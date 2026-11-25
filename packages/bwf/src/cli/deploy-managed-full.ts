import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { analyzeApplication } from '../application-routing.ts';
import {
  hasApiRoutes as routeScanHasApiRoutes,
  hasDocumentRoutes as routeScanHasDocumentRoutes,
  resolveAssetConfig,
} from '../asset-routing.ts';
import type { BwfConfig } from '../config.ts';
import { hasEmailHandlers } from '../router/email.ts';
import {
  isSandboxAttached,
  requiresSandboxPlatformImage,
  resolveSandboxConfig,
} from '../sandbox/config.ts';
import { buildEnv } from '../shared/untrusted-env.ts';
import { resolveDistDir, resolveWorkerDirName } from './build-output-dir.ts';
import type { PlatformClient } from './client.ts';
import { assertDeploySchemaDriftFree } from './deploy-drift.ts';
import {
  resolveFullDeployBuildCommand,
  log,
  getExitCode,
  resolveDeployLiveBindingConfig,
  resolveDeployWranglerCompat,
  resolveDeployWorkerMain,
  assertEnvSchemaValid,
  assertWorkerMainUploaded,
  validateDeployMigrations,
  ensureManagedHyperdrive,
  toManifestSchedulesAndQueues,
} from './deploy-helpers.ts';
import {
  mergeAndLintRoutingRules,
  streamDirectR2Deploy,
  warnUnpublishedRouting,
} from './deploy-managed-events.ts';
import { formatDeploySummary, printDeploySuccess } from './deploy-summary.ts';
import { MANAGED_DEPLOY_BUILD_ENV } from './deploy-transport.ts';
import type { GitDeployMetadata } from './git-metadata.ts';
import { isJsonObject } from './json-value.ts';
import type { CliLogger } from './log-file.ts';
import { createSpinner, formatCount, note } from './output.ts';
import {
  buildBwfManifest,
  collectAndHashAssets,
  collectWorkerFiles,
  detectNonSpaFallbackWarning,
} from './package.ts';
import type { ProjectConfig } from './project.ts';
import type { AssetConfig } from './types.ts';

export async function runFullDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  /**
   * The already-read `bwf.config.ts`, threaded from `runDeploy`. The build step reads
   * `inference.build` from it, so it must be available BEFORE the build.
   */
  bwfConfig: BwfConfig,
  skipBuild?: boolean,
  gitMetadata?: GitDeployMetadata,
  cliLog?: CliLogger,
  skipMigrations?: boolean,
): Promise<void> {
  cliLog?.info('deploy_mode', { mode: 'full' });

  // Decision: Build in a child process to avoid Vite API side effects on bundle output.
  if (!skipBuild) {
    const { label: buildCmd, command: buildExec } = resolveFullDeployBuildCommand(
      root,
      bwfConfig.inference?.build,
    );
    log.step(`Building (${buildCmd})...`);
    cliLog?.info('build_start', { command: buildCmd });
    const buildStartedAt = Date.now();
    try {
      // Decision: PLATFORM_DEPLOY_PROJECT_ID marks a managed build: platform dispatch owns routing.
      execSync(buildExec, {
        cwd: root,
        stdio: 'inherit',
        env: buildEnv(
          { PLATFORM_DEPLOY_PROJECT_ID: config.projectId, ...MANAGED_DEPLOY_BUILD_ENV },
          { localBinRoot: root },
        ),
      });
      cliLog?.info('build_end', { durationMs: Date.now() - buildStartedAt });
    } catch (error: unknown) {
      cliLog?.error('build_failed', error, { durationMs: Date.now() - buildStartedAt });
      process.exit(getExitCode(error));
    }
  } else {
    cliLog?.info('build_skipped', { reason: 'skipBuild' });
  }

  // Decision: Resolve output paths from build artifacts instead of resolving the Vite config again here;
  // plugins run only once, inside the build.
  const distDir = resolveDistDir(root);
  const workerDirName = resolveWorkerDirName(distDir);

  let assetsPrefix = 'assets';
  const clientManifestPath = join(distDir, 'client', '.vite', 'manifest.json');
  if (existsSync(clientManifestPath)) {
    const manifest: unknown = JSON.parse(readFileSync(clientManifestPath, 'utf8'));
    for (const entry of isJsonObject(manifest) ? Object.values(manifest) : []) {
      const file = isJsonObject(entry) ? entry.file : undefined;
      if (typeof file === 'string' && file.includes('/')) {
        const dir = file.slice(0, file.indexOf('/'));
        if (dir !== 'assets') {
          assetsPrefix = dir;
        }
        break;
      }
    }
  }

  const analysis = await analyzeApplication(root, { config: bwfConfig, environment: 'prod' });
  const { paths, dialect, bindings, authEnabled, scan: routeScan } = analysis;

  const sandboxConfig = bindings.needsSandbox ? resolveSandboxConfig(bwfConfig, root) : undefined;
  if (sandboxConfig && isSandboxAttached(sandboxConfig)) {
    throw new Error(
      'deploy: `sandbox.durableObject` attaches the container to your own Durable Object, which needs a native Cloudflare deploy (`bwf deploy --platform cloudflare`). Managed platforms run containers in their own controller; use `getSandbox` from `@builtbyfriends/bwf/sandbox` there.',
    );
  }
  if (bindings.needsSandbox && requiresSandboxPlatformImage(bwfConfig)) {
    log.error(
      'deploy: `sandbox.image` points at a local Dockerfile. Add `sandbox.platformImage` with a pushed registry image for `bwf deploy`, or deploy this sandbox directly with Wrangler.',
    );
    process.exit(1);
  }

  const clientDir = join(distDir, 'client');
  const { headerRules, redirectRules, fallbackRules } = mergeAndLintRoutingRules(
    clientDir,
    bwfConfig.routing,
  );

  assertDeploySchemaDriftFree(root, dialect);

  // Decision: Validate migrations before the Hyperdrive check so migrations can gate provisioning.
  const validatedMigrations = validateDeployMigrations(
    paths.migrationsDir,
    analysis.migrations,
    paths.sourceRelative,
  );

  // Decision: Migrations on disk also gate this: even if inference says needsD1: false, buildBwfManifest adds
  // the hyperdrive binding when migrations are present.
  if (dialect !== 'sqlite' && analysis.needsDatabase) {
    await ensureManagedHyperdrive(client, config.projectId, dialect);
  }
  const rawJobs = analysis.jobs;
  const rawQueues = analysis.queues;
  const { schedules, queues } = toManifestSchedulesAndQueues(rawJobs, rawQueues);
  const webSockets = analysis.websockets;
  const liveConfig = await resolveDeployLiveBindingConfig(root, client, config.projectId, {
    needsLive: bindings.needsLive,
    webSockets,
    sandboxClassName: sandboxConfig?.className,
    cliLog,
  });
  const hasRoutes = routeScan.routes.length > 0;
  const hasApiRoutes =
    routeScanHasApiRoutes(routeScan.routes) || routeScanHasApiRoutes(webSockets) || authEnabled;
  const hasDocumentRoutes = routeScanHasDocumentRoutes(routeScan.routes);
  const hasMiddleware = routeScan.middleware.length > 0;
  const hasWebSockets = webSockets.length > 0;
  const wranglerCompat = resolveDeployWranglerCompat(
    root,
    bwfConfig,
    join(distDir, workerDirName),
    {
      authEnabled,
      dialect,
      needsSandbox: bindings.needsSandbox,
    },
  );
  const workerMain = resolveDeployWorkerMain(bwfConfig, join(distDir, workerDirName));

  await assertEnvSchemaValid(root, client, config.projectId, bwfConfig.worker?.vars);

  const s = createSpinner();
  const onProgress = (msg: string) => s.message(msg);

  const assetConfig: AssetConfig = resolveAssetConfig({
    hasApiRoutes,
    hasDocumentRoutes,
    hasMiddleware,
    hasWebSockets: routeScanHasDocumentRoutes(webSockets),
    authEnabled,
    liveEnabled: liveConfig !== undefined,
    notFound: bwfConfig.routing?.notFound,
  });

  // Decision: `assetFiles` carries the in-memory buffer cache through to the upload step so each asset is read
  // from disk exactly once.
  s.start('Checking for changes...');
  cliLog?.info('preflight_start', { dir: clientDir });
  const { assetManifest, assetFiles } = await collectAndHashAssets(clientDir, onProgress);
  const { needed, skipped } = await client.preflight(config.projectId, assetManifest, true);
  s.stop('Checked for changes');
  cliLog?.info('preflight_end', {
    total: Object.keys(assetManifest).length,
    needed: needed.length,
    skipped,
  });

  if (skipped > 0) {
    log.info(`Skipping ${formatCount(skipped, 'unchanged asset')}`);
  }

  s.start('Packaging...');
  cliLog?.info('package_start', {
    mode: 'full',
    hasRoutes,
    hasMiddleware,
    hasWebSockets,
    authEnabled,
  });
  const packageStartedAt = Date.now();
  const bwfPackageOptions = {
    bindingNames: analysis.bindingNames,
    compatibilityDate: wranglerCompat?.compatibilityDate,
    compatibilityFlags: wranglerCompat?.compatibilityFlags,
    cpuMs: bwfConfig.worker?.limits?.cpu_ms,
    ...(workerMain && { workerMain }),
    ...(sandboxConfig && { sandbox: sandboxConfig }),
    ...(liveConfig && { live: liveConfig }),
  };

  const fallbackWarning = detectNonSpaFallbackWarning(assetConfig, fallbackRules);
  if (fallbackWarning) {
    onProgress(fallbackWarning);
    console.warn(`[bwf] ${fallbackWarning}`);
  }

  const manifest = buildBwfManifest({
    bindings: liveConfig ? { ...bindings, needsLive: true } : bindings,
    alwaysUseHttps: bwfConfig.routing?.alwaysUseHttps,
    storage: bwfConfig.storage,
    vectorize: bwfConfig.vectorize,
    database: typeof bwfConfig.database === 'object' ? bwfConfig.database : undefined,
    hasEmailHandlers: routeScan.email !== undefined && hasEmailHandlers(routeScan.email),
    migrations: validatedMigrations,
    schedules,
    ssr: hasRoutes || hasMiddleware || hasWebSockets || authEnabled,
    vars: bwfConfig.worker?.vars,
    queues,
    assetConfig,
    options: bwfPackageOptions,
    hashedAssetsPrefix: assetsPrefix,
    headerRules,
    redirectRules,
    fallbackRules,
    dialect,
    webSockets,
    durableObjects: analysis.durableObjects,
  });
  if (skipMigrations) {
    manifest.migrationMode = 'skip';
  }
  const workerDir = join(distDir, workerDirName);
  const workerFiles = collectWorkerFiles(workerDir);
  assertWorkerMainUploaded(workerFiles, workerMain);
  cliLog?.info('package_end', {
    mode: 'full',
    durationMs: Date.now() - packageStartedAt,
  });
  const result = await streamDirectR2Deploy({
    client,
    projectId: config.projectId,
    manifest,
    assetManifest,
    assetFiles,
    needed,
    gitMetadata,
    preflightUsed: skipped > 0,
    workerFiles,
    spinner: s,
    cliLog,
  });

  note(
    formatDeploySummary({
      workers: result.workers,
      assets: result.assets,
      unchangedAssets: skipped,
      migrations: result.migrations,
      cronJobs: schedules.length,
      queues: queues.length,
    }),
    result.url,
  );

  warnUnpublishedRouting(result);
  printDeploySuccess(result.published !== false);
}
