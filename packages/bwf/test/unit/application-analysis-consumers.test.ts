import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ResolvedConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { computeDesiredCloudflareResources } from '../../src/cli/deploy-resources.ts';
import { buildBwfManifest } from '../../src/cli/package.ts';
import { readConfig } from '../../src/config.ts';
import type { BwfConfig } from '../../src/config.ts';

type CloudflarePluginConfig = {
  config: (resolved: Record<string, unknown>) => Record<string, unknown>;
};

vi.mock('../../src/plugin-cloudflare.ts', () => import('../helpers/cloudflare-vite-plugin.ts'));

const roots: Array<string> = [];

function project(config: BwfConfig, files: Record<string, string>, framework = false): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-analysis-consumers-'));
  roots.push(root);
  const allFiles = {
    'package.json': JSON.stringify({
      name: 'analysis-app',
      type: 'module',
      ...(framework && { devDependencies: { '@sveltejs/kit': '2.70.3' } }),
    }),
    'bwf.json': JSON.stringify(config),
    ...files,
  };
  for (const [path, code] of Object.entries(allFiles)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, code);
  }
  return root;
}

async function pluginConfig(root: string): Promise<Record<string, unknown>> {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const { bwfPlugin } = await import('../../src/index.ts');
  const plugins = bwfPlugin();
  const cloudflarePlugin = plugins.find((plugin) => plugin.name === 'mock:cloudflare');
  if (cloudflarePlugin) {
    const config = (cloudflarePlugin.api as { pluginConfig: CloudflarePluginConfig }).pluginConfig
      .config;
    return config({});
  }
  const hook = plugins.find((plugin) => plugin.name === 'platform:wrangler-sync')?.configResolved;
  const handler = typeof hook === 'function' ? hook : hook?.handler;
  if (!handler) {
    throw new Error('Expected the Cloudflare config or framework Wrangler sync plugin.');
  }
  handler.call({} as never, { command: 'serve' } as ResolvedConfig);
  return JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('application analysis consumer parity', () => {
  it.each([undefined, false, true])(
    'carries D1 replication opt-in to native resources: %s',
    async (readReplication) => {
      const root = project(
        { database: { readReplication }, inference: { bindings: { db: 'APP_DB' } } },
        {},
      );
      const result = await computeDesiredCloudflareResources(
        root,
        readConfig(root),
        join(root, 'wrangler.jsonc'),
      );
      expect(result.desired.d1?.binding).toBe('APP_DB');
      expect(result.desired.d1?.readReplication).toBe(readReplication);
    },
  );
  it.each(['CACHE', false] as const)(
    'retains storage, auth and live with a partial KV override of %s',
    async (kv) => {
      const root = project(
        { inference: { bindings: { kv } } },
        {
          'routes/api/data.ts': `import { storage } from '@builtbyfriends/bwf/storage';
import { kv } from '@builtbyfriends/bwf/kv';
import { requireAuth } from '@builtbyfriends/bwf/auth';
export const GET = (c) => ({ storage, kv, user: requireAuth(c) });`,
          'src/live.ts': `import { defineLiveStream } from '@builtbyfriends/bwf/live';
export const live = defineLiveStream({ id: 'app' });`,
        },
      );
      const config = readConfig(root);
      const resources = await computeDesiredCloudflareResources(
        root,
        config,
        join(root, 'wrangler.jsonc'),
      );
      const application = resources.analysis;
      const manifest = buildBwfManifest({
        bindings: application.bindings,
        options: { bindingNames: application.bindingNames },
      });
      const emitted = await pluginConfig(root);

      expect(resources.authEnabled).toBe(true);
      expect(resources.needsLive).toBe(true);
      expect(resources.desired.d1?.binding).toBe('DB');
      expect(resources.desired.r2?.binding).toBe('STORAGE');
      expect(resources.desired.kvNamespaces.map((entry) => entry.binding)).toEqual(
        kv ? ['CACHE'] : [],
      );
      expect(manifest.auth).toBe(true);
      expect(manifest.bindings.d1).toEqual(['DB']);
      expect(manifest.bindings.r2).toEqual(['STORAGE']);
      expect(manifest.bindings.kv).toEqual(kv ? ['CACHE'] : undefined);
      expect(manifest.live?.className).toBe('PlatformLiveStreamDurableObject');
      expect(emitted.d1_databases).toEqual([
        { binding: 'DB', database_name: 'default', database_id: 'local' },
      ]);
      expect(emitted.r2_buckets).toEqual([{ binding: 'STORAGE', bucket_name: 'default' }]);
      expect(emitted.kv_namespaces).toEqual(kv ? [{ binding: 'CACHE', id: 'local' }] : undefined);
      expect(emitted.durable_objects).toEqual({
        bindings: [
          expect.objectContaining({
            name: expect.stringMatching(/^BWF_LIVE/),
            class_name: expect.stringMatching(/^PlatformLiveStreamDurableObject/),
          }),
        ],
      });
    },
  );

  it.each([
    { database: 'sqlite', framework: false },
    { database: 'pg', framework: false },
    { database: 'sqlite', framework: true },
    { database: 'pg', framework: true },
  ] as const)(
    'plans and emits a migration-only $database database (framework: $framework)',
    async ({ database, framework }) => {
      const root = project(
        {
          ...(database === 'pg' && { database }),
          sourceDir: 'app',
          inference: { bindings: { kv: false } },
        },
        {
          [framework ? 'src/routes/+page.server.ts' : 'app/routes/api/health.ts']:
            'export const GET = () => new Response("ok");',
          'app/db/migrations/0001_users.sql': 'CREATE TABLE users (id INTEGER PRIMARY KEY);',
        },
        framework,
      );
      const resources = await computeDesiredCloudflareResources(
        root,
        readConfig(root),
        join(root, 'wrangler.jsonc'),
      );
      const emitted = await pluginConfig(root);

      expect(resources.analysis.bindings.needsD1).toBe(false);
      expect(resources.analysis.authEnabled).toBe(false);
      expect(resources.desired.kvNamespaces).toEqual([]);
      expect(resources.migrations).toHaveLength(1);
      if (database === 'sqlite') {
        expect(resources.desired.d1).toEqual({
          binding: 'DB',
          name: 'analysis-app-db',
          migrationsDir: './app/db/migrations',
        });
        expect(resources.desired.hyperdrive).toBeUndefined();
        expect(emitted.d1_databases).toEqual([
          { binding: 'DB', database_name: 'default', database_id: 'local' },
        ]);
      } else {
        expect(resources.desired.d1).toBeUndefined();
        expect(resources.desired.hyperdrive).toEqual(
          expect.objectContaining({ binding: 'HYPERDRIVE', name: 'analysis-app-hyperdrive' }),
        );
        expect(emitted.d1_databases).toBeUndefined();
      }
    },
  );
});
