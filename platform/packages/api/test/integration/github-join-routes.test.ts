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
import * as dbModule from '../../src/db.ts';
import {
  getGitHubInstallationsByUser,
  recordInstallationRevocations,
  upsertGitHubInstallation,
  upsertGitHubInstallationMember,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { githubRoutes } from '../../src/routes/github.ts';
import { githubInstallationMembers } from '../../src/schema.ts';
import { JWT_SECRET, clearTables, createTestUser, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

// Decision: Mirrors how index.ts mounts githubRoutes. Auth is applied per route inside githubRoutes
// (join-url and join/complete are authed, the public join-callback isn't), so the only outer
// middleware sets the db.
const app = new Hono<ApiEnv>()
  .use('*', async (context, next) => {
    context.set('db', env.db);
    await next();
  })
  .route('/github', githubRoutes);

// Decision: The App's user-to-server OAuth credentials. They're present only when the App is configured for
// "Request user authorization (OAuth)". Without them the join flow returns 503.
const GITHUB_APP_USER_OAUTH_ENV = {
  GITHUB_APP_CLIENT_ID: 'Iv1.testappclientid',
  GITHUB_APP_CLIENT_SECRET: 'test-app-client-secret',
} as const;

const CODE_VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const WRONG_VERIFIER =
  'ZYXWVUTSRQPONMLKJIHGFEDCBA0123456789._~-abcd'; /* Decision: The GitHub account id that the default `mintJoinCode` and `runJoinCallback` carry. The
   revocation tombstone is keyed by this id, not the joiner's Platform user id, so the join-flow
   revocation tests record the tombstone against it. */
const JOIN_ACCOUNT_ID = '5551234';

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
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

function mockUserJoin(opts: {
  installationIds: Array<string>;
  accountId: string;
  acceptCode?: boolean;
}): { tokenExchangeBody: { current: Record<string, unknown> | null } } {
  const tokenExchangeBody = { current: null as Record<string, unknown> | null };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('login/oauth/access_token')) {
        if (typeof init?.body === 'string') {
          tokenExchangeBody.current = JSON.parse(init.body) as Record<string, unknown>;
        }
        if (opts.acceptCode === false) {
          return Response.json({ error: 'bad_verification_code' });
        }
        return Response.json({ access_token: 'user-to-server-token' });
      }
      // Decision: Match the installations list before the `/user` id read, since `/user/installations` also
      // contains `/user`.
      if (url.includes('/user/installations')) {
        return Response.json({
          installations: opts.installationIds.map((id) => ({ id: Number(id) })),
        });
      }
      if (url.endsWith('/user')) {
        return Response.json({ id: Number(opts.accountId) });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
  return { tokenExchangeBody };
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

async function mintJoinState(payload: {
  redirect: string;
  purpose?: string;
  codeChallenge: string;
  exp: number;
}): Promise<string> {
  const encoded = btoa(
    JSON.stringify({
      redirect: payload.redirect,
      purpose: payload.purpose ?? 'join',
      codeChallenge: payload.codeChallenge,
      codeChallengeMethod: 'S256',
      exp: payload.exp,
    }),
  );
  const signature = await hmacSignState(encoded, JWT_SECRET);
  return `${encoded}.${signature}`;
}

// Decision: Forge a signed `join_code` the way the join callback mints it, so /join/complete gets a
// controllable `iat` (when GitHub access was proven) and the revocation-tombstone gate can be
// tested without racing the DB clock.
async function mintJoinCode(payload: {
  installationIds: Array<string>;
  githubAccountId?: string;
  codeChallenge: string;
  iat: number;
  exp?: number;
}): Promise<string> {
  const encoded = btoa(
    JSON.stringify({
      purpose: 'join',
      installationIds: payload.installationIds,
      githubAccountId: payload.githubAccountId ?? '5551234',
      codeChallenge: payload.codeChallenge,
      codeChallengeMethod: 'S256',
      iat: payload.iat,
      exp: payload.exp ?? Date.now() + 5 * 60 * 1000,
    }),
  );
  const signature = await hmacSignState(encoded, JWT_SECRET);
  return `${encoded}.${signature}`;
}

// Decision: The callback returns 200 with `location.replace("<target>")`, not a 302, because `wrangler dev`
// mangles `Location: http://localhost:*` headers. The target carries the signed `join_code`.
function extractRedirectTarget(body: string): string | null {
  const match = /location\.replace\("([^"]+)"\)/.exec(body);
  return match ? match[1]! : null;
}

async function runJoinCallback(opts: {
  redirect: string;
  codeChallenge: string;
  installationIds: Array<string>;
  accountId: string;
}): Promise<{ res: Response; body: string; joinCode: string | null; target: string | null }> {
  mockUserJoin({ installationIds: opts.installationIds, accountId: opts.accountId });
  const state = await mintJoinState({
    redirect: opts.redirect,
    codeChallenge: opts.codeChallenge,
    exp: Date.now() + 10 * 60 * 1000,
  });
  const res = await app.fetch(
    new Request(
      `http://localhost/github/join-callback?code=valid-code&state=${encodeURIComponent(state)}`,
    ),
    { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
  );
  const body = await res.text();
  const target = extractRedirectTarget(body);
  const joinCode = target ? new URL(target).searchParams.get('join_code') : null;
  return { res, body, joinCode, target };
}

// Decision: `accountType` defaults to 'Organization', the only account type org-share admits. Pass 'User'
// to seed a personal install for the Organization-only guard tests.
async function seedInstall(opts: {
  installationId: string;
  accountId?: string;
  accountType?: 'User' | 'Organization';
}): Promise<void> {
  await upsertGitHubInstallation(env.db, {
    installationId: opts.installationId,
    userId: null,
    accountLogin: `acct-${opts.installationId}`,
    accountId: opts.accountId ?? `500${opts.installationId}`,
    accountType: opts.accountType ?? 'Organization',
    repositories: [{ full_name: `acct-${opts.installationId}/app`, id: 1 }],
  });
}

function decodeJoinCodeInstallationIds(joinCode: string): Array<string> {
  const encoded = joinCode.slice(0, joinCode.lastIndexOf('.'));
  const payload = JSON.parse(atob(encoded)) as { installationIds?: Array<string> };
  return payload.installationIds ?? [];
}

async function countMemberRows(db: Db, installationId: string, userId: string): Promise<number> {
  const rows = await db
    .select({ id: githubInstallationMembers.id })
    .from(githubInstallationMembers)
    .where(
      and(
        eq(githubInstallationMembers.installation_id, installationId),
        eq(githubInstallationMembers.user_id, userId),
      ),
    );
  return rows.length;
}

async function countAllMemberRows(db: Db): Promise<number> {
  const rows = await db
    .select({ id: githubInstallationMembers.id })
    .from(githubInstallationMembers);
  return rows.length;
}

describe('GET /github/join-url', () => {
  it('returns a signed join url with purpose:join, the challenge, future exp, and no userId', async () => {
    const user = await createTestUser(env.db);
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const redirect = 'http://localhost:9999/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-url?redirect=${encodeURIComponent(redirect)}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);
    expect(url).toContain(`client_id=${GITHUB_APP_USER_OAUTH_ENV.GITHUB_APP_CLIENT_ID}`);

    const state = decodeStateFromAuthorizeUrl(url);
    expect(state.purpose).toBe('join');
    expect(state.codeChallenge).toBe(challenge);
    expect(state.codeChallengeMethod).toBe('S256');
    expect(state.redirect).toBe(redirect);
    expect(typeof state.exp).toBe('number');
    expect((state.exp as number) > Date.now()).toBe(true);
    // Decision: The state carries no Platform user id. The bind waits until complete.
    expect('userId' in state).toBe(false);
  });

  it('rejects a non-localhost redirect', async () => {
    const user = await createTestUser(env.db);
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const redirect = 'https://evil.example.com/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-url?redirect=${encodeURIComponent(redirect)}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('fails closed (503, github_oauth_not_configured) when App user OAuth is unset', async () => {
    const user = await createTestUser(env.db);
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const redirect = 'http://localhost:9999/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-url?redirect=${encodeURIComponent(redirect)}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      env,
    );

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('github_oauth_not_configured');
  });

  it('requires auth', async () => {
    const res = await app.fetch(
      new Request(
        'http://localhost/github/join-url?redirect=http://localhost:1/cb&code_challenge=x',
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /github/join-callback', () => {
  it('redirects to localhost with a join_code and binds NOTHING', async () => {
    await seedInstall({ installationId: '700' });
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);

    const { res, body, joinCode, target } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '5551234',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('location')).toBeNull();
    expect(target).not.toBeNull();
    expect(target!.startsWith('http://localhost:9999/callback')).toBe(true);
    expect(joinCode).not.toBeNull();
    expect(body).toContain('location.replace(');

    expect(await countAllMemberRows(env.db)).toBe(0);
  });

  // Decision: The join_code `iat` is sampled (getDbNowMs) before the GitHub access proof, so it's a
  // conservative lower bound. A removal in the gap between proof and mint (mostly GitHub's access
  // propagation lag) then has revoked_at >= iat and is rejected at /join/complete. The test checks
  // the order with spies, not timing.
  it('stamps the join_code iat via getDbNowMs BEFORE the GitHub proof', async () => {
    await seedInstall({ installationId: '700' });
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);

    const callOrder: Array<string> = [];
    const SENTINEL_IAT = 1_700_000_000_000;
    const iatSpy = vi.spyOn(dbModule, 'getDbNowMs').mockImplementation(async () => {
      callOrder.push('iat');
      return SENTINEL_IAT;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('login/oauth/access_token')) {
          callOrder.push('proof');
          return Response.json({ access_token: 'user-to-server-token' });
        }
        if (url.includes('/user/installations')) {
          return Response.json({ installations: [{ id: 700 }] });
        }
        if (url.endsWith('/user')) {
          return Response.json({ id: Number(JOIN_ACCOUNT_ID) });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const state = await mintJoinState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });
    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?code=valid-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    const body = await res.text();
    const joinCode = new URL(extractRedirectTarget(body)!).searchParams.get('join_code')!;

    expect(iatSpy).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['iat', 'proof']);
    const decoded = JSON.parse(atob(joinCode.slice(0, joinCode.lastIndexOf('.')))) as {
      iat: number;
    };
    expect(decoded.iat).toBe(SENTINEL_IAT);
  });

  it('sends a matching redirect_uri on the token exchange', async () => {
    await seedInstall({ installationId: '700' });
    const { tokenExchangeBody } = mockUserJoin({ installationIds: ['700'], accountId: '5551234' });
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const state = await mintJoinState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });
    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?code=valid-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(200);
    // Decision: redirect_uri comes from the join-callback request origin, not state.redirect (the CLI's
    // localhost). join-url and join-callback derive the same value, so GitHub's redirect_uri match
    // holds.
    expect(tokenExchangeBody.current?.redirect_uri).toBe('http://localhost/github/join-callback');
  });

  it('rejects a forged/altered state (bad signature)', async () => {
    mockUserJoin({ installationIds: ['700'], accountId: '5551234' });
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const state = await mintJoinState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });
    // Decision: Flip the first char of the signature. It carries a full 6 bits, so the decoded HMAC bytes
    // change each time and the tamper can't be a flaky no-op.
    const dot = state.lastIndexOf('.');
    const sig = state.slice(dot + 1);
    const first = sig[0] === 'A' ? 'B' : 'A';
    const tampered = `${state.slice(0, dot + 1)}${first}${sig.slice(1)}`;

    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?code=valid-code&state=${encodeURIComponent(tampered)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('rejects an expired state', async () => {
    mockUserJoin({ installationIds: ['700'], accountId: '5551234' });
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const state = await mintJoinState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() - 1000,
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?code=valid-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('rejects a link-purpose state (cross-flow replay)', async () => {
    mockUserJoin({ installationIds: ['700'], accountId: '5551234' });
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    // Decision: A validly signed state with purpose 'link' mustn't drive the join callback. The purpose field
    // blocks replay across flows.
    const state = await mintJoinState({
      redirect: 'http://localhost:9999/callback',
      purpose: 'link',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?code=valid-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 (not 500) for a malformed, non-base64url state signature', async () => {
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const encoded = btoa(
      JSON.stringify({
        redirect: 'http://localhost:9999/callback',
        purpose: 'join',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        exp: Date.now() + 60_000,
      }),
    );
    const malformed = `${encoded}.*`;
    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?code=valid-code&state=${encodeURIComponent(malformed)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(400);
  });

  it('bounces github_oauth_failed to the CLI localhost when the exchange yields no installations', async () => {
    mockUserJoin({ installationIds: ['700'], accountId: '5551234', acceptCode: false });
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const state = await mintJoinState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?code=bad-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const target = extractRedirectTarget(await res.text());
    expect(target).not.toBeNull();
    const parsed = new URL(target!);
    expect(parsed.origin).toBe('http://localhost:9999');
    expect(parsed.searchParams.get('error')).toBe('github_oauth_failed');
    expect(parsed.searchParams.get('join_code')).toBeNull();
    expect(await countAllMemberRows(env.db)).toBe(0);
  });

  it('bounces the GitHub denial (no code, error param) to the CLI localhost', async () => {
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const state = await mintJoinState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?state=${encodeURIComponent(state)}&error=access_denied`,
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
    expect(parsed.searchParams.get('join_code')).toBeNull();
  });

  // Decision: Org-share is Organization-only. A personal (account_type='User') install the caller only
  // collaborates on mustn't become a join target, because it has no member_removed revocation path.
  it('excludes a personal (account_type=User) install from the join_code eligibility', async () => {
    await seedInstall({ installationId: '700', accountType: 'Organization' });
    await seedInstall({ installationId: '701', accountType: 'User' });

    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const { joinCode } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700', '701'],
      accountId: '5551234',
    });
    expect(joinCode).not.toBeNull();

    const eligibleIds = decodeJoinCodeInstallationIds(joinCode!);
    expect(eligibleIds).toEqual(['700']);
    expect(eligibleIds).not.toContain('701');
  });
});

describe('POST /github/join/complete', () => {
  it('upserts a membership keyed on the completing token-holder and returns joined', async () => {
    const other = await createTestUser(env.db, 'other', 'github', '900000700');
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const { joinCode } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '5551234',
    });
    expect(joinCode).not.toBeNull();

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'joined', count: 1 });
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(1);
    expect(await countMemberRows(env.db, '700', other.id)).toBe(0);
  });

  // Decision: The membership binds to the completing bearer token, not to anyone named in the state or
  // join_code.
  it('binds the membership to the completing token-holder, not the flow initiator', async () => {
    const attacker = await createTestUser(env.db, 'attacker', 'google', 'google-attacker');
    const completer = await createTestUser(env.db, 'completer', 'google', 'google-completer');
    await seedInstall({ installationId: '700' });

    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const { joinCode } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '5551234',
    });
    expect(joinCode).not.toBeNull();

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(completer.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'joined', count: 1 });
    expect(await countMemberRows(env.db, '700', completer.id)).toBe(1);
    expect(await countMemberRows(env.db, '700', attacker.id)).toBe(0);
  });

  it('is idempotent — a re-run refreshes the single (install,user) row', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);

    const first = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '5551234',
    });
    const firstComplete = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: first.joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(firstComplete.status).toBe(200);
    expect(await firstComplete.json()).toEqual({ status: 'joined', count: 1 });

    const second = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '5551234',
    });
    const secondComplete = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: second.joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(secondComplete.status).toBe(200);
    expect(await secondComplete.json()).toEqual({ status: 'joined', count: 1 });

    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(1);
    expect(await countAllMemberRows(env.db)).toBe(1);
  });

  it('rejects a PKCE mismatch with invalid_verifier and binds nothing', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const { joinCode } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '5551234',
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: joinCode, code_verifier: WRONG_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_verifier');
    expect(await countAllMemberRows(env.db)).toBe(0);
  });

  it('rejects an expired join_code', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const encoded = btoa(
      JSON.stringify({
        purpose: 'join',
        installationIds: ['700'],
        githubAccountId: '5551234',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        exp: Date.now() - 1000,
      }),
    );
    const signature = await hmacSignState(encoded, JWT_SECRET);
    const expiredJoinCode = `${encoded}.${signature}`;

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: expiredJoinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
    expect(await countAllMemberRows(env.db)).toBe(0);
  });

  it('excludes installs outside the caller accessible set and installs Platform does not track', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });
    await seedInstall({ installationId: '800' });

    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const { joinCode } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700', '999'],
      accountId: '5551234',
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'joined', count: 1 });
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(1);
    expect(await countMemberRows(env.db, '800', joiner.id)).toBe(0);
    expect(await countMemberRows(env.db, '999', joiner.id)).toBe(0);
    expect(await countAllMemberRows(env.db)).toBe(1);
  });

  // Decision: The person who installed the App on an organization has no special standing. Once the
  // membership from the install callback lapses, they rejoin like any other member.
  it('lets the organization installer rejoin after their membership expires', async () => {
    const installer = await createTestUser(env.db, 'installer', 'github', '900000704');
    await seedInstall({ installationId: '700' });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '700',
      userId: installer.id,
      githubAccountId: '900000704',
      ttlSeconds: -60,
    });
    expect(await getGitHubInstallationsByUser(env.db, installer.id)).toHaveLength(0);

    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const { joinCode } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '900000704',
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(installer.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'joined', count: 1 });
    expect(await countMemberRows(env.db, '700', installer.id)).toBe(1);
    const installs = await getGitHubInstallationsByUser(env.db, installer.id);
    expect(installs.map((i) => i.installation_id)).toEqual(['700']);
  });

  it('rejects a malformed body', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: 42 }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(400);
  });

  it('requires auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/github/join/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ join_code: 'x', code_verifier: 'y' }),
      }),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(401);
  });

  it('makes the joined install visible via getGitHubInstallationsByUser', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    expect(await getGitHubInstallationsByUser(env.db, joiner.id)).toHaveLength(0);

    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const { joinCode } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '5551234',
    });
    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(200);

    const installs = await getGitHubInstallationsByUser(env.db, joiner.id);
    expect(installs.map((i) => i.installation_id)).toContain('700');
  });

  // Decision: Revocation is monotonic. A join_code minted before a recorded revocation (iat <= revoked_at)
  // is a stale artifact from a removed member and mustn't bring the membership back. The install is
  // skipped and not counted.
  it('skips an install whose join_code predates a recorded revocation (stale replay)', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    await recordInstallationRevocations(env.db, ['700'], JOIN_ACCOUNT_ID);
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const staleJoinCode = await mintJoinCode({
      installationIds: ['700'],
      codeChallenge: challenge,
      iat: Date.now() - 60_000,
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: staleJoinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'joined', count: 0 });
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(0);
  });

  // Decision: The tombstone is a high-water mark, not a permanent ban. A real re-join after a re-add mints a
  // fresh join_code (iat > revoked_at), which is honored.
  it('restores membership when the join_code post-dates the revocation (legit re-join)', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    await recordInstallationRevocations(env.db, ['700'], JOIN_ACCOUNT_ID);
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const freshJoinCode = await mintJoinCode({
      installationIds: ['700'],
      codeChallenge: challenge,
      iat: Date.now() + 60_000,
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: freshJoinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'joined', count: 1 });
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(1);
  });

  // Decision: A join_code without `iat` can't be compared with revocation tombstones, so it's rejected. Mint
  // it inline so the property is really absent (mintJoinCode would add one).
  it('rejects a join_code without iat', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const encoded = btoa(
      JSON.stringify({
        purpose: 'join',
        installationIds: ['700'],
        githubAccountId: '5551234',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        exp: Date.now() + 5 * 60 * 1000,
      }),
    );
    const signature = await hmacSignState(encoded, JWT_SECRET);
    const joinCode = `${encoded}.${signature}`;

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid join_code' });
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(0);
  });

  it.each([null, ''])('rejects a join_code with GitHub account id %j', async (githubAccountId) => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const encoded = btoa(
      JSON.stringify({
        purpose: 'join',
        installationIds: ['700'],
        githubAccountId,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        iat: Date.now(),
        exp: Date.now() + 5 * 60 * 1000,
      }),
    );
    const signature = await hmacSignState(encoded, JWT_SECRET);
    const joinCode = `${encoded}.${signature}`;

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid join_code' });
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(0);
  });

  // Decision: The tombstone read and upsert loop runs in a transaction that locks the install rows install
  // first, which serializes a concurrent member_removed. PGlite serializes transactions, so that race
  // can't be reproduced here, and there's no race test. This checks the skip result is unchanged.
  it('under the tx-wrap, a multi-install join skips the revoked install and creates the fresh one', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });
    await seedInstall({ installationId: '701' });

    await recordInstallationRevocations(env.db, ['700'], JOIN_ACCOUNT_ID);
    const challenge = await calculatePKCECodeChallenge(CODE_VERIFIER);
    const joinCode = await mintJoinCode({
      installationIds: ['700', '701'],
      codeChallenge: challenge,
      iat: Date.now() - 60_000,
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'joined', count: 1 });
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(0);
    expect(await countMemberRows(env.db, '701', joiner.id)).toBe(1);
  });
});
