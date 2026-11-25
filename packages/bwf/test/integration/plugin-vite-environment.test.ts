import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkerBundleDir } from '@cloudflare/build-output-utils';
import { createServer, normalizePath, resolveConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { bwfPlugin } from '../../src/index.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

const roots: Array<string> = [];

function createProjectRoot(prefix = 'platform-vite-env-'): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      dependencies: {},
    }),
  );
  writeFileSync(
    join(root, 'bwf.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' } }),
  );
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('bwfPlugin Vite environments', () => {
  it('does not create bwf.json during Vite config resolution', async () => {
    const root = createProjectRoot();
    rmSync(join(root, 'bwf.json'), { force: true });
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await resolveConfig(
      {
        root,
        plugins: [bwfPlugin()],
      },
      'serve',
      'development',
    );

    expect(existsSync(join(root, 'bwf.json'))).toBe(false);
  });

  it('does not claim Vite SSR environments configured by test runners', async () => {
    const root = createProjectRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await expect(
      resolveConfig(
        {
          root,
          plugins: [bwfPlugin()],
          environments: {
            ssr: {
              resolve: {
                external: ['node:fs'],
              },
            },
          },
        },
        'serve',
        'test',
      ),
    ).resolves.toMatchObject({
      environments: {
        platform_worker: {
          build: {
            outDir: getWorkerBundleDir(realpathSync.native(root)),
          },
        },
      },
    });
  });

  it('clears resolve.external from the worker environment configured by test runners', async () => {
    const root = createProjectRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const config = await resolveConfig(
      {
        root,
        plugins: [bwfPlugin()],
        environments: {
          platform_worker: {
            resolve: {
              external: ['node:fs'],
              conditions: ['workerd'],
            },
            build: {
              emptyOutDir: false,
            },
          },
        },
      },
      'serve',
      'test',
    );

    expect(config.environments.platform_worker.resolve.external).toEqual([]);
    expect(config.environments.platform_worker.resolve.conditions).toContain('workerd');
    expect(config.environments.platform_worker.build).toMatchObject({
      emptyOutDir: false,
      outDir: getWorkerBundleDir(realpathSync.native(root)),
    });
  });

  it('scans native route and Durable Object dependencies before starting the Worker', async () => {
    vi.stubEnv('BWF_INSPECTOR_PORT', 'false');
    const root = createProjectRoot('platform-vite env (test)-');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    rmSync(join(root, 'bwf.json'));
    writeFileSync(join(root, 'bwf.config.ts'), "export default { sourceDir: 'src' };");
    mkdirSync(join(root, 'src/routes'), { recursive: true });
    mkdirSync(join(root, 'durable-objects'));
    for (const dependency of ['route-dependency', 'durable-dependency', 'production-dependency']) {
      const pkg = join(root, 'node_modules', dependency);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, 'package.json'),
        JSON.stringify({ name: dependency, main: 'index.js' }),
      );
      writeFileSync(join(pkg, 'index.js'), 'module.exports = 42;');
    }
    writeFileSync(
      join(root, 'src/routes/[id].ts'),
      "import value from 'route-dependency'; export const GET = () => Response.json(value);",
    );
    writeFileSync(
      join(root, 'src/routes/only.prod.ts'),
      "import value from 'production-dependency'; export const GET = () => Response.json(value);",
    );
    const durableRuntime = join(import.meta.dirname, '../../src/runtime/durable.ts');
    writeFileSync(
      join(root, 'durable-objects/counter.ts'),
      `import { defineDurableState } from ${JSON.stringify(normalizePath(durableRuntime))};
import count from 'durable-dependency';
export default defineDurableState({ initialState: { count }, methods: { get(c) { return c.state.count; } } });`,
    );

    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [bwfPlugin()],
      server: { middlewareMode: true, ws: false, watch: null, preTransformRequests: false },
    });
    try {
      const optimizer = server.environments.platform_worker.depsOptimizer;
      expect(optimizer).toBeDefined();
      await optimizer?.scanProcessing;
      const scanned = {
        ...optimizer?.metadata.optimized,
        ...optimizer?.metadata.discovered,
      };
      expect(Object.keys(scanned)).toEqual(
        expect.arrayContaining(['route-dependency', 'durable-dependency']),
      );
      expect(scanned).not.toHaveProperty('production-dependency');
    } finally {
      await server.close();
    }
  });

  it('adds native routes, procedures and auth to the Worker optimizer', async () => {
    const root = createProjectRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    mkdirSync(join(root, 'routes'));
    mkdirSync(join(root, 'procedures'));
    writeFileSync(join(root, 'routes/api.ts'), 'export const GET = () => new Response();');
    writeFileSync(join(root, 'routes/only.prod.ts'), 'export const GET = () => new Response();');
    writeFileSync(join(root, 'procedures/notes.ts'), 'export const list = () => [];');
    writeFileSync(
      join(root, 'auth.ts'),
      "import { defineAuth } from '@builtbyfriends/bwf/auth'; export default defineAuth({});",
    );
    const config = await resolveConfig(
      { root, configFile: false, plugins: [bwfPlugin()] },
      'serve',
      'development',
    );

    expect(config.environments.platform_worker.optimizeDeps.entries).toEqual(
      expect.arrayContaining([
        normalizePath(join(root, '.bwf/entry.ts')),
        normalizePath(join(root, 'routes/api.ts')),
        normalizePath(join(root, 'procedures/notes.ts')),
        normalizePath(join(root, 'auth.ts')),
      ]),
    );
    expect(config.environments.platform_worker.optimizeDeps.entries).not.toContain(
      normalizePath(join(root, 'routes/only.prod.ts')),
    );
  });

  it('preserves an explicitly configured scalar Worker optimizer entry', async () => {
    const root = createProjectRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    mkdirSync(join(root, 'routes'));
    writeFileSync(join(root, 'routes/api.ts'), 'export const GET = () => new Response();');
    const config = await resolveConfig(
      {
        root,
        configFile: false,
        plugins: [bwfPlugin()],
        environments: { platform_worker: { optimizeDeps: { entries: 'custom.ts' } } },
      },
      'serve',
      'development',
    );

    expect(config.environments.platform_worker.optimizeDeps.entries).toContain('custom.ts');
    expect(config.environments.platform_worker.optimizeDeps.entries).not.toContain(
      normalizePath(join(root, 'routes/api.ts')),
    );
  });

  it('prebundles void CommonJS dependencies only in the worker environment', async () => {
    const root = createProjectRoot();
    writeFileSync(
      join(root, 'bwf.json'),
      JSON.stringify({ database: 'pg', worker: { compatibility_date: '2026-02-24' } }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const config = await resolveConfig({ root, plugins: [bwfPlugin()] }, 'serve', 'development');

    expect(config.environments.platform_worker.optimizeDeps.include).toEqual(
      expect.arrayContaining(['@builtbyfriends/bwf > email-validator', '@builtbyfriends/bwf > pg']),
    );
    expect(config.environments.platform_worker.optimizeDeps.exclude).toEqual(
      expect.arrayContaining(['@builtbyfriends/bwf', 'better-auth']),
    );
    expect(config.environments.ssr.optimizeDeps.include).toEqual([]);
    expect(config.environments.ssr.optimizeDeps.exclude ?? []).not.toContain('better-auth');
  });

  it('loads a table file outside db/ that imports sql from bwf/db after a route loads bwf/db', async () => {
    // Decision: db/schema.ts re-exports a table file outside db/, which imports bwf/db while
    // bwf/db is still loading db/schema.ts.
    const root = realpathSync.native(createProjectRoot());
    mkdirSync(join(root, 'db'));
    writeFileSync(
      join(root, 'db/schema.ts'),
      'export * from "../src/resources/projects/projects.schema";\n',
    );
    mkdirSync(join(root, 'src/resources/projects'), { recursive: true });
    // Decision: A top-level sql`` call, as in a column default, is enough to need the helper.
    writeFileSync(
      join(root, 'src/resources/projects/projects.schema.ts'),
      "import { sql } from '@builtbyfriends/bwf/db';\nexport const projects = sql`(datetime('now'))`;\n",
    );
    mkdirSync(join(root, 'routes/api'), { recursive: true });
    writeFileSync(
      join(root, 'routes/api/projects.ts'),
      [
        "import { db } from '@builtbyfriends/bwf/db';",
        "import { projects } from '@schema';",
        'export const GET = () => Response.json({ db: typeof db, projects: typeof projects });',
        '',
      ].join('\n'),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [bwfPlugin()],
      optimizeDeps: { noDiscovery: true },
      // Decision: No watcher: macOS can report the files just written as changed, which
      // reloads bwf/db while the route is still loading it.
      server: { middlewareMode: true, ws: false, watch: null, preTransformRequests: false },
    });
    try {
      const route = await server.ssrLoadModule('/routes/api/projects.ts');
      const response = (route.GET as () => Response)();

      await expect(response.json()).resolves.toEqual({ db: 'object', projects: 'object' });
    } finally {
      await server.close();
    }
  }, 30_000);

  it('passes database.casing to the bwf/db client of a bwf app', async () => {
    const root = createProjectRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(root, 'bwf.json'),
      JSON.stringify({
        database: { dialect: 'pg', casing: 'snake_case' },
        worker: { compatibility_date: '2026-02-24' },
      }),
    );
    mkdirSync(join(root, 'db'));
    writeFileSync(join(root, 'db/schema.ts'), 'export {};\n');
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const config = await resolveConfig({ root, plugins: [bwfPlugin()] }, 'serve', 'development');
    const plugin = config.plugins.find((candidate) => candidate.name === 'platform:drizzle');
    const load = getHookHandler(plugin?.load) as (this: object, id: string) => string;

    expect(load.call({}, '\0virtual:platform-db')).toContain(
      'drizzle(connectionString, { schema, casing: "snake_case" })',
    );
  });
});

describe('deploy-build preview', () => {
  it('preserves the fresh deploy pointer when vite previews inside a deploy build', () => {
    const root = createProjectRoot();
    rmSync(join(root, 'bwf.json'));
    writeFileSync(join(root, 'bwf.config.ts'), 'export default {};\n');
    const stash = '{"configPath":"../../old-build/wrangler.json"}';
    const fresh = '{"configPath":"../../dist/server/wrangler.json"}';
    mkdirSync(join(root, '.bwf'), { recursive: true });
    writeFileSync(join(root, '.bwf/preview-deploy-config.json'), stash);
    const pointer = join(root, '.wrangler/deploy/config.json');
    mkdirSync(join(root, '.wrangler/deploy'), { recursive: true });
    writeFileSync(pointer, fresh);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.stubEnv('BWF_CLOUDFLARE_DEPLOY_BUILD', '1');
    const once = vi.spyOn(process, 'once').mockReturnValue(process);
    const argv = process.argv;
    process.argv = [argv[0], 'vite', 'build'];
    try {
      const guard = bwfPlugin().find(
        (plugin) => plugin.name === 'platform:remove-implicit-cloudflare-deploy-pointer',
      )!;
      const configure = getHookHandler(guard.config) as (
        config: object,
        env: { command: string; mode: string; isPreview: boolean },
      ) => void;
      configure({}, { command: 'serve', mode: 'production', isPreview: true });
      for (const [event, listener] of once.mock.calls) {
        if (event === 'exit') {
          (listener as () => void)();
        }
      }
      expect(existsSync(pointer)).toBe(true);
      expect(readFileSync(pointer, 'utf8')).toBe(fresh);
      expect(readFileSync(join(root, '.bwf/preview-deploy-config.json'), 'utf8')).toBe(stash);
    } finally {
      process.argv = argv;
    }
  });
});
