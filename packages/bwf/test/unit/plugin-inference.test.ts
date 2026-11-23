import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { LATEST_KNOWN_COMPAT_DATE } from '../../src/cli/wrangler.ts';
import { readConfig } from '../../src/config.ts';
import { bwfPlugin } from '../../src/index.ts';
import { inferProjectBindings } from '../../src/plugin-inference.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

const tempDirs: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-inference-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

function writeCompatConfig(root: string): void {
  writeFileSync(
    join(root, 'bwf.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' } }),
  );
}

describe('inferProjectBindings', () => {
  it('infers namespace auth use across the project without mistaking fetch aliases for auth', () => {
    const root = createTempRoot();
    const file = join(root, 'src/client.ts');
    writeFileSync(
      file,
      'import { type auth, fetch as authFetch } from "@builtbyfriends/bwf/client";',
    );
    expect(inferProjectBindings(root).needsAuth).toBe(false);
    writeFileSync(
      file,
      'import * as client from "@builtbyfriends/bwf/client"; client.auth.signOut();',
    );
    expect(inferProjectBindings(root).needsAuth).toBe(true);
  });

  it('retains resources used only through destructuring and bracket access', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src/handler.ts'),
      `
      export const handler = ({ env: { DB, KV } }) => [DB, KV];
      export const storage = (c) => c.env['STORAGE'];
    `,
    );
    expect(inferProjectBindings(root)).toMatchObject({
      needsD1: true,
      needsKV: true,
      needsR2: true,
    });
    expect(inferProjectBindings(root, { bindings: { db: false, kv: false } })).toMatchObject({
      needsD1: false,
      needsKV: false,
      needsR2: true,
    });
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['ts', 'tsx', 'jsx'])(
    'filters route-only bindings in .%s for the selected environment',
    (ext) => {
      const root = createTempRoot();
      mkdirSync(join(root, 'routes', 'api'), { recursive: true });
      writeFileSync(
        join(root, 'routes', 'api', `debug.dev.${ext}`),
        `
      import { storage } from "@builtbyfriends/bwf/storage";
      export const GET = async () => Response.json(await storage.list());
      `,
      );
      writeFileSync(
        join(root, 'routes', 'api', `events.dev.ws.${ext}`),
        "import { defineLiveStream } from '@builtbyfriends/bwf/live';",
      );

      expect(inferProjectBindings(root, undefined, ['routes']).needsR2).toBe(true);
      expect(inferProjectBindings(root, { environment: 'dev' }, ['routes']).needsR2).toBe(true);
      expect(inferProjectBindings(root, { environment: 'dev' }, ['routes']).needsLive).toBe(true);
      const production = inferProjectBindings(root, { environment: 'prod' }, ['routes']);
      expect(production.needsR2).toBe(false);
      expect(production.needsLive).toBe(false);
    },
  );

  it.each(['', 'src', 'app'])('infers .well-known bindings under sourceDir=%s', (sourceDir) => {
    const root = createTempRoot();
    if (sourceDir) {
      writeFileSync(join(root, 'bwf.json'), JSON.stringify({ sourceDir }));
    }
    const routesDir = join(root, sourceDir, 'routes', '.well-known');
    mkdirSync(join(routesDir, '_helpers'), { recursive: true });
    writeFileSync(
      join(routesDir, 'status.dev.tsx'),
      "import { kv } from '@builtbyfriends/bwf/kv'; export const GET = () => <p>{kv.get('status')}</p>;",
    );
    writeFileSync(
      join(routesDir, 'status.prod.jsx'),
      "import { storage } from '@builtbyfriends/bwf/storage'; export const GET = () => <p>{storage.list()}</p>;",
    );
    writeFileSync(
      join(routesDir, 'events.dev.ws.jsx'),
      "import { db } from '@builtbyfriends/bwf/db'; export default defineWebSocket({ onMessage: () => <p>{db.select()}</p> });",
    );
    writeFileSync(
      join(routesDir, '_helpers', 'stream.prod.tsx'),
      "import { defineLiveStream } from '@builtbyfriends/bwf/live'; export const Stream = () => <p>Stream</p>;",
    );

    expect(inferProjectBindings(root, { environment: 'dev' })).toMatchObject({
      needsKV: true,
      needsR2: false,
      needsD1: true,
      needsLive: true,
    });
    expect(inferProjectBindings(root, { environment: 'prod' })).toMatchObject({
      needsKV: false,
      needsR2: true,
      needsD1: false,
      needsLive: true,
    });
    expect(inferProjectBindings(root)).toMatchObject({
      needsKV: true,
      needsR2: true,
      needsD1: true,
      needsLive: true,
    });
  });

  it('infers .well-known bindings in the configured source fallback with custom scan directories', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'bwf.json'), JSON.stringify({ sourceDir: 'app' }));
    mkdirSync(join(root, 'app/routes/.well-known'), { recursive: true });
    writeFileSync(
      join(root, 'app/routes/.well-known/status.prod.jsx'),
      "import { kv } from '@builtbyfriends/bwf/kv'; export const GET = () => <p>Status</p>;",
    );

    expect(inferProjectBindings(root, { environment: 'prod' }, ['server']).needsKV).toBe(true);
    expect(inferProjectBindings(root, { environment: 'dev' }, ['server']).needsKV).toBe(false);
  });

  it.each(['tsx', 'jsx'])('keeps bindings from underscored route helpers in .%s', (ext) => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes/_components'), { recursive: true });
    mkdirSync(join(root, 'routes/components'), { recursive: true });
    writeFileSync(
      join(root, `routes/_components/Toolbar.prod.${ext}`),
      "import { kv } from '@builtbyfriends/bwf/kv'; export const Toolbar = () => <p>Toolbar</p>;",
    );
    writeFileSync(
      join(root, `routes/components/_Toolbar.dev.${ext}`),
      "import { storage } from '@builtbyfriends/bwf/storage'; export const Toolbar = () => <p>Toolbar</p>;",
    );
    writeFileSync(
      join(root, `routes/_helper.prod.ws.${ext}`),
      "import { db } from '@builtbyfriends/bwf/db'; export const helper = () => <p>Helper</p>;",
    );

    for (const environment of ['dev', 'prod'] as const) {
      expect(inferProjectBindings(root, { environment })).toMatchObject({
        needsKV: true,
        needsR2: true,
        needsD1: true,
      });
    }
  });

  it('keeps bindings from non-route files with environment-like suffixes', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes'), { recursive: true });
    mkdirSync(join(root, 'queues'), { recursive: true });
    writeFileSync(
      join(root, 'queues', 'sync.dev.ts'),
      "import { storage } from '@builtbyfriends/bwf/storage';",
    );
    writeFileSync(
      join(root, 'src', 'helper.dev.ts'),
      "import { kv } from '@builtbyfriends/bwf/kv';",
    );

    const result = inferProjectBindings(root, { environment: 'prod' });
    expect(result.needsR2).toBe(true);
    expect(result.needsKV).toBe(true);
  });

  it('detects auth from bwf/client import with auth specifier in src/', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'App.tsx'),
      `
      import { auth } from "@builtbyfriends/bwf/client";
      export default function App() {
        auth.signIn;
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(true);
  });

  it('detects live from the documented src/live.ts module', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'live.ts'),
      `
      import { defineLiveStream } from "@builtbyfriends/bwf/live";
      export const live = defineLiveStream({ id: "app" });
      `,
    );
    writeFileSync(
      join(root, 'routes', 'live.ts'),
      `
      import { defineHandler } from "@builtbyfriends/bwf";
      import { live } from "../src/live";
      export const GET = defineHandler((c) => live.connect(c));
      export const POST = defineHandler((c) => live.control(c));
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsLive).toBe(true);
  });

  it('infers resources used only by Durable Object modules', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'durable-objects'), { recursive: true });
    writeFileSync(
      join(root, 'durable-objects', 'agent.ts'),
      `
      import { createAi } from '@builtbyfriends/bwf/ai';
      import { createStorage } from '@builtbyfriends/bwf/storage';
      export function resources(env) { return [createAi(env), createStorage(env.STORAGE)]; }
    `,
    );
    expect(inferProjectBindings(root)).toMatchObject({
      needsAI: true,
      needsR2: true,
      needsSandbox: false,
    });
    expect(inferProjectBindings(root, undefined, ['durable-objects'])).toMatchObject({
      needsAI: true,
      needsR2: true,
    });
  });

  it('detects live from a stream module outside the default directories only when scanned', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes'), { recursive: true });
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(
      join(root, 'lib', 'live.ts'),
      `
      import { defineLiveStream } from "@builtbyfriends/bwf/live";
      export const live = defineLiveStream({ id: "app" });
      `,
    );
    writeFileSync(
      join(root, 'routes', 'live.ts'),
      `
      import { defineHandler } from "@builtbyfriends/bwf";
      import { live } from "../lib/live";
      export const GET = defineHandler((c) => live.connect(c));
      `,
    );

    expect(inferProjectBindings(root).needsLive).toBe(false);
    expect(inferProjectBindings(root, undefined, ['routes', 'lib']).needsLive).toBe(true);
  });

  it('detects auth from bwf/auth import in routes/', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes', 'api'), { recursive: true });
    writeFileSync(
      join(root, 'routes', 'api', 'profile.ts'),
      `
      import { requireAuth } from "@builtbyfriends/bwf/auth";
      export const GET = (c) => {
        const user = requireAuth(c);
        return { user };
      };
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(true);
  });

  it('does not detect auth from bwf/client with only fetch', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'App.tsx'),
      `
      import { fetch } from "@builtbyfriends/bwf/client";
      export default function App() {
        fetch("/api/hello");
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(false);
  });

  it('keeps unrelated hidden directories out of .well-known inference', () => {
    const root = createTempRoot();
    for (const directory of [
      'routes/.cache',
      'routes/.well-known/.cache',
      'routes/nested/.well-known',
    ]) {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(
        join(root, directory, 'hidden.tsx'),
        "import { storage } from '@builtbyfriends/bwf/storage';",
      );
    }
    writeFileSync(
      join(root, 'routes/.well-known/status.tsx'),
      "import { kv } from '@builtbyfriends/bwf/kv'; export const GET = () => <p>Status</p>;",
    );

    expect(inferProjectBindings(root)).toMatchObject({ needsKV: true, needsR2: false });
  });

  it('detects auth from the React bwf/client subpath in src/', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'App.tsx'),
      `
      import { auth } from "@builtbyfriends/bwf/client/react";
      export default function App() {
        auth.useSession();
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(true);
  });

  it('externalizes Cloudflare builtins for default worker builds', () => {
    const root = createTempRoot();
    writeCompatConfig(root);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = bwfPlugin();
      const externalPlugin = plugins.find(
        (plugin) => plugin.name === 'platform:cloudflare-builtins-external',
      );
      const config = getHookHandler(externalPlugin?.config) as (
        this: object,
        config: import('vite').UserConfig,
        env: import('vite').ConfigEnv,
      ) => import('vite').UserConfig | void;

      expect(externalPlugin).toBeTruthy();
      const result = config.call({} as never, {}, { command: 'build', mode: 'production' });
      const rootExternal = result?.build?.rollupOptions?.external as Array<unknown>;
      expect(rootExternal).toBeTruthy();
      expect(
        rootExternal.some((value) => value instanceof RegExp && value.test('cloudflare:workers')),
      ).toBe(true);
      expect(result?.environments).toBeUndefined();
    } finally {
      cwd.mockRestore();
    }
  });
});

describe('detectFramework', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not create bwf.json during plugin construction', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      bwfPlugin();
      expect(existsSync(join(root, 'bwf.json'))).toBe(false);
      expect(existsSync(join(root, 'bwf.config.ts'))).toBe(false);
    } finally {
      cwd.mockRestore();
    }
  });

  it('persists default compatibility in bwf.config.ts during build startup', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = bwfPlugin();
      const persistPlugin = plugins.find(
        (plugin) => plugin.name === 'platform:wrangler-compat-persist',
      );
      const buildStart = getHookHandler(persistPlugin?.buildStart) as (this: object) => void;

      expect(persistPlugin).toBeTruthy();
      buildStart.call({});
      expect(existsSync(join(root, 'bwf.json'))).toBe(false);
      expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
      expect(readConfig(root)).toEqual({
        worker: { compatibility_date: LATEST_KNOWN_COMPAT_DATE },
      });
    } finally {
      cwd.mockRestore();
    }
  });

  it('fails client builds that import server-only state runtimes', () => {
    const root = createTempRoot();
    writeCompatConfig(root);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = bwfPlugin();
      const stubsPlugin = plugins.find((plugin) => plugin.name === 'platform:client-stubs');
      const resolveId = getHookHandler(stubsPlugin?.resolveId) as (
        this: { environment?: { name?: string }; error(message: string): never },
        id: string,
      ) => string | undefined;

      expect(stubsPlugin).toBeTruthy();
      expect(() =>
        resolveId.call(
          {
            environment: { name: 'client' },
            error(message: string): never {
              throw new Error(message);
            },
          },
          '@builtbyfriends/bwf/live',
        ),
      ).toThrow('@builtbyfriends/bwf/live is server-only');
      expect(() =>
        resolveId.call(
          {
            environment: { name: 'client' },
            error(message: string): never {
              throw new Error(message);
            },
          },
          '@builtbyfriends/bwf/durable',
        ),
      ).toThrow('@builtbyfriends/bwf/durable is server-only');
    } finally {
      cwd.mockRestore();
    }
  });

  it('wires bwf/live for explicit Cloudflare targets', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes'), { recursive: true });
    writeFileSync(join(root, 'bwf.json'), JSON.stringify({ target: 'cloudflare' }));
    writeFileSync(
      join(root, 'src', 'live.ts'),
      `
      import { defineLiveStream } from "@builtbyfriends/bwf/live";
      export const live = defineLiveStream({ id: "app" });
      `,
    );
    writeFileSync(
      join(root, 'routes', 'live.ts'),
      `
      import { defineHandler } from "@builtbyfriends/bwf";
      import { live } from "../src/live";
      export const GET = defineHandler((c) => live.connect(c));
      export const POST = defineHandler((c) => live.control(c));
      `,
    );

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      bwfPlugin();
      const entry = readFileSync(join(root, '.bwf', 'entry.ts'), 'utf8');
      expect(entry).toContain('PlatformLiveStreamDurableObject');
      expect(entry).toContain('export { PlatformLiveStreamDurableObject };');
      expect(entry).toContain('__setLiveBindingName("BWF_LIVE");');
    } finally {
      cwd.mockRestore();
    }
  });

  it('exports convention-based typed Durable Objects from the worker entry', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes'), { recursive: true });
    mkdirSync(join(root, 'durable-objects'), { recursive: true });
    writeFileSync(join(root, 'routes', 'index.ts'), 'export const GET = () => new Response("ok");');
    writeFileSync(
      join(root, 'durable-objects', 'shopping-cart.ts'),
      'export default { class: class ShoppingCart {}, __bind() {} }',
    );
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      bwfPlugin();
      const entry = readFileSync(join(root, '.bwf', 'entry.ts'), 'utf8');
      expect(entry).toContain('import __platformDurableObject0 from');
      expect(entry).toContain('/durable-objects/shopping-cart.ts');
      expect(entry).toContain('__platformDurableObject0.__bind("SHOPPING_CART")');
      expect(entry).toContain('const ShoppingCartDurableObject = __platformDurableObject0.class');
    } finally {
      cwd.mockRestore();
    }
  });
});
