import { createDefaultPlanCatalog } from '@builtbyfriends/platform/plans';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
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
import {
  createGitHubConnection as createGitHubConnectionRecord,
  createGithubActionsBuildWithinLimit,
  deleteGitHubConnection,
  getBuild,
  getProject,
  getProjectBuilds,
  markGitHubInstallationStatus,
  setBuildCheckRunId,
  setGitHubInstallationRepositories,
  updateBuildStatus,
  updateGitHubConnection,
  upsertGitHubInstallation,
} from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import type { GithubOidcClaims } from '../../src/github/oidc-verify.ts';
import { writePlanCatalog } from '../../src/plans.ts';
import { oidcRoutes } from '../../src/routes/auth-oidc.ts';
import {
  builds,
  githubConnections,
  githubInstallations,
  projects,
  users,
} from '../../src/schema.ts';
import { verifyDeployToken } from '../helpers/project-token.ts';
import {
  createTestBuild,
  JWT_SECRET,
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

// Decision: Stub the OIDC verifier so the test exercises connection resolution and token minting without a
// real GitHub JWKS. The stub mirrors jose's audience enforcement: when the route passes an expected
// `audience`, a claims `aud` that doesn't match resolves to null.
let verifyResult: GithubOidcClaims | null = null;
function setVerifyResult(result: GithubOidcClaims | null): void {
  verifyResult = result;
}

vi.mock('../../src/github/oidc-verify.ts', () => ({
  verifyGithubOidcToken: async (_token: string, opts?: { audience?: string | Array<string> }) => {
    if (
      verifyResult &&
      opts?.audience !== undefined &&
      ![opts.audience].flat().includes(String(verifyResult.aud))
    ) {
      return null;
    }
    return verifyResult;
  },
}));

// Decision: The App JWT signer imports a real PKCS#8 PEM and the test secret is a placeholder, so stub it. The
// route only uses the returned string as a Bearer the fetch mock doesn't inspect.
vi.mock('../../src/github/app-jwt.ts', () => ({
  createAppJwt: async () => 'app-jwt-stub',
}));

// Decision: Controls the default `GET /repos/{repo}/installation` live-revocation response. `accountId ===
// null` echoes the active claims' `repository_owner_id` so the live owner check passes for legit
// cases. `status` < 0 models the 404 "App not installed" signal (the helper returns null).
let liveInstall: { status: number; installationId: string; accountId: string | null } = {
  status: 200,
  installationId: '1',
  accountId: null,
};
function setLiveInstall(
  next: Partial<{ status: number; installationId: string; accountId: string | null }>,
): void {
  liveInstall = { ...liveInstall, ...next };
}

// Decision: The exchange compares `claims.sha` against the live branch head and fails closed: it proceeds only
// when the result is 'identical'. 'ahead' (sha stale), 'behind' (branch moved backward off sha) and
// 'diverged' (off-branch) get 409; null (API error or 404) is unverifiable (503). The default
// 'identical' lets tests that don't exercise the guard mint a token.
let compareStatus: string | null = 'identical';
function setCompareStatus(status: string | null): void {
  compareStatus = status;
}

// Decision: The exchange compares twice: a pre-check before the build tx and a re-check after the row insert
// (closing the compare-to-insert TOCTOU). The TOCTOU tests need the two calls to differ: first
// 'identical' to pass the pre-check, then 'ahead' or null for a newer push landing in the window.
let compareStatusQueue: Array<string | null> = [];
function setCompareStatusQueue(queue: Array<string | null>): void {
  compareStatusQueue = [...queue];
}

// Decision: Used to inject a revocation that commits after the resolver and live-install checks but before
// the build tx. The compare call sits in that window (it precedes `getRepoInstallation` and
// `createGithubActionsBuildWithinLimit`), and the live `getRepoInstallation` reads the fetch mock,
// not the DB, so a DB-only suspend is caught only by the in-tx re-check.
let compareSideEffect: (() => Promise<void>) | null = null;
function setCompareSideEffect(fn: (() => Promise<void>) | null): void {
  compareSideEffect = fn;
}

// Decision: A >=400 status models a check-run create failure (`createCheckRun` returns null): the exchange
// still mints a token and persists no check_run_id.
const CHECK_RUN_ID = '999001';
let checkRunCreateStatus = 200;
let checkRunSideEffect: (() => Promise<void>) | null = null;
function setCheckRunCreateStatus(status: number): void {
  checkRunCreateStatus = status;
}
// Decision: The create mock returns a distinct id per call (999001, 999002, ...) so a duplicated create on a
// repeated exchange shows in both the count and a changed persisted `check_run_id`.
let checkRunCreateCount = 0;

const APP_ID = '123456';
const APP_KEY = 'pkcs8-pem-placeholder';

let env: TestEnv;

function makeApp(overrideEnv: TestEnv): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.use('*', async (context, next) => {
    context.set('db', overrideEnv.db);
    await next();
  });
  app.route('/auth', oidcRoutes);
  return app;
}

function makeClaims(overrides: Partial<GithubOidcClaims> = {}): GithubOidcClaims {
  const repository = overrides.repository ?? 'octo/repo';
  const ref = overrides.ref ?? 'refs/heads/main';
  const scaffoldRef = `${repository}/.github/workflows/bwf-deploy.yml@${ref}`;
  return {
    repository,
    repository_owner: repository.split('/')[0],
    repository_owner_id: 'octo-id',
    repository_id: '42',
    ref,
    sha: 'sha-oidc',
    run_id: '987654',
    run_attempt: '1',
    workflow: 'Deploy to Platform',
    workflow_ref: scaffoldRef,
    job_workflow_ref: scaffoldRef,
    sub: `repo:${repository}:ref:${ref}`,
    aud: 'platform',
    event_name: 'push',
    ...overrides,
  };
}

async function exchange(
  app: Hono<ApiEnv>,
  appEnv: TestEnv,
  body: unknown,
  options?: { withSecrets?: boolean },
): Promise<Response> {
  const withSecrets = options?.withSecrets ?? true;
  // Decision: The route creates and persists the check run synchronously (awaited before the token response),
  // so the check-run POST and `check_run_id` are durable when `app.fetch` resolves. No `waitUntil`
  // flush is needed.
  return app.fetch(
    new Request('http://localhost/auth/github-oidc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {
      ...appEnv,
      GITHUB_APP_ID: withSecrets ? APP_ID : undefined,
      GITHUB_APP_PRIVATE_KEY: withSecrets ? APP_KEY : undefined,
    },
  );
}

async function clearBuildTables(db: Db): Promise<void> {
  await db.delete(builds);
  await db.delete(githubConnections);
  await db.delete(githubInstallations);
}

async function seedActiveInstallation(
  db: Db,
  installationId: string,
  repositories: ReadonlyArray<{ full_name: string; id: number }> = [],
  repositorySelection: 'all' | 'selected' = repositories.length > 0 ? 'selected' : 'all',
  accountId: string = 'octo-id',
): Promise<void> {
  await upsertGitHubInstallation(db, {
    installationId,
    userId: null,
    accountLogin: 'octo',
    accountId,
    accountType: 'Organization',
    repositories,
    repositorySelection,
  });
}

async function createGitHubConnection(
  db: Db,
  args: Omit<Parameters<typeof createGitHubConnectionRecord>[1], 'authorizedByUserId'> & {
    authorizedByUserId?: string;
  },
) {
  const project = await getProject(db, args.projectId);
  if (!project) {
    throw new Error('test project missing');
  }
  return createGitHubConnectionRecord(db, {
    ...args,
    authorizedByUserId: args.authorizedByUserId ?? project.user_id,
  });
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearBuildTables(env.db);
  await clearTables(env.db);
  setVerifyResult(null);
  liveInstall = { status: 200, installationId: '1', accountId: null };
  setCompareStatus('identical');
  setCompareStatusQueue([]);
  setCompareSideEffect(null);
  setCheckRunCreateStatus(200);
  checkRunSideEffect = null;
  checkRunCreateCount = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/access_tokens')) {
        return Response.json({
          token: 'installation-token-stub',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
      }
      if (url.includes('/check-runs')) {
        if (checkRunSideEffect) {
          const effect = checkRunSideEffect;
          checkRunSideEffect = null;
          await effect();
        }
        if (checkRunCreateStatus < 200 || checkRunCreateStatus >= 300) {
          return new Response('check-run create failed', { status: checkRunCreateStatus });
        }
        checkRunCreateCount += 1;
        return Response.json({ id: 999_000 + checkRunCreateCount });
      }
      if (url.includes('/compare/')) {
        if (compareSideEffect) {
          const fn = compareSideEffect;
          compareSideEffect = null;
          await fn();
        }
        const verdict = compareStatusQueue.length > 0 ? compareStatusQueue.shift()! : compareStatus;
        if (verdict === null) {
          return new Response('not found', { status: 404 });
        }
        return Response.json({ status: verdict });
      }
      if (url.includes('/installation')) {
        if (liveInstall.status < 200 || liveInstall.status >= 300) {
          return new Response('not found', { status: liveInstall.status });
        }
        const accountId = liveInstall.accountId ?? verifyResult?.repository_owner_id ?? 'octo-id';
        return Response.json({
          id: liveInstall.installationId,
          account: { id: accountId },
        });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('POST /auth/github-oidc', () => {
  it('returns 503 when GitHub App secrets are unset', async () => {
    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 't', project: 'p' }, { withSecrets: false });
    expect(res.status).toBe(503);
  });

  it('returns 400 when oidcToken is missing', async () => {
    const app = makeApp(env);
    const res = await exchange(app, env, { project: 'p' });
    expect(res.status).toBe(400);
  });

  it('returns 401 on an invalid oidc token', async () => {
    const app = makeApp(env);
    setVerifyResult(null);
    const res = await exchange(app, env, { oidcToken: 'bad', project: 'p' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when no github_actions connection exists for the repo', async () => {
    const app = makeApp(env);
    setVerifyResult(makeClaims({ repository: 'octo/unconnected' }));
    const res = await exchange(app, env, { oidcToken: 't', project: 'p' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the user who authorized the connection is no longer owner or admin', async () => {
    const user = await createTestUser(env.db);
    const former = await createTestUser(env.db, 'oidc-former-owner');
    const project = await createTestProject(env.db, user.id, 'oidc-stale-authorizer');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      buildExecutor: 'github_actions',
      authorizedByUserId: former.id,
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 't', project: project.slug });

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      'no authorized github actions connection for repository; reconnect the repository',
    );
    expect(await getProjectBuilds(env.db, project.id)).toEqual([]);
  });

  it('returns 401 when the connection is a container executor', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-container');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'container',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 't', project: project.slug });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the declared project slug does not match the connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-slug');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 't', project: 'a-different-slug' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the oidc token audience is not "platform"', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-aud');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ aud: 'sigstore' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 when the oidc ref does not match the connected branch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-branch');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ ref: 'refs/heads/attacker' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 when the oidc ref is a tag', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-tag');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ ref: 'refs/tags/v1' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 when the oidc ref is a pull-request merge ref', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-pr');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ ref: 'refs/pull/1/merge' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  // Decision: verifyGithubOidcToken checks the signature but not claim types, so a signed but malformed token
  // can carry a missing or non-string `ref`. The handler returns the controlled 401 rather than
  // throwing on `.startsWith`/`.slice` into a global 500.
  it('returns 401 (not 500) when the oidc ref claim is missing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-no-ref');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    const claims = makeClaims();
    delete (claims as unknown as Record<string, unknown>).ref;
    setVerifyResult(claims);

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 (not 500) when the oidc ref claim is not a string', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-bad-ref');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ ref: 123 as unknown as string }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('mints a scoped deploy token and creates a building actions build', async () => {
    const user = await createTestUser(env.db, 'octo-user');
    const project = await createTestProject(env.db, user.id, 'oidc-ok');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ sha: 'commit-xyz', run_id: '424242' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);

    const json = (await res.json()) as { token: string; projectId: string; buildId: string };
    expect(json.projectId).toBe(project.id);
    expect(json.token).toBeTruthy();
    expect(json.buildId).toBeTruthy();

    const payload = await verifyDeployToken(json.token, JWT_SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.aud).toBe('deploy');
    expect(payload!.sub).toBe(user.id);
    expect(payload!.project).toBe(project.id);
    expect(payload!.login).toBe('octo-user');
    // Decision: The token is bound to the created build so the deploy endpoint can reject it once a newer run
    // supersedes or cancels that build.
    expect(payload!.build).toBe(json.buildId);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(1);
    const build = projectBuilds[0];
    expect(build.id).toBe(json.buildId);
    expect(build.executor).toBe('github_actions');
    expect(build.status).toBe('building');
    expect(build.commit_sha).toBe('commit-xyz');
    expect(build.branch).toBe('main');
    expect(build.github_run_id).toBe('424242');
    expect(build.logs_url).toBe('https://github.com/octo/repo/actions/runs/424242');
  });

  it('returns 403 and creates no build when the project owner is manually suspended', async () => {
    const user = await createTestUser(env.db, 'oidc-suspended-owner');
    const project = await createTestProject(env.db, user.id, 'oidc-suspended');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await env.db
      .update(users)
      .set({ suspended_reason: 'platform policy violation' })
      .where(eq(users.id, user.id));
    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'project owner suspended',
      message: expect.any(String),
    });
    expect(await getProjectBuilds(env.db, project.id)).toEqual([]);
    expect(checkRunCreateCount).toBe(0);
  });

  // Decision: The github_actions executor has no BuildManager DO, so the OIDC exchange is the only place the
  // "Platform Build" check run can be created. The returned id is persisted onto the build so the
  // workflow_run completion handler can finalize it.
  it('creates and persists a "Platform Build" check run for a github_actions exchange', async () => {
    const user = await createTestUser(env.db, 'octo-check');
    const project = await createTestProject(env.db, user.id, 'oidc-check');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ sha: 'commit-check', run_id: '424243' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildId: string };

    const build = await getBuild(env.db, json.buildId);
    expect(build!.check_run_id).toBe(CHECK_RUN_ID);
  });

  // Decision: A check-run create is best effort: the deploy is the critical path and the check is cosmetic. A
  // failed create doesn't fail the OIDC exchange or block the deploy token; the build carries a NULL
  // check_run_id (finalizers no-op on it).
  it('does not fail the exchange when check-run creation fails', async () => {
    const user = await createTestUser(env.db, 'octo-check-fail');
    const project = await createTestProject(env.db, user.id, 'oidc-check-fail');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ run_id: '424244' }));
    setCheckRunCreateStatus(500);

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { token: string; buildId: string };
    expect(json.token).toBeTruthy();

    const build = await getBuild(env.db, json.buildId);
    expect(build!.check_run_id).toBeNull();
  });

  // Decision: The exchange captures the OIDC `run_attempt` claim onto the build row so the workflow_run
  // completion handler can match a redelivered completion to the right attempt.
  it('captures the github_run_attempt claim onto the created build', async () => {
    const user = await createTestUser(env.db, 'octo-attempt');
    const project = await createTestProject(env.db, user.id, 'oidc-attempt');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ run_id: '525252', run_attempt: '3' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(1);
    expect(projectBuilds[0].github_run_id).toBe('525252');
    expect(projectBuilds[0].github_run_attempt).toBe('3');
  });

  it('returns 401 and creates no build when the run_attempt claim is missing', async () => {
    const user = await createTestUser(env.db, 'octo-no-attempt');
    const project = await createTestProject(env.db, user.id, 'oidc-no-attempt');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult({
      ...makeClaims({ run_id: '626262' }),
      run_attempt: undefined,
    } as unknown as GithubOidcClaims);

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe('oidc token missing run_attempt');
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  // Decision: The deploy token is exchanged before the workflow runs install, build, upload and finalize, so
  // its TTL has to cover the owner's plan build timeout plus margin, not the fixed 15-minute default.
  // A tier with a longer build timeout (sponsored = 20) would otherwise expire mid-deploy.
  it('sizes the deploy token TTL to the owner plan build timeout, not the 15-min default', async () => {
    const user = await createTestUser(env.db, 'octo-sponsored', 'github', undefined, 'sponsored');
    const project = await createTestProject(env.db, user.id, 'oidc-ttl');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);

    const json = (await res.json()) as { token: string };
    const payload = await verifyDeployToken(json.token, JWT_SECRET);
    expect(payload).not.toBeNull();
    const ttl = payload!.exp - payload!.iat;
    expect(ttl).toBeGreaterThan(15 * 60);
    expect(Math.abs(ttl - (20 * 60 + 5 * 60))).toBeLessThanOrEqual(5);
  });

  it('freezes a newly admitted Actions token timeout before later plan edits', async () => {
    const catalog = createDefaultPlanCatalog();
    const source = catalog.plans.find((plan) => plan.id === 'sponsored')!;
    const studio = { ...source, id: 'studio', name: 'Studio' };
    await writePlanCatalog(env.db, { ...catalog, plans: [...catalog.plans, studio] });
    const user = await createTestUser(env.db, 'snapshot-builder', 'github', undefined, 'studio');
    const project = await createTestProject(env.db, user.id, 'oidc-timeout-snapshot');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    checkRunSideEffect = async () => {
      await writePlanCatalog(env.db, {
        ...catalog,
        plans: [
          ...catalog.plans,
          { ...studio, limits: { ...studio.limits, buildTimeoutMinutes: 1 } },
        ],
      });
    };
    setVerifyResult(makeClaims());
    const response = await exchange(makeApp(env), env, {
      oidcToken: 'good',
      project: project.slug,
    });
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    const payload = await verifyDeployToken(token, JWT_SECRET);
    expect(payload!.exp - payload!.iat).toBe(20 * 60 + 5 * 60);
  });

  it('accepts the exchange when no project slug is supplied in the body', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-noslug');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { projectId: string };
    expect(json.projectId).toBe(project.id);
  });

  // Decision: The OIDC exchange has to honor GitHub App revocation and repo removal. GitHub Actions OIDC is
  // independent of the App, so without these guards a repo workflow could keep minting deploy tokens
  // after the App is suspended or deleted, or the repo is dropped from the installation.

  it('returns 401 and creates no build when the installation is suspended', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-suspended');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await markGitHubInstallationStatus(env.db, '1', 'suspended');

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 and creates no build when the installation is deleted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-deleted');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await markGitHubInstallationStatus(env.db, '1', 'deleted');

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 when the repo is not in a populated installation selection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-not-selected');
    await seedActiveInstallation(env.db, '1', [{ full_name: 'octo/other', id: 999 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('mints a token when the installation is active and the repo is selected', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-selected');
    // Decision: Membership is matched by id when the claim carries one; see getGitHubActionsConnectionsByRepo.
    await seedActiveInstallation(env.db, '1', [{ full_name: 'octo/repo', id: 42 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(1);
  });

  it('mints a token for an "all repositories" install regardless of the cache', async () => {
    // Decision: An `all`-repos install grants each repo; the empty `repositories` cache isn't "repo removed" in
    // that mode.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-allrepos');
    await seedActiveInstallation(env.db, '1', [], 'all');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
  });

  it('returns 401 and creates no build when the install is revoked between the resolver and the build tx', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-late-revoke');
    await seedActiveInstallation(env.db, '1', [], 'all');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    setCompareSideEffect(async () => {
      await markGitHubInstallationStatus(env.db, '1', 'suspended');
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  // Decision: The resolved connection can be disconnected and reconnected (to a different repo) between
  // resolution and the build tx. `project_id` is UNIQUE, so the reconnect deletes the old row and
  // creates one with a fresh id. With the same installation_id and repository_id, the live-install
  // check and the in-tx install re-check both pass; only the in-tx id match catches the swap.
  it('returns 409 and creates no build when the connection is replaced between the resolver and the build tx', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-replaced');
    await seedActiveInstallation(env.db, '1', [], 'all');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    setCompareSideEffect(async () => {
      await deleteGitHubConnection(env.db, project.id);
      await createGitHubConnection(env.db, {
        projectId: project.id,
        installationId: '1',
        repoFullName: 'octo/repo',
        repositoryId: '42',
        branch: 'main',
        buildExecutor: 'github_actions',
      });
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(409);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  // Decision: An empty `repositories` array doesn't mean "all repos". installation_repositories can reduce a
  // `selected` install's cache to [] when the last selected repo is removed, and that repo's workflow
  // has to stop minting tokens. The `repository_selection` enum tells the two cases apart.

  it('returns 401 when the last selected repo was removed (selected + empty cache)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-removed');
    await seedActiveInstallation(env.db, '1', [], 'selected');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 after installation_repositories removes the last selected repo', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-removed-delta');
    await seedActiveInstallation(env.db, '1', [{ full_name: 'octo/repo', id: 42 }], 'selected');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await setGitHubInstallationRepositories(env.db, '1', [], 'selected');

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
  });

  it('returns 409 and creates no build when the project is being deleted', async () => {
    // Decision: Concurrent teardown flipped the project to `deleting` (lockAndMarkDeleting holds projects FOR
    // UPDATE). The connection resolver doesn't filter on project status, so the exchange still reaches
    // the build tx; the in-tx projects FOR UPDATE check rejects rather than mint a token or orphan a
    // `building` row that teardown's cascade already raced past.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-deleting');
    await seedActiveInstallation(env.db, '1', [{ full_name: 'octo/repo', id: 42 }], 'selected');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(409);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  // Decision: Repeated OIDC exchanges for the same GitHub run are idempotent. Without reuse, each exchange
  // inserts a fresh `building` row; the workflow_run webhook only finalizes the newest, so older rows
  // stay `building` and consume the owner's active-build slots.

  it('reuses the existing in-flight build on a repeated exchange for the same run', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-idempotent');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);

    setVerifyResult(makeClaims({ run_id: '555' }));
    const first = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { buildId: string };

    setVerifyResult(makeClaims({ run_id: '555' }));
    const second = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { token: string; buildId: string };

    expect(secondJson.token).toBeTruthy();
    expect(secondJson.buildId).toBe(firstJson.buildId);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(1);
    expect(projectBuilds[0].github_run_id).toBe('555');
  });

  // Decision: A repeated exchange for the same run reuses the in-flight build, which already carries the
  // check_run_id its creating exchange persisted, so the check-run create is skipped. Otherwise a
  // retry POSTs a second "Platform Build" run and overwrites the id, leaving the first `in_progress`
  // for good.
  it('creates the "Platform Build" check run exactly once across repeated exchanges for the same run', async () => {
    const user = await createTestUser(env.db, 'octo-check-dup');
    const project = await createTestProject(env.db, user.id, 'oidc-check-dup');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);

    setVerifyResult(makeClaims({ run_id: '556' }));
    const first = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { buildId: string };
    expect(checkRunCreateCount).toBe(1);
    const firstBuild = await getBuild(env.db, firstJson.buildId);
    expect(firstBuild!.check_run_id).toBe('999001');

    setVerifyResult(makeClaims({ run_id: '556' }));
    const second = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { buildId: string };
    expect(secondJson.buildId).toBe(firstJson.buildId);

    expect(checkRunCreateCount).toBe(1);
    const reusedBuild = await getBuild(env.db, secondJson.buildId);
    expect(reusedBuild!.check_run_id).toBe('999001');
  });

  // Decision: Two truly overlapping same-(run, attempt) exchanges can both read a null id and both POST, but
  // setBuildCheckRunId is a CAS on `check_run_id IS NULL`, so the racing second persist no-ops and the
  // DB keeps one stable, completion-tracked id.
  it('setBuildCheckRunId is immutable once set (never overwrites a persisted id)', async () => {
    const user = await createTestUser(env.db, 'octo-check-immutable');
    const project = await createTestProject(env.db, user.id, 'oidc-check-immutable');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-immutable',
      branch: 'main',
      githubRunId: '777',
    });

    await setBuildCheckRunId(env.db, build.id, '900001');
    expect((await getBuild(env.db, build.id))!.check_run_id).toBe('900001');

    await setBuildCheckRunId(env.db, build.id, '900002');
    expect((await getBuild(env.db, build.id))!.check_run_id).toBe('900001');
  });

  it('enforces a single build row per project+GitHub run ATTEMPT at the DB layer', async () => {
    // Decision: Durability guard for the composite partial-unique index (migration 0025): even if the reuse path
    // were bypassed, the DB rejects a second row for the same (project_id, github_run_id,
    // github_run_attempt). Two `building` rows for one attempt leak an active-build slot, but two
    // different attempts of one run may coexist (a rerun), and NULL-attempt rows are exempt.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-unique-index');
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      githubRunId: '888',
      githubRunAttempt: '1',
    });

    await expect(
      createTestBuild(env.db, {
        projectId: project.id,
        userId: user.id,
        executor: 'github_actions',
        status: 'building',
        githubRunId: '888',
        githubRunAttempt: '1',
      }),
    ).rejects.toThrow();

    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      githubRunId: '888',
      githubRunAttempt: '2',
    });

    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });
    const all = await getProjectBuilds(env.db, project.id);
    expect(all.filter((b) => b.github_run_id === null).length).toBe(2);
  });

  // Decision: Build identity is scoped to the project because a GitHub `run_id` is unique only within a
  // repository. Two connected repos that share a numeric run_id each get their own build with no
  // collision on the composite unique index.

  it('lets two different projects share a run_id without colliding', async () => {
    const userA = await createTestUser(env.db, 'octo-a');
    const userB = await createTestUser(env.db, 'octo-b');
    const projectA = await createTestProject(env.db, userA.id, 'oidc-collide-a');
    const projectB = await createTestProject(env.db, userB.id, 'oidc-collide-b');
    await seedActiveInstallation(env.db, '1');
    await seedActiveInstallation(env.db, '2');
    await createGitHubConnection(env.db, {
      projectId: projectA.id,
      installationId: '1',
      repoFullName: 'octo/a',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await createGitHubConnection(env.db, {
      projectId: projectB.id,
      installationId: '2',
      repoFullName: 'octo/b',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);

    setVerifyResult(makeClaims({ repository: 'octo/a', run_id: '777' }));
    setLiveInstall({ installationId: '1' });
    const resA = await exchange(app, env, { oidcToken: 'good', project: projectA.slug });
    expect(resA.status).toBe(200);

    setVerifyResult(makeClaims({ repository: 'octo/b', run_id: '777' }));
    setLiveInstall({ installationId: '2' });
    const resB = await exchange(app, env, { oidcToken: 'good', project: projectB.slug });
    expect(resB.status).toBe(200);

    const buildsA = await getProjectBuilds(env.db, projectA.id);
    const buildsB = await getProjectBuilds(env.db, projectB.id);
    expect(buildsA.length).toBe(1);
    expect(buildsB.length).toBe(1);
    expect(buildsA[0].github_run_id).toBe('777');
    expect(buildsB[0].github_run_id).toBe('777');
    expect(buildsA[0].id).not.toBe(buildsB[0].id);
  });

  // Decision: GitHub Actions builds respect the owner's per-tier build concurrency. A free user
  // (concurrentBuilds=1) at their cap gets 429 on a new run for a different project (which can't free
  // the slot via the per project+branch supersede), but an idempotent repeat of an active run still
  // gets its token (reuse doesn't double-count the slot). A new run for the same project+branch
  // supersedes the active build instead (latest wins).

  it('returns 429 for a NEW run on another project when the owner is at their cap', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-concurrency');
    const otherProject = await createTestProject(env.db, user.id, 'oidc-concurrency-2');
    await seedActiveInstallation(env.db, '1');
    await seedActiveInstallation(env.db, '2');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await createGitHubConnection(env.db, {
      projectId: otherProject.id,
      installationId: '2',
      repoFullName: 'octo/other',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);

    setVerifyResult(makeClaims({ run_id: '111' }));
    const first = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(first.status).toBe(200);

    setVerifyResult(makeClaims({ repository: 'octo/other', run_id: '222' }));
    setLiveInstall({ installationId: '2' });
    const second = await exchange(app, env, { oidcToken: 'good', project: otherProject.slug });
    expect(second.status).toBe(429);

    setVerifyResult(makeClaims({ run_id: '111' }));
    setLiveInstall({ installationId: '1' });
    const repeat = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(repeat.status).toBe(200);

    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
    expect((await getProjectBuilds(env.db, otherProject.id)).length).toBe(0);
    expect((await getProjectBuilds(env.db, project.id))[0].github_run_id).toBe('111');
  });

  it('supersedes the active build when a NEW run targets the SAME project+branch (latest-wins)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-supersede');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);

    setVerifyResult(makeClaims({ run_id: '111' }));
    const first = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { buildId: string };

    setVerifyResult(makeClaims({ run_id: '222' }));
    const second = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { buildId: string };

    const builds111 = await getBuild(env.db, firstJson.buildId);
    expect(builds111!.status).toBe('cancelled');
    expect(builds111!.error).toBe('superseded by newer run');
    expect((await getBuild(env.db, secondJson.buildId))!.status).toBe('building');
  });

  // Decision: Build-slot acquisition is atomic per user. A count-then-insert flow would let two parallel
  // exchanges for different run_ids each read capacity below the cap and both insert, bypassing
  // `concurrentBuilds`. Slot acquisition runs in one transaction under a per-user FOR UPDATE lock, so
  // concurrent exchanges serialize.

  it('admits only ONE of two concurrent exchanges for different runs at a cap of 1', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-race');
    await seedActiveInstallation(env.db, '1');
    const connection = await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    // Decision: The OIDC verifier stub is a shared module-level value, so two concurrent exchanges can't each
    // carry their own claims through one `verifyResult`. Drive the race at the db layer instead: the
    // route's slot acquisition and insert is `createGithubActionsBuildWithinLimit`, so racing it
    // directly exercises the same code path.
    const [a, b] = await Promise.all([
      createGithubActionsBuildWithinLimit(env.db, {
        projectId: project.id,
        githubRunId: '301',
        githubRunAttempt: '1',
        connectionId: connection.id,
        installationId: '1',
        repositoryId: '42',
        expectedWorkflowPath: '.github/workflows/bwf-deploy.yml',
      }),
      createGithubActionsBuildWithinLimit(env.db, {
        projectId: project.id,
        githubRunId: '302',
        githubRunAttempt: '1',
        connectionId: connection.id,
        installationId: '1',
        repositoryId: '42',
        expectedWorkflowPath: '.github/workflows/bwf-deploy.yml',
      }),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['created', 'limit-exceeded']);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    const active = projectBuilds.filter((bld) =>
      ['starting', 'building', 'deploying'].includes(bld.status),
    );
    expect(active.length).toBe(1);
  });

  // Decision: A PATCH can re-point the connected branch after the route's pre-tx branch check (which reads the
  // old snapshot and passes) but before the helper takes the FOR UPDATE row lock. The locked row is
  // authoritative: the helper sees the new branch and returns `branch-mismatch` (409), and no build
  // is created. The test commits the PATCH inside the `/compare/` fetch mock, which the route calls
  // after the pre-tx check and before the locked re-read.
  it('returns 409 and creates no build when the branch is re-pointed mid-exchange', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-branch-race');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ ref: 'refs/heads/main', sha: 'sha-oidc' }));

    let patched = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/access_tokens')) {
          return Response.json({
            token: 'installation-token-stub',
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          });
        }
        if (url.includes('/compare/')) {
          if (!patched) {
            patched = true;
            await updateGitHubConnection(env.db, project.id, { branch: 'release' });
          }
          return Response.json({ status: 'identical' });
        }
        if (url.includes('/installation')) {
          return Response.json({ id: '1', account: { id: 'octo-id' } });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'connected branch changed concurrently',
    });

    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  // Decision: A completed GitHub Actions run can be re-run. The composite partial-unique index is scoped to
  // active statuses, so once the prior attempt is terminal a rerun of the same run_id starts a fresh
  // build instead of colliding on the terminal row. The workflow_run webhook then finalizes the
  // active rerun.

  it('lets a run be re-run after the prior attempt reaches a terminal status', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-rerun');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);

    setVerifyResult(makeClaims({ run_id: '700' }));
    const first = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { buildId: string };

    await updateBuildStatus(env.db, firstJson.buildId, 'failed', {
      completedAt: new Date().toISOString(),
    });

    setVerifyResult(makeClaims({ run_id: '700' }));
    const rerun = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(rerun.status).toBe(200);
    const rerunJson = (await rerun.json()) as { token: string; buildId: string };
    expect(rerunJson.token).toBeTruthy();
    expect(rerunJson.buildId).not.toBe(firstJson.buildId);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    const run700 = projectBuilds.filter((bld) => bld.github_run_id === '700');
    expect(run700.length).toBe(2);
    const rerunBuild = run700.find((bld) => bld.id === rerunJson.buildId)!;
    expect(rerunBuild.status).toBe('building');
  });

  // Decision: The OIDC exchange binds the deploy token to the scaffolded deploy workflow
  // (`.github/workflows/bwf-deploy.yml`). Otherwise any other workflow in the connected repo that can
  // request `id-token: write` on the connected branch (a hand-added workflow, an unsafe
  // `pull_request_target`, a `workflow_dispatch` of a different file) could mint a deploy token and
  // act as a deploy oracle.

  it('returns 401 and creates no build when the workflow is not bwf-deploy.yml', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-wrong-workflow');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    const otherWorkflow = 'octo/repo/.github/workflows/other.yml@refs/heads/main';
    setVerifyResult(makeClaims({ workflow_ref: otherWorkflow, job_workflow_ref: otherWorkflow }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 when a bwf-deploy.yml path is spoofed under a different repo prefix', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-spoof-prefix');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    const spoofed = 'attacker/evil/.github/workflows/bwf-deploy.yml@refs/heads/main';
    setVerifyResult(makeClaims({ workflow_ref: spoofed, job_workflow_ref: spoofed }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('returns 401 when the workflow_ref claim is missing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-no-workflow-ref');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ workflow_ref: '', job_workflow_ref: '' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('mints a token for the scaffolded bwf-deploy.yml workflow on the connected branch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-good-workflow');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
  });

  it('mints a token when the run matches the connection custom workflow_path', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-custom-workflow');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
      workflowPath: '.github/workflows/ci.yml',
    });

    const app = makeApp(env);
    const ciRef = 'octo/repo/.github/workflows/ci.yml@refs/heads/main';
    setVerifyResult(makeClaims({ workflow_ref: ciRef, job_workflow_ref: ciRef }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
  });

  it('returns 401 for the scaffolded bwf-deploy.yml when the connection pins a custom path', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-custom-rejects-default');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
      workflowPath: '.github/workflows/ci.yml',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('pins each connection to its own workflow_path when two projects share a repo', async () => {
    const user = await createTestUser(env.db);
    const projectDefault = await createTestProject(env.db, user.id, 'oidc-iso-default');
    const projectCustom = await createTestProject(env.db, user.id, 'oidc-iso-custom');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: projectDefault.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await createGitHubConnection(env.db, {
      projectId: projectCustom.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
      workflowPath: '.github/workflows/ci.yml',
    });

    const app = makeApp(env);
    const defaultRef = 'octo/repo/.github/workflows/bwf-deploy.yml@refs/heads/main';
    const ciRef = 'octo/repo/.github/workflows/ci.yml@refs/heads/main';

    setVerifyResult(makeClaims({ workflow_ref: ciRef, job_workflow_ref: ciRef }));
    const crossA = await exchange(app, env, { oidcToken: 'good', project: projectDefault.slug });
    expect(crossA.status).toBe(401);

    setVerifyResult(makeClaims({ workflow_ref: defaultRef, job_workflow_ref: defaultRef }));
    const crossB = await exchange(app, env, { oidcToken: 'good', project: projectCustom.slug });
    expect(crossB.status).toBe(401);

    expect((await getProjectBuilds(env.db, projectDefault.id)).length).toBe(0);
    expect((await getProjectBuilds(env.db, projectCustom.id)).length).toBe(0);

    setVerifyResult(makeClaims({ workflow_ref: ciRef, job_workflow_ref: ciRef }));
    const own = await exchange(app, env, { oidcToken: 'good', project: projectCustom.slug });
    expect(own.status).toBe(200);
    expect((await getProjectBuilds(env.db, projectCustom.id)).length).toBe(1);
  });

  // Decision: Connection identity is keyed on the immutable numeric repository id, not the mutable
  // `repo_full_name`. A repo whose full_name matches but whose id differs (name reuse) mustn't mint a
  // token; a renamed repo (same id, new full_name) still resolves.

  it('returns 401 when the full_name matches but the repository_id differs (name reuse)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-id-mismatch');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '100',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ repository: 'octo/repo', repository_id: '999' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('still resolves a renamed repo by its immutable id (same id, new full_name)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-renamed');
    await seedActiveInstallation(env.db, '1', [{ full_name: 'octo/renamed', id: 100 }], 'selected');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/old-name',
      repositoryId: '100',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ repository: 'octo/renamed', repository_id: '100' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
  });

  // Decision: A repo may back several github_actions projects (only project_id is unique). Resolution selects
  // the connection by the workflow's requested project slug, so an older project still deploys
  // instead of losing to the newest connection. With no slug, an ambiguous repo is rejected.

  it('mints a token for the OLDER project when two projects share a repo and a slug is given', async () => {
    const user = await createTestUser(env.db);
    const projectOld = await createTestProject(env.db, user.id, 'oidc-multi-old');
    const projectNew = await createTestProject(env.db, user.id, 'oidc-multi-new');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: projectOld.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await createGitHubConnection(env.db, {
      projectId: projectNew.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good', project: projectOld.slug });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { projectId: string };
    expect(json.projectId).toBe(projectOld.id);

    expect((await getProjectBuilds(env.db, projectOld.id)).length).toBe(1);
    expect((await getProjectBuilds(env.db, projectNew.id)).length).toBe(0);
  });

  it('returns 401 (ambiguous) when two projects share a repo and no slug is supplied', async () => {
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id, 'oidc-ambig-a');
    const projectB = await createTestProject(env.db, user.id, 'oidc-ambig-b');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: projectA.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await createGitHubConnection(env.db, {
      projectId: projectB.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good' });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toContain('multiple projects');

    expect((await getProjectBuilds(env.db, projectA.id)).length).toBe(0);
    expect((await getProjectBuilds(env.db, projectB.id)).length).toBe(0);
  });

  it('returns 401 when the repository_id claim is missing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-no-repo-id');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ repository_id: '' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('returns 401 when the repository_owner_id claim is missing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-no-owner-id');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ repository_owner_id: '' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  // Decision: A repo transfer keeps the immutable `repository_id` but changes the owning account. Without
  // binding the installation account to the OIDC `repository_owner_id`, a workflow in the new owner's
  // repo would match the old owner's stale `all`-repos connection (same id) and mint a deploy token
  // for the wrong project.

  it('returns 401 when a transferred repo (same id, new owner) hits a stale all-repos connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-transferred');
    await seedActiveInstallation(env.db, '1', [], 'all', 'alice-id');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ repository_id: '42', repository_owner_id: 'bob-id' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('mints a token when the OIDC repository_owner_id matches the installation account', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-owner-match');
    await seedActiveInstallation(env.db, '1', [], 'all', 'alice-id');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ repository_id: '42', repository_owner_id: 'alice-id' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
  });

  // Decision: The cached `github_installations` state can lag a missed or delayed installation, suspend or
  // installation_repositories webhook, so the OIDC exchange also makes a live App-JWT
  // `GET /repos/{repo}/installation` call. It fails closed when the App no longer covers the repo
  // (404), the covering installation id changed, or the live owner differs from the OIDC owner claim.

  it('returns 401 and creates no build when the live install check 404s (App removed)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-live-404');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    setLiveInstall({ status: 404 });

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('returns 401 and creates no build when the live installation id mismatches', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-live-id-mismatch');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    setLiveInstall({ installationId: '999' });

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('returns 401 and creates no build when the live owner differs from the OIDC owner claim', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-live-owner-mismatch');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    setLiveInstall({ accountId: 'someone-else-id' });

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  // Decision: Stale-SHA guard (fail closed): the auto-deploy OIDC exchange proceeds only when the live branch
  // head is `claims.sha` ('identical'). 'ahead' (sha stale), 'behind' (branch moved backward off the
  // sha via force-push or rollback, so it's an abandoned commit) and 'diverged' (sha force-pushed
  // off-branch) get 409. An unverifiable verdict (null, compare API unreachable) gets a retryable
  // 503. Failing open would let an older or abandoned run supersede the newer active build and mint a
  // token during a GitHub API outage, rolling the project back.

  it('returns 409 and creates no build when claims.sha is behind the branch head (compare === ahead)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-stale-sha');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ sha: 'old-commit' }));
    setCompareStatus('ahead');

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(409);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('mints a token when the run sha IS the branch head (compare === identical)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-head-sha');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    setCompareStatus('identical');

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
  });

  it('returns 503 and creates no build when the compare API is unreachable (compare === null)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-compare-unreachable');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    setCompareStatus(null);

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(503);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('returns 409 and creates no build when claims.sha is off-branch (compare === diverged)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-diverged-sha');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ sha: 'force-pushed-away' }));
    setCompareStatus('diverged');

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(409);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('returns 409 and creates no build when the branch head was moved backward off the sha (compare === behind)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-behind-head');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ sha: 'abandoned-commit' }));
    setCompareStatus('behind');

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(409);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  // Decision: Compare-to-insert TOCTOU: a newer push landing between the pre-check and the build INSERT is
  // invisible to the push webhook's terminateBuildsForProject cleanup (no row exists yet), so the
  // route re-checks freshness after creating the row and cancels it itself instead of minting a
  // token for the stale run.

  it('returns 409, mints no token, and cancels the created build when a newer push lands between the pre-check and the insert', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-toctou-ahead');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    setCompareStatusQueue(['identical', 'ahead']);

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'oidc sha is not the current branch head',
    });

    const rows = await getProjectBuilds(env.db, project.id);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].error).toBe('superseded by newer push during token exchange');
  });

  it('returns 503, mints no token, and cancels the created build when the post-create re-check is unverifiable', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-toctou-null');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    // Decision: Fail closed and cancel the row: an orphaned active row would hold a slot until the reaper. The
    // retried exchange re-inserts cleanly (terminal rows are outside the partial-unique index and
    // skipped by idempotent reuse).
    setCompareStatusQueue(['identical', null]);

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'unable to verify branch head; retry',
    });

    const rows = await getProjectBuilds(env.db, project.id);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].error).toBe('superseded by newer push during token exchange');
  });

  it('mints a token when the live install check confirms App coverage (default mock)', async () => {
    const user = await createTestUser(env.db, 'octo-live-ok');
    const project = await createTestProject(env.db, user.id, 'oidc-live-ok');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
  });

  // Decision: The exchange allowlists the GitHub Actions trigger event. A `pull_request_target` run executes in
  // the base-branch context, so its claims carry `ref=refs/heads/<connected-branch>` and
  // `sha=<branch head>`: it passes the `refs/heads/` check, the branch match and the 'identical'
  // freshness gate, yet can check out untrusted PR-head code. Only `push` (scaffolded) and
  // `workflow_dispatch` (collaborator-only) may mint.

  it('returns 401 and creates no build for a pull_request_target trigger (freshness gate would pass)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-pr-target');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ event_name: 'pull_request_target' }));
    setCompareStatus('identical');

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('returns 401 and creates no build for a pull_request trigger', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-pr');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ event_name: 'pull_request' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('mints a token for a workflow_dispatch trigger (trusted manual run)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-dispatch');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ event_name: 'workflow_dispatch' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
  });

  it('returns 401 and creates no build when the event_name claim is missing (fail-closed)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-no-event');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ event_name: '' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });
});
