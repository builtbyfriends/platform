import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import worker from '../../src/index.ts';
import { clearProxyTokenStateCache } from '../../src/proxy-token.ts';

const JWT_SECRET = 'test-secret-key';
const PROJECT = 'proj_000000000001';

async function signAiToken(projectId: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(projectId)));
  let binary = '';
  for (const byte of sig) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function createEnv(credential: Response | null) {
  return {
    AI: { run: vi.fn(), models: vi.fn(), toMarkdown: vi.fn() },
    JWT_SECRET,
    ROUTING: { get: vi.fn(async () => null), put: vi.fn(), delete: vi.fn() },
    API: {
      fetch: vi.fn(async (url: string) =>
        url.includes('/internal/credential/') && credential
          ? credential.clone()
          : Response.json({ error: 'not found' }, { status: 404 }),
      ),
    },
    CF_ACCOUNT_ID: 'test-account',
    CF_API_TOKEN: 'test-token',
    DISPATCH: { get: vi.fn() },
  };
}

function post(body: unknown): Request {
  return new Request('https://proxy/github/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const stored = () => Response.json({ token: 'ghp_secret', repositories: ['acme/widgets'] });

describe('POST /github/request', () => {
  let aiToken: string;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    aiToken = await signAiToken(PROJECT);
  });
  beforeEach(clearProxyTokenStateCache);
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('attaches the stored token and never returns it', async () => {
    const upstream = vi.fn(async () => Response.json({ number: 7 }, { status: 201 }));
    globalThis.fetch = upstream;
    const env = createEnv(stored());
    const res = await worker.fetch(
      post({
        projectId: PROJECT,
        aiToken,
        method: 'POST',
        path: '/repos/acme/widgets/pulls',
        body: { title: 'x', head: 'a', base: 'main' },
      }),
      env,
    );
    expect(res.status).toBe(201);
    expect(await res.text()).not.toContain('ghp_secret');
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/widgets/pulls');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ghp_secret');
  });

  it('refuses a repository the credential does not cover', async () => {
    globalThis.fetch = vi.fn();
    const res = await worker.fetch(
      post({ projectId: PROJECT, aiToken, path: '/repos/other/repo/pulls' }),
      createEnv(stored()),
    );
    expect(res.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    '/user',
    '/repos/acme/widgets/../../user',
    '/repos//x/y',
    'https://evil.test/repos/a/b',
  ])('refuses path %s', async (path) => {
    globalThis.fetch = vi.fn();
    const res = await worker.fetch(
      post({ projectId: PROJECT, aiToken, path }),
      createEnv(stored()),
    );
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('answers 404 when no credential is stored', async () => {
    const res = await worker.fetch(
      post({ projectId: PROJECT, aiToken, path: '/repos/acme/widgets/pulls' }),
      createEnv(null),
    );
    expect(res.status).toBe(404);
  });

  it('rejects an invalid project token', async () => {
    const res = await worker.fetch(
      post({ projectId: PROJECT, aiToken: 'bad', path: '/repos/acme/widgets/pulls' }),
      createEnv(stored()),
    );
    expect(res.status).toBe(403);
  });
});

describe('GitHub App installations', () => {
  let aiToken: string;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    aiToken = await signAiToken(PROJECT);
  });
  beforeEach(clearProxyTokenStateCache);
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uses the scope’s installation token for any repository the installation reaches', async () => {
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    globalThis.fetch = upstream;
    const env = createEnv(Response.json({ token: 'ghs_install', installation: true }));
    const res = await worker.fetch(
      post({ projectId: PROJECT, aiToken, scope: 'server_1', path: '/repos/anyone/repo/pulls' }),
      env,
    );
    expect(res.status).toBe(200);
    const [, init] = env.API.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ provider: 'github', scope: 'server_1' });
    const [, upstreamInit] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect((upstreamInit.headers as Record<string, string>).authorization).toBe(
      'Bearer ghs_install',
    );
  });

  it('forwards app operations to the API with the project bound', async () => {
    const env = createEnv(null);
    env.API.fetch.mockImplementation(async () =>
      Response.json({ url: 'https://github.com/apps/x' }),
    );
    const res = await worker.fetch(
      new Request('https://proxy/github/app', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: PROJECT,
          aiToken,
          op: 'install-url',
          scope: 'server_1',
          returnUrl: 'https://app.test/back',
          extra: 'dropped',
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const [url, init] = env.API.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api/internal/github-app/${PROJECT}`);
    expect(JSON.parse(init.body as string)).toEqual({
      op: 'install-url',
      scope: 'server_1',
      returnUrl: 'https://app.test/back',
    });
  });

  it('refuses an unknown app operation', async () => {
    const env = createEnv(null);
    const res = await worker.fetch(
      new Request('https://proxy/github/app', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: PROJECT, aiToken, op: 'token', scope: 's' }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(env.API.fetch).not.toHaveBeenCalled();
  });
});
