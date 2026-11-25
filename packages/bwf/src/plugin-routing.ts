import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join, resolve } from 'pathslash';
import { createRunnableDevEnvironment, isRunnableDevEnvironment, normalizePath } from 'vite';
import type { Plugin, ResolvedConfig, RunnableDevEnvironment } from 'vite';
import type { ApplicationAnalysis } from './application-analysis.ts';
import { completeApplicationAnalysis } from './application-routing.ts';
import { hasApiRoutes, hasDocumentRoutes, resolveAssetRoutingPolicy } from './asset-routing.ts';
import type { AssetRoutingPolicy } from './asset-routing.ts';
import {
  isAssetBypassRule,
  isGeneratedAssetHeaders,
  resolveAssetWorkerBypass,
} from './asset-worker-bypass.ts';
import {
  AUTH_CONFIG_ENVIRONMENT,
  loadBwfAuthConfig,
  viteAuthConfigImporter,
} from './auth/config.ts';
import { resolveDistDir, resolveWorkerDirName } from './cli/build-output-dir.ts';
import { lintRoutingPhases, mergeRoutingRules } from './cli/headers.ts';
import { stampClientAssetCachePolicy } from './client-asset-manifest.ts';
import { removeAuthTypesIfPresent, syncAuthTypesFile } from './codegen/auth-types.ts';
import { findEnvFileForPaths } from './codegen/env-types.ts';
import { generateProcedureTypes } from './codegen/procedure-types.ts';
import { syncAuthTypesInProjectTsconfig } from './codegen/project-tsconfig.ts';
import { generateQueueTypes } from './codegen/queue-types.ts';
import { generateRouteTypes } from './codegen/route-types.ts';
import { writeFileIfChanged } from './codegen/write-if-changed.ts';
import { readConfig, getDatabaseDialect } from './config.ts';
import { readAppIdentity } from './procedures/scan.ts';
import { readProjectPaths } from './project-paths.ts';
import { readDeployBuildQueueNames } from './queues/cloudflare-names.ts';
import {
  compileRouteTable,
  compileBrowserClient,
  compileWorkerEntry,
  compileWorkerClient,
} from './router/compile.ts';
import type { CompileOptions } from './router/compile.ts';
import type { RouteEnvironment } from './router/parse-filename.ts';
import type { ScanResult } from './router/scan.ts';
import type { BwfAuthRuntimeOptions } from './runtime/better-auth-shared.ts';
import { loadLocalEnv } from './shared/env.ts';
import { invalidateSourceAnalysis } from './shared/source-analysis-cache.ts';

const VIRTUAL_ROUTES_ID = 'virtual:platform-routes';
const VIRTUAL_CLIENT_WORKER_ID = 'virtual:platform-client-worker';
const VIRTUAL_CLIENT_BROWSER_ID = 'virtual:platform-client-browser';
const AUTH_CLIENT_FRAMEWORKS = ['react'] as const;
type AuthClientFramework = (typeof AUTH_CLIENT_FRAMEWORKS)[number];
const CLIENT_IMPORT_RE = /^@builtbyfriends\/bwf\/client(?:\/(react))?$/;
const VIRTUAL_CLIENT_RE = /^virtual:platform-client-(browser|worker)(?::(react))?$/;
// Decision: Rolldown resolveId hook filters currently require RegExp for `id`.
const RESOLVE_ID_FILTER =
  /^(virtual:platform-(routes|client-worker(?::(react))?|client-browser(?::(react))?)|@builtbyfriends\/bwf(\/client(\/(react))?|\/queues)?)$/;
const LOAD_ID_FILTER =
  /^virtual:platform-(routes|client-worker(?::(react))?|client-browser(?::(react))?)$/;

type RoutingPluginOptions = {
  getApplicationAnalysis: (environment: RouteEnvironment, refresh?: boolean) => ApplicationAnalysis;
  isAuthEnabled: () => boolean;
  getVersionMetadataBinding?: () => string | undefined;
  devTriggerToken?: string;
  remoteMode?: boolean;
  bindingNames?: { d1?: string; kv?: string; r2?: string };
  /** Merged with `_redirects` / `_headers` under Vite's `publicDir`; config rules take precedence. */
  routing?: import('./config.ts').RoutingConfig;
  /** `procedureTypes` from the config: where to keep the types-only procedures file current. */
  procedureTypes?: string;
  hasSandbox?: boolean;
  sandboxBindingName?: string;
  sandboxClassName?: string;
  sandboxInstanceType?: string;
  live?: { bindingName: string; className: string };
  durableObjects?: Array<{
    bindingName: string;
    className: string;
    filePath: string;
    name?: string;
  }>;
  /** Data-preserving exports for removed WebSocket Durable Object routes. */
  websocketTombstones?: Array<string>;
  onDevAssetRoutingPolicyChange?: (policy: AssetRoutingPolicy) => boolean;
  /**
   * Let Cloudflare serve fingerprinted build files without the Worker when the
   * app allows it (see `asset-worker-bypass.ts`). Only the native Cloudflare
   * app build sets this.
   */
  assetWorkerBypass?: boolean;
};

/**
 * Vite plugin that provides file-based routing.
 * - Scans routes/ and middleware/ directories
 * - Generates virtual modules for the route table and worker entry
 * - Watches for file changes and triggers HMR
 */
export function routingPlugin(
  root: string,
  options: RoutingPluginOptions,
): Plugin & {
  api: { finalizeCloudflareAssets(clientDir: string, assetsDir: string): void };
} {
  let scan: ScanResult | null = null;
  let routeEnvironment: RouteEnvironment = 'prod';
  let previewing = false;
  let authConfigPath: string | null = null;

  // Decision: Inputs to the last successful route table and generated entries, including
  // authored auth settings that can change without changing the source scan.
  const routeInputsKey = () => JSON.stringify([scan, authConfigPath, compileOptions.auth]);
  let generatedRouteInputs: string | undefined;
  // Decision: Size and mtime of the generated files that checkpoint wrote.
  let generatedFiles: string | undefined;
  let pendingRegeneration = Promise.resolve();

  // Decision: Startup and watcher callbacks share the scan and compile options. Keep their
  // writes and successful-input checkpoint together, even across async auth work.
  function regenerateInOrder<T>(regenerate: () => Promise<T>): Promise<T> {
    const result = pendingRegeneration.then(regenerate);
    pendingRegeneration = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  const paths = readProjectPaths(root);
  const routesDir = paths.routesDir;
  const middlewareDir = paths.middlewareDir;
  const jobsDir = paths.cronsDir;
  const queuesDir = paths.queuesDir;
  const proceduresDir = paths.proceduresDir;
  const emailDir = paths.emailDir;
  const authConfigPaths = new Set(paths.authConfigCandidates.map((path) => normalizePath(path)));
  let authConfigEnvironment: RunnableDevEnvironment | undefined;
  // Decision: Set when a file the auth config loaded changes, or a load fails, so the
  // next load starts from an empty module graph.
  let authConfigStale = false;
  const envFilePaths = new Set(paths.envFileCandidates.map((path) => normalizePath(path)));
  const normalizedRoutesDir = normalizePath(routesDir);
  const normalizedMiddlewareDir = normalizePath(middlewareDir);
  const normalizedJobsDir = normalizePath(jobsDir);
  const normalizedQueuesDir = normalizePath(queuesDir);
  const normalizedProceduresDir = normalizePath(proceduresDir);
  const normalizedEmailDir = normalizePath(emailDir);

  function hasEmailHandlers(): boolean {
    const email = scan?.email;
    return Boolean(email && (email.addresses.length > 0 || email.defaultHandler));
  }

  function isInDirectory(path: string, directory: string): boolean {
    return path === directory || path.startsWith(directory + '/');
  }

  function writeRouteTypes() {
    if (!scan) {
      return;
    }
    const { dts } = generateRouteTypes(scan, routesDir, outDir, {
      typedRoutes: options.routing?.typedRoutes,
    });
    writeFileIfChanged(join(outDir, 'routes.d.ts'), dts);
  }

  function writeQueueTypes() {
    if (!scan) {
      return;
    }
    const dts = generateQueueTypes(scan.queues, queuesDir, outDir);
    writeFileIfChanged(join(outDir, 'queues.d.ts'), dts);
  }

  function writeProcedureTypes() {
    if (!scan || !existsSync(proceduresDir)) {
      return;
    }
    const dts = generateProcedureTypes(scan.procedures ?? [], proceduresDir, outDir);
    writeFileIfChanged(join(outDir, 'procedures.d.ts'), dts);
  }

  // Decision: A web workspace's copy of the procedure types depends on schema contents, so it is
  // rewritten on any procedure edit. Edits that land while a run is going share one more run.
  let wireTypesRun: Promise<void> | undefined;
  let wireTypesAgain = false;
  function scheduleWireProcedureTypes(logger: { error: (message: string) => void }) {
    const target = options.procedureTypes;
    if (!target || !scan) {
      return;
    }
    if (wireTypesRun) {
      wireTypesAgain = true;
      return;
    }
    wireTypesRun = (async () => {
      do {
        wireTypesAgain = false;
        try {
          const { writeWireProcedureTypes } = await import('./codegen/wire-procedure-types.ts');
          await writeWireProcedureTypes({
            root,
            target,
            proceduresDir,
            files: scan?.procedures ?? [],
          });
        } catch (error) {
          logger.error(`bwf: could not update ${target}: ${(error as Error).message}`);
        }
      } while (wireTypesAgain);
      wireTypesRun = undefined;
    })();
  }

  async function rescan(refresh = false) {
    const analysis = options.getApplicationAnalysis(routeEnvironment, refresh);
    scan = (await completeApplicationAnalysis(analysis)).scan;
    authConfigPath = analysis.authConfigPath;
  }

  // Decision: Pre-resolve all runtime module paths so generated code uses absolute paths:
  // 1. A bare "platform" import would pull in the entire plugin.
  // 2. "hono" is a dependency of bwf, not of the user's project.
  // 3. Virtual modules have no filesystem location for relative resolution.
  const resolveFile = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));

  const handlerFile = resolveFile('#self/handler');
  const runtimeDir = dirname(resolveFile('#self/client'));
  const fetchPath = resolveFile('#self/runtime/fetch');
  const fetchStreamPath = resolveFile('#self/runtime/fetch-stream');
  const sandboxRuntimePath = resolveFile('#self/sandbox');
  const drizzleAdapterPath = resolveFile('better-auth/adapters/drizzle');
  const authClientPath = join(runtimeDir, 'auth-client.mjs');
  const explicitAuthClientPaths: Record<AuthClientFramework, string> = {
    react: join(runtimeDir, 'auth-client-react.mjs'),
  };
  const remote = options.remoteMode
    ? {
        bindingNames: options.bindingNames,
        remotePath: resolveFile('#self/remote'),
      }
    : undefined;
  // Decision: If the project has env.ts, splice boot-time validation into the worker
  // entry. The user file path is absolute so generated entry's import resolves
  // regardless of bundler cwd; the validator helper resolves to bwf/env.
  function getEnvSchemaModule(): { importPath: string; helperPath: string } | undefined {
    const envFile = findEnvFileForPaths(root, paths);
    if (!envFile) {
      return undefined;
    }
    return {
      importPath: envFile,
      helperPath: resolveFile('#self/env'),
    };
  }
  const runtimeEmailPath = resolveFile('#self/email');
  const compileOptions: CompileOptions = {
    runtimeEnvPath: resolveFile('#self/_env'),
    emailDir,
    projectRoot: root,
    homeDir: homedir(),
    webSocketRuntimePath: resolveFile('#self/runtime/ws-server'),
    liveRuntimePath: resolveFile('#self/runtime/live-server'),
    hasLive: options.live !== undefined,
    webSocketTombstones: options.websocketTombstones,
    dev: false,
    devTriggerToken: options.devTriggerToken,
    auth: null,
    managedDispatch: false,
    bindingHandlerPath: resolveFile('#self/remote/binding-handler'),
    procedures: {
      dir: proceduresDir,
      runtimePath: resolveFile('#self/runtime/procedures'),
      ...readAppIdentity(root),
    },
    bindingNames: options.bindingNames,
  };

  // Decision: Vite's default until `configResolved` reads the real value; null when `publicDir: false`.
  let publicDir: string | null = join(root, 'public');
  function reloadFileRules(): void {
    // Decision: Config rules still apply without a public dir, and stale preload rules are cleared.
    const merged = mergeRoutingRules({ dir: publicDir, routing: options.routing });
    lintRoutingPhases(merged);
    compileOptions.headerRules = merged.headerRules.length > 0 ? merged.headerRules : undefined;
    compileOptions.redirectRules =
      merged.redirectRules.length > 0 ? merged.redirectRules : undefined;
    compileOptions.fallbackRules = merged.fallbackRules;
  }
  reloadFileRules();

  // Decision: Resolve auth after config hooks have run and the auth config path is known.
  function resolveAuthCompileOptions(): void {
    if (!options.isAuthEnabled() && !authConfigPath) {
      compileOptions.auth = null;
      return;
    }
    const config = readConfig(root);
    const dialect = getDatabaseDialect(config);
    compileOptions.auth = {
      authRuntimePath:
        dialect === 'postgresql'
          ? join(runtimeDir, 'better-auth-pg.mjs')
          : dialect === 'mysql'
            ? join(runtimeDir, 'better-auth-mysql.mjs')
            : join(runtimeDir, 'better-auth.mjs'),
      authConfigPath,
      authDatabasePath: join(outDir, 'better-auth-db.ts'),
      authSchemaPath: join(outDir, 'better-auth-schema.ts'),
      dialect,
      providers: config.auth?.providers ?? null,
    };
  }

  /**
   * Size and mtime of every generated file, or undefined when one is missing.
   * Another void process in the same root (a build, `bwf db generate`) can
   * rewrite them, and the dev watcher ignores `.bwf/`.
   */
  function generatedFilesSignature(): string | undefined {
    const files = [
      'routes.d.ts',
      'queues.d.ts',
      ...(existsSync(proceduresDir) ? ['procedures.d.ts'] : []),
      'entry.ts',
      ...(compileOptions.auth
        ? [
            'better-auth-db.ts',
            'better-auth-schema.ts',
            ...(compileOptions.auth.authConfigPath ? ['auth.d.ts'] : []),
          ]
        : []),
    ];
    const parts: Array<string> = [];
    for (const file of files) {
      const stat = statSync(join(outDir, file), { throwIfNoEntry: false });
      if (!stat?.isFile()) {
        return undefined;
      }
      parts.push(`${file}:${stat.size}:${stat.mtimeMs}`);
    }
    return parts.join('|');
  }

  async function loadAuthConfig(configPath: string | null) {
    const environment = authConfigEnvironment;
    if (authConfigStale && environment) {
      // Decision: The runner checks each import against the graph. Invalidate all of
      // it: a failed import stays in it under the specifier it could not
      // resolve, not under a file path.
      environment.moduleGraph.invalidateAll();
    }
    authConfigStale = false;
    try {
      return await loadBwfAuthConfig(
        configPath,
        environment
          ? (path) => environment.runner.import(path)
          : viteAuthConfigImporter(root, resolvedConfig?.mode, resolvedConfig?.resolve),
      );
    } catch (error) {
      authConfigStale = true;
      throw error;
    }
  }

  async function writeAuthDatabaseFiles(): Promise<void> {
    if (!compileOptions.auth) {
      if (removeAuthTypesIfPresent(outDir)) {
        syncAuthTypesInProjectTsconfig(root);
      }
      return;
    }

    // Decision: Better Auth's schema helpers load zod and most of better-auth; only auth apps need them.
    const { generateBwfAuthDatabaseModule, generateBwfAuthDrizzleSchema } =
      await import('./auth/drizzle.ts');
    const authRuntime: BwfAuthRuntimeOptions = {
      dialect: compileOptions.auth.dialect,
      providers: compileOptions.auth.providers,
      userConfig: await loadAuthConfig(compileOptions.auth.authConfigPath),
    };
    const local = resolvedConfig?.command === 'serve' ? loadLocalEnv(root) : {};
    const env = { ...local, ...process.env } as Record<string, unknown>;
    const { authSchemaPath, authDatabasePath } = compileOptions.auth;

    writeFileIfChanged(authSchemaPath, generateBwfAuthDrizzleSchema(authRuntime, env));
    writeFileIfChanged(
      authDatabasePath,
      generateBwfAuthDatabaseModule({
        dialect: compileOptions.auth.dialect,
        schemaImportPath: authSchemaPath,
        drizzleAdapterPath,
        d1BindingName: options.bindingNames?.d1,
      }),
    );

    syncAuthTypesFile(compileOptions.auth.authConfigPath, outDir);
    syncAuthTypesInProjectTsconfig(root);
  }

  let resolvedConfig: import('vite').ResolvedConfig | null = null;

  function getClientAuthPath(id: string): string {
    const framework = VIRTUAL_CLIENT_RE.exec(id)?.[2] as AuthClientFramework | undefined;
    return framework ? explicitAuthClientPaths[framework] : authClientPath;
  }

  function resolveVirtualClientId(
    id: string,
    environmentName: string | undefined,
  ): string | undefined {
    const framework = CLIENT_IMPORT_RE.exec(id)?.[1] as AuthClientFramework | undefined;
    const base =
      environmentName === 'client' ? VIRTUAL_CLIENT_BROWSER_ID : VIRTUAL_CLIENT_WORKER_ID;
    return framework ? `${base}:${framework}` : base;
  }

  function isPotentialAuthConfigPath(path: string): boolean {
    const normalized = normalizePath(path);
    return (
      authConfigPaths.has(normalized) ||
      (authConfigEnvironment?.moduleGraph.getModulesByFile(normalized)?.size ?? 0) > 0
    );
  }

  function isPotentialEnvFilePath(path: string): boolean {
    return envFilePaths.has(normalizePath(path));
  }

  function resolveCurrentAssetRoutingPolicy(): AssetRoutingPolicy {
    const { routes, websockets = [], middleware } = scan!;
    return resolveAssetRoutingPolicy({
      hasApiRoutes:
        hasApiRoutes(routes) || hasApiRoutes(websockets) || compileOptions.auth !== null,
      hasDocumentRoutes: hasDocumentRoutes(routes),
      hasMiddleware: middleware.length > 0,
      hasWebSockets: hasDocumentRoutes(websockets),
      authEnabled: compileOptions.auth !== null,
      liveEnabled: options.live !== undefined,
      notFound: options.routing?.notFound,
    });
  }

  let clientImmutableFiles: Array<string> = [];

  /**
   * The generated `_headers` text when this build can skip the Worker for its
   * hashed files, and the new `wrangler.json` text when it changes; null when
   * there is no built Worker config. Reads only, so a read failure leaves the
   * output unchanged.
   */
  function planAssetWorkerBypass(
    clientDir: string,
    assetsDir: string,
    userHeaders: boolean,
  ): { headers: string | null; wranglerPath: string; wranglerText: string | null } | null {
    if (!scan || !resolvedConfig || compileOptions.managedDispatch) {
      return null;
    }
    let wranglerPath: string;
    let wrangler: { assets?: Record<string, unknown> };
    try {
      const distDir = resolveDistDir(root);
      wranglerPath = join(distDir, resolveWorkerDirName(distDir), 'wrangler.json');
      wrangler = JSON.parse(readFileSync(wranglerPath, 'utf8'));
    } catch {
      return null;
    }
    const assets = wrangler?.assets;
    if (
      !assets ||
      typeof assets !== 'object' ||
      typeof assets.directory !== 'string' ||
      resolve(dirname(wranglerPath), assets.directory) !== clientDir
    ) {
      return null;
    }
    // Decision: A client-only watch rebuild finds what an earlier bypass wrote instead of
    // the Worker build's rule.
    const workerBuildRule = isAssetBypassRule(assets.run_worker_first, assetsDir)
      ? ['/**']
      : assets.run_worker_first;
    const routePatterns = [...scan.routes, ...(scan.websockets ?? [])].map(
      (route) => route.pattern,
    );
    const facts = {
      runWorkerFirst: workerBuildRule,
      notFoundHandling: assets.not_found_handling,
      base: resolvedConfig.base,
      hasMiddleware: scan.middleware.length > 0,
      authEnabled: compileOptions.auth !== null,
      headerRuleCount: compileOptions.headerRules?.length ?? 0,
      redirectRuleCount: compileOptions.redirectRules?.length ?? 0,
      fallbackRuleCount: compileOptions.fallbackRules?.length ?? 0,
      publicEdgeFiles:
        publicDir !== null &&
        (existsSync(join(publicDir, '_headers')) || existsSync(join(publicDir, '_redirects'))),
      patterns: routePatterns,
      assetsDir,
      immutableFiles: clientImmutableFiles,
    };
    const bypass = userHeaders ? null : resolveAssetWorkerBypass(facts);
    const runWorkerFirst = bypass?.runWorkerFirst ?? workerBuildRule;
    return {
      headers: bypass?.headers ?? null,
      wranglerPath,
      wranglerText: isDeepStrictEqual(runWorkerFirst, assets.run_worker_first)
        ? null
        : JSON.stringify({ ...wrangler, assets: { ...assets, run_worker_first: runWorkerFirst } }),
    };
  }

  // Decision: The Cloudflare bridge calls this after both compatible outputs exist.
  function finalizeCloudflareAssets(clientDir: string, assetsDir: string): void {
    if (!options.assetWorkerBypass || resolvedConfig?.command !== 'build') {
      return;
    }
    const headersPath = join(clientDir, '_headers');
    let generatedHeaders = false;
    let userHeaders = false;
    if (existsSync(headersPath)) {
      try {
        generatedHeaders = isGeneratedAssetHeaders(readFileSync(headersPath, 'utf8'));
      } catch {
        return;
      }
      // Decision: A user-authored `_headers` keeps the Worker in front, as before.
      userHeaders = !generatedHeaders;
    }
    const plan = planAssetWorkerBypass(clientDir, assetsDir, userHeaders);
    // Decision: `_headers` first: on its own it changes nothing, as the Worker sets
    // the same policy for these files. Write errors fail the build.
    if (plan?.headers) {
      writeFileSync(headersPath, plan.headers);
    } else if (generatedHeaders) {
      // Decision: A `_headers` left by an earlier build must not outlive the bypass.
      rmSync(headersPath);
    }
    if (plan?.wranglerText) {
      writeFileSync(plan.wranglerPath, plan.wranglerText);
    }
  }

  const sandboxEntry = options.hasSandbox
    ? {
        bindingName: options.sandboxBindingName,
        className: options.sandboxClassName,
        instanceType: options.sandboxInstanceType,
        runtimePath: sandboxRuntimePath,
      }
    : false;

  function writeWorkerEntry(): void {
    const policy = resolveCurrentAssetRoutingPolicy();
    writeFileIfChanged(
      join(outDir, 'entry.ts'),
      compileWorkerEntry({
        versionMetadataBinding: options.getVersionMetadataBinding?.(),
        // Decision: Managed dispatch enforces HTTPS before the app Worker runs.
        alwaysUseHttps:
          options.routing?.alwaysUseHttps === true &&
          resolvedConfig?.command === 'build' &&
          !compileOptions.managedDispatch,
        hasQueues: scan!.queues.length > 0,
        remote,
        assetsDir: resolvedConfig?.build.assetsDir,
        webSocketClasses: [
          ...(scan!.websockets ?? []).map((route) => route.className),
          ...(options.websocketTombstones ?? []),
        ],
        runtimeEnvPath: compileOptions.runtimeEnvPath,
        runtimeEmailPath,
        envSchemaModule: getEnvSchemaModule(),
        sandbox: sandboxEntry,
        hasEmail: hasEmailHandlers(),
        serveSpaFallback: policy.workerSpaFallback,
        live: options.live,
        dev: compileOptions.dev,
        notFound: policy.assetConfig.not_found_handling ?? 'none',
        durableObjects: options.durableObjects,
      }),
    );
  }

  // Decision: Generate the entry file and tsconfig eagerly (at plugin creation time,
  // during bwfPlugin()). The CF plugin needs the `main` file to exist at
  // config resolution time, which is before any hooks like buildStart fire.
  // The tsconfig.json allows users to extend it from their root tsconfig
  // so generated types (.bwf/routes.d.ts) are discovered automatically.
  const outDir = join(root, '.bwf');
  mkdirSync(outDir, { recursive: true });
  // Decision: Write initial entry — will be re-written with hasQueues once scan completes
  writeFileIfChanged(
    join(outDir, 'entry.ts'),
    compileWorkerEntry({
      versionMetadataBinding: options.getVersionMetadataBinding?.(),
      remote,
      webSocketClasses: options.websocketTombstones,
      runtimeEnvPath: compileOptions.runtimeEnvPath,
      runtimeEmailPath,
      envSchemaModule: getEnvSchemaModule(),
      sandbox: sandboxEntry,
      live: options.live,
      durableObjects: options.durableObjects,
    }),
  );

  return {
    name: 'platform:routing',
    api: { finalizeCloudflareAssets },
    enforce: 'pre',
    configResolved(config) {
      resolvedConfig = config;
      // Decision: `vite preview` reports `command: 'serve'` but runs the built bundle,
      // so it never compiles the route table as dev.
      compileOptions.dev = config.command === 'serve' && !previewing;
      compileOptions.assetsDir = config.build.assetsDir;
      const clientOptimizer = config.environments?.client?.optimizeDeps;
      if (compileOptions.dev && options.isAuthEnabled() && clientOptimizer) {
        for (const specifier of ['better-auth/client', 'better-auth/react']) {
          const excluded = clientOptimizer.exclude?.some(
            (dependency) => specifier === dependency || specifier.startsWith(`${dependency}/`),
          );
          if (!excluded) {
            // Decision: Virtual auth imports are invisible to the initial dependency scan.
            clientOptimizer.include ??= [];
            clientOptimizer.include.push(specifier);
          }
        }
      }
      compileOptions.cloudflareQueueNames =
        config.command === 'build' ? readDeployBuildQueueNames() : undefined;
      // Decision: Vite resolves `publicDir: false` to ''.
      const resolvedPublicDir =
        config.publicDir && config.publicDir.length > 0 ? config.publicDir : null;
      if (resolvedPublicDir !== publicDir) {
        publicDir = resolvedPublicDir;
        reloadFileRules();
      }
    },
    config(_, env) {
      previewing = env.isPreview === true;
      routeEnvironment = env.command === 'serve' && !env.isPreview ? 'dev' : 'prod';
      // Decision: Dev only, so builds never see the environment.
      const authConfigEnvironmentConfig =
        routeEnvironment === 'dev'
          ? {
              environments: {
                [AUTH_CONFIG_ENVIRONMENT]: {
                  consumer: 'server' as const,
                  dev: {
                    createEnvironment: (name: string, config: ResolvedConfig) =>
                      // Decision: bwf invalidates it on saves; no HMR client to run.
                      createRunnableDevEnvironment(name, config, {
                        hot: false,
                        runnerOptions: { hmr: false },
                      }),
                  },
                },
              },
            }
          : {};
      compileOptions.hasLive = options.live !== undefined;
      compileOptions.managedDispatch =
        env.command === 'build' && Boolean(process.env.PLATFORM_DEPLOY_PROJECT_ID);

      if (env.command === 'serve' && options.isAuthEnabled()) {
        // Decision: Alias better-auth client subpaths to absolute file paths so
        // Vite can resolve them during SSR without the bare specifiers
        // needing to be hoisted into the user's node_modules (pnpm
        // strict mode). Without this, Vite discovers them lazily on
        // first auth page load, triggering a disruptive program reload.
        const betterAuthSubpaths = ['client', 'react'];
        const resolvedAliases = betterAuthSubpaths.flatMap((sub) => {
          try {
            return [
              {
                find: new RegExp(`^better-auth/${sub}$`),
                replacement: resolveFile(`better-auth/${sub}`),
              },
            ];
          } catch {
            return [];
          }
        });

        return { ...authConfigEnvironmentConfig, resolve: { alias: resolvedAliases } };
      }

      if (env.command !== 'build') {
        return authConfigEnvironmentConfig;
      }

      return { build: { manifest: _.build?.manifest ?? true } };
    },

    generateBundle: {
      order: 'post',
      handler(_output, bundle) {
        const manifest = this.environment.config.build.manifest;
        if (this.environment.name === 'client') {
          clientImmutableFiles = manifest
            ? stampClientAssetCachePolicy(
                bundle,
                typeof manifest === 'string' ? manifest : '.vite/manifest.json',
                compileOptions.headerRules,
              )
            : [];
        }
      },
    },

    buildStart() {
      return regenerateInOrder(async () => {
        generatedRouteInputs = undefined;
        await rescan();
        resolveAuthCompileOptions();
        const nextRouteInputs = routeInputsKey();
        await writeAuthDatabaseFiles();
        writeRouteTypes();
        writeQueueTypes();
        writeProcedureTypes();

        const migrationsDir = paths.migrationsDir;
        if (existsSync(migrationsDir) || compileOptions.auth) {
          const { collectMigrations } = await import('./migrations/collect.ts');
          const { buildMigrationPlanBundle } = await import('./migrations/plan.ts');
          const migrations = existsSync(migrationsDir) ? collectMigrations(migrationsDir) : [];
          const dialect = getDatabaseDialect(readConfig(root));
          compileOptions.migrationHandlerPath = resolveFile(
            dialect === 'postgresql'
              ? '#self/runtime/migration-handler-pg'
              : dialect === 'mysql'
                ? '#self/runtime/migration-handler-mysql'
                : '#self/runtime/migration-handler',
          );
          compileOptions.migrations = migrations;
          compileOptions.migrationPlanBundle =
            dialect === 'sqlite' ? buildMigrationPlanBundle(migrations) : undefined;
        }
        writeWorkerEntry();

        generatedRouteInputs = nextRouteInputs;
        generatedFiles = generatedFilesSignature();
      });
    },

    // Decision: `vite build --watch` reruns buildStart without the dev watcher below, so
    // forget the analysis of each changed file here as well.
    watchChange(id) {
      invalidateSourceAnalysis(id);
    },

    resolveId: {
      filter: { id: RESOLVE_ID_FILTER },
      handler(id) {
        if (id === VIRTUAL_ROUTES_ID) {
          return VIRTUAL_ROUTES_ID;
        }
        if (id === VIRTUAL_CLIENT_WORKER_ID) {
          return VIRTUAL_CLIENT_WORKER_ID;
        }
        if (id === VIRTUAL_CLIENT_BROWSER_ID) {
          return VIRTUAL_CLIENT_BROWSER_ID;
        }
        // Decision: Redirect bare "platform" imports to the lightweight handler
        // subpath to avoid pulling the entire plugin into the Worker bundle.
        if (id === '@builtbyfriends/bwf') {
          return handlerFile;
        }
        if (id === '@builtbyfriends/bwf/queues') {
          return resolveFile('#self/queues');
        }
        if (CLIENT_IMPORT_RE.test(id)) {
          return resolveVirtualClientId(id, this.environment?.name);
        }
      },
    },

    load: {
      filter: { id: LOAD_ID_FILTER },
      async handler(id) {
        const virtualClient = VIRTUAL_CLIENT_RE.exec(id);
        if (virtualClient?.[1] === 'browser') {
          return compileBrowserClient(getClientAuthPath(id), fetchPath, fetchStreamPath);
        }
        if (virtualClient?.[1] === 'worker') {
          return compileWorkerClient(getClientAuthPath(id));
        }
        if (id !== VIRTUAL_ROUTES_ID) {
          return;
        }
        // Decision: The route table embeds the dev-trigger token. Only server environments import
        // it; refusing the client environment keeps `/@id/virtual:platform-routes` from
        // returning it, either as the module or as code on Vite's error page.
        if (this?.environment?.name === 'client') {
          throw new Error(
            `${VIRTUAL_ROUTES_ID} is server-only and cannot be loaded by client code.`,
          );
        }
        if (!scan) {
          await regenerateInOrder(() => rescan());
        }
        return compileRouteTable(
          scan!,
          routesDir,
          middlewareDir,
          jobsDir,
          queuesDir,
          compileOptions,
        );
      },
    },

    hotUpdate() {
      // Decision: bwf invalidates this environment itself; Vite's update pass would
      // only log a page reload that nothing receives.
      if (this.environment.name === AUTH_CONFIG_ENVIRONMENT) {
        return [];
      }
    },

    async configureServer(devServer) {
      const authEnvironment = devServer.environments[AUTH_CONFIG_ENVIRONMENT];
      authConfigEnvironment =
        authEnvironment && isRunnableDevEnvironment(authEnvironment) ? authEnvironment : undefined;

      const watcher = devServer.watcher;

      const handleFileChange = async (path: string, event: 'add' | 'change' | 'unlink') => {
        const normalizedPath = normalizePath(path);
        invalidateSourceAnalysis(normalizedPath);
        const authConfigChanged = isPotentialAuthConfigPath(normalizedPath);
        if (authConfigChanged) {
          authConfigStale = true;
        }
        // Decision: After a failed load, a new file may be the import that was missing.
        const authImportCreated =
          event === 'add' && authConfigStale && compileOptions.auth !== null;

        const sourceConventionChanged =
          isInDirectory(normalizedPath, normalizedRoutesDir) ||
          isInDirectory(normalizedPath, normalizedMiddlewareDir) ||
          isInDirectory(normalizedPath, normalizedJobsDir) ||
          isInDirectory(normalizedPath, normalizedQueuesDir) ||
          isInDirectory(normalizedPath, normalizedProceduresDir) ||
          isInDirectory(normalizedPath, normalizedEmailDir) ||
          authConfigChanged ||
          authImportCreated ||
          isPotentialEnvFilePath(normalizedPath);
        if (!sourceConventionChanged) {
          return;
        }

        const shouldRestart = await regenerateInOrder(async () => {
          invalidateSourceAnalysis(normalizedPath);
          // Decision: Re-scan and invalidate the virtual module in ALL environments.
          // The route table virtual module lives in the workerd environment,
          // not the client — so we must iterate all environments.
          const forceRegeneration =
            event !== 'change' || authConfigChanged || isPotentialEnvFilePath(normalizedPath);

          if (forceRegeneration) {
            generatedRouteInputs = undefined;
          }

          try {
            await rescan(true);
          } catch (error) {
            // Decision: Keep the last good route table; the next change rescans.
            const message = error instanceof Error ? error.message : String(error);
            devServer.config.logger.error(message, {
              error: error instanceof Error ? error : undefined,
              timestamp: true,
            });
            return;
          }
          resolveAuthCompileOptions();
          if (isInDirectory(normalizedPath, normalizedProceduresDir)) {
            scheduleWireProcedureTypes(devServer.config.logger);
          }
          const nextRouteInputs = routeInputsKey();

          // Decision: Saving a handler usually changes nothing the scan reports.
          // Vite already invalidates the saved module, so the route table only needs
          // regenerating when the scan moved.
          const currentFiles = generatedFilesSignature();
          const routeInputsChanged =
            nextRouteInputs !== generatedRouteInputs ||
            currentFiles === undefined ||
            currentFiles !== generatedFiles;

          if (routeInputsChanged) {
            // Decision: A failed forced update must also retry when the scan itself is unchanged.
            generatedRouteInputs = undefined;
          }

          const shouldRestartForAssetRouting =
            event !== 'change' &&
            options.onDevAssetRoutingPolicyChange?.(resolveCurrentAssetRoutingPolicy()) === true;
          if (shouldRestartForAssetRouting) {
            return true;
          }

          if (routeInputsChanged) {
            await writeAuthDatabaseFiles();
            writeRouteTypes();
            writeQueueTypes();
            writeProcedureTypes();

            writeWorkerEntry();
          }

          // Decision: For structural changes (file add/remove), send full-reload to trigger
          // a program reload so the workerd picks up new/removed routes.
          // For content-only changes, module invalidation alone is sufficient —
          // the workerd re-evaluates stale modules on the next request. Sending
          // full-reload for content changes triggers an unnecessary program reload
          // that is not needed.
          const structural = event !== 'change';

          for (const env of Object.values(devServer.environments)) {
            const mod = env.moduleGraph.getModuleById(VIRTUAL_ROUTES_ID);
            if (mod && routeInputsChanged) {
              env.moduleGraph.invalidateModule(mod);
              if (structural) {
                env.hot.send({ type: 'full-reload' });
              }
            }
          }

          if (routeInputsChanged) {
            generatedRouteInputs = nextRouteInputs;
            generatedFiles = generatedFilesSignature();
          }
        });

        // Decision: Restart runs buildStart again, so release the generation queue first.
        if (shouldRestart) {
          await devServer.restart();
        }
      };

      const onFileChange = (path: string, event: 'add' | 'change' | 'unlink') =>
        handleFileChange(path, event).catch((error: unknown) => {
          devServer.config.logger.error(error instanceof Error ? error.message : String(error), {
            error: error instanceof Error ? error : undefined,
            timestamp: true,
          });
        });
      watcher.on('add', (path) => onFileChange(path, 'add'));
      watcher.on('change', (path) => onFileChange(path, 'change'));
      watcher.on('unlink', (path) => onFileChange(path, 'unlink'));

      // Decision: File-based routing rule HMR: `public/_redirects` / `public/_headers`
      // changes re-merge + invalidate the route module so rules take effect
      // without restarting the dev server. `vite dev` bakes rules into the compiled Hono app.
      if (publicDir) {
        const redirectsPath = join(publicDir, '_redirects');
        const headersPath = join(publicDir, '_headers');
        const handleRulesFileChange = (path: string) => {
          if (path !== redirectsPath && path !== headersPath) {
            return;
          }
          reloadFileRules();
          for (const env of Object.values(devServer.environments)) {
            const mod = env.moduleGraph.getModuleById(VIRTUAL_ROUTES_ID);
            if (mod) {
              env.moduleGraph.invalidateModule(mod);
              env.hot.send({ type: 'full-reload' });
            }
          }
        };
        watcher.on('add', handleRulesFileChange);
        watcher.on('change', handleRulesFileChange);
        watcher.on('unlink', handleRulesFileChange);
      }

      // Decision: Later configureServer hooks can load app modules before buildStart.
      // Their imports may already reference the generated authentication tables.
      if (options.isAuthEnabled()) {
        await regenerateInOrder(async () => {
          await rescan();
          resolveAuthCompileOptions();
          await writeAuthDatabaseFiles();
        });
      }
    },
  };
}
