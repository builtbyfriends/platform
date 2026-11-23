import { eq } from 'drizzle-orm';
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
import { signDeployToken } from '../../src/auth/deploy-token.ts';
import { hmacSignState } from '../../src/auth/hmac.ts';
import type { Db } from '../../src/db.ts';
import {
  createGitHubConnection,
  getBuild,
  getGitHubConnection,
  getGitHubInstallation,
  getInstallationRevocationAt,
  getProjectBuilds,
  hasGitHubConnectionAuthority,
  recordInstallationRevocations,
  removeProjectMember,
  setProjectMemberRole,
  upsertGitHubInstallation,
  upsertGitHubInstallationMember,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { generateId } from '../../src/id.ts';
import { authMiddleware } from '../../src/middleware/auth.ts';
import { githubProjectRoutes, githubRoutes } from '../../src/routes/github.ts';
import { webhookRoutes } from '../../src/routes/webhooks.ts';
import {
  builds,
  githubConnections,
  githubInstallations,
  githubInstallationMembers,
  githubInstallationRevocations,
  oauthAccounts,
  projectMembers,
  projects,
} from '../../src/schema.ts';
import {
  getTestGitHubInstallationMembers,
  createTestBuild,
  JWT_SECRET,
  clearTables,
  createTestProject,
  createTestUser,
  recordingBuildManager,
  setupEnv,
  teardownEnv,
  rpcRequest,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

// Decision: The callback mints an installation token, which would otherwise need a real RS256 PKCS#8 key
// via createAppJwt. Stub it so the test only exercises the route's ownership logic; the repo list
// comes from the mocked fetch. `getInstallationAccount` (the App-JWT account lookup for
// empty-repos installs) skips createAppJwt but still hits the stubbed global fetch for
// `GET /app/installations/:id`, so the route's real fail-open/closed branching runs against a
// mocked GitHub response.
vi.mock('../../src/github/installation-token.ts', () => ({
  getInstallationToken: async () => 'test-installation-token',
  getInstallationAccount: async (_env: unknown, installationId: string) => {
    const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as {
      account?: { id?: number | string; login?: string; type?: string };
    };
    const account = data.account;
    if (!account || (typeof account.id !== 'number' && typeof account.id !== 'string')) {
      return null;
    }
    if (typeof account.login !== 'string' || account.login === '') {
      return null;
    }
    return {
      accountId: String(account.id),
      login: account.login,
      type: account.type === 'Organization' ? 'Organization' : 'User',
    };
  },
}));

let env: TestEnv;

// Decision: Mirrors how index.ts mounts the github routers, so the test doesn't depend on the parent
// integrator's wiring.
const app = new Hono<ApiEnv>()
  .use('*', async (context, next) => {
    context.set('db', env.db);
    await next();
  })
  .route('/github', githubRoutes)
  // Decision: Mounted so the proof-id deploy-close test can drive the real member_removed webhook end to end
  // (the webhook writes the tombstone) and then try the member connect against the same app.
  .route('/webhooks', webhookRoutes)
  .use('/projects/*', authMiddleware)
  .route('/projects', githubProjectRoutes);

const WEBHOOK_SECRET = 'test-webhook-secret';

async function signWebhook(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

async function postWebhook(event: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return app.fetch(
    new Request('http://localhost/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event,
        'X-Hub-Signature-256': await signWebhook(WEBHOOK_SECRET, body),
      },
      body,
    }),
    { ...env, GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET },
    {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  );
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

// Decision: The shared clearTables helper doesn't know the github_* tables. Clear them in FK-safe order
// before it removes the projects and users they reference.
async function clearGitHubTables(db: Db): Promise<void> {
  await db.delete(builds);
  await db.delete(githubConnections);
  await db.delete(githubInstallationMembers);
  await db.delete(githubInstallations);
}

beforeEach(async () => {
  await clearGitHubTables(env.db);
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function authed(jwt: string, body?: unknown): RequestInit {
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

// Decision: Minimal GitHub App env so isGitHubAppConfigured() is true. The private key isn't parsed
// because getInstallationToken is mocked above.
const GITHUB_APP_ENV = {
  GITHUB_APP_ID: '123456',
  GITHUB_APP_PRIVATE_KEY: 'unused-because-token-is-mocked',
} as const;

// Decision: Present only when the App is set to "Request user authorization (OAuth) during installation".
// The callback's org-install path is inert without these.
const GITHUB_APP_USER_OAUTH_ENV = {
  GITHUB_APP_CLIENT_ID: 'Iv1.testappclientid',
  GITHUB_APP_CLIENT_SECRET: 'test-app-client-secret',
} as const;

async function mintInstallState(userId: string, githubAccountId: string): Promise<string> {
  const encoded = btoa(JSON.stringify({ userId, githubAccountId, nonce: crypto.randomUUID() }));
  const signature = await hmacSignState(encoded, JWT_SECRET);
  return `${encoded}.${signature}`;
}

const CONNECT_VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

// Decision: Defaults produce a valid grant whose codeChallenge is S256(CONNECT_VERIFIER), so passing
// `codeVerifier: CONNECT_VERIFIER` in the body satisfies PKCE.
async function mintConnectGrant(
  overrides: {
    purpose?: string;
    installationId?: string;
    repoFullName?: string;
    repositoryId?: number;
    githubAccountId?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    iat?: number;
    exp?: number;
  } = {},
): Promise<string> {
  const encoded = btoa(
    JSON.stringify({
      purpose: overrides.purpose ?? 'connect',
      installationId: overrides.installationId ?? '3000',
      repoFullName: overrides.repoFullName ?? 'org/app',
      repositoryId: overrides.repositoryId ?? 4242,
      githubAccountId: overrides.githubAccountId ?? '5551234',
      codeChallenge:
        overrides.codeChallenge ?? (await calculatePKCECodeChallenge(CONNECT_VERIFIER)),
      codeChallengeMethod: overrides.codeChallengeMethod ?? 'S256',
      // Decision: `iat` is the moment GitHub access was proven (the connect-authorize callback). The connect gate
      // rejects a grant whose iat <= the revocation tombstone. It defaults to now so no-revocation tests
      // are inert.
      iat: overrides.iat ?? Date.now(),
      exp: overrides.exp ?? Date.now() + 5 * 60 * 1000,
    }),
  );
  const signature = await hmacSignState(encoded, JWT_SECRET);
  return `${encoded}.${signature}`;
}

async function seedMemberScenario(opts: {
  installationId: string;
  memberProvider?: string;
  memberGithubId?: string;
  membershipTtlSeconds?: number;
  repositories?: Array<{ full_name: string; id: number }>;
  repositorySelection?: 'all' | 'selected';
  status?: 'active' | 'suspended';
  seedMembership?: boolean;
  accountType?: 'User' | 'Organization';
}): Promise<{
  owner: Awaited<ReturnType<typeof createTestUser>>;
  member: Awaited<ReturnType<typeof createTestUser>>;
  project: Awaited<ReturnType<typeof createTestProject>>;
}> {
  const owner = await createTestUser(
    env.db,
    `owner-${opts.installationId}`,
    'github',
    `gh-owner-${opts.installationId}`,
  );
  const member = await createTestUser(
    env.db,
    `member-${opts.installationId}`,
    opts.memberProvider ?? 'github',
    opts.memberGithubId,
  );
  const project = await createTestProject(env.db, member.id, `gh-member-${opts.installationId}`);
  const accountType = opts.accountType ?? 'Organization';
  await upsertGitHubInstallation(env.db, {
    installationId: opts.installationId,
    userId: accountType === 'User' ? owner.id : null,
    accountLogin: 'org',
    accountId: `acc_${opts.installationId}`,
    accountType,
    repositories: opts.repositories ?? [{ full_name: 'org/app', id: 1 }],
    repositorySelection: opts.repositorySelection,
  });
  if (opts.status === 'suspended') {
    await env.db
      .update(githubInstallations)
      .set({ status: 'suspended' })
      .where(eq(githubInstallations.installation_id, opts.installationId));
  }
  if (opts.seedMembership !== false) {
    await upsertGitHubInstallationMember(env.db, {
      installationId: opts.installationId,
      userId: member.id,
      githubAccountId: opts.memberGithubId ?? 'gh_member',
      ttlSeconds: opts.membershipTtlSeconds ?? 3600,
    });
  }
  return { owner, member, project };
}

// Decision: The member connect path is gated on App user OAuth being configured, so this helper sends the
// configured env. The dedicated fail-closed test drives the unconfigured case inline with bare
// `env`.
async function memberConnect(
  member: Awaited<ReturnType<typeof createTestUser>>,
  projectId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/projects/${projectId}/github`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${member.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
  );
}

function mockInstallationRepos(owner: { login: string; id: number; type: string }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/installation/repositories')) {
        return Response.json({
          repositories: [{ full_name: `${owner.login}/app`, id: 1, owner }],
        });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
}

function mockUserAuthInstall(opts: {
  owner: { login: string; id: number; type: string };
  userInstallationIds: ReadonlyArray<number>;
  callerAccountId?: number;
  acceptCode?: boolean;
}): { calls: { tokenExchange: boolean; userInstallations: boolean; user: boolean } } {
  const calls = { tokenExchange: false, userInstallations: false, user: false };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/installation/repositories')) {
        return Response.json({
          repositories: [{ full_name: `${opts.owner.login}/app`, id: 1, owner: opts.owner }],
        });
      }
      if (url.includes('login/oauth/access_token')) {
        calls.tokenExchange = true;
        if (opts.acceptCode === false) {
          return Response.json({ error: 'bad_verification_code' });
        }
        return Response.json({ access_token: 'user-to-server-token' });
      }
      if (url.includes('/user/installations')) {
        calls.userInstallations = true;
        return Response.json({
          installations: opts.userInstallationIds.map((id) => ({ id })),
        });
      }
      // Decision: Checked after `/user/installations` so the more specific path wins.
      if (url.endsWith('/user')) {
        calls.user = true;
        return Response.json({ id: opts.callerAccountId ?? opts.owner.id });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
  return { calls };
}

function mockEmptyInstallAccount(opts: {
  account: { login: string; id: number; type: string } | null;
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/installation/repositories')) {
        return Response.json({ repositories: [] });
      }
      // Decision: Mustn't match the `/access_tokens` sub-path; that's the token mint, which is mocked.
      if (/\/app\/installations\/[^/]+$/.test(new URL(url).pathname)) {
        if (opts.account === null) {
          return new Response('boom', { status: 500 });
        }
        return Response.json({ account: opts.account });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
}

describe('POST /projects/:id/github', () => {
  it('rejects connection mutations while the project is being deleted', async () => {
    const owner = await createTestUser(env.db, 'deleting-github-owner');
    const project = await createTestProject(env.db, owner.id, 'deleting-github');
    await upsertGitHubInstallation(env.db, {
      installationId: 'deleting-111',
      userId: owner.id,
      accountLogin: owner.login,
      accountId: 'deleting-owner-account',
      accountType: 'User',
      repositories: [{ full_name: `${owner.login}/app`, id: 9101 }],
    });
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'deleting-111',
      repoFullName: `${owner.login}/app`,
      repositoryId: '9101',
      authorizedByUserId: owner.id,
    });
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const requests = [
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: 'deleting-111',
          repoFullName: `${owner.login}/app`,
        }),
      }),
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'release' }),
      }),
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${owner.jwt}` },
      }),
    ];

    for (const request of requests) {
      const response = await app.fetch(request, env);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'project is being deleted' });
    }
    expect((await getGitHubConnection(env.db, project.id))?.branch).toBe('main');
  });

  it('lets project admins manage connections while readers and collaborators can only read them', async () => {
    const owner = await createTestUser(env.db, 'team-github-owner');
    const admin = await createTestUser(env.db, 'team-github-admin');
    const collaborator = await createTestUser(env.db, 'team-github-collaborator');
    const reader = await createTestUser(env.db, 'team-github-reader');
    const project = await createTestProject(env.db, owner.id, 'team-github');
    await env.db.insert(projectMembers).values([
      {
        project_id: project.id,
        user_id: admin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: collaborator.id,
        role: 'collaborator',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: reader.id,
        role: 'reader',
        added_by_user_id: owner.id,
      },
    ]);
    await upsertGitHubInstallation(env.db, {
      installationId: 'team-111',
      userId: admin.id,
      accountLogin: admin.login,
      accountId: 'team-admin-account',
      accountType: 'User',
      repositories: [{ full_name: `${admin.login}/app`, id: 9001 }],
    });

    const connect = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: 'team-111',
          repoFullName: `${admin.login}/app`,
        }),
      }),
      env,
    );
    expect(connect.status).toBe(200);
    expect((await getGitHubConnection(env.db, project.id))?.authorized_by_user_id).toBe(admin.id);

    for (const user of [reader, collaborator]) {
      const read = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/github`, authed(user.jwt)),
        env,
      );
      expect(read.status).toBe(200);
    }

    const collaboratorPatch = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${collaborator.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ branch: 'blocked' }),
      }),
      env,
    );
    expect(collaboratorPatch.status).toBe(403);

    const adminPatch = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${admin.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'release' }),
      }),
      env,
    );
    expect(adminPatch.status).toBe(200);

    const readerDelete = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${reader.jwt}` },
      }),
      env,
    );
    expect(readerDelete.status).toBe(403);

    const adminDelete = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${admin.jwt}` },
      }),
      env,
    );
    expect(adminDelete.status).toBe(200);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('connects a project to a repo within the caller installation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-app');
    await upsertGitHubInstallation(env.db, {
      installationId: '111',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '111',
          repoFullName: 'acme/app',
          branch: 'release',
          buildExecutor: 'github_actions',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const connection = (await res.json()) as {
      project_id: string;
      installation_id: string;
      repo_full_name: string;
      branch: string;
      build_executor: string;
    };
    expect(connection.project_id).toBe(project.id);
    expect(connection.installation_id).toBe('111');
    expect(connection.repo_full_name).toBe('acme/app');
    expect(connection.branch).toBe('release');
    expect(connection.build_executor).toBe('github_actions');

    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.repo_full_name).toBe('acme/app');
  });

  // Decision: The connect handler captures the repo's immutable numeric id from the installation's cached
  // repository list so webhook and OIDC routing key on it (full_name is mutable). Without it, a
  // rename or name reuse could misroute a deploy.
  it('captures the immutable repository_id at connect time', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-repo-id');
    await upsertGitHubInstallation(env.db, {
      installationId: '112',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 4242 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '112', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.repository_id).toBe('4242');
  });

  // Decision: createGitHubConnection uses `args.branch ?? 'main'`, and `??` doesn't catch '', so an empty
  // string would be stored verbatim and no push or OIDC ref could match it: a silent dead
  // connection. PATCH rejects '' the same way.
  it('returns 400 when the branch is an empty string', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-empty-branch');
    await upsertGitHubInstallation(env.db, {
      installationId: '113',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '113', repoFullName: 'acme/app', branch: '' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid branch');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('persists a custom workflow_path (.yaml accepted)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-wf-custom');
    await upsertGitHubInstallation(env.db, {
      installationId: '211',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '211',
          repoFullName: 'acme/app',
          workflowPath: '.github/workflows/deploy.yaml',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const connection = (await res.json()) as { workflow_path: string };
    expect(connection.workflow_path).toBe('.github/workflows/deploy.yaml');
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.workflow_path).toBe('.github/workflows/deploy.yaml');
  });

  it('defaults workflow_path to the scaffolded bwf-deploy.yml when omitted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-wf-default');
    await upsertGitHubInstallation(env.db, {
      installationId: '212',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '212', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.workflow_path).toBe('.github/workflows/bwf-deploy.yml');
  });

  it('returns 400 when workflowPath is outside .github/workflows/', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-wf-badprefix');
    await upsertGitHubInstallation(env.db, {
      installationId: '213',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '213',
          repoFullName: 'acme/app',
          workflowPath: 'ci.yml',
        }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid workflowPath');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns 400 when workflowPath contains a .. traversal', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-wf-traversal');
    await upsertGitHubInstallation(env.db, {
      installationId: '214',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '214',
          repoFullName: 'acme/app',
          workflowPath: '.github/workflows/../../evil.yml',
        }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid workflowPath');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Decision: getGitHubInstallation returns suspended and deleted rows, and a `selected` install keeps its
  // cached repos, so the connect would otherwise succeed. But the build resolvers require
  // status='active', so the connection would never build.
  it('returns 409 when the installation is not active', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-suspended');
    await upsertGitHubInstallation(env.db, {
      installationId: '114',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await env.db
      .update(githubInstallations)
      .set({ status: 'suspended' })
      .where(eq(githubInstallations.installation_id, '114'));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '114', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('installation is not active');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('defaults branch to main and executor to container', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-defaults');
    await upsertGitHubInstallation(env.db, {
      installationId: '111',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '111', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const connection = (await res.json()) as { branch: string; build_executor: string };
    expect(connection.branch).toBe('main');
    expect(connection.build_executor).toBe('container');
  });

  it('returns 403 when the project belongs to another user', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const other = await createTestUser(env.db, 'other');
    const project = await createTestProject(env.db, owner.id, 'gh-403');
    await upsertGitHubInstallation(env.db, {
      installationId: '222',
      userId: other.id,
      accountLogin: 'other',
      accountId: 'acc_2',
      accountType: 'User',
      repositories: [{ full_name: 'other/app', id: 9 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${other.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '222', repoFullName: 'other/app' }),
      }),
      env,
    );

    expect(res.status).toBe(403);
  });

  it('rejects an installation that does not belong to the caller', async () => {
    const user = await createTestUser(env.db, 'caller');
    const stranger = await createTestUser(env.db, 'stranger');
    const project = await createTestProject(env.db, user.id, 'gh-foreign-install');
    await upsertGitHubInstallation(env.db, {
      installationId: '333',
      userId: stranger.id,
      accountLogin: 'stranger',
      accountId: 'acc_3',
      accountType: 'User',
      repositories: [{ full_name: 'stranger/app', id: 7 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '333', repoFullName: 'stranger/app' }),
      }),
      // Decision: The non-owner path is gated on App user OAuth; send the configured env so this test reaches the
      // membership gate (opaque 404), not the kill switch.
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(404);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('rejects a repo not accessible by the installation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-no-repo');
    await upsertGitHubInstallation(env.db, {
      installationId: '444',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_4',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '444', repoFullName: 'acme/not-granted' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Decision: An `all`-repos install covers each repo in the account, including ones not in the cached
  // `repositories` array (for example, created after install). The connect route skips array
  // membership and resolves the id live via GET /repos.
  it('connects a repo absent from the cache under an all-repos install', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-all');
    await upsertGitHubInstallation(env.db, {
      installationId: '888',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_8',
      accountType: 'User',
      repositories: [{ full_name: 'acme/old', id: 1 }],
      repositorySelection: 'all',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/repos/acme/new')) {
          return Response.json({ id: 9999 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '888', repoFullName: 'acme/new' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.repo_full_name).toBe('acme/new');
    expect(persisted?.repository_id).toBe('9999');
  });

  it('rejects a repo whose live lookup 404s under an all-repos install', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-all-404');
    await upsertGitHubInstallation(env.db, {
      installationId: '999',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_9',
      accountType: 'User',
      repositories: [{ full_name: 'acme/old', id: 1 }],
      repositorySelection: 'all',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/repos/acme/missing')) {
          return new Response('Not Found', { status: 404 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '999', repoFullName: 'acme/missing' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Decision: An unmocked fetch here would throw, so reaching 200 also proves no live lookup happens for
  // `selected` installs.
  it('uses the cached array (no live lookup) for a selected install', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-selected');
    await upsertGitHubInstallation(env.db, {
      installationId: '1010',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_10',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 5151 }],
      repositorySelection: 'selected',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '1010', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.repository_id).toBe('5151');
  });

  it('returns 409 when the project is already connected', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-dup');
    await upsertGitHubInstallation(env.db, {
      installationId: '555',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_5',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const body = { installationId: '555', repoFullName: 'acme/app' };
    const first = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(first.status).toBe(200);

    const second = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(second.status).toBe(409);
  });
});

describe('GitHub connection project-admin provenance', () => {
  it('invalidates the connection and active builds when its authorizer loses admin access', async () => {
    const owner = await createTestUser(env.db, 'provenance-owner');
    const admin = await createTestUser(env.db, 'provenance-admin');
    const project = await createTestProject(env.db, owner.id, 'provenance-project');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: admin.id,
      role: 'admin',
      added_by_user_id: owner.id,
    });
    await upsertGitHubInstallation(env.db, {
      installationId: 'provenance-install',
      userId: admin.id,
      accountLogin: admin.login,
      accountId: 'provenance-account',
      accountType: 'User',
      repositories: [{ full_name: `${admin.login}/app`, id: 9101 }],
    });
    const connection = await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'provenance-install',
      repoFullName: `${admin.login}/app`,
      repositoryId: '9101',
      authorizedByUserId: admin.id,
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: owner.id,
      executor: 'container',
      status: 'building',
    });
    expect(await hasGitHubConnectionAuthority(env.db, connection.id, project.id)).toBe(true);

    await setProjectMemberRole(env.db, {
      projectId: project.id,
      subjectUserId: admin.id,
      role: 'collaborator',
      actorUserId: owner.id,
    });

    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
    expect((await getBuild(env.db, build.id))?.status).toBe('cancelled');
  });

  it('keeps a connection reauthorized by another current admin', async () => {
    const owner = await createTestUser(env.db, 'reauthorize-owner');
    const firstAdmin = await createTestUser(env.db, 'reauthorize-first');
    const secondAdmin = await createTestUser(env.db, 'reauthorize-second');
    const project = await createTestProject(env.db, owner.id, 'reauthorize-project');
    await env.db.insert(projectMembers).values([
      {
        project_id: project.id,
        user_id: firstAdmin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: secondAdmin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      },
    ]);
    await upsertGitHubInstallation(env.db, {
      installationId: 'reauthorize-install',
      userId: secondAdmin.id,
      accountLogin: secondAdmin.login,
      accountId: 'reauthorize-account',
      accountType: 'User',
      repositories: [{ full_name: `${secondAdmin.login}/app`, id: 9201 }],
    });
    const connection = await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'reauthorize-install',
      repoFullName: `${secondAdmin.login}/app`,
      repositoryId: '9201',
      authorizedByUserId: firstAdmin.id,
    });
    await env.db
      .update(githubConnections)
      .set({ authorized_by_user_id: secondAdmin.id })
      .where(eq(githubConnections.id, connection.id));

    await removeProjectMember(env.db, {
      projectId: project.id,
      subjectUserId: firstAdmin.id,
      actorUserId: owner.id,
    });

    expect((await getGitHubConnection(env.db, project.id))?.id).toBe(connection.id);
    expect(await hasGitHubConnectionAuthority(env.db, connection.id, project.id)).toBe(true);
  });
});

// Decision: Org-shared installs (RFC 0074): a non-owner org member connects their project to a repo in an
// install owned by someone else, by redeeming a per-repo `connect_grant` minted under the
// member's own GitHub token. The grant's `repositoryId` is authoritative: the member path doesn't
// touch the installation token or the install's cached repositories (the confused-deputy close).
describe('POST /projects/:id/github — non-owner member connect grant', () => {
  it('returns opaque 404 (installation not found) for a non-member', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3001',
      memberGithubId: '5551234',
      seedMembership: false,
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3001',
      repoFullName: 'org/app',
    });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('installation not found');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Decision: No install-existence oracle. With App user OAuth unconfigured (the kill switch), a non-owner
  // non-member probing an existing active Organization install gets the same opaque 404 a
  // nonexistent installationId returns, not a 503, which would leak that the install exists. The
  // membership 404 runs before the OAuth 503, so the two are indistinguishable.
  it('oracle-closed: non-member with App user OAuth unconfigured gets 404 (not 503), same as a nonexistent install', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3050',
      memberGithubId: '5551234',
      seedMembership: false,
    });

    const existing = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${member.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '3050', repoFullName: 'org/app' }),
      }),
      env,
    );
    expect(existing.status).toBe(404);
    expect(((await existing.json()) as { error: string }).error).toBe('installation not found');

    const nonexistent = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${member.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '9999-nonexistent', repoFullName: 'org/app' }),
      }),
      env,
    );
    expect(nonexistent.status).toBe(404);
    expect(((await nonexistent.json()) as { error: string }).error).toBe('installation not found');

    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns 403 connect_authorization_required for a member with no grant', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3002',
      memberGithubId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3002',
      repoFullName: 'org/app',
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('connect_authorization_required');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns 403 connect_authorization_required when codeVerifier is missing', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3003',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({ installationId: '3003', repoFullName: 'org/app' });

    const res = await memberConnect(member, project.id, {
      installationId: '3003',
      repoFullName: 'org/app',
      connectGrant: grant,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('connect_authorization_required');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Decision: A valid grant connects, and the grant's repositoryId wins even though the installation-token or
  // cached path would give a different answer (here it would 400: the cache doesn't list the target
  // repo). Reaching 200 with the grant's id proves resolveRepositoryId and the cached lookup were
  // skipped: the confused-deputy close.
  it('connects via a valid grant and trusts the grant repositoryId (confused-deputy proof)', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3004',
      memberGithubId: '5551234',
      repositories: [{ full_name: 'org/other', id: 111 }],
      repositorySelection: 'selected',
    });
    const grant = await mintConnectGrant({
      installationId: '3004',
      repoFullName: 'org/app',
      repositoryId: 424_242,
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3004',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
      branch: 'release',
      buildExecutor: 'github_actions',
    });

    expect(res.status).toBe(200);
    const connection = (await res.json()) as {
      project_id: string;
      repo_full_name: string;
      repository_id: string;
      branch: string;
      build_executor: string;
    };
    expect(connection.project_id).toBe(project.id);
    expect(connection.repo_full_name).toBe('org/app');
    expect(connection.repository_id).toBe('424242');
    expect(connection.branch).toBe('release');
    expect(connection.build_executor).toBe('github_actions');

    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.repository_id).toBe('424242');
  });

  // Decision: Org-share connect is Organization-only, as defense in depth. Even a caller with an active
  // membership row and a valid connect_grant for a personal (account_type='User') install gets the
  // same opaque 404 as the non-member miss. The join paths can't mint a personal membership, but a
  // stale one still has to be caught here: a personal install has no member_removed revocation path.
  it('returns opaque 404 for a member connecting a personal (account_type=User) install', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3009',
      memberGithubId: '5551234',
      accountType: 'User',
    });
    const grant = await mintConnectGrant({
      installationId: '3009',
      repoFullName: 'org/app',
      repositoryId: 424_242,
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3009',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('installation not found');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Decision: The Organization-only guard doesn't touch the owner path. Owners connect directly (no JOIN, no
  // membership), and the guard lives inside `if (!isOwner)`, so a personal-account owner connecting
  // their own install still succeeds.
  it('OWNER connecting their own personal (account_type=User) install still succeeds', async () => {
    const owner = await createTestUser(env.db, 'personal-owner', 'github', 'gh-personal-owner');
    const project = await createTestProject(env.db, owner.id, 'personal-owner-proj');
    await upsertGitHubInstallation(env.db, {
      installationId: '3010',
      userId: owner.id,
      accountLogin: 'personal-owner',
      accountId: 'acc_3010',
      accountType: 'User',
      repositories: [{ full_name: 'personal-owner/app', id: 4242 }],
      repositorySelection: 'selected',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '3010', repoFullName: 'personal-owner/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect((await getGitHubConnection(env.db, project.id))?.repository_id).toBe('4242');
  });

  it('returns 409 when an organization project is already connected', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3011',
      memberGithubId: '5551234',
    });
    const connect = async () =>
      memberConnect(member, project.id, {
        installationId: '3011',
        repoFullName: 'org/app',
        connectGrant: await mintConnectGrant({
          installationId: '3011',
          repoFullName: 'org/app',
          githubAccountId: '5551234',
        }),
        codeVerifier: CONNECT_VERIFIER,
      });

    const first = await connect();
    expect(first.status).toBe(200);
    const original = await getGitHubConnection(env.db, project.id);
    expect(original?.authorized_by_user_id).toBe(member.id);

    const second = await connect();
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'project already connected' });
    expect(await getGitHubConnection(env.db, project.id)).toEqual(original);
  });

  it('returns 403 invalid connect grant when the grant is for a different repo', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3005',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      installationId: '3005',
      repoFullName: 'org/other',
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3005',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns 403 invalid connect grant when the grant is for a different installation', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3006',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      installationId: '9999',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3006',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns 403 invalid connect grant when the PKCE verifier is wrong', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3007',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      installationId: '3007',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3007',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ0',
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns 403 invalid connect grant when the grant signature is tampered', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3008',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      installationId: '3008',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });
    const dot = grant.lastIndexOf('.');
    const sig = grant.slice(dot + 1);
    const first = sig[0] === 'A' ? 'B' : 'A';
    const tampered = `${grant.slice(0, dot + 1)}${first}${sig.slice(1)}`;

    const res = await memberConnect(member, project.id, {
      installationId: '3008',
      repoFullName: 'org/app',
      connectGrant: tampered,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns 403 invalid connect grant for a non-connect purpose', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3009',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      purpose: 'join',
      installationId: '3009',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3009',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Decision: Threat L1: A starts, B authorizes in the browser, A redeems B's proof. The grant's
  // githubAccountId (B's) has to equal the redeeming caller's own linked GitHub id (A's).
  it('returns 403 invalid connect grant when grant githubAccountId != caller linked id', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3010',
      memberGithubId: '900777',
    });
    const grant = await mintConnectGrant({
      installationId: '3010',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3010',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns 403 invalid connect grant when the caller has no linked GitHub id', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3011',
      memberProvider: 'google',
      memberGithubId: 'google-nolink',
    });
    const grant = await mintConnectGrant({
      installationId: '3011',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3011',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns 403 invalid connect grant for an expired grant', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3012',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      installationId: '3012',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
      exp: Date.now() - 1000,
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3012',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Decision: The status gate runs before grant verification (the member is already authorized), so a
  // suspended install gives 409 even with a valid grant.
  it('returns 409 installation is not active for an authorized member', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3013',
      memberGithubId: '5551234',
      status: 'suspended',
    });
    const grant = await mintConnectGrant({
      installationId: '3013',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3013',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('installation is not active');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns opaque 404 when the membership has expired', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3014',
      memberGithubId: '5551234',
      membershipTtlSeconds: -3600,
    });
    const grant = await mintConnectGrant({
      installationId: '3014',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3014',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('installation not found');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Decision: Monotonic revocation: a member who kept a valid TTL membership row but whose grant was minted
  // before a revocation tombstone (iat <= revoked_at) is replaying a stale artifact from a removal.
  // The in-tx recheck rejects it with the frozen stable 'invalid connect grant', and no connection
  // is created.
  it('returns 403 invalid connect grant when the grant predates a revocation tombstone', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3015',
      memberGithubId: '5551234',
    });
    await recordInstallationRevocations(env.db, ['3015'], '5551234');
    const grant = await mintConnectGrant({
      installationId: '3015',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
      iat: Date.now() - 60_000,
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3015',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('connects when the grant post-dates the revocation tombstone (legit re-authorize)', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3016',
      memberGithubId: '5551234',
    });
    await recordInstallationRevocations(env.db, ['3016'], '5551234');
    const grant = await mintConnectGrant({
      installationId: '3016',
      repoFullName: 'org/app',
      repositoryId: 987_654,
      githubAccountId: '5551234',
      iat: Date.now() + 60_000,
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3016',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(200);
    const connection = (await res.json()) as { repository_id: string };
    expect(connection.repository_id).toBe('987654');
    expect((await getGitHubConnection(env.db, project.id))?.repository_id).toBe('987654');
  });

  // Decision: Deploy-close, end to end. The deferred-bind hole: V joins a shared install with X's browser
  // proof (membership github_account_id = X), but V's Platform account isn't oauth-linked to X. A
  // real member_removed(X) delivery runs here. X has no oauth link, so only the membership-proof-id
  // route catches V, deletes the membership, and stamps a durable tombstone for (install, V). V then
  // escalates: oauth-links X and regains membership (a re-join), but replays a pre-removal
  // connect_grant (iat < the tombstone). The connect gate's in-tx tombstone recheck rejects it.
  it('deploy-close: a proof-id sever tombstones (install, V) so a pre-removal grant cannot connect', async () => {
    const ORG = '6100';
    const INSTALL = '6100i';
    const X = '6551234';

    await createTestUser(env.db, 'f1-owner', 'github', 'gh-owner-6100');
    const v = await createTestUser(env.db, 'f1-v', 'google', 'google-f1-v');
    await upsertGitHubInstallation(env.db, {
      installationId: INSTALL,
      userId: null,
      accountLogin: 'org',
      accountId: ORG,
      accountType: 'Organization',
      repositories: [{ full_name: 'org/app', id: 1 }],
      repositorySelection: 'selected',
    });
    const project = await createTestProject(env.db, v.id, 'f1-v-proj');
    await upsertGitHubInstallationMember(env.db, {
      installationId: INSTALL,
      userId: v.id,
      githubAccountId: X,
      ttlSeconds: 3600,
    });

    const webhookRes = await postWebhook('organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(X) } },
    });
    expect(webhookRes.status).toBe(200);
    expect(
      (await getTestGitHubInstallationMembers(env.db, INSTALL)).some((m) => m.user_id === v.id),
    ).toBe(false);
    const tombstone = await getInstallationRevocationAt(env.db, INSTALL, X);
    expect(tombstone).not.toBeNull();

    await env.db.insert(oauthAccounts).values({
      id: generateId('oa'),
      user_id: v.id,
      provider: 'github',
      provider_id: X,
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: INSTALL,
      userId: v.id,
      githubAccountId: X,
      ttlSeconds: 3600,
    });
    const staleGrant = await mintConnectGrant({
      installationId: INSTALL,
      repoFullName: 'org/app',
      githubAccountId: X,
      iat: tombstone! - 60_000,
    });

    const res = await memberConnect(v, project.id, {
      installationId: INSTALL,
      repoFullName: 'org/app',
      connectGrant: staleGrant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Decision: Deploy-close, end to end. The pre-mint hole: a soon-to-be-removed org member pre-mints a
  // join_code + connect_grant carrying their GitHub id X while still in the org, without a Platform
  // user, membership or oauth link. member_removed(X) then finds an empty affected set. The
  // tombstone is keyed by X (durable, known from the payload), so the real member_removed(X) below
  // records (install, X) even with nobody to sever. After removal the attacker binds a Platform
  // account V, links X, and replays the two pre-removal artifacts (iat < the tombstone):
  // (a) /join/complete skips the install (no membership resurrected), and
  // (b) even after we force a membership to exist, the connect gate 403s and creates no connection.
  // Driving the real webhook and real redemptions proves the write-side String(X) and the read-side
  // join/grant githubAccountId are the same string form.
  it('deploy-close: a pre-mint (empty-affected-set) removal tombstones (install, X) and blocks BOTH replay gates', async () => {
    const ORG = '6200';
    const INSTALL = '6200i';
    const X = '6559999';

    await createTestUser(env.db, 't19-owner', 'github', 'gh-owner-6200');
    await upsertGitHubInstallation(env.db, {
      installationId: INSTALL,
      userId: null,
      accountLogin: 'org',
      accountId: ORG,
      accountType: 'Organization',
      repositories: [{ full_name: 'org/app', id: 1 }],
      repositorySelection: 'selected',
    });

    const T0 = Date.now() - 60_000;
    const challenge = await calculatePKCECodeChallenge(CONNECT_VERIFIER);
    const joinEncoded = btoa(
      JSON.stringify({
        purpose: 'join',
        installationIds: [INSTALL],
        githubAccountId: X,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        iat: T0,
        exp: Date.now() + 5 * 60 * 1000,
      }),
    );
    const preJoinCode = `${joinEncoded}.${await hmacSignState(joinEncoded, JWT_SECRET)}`;
    const preGrant = await mintConnectGrant({
      installationId: INSTALL,
      repoFullName: 'org/app',
      githubAccountId: X,
      iat: T0,
    });

    const webhookRes = await postWebhook('organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(X) } },
    });
    expect(webhookRes.status).toBe(200);
    expect(await webhookRes.json()).toEqual({ ok: true });
    const tombstone = await getInstallationRevocationAt(env.db, INSTALL, X);
    expect(tombstone).not.toBeNull();
    expect(tombstone!).toBeGreaterThan(T0);

    const v = await createTestUser(env.db, 't19-v', 'google', 'google-t19-v');
    await env.db.insert(oauthAccounts).values({
      id: generateId('oa'),
      user_id: v.id,
      provider: 'github',
      provider_id: X,
    });
    const project = await createTestProject(env.db, v.id, 't19-v-proj');

    const joinRes = await app.fetch(
      new Request('http://localhost/github/join/complete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${v.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ join_code: preJoinCode, code_verifier: CONNECT_VERIFIER }),
      }),
      // Decision: /join/complete is gated on App user OAuth; send the configured env so this test exercises the
      // tombstone skip, not the kill switch.
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(joinRes.status).toBe(200);
    expect(await joinRes.json()).toEqual({ status: 'joined', count: 0 });
    expect(
      (await getTestGitHubInstallationMembers(env.db, INSTALL)).some((m) => m.user_id === v.id),
    ).toBe(false);

    await upsertGitHubInstallationMember(env.db, {
      installationId: INSTALL,
      userId: v.id,
      githubAccountId: X,
      ttlSeconds: 3600,
    });
    const connectRes = await memberConnect(v, project.id, {
      installationId: INSTALL,
      repoFullName: 'org/app',
      connectGrant: preGrant,
      codeVerifier: CONNECT_VERIFIER,
    });
    expect(connectRes.status).toBe(403);
    expect(((await connectRes.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Decision: A connect_grant without `iat` can't be compared with revocation tombstones, so it's rejected
  // even when no revocation exists. Mint inline so the property is truly absent from the signed
  // payload (mintConnectGrant would inject one).
  it('returns 403 invalid connect grant when the grant carries no iat', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3019',
      memberGithubId: '5551234',
    });
    const encoded = btoa(
      JSON.stringify({
        purpose: 'connect',
        installationId: '3019',
        repoFullName: 'org/app',
        repositoryId: 4242,
        githubAccountId: '5551234',
        codeChallenge: await calculatePKCECodeChallenge(CONNECT_VERIFIER),
        codeChallengeMethod: 'S256',
        exp: Date.now() + 5 * 60 * 1000,
      }),
    );
    const signature = await hmacSignState(encoded, JWT_SECRET);
    const grantWithoutIat = `${encoded}.${signature}`;

    const res = await memberConnect(member, project.id, {
      installationId: '3019',
      repoFullName: 'org/app',
      connectGrant: grantWithoutIat,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('connects a member with a valid grant and no revocation', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3017',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      installationId: '3017',
      repoFullName: 'org/app',
      repositoryId: 555_111,
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3017',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(200);
    expect((await getGitHubConnection(env.db, project.id))?.repository_id).toBe('555111');
  });

  it('OWNER path is unaffected by a revocation tombstone', async () => {
    const owner = await createTestUser(env.db, 'owner-3018', 'github', 'gh-owner-3018');
    const project = await createTestProject(env.db, owner.id, 'owner-proj-3018');
    await upsertGitHubInstallation(env.db, {
      installationId: '3018',
      userId: owner.id,
      accountLogin: 'acme',
      accountId: 'acc_3018',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 42 }],
      repositorySelection: 'selected',
    });
    await recordInstallationRevocations(env.db, ['3018'], 'gh-owner-3018');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '3018', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect((await getGitHubConnection(env.db, project.id))?.repository_id).toBe('42');
  });

  // Decision: The App user-OAuth config is a true kill switch: the signed-artifact redemption paths (which
  // make no live GitHub call) also fail closed when the config is removed, not just the begin
  // routes. A join_code or connect_grant minted before the config disappeared stops working at once,
  // not at its TTL. The owner connect path takes no user OAuth and stays unaffected.

  it('fail-closed: /join/complete with App user OAuth unconfigured returns 503 and creates no membership', async () => {
    const INSTALL = '7100i';
    await createTestUser(env.db, 'r101-join-owner', 'github', 'gh-owner-7100');
    await upsertGitHubInstallation(env.db, {
      installationId: INSTALL,
      userId: null,
      accountLogin: 'org',
      accountId: 'acc_7100',
      accountType: 'Organization',
      repositories: [{ full_name: 'org/app', id: 1 }],
      repositorySelection: 'selected',
    });
    const caller = await createTestUser(env.db, 'r101-join-caller', 'github', 'gh-caller-7100');
    const joinEncoded = btoa(
      JSON.stringify({
        purpose: 'join',
        installationIds: [INSTALL],
        githubAccountId: 'gh-caller-7100',
        codeChallenge: await calculatePKCECodeChallenge(CONNECT_VERIFIER),
        codeChallengeMethod: 'S256',
        iat: Date.now(),
        exp: Date.now() + 5 * 60 * 1000,
      }),
    );
    const joinCode = `${joinEncoded}.${await hmacSignState(joinEncoded, JWT_SECRET)}`;

    const res = await app.fetch(
      new Request('http://localhost/github/join/complete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${caller.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ join_code: joinCode, code_verifier: CONNECT_VERIFIER }),
      }),
      env,
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'github_oauth_not_configured',
      message: 'GitHub App user OAuth is not configured',
    });
    expect(
      (await getTestGitHubInstallationMembers(env.db, INSTALL)).some(
        (m) => m.user_id === caller.id,
      ),
    ).toBe(false);
  });

  it('fail-closed: member connect with App user OAuth unconfigured returns 503 and creates no connection', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '7200',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      installationId: '7200',
      repoFullName: 'org/app',
      repositoryId: 777_001,
      githubAccountId: '5551234',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${member.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '7200',
          repoFullName: 'org/app',
          connectGrant: grant,
          codeVerifier: CONNECT_VERIFIER,
        }),
      }),
      env,
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'github_oauth_not_configured',
      message: 'GitHub App user OAuth is not configured',
    });
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('OWNER connect is UNGATED — succeeds with App user OAuth unconfigured', async () => {
    const owner = await createTestUser(env.db, 'r101-owner', 'github', 'gh-owner-7300');
    const project = await createTestProject(env.db, owner.id, 'r101-owner-proj');
    await upsertGitHubInstallation(env.db, {
      installationId: '7300',
      userId: owner.id,
      accountLogin: 'acme',
      accountId: 'acc_7300',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 4242 }],
      repositorySelection: 'selected',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '7300', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect((await getGitHubConnection(env.db, project.id))?.repository_id).toBe('4242');
  });
});

// Decision: The connect gate re-derives ownership from the install row it locks FOR UPDATE inside the
// go-live transaction, not the stale pre-tx snapshot. If a personal install's owner pointer
// changes while a connect waits on that lock, the pre-tx owner path is stale: repositoryId was
// resolved via the installation token with no member grant, so falling through to the member
// insert would be a confused deputy. The re-read fails closed (opaque 404) on the
// `isOwner && !lockedIsOwner` transition.
describe('POST /projects/:id/github — locked-row ownership re-derivation', () => {
  it('returns opaque 404 for an unlinked personal install when the caller is not a member', async () => {
    const caller = await createTestUser(env.db, 'caller-3020', 'github', 'gh-caller-3020');
    const project = await createTestProject(env.db, caller.id, 'gh-cleared-3020');
    await upsertGitHubInstallation(env.db, {
      installationId: '3020',
      userId: null,
      accountLogin: 'someone',
      accountId: 'acc_3020',
      accountType: 'User',
      repositories: [{ full_name: 'someone/app', id: 1 }],
      repositorySelection: 'selected',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${caller.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '3020', repoFullName: 'someone/app' }),
      }),
      // Decision: The non-owner path is gated on App user OAuth; send the configured env so this test reaches the
      // membership gate (opaque 404), not the kill switch.
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('installation not found');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Decision: The race branch, driven deterministically. On the owner + all-repos path the route resolves the
  // repo id via a live GET /repos fetch between the pre-tx read (isOwner=true) and the go-live
  // transaction's FOR UPDATE re-read. The stubbed fetch clears the owner pointer as a side effect,
  // so the locked read sees user_id=NULL and fails closed. The fetch is a real await point in the
  // owner path, so the locked read sees a change made after the pre-tx snapshot without a timing
  // race.
  it('fails closed (404, no connection) when the owner pointer is cleared between the pre-tx read and the locked read', async () => {
    const owner = await createTestUser(env.db, 'owner-3021', 'github', 'gh-owner-3021');
    const project = await createTestProject(env.db, owner.id, 'gh-race-3021');
    await upsertGitHubInstallation(env.db, {
      installationId: '3021',
      userId: owner.id,
      accountLogin: 'owner-3021',
      accountId: 'acc_3021',
      accountType: 'User',
      repositories: [{ full_name: 'owner-3021/old', id: 1 }],
      repositorySelection: 'all',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/repos/owner-3021/new')) {
          await env.db
            .update(githubInstallations)
            .set({ user_id: null })
            .where(eq(githubInstallations.installation_id, '3021'));
          return Response.json({ id: 9999 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '3021', repoFullName: 'owner-3021/new' }),
      }),
      env,
    );

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('installation not found');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
    expect(fetch).toHaveBeenCalled();
  });
});

// Decision: The go-live transaction re-reads the mutable install gates (status, repository_selection,
// repositories) on the row it locks FOR UPDATE, not the stale pre-tx snapshot. A teardown handler
// (installation.deleted or suspend marks status inactive; a repository-selection change de-scopes
// the repo) locks the same install row install-first, so a teardown that wins the lock first is
// seen by the waiting connect. Two tests drive that seam deterministically: on the owner +
// all-repos path `resolveRepositoryId` does a live GET /repos fetch between the pre-tx read and
// the locked re-read, so the stub mutates the install as a concurrent teardown commit would. The
// member test shows the asymmetry: the coverage re-check is owner-only, so a member's live-proved
// grant for a repo absent from the lagging cache still connects.
describe('POST /projects/:id/github — post-lock status + coverage re-check', () => {
  // Decision: installation.deleted keeps the row but marks it inactive, so the missing-row guard doesn't
  // catch it. This exercises the locked-row status gate, not the pre-tx one.
  it('rejects with 409 when the install is torn down (status→deleted) between the pre-tx read and the locked read', async () => {
    const owner = await createTestUser(env.db, 'owner-r91a', 'github', 'gh-owner-r91a');
    const project = await createTestProject(env.db, owner.id, 'gh-r91a');
    await upsertGitHubInstallation(env.db, {
      installationId: '4001',
      userId: owner.id,
      accountLogin: 'org',
      accountId: 'acc_4001',
      accountType: 'User',
      repositories: [{ full_name: 'org/old', id: 1 }],
      repositorySelection: 'all',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/repos/org/new')) {
          await env.db
            .update(githubInstallations)
            .set({ status: 'deleted' })
            .where(eq(githubInstallations.installation_id, '4001'));
          return Response.json({ id: 9999 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '4001', repoFullName: 'org/new' }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('installation is not active');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('rejects with 400 when a selection change de-scopes the repo between the pre-tx read and the locked read', async () => {
    const owner = await createTestUser(env.db, 'owner-r91b', 'github', 'gh-owner-r91b');
    const project = await createTestProject(env.db, owner.id, 'gh-r91b');
    await upsertGitHubInstallation(env.db, {
      installationId: '4002',
      userId: owner.id,
      accountLogin: 'org',
      accountId: 'acc_4002',
      accountType: 'User',
      repositories: [{ full_name: 'org/old', id: 1 }],
      repositorySelection: 'all',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/repos/org/new')) {
          await env.db
            .update(githubInstallations)
            .set({
              repository_selection: 'selected',
              repositories: [{ full_name: 'org/other', id: 7 }],
            })
            .where(eq(githubInstallations.installation_id, '4002'));
          return Response.json({ id: 9999 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '4002', repoFullName: 'org/new' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'repository not accessible by installation',
    );
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Decision: Asymmetry guard: the coverage re-check is owner-only. A member holds a grant for a repo they
  // live-proved under their own token at connect-authorize, and the install's cached `repositories`
  // can lag that proof (the installation_repositories webhook updates the cache asynchronously). If
  // a later change added the owner coverage check to the member path, this legitimate connect would
  // false-reject.
  it('MEMBER connects a repo ABSENT from the selected cache via a live-proved grant (coverage check is owner-only)', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '4003',
      memberGithubId: '5551234',
      repositories: [{ full_name: 'org/other', id: 111 }],
      repositorySelection: 'selected',
    });
    const grant = await mintConnectGrant({
      installationId: '4003',
      repoFullName: 'org/app',
      repositoryId: 909_090,
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '4003',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(200);
    expect((await getGitHubConnection(env.db, project.id))?.repository_id).toBe('909090');
  });
});

describe('GET /projects/:id/github', () => {
  it('returns the connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-get');
    await upsertGitHubInstallation(env.db, {
      installationId: '666',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_6',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '666', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, authed(user.jwt)),
      env,
    );
    expect(res.status).toBe(200);
    const connection = (await res.json()) as Record<string, unknown>;
    expect(connection.repo_full_name).toBe('acme/app');
    expect(connection).not.toHaveProperty('requires_reconnect');
  });

  it('returns 404 when there is no connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-get-404');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, authed(user.jwt)),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 for a project owned by someone else', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const other = await createTestUser(env.db, 'other');
    const project = await createTestProject(env.db, owner.id, 'gh-get-403');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, authed(other.jwt)),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe('PATCH /projects/:id/github', () => {
  it('updates branch and build executor', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch');
    await upsertGitHubInstallation(env.db, {
      installationId: '777',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_7',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '777', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'develop', buildExecutor: 'github_actions' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const updated = (await res.json()) as { branch: string; build_executor: string };
    expect(updated.branch).toBe('develop');
    expect(updated.build_executor).toBe('github_actions');
  });

  it('updates workflow_path', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-wf');
    await upsertGitHubInstallation(env.db, {
      installationId: '778',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_7',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '778', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowPath: '.github/workflows/ci.yml' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { workflow_path: string }).workflow_path).toBe(
      '.github/workflows/ci.yml',
    );
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.workflow_path).toBe('.github/workflows/ci.yml');
  });

  it('returns 400 when workflowPath is invalid on PATCH', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-wf-bad');
    await upsertGitHubInstallation(env.db, {
      installationId: '779',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_7',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '779', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowPath: 'not-under-workflows.yml' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid workflowPath');
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.workflow_path).toBe('.github/workflows/bwf-deploy.yml');
  });

  it('returns 404 when there is no connection to patch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-404');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'develop' }),
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('cancels OLD-branch in-flight builds on a branch change', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-branch');
    await upsertGitHubInstallation(env.db, {
      installationId: '780',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_b',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '780', repoFullName: 'acme/app', branch: 'main' }),
      }),
      env,
    );

    const mainBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'main',
    });
    const developBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'develop',
    });

    const { namespace, cancelledIds } = recordingBuildManager({ recordFetchCancel: true });
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'develop' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { branch: string }).branch).toBe('develop');

    expect((await getBuild(env.db, mainBuild.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, mainBuild.id))!.error).toBe('branch changed');
    expect((await getBuild(env.db, developBuild.id))!.status).toBe('building');
    expect(cancelledIds).toEqual([mainBuild.id]);
  });

  it('cancels OLD-executor in-flight builds on an executor change', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-exec');
    await upsertGitHubInstallation(env.db, {
      installationId: '781',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_e',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '781',
          repoFullName: 'acme/app',
          buildExecutor: 'container',
        }),
      }),
      env,
    );

    const containerBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });
    const actionsBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });

    const { namespace, cancelledIds } = recordingBuildManager({ recordFetchCancel: true });
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ buildExecutor: 'github_actions' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);

    expect((await getBuild(env.db, containerBuild.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, containerBuild.id))!.error).toBe('executor changed');
    expect((await getBuild(env.db, actionsBuild.id))!.status).toBe('building');
    expect(cancelledIds).toEqual([containerBuild.id]);
  });

  // Decision: A workflow_path change is a trust-boundary change: it orphans in-flight github_actions builds
  // authorized under the old pin (their deploy token stays valid while the build is active), the
  // same way branch and executor changes do. Container builds don't use the workflow gate, so they
  // keep running.
  it('cancels in-flight github_actions builds on a workflow_path change', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-workflow');
    await upsertGitHubInstallation(env.db, {
      installationId: '783',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_w',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '783',
          repoFullName: 'acme/app',
          buildExecutor: 'github_actions',
        }),
      }),
      env,
    );

    const actionsBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });
    const containerBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });

    const { namespace, cancelledIds } = recordingBuildManager({ recordFetchCancel: true });
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowPath: '.github/workflows/ci.yml' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { workflow_path: string }).workflow_path).toBe(
      '.github/workflows/ci.yml',
    );

    expect((await getBuild(env.db, actionsBuild.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, actionsBuild.id))!.error).toBe('workflow path changed');
    expect((await getBuild(env.db, containerBuild.id))!.status).toBe('building');
    expect(cancelledIds).toEqual([]);
  });

  it('cancels no builds on a no-op PATCH', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-noop');
    await upsertGitHubInstallation(env.db, {
      installationId: '782',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_n',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '782',
          repoFullName: 'acme/app',
          branch: 'main',
          buildExecutor: 'container',
        }),
      }),
      env,
    );

    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'main',
    });

    const { namespace, cancelledIds } = recordingBuildManager({ recordFetchCancel: true });
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'main', buildExecutor: 'container' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);

    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).toHaveLength(0);
  });

  // Decision: The terminate decision comes from the connection row read under the FOR UPDATE lock
  // (`current`), not a pre-tx snapshot. To prove it, connect on `main`, then re-point the branch to
  // `release` in the DB (a concurrent PATCH that committed first). A PATCH `release` -> `develop`
  // terminates the `release` build and leaves a stray `main` build; keyed off a stale `main`
  // snapshot it would cancel the wrong build.
  it('terminates builds for the LOCKED current branch, not a stale snapshot', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-locked');
    await upsertGitHubInstallation(env.db, {
      installationId: '783',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_l',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '783', repoFullName: 'acme/app', branch: 'main' }),
      }),
      env,
    );

    await env.db
      .update(githubConnections)
      .set({ branch: 'release' })
      .where(eq(githubConnections.project_id, project.id));

    const mainBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'main',
    });
    const releaseBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'release',
    });

    const { namespace, cancelledIds } = recordingBuildManager({ recordFetchCancel: true });
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'develop' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { branch: string }).branch).toBe('develop');

    expect((await getBuild(env.db, releaseBuild.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, releaseBuild.id))!.error).toBe('branch changed');
    expect((await getBuild(env.db, mainBuild.id))!.status).toBe('building');
    expect(cancelledIds).toEqual([releaseBuild.id]);
  });
});

describe('DELETE /projects/:id/github', () => {
  it('removes the connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-delete');
    await upsertGitHubInstallation(env.db, {
      installationId: '888',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_8',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '888', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns 403 when deleting a connection on another user project', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const other = await createTestUser(env.db, 'other');
    const project = await createTestProject(env.db, owner.id, 'gh-delete-403');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${other.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  // Decision: Disconnecting terminalizes all in-flight builds (queued and active, both executors). A running
  // container build already minted a BWF_TOKEN, and an active build row keeps the middleware guard
  // passing, so the container could keep publishing from a disconnected repo. Terminalizing the
  // row (to cancelled) revokes the token; the DO `/cancel` is a best-effort container teardown on
  // top. github_actions builds are terminalized too so they stop pinning a concurrency slot.
  it('terminalizes ALL in-flight builds (container + github_actions) on disconnect', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-delete-terminate');
    await upsertGitHubInstallation(env.db, {
      installationId: '889',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_9',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '889',
          repoFullName: 'acme/app',
          buildExecutor: 'github_actions',
        }),
      }),
      env,
    );

    const actionsBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      githubRunId: '1000',
    });
    const activeContainer = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });
    const queuedContainer = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'queued',
    });
    const deployingContainer = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'deploying',
    });
    const completeContainer = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
    });

    const { namespace, cancelledIds } = recordingBuildManager({ recordFetchCancel: true });
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);

    for (const id of [
      actionsBuild.id,
      activeContainer.id,
      queuedContainer.id,
      deployingContainer.id,
    ]) {
      const row = await getBuild(env.db, id);
      expect(row!.status).toBe('cancelled');
      expect(row!.completed_at).not.toBeNull();
    }
    expect((await getBuild(env.db, completeContainer.id))!.status).toBe('complete');

    const all = await getProjectBuilds(env.db, project.id);
    expect(all.filter((b) => b.status === 'cancelled').length).toBe(4);

    expect([...cancelledIds].sort()).toEqual(
      [activeContainer.id, queuedContainer.id, deployingContainer.id].sort(),
    );

    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('rejects a deploy token bound to a build that disconnect cancelled', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-delete-token');
    await upsertGitHubInstallation(env.db, {
      installationId: '890',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_10',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '890', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });
    const deployToken = await signDeployToken(
      { projectId: project.id, userId: user.id, login: user.login, buildId: build.id },
      JWT_SECRET,
    );

    const guardApp = new Hono<ApiEnv>()
      .use('*', async (context, next) => {
        context.set('db', env.db);
        await next();
      })
      .use('/rpc/*', authMiddleware)
      .post('/rpc/database.provision', (context) => context.json({ ok: true }));

    const before = await guardApp.fetch(
      rpcRequest('database.provision', deployToken, { projectId: project.id }),
      env,
    );
    expect(before.status).toBe(200);

    const del = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(del.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('cancelled');

    const after = await guardApp.fetch(
      rpcRequest('database.provision', deployToken, { projectId: project.id }),
      env,
    );
    expect(after.status).toBe(403);
  });
});

describe('GET /github/installations', () => {
  it('lists the caller installations only', async () => {
    const user = await createTestUser(env.db, 'lister');
    const other = await createTestUser(env.db, 'other-lister');
    await upsertGitHubInstallation(env.db, {
      installationId: '901',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_901',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await upsertGitHubInstallation(env.db, {
      installationId: '902',
      userId: other.id,
      accountLogin: 'other',
      accountId: 'acc_902',
      accountType: 'User',
      repositories: [],
    });

    const res = await app.fetch(
      new Request('http://localhost/github/installations', authed(user.jwt)),
      env,
    );
    expect(res.status).toBe(200);
    const installations = (await res.json()) as Array<{ installation_id: string }>;
    expect(installations).toHaveLength(1);
    expect(installations[0].installation_id).toBe('901');
  });

  it('includes an installation the caller has an active membership in', async () => {
    const userA = await createTestUser(env.db, 'member-a');
    await upsertGitHubInstallation(env.db, {
      installationId: '910',
      userId: null,
      accountLogin: 'org',
      accountId: 'acc_910',
      accountType: 'Organization',
      repositories: [{ full_name: 'org/app', id: 1 }],
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '910',
      userId: userA.id,
      githubAccountId: 'gh_a',
      ttlSeconds: 3600,
    });

    const res = await app.fetch(
      new Request('http://localhost/github/installations', authed(userA.jwt)),
      env,
    );
    expect(res.status).toBe(200);
    const installations = (await res.json()) as Array<{ installation_id: string }>;
    expect(installations).toHaveLength(1);
    expect(installations[0].installation_id).toBe('910');
  });

  it('excludes an installation the caller has no membership in', async () => {
    const userA = await createTestUser(env.db, 'stranger-a');
    await upsertGitHubInstallation(env.db, {
      installationId: '911',
      userId: null,
      accountLogin: 'org2',
      accountId: 'acc_911',
      accountType: 'Organization',
      repositories: [],
    });

    const res = await app.fetch(
      new Request('http://localhost/github/installations', authed(userA.jwt)),
      env,
    );
    expect(res.status).toBe(200);
    const installations = (await res.json()) as Array<{ installation_id: string }>;
    expect(installations).toHaveLength(0);
  });

  it('excludes an installation whose membership has expired', async () => {
    const userA = await createTestUser(env.db, 'expired-a');
    await upsertGitHubInstallation(env.db, {
      installationId: '912',
      userId: null,
      accountLogin: 'org3',
      accountId: 'acc_912',
      accountType: 'Organization',
      repositories: [],
    });
    // Decision: A negative ttl makes `now() + (-3600 * interval '1 second')` land in the past.
    await upsertGitHubInstallationMember(env.db, {
      installationId: '912',
      userId: userA.id,
      githubAccountId: 'gh_a',
      ttlSeconds: -3600,
    });

    const res = await app.fetch(
      new Request('http://localhost/github/installations', authed(userA.jwt)),
      env,
    );
    expect(res.status).toBe(200);
    const installations = (await res.json()) as Array<{ installation_id: string }>;
    expect(installations).toHaveLength(0);
  });

  // Decision: Installing the App on an organization confers no standing of its own. The installer sees
  // nothing without an active membership; once membership is proven, the installer and other
  // members see only the installation metadata. Personal installation owners keep their repo list.
  it('never exposes organization repositories to the installer or members', async () => {
    const owner = await createTestUser(env.db, 'repo-owner');
    const member = await createTestUser(env.db, 'repo-member');
    const seededRepos = [
      { full_name: 'org/secret-app', id: 1 },
      { full_name: 'org/private-api', id: 2 },
    ];
    await upsertGitHubInstallation(env.db, {
      installationId: '920',
      userId: null,
      accountLogin: 'org5',
      accountId: 'acc_920',
      accountType: 'Organization',
      repositories: seededRepos,
      repositorySelection: 'selected',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '920',
      userId: member.id,
      githubAccountId: 'gh_member',
      ttlSeconds: 3600,
    });

    type Row = {
      installation_id: string;
      repository_selection: string;
      repositories: Array<{ full_name: string; id: number }>;
    };

    const ownerRes = await app.fetch(
      new Request('http://localhost/github/installations', authed(owner.jwt)),
      env,
    );
    expect(ownerRes.status).toBe(200);
    const ownerRows = (await ownerRes.json()) as Array<Row>;
    expect(ownerRows.find((r) => r.installation_id === '920')).toBeUndefined();

    await upsertGitHubInstallationMember(env.db, {
      installationId: '920',
      userId: owner.id,
      githubAccountId: 'gh_owner',
      ttlSeconds: 3600,
    });
    const provenOwnerRes = await app.fetch(
      new Request('http://localhost/github/installations', authed(owner.jwt)),
      env,
    );
    const provenOwnerRows = (await provenOwnerRes.json()) as Array<Row>;
    expect(provenOwnerRows.find((r) => r.installation_id === '920')?.repositories).toEqual([]);

    const memberRes = await app.fetch(
      new Request('http://localhost/github/installations', authed(member.jwt)),
      env,
    );
    expect(memberRes.status).toBe(200);
    const memberRows = (await memberRes.json()) as Array<Row>;
    const memberRow = memberRows.find((r) => r.installation_id === '920');
    expect(memberRow).toBeDefined();
    expect(memberRow!.repositories).toEqual([]);
    expect(memberRow!.installation_id).toBe('920');
    expect(memberRow!.repository_selection).toBe('selected');

    const personalRepos = [{ full_name: 'repo-owner/personal', id: 3 }];
    await upsertGitHubInstallation(env.db, {
      installationId: '921',
      userId: owner.id,
      accountLogin: 'repo-owner',
      accountId: 'acc_921',
      accountType: 'User',
      repositories: personalRepos,
    });
    const personalRes = await app.fetch(
      new Request('http://localhost/github/installations', authed(owner.jwt)),
      env,
    );
    const personalRows = (await personalRes.json()) as Array<Row>;
    expect(personalRows.find((r) => r.installation_id === '921')?.repositories).toEqual(
      personalRepos,
    );
  });

  it('requires auth', async () => {
    const res = await app.fetch(new Request('http://localhost/github/installations'), env);
    expect(res.status).toBe(401);
  });
});

describe('GET /github/install-url', () => {
  it('returns 503 when the GitHub App slug is unset', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      new Request('http://localhost/github/install-url', authed(user.jwt)),
      env,
    );
    expect(res.status).toBe(503);
  });

  it('returns a signed install url when the slug is configured', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      new Request('http://localhost/github/install-url', authed(user.jwt)),
      { ...env, GITHUB_APP_SLUG: 'platform-deploy' },
    );
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url.startsWith('https://github.com/apps/platform-deploy/installations/new?state=')).toBe(
      true,
    );
  });

  it('returns 403 github_identity_required when the caller has no github identity', async () => {
    const user = await createTestUser(env.db, 'nogithub', 'google');
    const res = await app.fetch(
      new Request('http://localhost/github/install-url', authed(user.jwt)),
      { ...env, GITHUB_APP_SLUG: 'platform-deploy' },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'github_identity_required' });
  });
});

describe('GET /github/callback', () => {
  it('returns 503 when the GitHub App is unconfigured', async () => {
    const res = await app.fetch(
      new Request('http://localhost/github/callback?installation_id=1&state=x.y'),
      env,
    );
    expect(res.status).toBe(503);
  });

  // Decision: The installation's GitHub account id is forced to equal A's bound account id (a derivation gap
  // or id collision), so the primary account check passes. The owner-guard backstop is what has to
  // reject the re-own and leave B's ownership intact.
  it('does not re-own another user installation (owner-guard backstop)', async () => {
    const userB = await createTestUser(env.db, 'victim', 'github', '5555');
    const userA = await createTestUser(env.db, 'attacker', 'github', '4242');

    await upsertGitHubInstallation(env.db, {
      installationId: '999',
      userId: userB.id,
      accountLogin: 'victim',
      accountId: '5555',
      accountType: 'User',
      repositories: [{ full_name: 'victim/app', id: 1 }],
    });

    mockInstallationRepos({ login: 'victim', id: 4242, type: 'User' });

    const state = await mintInstallState(userA.id, '4242');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=999&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(403);
    const persisted = await getGitHubInstallation(env.db, '999');
    expect(persisted?.user_id).toBe(userB.id);
    // Decision: Fallback path (no user-OAuth code, so authResult.authorized is false): the different-user hit
    // is an account-id collision, not proof of co-membership, so no cached membership may be granted.
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '999'));
    expect(members).toHaveLength(0);
  });

  it('rejects a callback whose installation account does not match the caller', async () => {
    const userA = await createTestUser(env.db, 'attacker', 'github', 'acc_a');
    mockInstallationRepos({ login: 'stranger', id: 9999, type: 'User' });

    const state = await mintInstallState(userA.id, 'acc_a');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=888&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(403);
    expect(await getGitHubInstallation(env.db, '888')).toBeNull();
  });

  it('links the installation when the account matches the caller', async () => {
    const user = await createTestUser(env.db, 'self', 'github', '7777');
    mockInstallationRepos({ login: 'self', id: 7777, type: 'User' });

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=4242&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(302);
    const persisted = await getGitHubInstallation(env.db, '4242');
    expect(persisted?.user_id).toBe(user.id);
    expect(persisted?.account_id).toBe('7777');
  });

  // Decision: A reconnect or `setup_action=update` callback hits the existing row (conflict path). The
  // callback just refetched the live membership, so it passes `refreshMembership: true`. The fresh
  // repo list and selection have to be persisted, or newly added repos and a widen-to-`all` stay
  // rejected until the next webhook.
  it('rolls fresh membership forward on a setup_action=update callback', async () => {
    const user = await createTestUser(env.db, 'reconnect', 'github', '7777');

    await upsertGitHubInstallation(env.db, {
      installationId: '4243',
      userId: user.id,
      accountLogin: 'reconnect',
      accountId: '7777',
      accountType: 'User',
      repositories: [{ full_name: 'reconnect/app', id: 1 }],
      repositorySelection: 'selected',
    });

    const owner = { login: 'reconnect', id: 7777, type: 'User' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/installation/repositories')) {
          return Response.json({
            repository_selection: 'selected',
            repositories: [
              { full_name: 'reconnect/app', id: 1, owner },
              { full_name: 'reconnect/api', id: 2, owner },
            ],
          });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=4243&setup_action=update&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(302);
    const persisted = await getGitHubInstallation(env.db, '4243');
    expect(persisted?.repositories).toEqual([
      { full_name: 'reconnect/app', id: 1 },
      { full_name: 'reconnect/api', id: 2 },
    ]);
    expect(persisted?.repository_selection).toBe('selected');
  });

  // Decision: An `all`-repository install doesn't enumerate or persist the full repo list. Once page 1 reports
  // `repository_selection: 'all'`, the callback stops paginating and stores an empty
  // `repositories`: the cached array isn't read for `all` installs (coverage checks short-circuit on
  // selection='all'; the connect route resolves ids live). This avoids GitHub round trips and JSONB
  // bloat for a large org.
  it('stops paginating and stores no repos for an all-repository install', async () => {
    const user = await createTestUser(env.db, 'allinstaller', 'github', '8888');
    const pagesFetched: Array<string> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/installation/repositories')) {
          pagesFetched.push(new URL(url).searchParams.get('page') ?? '1');
          // Decision: A full page (100 repos) would normally trigger a page-2 fetch; the `all` early break has to stop
          // here even though the page is full.
          const repositories = Array.from({ length: 100 }, (_, i) => ({
            full_name: `acme/repo-${i}`,
            id: i + 1,
            owner: { login: 'self8888', id: 8888, type: 'User' },
          }));
          return Response.json({ repository_selection: 'all', repositories });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const state = await mintInstallState(user.id, '8888');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=7000&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(302);
    expect(pagesFetched).toEqual(['1']);
    const persisted = await getGitHubInstallation(env.db, '7000');
    expect(persisted?.repository_selection).toBe('all');
    expect(persisted?.repositories).toEqual([]);
  });

  // Decision: An organization install authorized via "user authorization on install". The installation's
  // account is the org (9001), not the caller's personal GitHub id (7777), so the account-id
  // fallback would 403. GitHub appends a `code`; exchanging it gives a user token whose
  // GET /user/installations includes 5000. That proves only installation visibility, so the
  // callback records membership without making the caller an owner.
  it('links an org install authorized via user-auth-on-install code', async () => {
    const user = await createTestUser(env.db, 'orgadmin', 'github', '7777');
    const { calls } = mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9001, type: 'Organization' },
      userInstallationIds: [5000],
      callerAccountId: 7777,
    });

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5000&code=valid-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    expect(calls.tokenExchange).toBe(true);
    expect(calls.userInstallations).toBe(true);
    expect(calls.user).toBe(true);
    const persisted = await getGitHubInstallation(env.db, '5000');
    expect(persisted?.user_id).toBeNull();
    expect(persisted?.account_id).toBe('9001');
    expect(persisted?.account_type).toBe('Organization');
    expect(
      (await getTestGitHubInstallationMembers(env.db, '5000')).some(
        (row) => row.user_id === user.id,
      ),
    ).toBe(true);
  });

  it('rejects an install whose code does not list the installation_id', async () => {
    const user = await createTestUser(env.db, 'outsider', 'github', '7777');
    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9001, type: 'Organization' },
      userInstallationIds: [1234],
    });

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5000&code=valid-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(403);
    expect(await getGitHubInstallation(env.db, '5000')).toBeNull();
  });

  it('does not re-own a victim installation when the code does not authorize it', async () => {
    const userB = await createTestUser(env.db, 'victim', 'github', '5555');
    const userA = await createTestUser(env.db, 'attacker', 'github', '4242');

    await upsertGitHubInstallation(env.db, {
      installationId: '999',
      userId: userB.id,
      accountLogin: 'victim',
      accountId: '5555',
      accountType: 'User',
      repositories: [{ full_name: 'victim/app', id: 1 }],
    });

    mockUserAuthInstall({
      owner: { login: 'victim', id: 5555, type: 'User' },
      userInstallationIds: [777],
    });

    const state = await mintInstallState(userA.id, '4242');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=999&code=attacker-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(403);
    const persisted = await getGitHubInstallation(env.db, '999');
    expect(persisted?.user_id).toBe(userB.id);
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '999'));
    expect(members).toHaveLength(0);
  });

  it('grants a cached membership (no ownership) when a co-member joins an org install via the user-token path', async () => {
    const userA = await createTestUser(env.db, 'orgmember', 'github', '4242');

    await upsertGitHubInstallation(env.db, {
      installationId: '5000',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9001',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
    });

    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9001, type: 'Organization' },
      userInstallationIds: [5000],
      callerAccountId: 4242,
    });

    const state = await mintInstallState(userA.id, '4242');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5000&code=member-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);

    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '5000'));
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe(userA.id);
    expect(members[0].github_account_id).toBe('4242');

    const persisted = await getGitHubInstallation(env.db, '5000');
    expect(persisted?.user_id).toBeNull();
  });

  // Decision: The install-callback membership backstop is Organization-only. A different Platform user
  // reaching an existing personal (account_type='User') install owned by someone else, even on the
  // proven user-token path, is a non-shareable collision: a personal install has no member_removed
  // revocation path. It falls through to the conflict 403 and mints no membership.
  it('403s and grants NO membership when a different user hits a personal (User) install on the user-token path', async () => {
    const userB = await createTestUser(env.db, 'personalowner', 'github', '5555');
    const userA = await createTestUser(env.db, 'collider', 'github', '4242');

    await upsertGitHubInstallation(env.db, {
      installationId: '5001',
      userId: userB.id,
      accountLogin: 'b-personal',
      accountId: '9002',
      accountType: 'User',
      repositories: [{ full_name: 'b-personal/app', id: 1 }],
    });

    mockUserAuthInstall({
      owner: { login: 'b-personal', id: 9002, type: 'User' },
      userInstallationIds: [5001],
      callerAccountId: 4242,
    });

    const state = await mintInstallState(userA.id, '4242');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5001&code=collider-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('installation already linked to another user');

    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '5001'));
    expect(members).toHaveLength(0);

    const persisted = await getGitHubInstallation(env.db, '5001');
    expect(persisted?.user_id).toBe(userB.id);
  });

  it('is idempotent across repeat token-path co-member joins: one refreshed membership row', async () => {
    const userA = await createTestUser(env.db, 'orgmember', 'github', '4242');

    await upsertGitHubInstallation(env.db, {
      installationId: '5000',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9001',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
    });

    // Decision: Pre-seed a stale membership (near-immediate expiry, an old account id) so the join visibly
    // refreshes expires_at and github_account_id in place. The 24h ttl is far above the 1s seeded
    // ttl, so the comparison is strictly greater with no clock-granularity flake.
    await upsertGitHubInstallationMember(env.db, {
      installationId: '5000',
      userId: userA.id,
      githubAccountId: 'stale',
      ttlSeconds: 1,
    });
    const [seeded] = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '5000'));

    const join = async () => {
      mockUserAuthInstall({
        owner: { login: 'acme-org', id: 9001, type: 'Organization' },
        userInstallationIds: [5000],
        callerAccountId: 4242,
      });
      const state = await mintInstallState(userA.id, '4242');
      return app.fetch(
        new Request(
          `http://localhost/github/callback?installation_id=5000&code=member-install-code&state=${encodeURIComponent(state)}`,
        ),
        { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
      );
    };

    expect((await join()).status).toBe(302);
    expect((await join()).status).toBe(302);

    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '5000'));
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe(userA.id);
    expect(members[0].github_account_id).toBe('4242');
    expect(new Date(members[0].expires_at).getTime()).toBeGreaterThan(
      new Date(seeded.expires_at).getTime(),
    );

    expect((await getGitHubInstallation(env.db, '5000'))?.user_id).toBeNull();
  });

  it('links a personal install via the account-id fallback when no code is present', async () => {
    const user = await createTestUser(env.db, 'solo', 'github', '8888');
    mockInstallationRepos({ login: 'solo', id: 8888, type: 'User' });

    const state = await mintInstallState(user.id, '8888');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=6000&state=${encodeURIComponent(state)}`,
      ),
      // Decision: User-OAuth env is present but there's no code, so the fallback path runs and the token exchange
      // isn't attempted (mockInstallationRepos throws on any non-repos fetch, which proves it).
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    const persisted = await getGitHubInstallation(env.db, '6000');
    expect(persisted?.user_id).toBe(user.id);
    expect(persisted?.account_id).toBe('8888');
  });

  // Decision: Confused deputy: an attacker mints an install URL bound to their own GitHub account id (111)
  // and sends it to a victim org admin. The victim completes the install, so the OAuth `code`
  // exchanges to a token that can access the org installation. But the code-holder's own GET /user
  // id (222, the victim) doesn't match the signed state's account id (111), so the install is
  // rejected and nothing is linked.
  it('rejects an install whose code-holder is not the state initiator', async () => {
    const attacker = await createTestUser(env.db, 'attacker', 'github', '111');

    const { calls } = mockUserAuthInstall({
      owner: { login: 'acme-org', id: 999, type: 'Organization' },
      userInstallationIds: [5000],
      callerAccountId: 222,
    });

    const state = await mintInstallState(attacker.id, '111');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5000&code=victim-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('does not belong to the caller');
    expect(calls.user).toBe(true);
    expect(await getGitHubInstallation(env.db, '5000')).toBeNull();
  });

  it('links an org install when the code-holder matches the state initiator', async () => {
    const initiator = await createTestUser(env.db, 'orgadmin', 'github', '111');

    const { calls } = mockUserAuthInstall({
      owner: { login: 'acme-org', id: 999, type: 'Organization' },
      userInstallationIds: [5000],
      callerAccountId: 111,
    });

    const state = await mintInstallState(initiator.id, '111');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5000&code=initiator-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    expect(calls.user).toBe(true);
    expect(calls.userInstallations).toBe(true);
    const persisted = await getGitHubInstallation(env.db, '5000');
    expect(persisted?.user_id).toBeNull();
    expect(persisted?.account_id).toBe('999');
    expect(persisted?.account_type).toBe('Organization');
    expect(
      (await getTestGitHubInstallationMembers(env.db, '5000')).some(
        (row) => row.user_id === initiator.id,
      ),
    ).toBe(true);
  });

  // Decision: An install with no repositories selected yet has no repo owner to derive the account from. The
  // callback resolves the account via the App JWT (`GET /app/installations/:id`) and uses that real
  // id for the ownership check and persistence. It doesn't fabricate `account_id = installationId`.
  it('resolves the real account via the App-JWT lookup for an empty-repos install', async () => {
    const user = await createTestUser(env.db, 'empty-install', 'github', '7777');
    mockEmptyInstallAccount({ account: { login: 'empty-owner', id: 7777, type: 'User' } });

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=6100&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(302);
    const persisted = await getGitHubInstallation(env.db, '6100');
    expect(persisted?.user_id).toBe(user.id);
    expect(persisted?.account_id).toBe('7777');
    expect(persisted?.account_login).toBe('empty-owner');
  });

  it('fails closed (502) when the App-JWT account lookup fails for an empty-repos install', async () => {
    const user = await createTestUser(env.db, 'empty-fail', 'github', '7777');
    mockEmptyInstallAccount({ account: null });

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=6200&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('unable to resolve installation account');
    expect(await getGitHubInstallation(env.db, '6200')).toBeNull();
  });

  // Decision: The install callback's two org-shared grant points (owner re-adopt and membership backstop) gate
  // on the revocation tombstone under the install-row lock. The callback stamps its own DB-clock
  // proof `iat` internally, so unlike the connect-gate tests, these tests control the gate from the
  // tombstone side with an explicit revoked_at offset: a future offset is >= the later-stamped proof
  // iat (the concurrent race, reject), a past offset is < it (a legit re-add, allow). The real
  // proof-then-member_removed-then-grant interleaving can't be reproduced under PGlite's serialized
  // transactions. PGlite runs in-process, so `now()` == `Date.now()` and the 1h margin dwarfs any
  // granularity.
  async function seedRevocationAt(
    installationId: string,
    githubAccountId: string,
    offsetMs: number,
  ): Promise<void> {
    await env.db.insert(githubInstallationRevocations).values({
      id: generateId('ghr'),
      installation_id: installationId,
      github_account_id: githubAccountId,
      revoked_at: new Date(Date.now() + offsetMs).toISOString(),
    });
  }

  it('403s and does not re-adopt owner when the tombstone post-dates the proof (concurrent member_removed)', async () => {
    const owner = await createTestUser(env.db, 'org-owner', 'github', '7001');
    await upsertGitHubInstallation(env.db, {
      installationId: '9100',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9001',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
      repositorySelection: 'selected',
    });
    await seedRevocationAt('9100', '7001', 3_600_000);

    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9001, type: 'Organization' },
      userInstallationIds: [9100],
      callerAccountId: 7001,
    });
    const state = await mintInstallState(owner.id, '7001');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=9100&code=owner-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('installation access revoked');
    expect((await getGitHubInstallation(env.db, '9100'))?.user_id).toBeNull();
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '9100'));
    expect(members).toHaveLength(0);
  });

  // Decision: Org installs are member-only: even the original installer re-authorizing after a removal and
  // re-add gets a membership row and the owner pointer stays NULL (a re-added installer reconnects
  // via the member path with per-repo proof). The tombstone pre-dates the proof (legit re-add), so
  // the membership grant isn't over-blocked.
  it('org install is member-only: a re-added original installer gets membership, not ownership', async () => {
    const owner = await createTestUser(env.db, 'org-owner', 'github', '7002');
    await upsertGitHubInstallation(env.db, {
      installationId: '9101',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9002',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
      repositorySelection: 'selected',
    });
    await seedRevocationAt('9101', '7002', -3_600_000);

    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9002, type: 'Organization' },
      userInstallationIds: [9101],
      callerAccountId: 7002,
    });
    const state = await mintInstallState(owner.id, '7002');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=9101&code=owner-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    expect((await getGitHubInstallation(env.db, '9101'))?.user_id).toBeNull();
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '9101'));
    expect(members).toHaveLength(1);
    expect(members[0]?.user_id).toBe(owner.id);
    expect(members[0]?.github_account_id).toBe('7002');
  });

  // Decision: Confused-deputy guard: an org install (null owner + a tombstone for a removed member) reached by
  // a different member B mustn't be owned by B. Ownership would let B's owner connect resolve org
  // repos via the installation token and bypass the per-repo connect_grant proof. B gets a
  // membership row instead.
  it('org install: a different member B gets membership, not ownership (confused-deputy closed)', async () => {
    const memberB = await createTestUser(env.db, 'org-member-b', 'github', '7011');
    await upsertGitHubInstallation(env.db, {
      installationId: '9110',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9010',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
      repositorySelection: 'selected',
    });
    await seedRevocationAt('9110', '7010', -3_600_000);

    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9010, type: 'Organization' },
      userInstallationIds: [9110],
      callerAccountId: 7011,
    });
    const state = await mintInstallState(memberB.id, '7011');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=9110&code=member-b-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    const install = await getGitHubInstallation(env.db, '9110');
    expect(install?.user_id).toBeNull();
    expect(install?.user_id).not.toBe(memberB.id);
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '9110'));
    expect(members).toHaveLength(1);
    expect(members[0]?.user_id).toBe(memberB.id);
  });

  // Decision: A webhook-precreated organization row stays ownerless even when fresh. Installation visibility
  // can't prove organization-wide repository access.
  it('fresh null-owner org install records membership without adopting ownership', async () => {
    const installer = await createTestUser(env.db, 'org-first-installer', 'github', '7020');
    await upsertGitHubInstallation(env.db, {
      installationId: '9120',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9020',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
      repositorySelection: 'selected',
    });

    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9020, type: 'Organization' },
      userInstallationIds: [9120],
      callerAccountId: 7020,
    });
    const state = await mintInstallState(installer.id, '7020');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=9120&code=installer-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    expect((await getGitHubInstallation(env.db, '9120'))?.user_id).toBeNull();
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '9120'));
    expect(members).toHaveLength(1);
    expect(members[0]?.user_id).toBe(installer.id);
  });

  it('403s and grants no membership when the tombstone post-dates the proof (backstop concurrent member_removed)', async () => {
    const memberA = await createTestUser(env.db, 'org-member', 'github', '4242');
    await upsertGitHubInstallation(env.db, {
      installationId: '9102',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9003',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
    });
    await seedRevocationAt('9102', '4242', 3_600_000);

    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9003, type: 'Organization' },
      userInstallationIds: [9102],
      callerAccountId: 4242,
    });
    const state = await mintInstallState(memberA.id, '4242');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=9102&code=member-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('installation access revoked');
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '9102'));
    expect(members).toHaveLength(0);
    expect((await getGitHubInstallation(env.db, '9102'))?.user_id).toBeNull();
  });

  it('grants membership when the tombstone pre-dates the proof (backstop legit re-add)', async () => {
    const memberA = await createTestUser(env.db, 'org-member', 'github', '4243');
    await upsertGitHubInstallation(env.db, {
      installationId: '9103',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9004',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
    });
    await seedRevocationAt('9103', '4243', -3_600_000);

    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9004, type: 'Organization' },
      userInstallationIds: [9103],
      callerAccountId: 4243,
    });
    const state = await mintInstallState(memberA.id, '4243');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=9103&code=member-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '9103'));
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe(memberA.id);
    expect(members[0].github_account_id).toBe('4243');
    expect((await getGitHubInstallation(env.db, '9103'))?.user_id).toBeNull();
  });
});
