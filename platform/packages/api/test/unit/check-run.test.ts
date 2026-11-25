import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ApiEnv } from '../../src/env.ts';
import { completeCheckRun, createCheckRun } from '../../src/github/check-run.ts';

// Decision: A real RS256 PKCS#8 key, so the real getInstallationToken -> createAppJwt -> sign path runs.
// The integration suite mocks that module, so only this unit test covers the real mint and retry.
let PRIVATE_KEY_PEM: string;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  PRIVATE_KEY_PEM = await exportPKCS8(pair.privateKey);
});

function makeEnv(): ApiEnv['Bindings'] {
  return {
    GITHUB_APP_ID: '123456',
    GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
  } as unknown as ApiEnv['Bindings'];
}

const REPO = 'octocat/hello-world';
const HEAD_SHA = 'a'.repeat(40);
const BUILD_ID = 'build-123';
const CHECK_RUN_ID = '99001';

function urlOf(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function methodOf(input: string | URL | Request, init?: RequestInit): string {
  if (input instanceof Request) {
    return input.method;
  }
  return (init?.method ?? 'GET').toUpperCase();
}

function isTokenMint(url: string): boolean {
  return url.includes('/access_tokens');
}

function isCheckRun(url: string): boolean {
  return url.includes('/check-runs');
}

function accessTokenOk(): Response {
  return Response.json({
    token: 'minted-installation-token',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
}

function warnObjects(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const call of spy.mock.calls) {
    const arg = call[0];
    if (typeof arg !== 'string') {
      continue;
    }
    try {
      out.push(JSON.parse(arg) as Record<string, unknown>);
    } catch {}
  }
  return out;
}

function reasonsOf(spy: ReturnType<typeof vi.spyOn>, phase: string): Array<unknown> {
  return warnObjects(spy)
    .filter((o) => o.area === 'github' && o.phase === phase)
    .map((o) => o.reason);
}

function skipRetryDelay(): void {
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
    schedule(callback, delay === 250 ? 0 : delay, ...args),
  );
}

describe('createCheckRun', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  // Decision: Each test gets its own installation id: getInstallationToken caches the token per id for the
  // isolate, so a shared id would let one test's token satisfy the mint in another.
  let installId = 0;
  function nextInstallId(): string {
    installId += 1;
    return `inst-create-${installId}`;
  }

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    skipRetryDelay();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function callCreate(installationId: string): Promise<string | null> {
    return createCheckRun(makeEnv(), installationId, REPO, {
      name: 'Platform Build',
      headSha: HEAD_SHA,
      externalId: BUILD_ID,
      detailsUrl: 'https://example.com/build/123',
      title: 'Building',
      summary: 'Build in progress',
    });
  }

  it('returns the id as a string and POSTs the in_progress body', async () => {
    const installationId = nextInstallId();
    let postBody: Record<string, unknown> | undefined;
    let postCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          expect(methodOf(input, init)).toBe('POST');
          postCount += 1;
          postBody = JSON.parse(init!.body as string) as Record<string, unknown>;
          return Response.json({ id: 99_001 }, { status: 201 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callCreate(installationId);

    expect(result).toBe('99001');
    expect(postCount).toBe(1);
    expect(postBody).toBeDefined();
    expect(postBody!.status).toBe('in_progress');
    expect(postBody!.head_sha).toBe(HEAD_SHA);
    expect(postBody!.external_id).toBe(BUILD_ID);
    expect(postBody!.name).toBe('Platform Build');
    expect(postBody!.details_url).toBe('https://example.com/build/123');
    expect(postBody!.output).toEqual({ title: 'Building', summary: 'Build in progress' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns null with no retry on a 4xx and logs one failure', async () => {
    const installationId = nextInstallId();
    let postCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          postCount += 1;
          return new Response('Not Found', { status: 404, statusText: 'Not Found' });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callCreate(installationId);

    expect(result).toBeNull();
    expect(postCount).toBe(1);
    const reasons = reasonsOf(warnSpy, 'check-run-create');
    expect(reasons.filter((r) => r === 'http-4xx')).toHaveLength(1);
    expect(reasons).not.toContain('exhausted');
  });

  // Decision: The create POST is single-shot. It isn't idempotent, so a retry after an ambiguous 5xx or
  // network error could create a duplicate run and orphan the first `in_progress` one.
  it('does NOT retry on a 5xx — returns null after exactly one POST', async () => {
    const installationId = nextInstallId();
    let postCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          postCount += 1;
          return new Response('boom', { status: 500 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callCreate(installationId);

    expect(result).toBeNull();
    expect(postCount).toBe(1);
    const reasons = reasonsOf(warnSpy, 'check-run-create');
    expect(reasons.filter((r) => r === 'http-5xx')).toHaveLength(1);
    expect(reasons).not.toContain('exhausted');
  });

  it('does NOT retry on a network error — returns null after exactly one POST', async () => {
    const installationId = nextInstallId();
    let postCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          postCount += 1;
          throw new TypeError('network error');
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callCreate(installationId);

    expect(result).toBeNull();
    expect(postCount).toBe(1);
    const reasons = reasonsOf(warnSpy, 'check-run-create');
    expect(reasons.filter((r) => r === 'network-error')).toHaveLength(1);
    expect(reasons).not.toContain('exhausted');
  });

  it('returns null without throwing when token mint fails', async () => {
    const installationId = nextInstallId();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return new Response('bad creds', { status: 401 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callCreate(installationId);

    expect(result).toBeNull();
    const reasons = reasonsOf(warnSpy, 'check-run-create');
    expect(reasons).toContain('token-mint-failed');
    expect(reasons).toContain('exhausted');
  });
});

describe('completeCheckRun', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let installId = 0;
  function nextInstallId(): string {
    installId += 1;
    return `inst-complete-${installId}`;
  }

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    skipRetryDelay();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function callComplete(installationId: string, extra?: { text?: string }): Promise<boolean> {
    return completeCheckRun(makeEnv(), installationId, REPO, CHECK_RUN_ID, {
      conclusion: 'success',
      detailsUrl: 'https://example.com/build/123',
      title: 'Done',
      summary: 'Build succeeded',
      ...extra,
    });
  }

  it('returns true and PATCHes the completed body', async () => {
    const installationId = nextInstallId();
    let patchBody: Record<string, unknown> | undefined;
    let patchUrl: string | undefined;
    let patchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          expect(methodOf(input, init)).toBe('PATCH');
          patchCount += 1;
          patchUrl = url;
          patchBody = JSON.parse(init!.body as string) as Record<string, unknown>;
          return Response.json({ id: 99_001 }, { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId);

    expect(result).toBe(true);
    expect(patchCount).toBe(1);
    expect(patchUrl).toContain(`/check-runs/${CHECK_RUN_ID}`);
    expect(patchBody).toBeDefined();
    expect(patchBody!.status).toBe('completed');
    expect(patchBody!.conclusion).toBe('success');
    expect(patchBody!.output).toEqual({ title: 'Done', summary: 'Build succeeded' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('includes output.text in the PATCH body when text is provided', async () => {
    const installationId = nextInstallId();
    const logTail = '```\nlog line 1\nlog line 2\n```';
    let patchBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          patchBody = JSON.parse(init!.body as string) as Record<string, unknown>;
          return Response.json({ id: 99_001 }, { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId, { text: logTail });

    expect(result).toBe(true);
    expect(patchBody).toBeDefined();
    expect(patchBody!.output).toEqual({
      title: 'Done',
      summary: 'Build succeeded',
      text: logTail,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('omits the text key from output when text is not provided', async () => {
    const installationId = nextInstallId();
    let patchBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          patchBody = JSON.parse(init!.body as string) as Record<string, unknown>;
          return Response.json({ id: 99_001 }, { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId);

    expect(result).toBe(true);
    expect(patchBody).toBeDefined();
    const output = patchBody!.output as Record<string, unknown>;
    expect('text' in output).toBe(false);
    expect(output).toEqual({ title: 'Done', summary: 'Build succeeded' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('retries a persistent 5xx then returns false with an exhausted warn', async () => {
    const installationId = nextInstallId();
    let patchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          patchCount += 1;
          return new Response('boom', { status: 500 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId);

    expect(result).toBe(false);
    expect(patchCount).toBe(3);
    const reasons = reasonsOf(warnSpy, 'check-run-complete');
    expect(reasons.filter((r) => r === 'http-5xx')).toHaveLength(3);
    expect(reasons.filter((r) => r === 'exhausted')).toHaveLength(1);
  });

  it('returns false without throwing when token mint fails', async () => {
    const installationId = nextInstallId();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return new Response('bad creds', { status: 401 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId);

    expect(result).toBe(false);
    const reasons = reasonsOf(warnSpy, 'check-run-complete');
    expect(reasons).toContain('token-mint-failed');
    expect(reasons).toContain('exhausted');
  });

  // Decision: GitHub validates output.text on its side (65535 UTF-8 bytes and other content checks). The
  // complete PATCH is idempotent, so a 422 on a body with `text` is retried once without it: a
  // rejected log tail shouldn't cost the completion.
  it('retries ONCE without output.text when a 422 rejects a body that included text', async () => {
    const installationId = nextInstallId();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          const body = JSON.parse(init!.body as string) as Record<string, unknown>;
          bodies.push(body);
          if ('text' in (body.output as Record<string, unknown>)) {
            return new Response(
              '{"message":"Validation Failed: text maximum bytesize of 65535 exceeded"}',
              { status: 422, statusText: 'Unprocessable Entity' },
            );
          }
          return Response.json({ id: 99_001 }, { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId, { text: 'some rejected log tail' });

    expect(result).toBe(true);
    expect(bodies).toHaveLength(2);
    expect('text' in (bodies[0].output as Record<string, unknown>)).toBe(true);
    expect('text' in (bodies[1].output as Record<string, unknown>)).toBe(false);
    expect(bodies[1].output).toEqual({ title: 'Done', summary: 'Build succeeded' });
    expect(bodies[1].status).toBe('completed');
    expect(bodies[1].conclusion).toBe('success');
    expect(bodies[1].details_url).toBe('https://example.com/build/123');
    const reasons = reasonsOf(warnSpy, 'check-run-complete');
    expect(reasons).toEqual(['text-rejected-retry']);
  });

  it('keeps a non-422 4xx single-shot even when text was included', async () => {
    const installationId = nextInstallId();
    let patchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          patchCount += 1;
          return new Response('Forbidden', { status: 403, statusText: 'Forbidden' });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId, { text: 'a log tail' });

    expect(result).toBe(false);
    expect(patchCount).toBe(1);
    const reasons = reasonsOf(warnSpy, 'check-run-complete');
    expect(reasons).toEqual(['http-4xx']);
  });

  it('does not retry a 422 when the body never included text', async () => {
    const installationId = nextInstallId();
    let patchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          patchCount += 1;
          return new Response('{"message":"Validation Failed"}', {
            status: 422,
            statusText: 'Unprocessable Entity',
          });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId);

    expect(result).toBe(false);
    expect(patchCount).toBe(1);
    const reasons = reasonsOf(warnSpy, 'check-run-complete');
    expect(reasons).toEqual(['http-4xx']);
  });

  it('returns false after exactly two PATCHes when the text-less fallback also 422s', async () => {
    const installationId = nextInstallId();
    let patchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          patchCount += 1;
          return new Response('{"message":"Validation Failed"}', {
            status: 422,
            statusText: 'Unprocessable Entity',
          });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId, { text: 'a log tail' });

    expect(result).toBe(false);
    expect(patchCount).toBe(2);
    const reasons = reasonsOf(warnSpy, 'check-run-complete');
    expect(reasons).toEqual(['text-rejected-retry', 'http-4xx']);
  });
});
