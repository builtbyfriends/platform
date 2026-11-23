import { routeUrl } from '@builtbyfriends/bwf/routes';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vite-plus/test';
import { _validateEnvOnce, defineEnv, env } from '../../src/runtime/env-public.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';
import { defineHandler } from '../../src/runtime/handler.ts';
import { createManifestLoader } from '../../src/runtime/routing-assets.ts';
import {
  applyAssetCachePolicy,
  createAssetCachePolicy,
  createAssetFallback,
  createWorkerFetch,
  filterInternalBindings,
} from '../../src/runtime/routing-worker.ts';
import type { RuntimeEnvironment } from '../../src/runtime/routing-worker.ts';
import {
  createAssetNotFound,
  createHttpRouteHandler,
  createModuleLoader,
  createRoutingRuntime,
} from '../../src/runtime/routing.ts';
import type {
  RoutingContext,
  RoutingHeaderRule,
  RoutingRuntime,
} from '../../src/runtime/routing.ts';
const context = { waitUntil() {}, passThroughOnException() {}, props: {} };
const wrap = <T>(_env: RuntimeEnvironment, callback: () => T): T => callback();

declare module '@builtbyfriends/bwf/routes' {
  interface RoutePathMap {
    '/typed-rewrite/:id': 'id';
  }
}

describe('typed HTTP execution', () => {
  it.each([undefined, 301, 303, 307, 308] as const)(
    'redirects typed destinations with status %s',
    async (status) => {
      const app = new Hono();
      const runtime = createRoutingRuntime(app);
      app.use(runtime.contextMiddleware);
      const destination = routeUrl('/typed-rewrite/:id', {
        params: { id: 'a/b' },
        query: { tab: 'activity' },
        hash: 'details',
      });
      app.get(
        '/redirect',
        createHttpRouteHandler(
          async () => ({
            GET: defineHandler((c) => c.redirect(destination, status)),
          }),
          'GET',
        ),
      );
      const response = await app.fetch(new Request('https://app.test/redirect'), {}, context);
      expect(response.status).toBe(status ?? 302);
      expect(response.headers.get('Location')).toBe('/typed-rewrite/a%2Fb?tab=activity#details');
    },
  );

  it('rewrites typed destinations with encoded params and a query string', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app);
    app.use(runtime.contextMiddleware);
    app.get('/old', (c) =>
      c.rewrite({
        pathname: '/typed-rewrite/:id',
        params: { id: 'a/b' },
        query: { tab: 'activity' },
      }),
    );
    app.get('/typed-rewrite/:id', (c) =>
      c.json({
        id: c.req.param('id'),
        tab: c.req.query('tab'),
        original: c.originalUrl()?.pathname,
      }),
    );
    const response = await app.fetch(new Request('https://app.test/old'), {}, context);
    expect(await response.json()).toEqual({ id: 'a/b', tab: 'activity', original: '/old' });
  });

  it('caches successful production loads, retries rejected loads and refreshes dev loads', async () => {
    let count = 0;
    const load = createModuleLoader(async () => {
      if (++count === 1) {
        throw new Error('load failed');
      }
      return { count };
    });
    await expect(load()).rejects.toThrow('load failed');
    expect(await load()).toEqual({ count: 2 });
    expect(await load()).toEqual({ count: 2 });
    const devLoad = createModuleLoader(async () => ++count, false);
    expect(await devLoad()).toBe(3);
    expect(await devLoad()).toBe(4);
  });
  it('invokes the selected lazy export and converts its real return value', async () => {
    const app = new Hono();
    app.get(
      '/route',
      createHttpRouteHandler(async () => ({ GET: (c) => ({ url: c.req.path }) }), 'GET'),
    );
    app.post(
      '/route',
      createHttpRouteHandler(async () => ({ POST: () => undefined }), 'POST'),
    );
    expect(
      await (await app.fetch(new Request('https://app.test/route'), {}, context)).json(),
    ).toEqual({
      url: '/route',
    });
    expect(
      (await app.fetch(new Request('https://app.test/route', { method: 'POST' }), {}, context))
        .status,
    ).toBe(204);
  });
  it('isolates request context for overlapping asynchronous requests', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app);
    app.use(runtime.requestMiddleware);
    app.get('/:id', async (c) => {
      await Promise.resolve();
      return c.text(runtime.requestContext.getStore()!.request.url);
    });
    const responses = await Promise.all(
      ['/one', '/two'].map((path) =>
        app.fetch(new Request('https://app.test' + path), {}, context),
      ),
    );
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
      'https://app.test/one',
      'https://app.test/two',
    ]);
    expect(runtime.requestContext.getStore()).toBeUndefined();
  });
  it('applies the first matching host rule, capture substitution, query merge and dev traces', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { dev: true });
    app.use(runtime.contextMiddleware);
    app.use(
      runtime.routingMiddleware([
        { source: '/old/:id', destination: '/wrong', status: 301, host: 'other.test' },
        { source: '/old/:id', destination: '/new/:id?set=1', status: 301, origin: 'config' },
        { source: '/old/:id', destination: '/last', status: 302 },
      ]),
    );
    const response = await app.fetch(
      new Request('https://app.test/old/42?set=override&keep=1'),
      {},
      context,
    );
    expect(response.headers.get('location')).toBe('/new/42?set=1&keep=1');
    expect(response.headers.get('X-Platform-Routing')).toBe(
      'redirect[/old/:id] -> /new/42?set=1 301 (config)',
    );
  });
  it('keeps catch-all redirects on the same site when the capture starts with a slash', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app);
    app.use(runtime.contextMiddleware);
    app.use(runtime.routingMiddleware([{ source: '/en/*', destination: '/:splat', status: 301 }]));
    const response = await app.fetch(new Request('https://app.test/en//evil.com'), {}, context);
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/evil.com');
  });
  describe('code redirects and routing.redirects', () => {
    function redirectApp(setup: (app: Hono, runtime: RoutingRuntime) => void): Hono {
      const app = new Hono();
      const runtime = createRoutingRuntime(app);
      app.use(runtime.contextMiddleware);
      setup(app, runtime);
      return app;
    }

    it.each([
      ['/sign-in?redirectTo=/notes', '/notes', '/notes'],
      ['/notes?x=1', '/sign-in?redirectTo=%2Fnotes', '/sign-in?redirectTo=%2Fnotes'],
      ['/notes?x=1&y=2', '/notes#saved', '/notes#saved'],
      ['/old?x=1&y=2', 'https://example.com/next?ok=1', 'https://example.com/next?ok=1'],
      ['/old?x=1&y=2', '//partner.example.com/landing', '//partner.example.com/landing'],
    ])('c.redirect from %s to %s sends %s', async (requestPath, destination, location) => {
      const app = redirectApp((app) => {
        app.get('/*', (c) => c.redirect(destination));
      });
      const response = await app.fetch(new Request('https://app.test' + requestPath), {}, context);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(location);
    });

    it('does not leak a request token through middleware', async () => {
      const app = redirectApp((app) => {
        app.use('/any', async (c) => c.redirect('/banned'));
        app.get('/any', (c) => c.text('ok'));
      });
      const response = await app.fetch(new Request('https://app.test/any?token=abc'), {}, context);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/banned');
    });

    it('does not append the request query to a routeUrl redirect', async () => {
      const destination = routeUrl('/typed-rewrite/:id', {
        params: { id: 'a/b' },
        query: { tab: 'activity' },
        hash: 'details',
      });
      const app = redirectApp((app) => {
        app.get('/redirect', (c) => c.redirect(destination));
      });
      const response = await app.fetch(
        new Request('https://app.test/redirect?extra=1'),
        {},
        context,
      );
      expect(response.headers.get('location')).toBe('/typed-rewrite/a%2Fb?tab=activity#details');
    });

    it.each([
      ['/old?redirectTo=/notes', '/new', '/new?redirectTo=/notes'],
      ['/old?token=abc&keep=1', '/new?ref=1', '/new?ref=1&token=abc&keep=1'],
      ['/old?token=abc', '/new?', '/new'],
      ['/old?utm=x', '/new#faq', '/new?utm=x#faq'],
    ])('a routing redirect from %s to %s sends %s', async (requestPath, destination, location) => {
      const app = redirectApp((app, runtime) => {
        app.use(runtime.routingMiddleware([{ source: '/old', destination, status: 302 }]));
      });
      const response = await app.fetch(new Request('https://app.test' + requestPath), {}, context);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(location);
    });
  });
  it.each([true, false])('gates dynamic rewrite tracing on dev=%s', async (dev) => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { dev });
    app.use(runtime.contextMiddleware);
    app.use(runtime.routingMiddleware([]));
    app.get('/old', (c) => (c as RoutingContext).rewrite('/new'));
    app.get('/new', (c) => c.text('rewritten'));
    const response = await app.fetch(new Request('https://app.test/old'), {}, context);
    expect(await response.text()).toBe('rewritten');
    expect(response.headers.get('X-Platform-Routing')).toBe(
      dev ? 'c.rewrite -> /new (middleware)' : null,
    );
  });
  it.each([200, 404])(
    'overrides an existing response header with the last matching rule on %s',
    async (status) => {
      const app = new Hono();
      const runtime = createRoutingRuntime(app);
      app.use(
        runtime.headerMiddleware([
          { pattern: '/assets/*', headers: [['Cache-Control', 'no-cache']] },
          {
            pattern: '/assets/*',
            headers: [['Cache-Control', 'public, max-age=31536000, immutable']],
          },
        ]),
      );
      app.get(
        '/assets/app.css',
        () =>
          new Response('body{}', {
            status,
            headers: {
              'Content-Type': 'text/css',
              'Cache-Control': 'public, max-age=0, must-revalidate',
            },
          }),
      );
      const response = await app.request('https://app.test/assets/app.css');
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toBe('text/css');
      expect(await response.text()).toBe('body{}');
    },
  );
  it('updates immutable response headers and preserves unrelated cookies and metadata', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app);
    app.use(
      runtime.headerMiddleware([
        {
          pattern: '/assets/*',
          headers: [
            ['Location', '/new'],
            ['X-Robots-Tag', 'noindex'],
          ],
        },
      ]),
    );
    app.get('/assets/redirect', () => Response.redirect('https://old.test/', 302));
    app.get('/assets/cookies', () => {
      const headers = new Headers({ 'Content-Type': 'text/css' });
      headers.append('Set-Cookie', 'one=1; Path=/');
      headers.append('Set-Cookie', 'two=2; Path=/');
      return new Response('body{}', { status: 202, statusText: 'Queued', headers });
    });
    app.get(
      '/other',
      () => new Response('other', { headers: { 'Cache-Control': 'private, no-store' } }),
    );
    const redirect = await app.request('https://app.test/assets/redirect');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/new');
    const response = await app.request('https://app.test/assets/cookies');
    expect(response.status).toBe(202);
    expect(response.statusText).toBe('Queued');
    expect(response.headers.get('content-type')).toBe('text/css');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.getSetCookie()).toEqual(['one=1; Path=/', 'two=2; Path=/']);
    expect(await response.text()).toBe('body{}');
    const other = await app.request('https://app.test/other');
    expect(other.headers.get('cache-control')).toBe('private, no-store');
    expect(other.headers.has('x-robots-tag')).toBe(false);
  });
  it('adds a Set-Cookie rule next to the response cookies', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app);
    app.use(
      runtime.headerMiddleware([{ pattern: '/*', headers: [['Set-Cookie', 'consent=1; Path=/']] }]),
    );
    app.get('/sign-in', (c) => {
      c.header('Set-Cookie', 'session=abc; Path=/; HttpOnly', { append: true });
      return c.text('ok');
    });
    const response = await app.request('https://app.test/sign-in');
    expect(response.headers.getSetCookie()).toEqual([
      'session=abc; Path=/; HttpOnly',
      'consent=1; Path=/',
    ]);
  });
  it('uses the last matching Set-Cookie rule value', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app);
    app.use(runtime.contextMiddleware);
    app.use(
      runtime.headerMiddleware(
        ['theme=light; Path=/', 'theme=dark; Path=/', 'theme=light; Path=/'].map(
          (cookie): RoutingHeaderRule => ({ pattern: '/*', headers: [['Set-Cookie', cookie]] }),
        ),
      ),
    );
    app.get('/old', (c) => (c as RoutingContext).rewrite('/new'));
    app.get('/new', (c) => c.text('new'));
    for (const path of ['/new', '/old']) {
      const response = await app.request(`https://app.test${path}`);
      expect(response.headers.getSetCookie()).toEqual(['theme=light; Path=/']);
    }
  });
  it('ends with the source rule cookie after a rewrite', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app);
    app.use(runtime.contextMiddleware);
    app.use(
      runtime.headerMiddleware([
        { pattern: '/new', headers: [['Set-Cookie', 'theme=dark; Path=/']] },
        { pattern: '/old', headers: [['Set-Cookie', 'theme=light; Path=/']] },
      ]),
    );
    app.get('/old', (c) => (c as RoutingContext).rewrite('/new'));
    app.get('/new', (c) => c.text('new', 200, { 'set-cookie': 'theme=light; Path=/' }));
    const response = await app.request('https://app.test/old');
    expect(response.headers.getSetCookie().at(-1)).toBe('theme=light; Path=/');
  });
  it('adds a Set-Cookie rule once when a rewrite source and destination both match', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app);
    app.use(runtime.contextMiddleware);
    app.use(
      runtime.headerMiddleware([{ pattern: '/*', headers: [['Set-Cookie', 'consent=1; Path=/']] }]),
    );
    app.get('/old', (c) => (c as RoutingContext).rewrite('/new'));
    app.get('/new', (c) => c.text('new'));
    const response = await app.request('https://app.test/old');
    expect(response.headers.getSetCookie()).toEqual(['consent=1; Path=/']);
  });
  it('does not give a fallback page the rules of the missing path', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app);
    app.use(runtime.contextMiddleware);
    app.use(
      runtime.headerMiddleware([
        {
          pattern: '/assets/*',
          headers: [['Cache-Control', 'public, max-age=31536000, immutable']],
        },
      ]),
    );
    app.get(
      '/index.html',
      (c) => new Response('<html></html>', { headers: { 'Cache-Control': 'no-cache' } }),
    );
    app.notFound(
      async (c) =>
        (await runtime.applyFallback(c, [
          { source: '/*', destination: '/index.html', status: 200 },
        ])) ?? c.text('missing', 404),
    );
    const response = await app.fetch(
      new Request('https://app.test/assets/old-chunk.js'),
      {},
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });
  it('merges header rules in order after recursive fallback and stops fallback cycles', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { dev: true });
    app.use(runtime.contextMiddleware);
    app.use(
      runtime.headerMiddleware([
        { pattern: '/*', headers: [['x-rule', 'one']] },
        { pattern: '/a', headers: [['x-rule', 'two']] },
      ]),
    );
    app.notFound(
      async (c) =>
        (await runtime.applyFallback(c, [
          { source: '/a', destination: '/b', status: 200 },
          { source: '/b', destination: '/a', status: 200 },
        ])) ?? runtime.markNoMatch(c.req.raw, new Response('missing', { status: 404 })),
    );
    const response = await app.fetch(new Request('https://app.test/a'), {}, context);
    expect(response.status).toBe(404);
    // Decision: Only the destination's rules apply, as in edge routing and platform dispatch.
    expect(response.headers.get('x-rule')).toBe('one');
    expect(response.headers.get('X-Platform-Routing')).toBe('fallback[/a] -> /b (unknown)');
    expect(response.headers.get('X-Platform-No-Match')).toBe('1');
  });
});

function worker(overrides: Partial<Parameters<typeof createWorkerFetch>[0]> = {}) {
  const app = new Hono<{ Bindings: RuntimeEnvironment }>();
  app.get('/app', (c) =>
    c.json({
      public: c.env.PUBLIC,
      hidden: c.env.__PLATFORM_PROXY_TOKEN,
      keys: Object.keys(c.env),
    }),
  );
  return createWorkerFetch({
    app,
    assets: createAssetFallback(),
    withRawEnv: wrap,
    withRuntimeEnv: wrap,
    filterBindings: (env) => filterInternalBindings(env, ['__PLATFORM_']),
    internalRoute: async () => null,
    ...overrides,
  });
}
describe('typed Worker fetch execution', () => {
  it('proves the actual named metadata version and never echoes requested override or private metadata', async () => {
    const fetch = worker({ versionMetadataBinding: '__PLATFORM_VERSION_METADATA' });
    const request = new Request('https://app.test/__platform/ready', {
      headers: { 'Cloudflare-Workers-Version-Overrides': 'app="candidate-version"' },
    });
    const response = await fetch(
      request,
      {
        __PLATFORM_VERSION_METADATA: {
          id: 'served-version',
          tag: 'private-tag',
          timestamp: 'private-time',
        },
      },
      context,
    );
    expect(await response.json()).toEqual({ ready: true, versionId: 'served-version' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const missing = await fetch(request, {}, context);
    expect(await missing.json()).toEqual({ ready: true });
    expect(missing.headers.get('cache-control')).toBe('no-store');
  });
  const upper = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: async (value: unknown) => ({ value: String(value).toUpperCase() }),
    },
  };
  // Decision: The entry validates before it opens the request scope that the app's reads run in.
  it('serves an env.ts value with an async validator to app requests', async () => {
    defineEnv({ TOKEN: upper });
    try {
      const app = new Hono();
      app.get('/token', (c) => c.json({ token: env.TOKEN }));
      const fetch = worker({ app, validateEnv: _validateEnvOnce, withRuntimeEnv });
      for (const rawEnv of [{ TOKEN: 'sk_test' }, { TOKEN: 'sk_test' }]) {
        const response = await fetch(new Request('https://app.test/token'), rawEnv, context);
        expect(await response.json()).toEqual({ token: 'SK_TEST' });
      }
    } finally {
      defineEnv({});
    }
  });
  // Decision: Remote dev mode replaces the env with a copy before it opens the request scope.
  it('serves an env.ts value with an async validator to remote dev requests', async () => {
    defineEnv({ TOKEN: upper });
    try {
      const app = new Hono();
      app.get('/token', (c) => c.json({ token: env.TOKEN }));
      const fetch = worker({
        app,
        validateEnv: _validateEnvOnce,
        withRuntimeEnv,
        remoteEnv: (original) => ({ ...original }),
      });
      const response = await fetch(
        new Request('https://app.test/token'),
        { TOKEN: 'sk_test', __PLATFORM_REMOTE: '1' },
        context,
      );
      expect(await response.json()).toEqual({ token: 'SK_TEST' });
    } finally {
      defineEnv({});
    }
  });
  // Decision: Cloudflare can keep an isolate running when only its bindings change, so a request that holds
  // the old values can overlap one that holds the new values.
  it('serves each of two overlapping requests the async value of its own env', async () => {
    defineEnv({ TOKEN: upper });
    try {
      let waiting = 0;
      let release = () => {};
      const bothValidated = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = new Hono();
      app.get('/token', async (c) => {
        if (++waiting === 2) {
          release();
        }
        await bothValidated;
        return c.json({ token: env.TOKEN });
      });
      const fetch = worker({ app, validateEnv: _validateEnvOnce, withRuntimeEnv });
      const responses = await Promise.all(
        ['a', 'b'].map((value) =>
          fetch(new Request('https://app.test/token'), { TOKEN: value }, context),
        ),
      );
      expect(
        await Promise.all(
          responses.map(async (response) => [response.status, await response.text()]),
        ),
      ).toEqual([
        [200, '{"token":"A"}'],
        [200, '{"token":"B"}'],
      ]);
    } finally {
      defineEnv({});
    }
  });
  it('resolves remote env after validating original bindings and enters scopes before internal routes', async () => {
    const original = { __PLATFORM_REMOTE: '1' };
    const resolved = { PUBLIC: 'remote' };
    const calls: Array<string> = [];
    const fetch = worker({
      validateEnv: async (env) => {
        expect(env).toBe(original);
        calls.push('validate');
      },
      remoteEnv: () => {
        calls.push('remote');
        return resolved;
      },
      withRawEnv: (env, callback) => {
        expect(env).toBe(resolved);
        calls.push('raw');
        return callback();
      },
      withRuntimeEnv: (env, callback) => {
        expect(env).toBe(resolved);
        calls.push('runtime');
        return callback();
      },
      internalRoute: async () => {
        calls.push('internal');
        return new Response('internal');
      },
    });
    expect(
      await (await fetch(new Request('https://app.test/internal'), original, context)).text(),
    ).toBe('internal');
    expect(calls).toEqual(['validate', 'remote', 'raw', 'runtime', 'internal']);
  });
  it('routes email receipts through the scoped callback before app middleware and preserves its response', async () => {
    const emailReceipt = vi.fn(async () => new Response('receipt', { status: 202 }));
    const internalRoute = vi.fn(async () => null);
    const response = await worker({ emailReceipt, internalRoute })(
      new Request('https://app.test/__platform/email/receipt/v1', { method: 'POST' }),
      {},
      context,
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('receipt');
    expect(emailReceipt).toHaveBeenCalledTimes(1);
    expect(internalRoute).not.toHaveBeenCalled();
  });
  it('hides capabilities through property lookup, membership, enumeration and descriptors only when selected', () => {
    const env = { __PLATFORM_TOKEN: 'private', PLATFORM_NORMAL: 'public', ISR_CACHE: 'user-cache' };
    const publicEnv = filterInternalBindings(env, ['__PLATFORM_']);
    expect(publicEnv.ISR_CACHE).toBe('user-cache');
    const hidden = filterInternalBindings(env, ['__PLATFORM_'], ['ISR_CACHE']);
    expect(hidden.__PLATFORM_TOKEN).toBeUndefined();
    expect('ISR_CACHE' in hidden).toBe(false);
    expect(Object.keys(hidden)).toEqual(['PLATFORM_NORMAL']);
    expect(Object.getOwnPropertyDescriptor(hidden, '__PLATFORM_TOKEN')).toBeUndefined();
  });

  it('validates env for readiness and app requests and hides internal bindings', async () => {
    const validateEnv = vi.fn(async () => {});
    const fetch = worker({ validateEnv });
    const env = { PUBLIC: 'yes', __PLATFORM_PROXY_TOKEN: 'secret' };
    expect(
      await (await fetch(new Request('https://app.test/__platform/ready'), env, context)).json(),
    ).toEqual({ ready: true });
    expect(await (await fetch(new Request('https://app.test/app'), env, context)).json()).toEqual({
      public: 'yes',
      keys: ['PUBLIC'],
    });
    expect(validateEnv).toHaveBeenCalledTimes(2);
  });
});

describe('typed asset fallthrough', () => {
  it.each([['private, max-age=60'], ['no-store'], ['no-cache'], ['public, max-age=120']])(
    'preserves the authored %s policy for hashed assets',
    (policy) => {
      const source = new Response('asset', { headers: { 'cache-control': policy } });
      const response = applyAssetCachePolicy(
        new Request('https://app.test/assets/client-abcdefgh.js'),
        source,
        'assets',
        true,
      );
      expect(response.headers.get('cache-control')).toBe(policy);
      expect(source.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
    },
  );
  it.each([
    ['/assets/app-settings.json', 'application/json'],
    ['/assets/client.js', 'text/javascript'],
    ['/assets/page-abcdefgh.html', 'text/html'],
    ['/assets/client-abcdefgh.js', 'text/html'],
    ['/public/client-abcdefgh.js', 'text/javascript'],
  ])('does not make %s (%s) immutable', (path, contentType) => {
    const source = new Response('asset', {
      headers: {
        'cache-control': 'public, max-age=0, must-revalidate',
        'content-type': contentType,
      },
    });
    expect(
      applyAssetCachePolicy(new Request('https://app.test' + path), source).headers.get(
        'cache-control',
      ),
    ).toBe('public, max-age=0, must-revalidate');
  });
  it('recognizes the configured directory, hash, query and HEAD without overriding cookies', () => {
    const request = new Request('https://app.test/static/chunks/client-EmOhWjz4.js?cache=1', {
      method: 'HEAD',
    });
    const source = new Response(null, {
      headers: { 'cache-control': 'must-revalidate, PUBLIC, max-age=0' },
    });
    expect(
      applyAssetCachePolicy(request, source, '/static/', true).headers.get('cache-control'),
    ).toBe('public, max-age=31536000, immutable');
    expect(source.headers.get('cache-control')).toBe('must-revalidate, PUBLIC, max-age=0');
    const cookie = new Response('asset', { headers: { 'set-cookie': 'local=value; Path=/' } });
    expect(
      applyAssetCachePolicy(request, cookie, 'static', true).headers.get('cache-control'),
    ).toBe('no-store');
  });
  it.each([null, { client: { file: 'assets/client-abcdefgh.js' } }])(
    'uses conservative cache policy without build provenance: %j',
    async (manifest) => {
      const load = vi.fn(async () => manifest);
      const policy = createAssetCachePolicy('assets', load);
      const response = await policy(
        new Request('https://app.test/assets/client-abcdefgh.js'),
        {},
        new Response('asset', {
          headers: { 'cache-control': 'public, max-age=0, must-revalidate' },
        }),
      );
      expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
      await policy(
        new Request('https://app.test/assets/app-settings.json'),
        {},
        new Response('asset'),
      );
      expect(load).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps assets available when optional manifest lookup fails', async () => {
    const policy = createAssetCachePolicy('assets', async () => {
      throw new Error('unavailable');
    });
    const response = await policy(
      new Request('https://app.test/assets/app-settings.json'),
      {},
      new Response('asset'),
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.text()).resolves.toBe('asset');
  });
  it('preserves non-success, redirects and mutation responses', () => {
    for (const source of [
      new Response('missing', { status: 404 }),
      Response.redirect('https://app.test/new', 302),
    ]) {
      expect(
        applyAssetCachePolicy(new Request('https://app.test/assets/client-abcdefgh.js'), source),
      ).toBe(source);
    }
    const source = new Response('post');
    expect(
      applyAssetCachePolicy(
        new Request('https://app.test/assets/client-abcdefgh.js', { method: 'POST' }),
        source,
      ),
    ).toBe(source);
  });
  it('uses fresh requests, skips mutations and preserves intentional responses', async () => {
    const binding = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      return path === '/.vite/manifest.json'
        ? Response.json({
            client: {
              file: 'assets/file-abcdefgh.js',
              immutableFiles: ['assets/file-abcdefgh.js'],
            },
          })
        : new Response(path);
    });
    const serve = createAssetFallback();
    const post = new Request('https://app.test/mutate', { method: 'POST', body: 'body' });
    await post.text();
    const intentional = new Response('missing', { status: 404 });
    expect(await serve(post, { ASSETS: { fetch: binding } }, intentional)).toBe(intentional);
    const success = new Response('application');
    expect(
      await serve(new Request('https://app.test/page'), { ASSETS: { fetch: binding } }, success),
    ).toBe(success);
    expect(binding).not.toHaveBeenCalled();
    const request = new Request('https://app.test/assets/file-abcdefgh.js');
    const asset = await serve(request, { ASSETS: { fetch: binding } }, intentional);
    expect(binding.mock.calls[0][0]).not.toBe(request);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const plain = await serve(
      new Request('https://app.test/file.js'),
      { ASSETS: { fetch: binding } },
      intentional,
    );
    expect(plain.headers.get('cache-control')).toBe('no-store');
  });
});

describe('typed client asset tags', () => {
  it('shares one manifest fetch between concurrent cold loads', async () => {
    const binding = vi.fn(async () => Response.json({ page: { file: 'page.js' } }));
    const loader = createManifestLoader();
    const env = { ASSETS: { fetch: binding } };
    const request = new Request('https://app.test/page');
    const manifests = await Promise.all(Array.from({ length: 8 }, () => loader(request, env)));
    expect(binding).toHaveBeenCalledTimes(1);
    expect(new Set(manifests).size).toBe(1);
    expect(manifests[0]).toEqual({ page: { file: 'page.js' } });
    expect(await loader(request, env)).toBe(manifests[0]);
    expect(binding).toHaveBeenCalledTimes(1);
  });

  it('retries the manifest after a missing response or a rejected fetch', async () => {
    const manifest = { page: { file: 'page.js' } };
    const binding = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockRejectedValueOnce(new Error('assets unavailable'))
      .mockImplementation(async () => Response.json(manifest));
    const loader = createManifestLoader();
    const env = { ASSETS: { fetch: binding } };
    const request = new Request('https://app.test/page');
    expect(await loader(request, env)).toBeNull();
    expect(binding).toHaveBeenCalledTimes(1);
    const rejected = [loader(request, env), loader(request, env)];
    await expect(rejected[0]).rejects.toThrow('assets unavailable');
    await expect(rejected[1]).rejects.toThrow('assets unavailable');
    expect(binding).toHaveBeenCalledTimes(2);
    expect(await loader(request, env)).toEqual(manifest);
    expect(binding).toHaveBeenCalledTimes(3);
    await loader(request, env);
    expect(binding).toHaveBeenCalledTimes(3);
  });
});

describe('static asset marker', () => {
  const policy = 'public, max-age=0, must-revalidate';
  const env = {
    ASSETS: {
      fetch: async (request: Request) =>
        ['/favicon.ico', '/assets/client-abcdefgh.js'].includes(new URL(request.url).pathname)
          ? new Response('file', { headers: { 'cache-control': policy } })
          : new Response('missing', { status: 404 }),
    },
  };
  const fallbackRules = [{ source: '/old', destination: '/new', status: 200 }];

  function markerApp(withAssets: boolean) {
    const app = new Hono();
    const routing = createRoutingRuntime(app);
    const seen: Array<unknown> = [];
    app.use(routing.contextMiddleware);
    app.use(async (c, next) => {
      await next();
      seen.push((c as unknown as { get(key: string): unknown }).get('__platformStaticAsset'));
    });
    app.get('/new', (c) => c.text('fallback rule'));
    app.notFound(createAssetNotFound({ routing, fallbackRules }));
    const fetch = (path: string) =>
      app.fetch(new Request('https://app.test' + path), withAssets ? env : {}, context);
    return { fetch, seen };
  }

  it('marks only ASSETS hits from the asset fallback', async () => {
    const { fetch, seen } = markerApp(true);
    for (const path of ['/favicon.ico', '/assets/client-abcdefgh.js']) {
      const response = await fetch(path);
      expect(response.status).toBe(200);
      expect(seen.pop()).toMatchObject({ policy: response.headers.get('cache-control') });
    }
    for (const path of ['/missing', '/old']) {
      await fetch(path);
      expect(seen.pop(), path).toBeUndefined();
    }
  });

  it('does not mark responses without an ASSETS binding', async () => {
    const { fetch, seen } = markerApp(false);
    await fetch('/favicon.ico');
    expect(seen.pop()).toBeUndefined();
  });
});

describe('native HTTPS policy', () => {
  it('redirects HTTP before the app, keeping path, query and method', async () => {
    const app = { fetch: vi.fn(async () => new Response('app')) };
    const fetch = worker({ alwaysUseHttps: true, app });
    const response = await fetch(
      new Request('http://oxc.rs/docs?q=1', { method: 'POST' }),
      {},
      context,
    );
    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://oxc.rs/docs?q=1');
    expect(app.fetch).not.toHaveBeenCalled();
    const upgrade = await fetch(
      new Request('http://oxc.rs/chat', { headers: { upgrade: 'websocket' } }),
      {},
      context,
    );
    expect(upgrade.status).toBe(308);
  });

  it('answers bwf endpoints for tools and the platform over HTTP', async () => {
    const fetch = worker({
      alwaysUseHttps: true,
      emailReceipt: async () => new Response('receipt', { status: 202 }),
      internalRoute: async (request) =>
        new URL(request.url).pathname === '/__platform/migrate' ? new Response('migrated') : null,
    });
    const ready = await fetch(new Request('http://oxc.rs/__platform/ready'), {}, context);
    expect(await ready.json()).toEqual({ ready: true });
    const receipt = await fetch(
      new Request('http://oxc.rs/__platform/email/receipt/v1', { method: 'POST' }),
      {},
      context,
    );
    expect(receipt.status).toBe(202);
    const migrate = await fetch(
      new Request('http://oxc.rs/__platform/migrate', { method: 'POST' }),
      {},
      context,
    );
    expect(await migrate.text()).toBe('migrated');
  });
});
