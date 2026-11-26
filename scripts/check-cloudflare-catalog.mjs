import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cloudflareCatalog } from '../platform/packages/api/src/infrastructure/cloudflare-catalog.ts';
import { cloudflareOpenApiCoverage } from '../platform/packages/api/src/infrastructure/cloudflare-openapi-snapshot.ts';
import { resourceOperationPolicyCoverage } from '../platform/packages/api/src/infrastructure/resource-operations.ts';

const digest = (value) => createHash('sha256').update(value).digest('hex');
export function catalogDrift(current, candidate) {
  const before = new Map(current.map((entry) => [entry.id, entry]));
  const after = new Map(candidate.map((entry) => [entry.id, entry]));
  if (before.size !== current.length || after.size !== candidate.length) {
    throw Error('Duplicate catalog operation ID.');
  }
  return {
    added: candidate.filter((entry) => !before.has(entry.id)).map((entry) => entry.id),
    removed: current.filter((entry) => !after.has(entry.id)).map((entry) => entry.id),
    changed: candidate
      .filter((entry) => {
        const old = before.get(entry.id);
        return old && JSON.stringify(old) !== JSON.stringify(entry);
      })
      .map((entry) => entry.id),
  };
}

export function coverageDrift(previous, current) {
  const operations = catalogDrift(previous.operations, current.operations);
  const proxyOperations = catalogDrift(
    previous.proxyOperations ?? [],
    current.proxyOperations ?? [],
  );
  const sourceChanged = JSON.stringify(previous.source) !== JSON.stringify(current.source);
  return {
    operations,
    proxyOperations,
    sourceChanged,
    reviewRequired:
      sourceChanged ||
      [operations, proxyOperations].some((change) =>
        Object.values(change).some((entries) => entries.length > 0),
      ),
  };
}

export async function coverageReport() {
  const catalog = await cloudflareCatalog();
  const policy = await resourceOperationPolicyCoverage();
  const operations = catalog.operations.map((entry) => ({
    id: entry.id,
    product: entry.product,
    method: entry.httpMethod,
    path: entry.path,
    schemaSha256: entry.schemaSha256,
    aliases: entry.aliases,
    discoverable: true,
    installedPolicies: policy.provider
      .filter((value) => value.method === entry.httpMethod && value.path === entry.path)
      .map((value) => value.resourceType),
    targetExecution: 'requires-owned-resource-catalog',
    liveTested: 'not-recorded',
    uiAccepted: 'not-recorded',
  }));
  const unmatchedPolicies = policy.provider.filter(
    (value) =>
      !operations.some((entry) => value.method === entry.method && value.path === entry.path),
  );
  if (unmatchedPolicies.length) {
    throw Error('Installed provider policy has no pinned schema.');
  }
  let installedCli = { status: 'not-installed' };
  const require = createRequire(import.meta.url);
  let cliPath;
  try {
    cliPath = require.resolve('cf/package.json');
  } catch {}
  if (cliPath) {
    const pkg = JSON.parse(await readFile(cliPath, 'utf8'));
    const bytes = await readFile(new URL('dist/_meta/schemas.json', pathToFileURL(cliPath)));
    installedCli = {
      status:
        pkg.version === catalog.source.cliVersion && digest(bytes) === catalog.source.sha256
          ? 'matches-pin'
          : 'drift',
      version: pkg.version,
      sha256: digest(bytes),
    };
  }
  const families = [...new Set(operations.map((entry) => entry.product))].sort().map((product) => ({
    product,
    discoverable: operations.filter((entry) => entry.product === product).length,
    withInstalledPolicy: operations.filter(
      (entry) => entry.product === product && entry.installedPolicies.length,
    ).length,
    liveTested: 'not-recorded',
    uiAccepted: 'not-recorded',
  }));
  return {
    formatVersion: 1,
    source: catalog.source,
    extraction: cloudflareOpenApiCoverage,
    installedCli,
    counts: {
      discoverable: operations.length,
      cliAliases: operations.reduce((sum, entry) => sum + entry.aliases.length, 0),
      apiOnly: operations.filter((entry) => !entry.aliases.length).length,
      providerPolicies: policy.provider.length,
      proxyPolicies: policy.proxy.length,
    },
    families,
    proxyOperations: policy.proxy,
    operations,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [previousPath] = process.argv.slice(2);
  const report = await coverageReport();
  if (previousPath) {
    const bytes = await readFile(previousPath);
    if (bytes.length > 8 * 1024 * 1024) {
      throw Error('Previous coverage report exceeds 8 MiB.');
    }
    const previous = JSON.parse(bytes.toString());
    if (
      previous.formatVersion !== 1 ||
      !Array.isArray(previous.operations) ||
      previous.operations.length > 5000
    ) {
      throw Error('Invalid previous coverage report.');
    }
    report.drift = coverageDrift(previous, report);
    report.reviewRequired = report.drift.reviewRequired;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.installedCli.status === 'drift' || report.reviewRequired) {
    process.exitCode = 1;
  }
}
