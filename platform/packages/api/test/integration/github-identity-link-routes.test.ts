import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { calculatePKCECodeChallenge } from 'oauth4webapi';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { hmacSignState } from '../../src/auth/hmac.ts';
import type { Db } from '../../src/db.ts';
import {
  createOAuthAccount,
  getGitHubInstallationsByUser,
  getUserByOAuthAccount,
  upsertGitHubInstallation,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { githubRoutes } from '../../src/routes/github.ts';
import { githubInstallations, oauthAccounts } from '../../src/schema.ts';
import { JWT_SECRET, clearTables, createTestUser, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

// Decision: Mirrors how index.ts mounts githubRoutes. Auth is applied per route inside githubRoutes
// (link-url and link/complete are authed, the public link-callback isn't), so the only outer
// middleware sets the db.
const app = new Hono<ApiEnv>()
  .use('*', async (context, next) => {
    context.set('db', env.db);
    await next();
  })
  .route('/github', githubRoutes);

// Decision: The App's user-to-server OAuth credentials. They're present only when the App is configured for
// "Request user authorization (OAuth)". Without them the link flow returns 503.
const GITHUB_APP_USER_OAUTH_ENV = {
  GITHUB_APP_CLIENT_ID: 'Iv1.testappclientid',
  GITHUB_APP_CLIENT_SECRET: 'test-app-client-secret',
} as const;

const CODE_VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const WRONG_VERIFIER = 'ZYXWVUTSRQPONMLKJIHGFEDCBA0123456789._~-abcd';

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  // Decision: The shared clearTables helper doesn't know the github_* tables. Clear them before it removes
  // the users they reference.
  await env.db.delete(githubInstallations);
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function authedGet(jwt: string): RequestInit {
  return { method: 'GET', headers: { Authorization: `Bearer ${jwt}` } };
}

function authedPost(jwt: string, body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function mockUserOAuth(opts: { providerId: string; acceptCode?: boolean }): {
  calls: { tokenExchange: boolean; user: boolean };
  tokenExchangeBody: { current: Record<string, unknown> | null };
} {
  const calls = { tokenExchange: false, user: false };
  const tokenExchangeBody = { current: null as Record<string, unknown> | null };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('login/oauth/access_token')) {
        calls.tokenExchange = true;
        if (typeof init?.body === 'string') {
          tokenExchangeBody.current = JSON.parse(init.body) as Record<string, unknown>;
        }
        if (opts.acceptCode === false) {
          return Response.json({ error: 'bad_verification_code' });
        }
        return Response.json({ access_token: 'user-to-server-token' });
      }
      if (url.endsWith('/user')) {
        calls.user = true;
        return Response.json({ id: Number(opts.providerId) });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
  return { calls, tokenExchangeBody };
}

function decodeStateFromAuthorizeUrl(url: string): Record<string, unknown> {
  const parsed = new URL(url);
  const state = parsed.searchParams.get('state');
  if (!state) {
    throw new Error('authorize url carries no state');
  }
  const encoded = state.slice(0, state.lastIndexOf('.'));
  return JSON.parse(atob(encoded)) as Record<string, unknown>;
}

async function mintState(payload: {
  redirect: string;
  purpose?: string;
  codeChallenge: string;
  exp: number;
}): Promise<string> {
  const encoded = btoa(
    JSON.stringify({
      redirect: payload.redirect,
      purpose: payload.purpose ?? 'link',
      codeChallenge: payload.codeChallenge,
      codeChallengeMethod: 'S256',
      exp: payload.exp,
    }),
  );
  const signature = await hmacSignState(encoded, JWT_SECRET);
  return `${encoded}.${signature}`;
}

// Decision: The callback returns 200 with `location.replace("<target>")`, not a 302, because `wrangler dev`
// mangles `Location: http://localhost:*` headers (see meta/lessons.md and src/html-redirect.ts).
// The target carries the signed `link_code`.
function extractRedirectTarget(body: string): string | null {
  const match = /location\.replace\("([^"]+)"\)/.exec(body);
  return match ? match[1] : null;
}

async function runCallback(opts: {
  redirect: string;
  codeChallenge: string;
  providerId: string;
}): Promise<{ res: Response; body: string; linkCode: string | null; target: string | null }> {
  mockUserOAuth({ providerId: opts.providerId });
  const state = await mintState({
    redirect: opts.redirect,
    codeChallenge: opts.codeChallenge,
    exp: Date.now() + 10 * 60 * 1000,
  });
  const res = await app.fetch(
    new Request(
      `http://localhost/github/link-callback?code=valid-code&state=${encodeURIComponent(state)}`,
    ),
    { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
  );
  const body = await res.text();
  const target = extractRedirectTarget(body);
  const linkCode = target ? new URL(target).searchParams.get('link_code') : null;
  return { res, body, linkCode, target };
}

async function countOAuthRows(db: Db, providerId: string): Promise<number> {
  const rows = await db
    .select({ id: oauthAccounts.id })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.provider, 'github'), eq(oauthAccounts.provider_id, providerId)));
  return rows.length;
}

describe('GET /github/link-url', () => {
  it('returns a signed link url with purpose:link, the challenge, future exp, and no userId', async () => {
    const user = await createTestUser(env.db);
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const redirect = 'http://localhost:9999/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-url?redirect=${encodeURIComponent(redirect)}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);
    expect(url).toContain(`client_id=${GITHUB_APP_USER_OAUTH_ENV.GITHUB_APP_CLIENT_ID}`);

    const state = decodeStateFromAuthorizeUrl(url);
    expect(state.purpose).toBe('link');
    expect(state.codeChallenge).toBe(challenge);
    expect(state.codeChallengeMethod).toBe('S256');
    expect(state.redirect).toBe(redirect);
    expect(typeof state.exp).toBe('number');
    expect((state.exp as number) > Date.now()).toBe(true);
    // Decision: The state carries no Platform user id.
    expect('userId' in state).toBe(false);
  });

  it('rejects a non-localhost redirect', async () => {
    const user = await createTestUser(env.db);
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const redirect = 'https://evil.example.com/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-url?redirect=${encodeURIComponent(redirect)}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('fails closed (non-2xx, configured-error code) when App user OAuth is unset', async () => {
    const user = await createTestUser(env.db);
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const redirect = 'http://localhost:9999/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-url?redirect=${encodeURIComponent(redirect)}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      env,
    );

    expect(res.status).not.toBe(200);
    expect(((await res.json()) as { error: string }).error).toBe('github_oauth_not_configured');
  });

  it('requires auth', async () => {
    const res = await app.fetch(
      new Request(
        'http://localhost/github/link-url?redirect=http://localhost:1/cb&code_challenge=x',
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /github/link-callback', () => {
  it('redirects to localhost with a link_code and binds NOTHING', async () => {
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const providerId = '900000001';
    const { res, body, linkCode, target } = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('location')).toBeNull();
    expect(target).not.toBeNull();
    expect(target!.startsWith('http://localhost:9999/callback')).toBe(true);
    expect(linkCode).not.toBeNull();
    expect(body).toContain('location.replace(');

    expect(await countOAuthRows(env.db, providerId)).toBe(0);
  });

  it('rejects a forged/altered state (bad signature)', async () => {
    mockUserOAuth({ providerId: '900000002' });
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const state = await mintState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });
    // Decision: Flip the first char of the signature. It's a 43-char base64url encoding of 32 HMAC bytes, and
    // its last char carries only 2 significant bits, so flipping that one decodes to the same bytes
    // about 1 time in 4 (a flaky pass). The first char carries a full 6 bits.
    const dot = state.lastIndexOf('.');
    const sig = state.slice(dot + 1);
    const first = sig[0] === 'A' ? 'B' : 'A';
    const tampered = `${state.slice(0, dot + 1)}${first}${sig.slice(1)}`;

    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-callback?code=valid-code&state=${encodeURIComponent(tampered)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('rejects an expired state', async () => {
    mockUserOAuth({ providerId: '900000003' });
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const state = await mintState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() - 1000,
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-callback?code=valid-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('bounces github_oauth_failed to the CLI localhost when the code exchange fails', async () => {
    mockUserOAuth({ providerId: '900000004', acceptCode: false });
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const state = await mintState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-callback?code=bad-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    // Decision: State and redirect are valid, so the error goes to the CLI's localhost listener (200 and a JS
    // redirect), not JSON on the API host. Otherwise `bwf github link` hangs until its 5-minute timeout.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const target = extractRedirectTarget(await res.text());
    expect(target).not.toBeNull();
    const parsed = new URL(target!);
    expect(parsed.origin).toBe('http://localhost:9999');
    expect(parsed.searchParams.get('error')).toBe('github_oauth_failed');
    expect(parsed.searchParams.get('link_code')).toBeNull();
  });

  it('bounces the GitHub denial (no code, error param) to the CLI localhost', async () => {
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const state = await mintState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-callback?state=${encodeURIComponent(state)}&error=access_denied`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const target = extractRedirectTarget(await res.text());
    expect(target).not.toBeNull();
    const parsed = new URL(target!);
    expect(parsed.origin).toBe('http://localhost:9999');
    expect(parsed.searchParams.get('error')).toBe('access_denied');
    expect(parsed.searchParams.get('link_code')).toBeNull();
  });

  it('sends a matching redirect_uri on the token exchange', async () => {
    const { tokenExchangeBody } = mockUserOAuth({ providerId: '900000040' });
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const state = await mintState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });
    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-callback?code=valid-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(200);
    // Decision: redirect_uri comes from the link-callback request origin, not state.redirect (the CLI's
    // localhost). link-url and link-callback derive the same value.
    expect(tokenExchangeBody.current?.redirect_uri).toBe('http://localhost/github/link-callback');
  });

  it('returns 400 (not 500) for a malformed, non-base64url state signature', async () => {
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const encoded = btoa(
      JSON.stringify({
        redirect: 'http://localhost:9999/callback',
        purpose: 'link',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        exp: Date.now() + 60_000,
      }),
    );
    const malformed = `${encoded}.*`;
    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-callback?code=valid-code&state=${encodeURIComponent(malformed)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /github/link/complete', () => {
  it('binds the identity to the authed caller and returns linked', async () => {
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const providerId = '900000010';
    const { linkCode } = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });
    expect(linkCode).not.toBeNull();

    const res = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: linkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('linked');

    const owner = await getUserByOAuthAccount(env.db, 'github', providerId);
    expect(owner?.id).toBe(userA.id);
    expect(await countOAuthRows(env.db, providerId)).toBe(1);
  });

  it('is idempotent for the same caller (already_linked, still one row)', async () => {
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const providerId = '900000011';

    const first = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });
    const firstComplete = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: first.linkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );
    expect(firstComplete.status).toBe(200);
    expect(((await firstComplete.json()) as { status: string }).status).toBe('linked');

    const second = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });
    const secondComplete = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: second.linkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );
    expect(secondComplete.status).toBe(200);
    expect(((await secondComplete.json()) as { status: string }).status).toBe('already_linked');
    expect(await countOAuthRows(env.db, providerId)).toBe(1);
  });

  it('rejects a PKCE mismatch with invalid_verifier and binds nothing', async () => {
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const providerId = '900000012';
    const { linkCode } = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: linkCode, code_verifier: WRONG_VERIFIER }),
      ),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_verifier');
    expect(await countOAuthRows(env.db, providerId)).toBe(0);
  });

  it('rejects an expired link_code', async () => {
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const providerId = '900000013';
    const encoded = btoa(
      JSON.stringify({
        providerId,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        exp: Date.now() - 1000,
      }),
    );
    const signature = await hmacSignState(encoded, JWT_SECRET);
    const expiredLinkCode = `${encoded}.${signature}`;

    const res = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: expiredLinkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );

    expect(res.status).toBe(400);
    expect(await countOAuthRows(env.db, providerId)).toBe(0);
  });

  it('returns 409 when the provider id is already linked to another user', async () => {
    const userB = await createTestUser(env.db, 'bob', 'github', '900000014');
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const providerId = '900000014';

    const { linkCode } = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: linkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('github_identity_conflict');
    const owner = await getUserByOAuthAccount(env.db, 'github', providerId);
    expect(owner?.id).toBe(userB.id);
  });

  // Decision: The bind follows the completing bearer token, not the state or the user who started the flow,
  // so an attacker can only link their own id.
  it('binds the link_code to the COMPLETING token-holder, not the flow initiator', async () => {
    // Decision: Both accounts sign in with a non-github provider, so neither has a github oauth row yet.
    const attacker = await createTestUser(env.db, 'attacker', 'google', 'google-attacker');
    const completer = await createTestUser(env.db, 'completer', 'google', 'google-completer');

    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const providerId = '900000015';
    const { linkCode } = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });
    expect(linkCode).not.toBeNull();

    const res = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(completer.jwt, { link_code: linkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('linked');

    const owner = await getUserByOAuthAccount(env.db, 'github', providerId);
    expect(owner?.id).toBe(completer.id);
    expect(owner?.id).not.toBe(attacker.id);
    expect(await countOAuthRows(env.db, providerId)).toBe(1);
  });

  // Decision: RFC 0074 allows one GitHub identity per Platform account, so this is github_already_linked, a
  // 409 code distinct from github_identity_conflict (another user owns the id).
  it('returns 409 github_already_linked when the caller already linked a different github id', async () => {
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    await createOAuthAccount(env.db, userA.id, 'github', '900000020');

    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const providerId = '900000021';

    const { linkCode } = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: linkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('github_already_linked');
    expect(await countOAuthRows(env.db, providerId)).toBe(0);
  });

  it('backfills pre-existing unowned installations to the completing user on link', async () => {
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const providerId = '900000030';

    await upsertGitHubInstallation(env.db, {
      installationId: '500',
      userId: null,
      accountLogin: 'alice-gh',
      accountId: providerId,
      accountType: 'User',
      repositories: [{ full_name: 'alice-gh/app', id: 1 }],
    });

    const { linkCode } = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: linkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('linked');

    const [row] = await env.db
      .select({ userId: githubInstallations.user_id })
      .from(githubInstallations)
      .where(eq(githubInstallations.installation_id, '500'));
    expect(row?.userId).toBe(userA.id);

    const installs = await getGitHubInstallationsByUser(env.db, userA.id);
    expect(installs.map((i) => i.installation_id)).toContain('500');
  });
});
