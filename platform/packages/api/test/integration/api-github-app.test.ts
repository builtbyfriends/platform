import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { registerOAuthClient } from '../../src/auth/oauth.ts';
import { getProjectGitHubInstallation, upsertProjectGitHubInstallation } from '../../src/db.ts';
import app from '../../src/index.ts';
import { deriveProxyInternalAuth } from '../../src/proxy-token.ts';
import type { ProxyInternalRoute } from '../../src/proxy-token.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  JWT_SECRET,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

vi.mock('../../src/github/installation-token.ts', async (original) => ({
  ...(await original<typeof import('../../src/github/installation-token.ts')>()),
  getInstallationToken: async (
    _env: unknown,
    id: string,
    opts?: { repositoryIds?: Array<string>; permissions?: Record<string, string> },
  ) =>
    opts
      ? `ghs_scoped_${id}_${opts.repositoryIds?.join(',')}_${JSON.stringify(opts.permissions)}`
      : `ghs_for_${id}`,
}));
vi.mock('../../src/github/app-jwt.ts', () => ({ createAppJwt: async () => 'app-jwt' }));
const authorized = vi.fn(async (_env: unknown, code: string, _id: string) => ({
  authorized: code === 'good',
  callerAccountId: '1',
}));
vi.mock('../../src/github/user-installations.ts', async (original) => ({
  ...(await original<typeof import('../../src/github/user-installations.ts')>()),
  authorizeInstallViaUserToken: (env: unknown, code: string, id: string) =>
    authorized(env, code, id),
}));

let env: TestEnv;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  env = await setupEnv();
  Object.assign(env, {
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'mocked',
    GITHUB_APP_SLUG: 'test-app',
  });
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes('/app/installations/')) {
      return Response.json({
        id: 77,
        account: { id: 9, login: 'acme', type: 'Organization' },
        repository_selection: 'all',
        permissions: { contents: 'write', pull_requests: 'write' },
      });
    }
    if (href === 'https://api.github.com/repos/acme/site') {
      return Response.json({ id: 5, full_name: 'acme/site' });
    }
    if (href.includes('/installation/repositories')) {
      return Response.json({
        repositories: [{ id: 5, full_name: 'acme/site', private: true, default_branch: 'main' }],
      });
    }
    return Response.json({}, { status: 404 });
  });
  return () => {
    globalThis.fetch = originalFetch;
  };
});

async function internal(route: ProxyInternalRoute, projectId: string, body: unknown) {
  return app.fetch(
    new Request(`http://localhost/internal/${route}/${projectId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-platform-proxy-internal': await deriveProxyInternalAuth(JWT_SECRET, route, projectId),
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function project() {
  const user = await createTestUser(env.db);
  return createTestProject(env.db, user.id);
}

async function installUrl(projectId: string, scope = 'server_1') {
  const res = await internal('github-app', projectId, {
    op: 'install-url',
    scope,
    returnUrl: 'https://app.test/github/callback',
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { url: string; state: string };
}

function callback(query: Record<string, string>) {
  return app.fetch(
    new Request(`http://localhost/github-app/callback?${new URLSearchParams(query)}`),
    env,
  );
}

describe('GitHub App installations for an app’s own spaces', () => {
  it('connects an installation the person can reach and sends them back with the state', async () => {
    const { id } = await project();
    const { url, state } = await installUrl(id);
    expect(new URL(url).pathname).toBe('/apps/test-app/installations/new');
    expect(new URL(url).searchParams.get('state')).toBe(state);

    const res = await callback({ state, installation_id: '77', code: 'good' });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location')!);
    expect(back.origin + back.pathname).toBe('https://app.test/github/callback');
    expect(back.searchParams.get('state')).toBe(state);
    expect(back.searchParams.get('bound')).toBe('1');
    expect(await getProjectGitHubInstallation(env.db, id, 'server_1')).toMatchObject({
      installation_id: '77',
      account_login: 'acme',
    });

    const described = await internal('github-app', id, {
      op: 'describe',
      scope: 'server_1',
      state,
    });
    expect(await described.json()).toMatchObject({
      installationId: '77',
      accountLogin: 'acme',
      repositorySelection: 'all',
      permissions: { contents: 'write' },
      matched: true,
    });
    const other = await installUrl(id);
    const stale = await internal('github-app', id, {
      op: 'describe',
      scope: 'server_1',
      state: other.state,
    });
    expect(((await stale.json()) as { matched: boolean }).matched).toBe(false);

    const repos = await internal('github-app', id, { op: 'repositories', scope: 'server_1' });
    expect(await repos.json()).toEqual({
      repositories: [{ id: 5, full_name: 'acme/site', private: true, default_branch: 'main' }],
    });

    const credential = await internal('credential', id, { provider: 'github', scope: 'server_1' });
    expect(await credential.json()).toEqual({ token: 'ghs_for_77', installation: true });
  });

  it('refuses a person who cannot reach the installation', async () => {
    const { id } = await project();
    const { state } = await installUrl(id);
    const res = await callback({ state, installation_id: '77', code: 'bad' });
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toMatch(
      /cannot access/,
    );
    expect(await getProjectGitHubInstallation(env.db, id, 'server_1')).toBeNull();
  });

  it('refuses a forged state and passes other flows’ states on to the managed-builds callback', async () => {
    const { state } = await installUrl((await project()).id);
    const forged = `${state.slice(0, state.lastIndexOf('.'))}.AAAA`;
    expect((await callback({ state: forged, installation_id: '77', code: 'good' })).status).toBe(
      400,
    );
    const theirs = `${btoa(JSON.stringify({ userId: 'u', githubAccountId: '1' }))}.sig`;
    const res = await callback({ state: theirs, installation_id: '77' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/github\/callback\?/);
  });

  it('keeps one project’s installations from another and forgets them on disconnect', async () => {
    const a = await project();
    const b = await project();
    await upsertProjectGitHubInstallation(env.db, {
      project_id: a.id,
      scope: 'server_1',
      installation_id: '77',
      account_login: 'acme',
      account_id: '9',
      state_nonce: 'n',
    });
    expect(
      (await internal('credential', b.id, { provider: 'github', scope: 'server_1' })).status,
    ).toBe(404);
    expect((await internal('github-app', b.id, { op: 'describe', scope: 'server_1' })).status).toBe(
      404,
    );
    const wrongRoute = await app.fetch(
      new Request(`http://localhost/internal/github-app/${a.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-platform-proxy-internal': await deriveProxyInternalAuth(
            JWT_SECRET,
            'credential',
            a.id,
          ),
        },
        body: JSON.stringify({ op: 'describe', scope: 'server_1' }),
      }),
      env,
    );
    expect(wrongRoute.status).toBe(403);
    await internal('github-app', a.id, { op: 'disconnect', scope: 'server_1' });
    expect(await getProjectGitHubInstallation(env.db, a.id, 'server_1')).toBeNull();
  });

  it('checks scopes and return URLs', async () => {
    const { id } = await project();
    expect((await internal('github-app', id, { op: 'describe', scope: 'a b' })).status).toBe(400);
    expect(
      (
        await internal('github-app', id, {
          op: 'install-url',
          scope: 's',
          returnUrl: 'javascript:alert(1)',
        })
      ).status,
    ).toBe(400);
  });
});

describe('GitHub App installations for a connected application', () => {
  async function client() {
    const registration = await registerOAuthClient(env.db, {
      name: 'Chat',
      operator: 'Chat Co',
      redirectUris: ['https://app.test/back'],
      scopes: ['profile'],
    });
    const basic = `Basic ${btoa(`${registration.client.id}:${registration.clientSecret}`)}`;
    return { id: registration.client.id, basic };
  }
  function call(path: 'app' | 'request', authorization: string, body: unknown) {
    return app.fetch(
      new Request(`http://localhost/app-github/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify(body),
      }),
      env,
    );
  }

  it('connects, describes and calls GitHub with the installation token', async () => {
    const a = await client();
    const b = await client();
    Object.assign(env, { PLATFORM_APP_PERSON_CLIENTS: `${a.id},${b.id}` });
    const started = await call('app', a.basic, {
      op: 'install-url',
      scope: 'server_1',
      returnUrl: 'https://app.test/github/callback',
    });
    const { state } = (await started.json()) as { state: string };
    const res = await callback({ state, installation_id: '77', code: 'good' });
    expect(new URL(res.headers.get('location')!).searchParams.get('bound')).toBe('1');

    const described = await call('app', a.basic, { op: 'describe', scope: 'server_1', state });
    expect(await described.json()).toMatchObject({ installationId: '77', matched: true });
    expect((await call('app', b.basic, { op: 'describe', scope: 'server_1' })).status).toBe(404);
    const theirs = await installUrl((await project()).id);
    const mixed = await call('app', a.basic, {
      op: 'describe',
      scope: 'server_1',
      state: theirs.state,
    });
    expect(((await mixed.json()) as { matched: boolean }).matched).toBe(false);

    const sent = await call('request', a.basic, {
      scope: 'server_1',
      method: 'post',
      path: '/repos/acme/site/pulls',
      body: { title: 't' },
    });
    expect(sent.status).toBe(404);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls.at(-1)! as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/site/pulls');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghs_for_77');
    expect(init.body).toBe('{"title":"t"}');

    for (const path of ['/user', '/repos/acme/site/../../user', '/repos/acme//x', '/repos/acme']) {
      expect((await call('request', a.basic, { scope: 'server_1', path })).status).toBe(400);
    }
    expect(
      (await call('request', b.basic, { scope: 'server_1', path: '/repos/acme/site' })).status,
    ).toBe(404);

    await call('app', a.basic, { op: 'disconnect', scope: 'server_1' });
    expect((await call('app', a.basic, { op: 'describe', scope: 'server_1' })).status).toBe(404);
  });

  it('gives a read-only token for one repository the installation reaches', async () => {
    const a = await client();
    Object.assign(env, { PLATFORM_APP_PERSON_CLIENTS: a.id });
    const started = await call('app', a.basic, {
      op: 'install-url',
      scope: 'server_1',
      returnUrl: 'https://app.test/github/callback',
    });
    const { state } = (await started.json()) as { state: string };
    await callback({ state, installation_id: '77', code: 'good' });

    const res = await call('app', a.basic, {
      op: 'clone-token',
      scope: 'server_1',
      repo: 'acme/site',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      token: 'ghs_scoped_77_5_{"contents":"read"}',
      repo: 'acme/site',
    });
    const other = await call('app', a.basic, {
      op: 'clone-token',
      scope: 'server_1',
      repo: 'acme/other',
    });
    expect(other.status).toBe(404);
    for (const repo of ['acme', '../x', 'acme/site/x', 1]) {
      expect(
        (await call('app', a.basic, { op: 'clone-token', scope: 'server_1', repo })).status,
      ).toBe(400);
    }
    expect(
      (await call('app', a.basic, { op: 'clone-token', scope: 'server_2', repo: 'acme/site' }))
        .status,
    ).toBe(404);
  });

  it('refuses a client that is not listed, and wrong credentials', async () => {
    const a = await client();
    Object.assign(env, { PLATFORM_APP_PERSON_CLIENTS: '' });
    expect((await call('app', a.basic, { op: 'describe', scope: 's' })).status).toBe(403);
    Object.assign(env, { PLATFORM_APP_PERSON_CLIENTS: a.id });
    expect(
      (await call('app', `Basic ${btoa(`${a.id}:wrong`)}`, { op: 'describe', scope: 's' })).status,
    ).toBe(401);
    expect((await call('request', '', { scope: 's', path: '/repos/a/b' })).status).toBe(401);
  });
});
