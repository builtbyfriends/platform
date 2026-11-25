import { log } from '@voidzero-dev/vite-plus-prompts';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { printSuccess, pc } from './output.ts';
import type { PlatformArgs } from './platform-args.ts';
import {
  listInstallationManifests,
  listPlatformConnections,
  resolveInstallationManifest,
} from './platform-registry.ts';

export type PlatformHealth = Readonly<{
  healthy: boolean;
  version: string | null;
  detail: string;
}>;

export async function checkPlatformHealth(
  apiUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<PlatformHealth> {
  const get = (path: string) =>
    fetcher(`${apiUrl}${path}`, {
      headers: { Accept: 'application/json', ...cfAccessHeaders(process.env, apiUrl) },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  try {
    const [health, discovery] = await Promise.all([get('/health'), get('/.well-known/platform')]);
    const body = discovery.ok
      ? ((await discovery.json().catch(() => ({}))) as { platformVersion?: unknown })
      : {};
    await health.body?.cancel();
    const version = typeof body.platformVersion === 'string' ? body.platformVersion : null;
    return health.ok
      ? { healthy: true, version, detail: 'healthy' }
      : { healthy: false, version, detail: `/health answered HTTP ${health.status}` };
  } catch (error) {
    return {
      healthy: false,
      version: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listPlatformHealth(fetcher: typeof fetch = fetch): Promise<void> {
  const manifests = listInstallationManifests().filter(
    (manifest) => manifest.status !== 'uninstalled',
  );
  const connections = listPlatformConnections();
  const rows = [
    ...manifests.map((manifest) => ({
      name: manifest.deployment.displayName,
      slug: manifest.deployment.installationSlug,
      apiUrl: manifest.endpoints.apiUrl,
      managed: `installed in ${manifest.account.name}, ${manifest.status}, recorded ${manifest.platformVersion}`,
    })),
    ...connections
      .filter(
        (connection) =>
          !manifests.some(
            (manifest) =>
              manifest.id === connection.installationId ||
              manifest.endpoints.apiUrl === connection.apiUrl,
          ),
      )
      .map((connection) => ({
        name: connection.displayName,
        slug: null,
        apiUrl: connection.apiUrl,
        managed: 'connected only, not upgraded by bwf platform upgrade',
      })),
  ];
  if (rows.length === 0) {
    log.info('No platforms configured. Run `bwf connect <url>`.');
    return;
  }
  const results = await Promise.all(
    rows.map((row) =>
      row.apiUrl
        ? checkPlatformHealth(row.apiUrl, fetcher)
        : { healthy: false, version: null, detail: 'no API address saved yet' },
    ),
  );
  for (const [index, row] of rows.entries()) {
    const health = results[index]!;
    console.log(`  ${pc.bold(row.name)}${row.slug ? ` ${pc.dim(`(${row.slug})`)}` : ''}`);
    console.log(`    ${row.apiUrl ?? 'no API address'}`);
    console.log(`    ${row.managed}`);
    console.log(
      `    live ${health.version ?? 'unknown'}, ${health.healthy ? pc.green('healthy') : pc.red(health.detail)}`,
    );
  }
}

const SHARED_ENV = new Set([
  'PLATFORM_RECOVERY_KEY',
  'PLATFORM_TIMINGS',
  'PLATFORM_ACCESS_CREDENTIALS',
]);

export function installationSpecificEnv(env: NodeJS.ProcessEnv = process.env): Array<string> {
  return Object.keys(env)
    .filter(
      (name) =>
        env[name] &&
        (name === 'CLOUDFLARE_API_TOKEN' ||
          (name.startsWith('PLATFORM_') && !SHARED_ENV.has(name))),
    )
    .sort();
}

type UpgradeArgs = Extract<
  PlatformArgs,
  { subcommand: 'upgrade' | 'repair' | 'disable' | 'enable' }
>;

export async function upgradeInstallations(
  args: UpgradeArgs & { selectors: ReadonlyArray<string> },
  upgradeOne: (args: UpgradeArgs) => Promise<void>,
  fetcher: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const shared = installationSpecificEnv(env);
  if (shared.length > 0) {
    throw new Error(
      `platform: ${shared.join(', ')} would apply to every installation in this upgrade. Unset them, or upgrade one installation at a time.`,
    );
  }
  const manifests = args.selectors.map((selector) => resolveInstallationManifest(selector));
  const ids = new Set(manifests.map((manifest) => manifest.id));
  if (ids.size !== manifests.length) {
    throw new Error('platform: The same installation is named twice.');
  }
  const done: Array<string> = [];
  for (const [index, manifest] of manifests.entries()) {
    const label = `${manifest.deployment.displayName} (${manifest.id})`;
    const left = manifests.slice(index + 1).map((entry) => entry.id);
    log.step(`Upgrading ${label}, ${index + 1} of ${manifests.length}`);
    const stop = (reason: string, cause?: unknown) =>
      new Error(
        [
          `platform: Stopped at ${label}: ${reason}`,
          `Upgraded: ${done.length > 0 ? done.join(', ') : 'none'}`,
          `Not started: ${left.length > 0 ? left.join(', ') : 'none'}`,
        ].join('\n'),
        { cause },
      );
    try {
      await upgradeOne({ ...args, selector: manifest.id });
    } catch (error) {
      throw stop(error instanceof Error ? error.message : String(error), error);
    }
    if (args.plan) {
      continue;
    }
    const apiUrl = resolveInstallationManifest(manifest.id).endpoints.apiUrl;
    const health = apiUrl
      ? await checkPlatformHealth(apiUrl, fetcher)
      : { healthy: false, version: null, detail: 'no API address saved' };
    if (!health.healthy) {
      throw stop(`health check after the upgrade: ${health.detail}`);
    }
    done.push(manifest.id);
    printSuccess(`${label} runs ${health.version ?? 'an unknown version'} and is healthy.`);
  }
  if (!args.plan) {
    printSuccess(`Upgraded ${done.length} installations.`);
  }
}
