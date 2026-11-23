import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Env } from '../../src/env.ts';
import app, { rebuildRequest } from '../../src/index.ts';
import { PLATFORM_DISABLED_KEY } from '../../src/platform-lifecycle.ts';
import {
  SHARED_CACHE_POLICY_HEADER,
  SHARED_CACHE_POLICY_VERSION,
  markSharedCachePolicy,
} from '../../src/shared-cache.ts';

const edgeCacheStore = new Map<string, Response>();

vi.stubGlobal('caches', {
  default: {
    match: async (req: Request) => {
      const res = edgeCacheStore.get(req.url);
      return res ? res.clone() : undefined;
    },
    put: async (req: Request, res: Response) => {
      edgeCacheStore.set(req.url, res.clone());
    },
    delete: async (req: Request) => {
      return edgeCacheStore.delete(req.url);
    },
  },
});

beforeEach(() => {
  edgeCacheStore.clear();
});

type RoutingEntry = {
  workerName: string;
  projectId: string;
  userId?: string;
  type?: 'platform' | 'spa' | 'static' | 'framework';
  ssr?: boolean;
  revalidate?: number | Record<string, number>;
  pages?: ReadonlyArray<{ pattern: string; revalidate?: number }>;
  pathRevalidate?: Record<string, number>;
  version?: string;
  limits?: Record<string, number>;
  suspended?: string;
  hashedAssetsPrefix?: string;
  staticDeploymentId?: string;
  assetManifestId?: string;
  assetConfig?: {
    not_found_handling?: 'none' | 'single-page-application' | '404-page';
    html_handling?: 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none';
    run_worker_first?: boolean | Array<string>;
  };
  headerRules?: Array<{ pattern: string; headers: Array<[string, string]> }>;
  redirectRules?: Array<{ source: string; destination: string; status: number; host?: string }>;
  fallbackRules?: Array<{ source: string; destination: string; status: number; host?: string }>;
  queryAllowlist?: Record<string, Array<string>>;
  zeroTrust?: {
    teamDomain: string;
    audiences: Array<{ hostname: string; audience: string }>;
  };
};

function createCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function currentSharedCacheResponse(response: Response): Response {
  markSharedCachePolicy(response.headers);
  return response;
}

type MockIsrEntry = {
  body: string;
  status?: number;
  createdAt: number;
  ttl: number;
  headers?: Record<string, string>;
};

function packMockEntry(entry: MockIsrEntry): {
  value: ArrayBuffer;
  metadata: { s: number; c: number; t: number; p: typeof SHARED_CACHE_POLICY_VERSION };
} {
  const headers = entry.headers ?? {};
  const headerJson = new TextEncoder().encode(JSON.stringify(headers));
  const bodyBytes = new TextEncoder().encode(entry.body);
  const buffer = new ArrayBuffer(4 + headerJson.byteLength + bodyBytes.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerJson.byteLength, true);
  new Uint8Array(buffer, 4, headerJson.byteLength).set(headerJson);
  new Uint8Array(buffer, 4 + headerJson.byteLength).set(bodyBytes);
  return {
    value: buffer,
    metadata: {
      s: entry.status ?? 200,
      c: entry.createdAt,
      t: entry.ttl,
      p: SHARED_CACHE_POLICY_VERSION,
    },
  };
}

function createEnv(options: {
  routing: RoutingEntry;
  assets?: Record<string, MockIsrEntry>;
  assetManifest?: Record<string, string>;
  workerResponse?: Response;
  workerFetchImpl?: () => Promise<Response>;
}): {
  env: Env;
  workerFetch: ReturnType<typeof vi.fn>;
  dispatchGet: ReturnType<typeof vi.fn>;
  kvStore: Map<
    string,
    {
      value: ArrayBuffer;
      metadata: { s: number; c: number; t: number; p: typeof SHARED_CACHE_POLICY_VERSION };
    }
  >;
  analyticsWrites: Array<unknown>;
  logWrites: Array<unknown>;
} {
  const workerFetch = vi.fn(
    async () => options.workerFetchImpl?.() ?? options.workerResponse ?? new Response('worker'),
  );
  const kvStore = new Map<
    string,
    {
      value: ArrayBuffer;
      metadata: { s: number; c: number; t: number; p: typeof SHARED_CACHE_POLICY_VERSION };
    }
  >();
  const analyticsWrites: Array<unknown> = [];
  const logWrites: Array<unknown> = [];

  if (options.assets) {
    for (const [key, entry] of Object.entries(options.assets)) {
      kvStore.set(key, packMockEntry(entry));
    }
  }

  const dispatchGet = vi.fn(() => ({ fetch: workerFetch }));

  const env = {
    ROUTING: {
      get: async (key: string) =>
        key.startsWith('manifest:')
          ? JSON.stringify(options.assetManifest ?? {})
          : JSON.stringify(options.routing),
    },
    DISPATCH: {
      get: dispatchGet,
    },
    STATIC_ASSETS_R2: {
      get: async (key: string) => {
        const entry = kvStore.get(key.slice('isr-cache/'.length));
        if (!entry) {
          return null;
        }
        return {
          arrayBuffer: async () => entry.value,
          customMetadata: { isr: JSON.stringify(entry.metadata) },
        };
      },
      put: async (key: string, value: ArrayBuffer, opts: { customMetadata: { isr: string } }) => {
        kvStore.set(key.slice('isr-cache/'.length), {
          value,
          metadata: JSON.parse(opts.customMetadata.isr),
        });
      },
      delete: async (key: string) => {
        kvStore.delete(key.slice('isr-cache/'.length));
      },
      list: async (opts: { prefix: string; limit?: number }) => {
        const all = [...kvStore.keys()]
          .map((key) => `isr-cache/${key}`)
          .filter((key) => key.startsWith(opts.prefix))
          .sort();
        const limit = opts.limit ?? 1000;
        const slice = all.slice(0, limit);
        return {
          objects: slice.map((key) => ({ key })),
          truncated: slice.length !== all.length,
          cursor: '',
        };
      },
    },
    ISR_CACHE: { delete: async () => {} },
    ANALYTICS: {
      writeDataPoint: (data: unknown) => analyticsWrites.push(data),
    },
    LOGS: {
      writeDataPoint: (data: unknown) => logWrites.push(data),
    },
  } as unknown as Env;

  return { env, workerFetch, dispatchGet, kvStore, analyticsWrites, logWrites };
}

describe('dispatch fetch handler', () => {
  it('fails closed before dispatch when a protected route has no Access assertion', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        zeroTrust: {
          teamDomain: 'https://company.cloudflareaccess.com',
          audiences: [{ hostname: '*.void.app', audience: 'project-audience' }],
        },
      },
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/private'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('forwards /api requests to user worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('api'),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/hello', { method: 'GET' }),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('api');
  });

  it('meters websocket upgrade requests as websocket while forwarding them', async () => {
    const { env, workerFetch, analyticsWrites } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('switching', { status: 200 }),
    });

    const request = new Request('https://my-app.void.app/chat/general', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    const response = await app.fetch(request, env, createCtx());

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(workerFetch.mock.calls[0]?.[0].headers.get('upgrade')).toBe('websocket');
    expect((analyticsWrites[0] as { blobs: Array<string> }).blobs[1]).toBe('websocket');
    expect(response.headers.get('X-Hosted-By')).toBe('void.cloud');
  });

  it('dispatches SSR requests to worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true },
      workerResponse: new Response('<html>ssr</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('<html>ssr</html>');
  });

  it('dispatches non-SSR requests to worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('ok');
  });

  it('handles POST request with already-consumed body without throwing', async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('ok'),
    });

    const request = new Request('https://my-app.void.app/xmlrpc.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      body: 'payload',
    });
    await request.text();
    expect(request.bodyUsed).toBe(true);

    const response = await app.fetch(request, env, createCtx());

    expect(workerFetch).toHaveBeenCalledOnce();
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.method).toBe('POST');
    expect(forwarded.bodyUsed).toBe(false);
    expect(forwarded.headers.has('content-length')).toBe(false);
    expect(forwarded.headers.has('transfer-encoding')).toBe(false);
    expect(await response.text()).toBe('ok');
  });
});

// Decision: Node's Request doesn't accept `cf` in init, so the test can't read it off the result. It wraps
// globalThis.Request and checks the constructor gets `cf` in its init.
describe('rebuildRequest preserves request.cf', () => {
  let RequestCalls: Array<{ url: unknown; init: RequestInit | undefined }>;
  const OriginalRequest = globalThis.Request;

  beforeEach(() => {
    RequestCalls = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Request = class extends OriginalRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        // Decision: `cf` is removed before delegating because Node would reject it.
        RequestCalls.push({ url: input, init });
        const cleaned = init ? { ...init } : undefined;
        if (cleaned && 'cf' in cleaned) {
          delete (cleaned as { cf?: unknown }).cf;
        }
        super(input, cleaned);
      }
    };
  });

  afterEach(() => {
    globalThis.Request = OriginalRequest;
  });

  function withCf<T extends Request>(req: T, cf: unknown): T {
    Object.defineProperty(req, 'cf', { value: cf, configurable: true, enumerable: true });
    return req;
  }

  it('forwards cf when rebuilding a GET (no body)', () => {
    const cf = { country: 'US', colo: 'SFO', botManagement: { score: 99 } };
    const src = withCf(new OriginalRequest('https://my-app.void.app/old'), cf);

    const out = rebuildRequest(src, 'https://my-app.void.app/new', () => {});

    expect(out).toBeInstanceOf(OriginalRequest);
    const last = RequestCalls.at(-1)!;
    expect(last.url).toBe('https://my-app.void.app/new');
    expect((last.init as { cf?: unknown } | undefined)?.cf).toBe(cf);
  });

  it('forwards cf when rebuilding a POST with streaming body', () => {
    const cf = { country: 'DE' };
    const src = withCf(
      new OriginalRequest('https://my-app.void.app/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'payload',
      }),
      cf,
    );

    rebuildRequest(src, 'https://my-app.void.app/y', () => {});

    const last = RequestCalls.at(-1)!;
    expect((last.init as { cf?: unknown } | undefined)?.cf).toBe(cf);
  });

  it('forwards cf when the body is already consumed (drop-body branch)', async () => {
    const cf = { country: 'JP' };
    const src = withCf(
      new OriginalRequest('https://my-app.void.app/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'payload',
      }),
      cf,
    );
    await src.text();
    expect(src.bodyUsed).toBe(true);

    rebuildRequest(src, 'https://my-app.void.app/y', () => {});

    const last = RequestCalls.at(-1)!;
    expect((last.init as { cf?: unknown } | undefined)?.cf).toBe(cf);
  });
});

describe('custom domain routing', () => {
  it('routes custom domain via domain: KV key', async () => {
    const workerFetch = vi.fn(async () => new Response('custom-domain-api'));
    const routing: RoutingEntry = { workerName: 'user-app', projectId: 'proj_1' };

    const env = {
      ROUTING: {
        get: async (key: string) => {
          if (key === 'domain:app.example.com') {
            return JSON.stringify(routing);
          }
          return null;
        },
      },
      DISPATCH: {
        get: () => ({ fetch: workerFetch }),
      },
      ISR_CACHE: {
        getWithMetadata: async () => ({ value: null, metadata: null }),
      },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const response = await app.fetch(
      new Request('https://app.example.com/api/hello'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('custom-domain-api');
  });

  it('returns 404 for unknown hostname', async () => {
    const env = {
      ROUTING: {
        get: async () => null,
      },
      DISPATCH: {
        get: () => ({ fetch: vi.fn() }),
      },
      ISR_CACHE: {
        getWithMetadata: async () => ({ value: null, metadata: null }),
      },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const response = await app.fetch(new Request('https://unknown.example.com/'), env, createCtx());

    expect(response.status).toBe(404);
  });
});

describe('suspension check', () => {
  it('returns 429 when project is suspended', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        suspended: 'requests_exceeded',
      },
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/hello'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      code: 'usage_limit',
      resource: 'requests',
      reason: 'monthly_quota',
    });
  });
});

describe('custom limits', () => {
  it('passes limits to DISPATCH.get for API routes', async () => {
    const { env, dispatchGet } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        limits: { cpuMs: 10, subRequests: 50 },
      },
      workerResponse: new Response('api'),
    });

    await app.fetch(new Request('https://my-app.void.app/api/hello'), env, createCtx());

    expect(dispatchGet).toHaveBeenCalledWith(
      'user-app',
      {},
      { limits: { cpuMs: 10, subRequests: 50 } },
    );
  });

  it('does not pass limits when routing has no limits', async () => {
    const { env, dispatchGet } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('api'),
    });

    await app.fetch(new Request('https://my-app.void.app/api/hello'), env, createCtx());

    expect(dispatchGet).toHaveBeenCalledWith('user-app');
  });

  it('returns 429 when worker exceeds CPU limit', async () => {
    const workerFetch = vi.fn(async () => {
      throw new Error('Worker exceeded CPU time limit');
    });
    const dispatchGet = vi.fn(() => ({ fetch: workerFetch }));

    const env = {
      ROUTING: {
        get: async () =>
          JSON.stringify({
            workerName: 'user-app',
            projectId: 'proj_1',
            limits: { cpuMs: 10 },
          }),
      },
      DISPATCH: { get: dispatchGet },
      ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/hello'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      code: 'usage_limit',
      resource: 'execution',
      reason: 'cpu',
    });
  });

  it('passes limits to DISPATCH.get for SSR routes', async () => {
    const { env, dispatchGet } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        limits: { cpuMs: 30, subRequests: 50 },
      },
      workerResponse: new Response('<html>ssr</html>'),
    });

    await app.fetch(new Request('https://my-app.void.app/dashboard'), env, createCtx());

    expect(dispatchGet).toHaveBeenCalledWith(
      'user-app',
      {},
      { limits: { cpuMs: 30, subRequests: 50 } },
    );
  });
});

describe('hashed asset caching', () => {
  it('serves hashed asset from edge cache on hit', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();

    const url = 'https://test.void.app/assets/main-abc123.js';

    const res1 = await app.fetch(new Request(url), env, ctx);
    expect(res1.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    expect(res1.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    const res2 = await app.fetch(new Request(url), env, ctx2);
    expect(res2.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('does not serve one project cached asset to the next project on the same host', async () => {
    const url = 'https://test.void.app/assets/main-abc123.js';
    const previous = createEnv({
      routing: { workerName: 'old-worker', projectId: 'proj-old', hashedAssetsPrefix: 'assets' },
      workerResponse: new Response('evil'),
    });
    const previousCtx = createCtx();
    expect(await (await app.fetch(new Request(url), previous.env, previousCtx)).text()).toBe(
      'evil',
    );
    await Promise.all(
      (previousCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    );
    expect(edgeCacheStore.size).toBe(1);

    const next = createEnv({
      routing: { workerName: 'new-worker', projectId: 'proj-new', hashedAssetsPrefix: 'assets' },
      workerResponse: new Response('fresh'),
    });
    const res = await app.fetch(new Request(url), next.env, createCtx());
    expect(await res.text()).toBe('fresh');
    expect(next.workerFetch).toHaveBeenCalledOnce();
  });

  it('replaces an unmarked legacy hashed body instead of serving it', async () => {
    edgeCacheStore.set(
      'https://test.void.app/assets/stale.js?_p=proj-1',
      new Response('user-alice', {
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
      }),
    );

    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('fresh') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/stale.js'), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('fresh');
    expect(workerFetch).toHaveBeenCalledTimes(1);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const replacement = edgeCacheStore.get('https://test.void.app/assets/stale.js?_p=proj-1');
    expect(replacement?.headers.get(SHARED_CACHE_POLICY_HEADER)).toBe(
      String(SHARED_CACHE_POLICY_VERSION),
    );
    expect(await replacement?.clone().text()).toBe('fresh');
  });

  it('does not cache non-hashed asset paths without version', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('page') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/about'), env, ctx);
    expect(res.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/about'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('skips cache for non-GET requests to hashed paths', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    const res = await app.fetch(
      new Request('https://test.void.app/assets/main.js', { method: 'POST' }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    expect(edgeCacheStore.size).toBe(0);
  });

  it('does not cache non-ok worker responses', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env } = createEnv({
      routing,
      workerResponse: new Response('not found', { status: 404 }),
    });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/missing.js'), env, ctx);
    expect(res.status).toBe(404);
    expect(edgeCacheStore.size).toBe(0);
  });

  it('skips caching when hashedAssetsPrefix is not set', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/assets/main.js'), env, ctx);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/assets/main.js'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('works with custom prefix like _nuxt', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: '_nuxt',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('nuxt-asset') });
    const ctx = createCtx();

    const res = await app.fetch(
      new Request('https://test.void.app/_nuxt/entry.abc123.js'),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('keys cache on post-rewrite hashed URL when a redirect rule rewrites into the hashed prefix', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      redirectRules: [{ source: '/logo', destination: '/assets/logo-abc123.png', status: 200 }],
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/logo'), env, ctx);
    expect(res.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    expect(edgeCacheStore.has('https://test.void.app/assets/logo-abc123.png?_p=proj-1')).toBe(true);
    expect(edgeCacheStore.has('https://test.void.app/logo?_p=proj-1')).toBe(false);
  });

  it('normalizes query strings for cache key', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();

    const res1 = await app.fetch(
      new Request('https://test.void.app/assets/main-abc.js?v=1'),
      env,
      ctx,
    );
    expect(res1.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    const res2 = await app.fetch(
      new Request('https://test.void.app/assets/main-abc.js?v=2'),
      env,
      ctx2,
    );
    expect(res2.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('does not share a hashed-path response that sets a cookie', async () => {
    let render = 0;
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        hashedAssetsPrefix: 'assets',
      },
      workerFetchImpl: async () => {
        render++;
        return new Response(`user-${render}`, {
          headers: { 'Set-Cookie': `sid=user-${render}; Path=/; HttpOnly` },
        });
      },
    });
    const url = 'https://test.void.app/assets/session-abc.json';

    const firstCtx = createCtx();
    const first = await app.fetch(new Request(url), env, firstCtx);
    expect(await first.text()).toBe('user-1');
    expect(first.headers.get('Set-Cookie')).toContain('sid=user-1');
    await Promise.all((firstCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const second = await app.fetch(new Request(url), env, createCtx());
    expect(await second.text()).toBe('user-2');
    expect(second.headers.get('Set-Cookie')).toContain('sid=user-2');
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(edgeCacheStore.has(`${url}?_p=proj-1`)).toBe(false);
  });

  it('keeps credentialed hashed-path responses private without response opt-out headers', async () => {
    let render = 0;
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        hashedAssetsPrefix: 'assets',
      },
      workerFetchImpl: async () => new Response(`user-${++render}`),
    });
    const url = 'https://test.void.app/assets/session-abc.json';

    const firstCtx = createCtx();
    const first = await app.fetch(
      new Request(url, { headers: { Cookie: 'session=alice' } }),
      env,
      firstCtx,
    );
    expect(await first.text()).toBe('user-1');
    await Promise.all((firstCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const secondCtx = createCtx();
    const second = await app.fetch(
      new Request(url, { headers: { Cookie: 'session=bob' } }),
      env,
      secondCtx,
    );
    expect(await second.text()).toBe('user-2');
    expect(workerFetch.mock.calls[0]?.[0].headers.get('Cookie')).toBe('session=alice');
    expect(workerFetch.mock.calls[1]?.[0].headers.get('Cookie')).toBe('session=bob');
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(edgeCacheStore.has(`${url}?_p=proj-1`)).toBe(false);
  });

  it.each([
    ['Authorization', 'Bearer alice'],
    ['Accept', 'text/event-stream'],
  ])('bypasses hashed cache for %s requests', async (header, value) => {
    const url = 'https://test.void.app/assets/session-abc.json';
    const currentEntry = currentSharedCacheResponse(
      new Response('cached-user', {
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
      }),
    );
    edgeCacheStore.set(`${url}?_p=proj-1`, currentEntry);
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        hashedAssetsPrefix: 'assets',
      },
      workerResponse: new Response('live-user'),
    });

    const response = await app.fetch(
      new Request(url, { headers: { [header]: value } }),
      env,
      createCtx(),
    );

    expect(await response.text()).toBe('live-user');
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await edgeCacheStore.get(`${url}?_p=proj-1`)?.clone().text()).toBe('cached-user');
  });

  it('returns 429 when worker exceeds CPU limit', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env } = createEnv({ routing, workerResponse: new Response('ok') });
    const dispatchGet = env.DISPATCH.get as ReturnType<typeof vi.fn>;
    dispatchGet.mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error('Worker exceeded CPU time limit')),
    });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/main-abc.js'), env, ctx);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      code: 'usage_limit',
      resource: 'execution',
      reason: 'cpu',
    });
  });
});

describe('header rules', () => {
  it('applies header rules to worker responses', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      headerRules: [
        { pattern: '/*', headers: [['X-Frame-Options', 'DENY']] },
        {
          pattern: '/assets/*',
          headers: [['Cache-Control', 'public, max-age=31536000, immutable']],
        },
      ],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/app.js'), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('applies header rules to hashed assets on cache miss and cache hit', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      headerRules: [{ pattern: '/*', headers: [['X-Custom', 'from-rules']] }],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();

    const res1 = await app.fetch(new Request('https://test.void.app/assets/main-abc.js'), env, ctx);
    expect(res1.status).toBe(200);
    expect(res1.headers.get('X-Custom')).toBe('from-rules');
    expect(res1.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    const res2 = await app.fetch(
      new Request('https://test.void.app/assets/main-abc.js'),
      env,
      ctx2,
    );
    expect(res2.status).toBe(200);
    expect(res2.headers.get('X-Custom')).toBe('from-rules');
    expect(res2.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('applies COOP/COEP/CORP to a hashed worker asset across a cache hit (cross-origin isolation)', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      headerRules: [
        {
          pattern: '/assets/*',
          headers: [
            ['Cross-Origin-Embedder-Policy', 'require-corp'],
            ['Cross-Origin-Resource-Policy', 'same-origin'],
          ],
        },
      ],
    };
    const { env, workerFetch } = createEnv({
      routing,
      workerResponse: new Response('worker-bytes'),
    });
    const ctx = createCtx();
    const url = 'https://test.void.app/assets/worker-D2vJiay4.js';

    const miss = await app.fetch(new Request(url), env, ctx);
    expect(miss.status).toBe(200);
    expect(miss.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(miss.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    const hit = await app.fetch(new Request(url), env, ctx2);
    expect(hit.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    expect(hit.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(hit.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  it('keeps platform immutable Cache-Control on hashed assets when a rule overrides it', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      headerRules: [
        {
          pattern: '/*',
          headers: [
            ['Cache-Control', 'no-store'],
            ['X-Custom', 'from-rules'],
          ],
        },
      ],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();
    const url = 'https://test.void.app/assets/main-abc.js';

    const miss = await app.fetch(new Request(url), env, ctx);
    expect(miss.status).toBe(200);
    expect(miss.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(miss.headers.get('X-Custom')).toBe('from-rules');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    const hit = await app.fetch(new Request(url), env, ctx2);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(hit.headers.get('X-Custom')).toBe('from-rules');
  });

  it('does not let a rule forge Content-Length on hashed assets (metering integrity)', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      headerRules: [{ pattern: '/*', headers: [['Content-Length', '0']] }],
    };
    const { env } = createEnv({
      routing,
      workerResponse: new Response('asset-body', { headers: { 'Content-Length': '10' } }),
    });
    const ctx = createCtx();
    const url = 'https://test.void.app/assets/main-abc.js';

    const res = await app.fetch(new Request(url), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).not.toBe('0');
    expect(await res.text()).toBe('asset-body');
  });

  it('keeps platform representation headers on hashed assets when a rule overrides them', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      headerRules: [
        {
          pattern: '/*',
          headers: [
            ['Content-Type', 'text/plain'],
            ['Content-Encoding', 'gzip'],
            ['Cross-Origin-Embedder-Policy', 'require-corp'],
          ],
        },
      ],
    };
    const { env } = createEnv({
      routing,
      workerResponse: new Response('asset-body', {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
      }),
    });
    const ctx = createCtx();
    const url = 'https://test.void.app/assets/main-abc.js';

    const miss = await app.fetch(new Request(url), env, ctx);
    expect(miss.status).toBe(200);
    expect(miss.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(miss.headers.get('Content-Encoding')).toBeNull();
    expect(miss.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    const hit = await app.fetch(new Request(url), env, ctx2);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(hit.headers.get('Content-Encoding')).toBeNull();
    expect(hit.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });

  it('strips the Clear-Site-Data cookies directive on hashed assets (cross-tenant cookie boundary)', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      headerRules: [
        {
          pattern: '/assets/*',
          headers: [
            ['Clear-Site-Data', '"cookies"'],
            ['Cross-Origin-Embedder-Policy', 'require-corp'],
          ],
        },
      ],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();
    const url = 'https://test.void.app/assets/main-abc.js';

    const miss = await app.fetch(new Request(url), env, ctx);
    expect(miss.status).toBe(200);
    expect(miss.headers.get('Clear-Site-Data')).toBeNull();
    expect(miss.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    const hit = await app.fetch(new Request(url), env, ctx2);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('Clear-Site-Data')).toBeNull();
    expect(hit.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });

  it('last-match-wins for overlapping patterns', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      headerRules: [
        { pattern: '/*', headers: [['Cache-Control', 'no-cache']] },
        { pattern: '/assets/*', headers: [['Cache-Control', 'immutable']] },
      ],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/app.js'), env, ctx);
    expect(res.headers.get('Cache-Control')).toBe('immutable');
  });
});

describe('queue relay', () => {
  type MockMessage = {
    id: string;
    timestamp: Date;
    body: unknown;
    attempts: number;
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };

  function createMockBatch(
    queue: string,
    messages: Array<{ id: string; body: unknown; attempts?: number }>,
  ) {
    const msgs: Array<MockMessage> = messages.map((m) => ({
      id: m.id,
      timestamp: new Date('2026-01-15T12:00:00Z'),
      body: m.body,
      attempts: m.attempts ?? 1,
      ack: vi.fn(),
      retry: vi.fn(),
    }));
    return {
      queue,
      messages: msgs,
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch & {
      ackAll: ReturnType<typeof vi.fn>;
      retryAll: ReturnType<typeof vi.fn>;
      messages: Array<MockMessage>;
    };
  }

  function createQueueEnv(options: {
    routingRaw?: string | null;
    workerResponse?: Response;
    workerFetchImpl?: () => Promise<Response>;
    installationId?: string;
    trafficState?: string;
    lifecycleValue?: string | null;
    lifecycleError?: Error;
    suspendedProjects?: Array<string>;
    markerError?: Error;
  }) {
    const workerFetch = vi.fn(
      async (_req: Request) =>
        options.workerFetchImpl?.() ?? options.workerResponse ?? new Response('ok'),
    );
    const routingGet = vi.fn(async (key: string) => {
      if (key === PLATFORM_DISABLED_KEY) {
        if (options.lifecycleError) {
          throw options.lifecycleError;
        }
        return options.lifecycleValue ?? null;
      }
      if (key.startsWith('project-suspended:')) {
        if (options.markerError) {
          throw options.markerError;
        }
        const projectId = key.slice('project-suspended:'.length);
        return options.suspendedProjects?.includes(projectId) ? 'operator_review' : null;
      }
      return options.routingRaw ?? null;
    });
    const dispatchGet = vi.fn(() => ({ fetch: workerFetch }));
    return {
      env: {
        ROUTING: { get: routingGet },
        DISPATCH: { get: dispatchGet },
        ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
        ANALYTICS: { writeDataPoint: () => {} },
        ...(options.installationId ? { PLATFORM_INSTALLATION_ID: options.installationId } : {}),
        ...(options.trafficState ? { PLATFORM_TRAFFIC_STATE: options.trafficState } : {}),
      } as unknown as Env,
      dispatchGet,
      routingGet,
      workerFetch,
    };
  }

  it('retries without routing to an app while a self-hosted platform is disabled', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, dispatchGet, routingGet } = createQueueEnv({
      routingRaw: routing,
      installationId: 'installation-id',
      lifecycleValue: 'disabled',
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await app.queue(batch, env);

      expect(routingGet).toHaveBeenCalledOnce();
      expect(routingGet).toHaveBeenCalledWith(PLATFORM_DISABLED_KEY);
      expect(dispatchGet).not.toHaveBeenCalled();
      expect(batch.retryAll).toHaveBeenCalledWith({ delaySeconds: 300 });
      expect(batch.ackAll).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it.each(['staging', 'sandbox-drain'])(
    'retries %s batches without reading unavailable routing KV',
    async (trafficState) => {
      const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
      const { env, dispatchGet, routingGet } = createQueueEnv({
        installationId: 'installation-id',
        trafficState,
      });
      routingGet.mockRejectedValue(new Error('routing unavailable'));
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await app.queue(batch, env);

        expect(routingGet).not.toHaveBeenCalled();
        expect(dispatchGet).not.toHaveBeenCalled();
        expect(batch.retryAll).toHaveBeenCalledWith({ delaySeconds: 300 });
      } finally {
        warning.mockRestore();
      }
    },
  );

  it('relays batches after the self-hosted traffic gate is enabled', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, routingGet, workerFetch } = createQueueEnv({
      routingRaw: routing,
      installationId: 'installation-id',
      lifecycleValue: null,
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    expect(routingGet).toHaveBeenNthCalledWith(1, PLATFORM_DISABLED_KEY);
    expect(routingGet).toHaveBeenNthCalledWith(2, 'queue:test-queue', { cacheTtl: 60 });
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(batch.ackAll).toHaveBeenCalledOnce();
  });

  it('keeps hosted queue relay free of self-hosted lifecycle reads', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, routingGet, workerFetch } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    expect(routingGet).toHaveBeenCalledOnce();
    expect(routingGet).toHaveBeenCalledWith('queue:test-queue', { cacheTtl: 60 });
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it('fails closed when the self-hosted traffic gate cannot be read', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, dispatchGet, routingGet } = createQueueEnv({
      routingRaw: routing,
      installationId: 'installation-id',
      lifecycleError: new Error('routing unavailable'),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await app.queue(batch, env);

      expect(routingGet).toHaveBeenCalledOnce();
      expect(routingGet).toHaveBeenCalledWith(PLATFORM_DISABLED_KEY);
      expect(dispatchGet).not.toHaveBeenCalled();
      expect(batch.retryAll).toHaveBeenCalledWith({ delaySeconds: 300 });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('traffic gate read failed'));
    } finally {
      error.mockRestore();
    }
  });

  it('retries all when routing entry is missing', async () => {
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({ routingRaw: null });

    await app.queue(batch, env);

    expect(batch.retryAll).toHaveBeenCalledOnce();
    expect(batch.ackAll).not.toHaveBeenCalled();
  });

  it("holds a suspended project's batch without invoking its worker", async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'p1',
      queueName: 'emails',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, dispatchGet } = createQueueEnv({
      routingRaw: routing,
      suspendedProjects: ['p1'],
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await app.queue(batch, env);
    } finally {
      warning.mockRestore();
    }

    expect(dispatchGet).not.toHaveBeenCalled();
    expect(batch.retryAll).toHaveBeenCalledWith({ delaySeconds: 3600 });
    expect(batch.ackAll).not.toHaveBeenCalled();
  });

  it('relays batches of projects without a suspension marker', async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'p2',
      queueName: 'emails',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, routingGet, workerFetch } = createQueueEnv({
      routingRaw: routing,
      suspendedProjects: ['p1'],
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    expect(routingGet).toHaveBeenCalledWith('project-suspended:p2', { cacheTtl: 60 });
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(batch.ackAll).toHaveBeenCalledOnce();
  });

  it('relays when the suspension marker cannot be read', async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'p3',
      queueName: 'emails',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, workerFetch } = createQueueEnv({
      routingRaw: routing,
      markerError: new Error('routing unavailable'),
      workerResponse: Response.json({ ok: true }),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await app.queue(batch, env);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('suspension check failed'),
        expect.any(Error),
      );
    } finally {
      error.mockRestore();
    }

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(batch.ackAll).toHaveBeenCalledOnce();
  });

  it('acks all on legacy protocol (ok: true, no decisions)', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    expect(batch.ackAll).toHaveBeenCalledOnce();
    expect(batch.retryAll).not.toHaveBeenCalled();
  });

  it('retries all on legacy protocol (ok: false)', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({ ok: false }),
    });

    await app.queue(batch, env);

    expect(batch.retryAll).toHaveBeenCalledOnce();
    expect(batch.ackAll).not.toHaveBeenCalled();
  });

  it('applies per-message decisions correctly', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [
      { id: 'm1', body: 'ack-me' },
      { id: 'm2', body: 'retry-me' },
      { id: 'm3', body: 'no-decision' },
    ]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({
        ok: true,
        decisions: {
          m1: { action: 'ack' },
          m2: { action: 'retry' },
        },
      }),
    });

    await app.queue(batch, env);

    expect(batch.messages[0].ack).toHaveBeenCalledOnce();
    expect(batch.messages[1].retry).toHaveBeenCalledWith(undefined);
    expect(batch.messages[2].ack).not.toHaveBeenCalled();
    expect(batch.messages[2].retry).not.toHaveBeenCalled();
  });

  it('passes delaySeconds through on retry decisions', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'retry-me' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({
        ok: true,
        decisions: {
          m1: { action: 'retry', delaySeconds: 30 },
        },
      }),
    });

    await app.queue(batch, env);

    expect(batch.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it('retries all undecided messages when handler fails (ok: false)', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [
      { id: 'm1', body: 'acked' },
      { id: 'm2', body: 'undecided' },
    ]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({
        ok: false,
        decisions: {
          m1: { action: 'ack' },
        },
      }),
    });

    await app.queue(batch, env);

    expect(batch.messages[0].ack).toHaveBeenCalledOnce();
    expect(batch.retryAll).toHaveBeenCalledOnce();
  });

  it('retries all on network error', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerFetchImpl: () => Promise.reject(new Error('network error')),
    });

    await app.queue(batch, env);

    expect(batch.retryAll).toHaveBeenCalledOnce();
  });

  it('retries all on non-ok HTTP response', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: new Response('Internal Server Error', { status: 500 }),
    });

    await app.queue(batch, env);

    expect(batch.retryAll).toHaveBeenCalledOnce();
  });

  it('acks all on non-JSON 2xx response (legacy framework)', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: new Response('OK', { status: 200 }),
    });

    await app.queue(batch, env);

    expect(batch.ackAll).toHaveBeenCalledOnce();
  });

  it('forwards x-platform-internal header to user worker when proxyToken is in routing entry', async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'proj-1',
      queueName: 'emails',
      proxyToken: 'super-secret-token',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, workerFetch } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    expect(workerFetch).toHaveBeenCalledOnce();
    const req = workerFetch.mock.calls[0][0] as Request;
    expect(req.headers.get('x-platform-internal')).toBe('super-secret-token');
  });

  it('omits x-platform-internal header when proxyToken is missing (backward-compat)', async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'proj-1',
      queueName: 'emails',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, workerFetch } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    const req = workerFetch.mock.calls[0][0] as Request;
    expect(req.headers.get('x-platform-internal')).toBeNull();
  });

  it('logs a structured error when the user worker returns non-2xx', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const routing = JSON.stringify({
        workerName: 'user-app',
        projectId: 'proj-1',
        queueName: 'emails',
        proxyToken: 'tok',
      });
      const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
      const { env } = createQueueEnv({
        routingRaw: routing,
        workerResponse: new Response('unauthorized', { status: 401 }),
      });

      await app.queue(batch, env);

      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls
        .flat()
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      expect(logged).toMatch(/queue.*emails/i);
      expect(logged).toMatch(/user-app/);
      expect(logged).toMatch(/401/);
      expect(logged).toMatch(/unauthorized/);
      expect(batch.retryAll).toHaveBeenCalledOnce();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('logs a structured error when the relay fetch throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const routing = JSON.stringify({
        workerName: 'user-app',
        projectId: 'proj-1',
        queueName: 'emails',
        proxyToken: 'tok',
      });
      const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
      const { env } = createQueueEnv({
        routingRaw: routing,
        workerFetchImpl: () => Promise.reject(new Error('connection reset')),
      });

      await app.queue(batch, env);

      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls
        .flat()
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      expect(logged).toMatch(/emails/);
      expect(logged).toMatch(/user-app/);
      expect(logged).toMatch(/connection reset/);
      expect(batch.retryAll).toHaveBeenCalledOnce();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('logs a structured error when the routing entry is missing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const batch = createMockBatch('orphan-queue', [{ id: 'm1', body: 'hello' }]);
      const { env } = createQueueEnv({ routingRaw: null });

      await app.queue(batch, env);

      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls
        .flat()
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      expect(logged).toMatch(/orphan-queue/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it.each([401, 403])(
    'relays once and retries the batch later when the Worker rejects the token with %i',
    async (status) => {
      const routing = JSON.stringify({
        workerName: 'user-app',
        projectId: 'proj-1',
        queueName: 'emails',
        proxyToken: 'tok',
      });
      const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
      const { env, workerFetch } = createQueueEnv({ routingRaw: routing });
      workerFetch.mockImplementation(async () =>
        Response.json({ error: 'unauthorized' }, { status }),
      );
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await app.queue(batch, env);
      } finally {
        errSpy.mockRestore();
      }

      expect(workerFetch).toHaveBeenCalledOnce();
      expect(batch.retryAll).toHaveBeenCalledOnce();
      expect(batch.retryAll).toHaveBeenCalledWith({ delaySeconds: 120 });
      expect(batch.ackAll).not.toHaveBeenCalled();
    },
  );

  it('retries other relay failures without a delay', async () => {
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, workerFetch } = createQueueEnv({
      routingRaw: JSON.stringify({
        workerName: 'user-app',
        projectId: 'proj-1',
        queueName: 'emails',
        proxyToken: 'tok',
      }),
      workerResponse: new Response('boom', { status: 500 }),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await app.queue(batch, env);
    } finally {
      errSpy.mockRestore();
    }

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(batch.retryAll).toHaveBeenCalledWith();
  });

  it('forwards x-platform-internal on legacy /__queue fallback too', async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'proj-1',
      queueName: 'emails',
      proxyToken: 'legacy-token',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const calls: Array<{ path: string; header: string | null }> = [];
    const workerFetch = vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      calls.push({ path: url.pathname, header: req.headers.get('x-platform-internal') });
      if (url.pathname === '/__platform/queue') {
        return new Response('not found', { status: 404 });
      }
      return Response.json({ ok: true });
    });
    const env = {
      ROUTING: {
        get: async (key: string) => (key.startsWith('project-suspended:') ? null : routing),
      },
      DISPATCH: { get: () => ({ fetch: workerFetch }) },
      ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    await app.queue(batch, env);

    expect(calls).toEqual([
      { path: '/__platform/queue', header: 'legacy-token' },
      { path: '/__queue', header: 'legacy-token' },
    ]);
  });
});

describe('redirect rules', () => {
  it('applies redirect rules before invoking worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new', status: 301 }],
      },
    });

    const response = await app.fetch(new Request('https://test.void.app/old'), env, createCtx());

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/new');
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('does not redirect non-matching paths', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new', status: 301 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(new Request('https://test.void.app/other'), env, createCtx());

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it('redirects with :splat substitution', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/blog/*', destination: '/posts/:splat', status: 301 }],
      },
    });

    const response = await app.fetch(
      new Request('https://test.void.app/blog/hello-world'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/posts/hello-world');
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('redirects with named :slug captures', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/blog/:slug', destination: '/articles/:slug', status: 301 }],
      },
    });

    const response = await app.fetch(
      new Request('https://test.void.app/blog/hello'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/articles/hello');
  });

  it('preserves the request query string in the Location header', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new', status: 301 }],
      },
    });

    const response = await app.fetch(
      new Request('https://test.void.app/old?utm_source=email&id=42'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/new?utm_source=email&id=42');
  });

  it('destination query takes precedence over request query on conflict', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new?ref=internal', status: 302 }],
      },
    });

    const response = await app.fetch(
      new Request('https://test.void.app/old?ref=external&utm=x'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/new?ref=internal&utm=x');
  });
});

describe('rewrite rules', () => {
  it('rewrites path and forwards to worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('rewritten content'),
    });

    const response = await app.fetch(new Request('https://test.void.app/docs'), env, createCtx());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('rewritten content');
    expect(response.headers.has('Location')).toBe(false);
    expect(workerFetch).toHaveBeenCalledOnce();

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/en/docs');
  });

  it('rewrites with :splat substitution', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs/*', destination: '/en/docs/:splat', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/docs/getting-started'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/en/docs/getting-started');
  });

  it('rewrites with named :author/:slug captures', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [
          { source: '/blog/:author/:slug', destination: '/posts/:author/:slug', status: 200 },
        ],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/blog/jane/first-post'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/posts/jane/first-post');
  });

  it('sets X-Platform-Original-URL header on rewritten requests', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(new Request('https://test.void.app/docs'), env, createCtx());

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get('X-Platform-Original-URL')).toBe('https://test.void.app/docs');
  });

  it('preserves query string on rewritten requests', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/docs?lang=en'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    const forwardedUrl = new URL(forwarded.url);
    expect(forwardedUrl.pathname).toBe('/en/docs');
    expect(forwardedUrl.search).toBe('?lang=en');
  });

  it('does not rewrite non-matching paths', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(new Request('https://test.void.app/other'), env, createCtx());

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/other');
    expect(forwarded.headers.has('X-Platform-Original-URL')).toBe(false);
  });

  // Decision: The fixture's ROUTING binding returns the same entry for each hostname, so url.hostname is the
  // only difference between the two requests. This catches a refactor that drops the hostname
  // argument to applyRoutingRules.
  it('host-scoped redirect fires when request host matches rule.host', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [
          {
            source: '/*',
            destination: 'https://foo.com/:splat',
            status: 301,
            host: 'www.foo.com',
          },
        ],
      },
    });

    const response = await app.fetch(new Request('https://www.foo.com/about'), env, createCtx());

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('https://foo.com/about');
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('host-scoped redirect skipped when request host differs from rule.host', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [
          {
            source: '/*',
            destination: 'https://foo.com/:splat',
            status: 301,
            host: 'www.foo.com',
          },
        ],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(new Request('https://foo.com/about'), env, createCtx());

    expect(response.status).toBe(200);
    expect(response.headers.has('Location')).toBe(false);
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it('rewrite wins over redirect when it is the first match', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [
          { source: '/page', destination: '/en/page', status: 200 },
          { source: '/page', destination: '/other', status: 302 },
        ],
      },
      workerResponse: new Response('rewritten'),
    });

    const response = await app.fetch(new Request('https://test.void.app/page'), env, createCtx());

    expect(response.status).toBe(200);
    expect(response.headers.has('Location')).toBe(false);
    expect(workerFetch).toHaveBeenCalledOnce();

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/en/page');
  });

  it('strips client-supplied X-Platform-Original-URL when no rewrite fires', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/plain', {
        headers: { 'X-Platform-Original-URL': 'https://evil/attacker' },
      }),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.has('X-Platform-Original-URL')).toBe(false);
  });

  it('overrides client-supplied X-Platform-Original-URL with the true original URL on rewrite', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/docs', {
        headers: { 'X-Platform-Original-URL': 'https://evil/attacker' },
      }),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get('X-Platform-Original-URL')).toBe('https://test.void.app/docs');
  });

  it('sets X-Platform-Original-URL to the full original URL (with query) on redirectRules rewrite', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const originalUrl = 'https://test.void.app/old?ref=email';
    const response = await app.fetch(new Request(originalUrl), env, createCtx());

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/new');
    expect(forwarded.headers.get('X-Platform-Original-URL')).toBe(originalUrl);
  });

  it('forwards a body-less rewrite request with X-Platform-Original-URL when POST body is consumed', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/submit', destination: '/en/submit', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const originalUrl = 'https://test.void.app/submit';
    const inbound = new Request(originalUrl, { method: 'POST', body: 'payload' });
    await inbound.text();
    expect(inbound.bodyUsed).toBe(true);

    const response = await app.fetch(inbound, env, createCtx());
    expect(response.status).toBe(200);

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.method).toBe('POST');
    expect(forwarded.body).toBeNull();
    expect(forwarded.headers.has('content-length')).toBe(false);
    expect(forwarded.headers.has('transfer-encoding')).toBe(false);
    expect(forwarded.headers.get('X-Platform-Original-URL')).toBe(originalUrl);
    expect(new URL(forwarded.url).pathname).toBe('/en/submit');
  });

  // Decision: createEnv returns the same entry for any KV key, which hides the `slug ?? domain:${hostname}`
  // branch. ROUTING is built by hand here so the `domain:` lookup runs.
  it('applies rewrite rules on a custom-domain request (domain: KV key path)', async () => {
    const workerFetch = vi.fn(async (_req: Request) => new Response('rewritten'));
    const routingLookups: Array<string> = [];
    const routing: RoutingEntry = {
      workerName: 'user-app',
      projectId: 'proj_custom',
      redirectRules: [{ source: '/docs/*', destination: '/en/docs/:splat', status: 200 }],
    };

    const env = {
      ROUTING: {
        get: async (key: string) => {
          routingLookups.push(key);
          if (key === 'domain:app.example.com') {
            return JSON.stringify(routing);
          }
          return null;
        },
      },
      DISPATCH: { get: () => ({ fetch: workerFetch }) },
      ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const originalUrl = 'https://app.example.com/docs/intro';
    const response = await app.fetch(new Request(originalUrl), env, createCtx());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('rewritten');

    expect(routingLookups).toContain('domain:app.example.com');
    expect(routingLookups.every((k) => !k.startsWith('app'))).toBe(true);

    expect(workerFetch).toHaveBeenCalledOnce();
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/en/docs/intro');
    expect(forwarded.headers.get('X-Platform-Original-URL')).toBe(originalUrl);
  });
});

describe('static asset caching', () => {
  it('caches static asset on first request, serves from cache on second', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('favicon') });
    const ctx = createCtx();

    const res1 = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    expect(res1.status).toBe(200);
    expect(await res1.text()).toBe('favicon');
    expect(workerFetch).toHaveBeenCalledTimes(1);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    const res2 = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx2);
    expect(res2.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  describe.each(['/reports/private.txt', '/assets/private-abc123.txt'])(
    'worker-first asset middleware at %s',
    (path) => {
      const routing: RoutingEntry = {
        workerName: 'test-worker',
        projectId: 'proj-1',
        type: 'framework',
        version: 'deploy-1',
        ssr: true,
        assetManifestId: 'deploy-1',
        hashedAssetsPrefix: 'assets',
      };
      const assetManifest = { [path]: 'private-hash' };
      const url = `https://test.void.app${path}`;
      const cacheKey = `${url}?${path.startsWith('/assets/') ? '_p=proj-1' : '_v=deploy-1'}`;

      it.each(
        [true, ['/*'], ['/**'], ['/reports/*', '/assets/*'], ['/*.txt'], [path]].map(
          (runWorkerFirst) => ({
            runWorkerFirst,
          }),
        ),
      )(
        'runs middleware after an allowed request with run_worker_first=$runWorkerFirst',
        async ({ runWorkerFirst }) => {
          const { env, workerFetch } = createEnv({
            routing: { ...routing, assetConfig: { run_worker_first: runWorkerFirst } },
            assetManifest,
            workerFetchImpl: async () => {
              const request = workerFetch.mock.calls.at(-1)![0];
              return request.headers.get('x-report-key') === 'allowed'
                ? new Response('private report', { headers: { 'Content-Type': 'text/plain' } })
                : new Response('Hidden', { status: 404 });
            },
          });
          for (const allowed of [false, true, false]) {
            const ctx = createCtx();
            const response = await app.fetch(
              new Request(url, { headers: allowed ? { 'x-report-key': 'allowed' } : {} }),
              env,
              ctx,
            );
            await Promise.all(
              (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map(([promise]) => promise),
            );
            expect(response.status).toBe(allowed ? 200 : 404);
            expect(await response.text()).toBe(allowed ? 'private report' : 'Hidden');
          }
          expect(workerFetch).toHaveBeenCalledTimes(3);
          expect(edgeCacheStore.size).toBe(0);
        },
      );

      it('ignores an existing shared cache entry, including after a rewrite', async () => {
        const { env, workerFetch } = createEnv({
          routing: {
            ...routing,
            assetConfig: { run_worker_first: [path] },
            redirectRules: [{ source: '/download', destination: path, status: 200 }],
          },
          assetManifest,
          workerFetchImpl: async () => new Response('Hidden', { status: 404 }),
        });
        edgeCacheStore.set(
          cacheKey,
          currentSharedCacheResponse(
            new Response('private report', {
              headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
            }),
          ),
        );
        for (const requestUrl of [url, 'https://test.void.app/download']) {
          const response = await app.fetch(new Request(requestUrl), env, createCtx());
          expect(response.status).toBe(404);
          expect(await response.text()).toBe('Hidden');
        }
        expect(workerFetch).toHaveBeenCalledTimes(2);
        expect(workerFetch.mock.calls[1]![0].url).toBe(url);
      });

      it.each(
        [
          undefined,
          false,
          ['/api/*'],
          ['/reports/:name.txt', '/assets/:name.txt'],
          ['/*', '!/reports/*', '!/assets/*'],
          ['!/reports/*', '!/assets/*', '/*'],
          [`${path}.other`],
        ].map((runWorkerFirst) => ({ runWorkerFirst })),
      )(
        'retains asset caching with run_worker_first=$runWorkerFirst',
        async ({ runWorkerFirst }) => {
          const { env, workerFetch } = createEnv({
            routing: { ...routing, assetConfig: { run_worker_first: runWorkerFirst } },
            assetManifest,
            workerFetchImpl: async () => new Response('public asset'),
          });
          for (let visit = 0; visit < 2; visit++) {
            const ctx = createCtx();
            const response = await app.fetch(new Request(url), env, ctx);
            expect(await response.text()).toBe('public asset');
            await Promise.all(
              (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map(([promise]) => promise),
            );
          }
          expect(workerFetch).toHaveBeenCalledOnce();
          expect(edgeCacheStore.has(cacheKey)).toBe(true);
        },
      );

      it('retains caching for static deployments with no application Worker', async () => {
        const { env, workerFetch } = createEnv({
          routing: {
            ...routing,
            staticDeploymentId: 'deploy-1',
            assetConfig: { run_worker_first: true },
          },
          assetManifest,
        });
        edgeCacheStore.set(
          cacheKey,
          currentSharedCacheResponse(
            new Response('public asset', {
              headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
            }),
          ),
        );
        const response = await app.fetch(new Request(url), env, createCtx());
        expect(await response.text()).toBe('public asset');
        expect(workerFetch).not.toHaveBeenCalled();
      });
    },
  );

  it('keeps Set-Cookie responses out of the deploy-versioned static cache', async () => {
    let render = 0;
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'test-worker', projectId: 'proj-1', version: 'deploy-1' },
      workerFetchImpl: async () => {
        render++;
        return new Response(`user-${render}`, {
          headers: { 'Set-Cookie': `sid=user-${render}; Path=/; HttpOnly` },
        });
      },
    });

    const firstCtx = createCtx();
    const first = await app.fetch(new Request('https://test.void.app/profile.json'), env, firstCtx);
    expect(await first.text()).toBe('user-1');
    expect(first.headers.get('Set-Cookie')).toContain('sid=user-1');
    await Promise.all((firstCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const second = await app.fetch(
      new Request('https://test.void.app/profile.json'),
      env,
      createCtx(),
    );
    expect(await second.text()).toBe('user-2');
    expect(second.headers.get('Set-Cookie')).toContain('sid=user-2');
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(edgeCacheStore.has('https://test.void.app/profile.json?_v=deploy-1')).toBe(false);
  });

  it('replaces an unmarked legacy static body instead of serving it', async () => {
    const cacheKey = 'https://test.void.app/profile.json?_v=deploy-1';
    edgeCacheStore.set(
      cacheKey,
      new Response('user-alice', {
        headers: {
          'Cache-Control': 'public, s-maxage=31536000',
        },
      }),
    );
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'test-worker', projectId: 'proj-1', version: 'deploy-1' },
      workerResponse: new Response('user-bob'),
    });
    const ctx = createCtx();

    const response = await app.fetch(new Request('https://test.void.app/profile.json'), env, ctx);
    expect(await response.text()).toBe('user-bob');
    expect(workerFetch).toHaveBeenCalledOnce();
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const replacement = edgeCacheStore.get(cacheKey);
    expect(replacement).toBeDefined();
    expect(replacement!.headers.get(SHARED_CACHE_POLICY_HEADER)).toBe(
      String(SHARED_CACHE_POLICY_VERSION),
    );
    expect(await replacement!.clone().text()).toBe('user-bob');

    const cachedResponse = await app.fetch(
      new Request('https://test.void.app/profile.json'),
      env,
      createCtx(),
    );
    expect(await cachedResponse.text()).toBe('user-bob');
    expect(cachedResponse.headers.get(SHARED_CACHE_POLICY_HEADER)).toBeNull();
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it('client response omits s-maxage on static cache miss', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env } = createEnv({ routing, workerResponse: new Response('favicon') });

    const res = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, createCtx());
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });

  it('client response omits s-maxage on static cache hit', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env } = createEnv({ routing, workerResponse: new Response('favicon') });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const res = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, createCtx());
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });

  it('static edge cache entry retains s-maxage for TTL', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env } = createEnv({ routing, workerResponse: new Response('favicon') });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const cacheEntry = edgeCacheStore.get('https://test.void.app/favicon.ico?_v=deploy-1');
    expect(cacheEntry).toBeDefined();
    expect(cacheEntry!.headers.get('Cache-Control')).toBe(
      'public, s-maxage=31536000, max-age=0, must-revalidate',
    );
  });

  it('does not write a 206 (Range) worker response to the static edge cache', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      ssr: true,
    };
    const { env, workerFetch } = createEnv({
      routing,
      workerResponse: new Response('partial-bytes', {
        status: 206,
        headers: { 'Content-Type': 'application/xml', 'Content-Range': 'bytes 0-11/100' },
      }),
    });
    const ctx = createCtx();

    const res = await app.fetch(
      new Request('https://test.void.app/feed.xml', { headers: { Range: 'bytes=0-11' } }),
      env,
      ctx,
    );
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('partial-bytes');
    expect(edgeCacheStore.get('https://test.void.app/feed.xml?_v=deploy-1')).toBeUndefined();
    expect([...edgeCacheStore.keys()].some((k) => k.includes('?_v='))).toBe(false);
  });

  it('still writes a manifest-backed 200 asset response to the static edge cache', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      ssr: true,
      assetManifestId: 'deploy-1',
    };
    const { env } = createEnv({
      routing,
      assetManifest: { '/feed.xml': 'feed-hash' },
      workerResponse: new Response('<rss>feed</rss>', {
        status: 200,
        headers: { 'Content-Type': 'application/xml' },
      }),
    });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/feed.xml'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const cacheEntry = edgeCacheStore.get('https://test.void.app/feed.xml?_v=deploy-1');
    expect(cacheEntry).toBeDefined();
    expect(cacheEntry!.headers.get('Cache-Control')).toBe(
      'public, s-maxage=31536000, max-age=0, must-revalidate',
    );
  });

  it('invalidates cache on version change', async () => {
    const routing1: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env: env1, workerFetch: wf1 } = createEnv({
      routing: routing1,
      workerResponse: new Response('v1'),
    });
    const ctx1 = createCtx();

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env1, ctx1);
    expect(wf1).toHaveBeenCalledTimes(1);
    await Promise.all((ctx1.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const routing2: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-2',
    };
    const { env: env2, workerFetch: wf2 } = createEnv({
      routing: routing2,
      workerResponse: new Response('v2'),
    });
    const ctx2 = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/favicon.ico'), env2, ctx2);
    expect(res.status).toBe(200);
    expect(wf2).toHaveBeenCalledTimes(1);
  });

  it('does not cache /api/ routes', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('api') });

    await app.fetch(new Request('https://test.void.app/api/data'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/api/data'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache SSR paths without extension', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      ssr: true,
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ssr page') });

    await app.fetch(new Request('https://test.void.app/about'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/about'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('caches manifest-backed non-hashed asset paths in SSR projects', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      ssr: true,
      assetManifestId: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({
      routing,
      assetManifest: { '/favicon.ico': 'favicon-hash' },
      workerResponse: new Response('icon'),
    });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache when version is absent', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ok') });

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache non-OK responses', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env } = createEnv({
      routing,
      workerResponse: new Response('not found', { status: 404 }),
    });

    await app.fetch(new Request('https://test.void.app/missing.png'), env, createCtx());
    expect(edgeCacheStore.size).toBe(0);
  });

  it('does not cache when worker sets Cache-Control: private', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({
      routing,
      workerResponse: new Response('dynamic', {
        headers: { 'Cache-Control': 'private, max-age=0' },
      }),
    });

    await app.fetch(new Request('https://test.void.app/avatar.jpg'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/avatar.jpg'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache when worker sets Cache-Control: no-store', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({
      routing,
      workerResponse: new Response('dynamic', {
        headers: { 'Cache-Control': 'no-store' },
      }),
    });

    await app.fetch(new Request('https://test.void.app/data.json'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/data.json'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('normalizes query strings (same path, different query → same cache key)', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('img') });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/logo.png?width=100'), env, ctx);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/logo.png?width=200'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('drops non-allowlisted params from the key (still collapses on those)', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      queryAllowlist: { '/badge.png': ['theme'] },
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('img') });

    const ctx1 = createCtx();
    await app.fetch(new Request('https://test.void.app/badge.png?theme=light&utm=a'), env, ctx1);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    await Promise.all((ctx1.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/badge.png?theme=light&utm=b'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a wildcard allowlist entry so static candidates cannot fan out', async () => {
    // Decision: A broad `*` allowlist stays ISR-only, where the variant cap bounds it. The uncapped static
    // cache ignores it, or a cache-buster like `?theme=<random>` would fan out static assets. Only an
    // exact path opts in.
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      queryAllowlist: { '*': ['theme'] },
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('img') });

    const ctx1 = createCtx();
    await app.fetch(new Request('https://test.void.app/logo.png?theme=light'), env, ctx1);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    await Promise.all((ctx1.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/logo.png?theme=dark'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('skips cache for non-GET requests', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ok') });

    await app.fetch(
      new Request('https://test.void.app/form.html', { method: 'POST' }),
      env,
      createCtx(),
    );
    await app.fetch(
      new Request('https://test.void.app/form.html', { method: 'POST' }),
      env,
      createCtx(),
    );
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('applies header rules to cached static assets', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      headerRules: [{ pattern: '/*', headers: [['X-Custom', 'from-rules']] }],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    expect(res.headers.get('X-Custom')).toBe('from-rules');
  });
});

describe('static deployment caching (KV/R2)', () => {
  function createStaticDeployEnv(options: {
    routing: RoutingEntry;
    manifest: Record<string, string>;
    assets: Record<string, { body: string; contentType?: string }>;
    r2Get?: (key: string) => Promise<R2ObjectBody | null>;
  }): {
    env: Env;
    usageSend: ReturnType<typeof vi.fn>;
  } {
    const usageSend = vi.fn(async () => {});
    const env = {
      ROUTING: {
        get: async (key: string) => {
          if (key.startsWith('manifest:')) {
            return JSON.stringify(options.manifest);
          }
          return JSON.stringify(options.routing);
        },
      },
      DISPATCH: { get: vi.fn(() => ({ fetch: vi.fn() })) },
      ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
      STATIC_ASSETS: {
        getWithMetadata: async (key: string) => {
          const hash = key.replace(/^assets\/[^/]+\//, '');
          const asset = options.assets[hash];
          if (!asset) {
            return { value: null, metadata: null };
          }
          return {
            value: new TextEncoder().encode(asset.body).buffer,
            metadata: { ct: asset.contentType ?? 'text/html' },
          };
        },
      },
      STATIC_ASSETS_R2: { get: options.r2Get ?? (async () => null) },
      ANALYTICS: { writeDataPoint: () => {} },
      USAGE_QUEUE: { send: usageSend },
    } as unknown as Env;

    return { env, usageSend };
  }

  it('client response omits s-maxage for static deployment', async () => {
    const { env } = createStaticDeployEnv({
      routing: {
        workerName: '',
        projectId: 'proj-1',
        staticDeploymentId: 'deploy-abc',
        version: 'deploy-abc',
      },
      manifest: { '/index.html': 'hash1' },
      assets: { hash1: { body: '<html>hello</html>', contentType: 'text/html' } },
    });

    const res = await app.fetch(new Request('https://test.void.app/'), env, createCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });

  it('edge cache entry retains s-maxage for static deployment', async () => {
    const { env } = createStaticDeployEnv({
      routing: {
        workerName: '',
        projectId: 'proj-1',
        staticDeploymentId: 'deploy-abc',
        version: 'deploy-abc',
      },
      manifest: { '/index.html': 'hash1' },
      assets: { hash1: { body: '<html>hello</html>', contentType: 'text/html' } },
    });

    const ctx = createCtx();
    await app.fetch(new Request('https://test.void.app/'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const cacheEntry = edgeCacheStore.get('https://test.void.app/?_v=deploy-abc');
    expect(cacheEntry).toBeDefined();
    expect(cacheEntry!.headers.get('Cache-Control')).toBe(
      'public, s-maxage=31536000, max-age=0, must-revalidate',
    );
  });

  it('hedges a stalled R2 read and serves the retry within the original deadline', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let resolveSlow!: (value: R2ObjectBody) => void;
      const slow = new Promise<R2ObjectBody>((resolve) => {
        resolveSlow = resolve;
      });
      const winnerBytes = new TextEncoder().encode('<html>hedged</html>');
      const winner = {
        body: new Response(winnerBytes).body!,
        size: winnerBytes.byteLength,
        httpEtag: '"winner"',
        httpMetadata: { contentType: 'text/html' },
      } as unknown as R2ObjectBody;
      const cancelLoser = vi.fn();
      const loser = {
        body: new ReadableStream({ cancel: cancelLoser }),
        size: 1,
        httpEtag: '"loser"',
        httpMetadata: { contentType: 'text/html' },
      } as unknown as R2ObjectBody;
      const r2Get = vi
        .fn<(key: string) => Promise<R2ObjectBody | null>>()
        .mockReturnValueOnce(slow)
        .mockResolvedValueOnce(winner);
      const { env } = createStaticDeployEnv({
        routing: {
          workerName: '',
          projectId: 'proj-1',
          staticDeploymentId: 'deploy-abc',
          version: 'deploy-abc',
        },
        manifest: { '/index.html': '!hash1' },
        assets: {},
        r2Get,
      });
      const ctx = createCtx();
      const responsePromise = app.fetch(new Request('https://test.void.app/'), env, ctx);

      await vi.advanceTimersByTimeAsync(0);
      expect(r2Get).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1000);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(response.headers.get('ETag')).toBe('"winner"');
      expect(await response.text()).toBe('<html>hedged</html>');
      expect(r2Get).toHaveBeenCalledTimes(2);
      expect(r2Get).toHaveBeenNthCalledWith(2, 'assets/proj-1/hash1');
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

      resolveSlow(loser);
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelLoser).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('attributes an exhausted R2 timeout to the platform without extending 10s', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r2Get = vi.fn(() => new Promise<R2ObjectBody | null>(() => {}));
      const { env, usageSend } = createStaticDeployEnv({
        routing: {
          workerName: '',
          projectId: 'proj-1',
          userId: 'user-1',
          staticDeploymentId: 'deploy-abc',
          version: 'deploy-abc',
        },
        manifest: { '/index.html': '!hash1' },
        assets: {},
        r2Get,
      });
      const ctx = createCtx();
      const responsePromise = app.fetch(new Request('https://test.void.app/'), env, ctx);

      await vi.advanceTimersByTimeAsync(0);
      expect(r2Get).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1000);
      expect(r2Get).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(9000);

      const response = await responsePromise;
      expect(response.status).toBe(503);
      expect(response.headers.get('X-Platform-Timeout')).toBe('static-asset');
      expect(response.headers.get('Retry-After')).toBe('5');
      expect(r2Get).toHaveBeenCalledTimes(2);
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(usageSend).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            status: 503,
            failureKind: 'platform-static-asset-timeout',
          }),
        }),
      );
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it('meters exhausted R2 binding errors as a platform 503', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r2Get = vi.fn(async () => {
        throw new Error('R2 service unavailable');
      });
      const { env, usageSend } = createStaticDeployEnv({
        routing: {
          workerName: '',
          projectId: 'proj-1',
          userId: 'user-1',
          staticDeploymentId: 'deploy-abc',
          version: 'deploy-abc',
        },
        manifest: { '/index.html': '!hash1' },
        assets: {},
        r2Get,
      });
      const ctx = createCtx();

      const response = await app.fetch(new Request('https://test.void.app/'), env, ctx);

      expect(response.status).toBe(503);
      expect(response.headers.get('X-Platform-Storage-Error')).toBe('static-asset-read');
      expect(r2Get).toHaveBeenCalledTimes(2);
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(usageSend).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            status: 503,
            failureKind: 'platform-static-asset-error',
          }),
        }),
      );
    } finally {
      error.mockRestore();
    }
  });

  it('treats a missing manifest-referenced R2 object as a platform 503', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r2Get = vi.fn(async () => null);
      const { env, usageSend } = createStaticDeployEnv({
        routing: {
          workerName: '',
          projectId: 'proj-1',
          userId: 'user-1',
          staticDeploymentId: 'deploy-abc',
          version: 'deploy-abc',
        },
        manifest: { '/index.html': '!hash1' },
        assets: {},
        r2Get,
      });
      const ctx = createCtx();

      const response = await app.fetch(new Request('https://test.void.app/'), env, ctx);

      expect(response.status).toBe(503);
      expect(response.headers.get('X-Platform-Storage-Error')).toBe('static-asset-missing');
      expect(r2Get).toHaveBeenNthCalledWith(1, 'assets/proj-1/hash1');
      expect(r2Get).toHaveBeenNthCalledWith(2, 'assets/hash1');
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(usageSend).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            status: 503,
            failureKind: 'platform-static-asset-missing',
          }),
        }),
      );
    } finally {
      error.mockRestore();
    }
  });

  it.each([undefined, '_next/static'])(
    'serves encoded Next.js chunks before HTML fallback with hashedAssetsPrefix=%s',
    async (hashedAssetsPrefix) => {
      const path = '/_next/static/chunks/pages/package/[...slug]-abc123.js';
      const body = 'self.webpackChunk_N_E = [];';
      const { env } = createStaticDeployEnv({
        routing: {
          workerName: '',
          projectId: 'proj-1',
          staticDeploymentId: 'deploy-abc',
          version: 'deploy-abc',
          hashedAssetsPrefix,
          fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
        },
        manifest: { [path]: 'hash_chunk', '/index.html': 'hash_index' },
        assets: {
          hash_chunk: { body, contentType: 'text/javascript; charset=utf-8' },
          hash_index: { body: '<!DOCTYPE html><title>Fallback</title>', contentType: 'text/html' },
        },
      });

      for (const pathname of [path, path.replace('[', '%5B').replace(']', '%5D')]) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const ctx = createCtx();
          const response = await app.fetch(
            new Request(`https://test.void.app${pathname}`),
            env,
            ctx,
          );
          expect(response.status).toBe(200);
          expect(response.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
          expect(await response.text()).toBe(body);
          await Promise.all(
            (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
          );
        }
      }
    },
  );

  it('serves a hashed asset whose filename contains a space (%20-encoded request)', async () => {
    const { env } = createStaticDeployEnv({
      routing: {
        workerName: '',
        projectId: 'proj-1',
        staticDeploymentId: 'deploy-abc',
        version: 'deploy-abc',
        hashedAssetsPrefix: 'assets',
      },
      manifest: { '/assets/640_x_630_oxc masthead_.B7dLtkJB.riv': 'hash_riv' },
      assets: { hash_riv: { body: 'RIVE-BYTES', contentType: 'application/octet-stream' } },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/assets/640_x_630_oxc%20masthead_.B7dLtkJB.riv'),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('RIVE-BYTES');
  });
});

describe('static asset content-type normalization', () => {
  // Decision: Assets uploaded before the CLI MIME table knew an extension carry a stored
  // `application/octet-stream` type. Dispatch treats that default as unknown and derives the type
  // from the path, so files already deployed serve correctly.
  function createContentTypeEnv(options: {
    manifest: Record<string, string>;
    kvAssets?: Record<string, { body: string; ct: string }>;
    r2Assets?: Record<string, { body: string; contentType: string }>;
  }): Env {
    return {
      ROUTING: {
        get: async (key: string) =>
          key.startsWith('manifest:')
            ? JSON.stringify(options.manifest)
            : JSON.stringify({
                workerName: '',
                projectId: 'proj-1',
                staticDeploymentId: 'deploy-abc',
                version: 'deploy-abc',
              }),
      },
      DISPATCH: { get: vi.fn(() => ({ fetch: vi.fn() })) },
      ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
      STATIC_ASSETS: {
        getWithMetadata: async (key: string) => {
          const hash = key.replace(/^assets\/[^/]+\//, '');
          const asset = options.kvAssets?.[hash];
          if (!asset) {
            return { value: null, metadata: null };
          }
          return {
            value: new TextEncoder().encode(asset.body).buffer,
            metadata: { ct: asset.ct },
          };
        },
      },
      STATIC_ASSETS_R2: {
        get: async (key: string) => {
          const hash = key.replace(/^assets\/[^/]+\//, '');
          const asset = options.r2Assets?.[hash];
          if (!asset) {
            return null;
          }
          return {
            body: asset.body,
            size: asset.body.length,
            httpEtag: '"ad7a5ae51c0bc3bbd2d6c7cbdc238c3e"',
            httpMetadata: { contentType: asset.contentType },
          };
        },
      },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;
  }

  it('re-derives content type for .md stored in R2 as application/octet-stream', async () => {
    const env = createContentTypeEnv({
      manifest: { '/guide/page.md': '!hash_md' },
      r2Assets: { hash_md: { body: '# hello', contentType: 'application/octet-stream' } },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/guide/page.md'),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
  });

  it('re-derives content type for .md stored in KV as application/octet-stream', async () => {
    const env = createContentTypeEnv({
      manifest: { '/guide/page.md': 'hash_md' },
      kvAssets: { hash_md: { body: '# hello', ct: 'application/octet-stream' } },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/guide/page.md'),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
  });

  it('honors an explicit stored content type that is not octet-stream', async () => {
    const env = createContentTypeEnv({
      manifest: { '/guide/page.md': 'hash_md' },
      kvAssets: { hash_md: { body: '# hello', ct: 'text/plain; charset=utf-8' } },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/guide/page.md'),
      env,
      createCtx(),
    );
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
  });

  it('keeps application/octet-stream when the extension is also unknown', async () => {
    const env = createContentTypeEnv({
      manifest: { '/file.xyz': 'hash_xyz' },
      kvAssets: { hash_xyz: { body: 'data', ct: 'application/octet-stream' } },
    });

    const res = await app.fetch(new Request('https://test.void.app/file.xyz'), env, createCtx());
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('omits the Content-Type header for the application/null sentinel', async () => {
    const env = createContentTypeEnv({
      manifest: { '/data.bin': 'hash_bin' },
      kvAssets: { hash_bin: { body: 'data', ct: 'application/null' } },
    });

    const res = await app.fetch(new Request('https://test.void.app/data.bin'), env, createCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBeNull();
  });
});

describe('foreground worker duration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    ['API mutation', '/api/email', 'POST', undefined],
    ['SSR page', '/slow', 'GET', undefined],
    ['ISR cache miss', '/slow', 'GET', 60],
  ] as const)('waits for a slow %s to finish by default', async (_, path, method, revalidate) => {
    const completed = vi.fn();
    const { env, logWrites, analyticsWrites } = createEnv({
      routing: {
        workerName: 'user-app-dpl_1',
        projectId: 'proj_1',
        type: 'platform',
        ssr: true,
        revalidate,
      },
      workerFetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 11_000));
        completed();
        return new Response('completed', { headers: { 'Content-Type': 'text/html' } });
      },
    });
    const responsePromise = app.fetch(
      new Request(`https://my-app.void.app${path}`, { method }),
      env,
      createCtx(),
    );
    await vi.advanceTimersByTimeAsync(11_000);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('completed');
    expect(completed).toHaveBeenCalledOnce();
    expect(logWrites).toHaveLength(0);
    expect(analyticsWrites).toHaveLength(1);
  });

  it.each([undefined, 60])(
    'waits for a slow worker fallback with ISR TTL %s',
    async (revalidate) => {
      let calls = 0;
      const { env, workerFetch, logWrites } = createEnv({
        routing: {
          workerName: 'user-app-dpl_1',
          projectId: 'proj_1',
          type: 'platform',
          ssr: true,
          revalidate,
          fallbackRules: [{ source: '/missing', destination: '/slow', status: 200 }],
        },
        workerFetchImpl: async () => {
          if (++calls === 1) {
            return new Response('missing', {
              status: 404,
              headers: { 'X-Platform-No-Match': '1' },
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 11_000));
          return new Response('fallback', { headers: { 'Content-Type': 'text/html' } });
        },
      });
      const responsePromise = app.fetch(
        new Request('https://my-app.void.app/missing'),
        env,
        createCtx(),
      );
      await vi.advanceTimersByTimeAsync(11_000);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('fallback');
      expect(workerFetch).toHaveBeenCalledTimes(2);
      expect(logWrites).toHaveLength(0);
    },
  );

  it('keeps a separate bounded storage budget after a slow worker returns an asset stub', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const stubBody = 'Assets have not yet been deployed to this script.\n';
      const { env, logWrites } = createEnv({
        routing: {
          workerName: 'user-app-dpl_1',
          projectId: 'proj_1',
          type: 'platform',
          ssr: true,
          assetManifestId: 'deploy-1',
          assetConfig: { run_worker_first: true },
        },
        assetManifest: { '/bundle.js': '!bundle' },
        workerFetchImpl: async () => {
          await new Promise((resolve) => setTimeout(resolve, 11_000));
          return new Response(stubBody, {
            headers: {
              'Content-Type': 'text/plain;charset=UTF-8',
              'Content-Length': String(stubBody.length),
            },
          });
        },
      });
      const get = vi.fn(() => new Promise<R2ObjectBody | null>(() => {}));
      Object.assign(env, { STATIC_ASSETS_R2: { get } });
      let settled = false;
      const responsePromise = app
        .fetch(
          new Request('https://my-app.void.app/bundle.js', { headers: { Cookie: 'a=1' } }),
          env,
          createCtx(),
        )
        .then((response) => {
          settled = true;
          return response;
        });
      await vi.advanceTimersByTimeAsync(11_000);
      expect(get).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(9999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const response = await responsePromise;
      expect(response.status).toBe(503);
      expect(response.headers.get('X-Platform-Timeout')).toBe('static-asset');
      expect(get).toHaveBeenCalledTimes(2);
      expect(logWrites).toHaveLength(0);
    } finally {
      error.mockRestore();
    }
  });
});

describe('worker timeout explains itself in the project log stream', () => {
  function createHangingEnv(workerName: string) {
    const { env, logWrites, analyticsWrites } = createEnv({
      routing: { workerName, projectId: 'proj_1', type: 'platform', ssr: true },
      workerFetchImpl: () => new Promise<Response>(() => {}),
    });
    return {
      env: { ...env, DISPATCH_TIMEOUT_MS: '20' } as Env,
      logWrites,
      analyticsWrites,
    };
  }

  it('returns 503 and writes one log row attributed to the project', async () => {
    const { env, logWrites } = createHangingEnv('user-my-app-dpl_abc123');

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/slow', { method: 'POST' }),
      env,
      createCtx(),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('X-Platform-Timeout')).toBe('dispatch');

    expect(logWrites).toHaveLength(1);
    const dp = logWrites[0] as { indexes: Array<string>; blobs: Array<string> };
    expect(dp.indexes).toEqual(['user-my-app']);
    expect(dp.blobs[6]).toBe('dpl_abc123');
    expect(dp.blobs[5]).toBe('503');
    expect(dp.blobs[4]).toBe('POST');

    const logs = JSON.parse(dp.blobs[1]) as Array<{ level: string; message: Array<string> }>;
    expect(logs[0].level).toBe('error');
    expect(logs[0].message.join(' ')).toContain('POST /api/slow');
    expect(logs[0].message.join(' ')).toContain('20 ms');
  });

  it('still meters the request exactly once', async () => {
    const { env, analyticsWrites, logWrites } = createHangingEnv('user-my-app-dpl_abc123');

    await app.fetch(new Request('https://my-app.void.app/api/slow'), env, createCtx());

    expect(analyticsWrites).toHaveLength(1);
    expect(logWrites).toHaveLength(1);
    const dp = analyticsWrites[0] as { blobs: Array<string> };
    expect(dp.blobs[3]).toBe('503');
  });

  it('writes no log row for a project whose routing carries no worker name', async () => {
    const { env, logWrites } = createHangingEnv('');

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/slow'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(503);
    expect(logWrites).toHaveLength(0);
  });

  it('does not write a log row when the worker answers in time', async () => {
    const { env, logWrites } = createEnv({
      routing: { workerName: 'user-my-app-dpl_abc123', projectId: 'proj_1' },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/fast'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(logWrites).toHaveLength(0);
  });
});

it.each(['requests', 'execution'] as const)(
  'serves a custom %s page from assets independently of application execution',
  async (resource) => {
    const filename = resource === 'requests' ? '/usage-limit.html' : '/execution-limit.html';
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'deploy_1',
        ...(resource === 'requests' ? { suspended: 'requests_exceeded' } : {}),
      },
      assetManifest: { [filename]: '!custom-page' },
      workerFetchImpl: async () => {
        throw new Error('Worker exceeded CPU limit');
      },
    });
    const get = vi.fn(async () => ({
      body: new Blob(['<h1>We will be back</h1>']).stream(),
      httpMetadata: { contentType: 'text/html' },
      httpEtag: '"page"',
    }));
    Object.assign(env, { STATIC_ASSETS_R2: { get } });
    const res = await app.fetch(
      new Request('https://my-app.void.app/', { headers: { accept: 'text/html' } }),
      env,
      createCtx(),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('We will be back');
    expect(get).toHaveBeenCalledWith('assets/proj_1/custom-page');
    expect(workerFetch).toHaveBeenCalledTimes(resource === 'requests' ? 0 : 1);
  },
);

function meteredRequestType(analyticsWrites: Array<unknown>): string | undefined {
  expect(analyticsWrites).toHaveLength(1);
  return (analyticsWrites[0] as { blobs: Array<string> }).blobs[1];
}

describe('request type metering for SSR routes with a file extension', () => {
  const routing: RoutingEntry = {
    workerName: 'user-app-dpl_1',
    projectId: 'proj_1',
    type: 'platform',
    ssr: true,
    version: 'deploy-1',
    assetManifestId: 'deploy-1',
    assetConfig: { not_found_handling: 'none', run_worker_first: ['/**'] },
  };
  const routingWithoutManifest: RoutingEntry = {
    workerName: 'user-app-dpl_1',
    projectId: 'proj_1',
    type: 'platform',
    ssr: true,
    version: 'deploy-1',
  };
  const assetManifest = { '/robots.txt': 'robots-hash' };

  function svgResponse(): Response {
    return new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } });
  }

  it.each(['/sponsors.svg', '/support-matrix.png?theme=dark'])(
    'labels the route at %s as ssr when the asset manifest does not list it',
    async (path) => {
      const { env, workerFetch, analyticsWrites } = createEnv({
        routing,
        assetManifest,
        workerResponse: svgResponse(),
      });

      const response = await app.fetch(
        new Request(`https://my-app.void.app${path}`),
        env,
        createCtx(),
      );

      expect(response.status).toBe(200);
      expect(workerFetch).toHaveBeenCalledOnce();
      expect(meteredRequestType(analyticsWrites)).toBe('ssr');
    },
  );

  it.each<[string, RequestInit]>([
    ['a plain GET', {}],
    ['a GET with a cookie', { headers: { Cookie: 'a=1' } }],
    ['a HEAD request', { method: 'HEAD' }],
    ['a Range request', { headers: { Range: 'bytes=0-3' } }],
  ])('keeps a file listed in the asset manifest as static for %s', async (_, init) => {
    const { env, workerFetch, analyticsWrites } = createEnv({
      routing,
      assetManifest,
      workerResponse: new Response('User-agent: *', { headers: { 'Content-Type': 'text/plain' } }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/robots.txt', init),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(meteredRequestType(analyticsWrites)).toBe('static');
  });

  it.each([
    ['is missing', async () => null],
    [
      'cannot be read',
      async () => {
        throw new Error('KV unavailable');
      },
    ],
  ])('keeps a successful response static when the asset manifest %s', async (_, readManifest) => {
    const created = createEnv({
      routing,
      assetManifest,
      workerResponse: new Response('User-agent: *', { headers: { 'Content-Type': 'text/plain' } }),
    });
    const readRouting = created.env.ROUTING.get.bind(created.env.ROUTING);
    const env = {
      ...created.env,
      ROUTING: {
        get: (key: string) => (key.startsWith('manifest:') ? readManifest() : readRouting(key)),
      },
    } as unknown as Env;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await app.fetch(
        new Request('https://my-app.void.app/robots.txt'),
        env,
        createCtx(),
      );

      expect(response.status).toBe(200);
      expect(created.workerFetch).toHaveBeenCalledOnce();
      expect(meteredRequestType(created.analyticsWrites)).toBe('static');
    } finally {
      error.mockRestore();
    }
  });

  it('keeps a successful response static when the deploy has no asset manifest', async () => {
    const { env, analyticsWrites } = createEnv({
      routing: routingWithoutManifest,
      workerResponse: svgResponse(),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/sponsors.svg'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(meteredRequestType(analyticsWrites)).toBe('static');
  });

  it('labels a route server error as ssr when the deploy has no asset manifest', async () => {
    const { env, analyticsWrites } = createEnv({
      routing: routingWithoutManifest,
      workerResponse: new Response('boom', { status: 500 }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/sponsors.svg'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(500);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
  });

  it('labels a route that runs past the dispatch budget as ssr when the deploy has no asset manifest', async () => {
    const { env, analyticsWrites } = createEnv({
      routing: routingWithoutManifest,
      workerFetchImpl: () => new Promise<Response>(() => {}),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/sponsors.svg'),
      { ...env, DISPATCH_TIMEOUT_MS: '20' } as Env,
      createCtx(),
    );

    expect(response.status).toBe(503);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
  });

  it.each<[string, RequestInit]>([
    ['a HEAD request', { method: 'HEAD' }],
    ['a GET with a cookie', { headers: { Cookie: 'a=1' } }],
  ])('labels a route server error from %s as ssr without reading the manifest', async (_, init) => {
    const { env, analyticsWrites } = createEnv({
      routing,
      assetManifest,
      workerResponse: new Response('boom', { status: 500 }),
    });
    const routingGet = vi.spyOn(env.ROUTING, 'get');

    const response = await app.fetch(
      new Request('https://my-app.void.app/sponsors.svg', init),
      env,
      createCtx(),
    );

    expect(response.status).toBe(500);
    expect(routingGet.mock.calls.some(([key]) => String(key).startsWith('manifest:'))).toBe(false);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
  });

  it.each([
    ['an asset manifest that does not list the path', routing],
    ['no asset manifest', routingWithoutManifest],
  ])('keeps a platform asset failure static on a deploy with %s', async (_, deployRouting) => {
    const stubBody = 'Assets have not yet been deployed to this script.\n';
    const { env, analyticsWrites } = createEnv({
      routing: deployRouting,
      assetManifest,
      workerResponse: new Response(stubBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'Content-Length': String(stubBody.length),
        },
      }),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await app.fetch(
        new Request('https://my-app.void.app/sponsors.svg'),
        env,
        createCtx(),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('X-Platform-Storage-Error')).toBe('static-asset-missing');
      expect(meteredRequestType(analyticsWrites)).toBe('static');
      expect((analyticsWrites[0] as { blobs: Array<string> }).blobs[5]).toBe(
        'platform-static-asset-missing',
      );
    } finally {
      error.mockRestore();
    }
  });

  it('labels a route that runs past the dispatch budget as ssr', async () => {
    const { env, analyticsWrites } = createEnv({
      routing,
      assetManifest,
      workerFetchImpl: () => new Promise<Response>(() => {}),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/sponsors.svg', { headers: { Cookie: 'a=1' } }),
      { ...env, DISPATCH_TIMEOUT_MS: '20' } as Env,
      createCtx(),
    );

    expect(response.status).toBe(503);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
  });
});

describe('request type metering when Cloudflare serves assets before the worker', () => {
  const assetFirstRouting: RoutingEntry = {
    workerName: 'user-app-dpl_1',
    projectId: 'proj_1',
    type: 'framework',
    ssr: true,
    version: 'deploy-1',
    assetManifestId: 'deploy-1',
    assetConfig: { not_found_handling: 'none' },
  };
  const spaWithApiRouting: RoutingEntry = {
    workerName: 'user-app-dpl_1',
    projectId: 'proj_1',
    type: 'platform',
    ssr: true,
    version: 'deploy-1',
    assetManifestId: 'deploy-1',
    assetConfig: {
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api', '/api/*', '/__platform', '/__platform/*'],
    },
  };
  const assetManifest = { '/index.html': 'shell-hash', '/robots.txt': 'robots-hash' };
  const deploys = [
    ['an asset-first deploy', assetFirstRouting],
    ['a SPA deploy with API routes', spaWithApiRouting],
  ] as const;

  it('labels an unlisted path as ssr when the worker answers it', async () => {
    const { env, analyticsWrites } = createEnv({
      routing: assetFirstRouting,
      assetManifest,
      workerResponse: new Response('png', { headers: { 'Content-Type': 'image/png' } }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/og.png'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
  });

  it('labels an unlisted path that runs past the dispatch budget as ssr', async () => {
    const { env, analyticsWrites } = createEnv({
      routing: assetFirstRouting,
      assetManifest,
      workerFetchImpl: () => new Promise<Response>(() => {}),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/og.png'),
      { ...env, DISPATCH_TIMEOUT_MS: '20' } as Env,
      createCtx(),
    );

    expect(response.status).toBe(503);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
  });

  it.each([
    ['/docs/v1.2', '/docs/v1.2.html', 200],
    ['/docs/v1.2', '/docs/v1.2/index.html', 307],
    ['/about.html', '/about/index.html', 307],
    ['/about/index.html', '/about.html', 307],
    ['/docs/release%20v1.2', '/docs/release v1.2.html', 200],
  ])('keeps %s static when the asset layer answers it from %s', async (path, file, status) => {
    const { env, analyticsWrites } = createEnv({
      routing: assetFirstRouting,
      assetManifest: { ...assetManifest, [file]: 'page-hash' },
      workerResponse:
        status === 200
          ? new Response('<html>page</html>', { headers: { 'Content-Type': 'text/html' } })
          : new Response(null, { status, headers: { Location: '/' } }),
    });

    const response = await app.fetch(
      new Request(`https://my-app.void.app${path}`),
      env,
      createCtx(),
    );

    expect(response.status).toBe(status);
    expect(meteredRequestType(analyticsWrites)).toBe('static');
  });

  it('labels an unlisted path as ssr when html_handling is none', async () => {
    const { env, analyticsWrites } = createEnv({
      routing: {
        ...assetFirstRouting,
        assetConfig: { not_found_handling: 'none', html_handling: 'none' },
      },
      assetManifest: { ...assetManifest, '/docs/v1.2.html': 'page-hash' },
      workerResponse: new Response('<html>route</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/docs/v1.2'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
  });

  it('keeps the SPA shell served for an unlisted path static', async () => {
    const { env, analyticsWrites } = createEnv({
      routing: spaWithApiRouting,
      assetManifest,
      workerResponse: new Response('<html>shell</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/old-page.html'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(meteredRequestType(analyticsWrites)).toBe('static');
  });

  it.each(deploys)('keeps a server error for a listed file static on %s', async (_, routing) => {
    const { env, analyticsWrites } = createEnv({
      routing,
      assetManifest,
      workerResponse: new Response('unavailable', { status: 503 }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/robots.txt'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(503);
    expect(meteredRequestType(analyticsWrites)).toBe('static');
  });

  it.each(deploys)(
    'keeps a listed file that runs past the dispatch budget static on %s',
    async (_, routing) => {
      const { env, analyticsWrites } = createEnv({
        routing,
        assetManifest,
        workerFetchImpl: () => new Promise<Response>(() => {}),
      });

      const response = await app.fetch(
        new Request('https://my-app.void.app/robots.txt'),
        { ...env, DISPATCH_TIMEOUT_MS: '20' } as Env,
        createCtx(),
      );

      expect(response.status).toBe(503);
      expect(meteredRequestType(analyticsWrites)).toBe('static');
    },
  );
});

describe('request type metering after a fallback rewrite', () => {
  it('does not apply the manifest answer for the original path to the rewrite target', async () => {
    let calls = 0;
    const { env, workerFetch, analyticsWrites } = createEnv({
      routing: {
        workerName: 'user-app-dpl_1',
        projectId: 'proj_1',
        type: 'framework',
        ssr: true,
        version: 'deploy-1',
        assetManifestId: 'deploy-1',
        fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
      },
      assetManifest: { '/index.html': 'shell-hash' },
      workerFetchImpl: async () => {
        calls++;
        return calls === 1
          ? new Response('missing', { status: 404 })
          : new Response('<html>shell</html>', { headers: { 'Content-Type': 'text/html' } });
      },
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/missing.png'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(meteredRequestType(analyticsWrites)).toBe('static');
  });
});
