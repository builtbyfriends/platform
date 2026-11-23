import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

type MockCloudflarePluginConfig = {
  config: (resolved: Record<string, unknown>) => Record<string, unknown>;
};

type MockCloudflarePlugin = Plugin & {
  api: {
    pluginConfig: MockCloudflarePluginConfig;
  };
};

vi.mock('../../src/plugin-cloudflare.ts', () => import('../helpers/cloudflare-vite-plugin.ts'));

const tempDirs: Array<string> = [];

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-dev-assets-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(root, 'bwf.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' } }),
  );
  return root;
}

function createPagesProjectRoot(): string {
  const root = createProjectRoot();
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(
    join(root, 'pages', 'index.tsx'),
    'export default function Page() { return null; }',
  );
  return root;
}

function createApiOnlyProjectRoot(): string {
  const root = createProjectRoot();
  mkdirSync(join(root, 'routes/api'), { recursive: true });
  writeFileSync(join(root, 'routes/api/hello.ts'), 'export const GET = () => Response.json({});');
  return root;
}

function createConfiguredEdgeRulesProjectRoot(): string {
  const root = createApiOnlyProjectRoot();
  writeFileSync(
    join(root, 'bwf.json'),
    JSON.stringify({
      worker: { compatibility_date: '2026-02-24' },
      routing: {
        headers: { '/asset.txt': ['X-Edge: yes'] },
        redirects: { '/old.txt': '/new.txt' },
      },
    }),
  );
  return root;
}

function createFrameworkProjectRoot(): string {
  const root = createProjectRoot();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ type: 'module', dependencies: { vinext: '^0.0.5', react: '^19.0.0' } }),
  );
  return root;
}

function createFrameworkOwnedRuntimeProjectRoot(): string {
  const root = createProjectRoot();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ type: 'module', dependencies: { '@analogjs/platform': '^2.0.0' } }),
  );
  return root;
}

function createAstroProjectRoot(): string {
  const root = createProjectRoot();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ type: 'module', dependencies: { astro: '^7.0.0' } }),
  );
  return root;
}

function createNodeProjectRoot(): string {
  const root = createProjectRoot();
  writeFileSync(
    join(root, 'bwf.json'),
    JSON.stringify({ target: 'node', worker: { compatibility_date: '2026-02-24' } }),
  );
  return root;
}

function useDatabase(root: string, database: 'pg' | 'mysql'): string {
  const configPath = join(root, 'bwf.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, database }));
  return root;
}

function createDevOnlyApiProjectRoot(): string {
  const root = createProjectRoot();
  mkdirSync(join(root, 'routes/api'), { recursive: true });
  writeFileSync(
    join(root, 'routes/api/debug.dev.ts'),
    'export const GET = () => Response.json({});',
  );
  return root;
}

function createBindingProjectRoot(): string {
  const root = createProjectRoot();
  mkdirSync(join(root, 'routes/api'), { recursive: true });
  writeFileSync(
    join(root, 'routes/api/bindings.ts'),
    `
import { db } from "@builtbyfriends/bwf/db";
import { storage } from "@builtbyfriends/bwf/storage";

export async function GET() {
  await db.select();
  await storage.head("key");
  return Response.json({});
}
`,
  );
  return root;
}

function createAiProjectRoot(platform: 'cloudflare' | 'platform'): string {
  const root = createProjectRoot();
  mkdirSync(join(root, 'routes/api'), { recursive: true });
  writeFileSync(
    join(root, 'routes/api/ai.ts'),
    'import { ai } from "@builtbyfriends/bwf/ai"; export const GET = () => ai.run("model", {});',
  );
  mkdirSync(join(root, '.bwf'), { recursive: true });
  writeFileSync(
    join(root, '.bwf/project.json'),
    JSON.stringify({
      platform,
      ...(platform === 'platform' && {
        projectId: 'managed-project',
        proxyUrl: 'https://proxy.void.cloud',
        slug: 'managed-project',
      }),
    }),
  );
  return root;
}

function saveDeploymentPlatform(root: string, platform: 'cloudflare' | 'platform'): void {
  mkdirSync(join(root, '.bwf'), { recursive: true });
  writeFileSync(join(root, '.bwf/project.json'), JSON.stringify({ platform }));
}

function createCustomBindingProjectRoot(): string {
  const root = createBindingProjectRoot();
  writeFileSync(
    join(root, 'bwf.json'),
    JSON.stringify({
      inference: { bindings: { db: 'myapp_db', kv: 'myapp_kv', storage: 'myapp_storage' } },
      worker: { compatibility_date: '2026-02-24' },
    }),
  );
  return root;
}

function createApiWebSocketOnlyProjectRoot(): string {
  const root = createProjectRoot();
  mkdirSync(join(root, 'routes/api'), { recursive: true });
  writeFileSync(
    join(root, 'routes/api/chat.ws.ts'),
    'export default defineWebSocket({ onMessage() {} });',
  );
  return root;
}

function createAuthOnlyProjectRoot(): string {
  const root = createProjectRoot();
  writeFileSync(
    join(root, 'bwf.json'),
    JSON.stringify({
      auth: { providers: ['email'] },
      worker: { compatibility_date: '2026-02-24' },
    }),
  );
  return root;
}

function createDocumentRouteProjectRoot(): string {
  const root = createProjectRoot();
  mkdirSync(join(root, 'routes'), { recursive: true });
  writeFileSync(join(root, 'routes/hello.ts'), "export const GET = () => new Response('hello');");
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('bwfPlugin dev asset routing', () => {
  async function runEnvConfig(root: string): Promise<void> {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { bwfPlugin } = await import('../../src/index.ts');
    const plugins = bwfPlugin();
    const envPlugin = plugins.find((plugin) => plugin.name === 'platform:env');
    const config = getHookHandler(envPlugin?.config) as (
      config: import('vite').UserConfig,
      env: import('vite').ConfigEnv,
    ) => void;
    config({}, { command: 'build', mode: 'production' });
  }

  // Decision: The Cloudflare plugin gives each environment it runs in workerd these conditions.
  const workerd = { resolve: { conditions: ['workerd', 'worker', 'module', 'browser'] } };
  const node = { resolve: { conditions: ['module', 'node'] } };

  async function resolveRuntimeOptimizerConfig(
    root: string,
    environmentName: string,
    environment: import('vite').EnvironmentOptions = {},
  ): Promise<unknown> {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { bwfPlugin } = await import('../../src/index.ts');
    const plugin = bwfPlugin().find((entry) => entry.name === 'platform:server-runtime-optimizer');
    const configEnvironment = getHookHandler(plugin?.configEnvironment) as (
      name: string,
      environment: import('vite').EnvironmentOptions,
    ) => unknown;
    return configEnvironment(environmentName, environment);
  }

  it('runs the env config hook for framework and Node early-return plugin paths', async () => {
    await expect(runEnvConfig(createFrameworkProjectRoot())).resolves.toBeUndefined();
    vi.restoreAllMocks();
    await expect(runEnvConfig(createNodeProjectRoot())).resolves.toBeUndefined();
  });

  it('converts void CommonJS dependencies only in environments that run in workerd', async () => {
    const workerdOptimizer = {
      optimizeDeps: {
        exclude: ['@builtbyfriends/bwf', 'better-auth'],
        include: [
          '@builtbyfriends/bwf > email-validator',
          '@builtbyfriends/bwf > hono',
          '@builtbyfriends/bwf > hono/route',
        ],
      },
    };
    const nodeOptimizer = { optimizeDeps: { exclude: ['@builtbyfriends/bwf'] } };
    const cases = [
      [createApiOnlyProjectRoot, 'platform_worker', workerd, workerdOptimizer],
      // Decision: Default mode doesn't run Vite's own ssr environment.
      [createApiOnlyProjectRoot, 'ssr', node, nodeOptimizer],
      [createFrameworkProjectRoot, 'ssr', workerd, workerdOptimizer],
      // Decision: @astrojs/cloudflare runs Astro's ssr environment in workerd.
      [createAstroProjectRoot, 'ssr', workerd, workerdOptimizer],
      [createFrameworkOwnedRuntimeProjectRoot, 'ssr', node, nodeOptimizer],
      [createNodeProjectRoot, 'ssr', {}, nodeOptimizer],
    ] as const;
    for (const [createRoot, name, environment, expected] of cases) {
      vi.restoreAllMocks();
      await expect(
        resolveRuntimeOptimizerConfig(createRoot(), name, environment),
        `${createRoot.name} ${name}`,
      ).resolves.toEqual(expected);
    }
  });

  it('prebundles the bwf/db driver wherever workerd runs it', async () => {
    const cases = [
      [createApiOnlyProjectRoot, 'mysql', workerd, ['@builtbyfriends/bwf > mysql2']],
      [createApiOnlyProjectRoot, 'pg', workerd, ['@builtbyfriends/bwf > pg']],
      [createAstroProjectRoot, 'mysql', workerd, ['@builtbyfriends/bwf > mysql2']],
      [createAstroProjectRoot, 'pg', workerd, ['@builtbyfriends/bwf > pg']],
      [createFrameworkOwnedRuntimeProjectRoot, 'mysql', node, undefined],
      [createNodeProjectRoot, 'pg', {}, undefined],
    ] as const;
    for (const [createRoot, database, environment, drivers] of cases) {
      vi.restoreAllMocks();
      await expect(
        resolveRuntimeOptimizerConfig(useDatabase(createRoot(), database), 'ssr', environment),
        `${createRoot.name} ${database}`,
      ).resolves.toEqual({
        optimizeDeps: drivers
          ? {
              exclude: ['@builtbyfriends/bwf', 'better-auth'],
              include: [
                '@builtbyfriends/bwf > email-validator',
                '@builtbyfriends/bwf > hono',
                '@builtbyfriends/bwf > hono/route',
                ...drivers,
              ],
            }
          : { exclude: ['@builtbyfriends/bwf'] },
      });
    }
  });

  it('leaves client dependency optimization unchanged', async () => {
    await expect(
      resolveRuntimeOptimizerConfig(createPagesProjectRoot(), 'client'),
    ).resolves.toBeUndefined();
  });

  async function resolveCloudflareConfig(
    root: string,
    resolved: Record<string, unknown> = {},
    configEnv: import('vite').ConfigEnv = { command: 'serve', mode: 'development' },
    { envSchema = false }: { envSchema?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const { bwfPlugin } = await import('../../src/index.ts');
    const plugins = bwfPlugin();

    if (envSchema) {
      const schemaPlugin = plugins.find((plugin) => plugin.name === 'platform:env-schema');
      const schemaConfig = getHookHandler(schemaPlugin?.config) as (
        config: import('vite').UserConfig,
        env: import('vite').ConfigEnv,
      ) => Promise<void>;
      await schemaConfig({}, configEnv);
    }

    const envPlugin = plugins.find((plugin) => plugin.name === 'platform:env');
    const config = getHookHandler(envPlugin?.config) as (
      config: import('vite').UserConfig,
      env: import('vite').ConfigEnv,
    ) => void;
    config({}, configEnv);

    const cloudflarePlugin = plugins.find(
      (plugin): plugin is MockCloudflarePlugin => plugin.name === 'mock:cloudflare',
    );
    if (!cloudflarePlugin) {
      throw new Error('Expected mocked Cloudflare plugin.');
    }

    return cloudflarePlugin.api.pluginConfig.config(resolved);
  }

  async function resolveBwfPluginAssets(
    root: string,
    resolved: Record<string, unknown> = {},
    configEnv?: import('vite').ConfigEnv,
  ): Promise<{ not_found_handling?: string; run_worker_first?: Array<string> }> {
    const merged = await resolveCloudflareConfig(root, resolved, configEnv);
    return merged.assets as { not_found_handling?: string; run_worker_first?: Array<string> };
  }

  it.each([
    ['API-only projects', createApiOnlyProjectRoot, undefined],
    ['a dev-only API route in dev', createDevOnlyApiProjectRoot, undefined],
    [
      'a prod-only API route in a preview run',
      () => {
        const root = createProjectRoot();
        mkdirSync(join(root, 'routes/api'), { recursive: true });
        writeFileSync(
          join(root, 'routes/api/health.prod.ts'),
          'export const GET = () => Response.json({});',
        );
        return root;
      },
      { command: 'serve', mode: 'production', isPreview: true },
    ],
    ['API websocket-only projects', createApiWebSocketOnlyProjectRoot, undefined],
    ['auth-only projects', createAuthOnlyProjectRoot, undefined],
    [
      'an API-only project with an inactive middleware directory',
      () => {
        const root = createApiOnlyProjectRoot();
        mkdirSync(join(root, 'middleware'), { recursive: true });
        writeFileSync(join(root, 'middleware', '_ignored.ts'), 'export default () => undefined;');
        return root;
      },
      undefined,
    ],
  ] as const)(
    'routes API requests to the worker and keeps documents static-first for %s',
    async (_label, createRoot, configEnv) => {
      const assets = await resolveBwfPluginAssets(createRoot(), {}, configEnv);

      expect(assets?.not_found_handling).toBe('single-page-application');
      expect(assets?.run_worker_first).toEqual(['/api', '/api/*', '/__platform', '/__platform/*']);
    },
  );

  it('drops the API worker-first rules in a build when the only route is dev-only', async () => {
    const root = createDevOnlyApiProjectRoot();
    const assets = await resolveBwfPluginAssets(
      root,
      {},
      {
        command: 'build',
        mode: 'production',
      },
    );

    expect(assets?.not_found_handling).toBe('single-page-application');
    expect(assets?.run_worker_first).toEqual(['/__platform', '/__platform/*']);
  });

  it('runs configured edge rules before existing assets in native production builds', async () => {
    const root = createConfiguredEdgeRulesProjectRoot();
    const assets = await resolveBwfPluginAssets(root, {}, { command: 'build', mode: 'production' });

    expect(assets?.run_worker_first).toEqual(['/**']);
  });

  it.each([
    { name: 'sends every path to the Worker in native builds', managed: false, expected: ['/**'] },
    {
      name: 'keeps the inferred policy in managed builds',
      managed: true,
      expected: ['/api', '/api/*', '/__platform', '/__platform/*'],
    },
  ])('routing.alwaysUseHttps alone $name', async ({ managed, expected }) => {
    if (managed) {
      vi.stubEnv('PLATFORM_DEPLOY_PROJECT_ID', 'managed-project');
    }
    const root = createApiOnlyProjectRoot();
    writeFileSync(join(root, 'bwf.json'), JSON.stringify({ routing: { alwaysUseHttps: true } }));
    const assets = await resolveBwfPluginAssets(root, {}, { command: 'build', mode: 'production' });

    expect(assets?.run_worker_first).toEqual(expected);
    expect(assets?.not_found_handling).toBe('single-page-application');
  });

  it('runs merged public routing files before existing assets in native production builds', async () => {
    const root = createApiOnlyProjectRoot();
    mkdirSync(join(root, 'public'), { recursive: true });
    writeFileSync(join(root, 'public/_headers'), '/asset.txt\n  X-Edge: yes\n');
    writeFileSync(join(root, 'public/_redirects'), '/old.txt /new.txt 302\n');

    const assets = await resolveBwfPluginAssets(root, {}, { command: 'build', mode: 'production' });

    expect(assets?.run_worker_first).toEqual(['/**']);
  });

  it('preserves native fallback ordering ahead of the SPA shell', async () => {
    const root = createApiOnlyProjectRoot();
    writeFileSync(
      join(root, 'bwf.json'),
      JSON.stringify({
        worker: { compatibility_date: '2026-02-24' },
        routing: { fallbacks: { '/legacy/*': '/legacy.html' } },
      }),
    );

    const assets = await resolveBwfPluginAssets(root, {}, { command: 'build', mode: 'production' });

    expect(assets?.run_worker_first).toEqual(['/**']);
    expect(assets?.not_found_handling).toBe('none');
  });

  it('lets managed production dispatch keep the inferred asset-first policy', async () => {
    vi.stubEnv('PLATFORM_DEPLOY_PROJECT_ID', 'managed-project');
    const assets = await resolveBwfPluginAssets(
      createConfiguredEdgeRulesProjectRoot(),
      {},
      { command: 'build', mode: 'production' },
    );

    expect(assets?.run_worker_first).toEqual(['/api', '/api/*', '/__platform', '/__platform/*']);
  });

  it('ignores an ambient managed project marker during native development', async () => {
    vi.stubEnv('PLATFORM_DEPLOY_PROJECT_ID', 'managed-project');
    const assets = await resolveBwfPluginAssets(
      createConfiguredEdgeRulesProjectRoot(),
      {},
      { command: 'serve', mode: 'development' },
    );

    expect(assets?.run_worker_first).toContain('/**');
  });

  it('does not return existing D1 or R2 bindings when adding inferred defaults', async () => {
    const root = createBindingProjectRoot();
    const config = await resolveCloudflareConfig(root, {
      d1_databases: [{ binding: 'myapp_db', database_name: 'prod', database_id: 'real-id' }],
      r2_buckets: [{ binding: 'myapp_storage', bucket_name: 'prod' }],
    });

    expect(config.d1_databases).toEqual([
      { binding: 'DB', database_name: 'default', database_id: 'local' },
    ]);
    expect(config.r2_buckets).toEqual([{ binding: 'STORAGE', bucket_name: 'default' }]);
  });

  it('uses custom inference binding names for generated D1 and R2 bindings', async () => {
    const root = createCustomBindingProjectRoot();
    const config = await resolveCloudflareConfig(root);

    expect(config.d1_databases).toEqual([
      { binding: 'myapp_db', database_name: 'default', database_id: 'local' },
    ]);
    expect(config.kv_namespaces).toEqual([{ binding: 'myapp_kv', id: 'local' }]);
    expect(config.r2_buckets).toEqual([{ binding: 'myapp_storage', bucket_name: 'default' }]);
  });

  it('uses the owner Cloudflare account for Workers AI during direct local development', async () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cloudflare-token');
    vi.stubEnv('CLOUDFLARE_CF_AUTH', undefined);
    vi.stubEnv('CLOUDFLARE_AUTH_USE_KEYRING', 'false');
    vi.stubEnv('BWF_TOKEN', 'platform-token-that-must-not-be-used');
    const config = await resolveCloudflareConfig(createAiProjectRoot('cloudflare'));

    expect(config.ai).toEqual({ binding: 'AI', remote: true });
    expect(config.vars).not.toMatchObject({
      __PLATFORM_TOKEN: expect.anything(),
      __PLATFORM_PROJECT_ID: expect.anything(),
      __PLATFORM_PROXY_URL: expect.anything(),
    });
    expect(process.env.CLOUDFLARE_API_TOKEN).toBe('cloudflare-token');
    expect(process.env.CLOUDFLARE_CF_AUTH).toBe('true');
    expect(process.env.CLOUDFLARE_AUTH_USE_KEYRING).toBe('true');
  });

  it.each([
    ['preview', { command: 'serve', mode: 'production', isPreview: true }],
    ['build', { command: 'build', mode: 'production' }],
  ] as const)(
    'uses the bwf Cloudflare login when a direct %s opens a remote session',
    async (_label, configEnv) => {
      vi.stubEnv('CLOUDFLARE_CF_AUTH', undefined);
      vi.stubEnv('CLOUDFLARE_AUTH_USE_KEYRING', undefined);
      await resolveCloudflareConfig(createAiProjectRoot('cloudflare'), {}, configEnv);

      expect(process.env.CLOUDFLARE_CF_AUTH).toBe('true');
      expect(process.env.CLOUDFLARE_AUTH_USE_KEYRING).toBe('true');
    },
  );

  it('passes schema-declared shell values to the dev Worker without copying unrelated shell values', async () => {
    const root = createProjectRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
    writeFileSync(
      join(root, '.env'),
      'BWF_TEST_TOKEN=from-file\nBWF_TEST_FILE_ONLY=local\nBWF_TEST_UNDECLARED=from-file\n',
    );
    vi.stubEnv('BWF_TEST_TOKEN', 'from-shell');
    vi.stubEnv('BWF_TEST_SHELL_ONLY', 'shell-only');
    vi.stubEnv('BWF_TEST_UNDECLARED', 'from-shell');
    vi.stubEnv('BWF_TEST_UNRELATED', 'must-stay-out');

    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { string } = await import('../../src/runtime/env-helpers.ts');
    defineEnv({
      BWF_TEST_TOKEN: string(),
      BWF_TEST_FILE_ONLY: string(),
      BWF_TEST_SHELL_ONLY: string(),
    });

    const config = await resolveCloudflareConfig(root, {}, undefined, { envSchema: true });
    expect(config.vars).toMatchObject({
      BWF_TEST_TOKEN: 'from-shell',
      BWF_TEST_FILE_ONLY: 'local',
      BWF_TEST_SHELL_ONLY: 'shell-only',
      BWF_TEST_UNDECLARED: 'from-shell',
    });
    expect(config.vars).not.toHaveProperty('BWF_TEST_UNRELATED');
  });

  function createSvelteKitProjectRoot(): string {
    const root = createProjectRoot();
    mkdirSync(join(root, 'src/routes'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', dependencies: { '@sveltejs/kit': '2.0.0' } }),
    );
    return root;
  }

  it.each([
    ['native', createProjectRoot],
    ['Class A framework', createFrameworkProjectRoot],
    ['Class B/C framework', createSvelteKitProjectRoot],
    ['Node target', createNodeProjectRoot],
  ] as const)('stops a %s app on a reserved .env name', async (_label, createRoot) => {
    const root = createRoot();
    writeFileSync(join(root, '.env'), 'API_KEY=k\n__PLATFORM_PROXY_TOKEN=local\n');
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const { bwfPlugin } = await import('../../src/index.ts');
    const schemaPlugins = bwfPlugin().filter((plugin) => plugin.name === 'platform:env-schema');
    expect(schemaPlugins).toHaveLength(1);
    const schemaConfig = getHookHandler(schemaPlugins[0].config) as (
      config: import('vite').UserConfig,
      env: import('vite').ConfigEnv,
    ) => Promise<void>;
    await expect(schemaConfig({}, { command: 'serve', mode: 'development' })).rejects.toThrow(
      '.env defines names reserved for bwf: __PLATFORM_PROXY_TOKEN. bwf sets these itself',
    );
  });

  it('enables remote mode on an explicit Workers AI binding during direct development', async () => {
    vi.stubEnv('CLOUDFLARE_CF_AUTH', undefined);
    vi.stubEnv('CLOUDFLARE_AUTH_USE_KEYRING', 'false');
    const config = await resolveCloudflareConfig(createAiProjectRoot('cloudflare'), {
      ai: { binding: 'AI', staging: true },
    });

    expect(config.ai).toEqual({ binding: 'AI', remote: true, staging: true });
  });

  it('keeps managed Workers AI development on the bwf proxy', async () => {
    vi.stubEnv('CLOUDFLARE_CF_AUTH', undefined);
    vi.stubEnv('CLOUDFLARE_AUTH_USE_KEYRING', undefined);
    vi.stubEnv('BWF_TOKEN', 'managed-token');
    const root = createAiProjectRoot('platform');
    vi.stubEnv('BWF_API_URL', 'https://platform.example.test');
    vi.stubEnv('PLATFORM_REGISTRY_DIR', join(root, 'registry'));
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      displayName: 'Test',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.example.test',
    });
    writeFileSync(
      join(root, '.bwf/project.json'),
      JSON.stringify({
        platform: 'platform',
        projectId: 'managed-project',
        slug: 'managed-app',
        platformUrl: 'https://platform.example.test',
      }),
    );
    const config = await resolveCloudflareConfig(root);

    expect(config.ai).toBeUndefined();
    expect(config.vars).toMatchObject({
      __PLATFORM_TOKEN: 'managed-token',
      __PLATFORM_PROJECT_ID: 'managed-project',
      __PLATFORM_PROXY_URL: 'https://proxy.example.test',
    });
    expect(process.env.CLOUDFLARE_CF_AUTH).toBeUndefined();
    expect(process.env.CLOUDFLARE_AUTH_USE_KEYRING).toBeUndefined();
  });

  it('adds no remote AI to a direct non-AI app but keeps its remote bindings on the bwf login', async () => {
    vi.stubEnv('CLOUDFLARE_CF_AUTH', undefined);
    vi.stubEnv('CLOUDFLARE_AUTH_USE_KEYRING', 'false');
    const root = createApiOnlyProjectRoot();
    saveDeploymentPlatform(root, 'cloudflare');
    const config = await resolveCloudflareConfig(root);

    expect(config.ai).toBeUndefined();
    expect(process.env.CLOUDFLARE_CF_AUTH).toBe('true');
    expect(process.env.CLOUDFLARE_AUTH_USE_KEYRING).toBe('true');
  });

  it('passes worker.limits.cpu_ms from bwf.json into the generated worker config', async () => {
    const root = createProjectRoot();
    writeFileSync(
      join(root, 'bwf.json'),
      JSON.stringify({
        worker: { compatibility_date: '2026-02-24', limits: { cpu_ms: 120_000 } },
      }),
    );

    const config = await resolveCloudflareConfig(root);

    expect(config.limits).toEqual({ cpu_ms: 120_000 });
  });

  it('emits no limits key when worker.limits is not configured', async () => {
    const root = createProjectRoot();

    const config = await resolveCloudflareConfig(root);

    expect('limits' in config).toBe(false);
  });

  it('routes document routes through the worker before SPA fallback HTML', async () => {
    const root = createDocumentRouteProjectRoot();
    const assets = await resolveBwfPluginAssets(root);

    expect(assets?.not_found_handling).toBe('none');
    expect(assets?.run_worker_first).toEqual([
      '!/@vite/*',
      '!/@id/*',
      '!/@fs/*',
      '!/@react-refresh',
      '!/node_modules/*',
      '!/__uno.css',
      '/**',
    ]);
  });
});
