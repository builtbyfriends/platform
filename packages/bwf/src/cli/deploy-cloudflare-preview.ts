import { parseRootWranglerConfig } from '@builtbyfriends/deploy-cloudflare';
import { type } from 'arktype';
import { dirname, resolve } from 'pathslash';
import { readConfig } from '../config.ts';
import type { BwfConfig } from '../config.ts';
import { prepareCfBuildOutput } from './cf-build-output.ts';
import type { CfCommand } from './cf-version-api.ts';
import { createCfCommand } from './cf-version-runner.ts';
import { createCloudflareChildReporter, observeCfCommand } from './cloudflare-child-report.ts';
import { readCloudflareLink } from './cloudflare-link.ts';
import { resolveCloudflareOperationContext } from './cloudflare-operations.ts';
import {
  assertNotDeclared,
  ensurePreviewDatabase,
  previewBuild,
  previewDatabaseName,
  readPreviewUrl,
  removePreviewDatabase,
} from './cloudflare-preview.ts';
import { isCleanCloudflareExit } from './cloudflare-process.ts';
import { withRecordedReadinessAccessOrigin } from './cloudflare-readiness.ts';
import { removeDeployPointer } from './deploy-artifact-validation.ts';
import { buildCloudflareWorker } from './deploy-cloudflare-build.ts';
import type { CloudflarePreflight, CloudflareDeploySource } from './deploy-cloudflare-preflight.ts';
import {
  prepareCloudflareDeploySource,
  preflightCloudflareWorker,
} from './deploy-cloudflare-preflight.ts';
import { runHealthCheck } from './deploy-health-check.ts';
import { log } from './deploy-helpers.ts';
import { deployChildEnv } from './deploy-transport.ts';
import type { CloudflareDeployDeps, RunDeployOptions } from './deploy-types.ts';
import type { CliLogger } from './log-file.ts';
import { getErrorMessage, note } from './output.ts';
import {
  applyPreviewSecrets,
  collectPreviewSecrets,
  liveSecretsFailureMessage,
  missingPreviewSecretsMessage,
} from './preview-secrets.ts';
import type { PreviewSecretValues } from './preview-secrets.ts';

const CF_TIMEOUT_MS = 300_000;

const PREVIEW_SHARES =
  "A preview gets its own Durable Objects and its own copy of each D1 database. KV, R2, queues and containers are the live app's, so a preview reads and writes the live data there. A preview has no Workflow binding. It starts without secrets: bwf sets a copy of each secret the live app has, from environment variables or --secrets-file.";

type PreviewRun = {
  root: string;
  name: string;
  options: RunDeployOptions;
  bwfConfig: BwfConfig;
  deps: CloudflareDeployDeps;
  exit: (code: number) => never;
  source: CloudflareDeploySource;
  preflight: CloudflarePreflight;
  runCf: CfCommand;
};

type D1Entry = { databaseName: string; binding: string; migrationsDir: string | undefined };

function lastLines(text: string, count: number): string {
  return text.trim().split('\n').slice(-count).join('\n');
}

const DeclaredDatabase = type({
  binding: 'string',
  database_name: 'string',
  'migrations_dir?': 'string',
});

/** The D1 databases the root config declares, each with the folder its migrations come from. */
function declaredDatabases(source: CloudflareDeploySource): Array<D1Entry> {
  const entries = DeclaredDatabase.array()(parseRootWranglerConfig(source.configPath).d1_databases);
  const found: Array<D1Entry> = [];

  for (const entry of entries instanceof type.errors ? [] : entries) {
    const own = entry.migrations_dir
      ? resolve(dirname(source.configPath), entry.migrations_dir)
      : undefined;

    const appDatabase =
      source.desired.d1?.binding === entry.binding ? source.migrationsDir : undefined;

    found.push({
      binding: entry.binding,
      databaseName: entry.database_name,
      migrationsDir: own ?? appDatabase,
    });
  }

  return found;
}

async function removePreview(run: PreviewRun): Promise<void> {
  const { name, runCf, source } = run;
  let failed = false;

  const deleted = await runCf(
    ['previews', 'delete', name, '--worker', run.preflight.workerName, '--force'],
    {
      cwd: run.root,
      capture: true,
      timeoutMs: CF_TIMEOUT_MS,
    },
  );

  if (!isCleanCloudflareExit(deleted)) {
    failed = true;
    log.error(
      `deploy: could not delete preview ${name}: ${lastLines(deleted.stderr || deleted.stdout, 1)}`,
    );
  }

  const declared = declaredDatabases(source);

  for (const { databaseName } of declared) {
    const copy = previewDatabaseName(databaseName, name);

    try {
      assertNotDeclared(
        copy,
        declared.map((entry) => entry.databaseName),
      );

      const removed = await removePreviewDatabase({ runCf, cwd: run.root, name: copy });

      log.info(removed ? `Deleted database ${copy}.` : `No database ${copy} to delete.`);
    } catch (error) {
      failed = true;
      log.error(`deploy: could not delete database ${copy}: ${getErrorMessage(error)}`);
    }
  }

  if (failed) {
    return run.exit(1);
  }

  log.info(`Removed preview ${name}.`);
}

async function stagePreviewOutput(run: PreviewRun, generatedConfigPath: string) {
  const { name, runCf, options, root } = run;
  const databases = declaredDatabases(run.source);

  const build = previewBuild({
    preview: name,
    databaseFor: async (binding, databaseName) => {
      const copy = previewDatabaseName(databaseName, name);
      const own = databases.find((entry) => entry.binding === binding);

      assertNotDeclared(
        copy,
        databases.map((entry) => entry.databaseName),
      );

      log.step(`Preparing database ${copy}...`);

      const id = await ensurePreviewDatabase({
        runCf,
        cwd: root,
        name: copy,
        migrationsDir: options.skipMigrations ? undefined : own?.migrationsDir,
      });

      return { name: copy, id };
    },
  });

  try {
    return await prepareCfBuildOutput(
      dirname(generatedConfigPath),
      run.preflight.accountId,
      undefined,
      root,
      build,
    );
  } catch (error) {
    log.error(`deploy: could not prepare preview ${name}: ${getErrorMessage(error)}`);

    return run.exit(1);
  }
}

async function checkPreviewHealth(run: PreviewRun, url: string): Promise<void> {
  const command = run.bwfConfig.deploy?.cloudflare?.healthCheck;

  if (command === undefined) {
    return;
  }

  log.step(`Running the health check against ${url}`);

  const health = await runHealthCheck(command, url, run.root);

  if (!health.ok) {
    log.error(
      `deploy: the health check ${health.detail}. To remove the preview and its databases, run \`bwf deploy --platform cloudflare --remove-preview ${run.name}\`.`,
    );

    return run.exit(1);
  }

  log.info('Health check passed.');
}

async function deployPreview(run: PreviewRun): Promise<void> {
  const { root, name, runCf } = run;

  removeDeployPointer(root);
  log.info(PREVIEW_SHARES);

  const context = resolveCloudflareOperationContext(root);
  let secrets: PreviewSecretValues;

  try {
    secrets = await collectPreviewSecrets(context, {
      secretsFile: run.options.secretsFile,
      env: process.env,
    });
  } catch (error) {
    log.error(liveSecretsFailureMessage(error instanceof Error ? error : new Error(String(error))));

    return run.exit(1);
  }

  if (secrets.missing.length > 0) {
    log.error(missingPreviewSecretsMessage(secrets.missing));

    return run.exit(1);
  }

  const build = await buildCloudflareWorker({
    root,
    bwfConfig: run.bwfConfig,
    deps: run.deps,
    exit: run.exit,
    atomic: false,
    skipMigrations: true,
    preview: true,
    source: run.source,
    preflight: run.preflight,
  });

  const output = await stagePreviewOutput(run, build.generatedConfigPath);

  if (!output) {
    log.error('deploy: cf could not prepare the built Worker for a preview.');

    return run.exit(1);
  }

  let url: string | undefined;

  try {
    log.step(`Deploying preview ${name}...`);

    const deployed = await runCf(['previews', 'deploy', '--prebuilt', '--preview-name', name], {
      cwd: output.directory,
      capture: true,
      timeoutMs: CF_TIMEOUT_MS,
    });

    if (!isCleanCloudflareExit(deployed)) {
      log.error(
        `deploy: cf could not deploy preview ${name}. The app needs a first deploy before it can have previews.\n${lastLines(deployed.stderr || deployed.stdout, 3)}`,
      );

      return run.exit(1);
    }

    url = readPreviewUrl(deployed.stdout);
  } finally {
    await output.dispose();
  }

  if (url === undefined) {
    log.error(`deploy: preview ${name} deployed, but cf gave no address for it.`);

    return run.exit(1);
  }

  try {
    await applyPreviewSecrets(context, name, secrets);
  } catch (error) {
    log.error(
      `deploy: preview ${name} deployed, but its secrets could not be set: ${getErrorMessage(error)}`,
    );

    return run.exit(1);
  }

  note(`Preview ${name}`, url);
  await checkPreviewHealth(run, url);
}

/**
 * Deploy the app as a Worker Preview, or remove one. A preview has its own Durable Objects (reached through the Worker's
 * exports) and its own copy of each D1 database, made and migrated here and deleted with the preview.
 */
export async function runCloudflarePreview(
  root: string,
  options: RunDeployOptions,
  cliLog: CliLogger,
  deps: CloudflareDeployDeps = {},
): Promise<void> {
  options = withRecordedReadinessAccessOrigin(options);

  const name = options.removePreview ?? options.preview;
  const exitProcess = deps.exit ?? ((code: number): never => process.exit(code));

  const exit = (code: number): never => {
    if (code === 0) {
      cliLog.info('deploy_end', { ok: true, exitCode: code });
    } else {
      cliLog.error('deploy_end', undefined, { ok: false, exitCode: code });
    }

    return exitProcess(code);
  };

  deps = { ...deps, exit };

  if (name === undefined) {
    return exit(1);
  }

  const reporter = createCloudflareChildReporter(cliLog);
  const bwfConfig = readConfig(root);
  const source = await prepareCloudflareDeploySource(root, options, bwfConfig);

  if (!source) {
    return exit(1);
  }

  const preflight = await preflightCloudflareWorker({
    root,
    bwfConfig,
    options,
    deps,
    exit,
    cliLog,
    reporter,
    initialCloudflareLink: readCloudflareLink(root),
    source,
  });

  if (!preflight.usesCf) {
    log.error('deploy: previews need the cf uploader, which this app does not use.');

    return exit(1);
  }

  const { accountId, apiBaseUrl, cfUploaderIsPinned } = preflight;

  const runCf = observeCfCommand(
    createCfCommand({
      accountId,
      apiBaseUrl,
      env: deployChildEnv,
      verifyUploader: cfUploaderIsPinned,
    }),
    reporter,
  );

  const run: PreviewRun = { root, name, options, bwfConfig, deps, exit, source, preflight, runCf };

  await (options.removePreview === undefined ? deployPreview(run) : removePreview(run));

  return exit(0);
}
