import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { DEPLOY_POST_ATTEMPTS, PlatformClient } from '../../src/cli/client.ts';
import type { ManifestOnlyDeployPayload } from '../../src/cli/client.ts';
import type { DeployManifest } from '../../src/cli/types.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

const spawnSyncMock = vi.hoisted(() => vi.fn());
const accessKeyring = vi.hoisted(() => ({
  read: vi.fn((): string | null => null),
  write: vi.fn(() => true),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: (...args: Array<unknown>) => spawnSyncMock(...args),
}));
vi.mock('../../src/cli/keyring.ts', () => ({
  readKeyringPassword: accessKeyring.read,
  writeKeyringPassword: accessKeyring.write,
}));

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = withPlatformDiscovery(fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

const apiUrl = 'https://api.test';
const projectId = 'proj_test';
const token = 'auth-token-x';

function makeClient(): PlatformClient {
  return new PlatformClient(token, { apiUrl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PlatformClient.requestUploadUrls', () => {
  it('calls deploy.uploadUrls and returns the urls map', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          urls: {
            aabbccdd: { url: 'https://r2/.../1', headers: { 'Content-Md5': 'abc==' } },
          },
        },
      }),
    );

    const client = makeClient();
    const urls = await client.requestUploadUrls(projectId, [
      { blake3: 'aabbccdd', md5: '11223344', size: 17, contentType: 'text/plain' },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/rpc/deploy.uploadUrls`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    // Decision: The version header lets the platform's cliVersionGate middleware refuse stale CLIs cleanly
    // (HTTP 426 + cli_outdated). It has to look like a semver triplet; the exact value comes from
    // package.json.
    expect(headers['X-Platform-CLI-Version']).toMatch(/^\d+\.\d+\.\d+/);

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      projectId,
      assets: [{ blake3: 'aabbccdd', md5: '11223344', size: 17, contentType: 'text/plain' }],
    });

    expect(urls).toEqual({
      aabbccdd: { url: 'https://r2/.../1', headers: { 'Content-Md5': 'abc==' } },
    });
  });
});

describe('PlatformClient.requestWorkerUploadUrls', () => {
  const modules = [
    { name: 'index.js', size: 18, sha256: 'a'.repeat(64) },
    { name: 'chunks/b.js', size: 4, sha256: 'b'.repeat(64) },
  ];
  const urls = [
    { url: 'https://r2/worker/0', headers: { 'Content-Type': 'application/javascript' } },
    { url: 'https://r2/worker/1', headers: { 'Content-Type': 'application/javascript' } },
  ];

  it('POSTs the modules in order and returns the upload id and URLs', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'wup_1', urls } }));

    await expect(makeClient().requestWorkerUploadUrls(projectId, modules)).resolves.toEqual({
      id: 'wup_1',
      urls,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/rpc/deploy.workerUploadUrls`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(init.body as string)).toEqual({ projectId, modules });
  });

  it("shows the platform's message when the Worker is over the size limit", async () => {
    const message = 'This Worker is 70 MB without source maps. Cloudflare allows at most 64 MiB.';
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'WORKER_TOO_LARGE', message } }, 413),
    );

    const request = makeClient().requestWorkerUploadUrls(projectId, modules);
    await expect(request).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 413,
      code: 'worker_too_large',
    });
    await expect(request).rejects.toThrow(message);
  });

  it.each([
    ['without an id', { urls }],
    ['with fewer URLs than modules', { id: 'wup_1', urls: urls.slice(1) }],
    ['with a malformed URL entry', { id: 'wup_1', urls: [urls[0], { url: 'https://r2/x' }] }],
  ])('rejects a response %s', async (_label, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: body }));
    await expect(makeClient().requestWorkerUploadUrls(projectId, modules)).rejects.toThrow(
      'Invalid worker upload URLs from platform.',
    );
  });
});

describe('PlatformClient.getMigrationStatus', () => {
  it('passes the dialect query parameter when provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ applied: [] }));

    const client = makeClient();
    await client.getMigrationStatus(projectId, 'postgresql');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(`${apiUrl}/projects/${projectId}/migrations?dialect=postgresql`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
  });
});

describe('PlatformClient.finalizeDeploy', () => {
  const baseManifest: DeployManifest = {
    version: 3,
    assetManifestVersion: 2,
    bindings: {},
    type: 'spa',
    assetConfig: { not_found_handling: 'single-page-application' },
  };

  function makePayload(): ManifestOnlyDeployPayload {
    return {
      manifest: baseManifest,
      assetManifest: {
        '/index.html': {
          blake3: 'a'.repeat(32),
          md5: 'b'.repeat(32),
          size: 12,
          hash: 'a'.repeat(32),
        },
      },
      source: 'manual',
      commit: null,
      repositoryUrl: null,
      commitUrl: null,
      gitRef: null,
      preflight: 'true',
    };
  }

  const done = {
    event: 'done',
    deployment: 'dpl_durable',
    url: 'https://durable.void.app',
    urls: ['https://durable.void.app'],
    assets: 1,
    workers: 0,
    published: false,
  };

  function accepted(deploymentId = 'dpl_durable'): Response {
    return jsonResponse({ data: { deploymentId } });
  }

  function eventPage(events: Array<{ seq: number; event: unknown }>, terminal = true): Response {
    return jsonResponse({
      data: {
        deploymentId: 'dpl_durable',
        events,
        lastSeq: events.at(-1)?.seq ?? 0,
        terminal,
      },
    });
  }

  function rpcError(code: string, message: string, status: number): Response {
    return jsonResponse({ error: { code, message } }, status);
  }

  function finalizeCalls(): Array<[string, RequestInit]> {
    return (fetchMock.mock.calls as Array<[string, RequestInit]>).filter(([url]) =>
      String(url).endsWith('/rpc/deploy.finalize'),
    );
  }

  async function collectDeploy(): Promise<Array<unknown>> {
    const events: Array<unknown> = [];
    for await (const event of makeClient().finalizeDeploy(projectId, makePayload())) {
      events.push(event);
    }
    return events;
  }

  it('calls deploy.finalize with the manifest, then follows the deployment to its result', async () => {
    fetchMock
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        eventPage(
          [{ seq: 1, event: { event: 'asset_upload', total: 1, new: 0, cached: 1 } }],
          false,
        ),
      )
      .mockResolvedValueOnce(eventPage([{ seq: 2, event: done }]));

    expect(await collectDeploy()).toEqual([
      { event: 'start', deploymentId: 'dpl_durable' },
      { event: 'asset_upload', total: 1, new: 0, cached: 1 },
      done,
    ]);

    const [url, init] = finalizeCalls()[0]!;
    expect(url).toBe(`${apiUrl}/rpc/deploy.finalize`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    const body = JSON.parse(init.body as string);
    expect(body.projectId).toBe(projectId);
    expect(body.body.manifest).toEqual(baseManifest);
    expect(body.body.preflight).toBe('true');
    expect(body.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(fetchMock.mock.calls.slice(1).map(([u]) => String(u))).toEqual([
      `${apiUrl}/rpc/deployments.events`,
      `${apiUrl}/rpc/deployments.events`,
    ]);
  });

  it('retries a transport-level rejection with backoff and the same idempotency key', async () => {
    vi.useFakeTimers();
    let posts = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/rpc/deploy.finalize')) {
        posts++;
        return posts === 1
          ? Promise.reject(
              new TypeError('fetch failed', {
                cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
              }),
            )
          : Promise.resolve(accepted());
      }
      return Promise.resolve(eventPage([{ seq: 1, event: done }]));
    });
    const cliLog = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      path: '/tmp/test.jsonl',
      close: vi.fn(),
    };
    try {
      const events: Array<unknown> = [];
      const consume = (async () => {
        for await (const event of new PlatformClient(token, { apiUrl, cliLog }).finalizeDeploy(
          projectId,
          makePayload(),
        )) {
          events.push(event);
        }
      })();
      await vi.runAllTimersAsync();
      await consume;

      const calls = finalizeCalls();
      expect(calls).toHaveLength(2);
      const keys = calls.map(([, init]) => JSON.parse(init.body as string).idempotencyKey);
      expect(keys[0]).toBe(keys[1]);
      expect(events).toEqual([{ event: 'start', deploymentId: 'dpl_durable' }, done]);
      expect(cliLog.warn).toHaveBeenCalledWith(
        'deploy_fetch_retry',
        expect.objectContaining({ attempt: 1, delayMs: 1000 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('chooses a new idempotency key for each invocation', async () => {
    fetchMock
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(eventPage([{ seq: 1, event: done }]))
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(eventPage([{ seq: 1, event: done }]));
    await collectDeploy();
    await collectDeploy();
    const [first, second] = finalizeCalls().map(
      ([, init]) => JSON.parse(init.body as string).idempotencyKey,
    );
    expect(first).not.toBe(second);
  });

  it('does not retry non-transport rejections (e.g. AbortError)', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await expect(collectDeploy()).rejects.toThrow('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the bounded number of transport retries', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    try {
      const assertion = expect(collectDeploy()).rejects.toThrow('fetch failed');
      await vi.runAllTimersAsync();
      await assertion;
      expect(finalizeCalls()).toHaveLength(DEPLOY_POST_ATTEMPTS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces an in-progress deployment as an error event without retrying', async () => {
    fetchMock.mockResolvedValueOnce(
      rpcError('DEPLOY_IN_PROGRESS', 'deploy in progress: deployment dpl_old', 409),
    );
    const events = await collectDeploy();
    expect(events).toEqual([
      {
        event: 'error',
        step: 'finalize',
        message: expect.stringContaining('deployment dpl_old'),
      },
    ]);
    expect(finalizeCalls()).toHaveLength(1);
  });

  it('throws the platform error for a 409 that names no deployment', async () => {
    fetchMock.mockResolvedValueOnce(
      rpcError('DEPLOY_CONFLICT', 'the deploy conflicts with the project state', 409),
    );
    await expect(collectDeploy()).rejects.toMatchObject({ name: 'PlatformApiError', status: 409 });
  });

  it('does not retry HTTP error responses — the platform answered', async () => {
    fetchMock.mockResolvedValueOnce(rpcError('DEPLOY_UNAVAILABLE', 'deploys are unavailable', 503));
    await expect(collectDeploy()).rejects.toMatchObject({ name: 'PlatformApiError', status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serializes workerFiles as base64 in the JSON body', async () => {
    fetchMock
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(eventPage([{ seq: 1, event: done }]));
    const payload = makePayload();
    payload.workerFiles = { 'index.mjs': Buffer.from('export default {};').toString('base64') };
    const events = [];
    for await (const event of makeClient().finalizeDeploy(projectId, payload)) {
      events.push(event);
    }
    const body = JSON.parse(finalizeCalls()[0]![1].body as string).body;
    expect(body.workerFiles).toEqual({
      'index.mjs': Buffer.from('export default {};').toString('base64'),
    });
  });

  it('rejects a malformed deployment receipt without observing it', async () => {
    fetchMock.mockResolvedValueOnce(accepted('not a valid id!'));
    await expect(collectDeploy()).rejects.toThrow('Invalid deployment receipt from platform.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries transient observation errors from the same cursor and consumes partial pages', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(eventPage([{ seq: 2, event: { event: 'worker_readiness' } }], false))
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, 429))
      .mockResolvedValueOnce(
        eventPage([{ seq: 3, event: { event: 'worker_upload', modules: 1 } }], false),
      )
      .mockResolvedValueOnce(eventPage([{ seq: 4, event: done }]));
    try {
      const result = collectDeploy();
      await vi.runAllTimersAsync();
      expect(await result).toEqual([
        { event: 'start', deploymentId: 'dpl_durable' },
        { event: 'worker_readiness' },
        { event: 'worker_upload', modules: 1 },
        done,
      ]);
      expect(
        fetchMock.mock.calls.slice(1).map(([, init]) => JSON.parse(init.body as string).since),
      ).toEqual([0, 2, 2, 2, 3]);
      expect(finalizeCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([401, 403, 404, 426])(
    'preserves fatal observation HTTP %i without retrying or redeploying',
    async (status) => {
      fetchMock
        .mockResolvedValueOnce(accepted())
        .mockResolvedValueOnce(
          jsonResponse(
            { error: 'observation denied', message: 'Actionable platform message.' },
            status,
          ),
        );
      await expect(collectDeploy()).rejects.toMatchObject({
        name: 'PlatformApiError',
        status,
        message: expect.stringContaining('Actionable platform message.'),
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(finalizeCalls()).toHaveLength(1);
    },
  );

  it('bounds consecutive observation retries and retains the final platform error', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(accepted())
      .mockImplementation(async () => jsonResponse({ error: 'unavailable' }, 503));
    try {
      const assertion = expect(collectDeploy()).rejects.toMatchObject({
        name: 'PlatformApiError',
        status: 503,
      });
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(7);
      expect(finalizeCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a persisted cancellation error instead of reporting successful acceptance', async () => {
    const canceled = { event: 'error', step: 'canceling', message: 'deployment canceled' };
    fetchMock
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(eventPage([{ seq: 1, event: canceled }]));
    expect(await collectDeploy()).toEqual([
      { event: 'start', deploymentId: 'dpl_durable' },
      canceled,
    ]);
    expect(finalizeCalls()).toHaveLength(1);
  });

  it('bounds observation of a platform that never reports completion', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    fetchMock.mockResolvedValueOnce(accepted()).mockImplementation(async () => {
      vi.setSystemTime(startedAt + 30 * 60_000);
      return eventPage([], false);
    });
    try {
      const assertion = expect(collectDeploy()).rejects.toThrow(
        'Timed out observing deployment dpl_durable',
      );
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(finalizeCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { deploymentId: 'other', events: [], lastSeq: 0, terminal: true },
    { deploymentId: 'dpl_durable', events: [], lastSeq: 0, terminal: true },
  ])('fails closed on invalid observation response %#', async (page) => {
    fetchMock.mockResolvedValueOnce(accepted()).mockResolvedValueOnce(jsonResponse({ data: page }));
    await expect(collectDeploy()).rejects.toThrow(/Invalid deployment|without a terminal result/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// Decision: The deploy command keeps the CF Access service-token pair out of untrusted build children
// (through `buildEnv()` on the spawn env). That's only safe because the client captures the
// Access headers at construction and reuses them.
describe('PlatformClient CF Access header capture (survives a later env scrub)', () => {
  it('keeps sending CF-Access headers after CF_ACCESS_* are deleted from process.env', async () => {
    vi.stubEnv('PLATFORM_ACCESS_ORIGIN', 'https://api.staging.void.cloud');
    vi.stubEnv('CF_ACCESS_CLIENT_ID', 'svc-id.access');
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', 'svc-secret');
    const client = new PlatformClient(token, { apiUrl: 'https://api.staging.void.cloud' });

    vi.stubEnv('CF_ACCESS_CLIENT_ID', undefined);
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', undefined);

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { urls: {} } }));
    await client.requestUploadUrls(projectId, [
      { blake3: 'a'.repeat(32), md5: 'b'.repeat(32), size: 1, contentType: 'text/plain' },
    ]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['CF-Access-Client-Id']).toBe('svc-id.access');
    expect(headers['CF-Access-Client-Secret']).toBe('svc-secret');
  });

  it('does not send staging Access credentials to a self-hosted platform', async () => {
    vi.stubEnv('CF_ACCESS_CLIENT_ID', 'svc-id.access');
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', 'svc-secret');
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { urls: {} } }));

    await client.requestUploadUrls(projectId, [
      { blake3: 'a'.repeat(32), md5: 'b'.repeat(32), size: 1, contentType: 'text/plain' },
    ]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['CF-Access-Client-Id']).toBeUndefined();
    expect(headers['CF-Access-Client-Secret']).toBeUndefined();
  });

  it('uses a browser-renewed Access token acquired after construction', async () => {
    vi.stubEnv('CF_ACCESS_CLIENT_ID', undefined);
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', undefined);
    vi.stubEnv('PLATFORM_ACCESS_CREDENTIALS', undefined);
    vi.stubEnv('PLATFORM_ACCESS_ORIGIN', 'https://api.staging.void.cloud');
    const tokenFor = (label: string) =>
      'header.' +
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, label })).toString(
        'base64url',
      ) +
      '.signature';
    vi.stubEnv('CF_ACCESS_TOKEN', tokenFor('initial'));
    const client = new PlatformClient(token, { apiUrl: 'https://api.staging.void.cloud' });

    const renewedToken = tokenFor('renewed');
    vi.stubEnv('CF_ACCESS_TOKEN', renewedToken);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { urls: {} } }));
    await client.requestUploadUrls(projectId, [
      { blake3: 'a'.repeat(32), md5: 'b'.repeat(32), size: 1, contentType: 'text/plain' },
    ]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['cf-access-token']).toBe(renewedToken);
    expect(headers['CF-Access-Client-Id']).toBeUndefined();
  });
});

describe('PlatformClient Cloudflare Access challenge renewal', () => {
  const origin = 'https://api.example.com';
  const accessJwt = (seconds: number) =>
    `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url')}.signature`;
  let stdinTty: boolean | undefined;
  let stdoutTty: boolean | undefined;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    accessKeyring.read.mockReset().mockReturnValue(null);
    accessKeyring.write.mockReset().mockReturnValue(true);
    stdinTty = process.stdin.isTTY;
    stdoutTty = process.stdout.isTTY;
    vi.stubEnv('PLATFORM_ACCESS_ORIGIN', undefined);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTty });
  });

  it('renews a rejected human token and retries once at the original API endpoint', async () => {
    const stale = accessJwt(600);
    const fresh = accessJwt(900);
    vi.stubEnv(
      'PLATFORM_ACCESS_CREDENTIALS',
      JSON.stringify({ [origin]: { CF_ACCESS_TOKEN: stale } }),
    );
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    spawnSyncMock.mockImplementation((_command, args: Array<string>) =>
      args[1] === 'login' ? { status: 0, stdout: '' } : { status: 0, stdout: fresh },
    );
    const challengeLocation =
      'https://team.cloudflareaccess.com/cdn-cgi/access/login/api.example.com';
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: challengeLocation } }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    await expect(new PlatformClient(token, { apiUrl: origin }).listProjects()).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${origin}/rpc/projects.list`,
      `${origin}/rpc/projects.list`,
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).redirect)).toEqual([
      'manual',
      'manual',
    ]);
    const firstHeaders = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1]?.[1].headers as Record<string, string>;
    expect(firstHeaders['cf-access-token']).toBe(stale);
    expect(secondHeaders['cf-access-token']).toBe(fresh);
    expect(secondHeaders['CF-Access-Client-Id']).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => url === challengeLocation)).toBe(false);
  });

  it('does not retry ambiguous API errors', async () => {
    vi.stubEnv(
      'PLATFORM_ACCESS_CREDENTIALS',
      JSON.stringify({ [origin]: { CF_ACCESS_TOKEN: accessJwt(600) } }),
    );
    fetchMock.mockResolvedValueOnce(new Response('application failure', { status: 500 }));

    await expect(
      new PlatformClient(token, { apiUrl: origin }).listProjects(),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('does not replace a rejected scoped service credential with a human login', async () => {
    vi.stubEnv(
      'PLATFORM_ACCESS_CREDENTIALS',
      JSON.stringify({
        [origin]: { CF_ACCESS_CLIENT_ID: 'ci-client', CF_ACCESS_CLIENT_SECRET: 'ci-secret' },
      }),
    );
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const client = new PlatformClient(token, { apiUrl: origin });
    vi.stubEnv('PLATFORM_ACCESS_CREDENTIALS', undefined);
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/api.example.com',
        },
      }),
    );

    await expect(client.listProjects()).rejects.toMatchObject({ status: 302 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
