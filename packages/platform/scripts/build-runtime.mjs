import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join } from 'pathslash';
import { buildSandboxController } from '../../../platform/packages/api/scripts/build-sandbox-controller.mjs';

const packageRoot = join(dirname(import.meta.filename), '..');
const repositoryRoot = join(packageRoot, '..', '..');
const runtimeRoot = join(packageRoot, 'dist', 'runtime');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'platform-runtime-'));
const wrangler = fileURLToPath(import.meta.resolve('wrangler'));
const drizzleRoot = join(repositoryRoot, 'platform', 'packages', 'api', 'drizzle');
const apiRoot = join(repositoryRoot, 'platform', 'packages', 'api');
const {
  PLATFORM_ADMIN_CLIENT_ASSET_PATH,
  PLATFORM_ADMIN_STYLE_ASSET_PATH,
  parsePlatformRuntimeManifest,
  platformDatabaseSchemaDigest,
} = await import(pathToFileURL(join(packageRoot, 'dist', 'installer.mjs')).href);
const { PLATFORM_USAGE_PROTOCOL_VERSION } = await import(
  pathToFileURL(join(packageRoot, 'dist', 'index.mjs')).href
);

const workers = [
  ['api', join(repositoryRoot, 'platform', 'packages', 'api', 'src', 'worker', 'index.ts')],
  ['proxy', join(repositoryRoot, 'platform', 'packages', 'proxy', 'src', 'index.ts')],
  [
    'emailGateway',
    join(repositoryRoot, 'platform', 'packages', 'email-gateway', 'src', 'index.ts'),
  ],
  ['tail', join(repositoryRoot, 'platform', 'packages', 'tail', 'src', 'index.ts')],
  ['dispatch', join(repositoryRoot, 'platform', 'packages', 'dispatch', 'src', 'index.ts')],
];
const sourceAliases = {
  '@builtbyfriends/deploy-core': join(repositoryRoot, 'packages', 'deploy-core', 'src', 'index.ts'),
  '@builtbyfriends/edge': join(repositoryRoot, 'packages', 'edge', 'src', 'index.ts'),
};

try {
  const adminClient = spawnSync(
    process.execPath,
    [join(apiRoot, 'scripts', 'build-admin-client.mjs')],
    {
      cwd: apiRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (adminClient.status !== 0) {
    process.stderr.write(adminClient.stdout);
    process.stderr.write(adminClient.stderr);
    throw new Error('Failed to build the platform admin client.');
  }
  rmSync(runtimeRoot, { force: true, recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  const adminClientAsset = join(runtimeRoot, PLATFORM_ADMIN_CLIENT_ASSET_PATH);
  mkdirSync(dirname(adminClientAsset), { recursive: true });
  cpSync(join(apiRoot, 'dist', 'admin-assets', 'admin', 'client.js'), adminClientAsset);
  const adminClientContents = readFileSync(adminClientAsset);
  const adminStyleAsset = join(runtimeRoot, PLATFORM_ADMIN_STYLE_ASSET_PATH);
  cpSync(join(apiRoot, 'dist', 'admin-assets', 'admin', 'style.css'), adminStyleAsset);
  const adminStyleContents = readFileSync(adminStyleAsset);
  const artifacts = {};
  const controller = buildSandboxController(temporaryRoot);

  for (const [name, entrypoint] of workers) {
    const configPath = join(temporaryRoot, `${name}.json`);
    const outputDirectory = join(temporaryRoot, name);
    writeFileSync(
      configPath,
      JSON.stringify({
        name: `platform-runtime-build-${name === 'emailGateway' ? 'email-gateway' : name}`,
        main: entrypoint,
        alias: {
          ...sourceAliases,
          ...(name === 'api'
            ? { 'platform:sandbox-controller-source': controller.modulePath }
            : {}),
        },
        compatibility_date: '2026-02-24',
        compatibility_flags:
          name === 'api' || name === 'proxy' || name === 'emailGateway' ? ['nodejs_compat'] : [],
        keep_names: true,
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        wrangler,
        'deploy',
        '--dry-run',
        '--config',
        configPath,
        '--outdir',
        outputDirectory,
        '--minify',
      ],
      { cwd: dirname(entrypoint), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result.status !== 0) {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(`Failed to build the ${name} platform Worker.`);
    }
    const artifactPath = join(outputDirectory, 'index.js');
    // Decision: Publish executable artifacts without build-only maps or dangling map references.
    const contents = Buffer.from(
      readFileSync(artifactPath, 'utf8').replace(/\n\/\/# sourceMappingURL=[^\r\n]*\s*$/u, '\n'),
    );
    const packagedArtifactPath = join(runtimeRoot, name, 'index.js');
    mkdirSync(dirname(packagedArtifactPath), { recursive: true });
    writeFileSync(packagedArtifactPath, contents);
    artifacts[name] = {
      path: `${name}/index.js`,
      sha256: createHash('sha256').update(contents).digest('hex'),
      size: contents.byteLength,
    };
  }

  cpSync(drizzleRoot, join(runtimeRoot, 'drizzle'), {
    recursive: true,
    // Decision: Drizzle snapshots support authoring new migrations, not applying them.
    filter: (source) => !/^\d{4}_snapshot\.json$/.test(basename(source)),
  });
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const database = buildDatabaseManifest();
  const manifest = parsePlatformRuntimeManifest({
    artifacts,
    assets: {
      adminClient: {
        path: PLATFORM_ADMIN_CLIENT_ASSET_PATH,
        sha256: createHash('sha256').update(adminClientContents).digest('hex'),
        size: adminClientContents.byteLength,
      },
      adminStyle: {
        path: PLATFORM_ADMIN_STYLE_ASSET_PATH,
        sha256: createHash('sha256').update(adminStyleContents).digest('hex'),
        size: adminStyleContents.byteLength,
      },
    },
    applicationRoutingVersion: 1,
    privatePreviews: 1,
    authenticationProtocolVersion: 1,
    deploymentExecution: 1,
    appAccessSetup: 1,
    runtimeLogs: 1,
    storageLocationHint: 1,
    emailProtocolVersion: 1,
    database,
    platformVersion: packageJson.version,
    safetyProtocols: { sandboxDrain: 3 },
    schemaVersion: 2,
    // Decision: scripts/stamp-source-revision.mjs records the revision after this cached build.
    sourceRevision: null,
    usageProtocolVersion: PLATFORM_USAGE_PROTOCOL_VERSION,
  });
  writeFileSync(join(runtimeRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

function buildDatabaseManifest() {
  const journalPath = join(drizzleRoot, 'meta', '_journal.json');
  const journalContents = readFileSync(journalPath);
  const journal = parseObjectJson(journalContents, journalPath);
  if (journal.dialect !== 'postgresql') {
    throw new Error('bwf Platform migrations must use the PostgreSQL dialect.');
  }
  if (!Array.isArray(journal.entries)) {
    throw new Error('bwf Platform migration journal entries must be an array.');
  }
  const compatibilityPath = join(drizzleRoot, 'compatibility.json');
  const compatibility = parseObjectJson(readFileSync(compatibilityPath), compatibilityPath);
  if (compatibility.schemaVersion !== 1) {
    throw new Error('bwf Platform database compatibility schemaVersion must be 1.');
  }
  if (!Array.isArray(compatibility.rollbackSafeFrom)) {
    throw new Error('bwf Platform rollbackSafeFrom must be an array.');
  }
  // Decision: parsePlatformRuntimeManifest validates these values, their order, and the rollback lineage.
  const migrations = journal.entries.map((entry, position) => {
    const tag = entry?.tag;
    if (typeof tag !== 'string') {
      throw new Error(`bwf Platform migration journal entry ${position} has an invalid tag.`);
    }
    const sqlPath = join(drizzleRoot, `${tag}.sql`);
    let sql;
    try {
      sql = readFileSync(sqlPath);
    } catch (error) {
      throw new Error(
        `bwf Platform migration ${tag} is missing: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return {
      index: entry.idx,
      sha256: sha256(sql),
      tag,
      timestampMillis: entry.when,
    };
  });
  return {
    journalSha256: sha256(journalContents),
    lineage: compatibility.lineage,
    migrations,
    protocolVersion: 1,
    rollbackSafeFrom: compatibility.rollbackSafeFrom,
    schemaDigest: platformDatabaseSchemaDigest(compatibility.lineage, migrations),
  };
}

function parseObjectJson(contents, path) {
  let value;
  try {
    value = JSON.parse(contents.toString('utf8'));
  } catch (error) {
    throw new Error(
      `bwf Platform metadata is invalid at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`bwf Platform metadata at ${path} must be an object.`);
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
