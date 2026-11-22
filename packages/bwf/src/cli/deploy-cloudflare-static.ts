import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  activateCloudflareVersion,
  encodeCloudflareVersionMessage,
  parseRootWranglerConfig,
  readCloudflareTriggerConfig,
  readWranglerTopLevelString,
  renderCloudflareStaticEntry,
  stageCloudflareStaticAssets,
  writeCloudflareStaticDeployConfig,
  assertExistingCloudflareConfig,
} from '@builtbyfriends/deploy-cloudflare';
import { dirname, join, relative } from 'pathslash';
import { edgeRulesNeedWorker, BWF_INTERNAL_WORKER_FIRST } from '../asset-routing.ts';
import { convertHeadersConfig, type RoutingConfig, type BwfConfig } from '../config.ts';
import { selectNativeVersionMetadataBinding } from '../shared/version-metadata.ts';
import { prepareCfStaticBuildOutput } from './cf-build-output.ts';
import { type CloudflareCandidateReceipt } from './cloudflare-candidate.ts';
import type { CloudflareChildReporter } from './cloudflare-child-report.ts';
import { readCloudflareLink, type CloudflareLink } from './cloudflare-link.ts';
import { deduplicateGeneratedCompatibilityFlags } from './deploy-artifact-validation.ts';
import { prepareExistingCloudflareDeployWithAuth } from './deploy-cloudflare-auth.ts';
import {
  discoverRootWranglerConfig,
  activateCloudflareVersionWithProgress,
  assertCloudflareDeployTargetUnchanged,
  cloudflareCandidateActivationOptions,
  confirmCloudflareDeployAuthentication,
  connectCloudflareDeployAccount,
  createCfActivationRunner,
  recordCloudflareActivation,
  reportCloudflareActivationFailure,
  formatCloudflareActivationError,
} from './deploy-cloudflare-helpers.ts';
import {
  resolveStaticDeployPreset,
  resolveStaticBuildCommand,
  log,
  getExitCode,
} from './deploy-helpers.ts';
import { mergeAndLintRoutingRules } from './deploy-managed-events.ts';
import { deriveWorkerName } from './deploy-resources.ts';
import { formatDeploySummary, printDeployContext, printDeploySuccess } from './deploy-summary.ts';
import {
  scrubManagedDeployBuildMarkers,
  scrubWranglerAuthCredentials,
  deployChildEnv,
} from './deploy-transport.ts';
import { type RunDeployOptions, type CloudflareDeployDeps } from './deploy-types.ts';
import { readGeneratedAssetHeadersFile } from './headers.ts';
import { type CliLogger } from './log-file.ts';
import { getErrorMessage, note } from './output.ts';
import { buildStaticManifest, readWranglerHtmlHandling } from './package.ts';
import { detectPreset, type StaticPreset } from './preset.ts';
import { deleteEnvVarCaseAware } from './provision.ts';
import type { AssetConfig, DeployManifest } from './types.ts';
import { readWranglerManagedQueueCleanupCandidates } from './wrangler.ts';

/** Default runtime date for static Workers that set none. */
const DEFAULT_COMPATIBILITY_DATE = '2026-09-11';

export function resolveCloudflareStaticPreset(
  root: string,
  bwfConfig: BwfConfig,
  options: Pick<RunDeployOptions, 'dir' | 'spa'>,
): StaticPreset | null {
  const configured = resolveStaticDeployPreset(root, bwfConfig, options);
  if (configured) {
    return {
      ...configured,
      buildCommand: resolveStaticBuildCommand(
        configured,
        bwfConfig.inference?.build,
        Boolean(options.dir),
      ),
    };
  }
  if (bwfConfig.inference?.appType) {
    return null;
  }
  const detected = detectPreset(root, { spa: options.spa, strictBackend: true });
  return detected
    ? {
        ...detected,
        buildCommand: resolveStaticBuildCommand(detected, bwfConfig.inference?.build, false),
      }
    : null;
}

export type StaticEdgeRouting = {
  assetConfig: AssetConfig;
  /** Rules the thin edge Worker applies. */
  entry: Pick<DeployManifest, 'alwaysUseHttps' | 'headerRules' | 'redirectRules' | 'fallbackRules'>;
  /** `_headers` text Cloudflare applies to asset responses itself. */
  assetHeaders: string | undefined;
};

/**
 * Route a static deploy around its thin edge Worker. Without edge rules that
 * Worker only answers `/__platform/ready`, so Cloudflare serves every other request
 * from assets without starting it. The Platform-generated `_headers` is not such a
 * rule: it only marks fingerprinted files immutable, which Cloudflare applies
 * itself. Any other rule keeps the Worker in front of every request.
 */
export function planStaticEdgeRouting(options: {
  outputDir: string;
  appType: StaticPreset['appType'];
  routing: RoutingConfig | undefined;
  htmlHandling: AssetConfig['html_handling'];
}): StaticEdgeRouting {
  const generatedHeaders = readGeneratedAssetHeadersFile(options.outputDir);
  const merged = mergeAndLintRoutingRules(options.outputDir, options.routing);
  const manifest = buildStaticManifest({
    appType: options.appType,
    alwaysUseHttps: options.routing?.alwaysUseHttps,
    hashedAssetsPrefix: 'assets',
    headerRules: merged.headerRules,
    redirectRules: merged.redirectRules,
    fallbackRules: merged.fallbackRules,
    notFound: options.routing?.notFound,
    html_handling: options.htmlHandling,
  });
  const assetConfig = manifest.assetConfig ?? { not_found_handling: 'none' };
  const entry = {
    alwaysUseHttps: manifest.alwaysUseHttps,
    headerRules: manifest.headerRules,
    redirectRules: manifest.redirectRules,
    fallbackRules: manifest.fallbackRules,
  };
  const userHeaderRules =
    generatedHeaders === undefined
      ? entry.headerRules
      : convertHeadersConfig(options.routing?.headers);
  if (edgeRulesNeedWorker({ ...entry, headerRules: userHeaderRules })) {
    return {
      assetConfig: { ...assetConfig, run_worker_first: true },
      entry,
      assetHeaders: undefined,
    };
  }
  return {
    assetConfig: { ...assetConfig, run_worker_first: [...BWF_INTERNAL_WORKER_FIRST] },
    entry: { ...entry, headerRules: undefined },
    assetHeaders: generatedHeaders,
  };
}

export async function runCloudflareStaticDeploy(
  root: string,
  options: RunDeployOptions,
  bwfConfig: BwfConfig,
  preset: StaticPreset,
  cliLog: CliLogger,
  deps: CloudflareDeployDeps,
  initialCloudflareLink: CloudflareLink | null,
  initialCloudflareCandidate: CloudflareCandidateReceipt | null,
  reporter: CloudflareChildReporter,
): Promise<void> {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const configPath = discoverRootWranglerConfig(root);
  const connection = await connectCloudflareDeployAccount({
    root,
    configPath,
    rootConfig: parseRootWranglerConfig(configPath),
    deps,
    persistAccount: !(options.reuseExistingWorker || initialCloudflareLink),
    readinessAccessOrigin: options.readinessAccessOrigin,
    reporter,
  });
  if (!connection || !(await confirmCloudflareDeployAuthentication(connection, configPath))) {
    return exit(1);
  }
  const {
    apiBaseUrl,
    complianceRegion,
    usesCf,
    cfUploaderIsPinned,
    assertUploaderStillPinned,
    accountId,
    workersDevSubdomain,
    readinessAccessOrigin,
    runWrangler,
  } = connection;

  const existingWorker = await prepareExistingCloudflareDeployWithAuth(
    {
      root,
      configPath,
      accountId,
      reuse: options.reuseExistingWorker,
      pinnedLink: initialCloudflareLink,
      runWrangler,
      readExistingWorker: deps.readExistingWorker,
    },
    assertUploaderStillPinned,
  );
  const pinnedHandoffLink = existingWorker ? readCloudflareLink(root) : null;
  if (existingWorker && !pinnedHandoffLink) {
    throw new Error('The pending Cloudflare handoff was not saved before deployment.');
  }
  const rootConfig = parseRootWranglerConfig(configPath);
  const workerName = readWranglerTopLevelString(rootConfig, 'name') ?? deriveWorkerName(root);
  printDeployContext(workerName, 'Cloudflare');
  const rootConfigBeforeBuild = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;
  if (preset.buildCommand && !options.skipBuild) {
    log.step('Building...');
    const buildChildEnv = scrubManagedDeployBuildMarkers(
      scrubWranglerAuthCredentials(deployChildEnv(accountId, apiBaseUrl)),
    );
    deleteEnvVarCaseAware(buildChildEnv, 'NODE_ENV');
    buildChildEnv.NODE_ENV = 'production';
    const runStaticBuild =
      deps.runStaticBuild ??
      ((command: string, env: NodeJS.ProcessEnv) => {
        execSync(command, { cwd: root, stdio: 'inherit', env });
      });
    try {
      runStaticBuild(preset.buildCommand, buildChildEnv);
    } catch (error) {
      log.error(`deploy: build failed — ${getErrorMessage(error)}`);
      return exit(getExitCode(error));
    }
  }
  log.step('Preparing deployment...');
  if (!existsSync(preset.outputDir)) {
    log.error(`deploy: Output directory '${preset.outputDir}' not found. Run the build first.`);
    return exit(1);
  }
  if (!assertUploaderStillPinned()) {
    return exit(1);
  }
  const rootConfigAfterBuild = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;
  if (rootConfigAfterBuild !== rootConfigBeforeBuild) {
    log.error(
      [
        'deploy: the root Wrangler config changed during the static build.',
        'Refusing to upload a config rewritten by project build code. Restore the config and retry.',
      ].join('\n'),
    );
    return exit(1);
  }

  const edgeRouting = planStaticEdgeRouting({
    outputDir: preset.outputDir,
    appType: preset.appType,
    routing: bwfConfig.routing,
    htmlHandling: readWranglerHtmlHandling(rootConfig),
  });
  const entryPath = join(root, '.bwf', 'deploy', 'cloudflare', 'static-edge.mjs');
  mkdirSync(dirname(entryPath), { recursive: true });

  // Decision: Write the static config separately so the root config, with its Worker-only bindings and
  // comments, stays untouched for a later switch back to a Worker app.
  const staticConfigPath = join(dirname(entryPath), 'wrangler-static.json');
  writeFileSync(staticConfigPath, `${JSON.stringify(rootConfig, null, 2)}\n`, { mode: 0o600 });
  writeCloudflareStaticDeployConfig({
    configPath: staticConfigPath,
    name: workerName,
    accountId,
    main: relative(dirname(staticConfigPath), entryPath),
    assetsDirectory: relative(dirname(staticConfigPath), preset.outputDir),
    compatibilityDate:
      bwfConfig.worker?.compatibility_date ??
      readWranglerTopLevelString(rootConfig, 'compatibility_date') ??
      DEFAULT_COMPATIBILITY_DATE,
    assetConfig: edgeRouting.assetConfig,
  });
  deduplicateGeneratedCompatibilityFlags(staticConfigPath, configPath);
  const staticConfig = parseRootWranglerConfig(staticConfigPath);
  const versionMetadataBinding = selectNativeVersionMetadataBinding(staticConfig, {
    nativeBuild: true,
    preserveBindings: existingWorker !== null,
  });
  if (versionMetadataBinding && staticConfig.version_metadata === undefined) {
    writeFileSync(
      staticConfigPath,
      `${JSON.stringify({ ...staticConfig, version_metadata: { binding: versionMetadataBinding } }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  writeFileSync(
    entryPath,
    renderCloudflareStaticEntry({
      runtimeImport: '@builtbyfriends/bwf/edge',
      ...edgeRouting.entry,
      versionMetadataBinding,
    }),
  );

  if (existingWorker) {
    assertExistingCloudflareConfig(existingWorker, parseRootWranglerConfig(staticConfigPath), true);
  }

  const stagedAssetsDirectory = join(root, '.bwf', 'deploy', 'cloudflare', 'assets');
  stageCloudflareStaticAssets({
    sourceDirectory: preset.outputDir,
    destinationDirectory: stagedAssetsDirectory,
    headers: edgeRouting.assetHeaders,
  });

  const queueConsumerCleanup = readWranglerManagedQueueCleanupCandidates(configPath);
  assertCloudflareDeployTargetUnchanged({
    root,
    existingWorker,
    pinnedHandoffLink,
    initialCloudflareCandidate,
    accountId,
    workerName,
  });
  if (usesCf && !cfUploaderIsPinned()) {
    return exit(1);
  }
  const cfOutput = usesCf
    ? await prepareCfStaticBuildOutput({
        projectRoot: root,
        configPath: staticConfigPath,
        assetsDirectory: stagedAssetsDirectory,
        accountId,
      })
    : null;
  if (!cfOutput && usesCf) {
    log.error('deploy: cf could not prepare the static Worker for deployment.');
    return exit(1);
  }
  const activationRunner = createCfActivationRunner({
    cfOutput,
    accountId,
    apiBaseUrl,
    workerName,
    configPath: staticConfigPath,
    runWrangler,
    cfUploaderIsPinned,
    verifyCompatibilityRunner: assertUploaderStillPinned,
    reporter,
  });
  const execution = await activateCloudflareVersionWithProgress(
    deps.activateVersion ?? activateCloudflareVersion,
    {
      ...cloudflareCandidateActivationOptions({
        root,
        rootConfigPath: configPath,
        uploadConfigPath: staticConfigPath,
        accountId,
        apiBaseUrl,
        complianceRegion,
        workerName,
        workersDevSubdomain,
        readinessAccessOrigin,
        runWrangler,
        readExistingWorker: deps.readExistingWorker,
        existingWorker,
        pinnedHandoffLink,
        initialCloudflareCandidate,
        assertUploaderStillPinned,
        staticAssetsBinding: 'ASSETS',
        queueConsumerCleanup,
      }),
      runWrangler: activationRunner,
      verifyUploader: cfOutput ? cfUploaderIsPinned : assertUploaderStillPinned,
      requireVersionMetadata: existingWorker === null || versionMetadataBinding !== undefined,
      requirePreviewForReadiness: existingWorker !== null && versionMetadataBinding === undefined,
      message: encodeCloudflareVersionMessage([], {
        ...readCloudflareTriggerConfig(staticConfigPath, configPath),
        ...(existingWorker ? { preserve: true } : {}),
      }),
      assetsDirectoryOverride: stagedAssetsDirectory,
    },
  ).finally(() => cfOutput?.dispose());
  if (!execution.ok) {
    await reportCloudflareActivationFailure(
      reporter,
      formatCloudflareActivationError(execution),
      execution,
    );
    return exit(1);
  }
  recordCloudflareActivation({
    root,
    configPath,
    accountId,
    workerName,
    existingWorker,
    queueConsumerCleanup,
    execution,
    cliLog,
  });
  note(
    formatDeploySummary({
      workerName,
      typeLabel: preset.appType === 'spa' ? 'Static SPA' : 'Static Site',
    }),
    execution.previewUrl,
  );
  printDeploySuccess();
}
