import { compilePattern as sharedCompilePattern, matchPatternCaptures } from '@builtbyfriends/edge';
import { Hono } from 'hono';
import { parseSync } from 'vite';
import { describe, expect, it } from 'vite-plus/test';
import { compileRouteTable, compileWorkerEntry } from '../../src/router/compile.ts';
import type { CompileOptions } from '../../src/router/compile.ts';
import type { ScanResult } from '../../src/router/scan.ts';
import { BwfAssetRewriteError } from '../../src/runtime/handler.ts';
import {
  createRoutingRuntime,
  createHttpRouteHandler,
  createModuleLoader,
  createAssetFallback,
  createAssetNotFound,
} from '../../src/runtime/routing.ts';
import type { RoutingRuntime } from '../../src/runtime/routing.ts';

const testOptions = {
  runtimeEnvPath: '/resolved/platform/runtime/env.mjs',
  projectRoot: '/project',
  homeDir: '/Users/test',
  webSocketRuntimePath: '/resolved/platform/runtime/ws-server.mjs',
  auth: null,
};

const emptyScan: ScanResult = {
  routes: [],
  middleware: [],
  jobs: [],
  queues: [],
};

function compile(options: Partial<CompileOptions> = {}, scan: ScanResult = emptyScan): string {
  return compileRouteTable(scan, '/routes', '/middleware', '/crons', '/queues', {
    ...testOptions,
    ...options,
  });
}

describe('compileRouteTable', () => {
  it('matches every expression of a multi-cron job', () => {
    const code = compile(
      {},
      {
        ...emptyScan,
        jobs: [{ filePath: 'multi.ts', name: 'multi', crons: ['0 * * * *', '30 * * * *'] }],
      },
    );

    expect(code).toContain('const job0Crons = ["0 * * * *","30 * * * *"]');
    expect(code).toContain('job0Crons.includes(controller.cron)');
    expect(code).toContain('import("/crons/multi.ts")');
  });

  it('handles empty scan result', () => {
    const code = compile();

    expect(code).toContain('const app = new Hono()');
    expect(code).toContain('export async function scheduled() {}');
    expect(code).toContain('export default app');
  });

  it('omits /__platform/queue route when no queues defined', () => {
    expect(compile()).not.toContain('/__platform/queue');
  });

  it('exports __PLATFORM_BUILD_KEY as a unique UUID for build-time auth', () => {
    const scan: ScanResult = {
      ...emptyScan,
      jobs: [{ filePath: 'sync.ts', name: 'sync', crons: ['0 * * * *'] }],
    };

    const code1 = compile({}, scan);
    const code2 = compile({}, scan);

    expect(code1).toContain('export const __PLATFORM_BUILD_KEY =');
    const match1 = code1.match(/__PLATFORM_BUILD_KEY = "([^"]+)"/);
    const match2 = code2.match(/__PLATFORM_BUILD_KEY = "([^"]+)"/);
    expect(match1).toBeTruthy();
    expect(match2).toBeTruthy();
    expect(match1![1]).not.toBe(match2![1]);
  });

  it('exports tombstones for removed websocket Durable Object classes', () => {
    const code = compile({ webSocketTombstones: ['RemovedChatWs'] });

    expect(code).toContain('createWebSocketTombstoneDurableObject');
    expect(code).toContain(
      'export const RemovedChatWs = __createWebSocketTombstoneDurableObject("RemovedChatWs")',
    );
    expect(compileWorkerEntry({ webSocketClasses: ['RemovedChatWs'] })).toContain(
      'export { RemovedChatWs };',
    );
  });

  it('generates the shared live durable object export when live is enabled', () => {
    const code = compile({
      hasLive: true,
      liveRuntimePath: '/resolved/platform/runtime/live-server.mjs',
    });

    expect(code).toContain('createLiveDurableObject');
    expect(code).toContain(
      'export const PlatformLiveStreamDurableObject = __createLiveDurableObject();',
    );
  });

  it('generates websocket durable object exports and proxy routes', () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: '/chat/:room',
          methods: ['GET'],
          params: ['room'],
          catchAll: false,
          env: null,
          filePath: 'chat/[room].ts',
        },
      ],
      websockets: [
        {
          pattern: '/chat/:room',
          methods: [],
          params: ['room'],
          catchAll: false,
          env: null,
          filePath: 'chat/[room].ws.ts',
          className: 'ChatRoomWs',
          bindingName: 'ChatRoomWs',
          mode: 'room',
          hasAuthGate: true,
        },
      ],
      middleware: [{ order: 1, filePath: '01.auth.ts' }],
      jobs: [],
      queues: [],
    };

    const code = compile({}, scan);

    expect(code).toContain('import websocket0 from "/routes/chat/[room].ws.ts"');
    expect(code).toContain('createWebSocketDurableObject');
    expect(code).toContain('export const ChatRoomWs = __createWebSocketDurableObject');
    expect(code).toContain('const __platformWebSocketRoutes = [{"pattern":"/chat/:room"');
    expect(code).toContain('"mode":"room"');
    expect(code).toContain('__registerWebSocketRoutes(__platformWebSocketRoutes);');
    expect(code.indexOf('__platformWebSocketRoutes[0].key = websocket0.key')).toBeLessThan(
      code.indexOf('__registerWebSocketRoutes(__platformWebSocketRoutes);'),
    );
    expect(code).toContain('app.all("/chat/:room"');
    expect(code).toContain(
      'if (c.req.raw.headers.get("upgrade")?.toLowerCase() !== "websocket") return next()',
    );
    expect(code).toContain('__forwardWebSocketRequest');
    expect(code.indexOf('app.use(middleware0)')).toBeLessThan(
      code.indexOf('app.all("/chat/:room"'),
    );
    const fallback = 'app.all("/chat/:room", (c) => __forwardWebSocketRequest';
    expect(code.indexOf('app.get("/chat/:room"')).toBeGreaterThan(
      code.indexOf('app.all("/chat/:room"'),
    );
    expect(code.indexOf(fallback)).toBeGreaterThan(code.indexOf('app.get("/chat/:room"'));
  });
});

function evalCompiledApp(code: string): Hono {
  // Decision: Drop imports and `export` keywords so the module body runs inside `new Function`;
  // a noop `withRuntimeEnv` replaces the imported one.
  const stripped = code
    .replaceAll(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?\s*$/gm, '')
    .replaceAll(/^export\s+default\s+app;?\s*$/gm, '')
    .replaceAll(/^export\s+(const|async\s+function|function)\s+/gm, '$1 ')
    .replaceAll(/^export\s+\{[^}]*\};?\s*$/gm, '');

  const factory = new Function(
    'Hono',
    'AsyncLocalStorage',
    '__createRoutingRuntime',
    '__createHttpRouteHandler',
    '__createModuleLoader',
    '__createAssetNotFound',
    ['const withRuntimeEnv = (_e, fn) => fn();', stripped, 'return app;'].join('\n'),
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vitest runs in node; node:async_hooks is built-in.
  const { AsyncLocalStorage } = require('node:async_hooks');
  return factory(
    Hono,
    AsyncLocalStorage,
    createRoutingRuntime,
    createHttpRouteHandler,
    createModuleLoader,
    createAssetNotFound,
  ) as Hono;
}

const executionContext = { waitUntil() {}, passThroughOnException() {}, props: {} };
const runtimeByApp = new WeakMap<Hono, RoutingRuntime>();
function installBwfWrappers(app: Hono): void {
  const runtime = createRoutingRuntime(app, { managedDispatch: true });
  runtimeByApp.set(app, runtime);
  app.use(runtime.contextMiddleware);
}

describe('c.redirect runtime wrapper', () => {
  it.each([
    ['/new', '/new'],
    ['/new?tab=1', '/new?tab=1'],
    ['https://example.com/next', 'https://example.com/next'],
    // Decision: A protocol-relative location is cross-origin, so the request query must not leak to it.
    ['//partner.example.com/landing', '//partner.example.com/landing'],
  ])('redirects to %s with Location %s', async (destination, location) => {
    const app = new Hono();
    installBwfWrappers(app);
    app.get('/old', (c) => c.redirect(destination, 302));

    const res = await app.fetch(new Request('http://localhost/old?x=1&y=2'), {}, executionContext);

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(location);
  });
});

function installRoutingRulesMiddleware(
  app: Hono,
  rules: Array<{ source: string; destination: string; status: number; force?: boolean }>,
): void {
  const runtime = runtimeByApp.get(app) ?? createRoutingRuntime(app);
  app.use('*', runtime.routingMiddleware(rules));
}

async function rewriteError(destination: string): Promise<unknown> {
  const app = new Hono();
  installBwfWrappers(app);

  let caught: unknown;
  app.get('/from', (c) => {
    try {
      (c as any).rewrite(destination);
    } catch (error) {
      caught = error;
    }
    return c.text('handled', 200);
  });

  const res = await app.fetch(new Request('http://localhost/from'), {}, executionContext);
  expect(res.status).toBe(200);
  return caught;
}

describe('c.rewrite runtime wrapper', () => {
  it('re-dispatches to the rewritten path and exposes c.originalUrl / c.isRewritten', async () => {
    const app = new Hono();
    installBwfWrappers(app);

    app.get('/external', (c) => (c as any).rewrite('/internal'));
    app.get('/internal', (c) => {
      return new Response('internal-body', {
        headers: {
          'X-Handler': 'internal',
          'X-Original-Url': (c as any).originalUrl()?.href ?? '',
          'X-Is-Rewritten': (c as any).isRewritten() ? '1' : '0',
        },
      });
    });

    const res = await app.fetch(
      new Request('http://localhost/external?keep=1'),
      {},
      executionContext,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('internal-body');
    expect(res.headers.get('X-Handler')).toBe('internal');
    expect(res.headers.get('X-Original-Url')).toBe('http://localhost/external?keep=1');
    expect(res.headers.get('X-Is-Rewritten')).toBe('1');
  });

  it('c.isRewritten() is true when dispatch sets X-Platform-Original-URL (platform edge rewrite)', async () => {
    const app = new Hono();
    installBwfWrappers(app);

    app.get('/en/docs', (c) => {
      return new Response('docs-body', {
        headers: {
          'X-Original-Url': (c as any).originalUrl()?.href ?? '',
          'X-Is-Rewritten': (c as any).isRewritten() ? '1' : '0',
        },
      });
    });

    const dispatchForwarded = new Request('http://localhost/en/docs', {
      headers: { 'X-Platform-Original-URL': 'http://localhost/docs' },
    });
    const res = await app.fetch(dispatchForwarded);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('docs-body');
    expect(res.headers.get('X-Original-Url')).toBe('http://localhost/docs');
    expect(res.headers.get('X-Is-Rewritten')).toBe('1');
  });

  it('single-hop loop guard: re-dispatched request skips the static rule table', async () => {
    const app = new Hono();
    let ruleMatches = 0;

    installBwfWrappers(app);
    app.use('*', async (c, next) => {
      if (!(c as any).isRewritten()) {
        ruleMatches++;
      }
      await next();
    });
    installRoutingRulesMiddleware(app, [
      { source: '/a', destination: '/a', status: 200, force: true },
    ]);

    app.get('/a', (c) => {
      return new Response('handler-a', {
        headers: { 'X-Is-Rewritten': (c as any).isRewritten() ? '1' : '0' },
      });
    });

    const res = await app.fetch(new Request('http://localhost/a'), {}, executionContext);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('handler-a');
    expect(ruleMatches).toBe(1);
    expect(res.headers.get('X-Is-Rewritten')).toBe('1');
  });

  it('rewrite vs fallback interaction: force-rewrite (always) wins over fallback (post-asset)', async () => {
    const { splitRedirectRulesByForce } = await import('../../src/cli/headers.ts');
    const allRules = [
      {
        source: '/docs/*',
        destination: '/fallback.html',
        status: 200,
        force: false,
        origin: 'bwf.config.ts#routing.fallbacks',
      },
      {
        source: '/docs/*',
        destination: '/rewrite-target',
        status: 200,
        force: true,
        origin: 'bwf.config.ts#routing.rewrites',
      },
    ];
    const { always: preAsset, fallbacks: postAsset } = splitRedirectRulesByForce(allRules);

    const app = new Hono();
    installBwfWrappers(app);
    installRoutingRulesMiddleware(app, preAsset);

    let fallbackFired = false;
    app.notFound(async (c) => {
      fallbackFired = true;
      return (
        (await runtimeByApp.get(app)!.applyFallback(c, postAsset)) ?? new Response('fallback-hit')
      );
    });

    app.get('/rewrite-target', (c) => c.text('rewrite-target', 200));

    const res = await app.fetch(new Request('http://localhost/docs/intro'), {}, executionContext);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('rewrite-target');
    expect(fallbackFired).toBe(false);
  });

  it('middleware runs twice on c.rewrite, with c.isRewritten() flipping false → true', async () => {
    const app = new Hono();
    installBwfWrappers(app);

    let invocations = 0;
    const observed: Array<boolean> = [];
    app.use('*', async (c, next) => {
      invocations++;
      observed.push((c as any).isRewritten());
      await next();
    });

    app.get('/from', (c) => (c as any).rewrite('/to'));
    app.get('/to', (c) => c.text('to-handler', 200));

    const res = await app.fetch(new Request('http://localhost/from'), {}, executionContext);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('to-handler');
    expect(invocations).toBe(2);
    expect(observed).toEqual([false, true]);
  });

  it('middleware runs twice when a post-asset fallback rewrite re-dispatches', async () => {
    const app = new Hono();
    installBwfWrappers(app);

    let invocations = 0;
    const observedReqUrls: Array<string> = [];
    const observedOriginalUrls: Array<URL | null> = [];
    app.use('*', async (c, next) => {
      invocations++;
      observedReqUrls.push(c.req.url);
      observedOriginalUrls.push((c as any).originalUrl());
      await next();
    });

    const fallbackRules = [{ source: '/missing/*', destination: '/spa-shell', status: 200 }];
    app.notFound(
      async (c) =>
        (await runtimeByApp.get(app)!.applyFallback(c, fallbackRules)) ?? c.text('not-found', 404),
    );

    app.get('/spa-shell', (c) => c.text('shell-body', 200));

    const res = await app.fetch(new Request('http://localhost/missing/deep'), {}, executionContext);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('shell-body');

    expect(invocations).toBe(2);
    expect(observedReqUrls[0]).toBe('http://localhost/missing/deep');
    expect(observedOriginalUrls[0]).toBeNull();
    expect(observedReqUrls[1]).toBe('http://localhost/spa-shell');
    expect(observedOriginalUrls[1]?.href).toBe('http://localhost/missing/deep');
  });

  it('c.rewrite() target reaches fallbackRules when no route matches', async () => {
    const app = new Hono();
    installBwfWrappers(app);

    app.use('*', async (c, next) => {
      if (new URL(c.req.url).pathname === '/trigger') {
        return (c as any).rewrite('/missing');
      }
      await next();
    });

    const fallbackRules = [{ source: '/missing', destination: '/index', status: 200 }];
    app.notFound(
      async (c) =>
        (await runtimeByApp.get(app)!.applyFallback(c, fallbackRules)) ?? c.text('not-found', 404),
    );

    app.get('/index', (c) => c.text('index-body', 200));

    const res = await app.fetch(new Request('http://localhost/trigger'), {}, executionContext);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('index-body');
  });

  // Decision: Setting `URL.pathname` to a value with `?` or `#` would percent-encode it,
  // so the destination is split: the query is kept and the fragment dropped.
  it.each([
    ['/page?x=1', '', '/page', '?x=1'],
    ['/page', '?x=1&y=2', '/page', '?x=1&y=2'],
    ['/page?b=2', '?a=1', '/page', '?b=2'],
    ['/foo#frag', '', '/foo', ''],
    ['/foo?x=1#frag', '', '/foo', '?x=1'],
    ['/foo#frag?x=1', '', '/foo', ''],
  ])(
    'c.rewrite(%j) from a request with query %j lands on %s with search %j',
    async (destination, incomingQuery, pathname, search) => {
      const app = new Hono();
      installBwfWrappers(app);

      app.get('/from', (c) => (c as any).rewrite(destination));
      app.get(pathname, (c) => {
        const u = new URL(c.req.url);
        return new Response('ok', {
          headers: {
            'X-Req-Path': u.pathname,
            'X-Req-Search': u.search,
            'X-Req-Hash': u.hash,
          },
        });
      });

      const res = await app.fetch(
        new Request(`http://localhost/from${incomingQuery}`),
        {},
        executionContext,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Req-Path')).toBe(pathname);
      expect(res.headers.get('X-Req-Search')).toBe(search);
      expect(res.headers.get('X-Req-Hash')).toBe('');
    },
  );

  it.each([
    ['external URL', 'http://evil.com'],
    ['protocol-relative', '//evil.com/path'],
  ])('c.rewrite rejects %s destinations with a clear error', async (_label, destination) => {
    const caught = await rewriteError(destination);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('path-absolute');
    expect((caught as Error).message).toContain('protocol-relative');
    expect((caught as Error).message).toContain('use fetch()');
  });

  it.each(['/hero.png', '/hero.PNG', '/api/users.json', '/hero.png?v=2'])(
    'c.rewrite to static asset path %s throws BwfAssetRewriteError',
    async (destination) => {
      const caught = await rewriteError(destination);

      expect(caught).toBeInstanceOf(BwfAssetRewriteError);
      expect((caught as Error).name).toBe('BwfAssetRewriteError');
      expect((caught as Error).message).toContain(destination);
      expect((caught as Error).message).toContain('`routing.rewrites` rule in bwf.config.ts');
      expect((caught as Error).message).toContain(
        'https://github.com/builtbyfriends/platform/blob/main/docs/guide/edge/rewrites.md#runtime-rewrites-cannot-reach-static-assets',
      );
    },
  );

  // Decision: `.html` may be a real route, so it isn't treated as a static asset.
  it.each(['/about.html', '/users/123'])(
    'c.rewrite to %s re-dispatches without throwing',
    async (destination) => {
      const app = new Hono();
      installBwfWrappers(app);
      app.get('/from', (c) => (c as any).rewrite(destination));
      app.get(destination, (c) => c.text('target', 200));

      const res = await app.fetch(new Request('http://localhost/from'), {}, executionContext);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('target');
    },
  );
});

describe('compileWorkerEntry', () => {
  it('passes the HTTPS redirect to the worker fetch only when enabled', () => {
    expect(compileWorkerEntry({ alwaysUseHttps: true })).toContain('alwaysUseHttps: true');
    expect(compileWorkerEntry()).not.toContain('alwaysUseHttps');
  });

  it('passes the version metadata binding name to the worker fetch', () => {
    expect(compileWorkerEntry({ versionMetadataBinding: 'AUTHORED_VERSION' })).toContain(
      'versionMetadataBinding: "AUTHORED_VERSION"',
    );
  });

  it('re-exports typed Durable Object modules as worker classes', () => {
    const code = compileWorkerEntry({
      durableObjects: [
        {
          bindingName: 'COUNTER',
          className: 'CounterDurableObject',
          filePath: '/app/durable-objects/counter.ts',
        },
      ],
    });

    expect(code).toContain(
      'import __platformDurableObject0 from "/app/durable-objects/counter.ts";',
    );
    expect(code).toContain('__platformDurableObject0.__bind("COUNTER");');
    expect(code).toContain(
      'const CounterDurableObject = __platformDurableObject0.class;\nexport { CounterDurableObject };',
    );
  });

  it('re-exports the live Durable Object class when enabled', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: '@builtbyfriends/bwf/_env',
      sandbox: false,
      serveSpaFallback: false,
      live: true,
    });

    expect(code).toContain('PlatformLiveStreamDurableObject');
    expect(code).toContain('export { PlatformLiveStreamDurableObject };');
    expect(code).toContain('__setLiveBindingName("BWF_LIVE");');
  });

  it('re-exports the configured live Durable Object class', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: '@builtbyfriends/bwf/_env',
      sandbox: false,
      serveSpaFallback: false,
      live: {
        bindingName: 'BWF_LIVE_abcd1234',
        className: 'PlatformLiveStreamDurableObject_abcd1234',
      },
    });

    expect(code).toContain(
      'export { PlatformLiveStreamDurableObject as PlatformLiveStreamDurableObject_abcd1234 };',
    );
    expect(code).toContain('__setLiveBindingName("BWF_LIVE_abcd1234");');
  });

  it('turns on live dev error messages only in the dev entry', () => {
    const options = {
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: '@builtbyfriends/bwf/_env',
      sandbox: false,
      serveSpaFallback: false,
      live: true,
    };

    const devCode = compileWorkerEntry({ ...options, dev: true });
    expect(devCode).toContain(
      'import { __setLiveBindingName, __setLiveDev } from "@builtbyfriends/bwf/live";',
    );
    expect(devCode).toContain('__setLiveDev(true);');

    const prodCode = compileWorkerEntry(options);
    expect(prodCode).toContain('__setLiveBindingName("BWF_LIVE");');
    expect(prodCode).not.toContain('__setLiveDev');
    expect(compileWorkerEntry({ ...options, dev: false })).not.toContain('__setLiveDev');
    expect(compileWorkerEntry({ ...options, live: false, dev: true })).not.toContain(
      '__setLiveDev',
    );
  });

  it('re-exports the BwfPlatformSandbox Durable Object class when enabled', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: '@builtbyfriends/bwf/_env',
      sandbox: true,
    });

    // Decision: BwfPlatformSandbox carries the metering and gate hooks, so user subclasses inherit them.
    expect(code).toContain(
      'import { BwfPlatformSandbox as __PlatformSandbox, __setSandboxBindingName } from "@builtbyfriends/bwf/sandbox"',
    );
    expect(code).not.toContain('from "@cloudflare/sandbox"');
    expect(code).toContain('export { __PlatformSandbox as SandboxV1 };');
    expect(code).toContain('__setSandboxBindingName("SANDBOX");');
  });

  it('exports the configured Sandbox Durable Object subclass via BwfPlatformSandbox', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: '@builtbyfriends/bwf/_env',
      sandbox: {
        bindingName: 'CODE',
        className: 'CodeSandbox',
        runtimePath: '@builtbyfriends/bwf/sandbox',
      },
    });

    expect(code).toContain(
      'import { BwfPlatformSandbox as __PlatformSandbox, __setSandboxBindingName } from "@builtbyfriends/bwf/sandbox"',
    );
    expect(code).not.toContain('from "@cloudflare/sandbox"');
    expect(code).toContain('export class CodeSandbox extends __PlatformSandbox {}');
    expect(code).toContain('__setSandboxBindingName("CODE");');
  });

  it('uses the resolved sandbox runtime path when one is provided', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: '@builtbyfriends/bwf/_env',
      sandbox: {
        runtimePath: '/abs/path/to/sandbox.mjs',
      },
    });

    expect(code).toContain(
      'import { BwfPlatformSandbox as __PlatformSandbox, __setSandboxBindingName } from "/abs/path/to/sandbox.mjs"',
    );
  });

  it('omits the sandbox import and export when sandbox is disabled', () => {
    const code = compileWorkerEntry();

    expect(code).not.toContain('__PlatformSandbox');
    expect(code).not.toContain('BwfPlatformSandbox');
    expect(code).not.toContain('__setSandboxBindingName');
    expect(code).not.toContain('from "@cloudflare/sandbox"');
  });

  it('generates queue() export in worker entry when hasQueues=true', () => {
    const code = compileWorkerEntry({ hasQueues: true });

    expect(code).toContain('async function __platformQueue(batch, env, ctx)');
    expect(code).toContain('async function handleScheduled(controller, env, ctx)');
    expect(code).toContain('serveWithAssets');
    expect(code).toContain(
      'async queue(batch) { return __platformQueue(batch, this.env, this.ctx); }',
    );
    expect(code).toContain('__processQueue');
    expect(code).toContain('batch.queue');
    expect(code).toContain('m.timestamp.toISOString()');
    expect(code).toContain('withRuntimeEnv(env, () => __processQueue(payload, userEnv))');
  });

  it('omits queue() export when hasQueues=false', () => {
    const code = compileWorkerEntry({ hasQueues: false });

    expect(code).not.toContain('queue');
  });

  it('sets missing asset MIME types while preserving binding headers', async () => {
    const serveWithAssets = createAssetFallback();

    for (const [path, expected] of [
      ['/assets/app.js', 'text/javascript; charset=utf-8'],
      ['/assets/app.css', 'text/css; charset=utf-8'],
      ['/assets/logo.webp', 'image/webp'],
      ['/assets/font.woff2', 'font/woff2'],
      ['/assets/unknown.xyz', null],
    ] as const) {
      const response = await serveWithAssets(
        new Request(`https://app.test${path}`),
        { ASSETS: { fetch: async () => new Response(new Uint8Array([1])) } },
        new Response('not found', { status: 404 }),
      );
      expect(response.headers.get('Content-Type')).toBe(expected);
    }

    const originalType = 'application/javascript';
    const response = await serveWithAssets(
      new Request('https://app.test/assets/app.js'),
      {
        ASSETS: {
          fetch: async () =>
            new Response(new Uint8Array([1]), { headers: { 'Content-Type': originalType } }),
        },
      },
      new Response('not found', { status: 404 }),
    );
    expect(response.headers.get('Content-Type')).toBe(originalType);
  });

  it('serveWithAssets does not include the SPA shell fallback by default', () => {
    const code = compileWorkerEntry();

    // Decision: Pages and SSR apps return intentional HTML 404 responses. The outer asset fallthrough
    // must not rewrite those to the SPA shell.
    expect(code).not.toContain('"/index.html"');
    expect(code).not.toContain('accept.includes("text/html")');
  });

  it('serveWithAssets keeps the worker response for not_found_handling: none', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: '@builtbyfriends/bwf/_env',
      sandbox: false,
      serveSpaFallback: false,
      notFound: 'none',
    });

    expect(code).toBe(compileWorkerEntry());
  });

  it('passes filtered env (userEnv) not raw env to scheduled handler', () => {
    const code = compileWorkerEntry();

    expect(code).toContain('async function handleScheduled(controller, env, ctx)');
    expect(code).toContain('const userEnv = __filterInternalBindings(env)');
    expect(code).toContain('scheduled(controller, userEnv, ctx)');
    expect(code).not.toMatch(/scheduled\(controller,\s*env,\s*ctx\)/);
  });

  it('omits boot-time env validation when no envSchemaModule is provided', () => {
    const code = compileWorkerEntry();
    expect(code).not.toContain('_validateEnvOnce');
  });

  it('passes custom binding names to remote env proxying', () => {
    const code = compileWorkerEntry({
      hasQueues: true,
      remote: {
        bindingNames: { d1: 'myapp_db', kv: 'myapp_kv', r2: 'myapp_storage' },
        remotePath: '/resolved/remote.mjs',
      },
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: '/resolved/env.mjs',
    });

    expect(code).toContain(
      'createRemoteEnv(env, {"d1":"myapp_db","kv":"myapp_kv","r2":"myapp_storage"})',
    );
  });
});

describe('shared pattern compiler in generated routes', () => {
  const compilePattern = (source: string) => {
    const { paramNames } = sharedCompilePattern(source);
    return { names: [...paramNames] };
  };

  it(':name and bare "*" do not clash even when both appear', () => {
    const { names } = compilePattern('/u/:id*/files/*');
    expect(names).toEqual(['id', 'splat']);
    expect(matchPatternCaptures('/u/:id*/files/*', '/u/42/extra/files/a/b')).toEqual({
      id: '42/extra',
      splat: 'a/b',
    });
  });

  it('__compilePattern itself still throws on duplicate capture group names', () => {
    // Decision: Config validation rejects these; the runtime skips such rules per request.
    expect(() => compilePattern('/:id/:id')).toThrow(/duplicate capture group name/i);
    expect(() => compilePattern('/:splat/*')).toThrow(/duplicate capture group name/i);
    expect(() => compilePattern('/:rest*/:rest*')).toThrow(/duplicate capture group name/i);
  });

  it('production routing middleware skips invalid rules and still applies valid ones', async () => {
    const codeWithRules = compile({
      dev: true,
      redirectRules: [
        {
          source: '/:id/:id',
          destination: '/x',
          status: 200,
          force: true,
          origin: 'test',
        },
        {
          source: '/old',
          destination: '/new',
          status: 200,
          force: true,
          origin: 'test',
        },
      ],
    });
    const app = evalCompiledApp(codeWithRules);
    app.get('/new', (c) => c.text('new route'));
    const response = await app.fetch(
      new Request('https://app.test/old'),
      {},
      { waitUntil() {}, passThroughOnException() {}, props: {} },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('new route');
  });

  it('header matching skips malformed patterns and warns once per app', async () => {
    const warnings: Array<string> = [];
    const originalWarn = console.warn;
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      const app = new Hono();
      const runtime = createRoutingRuntime(app);
      app.use(runtime.headerMiddleware([{ pattern: '/:id/:id', headers: [['x-bad', '1']] }]));
      app.get('*', (c) => c.text('ok'));
      for (let i = 0; i < 2; i++) {
        const response = await app.fetch(new Request('https://app.test/a/b'), {}, executionContext);
        expect(response.status).toBe(200);
        expect(response.headers.has('x-bad')).toBe(false);
      }
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('failed to compile route pattern');
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('typed runtime metadata wiring', () => {
  it('imports Worker-safe execution and emits route export selection and cache policy', () => {
    const scan: ScanResult = {
      ...emptyScan,
      routes: [
        {
          pattern: '/hello',
          filePath: 'hello.ts',
          params: [],
          catchAll: false,
          env: null,
          methods: ['GET', 'POST'],
        },
      ],
    };
    const dev = compile({ dev: true }, scan);
    expect(dev).toContain('createRoutingRuntime as __createRoutingRuntime');
    expect(dev).toContain(
      'const _load_hello_ts = __createModuleLoader(() => import("/routes/hello.ts"), false)',
    );
    expect(dev).toContain('app.get("/hello", __createHttpRouteHandler(_load_hello_ts, "GET"))');
    expect(dev).toContain('app.post("/hello", __createHttpRouteHandler(_load_hello_ts, "POST"))');
    expect(dev).not.toContain('function __platformAnnotateRouting');
    expect(dev).not.toContain('c.rewrite =');
  });
  it('gives route files that differ only in punctuation their own loaders', () => {
    const route = (filePath: string, pattern: string) => ({
      pattern,
      filePath,
      params: [],
      catchAll: false,
      env: null,
      methods: ['GET'],
    });
    const code = compile(
      { dev: true },
      {
        ...emptyScan,
        routes: [
          route('api/user-list.ts', '/api/user-list'),
          route('api/user_list.ts', '/api/user_list'),
        ],
      },
    );
    const parsed = parseSync('routes.js', code, { sourceType: 'module', showSemanticErrors: true });
    expect(parsed.errors.map((error) => error.message)).toEqual([]);
    expect(code).toContain(
      'const _load_api_user_list_ts = __createModuleLoader(() => import("/routes/api/user-list.ts"), false)',
    );
    expect(code).toContain(
      'const _load_api_user_list_ts_2 = __createModuleLoader(() => import("/routes/api/user_list.ts"), false)',
    );
    expect(code).toContain(
      'app.get("/api/user_list", __createHttpRouteHandler(_load_api_user_list_ts_2, "GET"))',
    );
  });
  it('keeps authored rule origins in dev and omits them in production and managed dispatch', () => {
    const rules = [{ source: '/old', destination: '/new', status: 301, origin: 'config' }];
    const dev = compile({ dev: true, redirectRules: rules, fallbackRules: rules });
    expect(dev).toContain('"origin":"config"');
    expect(dev).toContain('__routingRuntime.routingMiddleware(__routingRules)');
    expect(dev).toContain('__createAssetNotFound');
    const production = compile({ dev: false, redirectRules: rules, fallbackRules: rules });
    expect(production).not.toContain('"origin":"config"');
    const managed = compile({ managedDispatch: true, redirectRules: rules, fallbackRules: rules });
    expect(managed).not.toContain('const __routingRules');
    expect(managed).not.toContain('app.notFound');
  });
  it('looks rewrite destinations up in static assets', () => {
    const rewrite = [{ source: '/', destination: '/index.html', status: 200, force: true }];
    expect(compile({ dev: false, redirectRules: rewrite })).toContain(
      'app.notFound(__routingRuntime.trackNotFound(__createAssetNotFound',
    );
  });

  it('wires fetch validation and opaque internal routes through runtime callbacks', () => {
    const code = compileWorkerEntry({
      envSchemaModule: { importPath: '/env.ts', helperPath: '/env-helpers.ts' },
    });
    expect(code).toContain('const __platformFetch = __createWorkerFetch({');
    expect(code).toContain('validateEnv: _validateEnvOnce');
    expect(code).toContain('internalRoute: __platformHandleInternalRoute');
    expect(code).toContain(
      'const serveWithAssets = __createAssetFallback({"assetsDir":"assets","serveSpaFallback":false,"notFound":"none"})',
    );
    expect(code).not.toContain('function __handleInternal');
    expect(code).not.toContain('async function serveWithAssets');
  });
});

describe('default-target dev parity', () => {
  const redirectRules = [
    {
      source: '/old',
      destination: '/new',
      status: 301,
      origin: 'bwf.config.ts#routing.redirects',
    },
    {
      source: '/rewrite',
      destination: '/new',
      status: 200,
      force: true,
      origin: 'bwf.config.ts#routing.rewrites',
    },
  ];
  const headerRules = [{ pattern: '/*', headers: [['x-test', '1']] as Array<[string, string]> }];
  const fallbackRules = [
    {
      source: '/docs/*',
      destination: '/docs.html',
      status: 200,
      force: false,
      origin: 'bwf.config.ts#routing.fallbacks',
    },
  ];

  const compileWithRules = (options: Partial<CompileOptions>) =>
    compile({ redirectRules, headerRules, fallbackRules, ...options });

  it('applies header rules to immutable responses in local dev', async () => {
    const app = evalCompiledApp(compileWithRules({ dev: true }));
    app.get('/redirect', () => Response.redirect('https://example.com/next', 302));

    const res = await app.fetch(new Request('http://localhost/redirect'), {}, executionContext);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/next');
    expect(res.headers.get('x-test')).toBe('1');
  });

  it('runs native Cloudflare prod rewrites, headers, and post-asset fallbacks', async () => {
    const app = evalCompiledApp(compileWithRules({ dev: false, managedDispatch: false }));
    app.get('/new', (c: any) =>
      c.text(c.originalUrl()?.pathname === '/rewrite' ? 'rewritten' : 'new'),
    );
    app.get('/docs.html', (c) => c.text('fallback'));
    const env = {
      ASSETS: { fetch: async () => new Response('missing', { status: 404 }) },
    };

    const rewrite = await app.fetch(new Request('http://localhost/rewrite'), env, executionContext);
    expect(await rewrite.text()).toBe('rewritten');
    expect(rewrite.headers.get('x-test')).toBe('1');

    const fallback = await app.fetch(
      new Request('http://localhost/docs/guide'),
      env,
      executionContext,
    );
    expect(await fallback.text()).toBe('fallback');
    expect(fallback.headers.get('x-test')).toBe('1');
  });

  it('applies native Cloudflare prod headers to assets without fallback rules', async () => {
    const code = compile({ dev: false, managedDispatch: false, headerRules });
    const app = evalCompiledApp(code);
    const res = await app.fetch(
      new Request('http://localhost/logo.svg'),
      { ASSETS: { fetch: async () => new Response('asset') } },
      executionContext,
    );

    expect(await res.text()).toBe('asset');
    expect(res.headers.get('x-test')).toBe('1');
    expect(code).not.toContain('const __fallbackRules =');
  });

  it('omits redirect + header + fallback middleware from managed bundles', () => {
    const code = compileWithRules({ dev: false, managedDispatch: true });
    expect(code).not.toContain('const __routingRules =');
    expect(code).not.toContain('const __headerRules =');
    expect(code).not.toContain('const __fallbackRules =');
  });

  it('reads inbound X-Platform-Original-URL only behind managed dispatch', async () => {
    const permutations: Array<{
      label: string;
      opts: { dev: boolean; managedDispatch?: boolean };
      trustsHeader: boolean;
    }> = [
      { label: 'managedCfProd', opts: { dev: false, managedDispatch: true }, trustsHeader: true },
      { label: 'nativeCfProd', opts: { dev: false }, trustsHeader: false },
      { label: 'cfDev', opts: { dev: true, managedDispatch: true }, trustsHeader: false },
    ];

    for (const { label, opts, trustsHeader } of permutations) {
      const app = evalCompiledApp(compileWithRules(opts));
      // Decision: Registered after eval so the compiled context middleware runs first.
      app.get('/probe', (c: any) => {
        const orig = c.originalUrl();
        return new Response('probe', {
          headers: {
            'X-Original-Url': orig?.href ?? '',
            'X-Is-Rewritten': c.isRewritten() ? '1' : '0',
          },
        });
      });
      const res = await app.fetch(
        new Request('http://localhost/probe', {
          headers: { 'X-Platform-Original-URL': 'http://localhost/spoof' },
        }),
        {},
        executionContext,
      );

      expect(res.status, `${label}: probe should return 200`).toBe(200);
      expect(res.headers.get('X-Original-Url'), label).toBe(
        trustsHeader ? 'http://localhost/spoof' : '',
      );
      expect(res.headers.get('X-Is-Rewritten'), label).toBe(trustsHeader ? '1' : '0');
    }
  });
});
