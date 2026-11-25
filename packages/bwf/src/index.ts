import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'pathslash';
import pc from 'picocolors';
import type { Plugin } from 'vite';
import { analyzeApplicationSync, getNativeWorkerSourceFiles } from './application-analysis.ts';
import type { ApplicationAnalysis } from './application-analysis.ts';
import { applyBindingOverrides } from './application-features.ts';
import {
  edgeRulesNeedWorker,
  hasApiRoutes as routeScanHasApiRoutes,
  hasDocumentRoutes as routeScanHasDocumentRoutes,
  resolveAssetRoutingPolicy,
} from './asset-routing.ts';
import type { AssetRoutingPolicy } from './asset-routing.ts';
import { parseJsoncObject } from './cli/generated-wrangler-config.ts';
import { mergeRoutingRules } from './cli/headers.ts';
import { readDeploymentPlatform } from './cli/project.ts';
import {
  normalizeWranglerCompatibilityFlags,
  readWranglerCompat,
  readWranglerWebSocketTombstones,
  readExistingLiveBindingConfig,
  resolveLiveBindingConfig,
  syncWranglerDurableObjects,
  syncWranglerWebSockets,
} from './cli/wrangler.ts';
import {
  materializeCloudflareConfig,
  restoreCloudflarePreviewPointer,
  stashCloudflareDeployPointer,
} from './cloudflare-config.ts';
import { syncBindingTypes } from './codegen/binding-types.ts';
import { getDatabaseCasing, readConfig } from './config.ts';
import { inferBindingsFromSource } from './inference/walk.ts';
import { resolveLocalD1Target, writeLocalD1PersistState } from './local-d1.ts';
import { bwfLog, bwfWarn } from './log.ts';
import { readBwfDevCredentials, runAiSetupPrompt } from './plugin-ai-setup.ts';
import { bindingRuntimePlugin } from './plugin-binding-runtime.ts';
import { createClientStubsPlugin } from './plugin-client-stubs.ts';
import { cloudflare } from './plugin-cloudflare.ts';
import type { WorkerConfig, AuxiliaryWorkerConfig } from './plugin-cloudflare.ts';
import {
  afterServerReady,
  warnIfPackageJsonIsNotEsm,
  isViteBuildOrPreview,
  getOrCreateDevTriggerToken,
  devTriggerSecretGuardPlugin,
  isVitestServer,
  selectBwfCloudflareLogin,
} from './plugin-dev-config.ts';
import { devTriggersHintPlugin } from './plugin-dev-triggers-hint.ts';
import { drizzlePlugin } from './plugin-drizzle.ts';
import { emailDevInboxPlugin } from './plugin-email-dev-inbox.ts';
import { envClientFoldPlugin } from './plugin-env-client-fold.ts';
import { envClientGuardPlugin } from './plugin-env-client-guard.ts';
import { envSchemaPlugin } from './plugin-env-schema.ts';
import type { EnvSchemaFacts } from './plugin-env-schema.ts';
import { DEFAULT_SCAN_DIRS } from './plugin-inference.ts';
import { migrationPlugin } from './plugin-migration.ts';
import { restartPlugin } from './plugin-restart.ts';
import { routingPlugin } from './plugin-routing.ts';
import { sentry } from './plugin-sentry.ts';
import { mergeWorkerBindings } from './plugin-worker-bindings.ts';
import {
  createServerRuntimeOptimizerPlugin,
  DEV_ASSET_ROUTING_EXCLUSIONS,
  createCloudflareBuiltinsExternalPlugin,
  createWorkerEnvironmentSanitizerPlugin,
  createWranglerCompatPersistPlugin,
  createDefaultWorkerEnvironmentPlugin,
  DEFAULT_WORKER_ENVIRONMENT_NAME,
  createSandboxSdkResolvePlugin,
} from './plugin-worker-environment.ts';
import { assertNoRootSourceConventionConflicts } from './project-paths.ts';
import { isRouteEnabledForEnvironment } from './router/parse-filename.ts';
import type { RouteEnvironment } from './router/parse-filename.ts';
import { isSandboxAttached, resolveSandboxConfig } from './sandbox/config.ts';
import { CLOUDFLARE_DEPLOY_BUILD_ENV, loadLocalEnv, resolveRemoteMode } from './shared/env.ts';

const scheduledPreviewPointerCleanups = new Set<string>();

/** Returns the Vite plugins that build and serve a bwf app on Cloudflare. */
export function bwfPlugin(options?: {
  persistTo?: string;
  auxiliaryWorkers?: Array<AuxiliaryWorkerConfig>;
}): Array<Plugin> {
  const root = process.cwd();
  const directCloudflareDestination = readDeploymentPlatform(root) === 'cloudflare';
  if (directCloudflareDestination) {
    // Decision: Here, not in a hook, so every command selects the login before any session opens.
    selectBwfCloudflareLogin();
  }
  warnIfPackageJsonIsNotEsm(root);
  // Decision: Token only matters in serve — the dispatch module that uses it is
  // DCE'd from production worker bundles. In build/preview we still need
  // *some* string (the wrapper embeds it for completeness), but we skip
  // persisting it so build-only CI workflows don't materialize dev state.
  const devTriggerToken = isViteBuildOrPreview()
    ? crypto.randomUUID()
    : getOrCreateDevTriggerToken(root);
  const config = readConfig(root);
  syncBindingTypes(root, config);
  const projectCloudflareConfigPath = materializeCloudflareConfig(root);
  const cloudflareConfigPath =
    projectCloudflareConfigPath && existsSync(projectCloudflareConfigPath)
      ? projectCloudflareConfigPath
      : undefined;
  let previewing = false;
  // Decision: A preview reads the build's Wrangler deploy config, which the build moved aside. Put it back
  // until the preview exits.
  const restorePreviewPointer = () => {
    if (
      !existsSync(join(root, 'bwf.config.ts')) ||
      process.env[CLOUDFLARE_DEPLOY_BUILD_ENV] === '1'
    ) {
      return;
    }
    if (restoreCloudflarePreviewPointer(root) && !scheduledPreviewPointerCleanups.has(root)) {
      scheduledPreviewPointerCleanups.add(root);
      process.once('exit', () => {
        rmSync(join(root, '.wrangler', 'deploy', 'config.json'), { force: true });
      });
    }
  };
  const implicitDeployGuard: Plugin = {
    name: 'platform:remove-implicit-cloudflare-deploy-pointer',
    enforce: 'pre',
    config(_config, environment) {
      previewing = environment.isPreview === true;
      if (previewing) {
        restorePreviewPointer();
      }
    },
    closeBundle() {
      if (
        !previewing &&
        existsSync(join(root, 'bwf.config.ts')) &&
        process.env[CLOUDFLARE_DEPLOY_BUILD_ENV] !== '1'
      ) {
        stashCloudflareDeployPointer(root);
      }
    },
  };
  let application = analyzeApplicationSync(root, { config });
  const { paths, dialect, bindingNames, authConfigPath } = application;
  const analyses = new Map<RouteEnvironment, ApplicationAnalysis>();
  const getApplicationAnalysis = (environment: RouteEnvironment, refresh = false) => {
    let result = refresh ? undefined : analyses.get(environment);
    if (!result) {
      result = analyzeApplicationSync(root, { config, environment });
      analyses.set(environment, result);
    }
    application = result;
    return result;
  };
  let routeEnvironment: RouteEnvironment = 'prod';
  assertNoRootSourceConventionConflicts(paths);
  const localD1PersistRoot = options?.persistTo ?? join(root, '.bwf');
  const localD1 = resolveLocalD1Target(root, {
    bindingName: bindingNames?.d1 ?? 'DB',
    persistRoot: localD1PersistRoot,
  });
  writeLocalD1PersistState(root, options?.persistTo);
  let bindings = application.bindings;
  const sandboxConfig = bindings.needsSandbox ? resolveSandboxConfig(config, root) : undefined;
  let authEnabled = application.authEnabled;

  // Decision: Server-only bwf/* imports (db, kv, ai, etc.) must not pull in
  // cloudflare:workers or node: builtins when bundled for the browser.
  // Resolve them to empty stubs in any client environment.
  const clientStubsPlugin = createClientStubsPlugin();

  // Decision: Generated server entries import the env module by its resolved file path.
  // Prebundling a bare `platform` runtime subpath creates another package module
  // graph and therefore another envContext, so request bindings disappear for
  // the prebundled copy.
  const serverRuntimeOptimizerPlugin = createServerRuntimeOptimizerPlugin(
    dialect,
    () => readWranglerCompat(root, config),
    { root, scan: () => Promise.resolve(getNativeWorkerSourceFiles(application)) },
  );
  const queues = application.queues;
  // Decision: Deliberately scanned with NO environment: this list is the superset used to
  // RESERVE binding and Durable Object class names below, and reservation must
  // not depend on which command is running. A filtered list would let the live
  // DO resolve to `BWF_LIVE` under `vite dev` and `BWF_LIVE_2` under
  // `vite build` for the same project. Consumers that emit config rather than
  // reserve names re-filter by `routeEnvironment` (see `mergeBindings` and
  // `resolveConfiguredAssetRoutingPolicy`).
  const websocketRoutes = application.allWebsockets;
  const durableObjects = application.durableObjects;
  for (const module of durableObjects) {
    const websocketCollision = websocketRoutes.find(
      (route) => route.bindingName === module.bindingName || route.className === module.className,
    );
    if (websocketCollision) {
      throw new Error(
        `durable: durable-objects/${module.filePath.split('/').pop()} conflicts with WebSocket route '${websocketCollision.filePath}'. Rename one of the files.`,
      );
    }
    if (
      sandboxConfig &&
      !isSandboxAttached(sandboxConfig) &&
      (sandboxConfig.binding === module.bindingName || sandboxConfig.className === module.className)
    ) {
      throw new Error(
        `durable: durable-objects/${module.filePath.split('/').pop()} conflicts with the configured Sandbox binding or class. Rename the Durable Object file.`,
      );
    }
  }
  syncWranglerDurableObjects(root, durableObjects);
  const productionWebSocketRoutes = websocketRoutes.filter((route) =>
    isRouteEnabledForEnvironment(route, 'prod'),
  );
  syncWranglerWebSockets(root, productionWebSocketRoutes);
  const websocketTombstones = readWranglerWebSocketTombstones(root, productionWebSocketRoutes);
  const existingLiveConfig = readExistingLiveBindingConfig(root);
  const liveConfig = bindings.needsLive
    ? resolveLiveBindingConfig(root, {
        reservedBindings: [
          ...websocketRoutes.map((route) => route.bindingName),
          ...durableObjects.map((module) => module.bindingName),
        ],
        reservedClasses: [
          ...websocketRoutes.map((route) => route.className),
          ...durableObjects.map((module) => module.className),
          sandboxConfig?.className,
        ],
      })
    : existingLiveConfig;
  const shouldEmitLive = () => bindings.needsLive || existingLiveConfig !== undefined;

  const remoteMode = resolveRemoteMode(config.remote);

  // Decision: Core worker config — always set by bwfPlugin (main, triggers, assets).
  // Bindings are handled separately in the config function below.
  const workerConfig: Record<string, unknown> = {};
  const jobs = application.jobs;
  if (jobs.length > 0) {
    workerConfig.triggers = {
      crons: [...new Set(jobs.flatMap((job) => job.crons))],
    };
  }
  let envSchemaFacts: EnvSchemaFacts | undefined;
  let assetRouting: AssetRoutingPolicy;
  if (config.worker?.vars) {
    workerConfig.vars = { ...config.worker.vars };
  }

  // Decision: Tracks whether vite is running in dev or build mode. Set early in
  // envPlugin.config so mergeBindings can gate credential injection on 'serve'.
  let viteCommand: 'serve' | 'build' = 'build';
  let versionMetadataBinding: string | undefined;

  const wranglerCompat = readWranglerCompat(root, config);
  workerConfig.compatibility_date = wranglerCompat.compatibilityDate;
  if (wranglerCompat.compatibilityFlags) {
    workerConfig.compatibility_flags = wranglerCompat.compatibilityFlags;
  }
  if (config.worker?.limits?.cpu_ms) {
    workerConfig.limits = { cpu_ms: config.worker.limits.cpu_ms };
  }
  const inspectorPortEnv = process.env.BWF_INSPECTOR_PORT;
  const inspectorPort =
    inspectorPortEnv === 'false'
      ? false
      : typeof inspectorPortEnv === 'string' && inspectorPortEnv.length > 0
        ? Number.parseInt(inspectorPortEnv, 10)
        : undefined;

  const inspectorPortOption: { inspectorPort?: number | false } =
    inspectorPort === false
      ? { inspectorPort: false }
      : typeof inspectorPort === 'number'
        ? { inspectorPort }
        : {};

  const outDir = join(root, '.bwf');
  mkdirSync(outDir, { recursive: true });

  // Decision: Config function that merges inferred bindings with the resolved Cloudflare
  // config. Bindings already declared there (with real IDs) take precedence;
  // placeholders are added only for inferred bindings that are missing.
  const sentryIntegration = sentry(root);

  function mergeBindings(resolved: WorkerConfig): Partial<WorkerConfig> {
    const merged = mergeWorkerBindings(resolved, {
      websocketRoutes,
      routeEnvironment,
      workerConfig,
      envSchemaFacts,
      authEnabled,
      viteCommand,
      bindingNames,
      dialect,
      application,
      bindings,
      directCloudflareDestination,
      config,
      devTriggerToken,
      queues,
      durableObjects,
      sandboxConfig,
      shouldEmitLive,
      liveConfig,
      root,
      remoteMode,
    });
    versionMetadataBinding = merged.versionMetadataBinding;
    sentryIntegration.writeConfig([
      cloudflareConfigPath
        ? parseJsoncObject(readFileSync(cloudflareConfigPath, 'utf8'))
        : undefined,
      workerConfig,
      resolved,
      merged.patch,
    ] as never);
    return merged.patch;
  }

  function applyEnvSchema(facts: EnvSchemaFacts): void {
    envSchemaFacts = facts;
  }

  // Decision: Plugin that loads the single local `.env` file into worker bindings for
  // local dev and preview only. Production values come from remote secrets;
  // builds never turn local dotenv entries into deployable Worker vars.
  const envPlugin: Plugin = {
    name: 'platform:env',
    config(userConfig, { command, isPreview }) {
      viteCommand = command;
      // Decision: `dev` is the Vite dev server only. Every build, `bwf deploy`, and
      // `vite preview` (which reports `command: 'serve'`) is `prod`.
      routeEnvironment = command === 'serve' && !isPreview ? 'dev' : 'prod';
      application = getApplicationAnalysis(routeEnvironment);
      bindings = application.bindings;
      authEnabled = application.authEnabled;
      managedCloudflareBuild =
        command === 'build' && Boolean(process.env.PLATFORM_DEPLOY_PROJECT_ID);
      assetRoutingPublicDir =
        userConfig.publicDir === false
          ? null
          : typeof userConfig.publicDir === 'string'
            ? resolve(root, userConfig.publicDir)
            : join(root, 'public');
      assetRouting = resolveConfiguredAssetRoutingPolicy();
      applyAssetRoutingPolicy(assetRouting);
      // Decision: Exclude the .bwf cache directory from the file watcher so that
      // miniflare SQLite writes don't trigger infinite HMR refreshes.
      const ignored = ['**/.bwf/**'];
      if (command === 'serve') {
        const local = loadLocalEnv(root, { onWarn: (message) => bwfWarn(message) });
        // Decision: Keep the dev Worker on the same values that env-schema validation
        // sees. Shell values override .env, and shell-only values are included
        // only when declared by the schema. Never copy unrelated host secrets.
        // envSchemaPlugin rejects `__PLATFORM_*` names in .env and env.ts, so no
        // reserved key can enter here.
        const env = { ...local };
        for (const key of new Set([...Object.keys(local), ...(envSchemaFacts?.keys ?? [])])) {
          if (process.env[key] !== undefined) {
            env[key] = process.env[key];
          }
        }
        workerConfig.vars = {
          ...(workerConfig.vars as Record<string, string> | undefined),
          ...env,
        };
        // Decision: The Cloudflare preview server runs the already-built wrangler
        // artifact and sources its declared secrets from process.env instead
        // of the in-memory worker config. Populate only missing entries so the
        // shell still wins and `.env` remains a local runtime input.
        if (isPreview) {
          for (const [key, value] of Object.entries(env)) {
            process.env[key] ??= value;
          }
        }
      }

      // Decision: In dev, keep document requests on the user worker. If this is deleted,
      // the CF router may route a page request to the user worker, the dev
      // override sends that request back through Vite middleware, and Vite's
      // final Cloudflare handler routes it to the CF router again. Workerd
      // reports that loop as a hung request.
      //
      // Vite's own module URLs still need to bypass the worker so HMR,
      // virtual modules, and dev CSS are served by Vite middleware directly.
      const assets = workerConfig.assets as { run_worker_first?: Array<string> } | undefined;
      if (command === 'serve' && !isPreview && assets?.run_worker_first?.includes('/**')) {
        assets.run_worker_first = [...DEV_ASSET_ROUTING_EXCLUSIONS, '/**'];
      }

      const watchConfig = { server: { watch: { ignored } } };

      return { ...watchConfig, environments: { ssr: { build: { minify: true } } } };
    },
    configureServer(server) {
      if (remoteMode && (bindings.needsD1 || bindings.needsKV || bindings.needsR2)) {
        const credentials = readBwfDevCredentials(root);
        if (credentials.status === 'ok') {
          const lines = [pc.blue('Remote bindings active')];
          if (bindings.needsD1) {
            lines.push(`  DB      ${pc.dim('→ remote D1')}`);
          }
          if (bindings.needsKV) {
            lines.push(`  KV      ${pc.dim('→ remote KV')}`);
          }
          if (bindings.needsR2) {
            lines.push(`  STORAGE ${pc.dim('→ remote R2')}`);
          }
          afterServerReady(server, () => {
            console.log();
            bwfLog(lines.join('\n         '));
          });
        } else if (credentials.status === 'no-token') {
          afterServerReady(server, () => {
            console.log();
            bwfWarn('Remote mode requires authentication. Run `bwf account login`, then restart.');
            bwfWarn('Falling back to local bindings.');
          });
        } else {
          afterServerReady(server, () => {
            console.log();
            bwfWarn('Remote mode requires a linked project. Run `bwf project link` first.');
            bwfWarn('Falling back to local bindings.');
          });
        }
      }

      if (bindings.needsAI && !directCloudflareDestination) {
        const credentials = readBwfDevCredentials(root);
        if (credentials.status === 'no-token') {
          afterServerReady(server, () => {
            console.log();
            bwfWarn(
              'AI requires authentication. Run `bwf account login`, then restart the dev server.',
            );
          });
        } else if (credentials.status === 'no-project') {
          // Decision: A test run must not stop for questions, and Vitest's watch mode reads keys from
          // the terminal, so Vitest's server gets the hint below.
          if (process.stdin.isTTY && !isVitestServer(server.config)) {
            afterServerReady(server, () => {
              console.log();
              runAiSetupPrompt(root, credentials.token, credentials.apiUrl, server);
            });
          } else {
            afterServerReady(server, () => {
              console.log();
              bwfWarn('AI requires a linked project. Run `bwf project link` to set one up.');
            });
          }
        }
      }
    },
  };

  const autoDetectAuth = !authEnabled;
  const bindingWatchPlugin: Plugin = {
    name: 'platform:binding-watch',
    apply: 'serve',
    configureServer(server) {
      const effectiveDirs = config.inference?.scanDirs ?? DEFAULT_SCAN_DIRS;
      const watchDirs = [...new Set([...effectiveDirs, 'src'])].map((d) => join(root, d));
      let hintShown = false;
      const check = (path: string) => {
        if (hintShown) {
          return;
        }
        if (!watchDirs.some((d) => path.startsWith(d))) {
          return;
        }
        try {
          const code = readFileSync(path, 'utf8');
          const fileBindings = applyBindingOverrides(
            inferBindingsFromSource(code, path.split('/').pop()!),
            config.inference?.bindings,
          );
          const newBindings: Array<string> = [];
          if (fileBindings.needsD1 && !bindings.needsD1) {
            newBindings.push('D1 (bwf/db)');
          }
          if (fileBindings.needsKV && !bindings.needsKV) {
            newBindings.push('KV (bwf/kv)');
          }
          if (fileBindings.needsR2 && !bindings.needsR2) {
            newBindings.push('R2 (bwf/storage)');
          }
          if (fileBindings.needsAI && !bindings.needsAI) {
            newBindings.push('AI (bwf/ai)');
          }
          if (fileBindings.needsSandbox && !bindings.needsSandbox) {
            newBindings.push('Sandbox (bwf/sandbox)');
          }
          if (fileBindings.needsEmail && !bindings.needsEmail) {
            newBindings.push('Email (bwf/email)');
          }
          if (autoDetectAuth && fileBindings.needsAuth) {
            newBindings.push('Auth (bwf/auth)');
          }
          if (newBindings.length > 0) {
            hintShown = true;
            const detected = newBindings.join(', ');
            setTimeout(() => {
              bwfLog(`New ${detected} binding detected. Restart to apply.`);
            }, 300);
            server.hot.send({
              type: 'custom',
              event: 'platform:new-binding',
              data: { message: `New ${detected} binding detected.` },
            });
          }
        } catch {
          // Decision: Ignore transient read errors while files are being written or removed.
        }
      };
      // Decision: Attach after the HTTP server is listening so initial plugin file
      // writes (typegen, entry generation) don't trigger a spurious check.
      const attach = () => {
        server.watcher.on('add', check);
        server.watcher.on('change', check);
      };
      if (server.httpServer) {
        server.httpServer.once('listening', attach);
      } else {
        attach();
      }
    },
  };

  // Decision: Platform-managed auth uses native node:crypto password hashing.
  // PostgreSQL needs nodejs_compat for the `pg` driver (events, net, tls, dns, etc.).
  // Cloudflare's Sandbox SDK also imports Node built-ins.
  // Other apps only need nodejs_als for AsyncLocalStorage (isomorphic fetch context threading).
  const existingFlags = (workerConfig.compatibility_flags as Array<string> | undefined) ?? [];
  const needsNodejsCompat = authEnabled || dialect !== 'sqlite' || bindings.needsSandbox;
  const normalizedFlags = normalizeWranglerCompatibilityFlags(existingFlags, {
    needsNodejsCompat,
  });
  if (normalizedFlags && normalizedFlags !== existingFlags) {
    workerConfig.compatibility_flags = normalizedFlags;
  }

  let assetRoutingPublicDir: string | null = join(root, 'public');
  let managedCloudflareBuild = false;

  function resolveConfiguredAssetRoutingPolicy(): AssetRoutingPolicy {
    const routePatterns = application.routes;
    const environmentWebsocketRoutes = websocketRoutes.filter((route) =>
      isRouteEnabledForEnvironment(route, routeEnvironment),
    );
    const policy = resolveAssetRoutingPolicy({
      hasApiRoutes:
        routeScanHasApiRoutes(routePatterns) ||
        routeScanHasApiRoutes(environmentWebsocketRoutes) ||
        authEnabled,
      hasDocumentRoutes: routeScanHasDocumentRoutes(routePatterns),
      hasMiddleware: application.middleware.length > 0,
      hasWebSockets: routeScanHasDocumentRoutes(environmentWebsocketRoutes),
      authEnabled,
      liveEnabled: shouldEmitLive() && liveConfig !== undefined,
      notFound: config.routing?.notFound,
    });
    const rules = mergeRoutingRules({ dir: assetRoutingPublicDir, routing: config.routing });
    const nativeOwnsEdgeRouting =
      !managedCloudflareBuild &&
      edgeRulesNeedWorker({ ...rules, alwaysUseHttps: config.routing?.alwaysUseHttps });
    if (nativeOwnsEdgeRouting) {
      // Decision: Cloudflare otherwise serves an existing asset before the generated
      // Worker can apply redirects or response headers. Native builds own the
      // rule pipeline, so send every path through the Worker first. Managed
      // builds keep their inferred policy because dispatch owns these rules.
      policy.assetConfig.run_worker_first = ['/**'];
      // Decision: A SPA asset binding resolves its shell before the Worker can observe
      // an asset miss. Disable that platform fallback when native fallback
      // rules exist, then restore the SPA shell in serveWithAssets after the
      // ordered user fallbacks have had their chance.
      if (
        rules.fallbackRules?.length &&
        policy.assetConfig.not_found_handling === 'single-page-application'
      ) {
        policy.assetConfig.not_found_handling = 'none';
        policy.workerSpaFallback = true;
      }
    }
    return policy;
  }

  // Decision: Provisional: `routeEnvironment` is still its `prod` default here, because no
  // `config` hook has run yet. `envPlugin.config` recomputes this before any
  // consumer reads it — `mergeBindings` runs inside the Cloudflare plugin's own
  // `config` hook, which Vite sorts after `envPlugin`'s. It is assigned here so
  // `assetRouting` is never read while unassigned.
  assetRouting = resolveConfiguredAssetRoutingPolicy();

  workerConfig.main = join(root, '.bwf', 'entry.ts');

  function applyAssetRoutingPolicy(policy: AssetRoutingPolicy): void {
    workerConfig.assets = {
      binding: 'ASSETS',
      ...policy.assetConfig,
    };
  }

  function updateDevAssetRoutingPolicy(next: AssetRoutingPolicy): boolean {
    const previous = assetRouting;
    const requiresRestart =
      previous.workerFirst !== next.workerFirst ||
      previous.apiWorkerFirst !== next.apiWorkerFirst ||
      previous.assetConfig.not_found_handling !== next.assetConfig.not_found_handling ||
      JSON.stringify(previous.assetConfig.run_worker_first) !==
        JSON.stringify(next.assetConfig.run_worker_first);
    assetRouting = next;
    if (requiresRestart) {
      applyAssetRoutingPolicy(next);
    }
    return requiresRestart;
  }

  applyAssetRoutingPolicy(assetRouting);

  const routes = routingPlugin(root, {
    getApplicationAnalysis,
    isAuthEnabled: () => authEnabled,
    getVersionMetadataBinding: () => versionMetadataBinding,
    devTriggerToken,
    remoteMode,
    // Decision: Merged with `public/_redirects` and `_headers`; managed builds omit them (dispatch owns them).
    routing: config.routing,
    procedureTypes: config.procedureTypes,
    bindingNames,
    get hasSandbox() {
      return bindings.needsSandbox && !isSandboxAttached(sandboxConfig);
    },
    sandboxBindingName: sandboxConfig?.binding,
    sandboxClassName: sandboxConfig?.className,
    sandboxInstanceType: sandboxConfig?.instanceType,
    get live() {
      return shouldEmitLive() ? liveConfig : undefined;
    },
    durableObjects,
    websocketTombstones,
    onDevAssetRoutingPolicyChange: updateDevAssetRoutingPolicy,
    // Decision: Native builds of eligible apps let Cloudflare serve hashed build files directly.
    assetWorkerBypass: true,
  });

  return [
    createCloudflareBuiltinsExternalPlugin(),
    createDefaultWorkerEnvironmentPlugin(),
    createWorkerEnvironmentSanitizerPlugin([DEFAULT_WORKER_ENVIRONMENT_NAME]),
    createWranglerCompatPersistPlugin(root, config),
    devTriggerSecretGuardPlugin(),
    restartPlugin(),
    bindingWatchPlugin,
    ...(bindings.needsEmail ? [emailDevInboxPlugin({ devTriggerToken })] : []),
    envPlugin,
    envSchemaPlugin(root, { onSchema: applyEnvSchema }),
    envClientGuardPlugin(root),
    envClientFoldPlugin(),
    clientStubsPlugin,
    serverRuntimeOptimizerPlugin,
    bindingRuntimePlugin(bindingNames),
    ...(bindings.needsSandbox && !isSandboxAttached(sandboxConfig)
      ? [createSandboxSdkResolvePlugin()]
      : []),
    routes,
    drizzlePlugin(root, true, dialect, {
      d1BindingName: bindingNames?.d1,
      forceVirtualDb: authEnabled || bindingNames?.d1 !== undefined,
      casing: getDatabaseCasing(config),
      localD1DatabaseId: localD1.databaseId,
      localD1PersistRoot: localD1.persistRoot,
    }),
    migrationPlugin(root, dialect, localD1.databaseId, localD1.persistRoot, {
      enabled: authEnabled,
      configPath: authConfigPath,
    }),
    devTriggersHintPlugin(root, devTriggerToken),
    ...cloudflare({
      configPath: cloudflareConfigPath,
      ...inspectorPortOption,
      persistState: { path: localD1.persistRoot },
      auxiliaryWorkers: options?.auxiliaryWorkers,
      viteEnvironment: { name: DEFAULT_WORKER_ENVIRONMENT_NAME },
      config: mergeBindings,
      finalizeAssets(clientDir, environment) {
        // Decision: Vite can create a separate plugin instance for each environment. Use
        // the client instance that recorded this build's immutable asset files.
        const clientRoutes = environment?.config.plugins.find(
          (plugin) => plugin.name === routes.name,
        ) as typeof routes | undefined;
        clientRoutes?.api.finalizeCloudflareAssets(clientDir, environment!.config.build.assetsDir);
      },
    }),
    ...sentryIntegration.plugins,
    implicitDeployGuard,
  ];
}

export {
  defineHandler,
  defineMiddleware,
  basicAuth,
  defineScheduled,
  defineQueue,
  BwfAssetRewriteError,
} from './runtime/handler.ts';

export type {
  CloudContext,
  CloudContextVariables,
  CloudBindings,
  CloudEnv,
  BasicAuthOptions,
  TypedHandler,
  TypedQueueHandler,
  QueueBatch,
  QueueMessage,
  QueueRetryOptions,
} from './runtime/handler.ts';

export type { ValidatorSlots, HandlerInput } from './runtime/validator.ts';

export type { AuthUser } from './runtime/auth.ts';

export type { QueueMap } from './runtime/queues.ts';

export { shouldInjectEmailDevInboxVar } from './plugin-binding-utils.ts';

export { shouldBindWorkersAi, resolveWorkersAiBindingName } from './plugin-ai-setup.ts';
