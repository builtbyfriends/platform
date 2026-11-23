import { eq, sql } from 'drizzle-orm';
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
  deleteGitHubConnection,
  getBuild,
  getGitHubConnection,
  getGitHubInstallation,
  getInstallationRevocationAt,
  getProject,
  getProjectBuilds,
  markGitHubInstallationStatus,
  setBuildCheckRunId,
  upsertGitHubInstallation,
  upsertGitHubInstallationMember,
} from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
// Decision: Namespace import so a test can spy the pre-tx `getGitHubInstallation` snapshot (the under-lock
// re-read inside the handler hits the row directly, not via this).
import * as db from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { createGitHubWebhookIngressProof } from '../../src/github/webhook-ingress-auth.ts';
import { scheduled } from '../../src/index.ts';
import internalGitHubWebhook from '../../src/routes/internal-github-webhook.ts';
import { webhookRoutes } from '../../src/routes/webhooks.ts';
import {
  builds,
  deployments,
  githubConnections,
  githubInstallations,
  projectMembers,
} from '../../src/schema.ts';
import {
  getTestGitHubInstallationMembers,
  createTestBuild,
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  recordingBuildManager,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

const WEBHOOK_SECRET = 'test-webhook-secret';
const INGRESS_SECRET = 'test-purpose-separated-ingress-secret';
const DELIVERY_ID = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

// Decision: The push handler makes a live GitHub compare call to detect a stale out-of-order push. The handler
// fails closed: it builds only when the push is the current branch head ('identical') and skips
// 'ahead' (stale), 'behind' (branch moved backward off the sha), 'diverged' (off-branch) and null
// (compare API unreachable). The default 'identical' lets push tests that don't exercise the gate
// create their build.
let compareStatus: string | null = 'identical';
function setCompareStatus(status: string | null): void {
  compareStatus = status;
}
// Decision: A commit can be the head of one connected branch and not another, which the single
// `compareStatus` can't express.
let compareStatusByBranch: Record<string, string | null> | null = null;
function setCompareStatusByBranch(map: Record<string, string | null> | null): void {
  compareStatusByBranch = map;
}

// Decision: Concurrency probe for the rerun fan-out. A `check_suite` rerequest compares one branch head per
// distinct branch, and GitHub drops a webhook delivery it hasn't answered in 10s (with no automatic
// redelivery), so those compares can't run in series. When armed with N, each compare call parks
// until N are in flight at once. `compareConcurrencyPeak` is monotonic, so a serial handler tops out
// at 1, releases each call on the deadline, and the test fails on the assertion rather than hanging.
let compareInFlight = 0;
let compareConcurrencyPeak = 0;
let compareBarrierSize = 0;
function armCompareConcurrencyProbe(size: number): void {
  compareInFlight = 0;
  compareConcurrencyPeak = 0;
  compareBarrierSize = size;
}

// Decision: Used to inject a revocation that commits after the push resolver's checks but before the
// supersede/create tx; the compare call sits in that window.
let compareSideEffect: (() => Promise<void>) | null = null;
function setCompareSideEffect(fn: (() => Promise<void>) | null): void {
  compareSideEffect = fn;
}

// Decision: The branch-delete handler re-verifies git state via `getBranchExistence` before cancelling (a stale
// or out-of-order delete mustn't clobber a valid recreated-branch build). 'present' (recreated) and
// 'unknown' (unconfirmed) both fail closed and skip cancellation.
let branchExistence: 'present' | 'absent' | 'unknown' = 'absent';
function setBranchExistence(value: 'present' | 'absent' | 'unknown'): void {
  branchExistence = value;
}

// Decision: The installation_repositories handler refetches the authoritative repo list on an `all` to
// `selected` narrowing, because the cached array is empty for `all` installs on purpose and the
// event delta can't rebuild the kept set.
let listReposResult: {
  repositories: ReadonlyArray<{ full_name: string; id: number }>;
  owner: undefined;
  repositorySelection: 'all' | 'selected';
} = { repositories: [], owner: undefined, repositorySelection: 'selected' };
function setListReposResult(
  repositories: ReadonlyArray<{ full_name: string; id: number }>,
  repositorySelection: 'all' | 'selected' = 'selected',
): void {
  listReposResult = { repositories, owner: undefined, repositorySelection };
}

vi.mock('../../src/github/installation-token.ts', () => ({
  getBranchHeadComparisonStatus: async (
    _env: unknown,
    _installationId: unknown,
    _repo: unknown,
    _sha: unknown,
    branch?: string,
  ) => {
    if (compareBarrierSize > 1) {
      compareInFlight++;
      compareConcurrencyPeak = Math.max(compareConcurrencyPeak, compareInFlight);
      // Decision: Wait on the monotonic peak, not the live count: the last arrival exits at once and decrements,
      // which would otherwise strand its peers.
      const deadline = Date.now() + 1000;
      while (compareConcurrencyPeak < compareBarrierSize && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      compareInFlight--;
    }
    if (compareSideEffect) {
      const fn = compareSideEffect;
      compareSideEffect = null;
      await fn();
    }
    if (compareStatusByBranch && branch !== undefined && branch in compareStatusByBranch) {
      return compareStatusByBranch[branch]!;
    }
    return compareStatus;
  },
  getBranchExistence: async () => branchExistence,
  getInstallationToken: async () => 'tok',
  // Decision: check-run.ts imports these constants from installation-token.ts. The mock replaces the whole
  // module, so re-export them, or completeCheckRun's fetch URL resolves to `undefined` and throws.
  GITHUB_API_BASE: 'https://api.github.com',
  GITHUB_API_VERSION: '2026-03-10',
}));

vi.mock('../../src/github/installation-repos.ts', () => ({
  listInstallationRepositories: async () => listReposResult,
}));

let env: TestEnv;

function makeApp(overrideEnv: TestEnv): { app: Hono<ApiEnv>; appEnv: TestEnv } {
  const app = new Hono<ApiEnv>();
  app.use('*', async (context, next) => {
    context.set('db', overrideEnv.db);
    await next();
  });
  app.route('/webhooks', webhookRoutes);
  app.route('/internal/github-webhook', internalGitHubWebhook);
  return { app, appEnv: overrideEnv };
}

async function sign(secret: string, body: string): Promise<string> {
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

async function clearBuildTables(db: Db): Promise<void> {
  await db.delete(builds);
  await db.delete(githubConnections);
  await db.delete(githubInstallations);
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

// Decision: The push resolver (`getGitHubConnectionsByRepo`) INNER JOINs github_installations and requires
// status='active' plus repo membership, so each push test that expects a build seeds one.
async function seedInstallation(
  db: Db,
  installationId: string,
  repositories: ReadonlyArray<{ full_name: string; id: number }> = [],
  repositorySelection: 'all' | 'selected' = repositories.length > 0 ? 'selected' : 'all',
): Promise<void> {
  await upsertGitHubInstallation(db, {
    installationId,
    userId: null,
    accountLogin: `acct-${installationId}`,
    accountId: installationId,
    accountType: 'Organization',
    repositories,
    repositorySelection,
  });
}

async function post(
  app: Hono<ApiEnv>,
  appEnv: TestEnv,
  event: string,
  payload: unknown,
  options?: { secret?: string | null; signature?: string | null; withSecret?: boolean },
): Promise<Response> {
  const body = JSON.stringify(payload);
  const withSecret = options?.withSecret ?? true;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': event,
  };
  if (options?.signature !== undefined && options.signature !== null) {
    headers['X-Hub-Signature-256'] = options.signature;
  } else if (options?.signature !== null) {
    headers['X-Hub-Signature-256'] = await sign(options?.secret ?? WEBHOOK_SECRET, body);
  }
  // Decision: The workflow_run handler defers the check-run completion onto `executionCtx.waitUntil` (off the
  // webhook 2xx path). Capture those promises and await them before returning so tests can assert the
  // PATCH deterministically: real Workers await waitUntil on response close, but Hono passes the ctx
  // through without awaiting.
  const pending: Array<Promise<unknown>> = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const res = await app.fetch(
    new Request('http://localhost/webhooks/github', { method: 'POST', headers, body }),
    { ...appEnv, GITHUB_WEBHOOK_SECRET: withSecret ? WEBHOOK_SECRET : undefined },
    executionCtx,
  );
  await Promise.all(pending);
  return res;
}

async function postThroughIngressOperation(
  app: Hono<ApiEnv>,
  appEnv: TestEnv,
  event: string,
  payload: unknown,
  options?: {
    deliveryId?: string;
    timestampSeconds?: number;
    proofBody?: string;
    proof?: string;
    signature?: string;
  },
): Promise<Response> {
  const body = JSON.stringify(payload);
  const bodyBytes = new TextEncoder().encode(body);
  const deliveryId = options?.deliveryId ?? DELIVERY_ID;
  const timestampSeconds = options?.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const proof =
    options?.proof ??
    (await createGitHubWebhookIngressProof({
      secret: INGRESS_SECRET,
      timestampSeconds,
      deliveryId,
      event,
      body: new TextEncoder().encode(options?.proofBody ?? body),
    }));
  const response = await app.fetch(
    new Request('https://platform-api.internal/internal/github-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event,
        'X-GitHub-Delivery': deliveryId,
        'X-Hub-Signature-256': options?.signature ?? (await sign(WEBHOOK_SECRET, body)),
        'X-Platform-GitHub-Ingress-Timestamp': String(timestampSeconds),
        'X-Platform-GitHub-Ingress-Proof': proof,
      },
      body: bodyBytes,
    }),
    {
      ...appEnv,
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GITHUB_WEBHOOK_INGRESS_SECRET: INGRESS_SECRET,
    },
    {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  );
  return response;
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
  setCompareStatus('identical');
  setCompareStatusByBranch(null);
  armCompareConcurrencyProbe(0);
  setCompareSideEffect(null);
  setBranchExistence('absent');
  setListReposResult([], 'selected');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('POST /webhooks/github', () => {
  it('returns 503 when the webhook secret is unset', async () => {
    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {}, { withSecret: false });
    expect(res.status).toBe(503);
  });

  it('returns 401 on a bad signature', async () => {
    const { app, appEnv } = makeApp(env);
    const res = await post(
      app,
      appEnv,
      'push',
      { ref: 'refs/heads/main' },
      {
        signature: 'sha256=deadbeef',
      },
    );
    expect(res.status).toBe(401);
  });

  it('rejects an invalid or expired ingress proof before webhook processing', async () => {
    const { app, appEnv } = makeApp(env);
    const invalid = await postThroughIngressOperation(
      app,
      appEnv,
      'push',
      {},
      {
        proof: `sha256=${'0'.repeat(64)}`,
      },
    );
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({ error: 'invalid ingress proof' });

    const expired = await postThroughIngressOperation(
      app,
      appEnv,
      'push',
      {},
      {
        timestampSeconds: Math.floor(Date.now() / 1000) - 301,
      },
    );
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: 'invalid ingress proof' });
  });

  it('binds the ingress proof to the exact body and still verifies GitHub independently', async () => {
    const { app, appEnv } = makeApp(env);
    const mutated = await postThroughIngressOperation(
      app,
      appEnv,
      'push',
      { value: 2 },
      {
        proofBody: JSON.stringify({ value: 1 }),
      },
    );
    expect(mutated.status).toBe(401);
    expect(await mutated.json()).toEqual({ error: 'invalid ingress proof' });

    const invalidGitHub = await postThroughIngressOperation(
      app,
      appEnv,
      'push',
      {},
      {
        signature: `sha256=${'0'.repeat(64)}`,
      },
    );
    expect(invalidGitHub.status).toBe(401);
    expect(await invalidGitHub.json()).toEqual({ error: 'invalid signature' });
  });

  it('creates a container build row and pokes the scheduler on a matching push', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-container');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '5551',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '555');

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 5551 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; buildIds: ReadonlyArray<string> };
    expect(json.ok).toBe(true);
    expect(json.buildIds).toHaveLength(1);

    const build = await getBuild(env.db, json.buildIds[0]);
    expect(build).not.toBeNull();
    expect(build!.executor).toBe('container');
    expect(build!.status).toBe('queued');
    expect(build!.commit_sha).toBe('abc1234');
    expect(build!.branch).toBe('main');
    expect(build!.project_id).toBe(project.id);
    expect(build!.user_id).toBe(user.id);
    expect(build!.instance_type).toBe('standard-3');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [pokeUrl, pokeInit] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(pokeUrl).toContain('/poke');
    expect(pokeInit.method).toBe('POST');
  });

  it("persists a paid owner's container size (standard-4) on the build row at enqueue", async () => {
    const user = await createTestUser(env.db, 'paid-owner', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id, 'wh-paid');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '556',
      repoFullName: 'octo/paid',
      repositoryId: '5561',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '556');
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'paid123',
      installation: { id: 556 },
      repository: { full_name: 'octo/paid', id: 5561 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);

    const build = await getBuild(env.db, json.buildIds[0]);
    expect(build!.executor).toBe('container');
    expect(build!.user_id).toBe(user.id);
    expect(build!.instance_type).toBe('standard-4');
  });

  it('ignores a stale push whose sha is behind the branch head (compare === ahead)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-stale-push');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '715167',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '555');
    const { app, appEnv } = makeApp(env);

    setCompareStatus('ahead');

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'oldsha1',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 715_167 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'push is not the current branch head',
    });
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(0);
  });

  it('builds a push whose sha IS the branch head (compare === identical)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-head-push');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '5552',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '555');

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);

    setCompareStatus('identical');

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'headsha1',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 5552 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);
    const build = await getBuild(env.db, json.buildIds[0]);
    expect(build!.commit_sha).toBe('headsha1');
    expect(build!.status).toBe('queued');
  });

  it('ignores a push when the branch head was moved backward off the sha (compare === behind), leaving the queued build intact', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-behind-push');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '715167',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '555');
    const existing = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'queued',
      commitSha: 'newer-queued',
      branch: 'main',
    });
    const { app, appEnv } = makeApp(env);

    setCompareStatus('behind');

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abandonedsha',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 715_167 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'push is not the current branch head',
    });
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(1);
    const stillQueued = await getBuild(env.db, existing.id);
    expect(stillQueued!.status).toBe('queued');
    expect(stillQueued!.commit_sha).toBe('newer-queued');
  });

  it('ignores a push when the compare API is unreachable (compare === null), leaving the queued build intact', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-null-push');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '715167',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '555');
    const existing = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'queued',
      commitSha: 'newer-queued',
      branch: 'main',
    });
    const { app, appEnv } = makeApp(env);

    setCompareStatus(null);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'unverifiable',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 715_167 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'push is not the current branch head',
    });
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(1);
    const stillQueued = await getBuild(env.db, existing.id);
    expect(stillQueued!.status).toBe('queued');
    expect(stillQueued!.commit_sha).toBe('newer-queued');
  });

  it('ignores a push whose sha is off-branch (compare === diverged), leaving the queued build intact', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-diverged-push');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '715167',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '555');
    const existing = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'queued',
      commitSha: 'newer-queued',
      branch: 'main',
    });
    const { app, appEnv } = makeApp(env);

    setCompareStatus('diverged');

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'orphansha',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 715_167 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'push is not the current branch head',
    });
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(1);
    const stillQueued = await getBuild(env.db, existing.id);
    expect(stillQueued!.status).toBe('queued');
    expect(stillQueued!.commit_sha).toBe('newer-queued');
  });

  it('ignores a push to a non-connected branch (no build row)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-branch');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '715167',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '555');
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/feature',
      after: 'abc1234',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 715_167 },
    });

    expect(res.status).toBe(200);
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(0);
  });

  it('does not create a build for github_actions executor on push', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-actions');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '777',
      repoFullName: 'octo/actions-repo',
      repositoryId: '886845',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '777');
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'def5678',
      installation: { id: 777 },
      repository: { full_name: 'octo/actions-repo', id: 886_845 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { executor?: string }).toMatchObject({
      executor: 'github_actions',
    });
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(0);
  });

  it('skips a branch-delete push (all-zero after sha)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-delete');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '715167',
      branch: 'main',
      buildExecutor: 'container',
    });
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 715_167 },
    });

    expect(res.status).toBe(200);
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(0);
  });

  it('upserts an installation on installation:created', async () => {
    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9001,
        account: { login: 'octo-org', id: 42, type: 'Organization' },
        repository_selection: 'selected',
      },
      repositories: [{ full_name: 'octo-org/site', id: 1 }],
    });

    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9001');
    expect(installation).not.toBeNull();
    expect(installation!.account_login).toBe('octo-org');
    expect(installation!.account_id).toBe('42');
    expect(installation!.account_type).toBe('Organization');
    expect(installation!.status).toBe('active');
    expect(installation!.repositories).toEqual([{ full_name: 'octo-org/site', id: 1 }]);
    expect(installation!.repository_selection).toBe('selected');
  });

  it('records repository_selection=all on an all-repos install', async () => {
    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9011,
        account: { login: 'octo-all', id: 11, type: 'Organization' },
        repository_selection: 'all',
      },
      repositories: [],
    });

    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9011');
    expect(installation!.repository_selection).toBe('all');
    expect(installation!.repositories).toEqual([]);
  });

  it('marks an installation deleted on installation:deleted', async () => {
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: { id: 9002, account: { login: 'octo', id: 7, type: 'User' } },
      repositories: [],
    });
    const res = await post(app, appEnv, 'installation', {
      action: 'deleted',
      installation: { id: 9002 },
    });
    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9002');
    expect(installation!.status).toBe('deleted');
  });

  it('does NOT reactivate a deleted installation from a stale/redelivered created', async () => {
    // Decision: A real reinstall gets a new installation_id, so a `created` that conflicts with an existing row is
    // a stale replay. After `deleted` it stays `deleted`; otherwise the connection resolvers (which gate
    // only on status='active') would resume minting deploy tokens for an App the user removed.
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: { id: 9020, account: { login: 'octo', id: 7, type: 'User' } },
      repositories: [],
    });
    await post(app, appEnv, 'installation', { action: 'deleted', installation: { id: 9020 } });
    const res = await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9020,
        account: { login: 'octo', id: 7, type: 'User' },
        repository_selection: 'selected',
      },
      repositories: [{ full_name: 'octo/site', id: 1 }],
    });
    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9020');
    expect(installation!.status).toBe('deleted');
  });

  it('does NOT reactivate a suspended installation from a stale/redelivered created', async () => {
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: { id: 9021, account: { login: 'octo', id: 7, type: 'User' } },
      repositories: [],
    });
    await post(app, appEnv, 'installation', { action: 'suspend', installation: { id: 9021 } });
    const res = await post(app, appEnv, 'installation', {
      action: 'created',
      installation: { id: 9021, account: { login: 'octo', id: 7, type: 'User' } },
      repositories: [],
    });
    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9021');
    expect(installation!.status).toBe('suspended');
    await post(app, appEnv, 'installation', { action: 'unsuspend', installation: { id: 9021 } });
    const after = await getGitHubInstallation(env.db, '9021');
    expect(after!.status).toBe('active');
  });

  it('does NOT roll back the repo cache from a stale/redelivered created', async () => {
    // Decision: Installation ids aren't reused, so a conflicting `created` is stale and mustn't overwrite repo
    // membership the authoritative `installation_repositories` handler has since advanced.
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9030,
        account: { login: 'octo', id: 7, type: 'User' },
        repository_selection: 'selected',
      },
      repositories: [{ full_name: 'octo/a', id: 1 }],
    });
    await post(app, appEnv, 'installation_repositories', {
      action: 'added',
      installation: { id: 9030 },
      repositories_added: [{ full_name: 'octo/b', id: 2 }],
      repositories_removed: [],
      repository_selection: 'selected',
    });
    expect(
      (await getGitHubInstallation(env.db, '9030'))!.repositories.map((r) => r.id).sort(),
    ).toEqual([1, 2]);
    const res = await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9030,
        account: { login: 'octo', id: 7, type: 'User' },
        repository_selection: 'selected',
      },
      repositories: [{ full_name: 'octo/a', id: 1 }],
    });
    expect(res.status).toBe(200);
    const after = await getGitHubInstallation(env.db, '9030');
    expect(after!.repositories.map((r) => r.id).sort()).toEqual([1, 2]);
    expect(after!.repository_selection).toBe('selected');
  });

  it('does NOT downgrade an all selection from a stale/redelivered created that says selected', async () => {
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9031,
        account: { login: 'octo', id: 7, type: 'User' },
        repository_selection: 'all',
      },
      repositories: [],
    });
    const res = await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9031,
        account: { login: 'octo', id: 7, type: 'User' },
        repository_selection: 'selected',
      },
      repositories: [{ full_name: 'octo/a', id: 1 }],
    });
    expect(res.status).toBe(200);
    expect((await getGitHubInstallation(env.db, '9031'))!.repository_selection).toBe('all');
  });

  it('does NOT revive a deleted installation from a stale/redelivered unsuspend', async () => {
    // Decision: unsuspend is guarded to the suspended -> active transition. A stale unsuspend landing after a
    // later `deleted` leaves the row terminal; otherwise the resolvers (status='active' only) would
    // re-grant deploys.
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: { id: 9022, account: { login: 'octo', id: 7, type: 'User' } },
      repositories: [],
    });
    await post(app, appEnv, 'installation', { action: 'suspend', installation: { id: 9022 } });
    await post(app, appEnv, 'installation', { action: 'deleted', installation: { id: 9022 } });
    const res = await post(app, appEnv, 'installation', {
      action: 'unsuspend',
      installation: { id: 9022 },
    });
    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9022');
    expect(installation!.status).toBe('deleted');
  });

  it('does NOT let a stale suspend walk a deleted install back to suspended (then unsuspend)', async () => {
    // Decision: The harder chain: suspend -> deleted -> stale suspend -> stale unsuspend. The stale suspend
    // mustn't rewrite deleted -> suspended, or the stale unsuspend's suspended -> active guard would
    // re-arm and revive the removed App.
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: { id: 9023, account: { login: 'octo', id: 7, type: 'User' } },
      repositories: [],
    });
    await post(app, appEnv, 'installation', { action: 'suspend', installation: { id: 9023 } });
    await post(app, appEnv, 'installation', { action: 'deleted', installation: { id: 9023 } });
    await post(app, appEnv, 'installation', { action: 'suspend', installation: { id: 9023 } });
    expect((await getGitHubInstallation(env.db, '9023'))!.status).toBe('deleted');
    await post(app, appEnv, 'installation', { action: 'unsuspend', installation: { id: 9023 } });
    expect((await getGitHubInstallation(env.db, '9023'))!.status).toBe('deleted');
  });

  it('applies the repository delta on installation_repositories', async () => {
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: { id: 9003, account: { login: 'octo', id: 7, type: 'User' } },
      repositories: [
        { full_name: 'octo/a', id: 1 },
        { full_name: 'octo/b', id: 2 },
      ],
    });

    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'added',
      installation: { id: 9003 },
      repositories_added: [{ full_name: 'octo/c', id: 3 }],
      repositories_removed: [{ full_name: 'octo/a', id: 1 }],
      repository_selection: 'selected',
    });

    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9003');
    const ids = installation!.repositories.map((r) => r.id).sort();
    expect(ids).toEqual([2, 3]);
    expect(installation!.repository_selection).toBe('selected');
  });

  it('updates repository_selection when the install flips to all', async () => {
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9004,
        account: { login: 'octo', id: 8, type: 'User' },
        repository_selection: 'selected',
      },
      repositories: [{ full_name: 'octo/a', id: 1 }],
    });

    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'added',
      installation: { id: 9004 },
      repositories_added: [],
      repositories_removed: [],
      repository_selection: 'all',
    });

    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9004');
    expect(installation!.repository_selection).toBe('all');
  });

  // Decision: When an `all` install narrows to `selected`, the cached `repositories` array is empty by design,
  // so applying the event's delta would persist `selected` with no kept repos and break builds for
  // repos the user kept. The handler refetches the authoritative accessible set instead.
  it('refetches the repo list when an all install narrows to selected', async () => {
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9005,
        account: { login: 'octo', id: 9, type: 'User' },
        repository_selection: 'all',
      },
      repositories: [],
    });

    setListReposResult([
      { full_name: 'octo/keep1', id: 11 },
      { full_name: 'octo/keep2', id: 22 },
    ]);

    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'removed',
      installation: { id: 9005 },
      repositories_added: [],
      repositories_removed: [{ full_name: 'octo/dropped', id: 99 }],
      repository_selection: 'selected',
    });

    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9005');
    expect(installation!.repository_selection).toBe('selected');
    const ids = installation!.repositories.map((r) => r.id).sort((a, b) => a - b);
    expect(ids).toEqual([11, 22]);
  });

  // Decision: A stale all -> selected delivery arriving after the user switched the App back to `all`. The
  // refetch reports `all`, so each repo is still covered, and the stale `repositories_removed` mustn't
  // cancel the in-flight build for a covered repo (that would revoke a valid token and tear down a
  // valid container).
  it('does not cancel builds when a stale all→selected refetch reports all', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stale-all-narrow');
    await seedInstallation(env.db, '9006', [], 'all');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9006',
      repoFullName: 'octo/still-covered',
      repositoryId: '9601',
      branch: 'main',
      buildExecutor: 'container',
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-stale',
      branch: 'main',
    });

    setListReposResult([], 'all');

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'removed',
      installation: { id: 9006 },
      repositories_added: [],
      repositories_removed: [{ full_name: 'octo/still-covered', id: 9601 }],
      repository_selection: 'selected',
    });

    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9006');
    expect(installation!.repository_selection).toBe('all');
    // Decision: The `selection === 'all'` guard returns early before the revocation tx, so no DO cancel is
    // attempted either.
    const after = await getBuild(env.db, build.id);
    expect(after!.status).toBe('building');
  });

  it('completes a seeded actions build on workflow_run:completed (success)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-wfr');
    // Decision: The workflow_run handler resolves the build by mapping the payload repo (installation +
    // full_name) to a connected project first, so a matching connection has to exist.
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '321',
      repoFullName: 'octo/wfr',
      repositoryId: '855536',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '321');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    // Decision: The build links to the deployment via commit sha, so stamp the deployment commit to match the
    // workflow head sha.
    await env.db
      .update(deployments)
      .set({ commit: 'sha-success' })
      .where(eq(deployments.id, deployment.id));

    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-success',
      branch: 'main',
      githubRunId: '123456',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 321 },
      repository: { full_name: 'octo/wfr', id: 855_536 },
      workflow_run: { id: 123_456, run_attempt: 1, conclusion: 'success', head_sha: 'sha-success' },
    });

    expect(res.status).toBe(200);
    const updated = await getBuild(env.db, build.id);
    expect(updated!.status).toBe('complete');
    expect(updated!.deployment_id).toBe(deployment.id);
    expect(updated!.completed_at).not.toBeNull();
  });

  it('fails a seeded actions build on workflow_run:completed (failure)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-wfr-fail');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '322',
      repoFullName: 'octo/wfr-fail',
      repositoryId: '871475',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '322');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-fail',
      branch: 'main',
      githubRunId: '654321',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 322 },
      repository: { full_name: 'octo/wfr-fail', id: 871_475 },
      workflow_run: { id: 654_321, run_attempt: 1, conclusion: 'failure', head_sha: 'sha-fail' },
    });

    expect(res.status).toBe(200);
    const updated = await getBuild(env.db, build.id);
    expect(updated!.status).toBe('failed');
    expect(updated!.deployment_id).toBeNull();
  });

  it('ignores a workflow_run:completed without run_attempt (build unchanged)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-wfr-no-attempt');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '323',
      repoFullName: 'octo/wfr-no-attempt',
      repositoryId: '871476',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '323');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-no-attempt',
      branch: 'main',
      githubRunId: '654322',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 323 },
      repository: { full_name: 'octo/wfr-no-attempt', id: 871_476 },
      workflow_run: { id: 654_322, conclusion: 'success', head_sha: 'sha-no-attempt' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'missing workflow_run run_attempt' });
    const unchanged = await getBuild(env.db, build.id);
    expect(unchanged!.status).toBe('building');
    expect(unchanged!.completed_at).toBeNull();
  });

  // Decision: github_actions builds have no BuildManager DO, so the check run created at OIDC-exchange time is
  // finalized here, on workflow_run:completed.
  it('completes the "Platform Build" check run on workflow_run:completed (success)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-check-ok');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '331',
      repoFullName: 'octo/check-ok',
      repositoryId: '766742',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '331');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-check-ok',
      branch: 'main',
      githubRunId: '424250',
      githubRunAttempt: '1',
    });
    await setBuildCheckRunId(env.db, build.id, '5001');

    // Decision: getInstallationToken is module-mocked, so completeCheckRun's only network call is the PATCH.
    const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: 5001 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 331 },
      repository: { full_name: 'octo/check-ok', id: 766_742 },
      workflow_run: {
        id: 424_250,
        run_attempt: 1,
        conclusion: 'success',
        head_sha: 'sha-check-ok',
      },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('complete');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain('/repos/octo/check-ok/check-runs/5001');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string) as { status: string; conclusion: string };
    expect(body.status).toBe('completed');
    expect(body.conclusion).toBe('success');
  });

  it('completes the "Platform Build" check run on workflow_run:completed (failure)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-check-fail');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '332',
      repoFullName: 'octo/check-fail',
      repositoryId: '739072',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '332');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-check-fail',
      branch: 'main',
      githubRunId: '424251',
      githubRunAttempt: '1',
    });
    await setBuildCheckRunId(env.db, build.id, '5002');

    const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: 5002 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 332 },
      repository: { full_name: 'octo/check-fail', id: 739_072 },
      workflow_run: {
        id: 424_251,
        run_attempt: 1,
        conclusion: 'failure',
        head_sha: 'sha-check-fail',
      },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('failed');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain('/repos/octo/check-fail/check-runs/5002');
    const body = JSON.parse(init.body as string) as { conclusion: string };
    expect(body.conclusion).toBe('failure');
  });

  it('does not PATCH a check run when the build has no check_run_id', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-check-none');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '333',
      repoFullName: 'octo/check-none',
      repositoryId: '811598',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '333');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-check-none',
      branch: 'main',
      githubRunId: '424252',
      githubRunAttempt: '1',
    });

    const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({}),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 333 },
      repository: { full_name: 'octo/check-none', id: 811_598 },
      workflow_run: {
        id: 424_252,
        run_attempt: 1,
        conclusion: 'success',
        head_sha: 'sha-check-none',
      },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('complete');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still returns 2xx and finalizes the build when completeCheckRun throws', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-check-throw');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '334',
      repoFullName: 'octo/check-throw',
      repositoryId: '870692',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '334');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-check-throw',
      branch: 'main',
      githubRunId: '424253',
      githubRunAttempt: '1',
    });
    await setBuildCheckRunId(env.db, build.id, '5003');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi
      .spyOn(checkRunModule, 'completeCheckRun')
      .mockRejectedValue(new Error('check-run PATCH exploded'));
    try {
      const { app, appEnv } = makeApp(env);
      const res = await post(app, appEnv, 'workflow_run', {
        action: 'completed',
        installation: { id: 334 },
        repository: { full_name: 'octo/check-throw', id: 870_692 },
        workflow_run: {
          id: 424_253,
          run_attempt: 1,
          conclusion: 'success',
          head_sha: 'sha-check-throw',
        },
      });

      expect(res.status).toBe(200);
      expect((await getBuild(env.db, build.id))!.status).toBe('complete');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  // Decision: The check reflects GitHub's run outcome, so completion is driven from the workflow_run conclusion
  // independent of our build-status CAS. Many out-of-band paths (push-supersede, OIDC latest-wins,
  // disconnect, app or repo removal, teardown, reaper) can drive the build terminal without touching
  // its check, and GitHub still fires workflow_run:completed. A workflow_run for an already-terminal
  // build with a check_run_id still PATCHes the check, or it stays `in_progress` for good.
  it('completes the "Platform Build" check run even when the build is already terminal', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-check-terminal');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '335',
      repoFullName: 'octo/check-terminal',
      repositoryId: '796140',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '335');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'cancelled',
      commitSha: 'sha-check-terminal',
      branch: 'main',
      githubRunId: '424260',
      githubRunAttempt: '1',
    });
    await setBuildCheckRunId(env.db, build.id, '5010');

    const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: 5010 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 335 },
      repository: { full_name: 'octo/check-terminal', id: 796_140 },
      workflow_run: {
        id: 424_260,
        run_attempt: 1,
        conclusion: 'cancelled',
        head_sha: 'sha-check-terminal',
      },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('cancelled');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain('/repos/octo/check-terminal/check-runs/5010');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string) as { status: string; conclusion: string };
    expect(body.status).toBe('completed');
    expect(body.conclusion).toBe('cancelled');
  });

  it('still terminalizes the actions build when the deployment lookup throws (slot-pin fix)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-wfr-lookupthrow');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '323',
      repoFullName: 'octo/wfr-throw',
      repositoryId: '823577',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '323');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ commit: 'sha-throw' })
      .where(eq(deployments.id, deployment.id));
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-throw',
      branch: 'main',
      githubRunId: '777777',
      githubRunAttempt: '1',
    });

    // Decision: A transient Hyperdrive or Postgres failure on the deployment lookup mustn't skip the terminal
    // write, or the build stays active, keeps honoring its deploy token, and pins the user's slot until
    // the hourly reaper.
    const dbModule = await import('../../src/db.ts');
    const spy = vi
      .spyOn(dbModule, 'getDeploymentByProjectAndCommit')
      .mockRejectedValue(new Error('Hyperdrive transient 500'));
    try {
      const { app, appEnv } = makeApp(env);
      const res = await post(app, appEnv, 'workflow_run', {
        action: 'completed',
        installation: { id: 323 },
        repository: { full_name: 'octo/wfr-throw', id: 823_577 },
        workflow_run: { id: 777_777, run_attempt: 1, conclusion: 'success', head_sha: 'sha-throw' },
      });

      expect(res.status).toBe(200);
      const updated = await getBuild(env.db, build.id);
      expect(updated!.status).toBe('complete');
      expect(updated!.deployment_id).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  // Decision: A GitHub `run_id` is unique only within a repository, so a workflow_run for repo X mustn't finalize
  // repo Y's build that shares the numeric run_id. The handler resolves the build scoped to the
  // connected project of the payload's repository.

  it('does not finalize another project build that shares the run_id', async () => {
    const user = await createTestUser(env.db);
    const projectX = await createTestProject(env.db, user.id, 'wh-collide-x');
    const projectY = await createTestProject(env.db, user.id, 'wh-collide-y');
    await createGitHubConnection(env.db, {
      projectId: projectX.id,
      installationId: '900',
      repoFullName: 'octo/x',
      repositoryId: '872525',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await createGitHubConnection(env.db, {
      projectId: projectY.id,
      installationId: '901',
      repoFullName: 'octo/y',
      repositoryId: '894906',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '900');
    await seedInstallation(env.db, '901');

    const buildX = await createTestBuild(env.db, {
      projectId: projectX.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-x',
      branch: 'main',
      githubRunId: '500',
      githubRunAttempt: '1',
    });
    const buildY = await createTestBuild(env.db, {
      projectId: projectY.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-y',
      branch: 'main',
      githubRunId: '500',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 900 },
      repository: { full_name: 'octo/x', id: 872_525 },
      workflow_run: { id: 500, run_attempt: 1, conclusion: 'failure', head_sha: 'sha-x' },
    });

    expect(res.status).toBe(200);
    const updatedX = await getBuild(env.db, buildX.id);
    const updatedY = await getBuild(env.db, buildY.id);
    expect(updatedX!.status).toBe('failed');
    expect(updatedY!.status).toBe('building');
  });

  // Decision: One repo can back several github_actions projects (matrix or several --project jobs sharing one
  // run_id+attempt). GitHub fires workflow_run:completed once, so the handler finalizes each matching
  // build, not just the first connection's, or the others stay active until the 60m reaper.

  it('finalizes EVERY active build sharing a run_id across projects on one repo', async () => {
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id, 'wh-wfr-multi-a');
    const projectB = await createTestProject(env.db, user.id, 'wh-wfr-multi-b');
    await createGitHubConnection(env.db, {
      projectId: projectA.id,
      installationId: '960',
      repoFullName: 'octo/multi',
      repositoryId: '960960',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await createGitHubConnection(env.db, {
      projectId: projectB.id,
      installationId: '960',
      repoFullName: 'octo/multi',
      repositoryId: '960960',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '960', [{ full_name: 'octo/multi', id: 960_960 }]);

    const deploymentA = await createTestDeployment(env.db, projectA.id, 'live');
    const deploymentB = await createTestDeployment(env.db, projectB.id, 'live');
    await env.db
      .update(deployments)
      .set({ commit: 'sha-multi' })
      .where(eq(deployments.id, deploymentA.id));
    await env.db
      .update(deployments)
      .set({ commit: 'sha-multi' })
      .where(eq(deployments.id, deploymentB.id));

    const buildA = await createTestBuild(env.db, {
      projectId: projectA.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-multi',
      branch: 'main',
      githubRunId: '960',
      githubRunAttempt: '1',
    });
    const buildB = await createTestBuild(env.db, {
      projectId: projectB.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-multi',
      branch: 'main',
      githubRunId: '960',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 960 },
      repository: { full_name: 'octo/multi', id: 960_960 },
      workflow_run: { id: 960, run_attempt: 1, conclusion: 'success', head_sha: 'sha-multi' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; buildIds: ReadonlyArray<string> };
    expect(body.buildIds).toHaveLength(2);
    expect([...body.buildIds].sort()).toEqual([buildA.id, buildB.id].sort());

    const updatedA = await getBuild(env.db, buildA.id);
    const updatedB = await getBuild(env.db, buildB.id);
    expect(updatedA!.status).toBe('complete');
    expect(updatedB!.status).toBe('complete');
    expect(updatedA!.deployment_id).toBe(deploymentA.id);
    expect(updatedB!.deployment_id).toBe(deploymentB.id);
  });

  it('finalizes the active rerun build, not the prior terminal row, for a re-run', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-rerun');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '950',
      repoFullName: 'octo/rerun',
      repositoryId: '889911',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '950');

    const terminal = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'failed',
      commitSha: 'sha-old',
      branch: 'main',
      githubRunId: '800',
      githubRunAttempt: '1',
    });
    const rerun = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-new',
      branch: 'main',
      githubRunId: '800',
      githubRunAttempt: '2',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 950 },
      repository: { full_name: 'octo/rerun', id: 889_911 },
      workflow_run: { id: 800, run_attempt: 2, conclusion: 'success', head_sha: 'sha-new' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; buildIds: ReadonlyArray<string> };
    expect(body.buildIds).toEqual([rerun.id]);
    const updatedRerun = await getBuild(env.db, rerun.id);
    expect(updatedRerun!.status).toBe('complete');
    expect(updatedRerun!.completed_at).not.toBeNull();
    const updatedTerminal = await getBuild(env.db, terminal.id);
    expect(updatedTerminal!.status).toBe('failed');
  });

  it('a redelivered attempt-1 completion leaves attempt-2 ACTIVE and does not re-finalize attempt-1', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-rerun-redeliver');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '951',
      repoFullName: 'octo/redeliver',
      repositoryId: '874787',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '951');

    const attempt1 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'failed',
      commitSha: 'sha-a1',
      branch: 'main',
      githubRunId: '801',
      githubRunAttempt: '1',
    });
    const attempt2 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-a2',
      branch: 'main',
      githubRunId: '801',
      githubRunAttempt: '2',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 951 },
      repository: { full_name: 'octo/redeliver', id: 874_787 },
      workflow_run: { id: 801, run_attempt: 1, conclusion: 'success', head_sha: 'sha-a1' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'build already terminal',
    });

    const updated2 = await getBuild(env.db, attempt2.id);
    expect(updated2!.status).toBe('building');
    expect(updated2!.completed_at).toBeNull();
    const updated1 = await getBuild(env.db, attempt1.id);
    expect(updated1!.status).toBe('failed');
  });

  it('ignores a workflow_run for a repo with no connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-no-conn');
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-z',
      branch: 'main',
      githubRunId: '600',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 999 },
      repository: { full_name: 'octo/unknown', id: 881_839 },
      workflow_run: { id: 600, run_attempt: 1, conclusion: 'success', head_sha: 'sha-z' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'no matching connection',
    });
  });

  it('ignores a push whose full_name matches but repository.id differs (name reuse)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-id-mismatch');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '610',
      repoFullName: 'octo/repo',
      repositoryId: '100',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '610');

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      installation: { id: 610 },
      repository: { full_name: 'octo/repo', id: 999 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'no matching connection',
    });
    expect((await env.db.select().from(builds)).length).toBe(0);
  });

  it('creates a build for a renamed repo by its immutable id (same id, new full_name)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-renamed');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '611',
      repoFullName: 'octo/old-name',
      repositoryId: '100',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '611');

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'def5678',
      installation: { id: 611 },
      repository: { full_name: 'octo/new-name', id: 100 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);
    const build = await getBuild(env.db, json.buildIds[0]);
    expect(build!.project_id).toBe(project.id);
  });

  // Decision: A repository_id-matched push whose payload full_name differs from the stored name self-heals the
  // stored repo_full_name, so the container build fetches the source tarball from the renamed repo.

  it('self-heals the stored repo_full_name on a renamed-repo push', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-selfheal');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '620',
      repoFullName: 'octo/old',
      repositoryId: '555',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '620');

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      installation: { id: 620 },
      repository: { full_name: 'octo/new', id: 555 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);

    const healed = await getGitHubConnection(env.db, project.id);
    expect(healed!.repo_full_name).toBe('octo/new');
  });

  it('does not match a connection by name when the push carries a different repository id', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-null-id');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '650',
      repoFullName: 'octo/legacy',
      repositoryId: '722400',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '650');

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'leg0001',
      installation: { id: 650 },
      repository: { full_name: 'octo/legacy', id: 12_345 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'no matching connection',
    });
    expect((await env.db.select().from(builds)).length).toBe(0);
  });

  it('routes a push to the matching-branch project when two projects share a repo', async () => {
    const user = await createTestUser(env.db);
    const projectMain = await createTestProject(env.db, user.id, 'wh-multi-main');
    const projectDev = await createTestProject(env.db, user.id, 'wh-multi-dev');
    await createGitHubConnection(env.db, {
      projectId: projectMain.id,
      installationId: '630',
      repoFullName: 'octo/shared',
      repositoryId: '777',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: projectDev.id,
      installationId: '630',
      repoFullName: 'octo/shared',
      repositoryId: '777',
      branch: 'develop',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '630');

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/develop',
      after: 'dev0001',
      installation: { id: 630 },
      repository: { full_name: 'octo/shared', id: 777 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds?: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);

    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(1);
    expect(rows[0].project_id).toBe(projectDev.id);
  });

  it('fans out a push to every same-branch connection when two projects share a repo', async () => {
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id, 'wh-fanout-a');
    const projectB = await createTestProject(env.db, user.id, 'wh-fanout-b');
    await createGitHubConnection(env.db, {
      projectId: projectA.id,
      installationId: '640',
      repoFullName: 'octo/fan',
      repositoryId: '888',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: projectB.id,
      installationId: '640',
      repoFullName: 'octo/fan',
      repositoryId: '888',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '640');

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'fan0001',
      installation: { id: 640 },
      repository: { full_name: 'octo/fan', id: 888 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds?: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(2);

    const rows = await env.db.select().from(builds);
    const projectIds = rows.map((r) => r.project_id).sort();
    expect(projectIds).toEqual([projectA.id, projectB.id].sort());
  });

  it('does not finalize a workflow_run whose repository.id differs from the connected id', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-wfr-id-mismatch');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '612',
      repoFullName: 'octo/repo',
      repositoryId: '100',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '612');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-x',
      branch: 'main',
      githubRunId: '700',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 612 },
      repository: { full_name: 'octo/repo', id: 999 },
      workflow_run: { id: 700, run_attempt: 1, conclusion: 'success', head_sha: 'sha-x' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'no matching connection',
    });
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
  });

  // Decision: The push resolver is revocation-aware. A delayed or redelivered signed push that arrives after the
  // App is suspended or uninstalled (or the repo dropped from a `selected` install) resolves no
  // connection and builds nothing, even within the installation-token cache window.
  it('ignores a push for a SUSPENDED installation (no build)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-f23-1-susp');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '7301',
      repoFullName: 'octo/susp',
      repositoryId: '764776',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '7301');
    await markGitHubInstallationStatus(env.db, '7301', 'suspended');

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      installation: { id: 7301 },
      repository: { full_name: 'octo/susp', id: 764_776 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'no matching connection',
    });
    expect((await env.db.select().from(builds)).length).toBe(0);
  });

  it('ignores a push for a DELETED installation (no build)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-f23-1-del');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '7302',
      repoFullName: 'octo/del',
      repositoryId: '873576',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '7302');
    await markGitHubInstallationStatus(env.db, '7302', 'deleted');

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      installation: { id: 7302 },
      repository: { full_name: 'octo/del', id: 873_576 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'no matching connection',
    });
    expect((await env.db.select().from(builds)).length).toBe(0);
  });

  it('ignores a push for a repo NOT in a selected install (no build)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-f23-1-sel');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '7303',
      repoFullName: 'octo/dropped',
      repositoryId: '73',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '7303', [{ full_name: 'octo/other', id: 7399 }], 'selected');

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      installation: { id: 7303 },
      repository: { full_name: 'octo/dropped', id: 73 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'no matching connection',
    });
    expect((await env.db.select().from(builds)).length).toBe(0);
  });

  it('builds a push for an ACTIVE install whose repo IS a member (happy path)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-f23-1-ok');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '7304',
      repoFullName: 'octo/member',
      repositoryId: '74',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '7304', [{ full_name: 'octo/member', id: 74 }], 'selected');

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      installation: { id: 7304 },
      repository: { full_name: 'octo/member', id: 74 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);
    const build = await getBuild(env.db, json.buildIds[0]);
    expect(build!.status).toBe('queued');
    expect(build!.commit_sha).toBe('abc1234');
  });

  it('returns 2xx and ignores an unknown event', async () => {
    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'star', { action: 'created' });
    expect(res.status).toBe(200);
  });

  it('returns 2xx for a pull_request stub event', async () => {
    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'pull_request', { action: 'opened' });
    expect(res.status).toBe(200);
  });
});

// Decision: Pushes are idempotent and latest-wins:
// * a newer push supersedes older still-queued builds for the same project+branch, so the newest
//   commit deploys, not whichever finishes last;
// * a webhook redelivery for a commit already in flight doesn't double-build;
// * a running build for an older commit is superseded too: leaving it active would keep a live
//   deploy token (it could publish a stale commit) and pin a concurrency slot.

describe('POST /webhooks/github — push idempotency + latest-wins', () => {
  function pokeApp(): {
    app: Hono<ApiEnv>;
    appEnv: TestEnv;
    cancelledIds: ReadonlyArray<string>;
  } {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const { namespace, cancelledIds } = recordingBuildManager();
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_MANAGER: namespace,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);
    return { app, appEnv, cancelledIds };
  }

  async function pushCommit(
    app: Hono<ApiEnv>,
    appEnv: TestEnv,
    after: string,
  ): Promise<{ buildId: string }> {
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after,
      installation: { id: 700 },
      repository: { full_name: 'octo/idem', id: 70 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(body.buildIds).toHaveLength(1);
    return { buildId: body.buildIds[0] };
  }

  it('newer push supersedes the older queued build; redelivery dedups; running IS cancelled', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-idem');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '700',
      repoFullName: 'octo/idem',
      repositoryId: '70',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '700');

    const { app, appEnv, cancelledIds } = pokeApp();

    const first = await pushCommit(app, appEnv, 'aaa');
    expect(first.buildId).toBeTruthy();
    const buildAaa = await getBuild(env.db, first.buildId);
    expect(buildAaa!.status).toBe('queued');
    expect(buildAaa!.commit_sha).toBe('aaa');

    const second = await pushCommit(app, appEnv, 'bbb');
    expect(second.buildId).not.toBe(first.buildId);
    const supersededAaa = await getBuild(env.db, first.buildId);
    expect(supersededAaa!.status).toBe('cancelled');
    expect(supersededAaa!.error).toBe('superseded by newer push');
    const buildBbb = await getBuild(env.db, second.buildId);
    expect(buildBbb!.status).toBe('queued');
    expect(buildBbb!.commit_sha).toBe('bbb');

    const beforeCount = (await env.db.select().from(builds)).length;
    const redeliver = await pushCommit(app, appEnv, 'bbb');
    expect(redeliver.buildId).toBe(second.buildId);
    const afterCount = (await env.db.select().from(builds)).length;
    expect(afterCount).toBe(beforeCount);

    await env.db.update(builds).set({ status: 'building' }).where(eq(builds.id, second.buildId));
    const third = await pushCommit(app, appEnv, 'ccc');
    expect(third.buildId).not.toBe(second.buildId);
    const supersededBbb = await getBuild(env.db, second.buildId);
    expect(supersededBbb!.status).toBe('cancelled');
    expect(supersededBbb!.error).toBe('superseded by newer push');
    expect(cancelledIds).toContain(second.buildId);
    const buildCcc = await getBuild(env.db, third.buildId);
    expect(buildCcc!.status).toBe('queued');
    expect(buildCcc!.commit_sha).toBe('ccc');
  });

  it('keeps a valid ingress delivery idempotent through the existing push pipeline', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-ingress-idem');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '701',
      repoFullName: 'octo/ingress-idem',
      repositoryId: '71',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '701');
    const { app, appEnv } = pokeApp();
    const payload = {
      ref: 'refs/heads/main',
      after: 'ingress-sha',
      installation: { id: 701 },
      repository: { full_name: 'octo/ingress-idem', id: 71 },
    };

    const first = await postThroughIngressOperation(app, appEnv, 'push', payload);
    const second = await postThroughIngressOperation(app, appEnv, 'push', payload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json<{ buildIds: ReadonlyArray<string> }>();
    const secondBody = await second.json<{ buildIds: ReadonlyArray<string> }>();
    expect(firstBody.buildIds).toHaveLength(1);
    expect(secondBody.buildIds).toEqual(firstBody.buildIds);
    expect(
      (await env.db.select().from(builds)).filter((build) => build.project_id === project.id),
    ).toHaveLength(1);
  });

  it('redelivery after the commit already COMPLETED reuses the build (no re-enqueue)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-idem-complete');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '700',
      repoFullName: 'octo/idem',
      repositoryId: '70',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '700');

    const { app, appEnv } = pokeApp();

    const first = await pushCommit(app, appEnv, 'xxx');
    const depXxx = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(builds)
      .set({ status: 'complete', deployment_id: depXxx.id })
      .where(eq(builds.id, first.buildId));

    const beforeCount = (await env.db.select().from(builds)).length;
    const redeliver = await pushCommit(app, appEnv, 'xxx');
    expect(redeliver.buildId).toBe(first.buildId);
    const afterCount = (await env.db.select().from(builds)).length;
    expect(afterCount).toBe(beforeCount);
    const rows = await env.db.select().from(builds).where(eq(builds.project_id, project.id));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('complete');
  });

  it('re-pushing a commit after a FAILED build enqueues a new build (failed does not block)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-idem-failed');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '700',
      repoFullName: 'octo/idem',
      repositoryId: '70',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '700');

    const { app, appEnv } = pokeApp();

    const first = await pushCommit(app, appEnv, 'yyy');
    await env.db.update(builds).set({ status: 'failed' }).where(eq(builds.id, first.buildId));

    const second = await pushCommit(app, appEnv, 'yyy');
    expect(second.buildId).not.toBe(first.buildId);
    const retried = await getBuild(env.db, second.buildId);
    expect(retried!.status).toBe('queued');
    expect(retried!.commit_sha).toBe('yyy');
    expect((await getBuild(env.db, first.buildId))!.status).toBe('failed');
  });

  // Decision: A force-push rollback to a previously deployed (still `complete`) SHA that the project isn't live
  // on re-deploys it: a fresh queued build is enqueued (the old `complete` build isn't reused), so the
  // project returns to the rolled-back commit. A newer in-flight build for the now-off-branch commit
  // is still cancelled and its DO torn down, or it would keep a live deploy token and publish the
  // stale newer commit.
  it('rollback to a complete SHA that is not live RE-DEPLOYS it AND cancels a newer in-flight build', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-rollback');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '700',
      repoFullName: 'octo/idem',
      repositoryId: '70',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '700');

    const b1 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
      commitSha: 'C1',
      branch: 'main',
    });
    await createTestDeployment(env.db, project.id, 'live', undefined, undefined, { commit: 'C2' });
    const b2 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'C2',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = pokeApp();

    const rollback = await pushCommit(app, appEnv, 'C1');
    expect(rollback.buildId).not.toBe(b1.id);
    const fresh = await getBuild(env.db, rollback.buildId);
    expect(fresh!.status).toBe('queued');
    expect(fresh!.commit_sha).toBe('C1');
    expect((await getBuild(env.db, b1.id))!.status).toBe('complete');

    const cancelledB2 = await getBuild(env.db, b2.id);
    expect(cancelledB2!.status).toBe('cancelled');
    expect(cancelledB2!.error).toBe('superseded by newer push');
    expect(cancelledIds).toContain(b2.id);
  });

  it('redelivery of a complete SHA that is currently live reuses it (no re-enqueue)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-rollback-live');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '700',
      repoFullName: 'octo/idem',
      repositoryId: '70',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '700');

    const depA = await createTestDeployment(env.db, project.id, 'live', undefined, undefined, {
      commit: 'C1',
    });
    const b1 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
      commitSha: 'C1',
      branch: 'main',
    });
    await env.db.update(builds).set({ deployment_id: depA.id }).where(eq(builds.id, b1.id));

    const { app, appEnv } = pokeApp();

    const beforeCount = (await env.db.select().from(builds)).length;
    const redeliver = await pushCommit(app, appEnv, 'C1');
    expect(redeliver.buildId).toBe(b1.id);
    const afterCount = (await env.db.select().from(builds)).length;
    expect(afterCount).toBe(beforeCount);
  });

  it('push still returns a build id on the normal (non-skipped) path (caller)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-f23-2-caller');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '700',
      repoFullName: 'octo/idem',
      repositoryId: '70',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '700');

    const { app, appEnv } = pokeApp();
    const res = await pushCommit(app, appEnv, 'zzz');
    const build = await getBuild(env.db, res.buildId);
    expect(build!.status).toBe('queued');
    expect(build!.commit_sha).toBe('zzz');
  });
});

// Decision: The push handler pokes BUILD_SCHEDULER best effort after inserting the row, and the DO lets its
// alarm lapse on an empty queue. If that poke fails the row sits `queued` with no alarm to drain it,
// so the hourly cron tier re-arms the scheduler while a container build is still queued. The
// mockController has `cron === undefined` (not FAST_CRON), so scheduled() runs the hourly tier.
describe('scheduled() re-arms BUILD_SCHEDULER for orphaned queued builds', () => {
  const mockController = {} as ScheduledController;
  const mockCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  // Decision: CRON_FIRES_QUEUE isn't on TestEnv, so stub it inline (scheduled() doesn't exercise it here).
  function makeBindings(pokeFetch: ReturnType<typeof vi.fn>): ApiEnv['Bindings'] {
    return {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: pokeFetch }),
      } as unknown as DurableObjectNamespace,
      CRON_FIRES_QUEUE: {
        send: async () => {},
        sendBatch: async () => {},
      },
    } as unknown as ApiEnv['Bindings'];
  }

  it('pokes the scheduler when a container build is queued but the poke was missed', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-reaper');
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'queued',
      commitSha: 'sha-orphan',
      branch: 'main',
    });

    const pokeFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );

    await scheduled(mockController, makeBindings(pokeFetch), mockCtx);

    expect(pokeFetch).toHaveBeenCalledTimes(1);
    const [pokeUrl, pokeInit] = pokeFetch.mock.calls[0]! as [string, RequestInit];
    expect(pokeUrl).toContain('/poke');
    expect(pokeInit.method).toBe('POST');
  });

  it('does not poke the scheduler when no container build is queued', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-no-reaper');
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-running',
      branch: 'main',
    });
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'queued',
      commitSha: 'sha-actions',
      branch: 'main',
    });

    const pokeFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );

    await scheduled(mockController, makeBindings(pokeFetch), mockCtx);

    expect(pokeFetch).not.toHaveBeenCalled();
  });

  it('does not throw if the scheduler poke fails (isolated from the rest of the tick)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-reaper-fail');
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'queued',
      commitSha: 'sha-orphan2',
      branch: 'main',
    });

    const pokeFetch = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new Error('DO transport failure');
    });

    await expect(
      scheduled(mockController, makeBindings(pokeFetch), mockCtx),
    ).resolves.toBeUndefined();
    expect(pokeFetch).toHaveBeenCalledTimes(1);
  });
});

// Decision: The hourly tier reaps GitHub Actions builds stuck active far past any plan's build timeout. A
// missed workflow_run completion (or a disconnect mid-run) would otherwise pin a concurrency slot
// for good. Container builds have their own DO timeout and aren't reaped here.

describe('scheduled() reaps over-age active github_actions builds', () => {
  const mockController = {} as ScheduledController;
  const mockCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  function makeBindings(): ApiEnv['Bindings'] {
    return {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: async () => Response.json({ ok: true }) }),
      } as unknown as DurableObjectNamespace,
      CRON_FIRES_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    } as unknown as ApiEnv['Bindings'];
  }

  async function ageBuild(buildId: string, minutesAgo: number): Promise<void> {
    await env.db
      .update(builds)
      .set({ created_at: sql`now() - (${minutesAgo} * interval '1 minute')` })
      .where(eq(builds.id, buildId));
  }

  it('fails an over-age active github_actions build', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-stale-actions');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-stale',
      branch: 'main',
      githubRunId: '900',
    });
    await ageBuild(build.id, 90);

    await scheduled(mockController, makeBindings(), mockCtx);

    const updated = await getBuild(env.db, build.id);
    expect(updated!.status).toBe('failed');
    expect(updated!.completed_at).not.toBeNull();
  });

  it('does not reap a recent active github_actions build', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-fresh-actions');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-fresh',
      branch: 'main',
      githubRunId: '901',
    });
    await ageBuild(build.id, 5);

    await scheduled(mockController, makeBindings(), mockCtx);

    expect((await getBuild(env.db, build.id))!.status).toBe('building');
  });

  it('does not reap an over-age active container build (DO timeout owns those)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-stale-container');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-c',
      branch: 'main',
    });
    await ageBuild(build.id, 120);

    await scheduled(mockController, makeBindings(), mockCtx);

    expect((await getBuild(env.db, build.id))!.status).toBe('building');
  });
});

// Decision: App removal or suspension and repo removal revoke in-flight builds. Terminalizing a build row (to
// cancelled) revokes its deploy token (the middleware guard rejects a token whose bound build isn't
// active), and active container builds also get a best-effort `cancelBuild` DO RPC.

describe('POST /webhooks/github — revoke builds on App removal', () => {
  function recordingApp(): {
    app: Hono<ApiEnv>;
    appEnv: TestEnv;
    cancelledIds: ReadonlyArray<string>;
  } {
    const { namespace, cancelledIds } = recordingBuildManager();
    const overrideEnv: TestEnv = { ...env, BUILD_MANAGER: namespace };
    const { app, appEnv } = makeApp(overrideEnv);
    return { app, appEnv, cancelledIds };
  }

  it('cancels in-flight builds and stops the container DO on installation:deleted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-1-del');
    await seedInstallation(env.db, '8001');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8001',
      repoFullName: 'octo/del',
      repositoryId: '873576',
      branch: 'main',
      buildExecutor: 'container',
    });
    const container = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-del',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation', {
      action: 'deleted',
      installation: { id: 8001 },
    });

    expect(res.status).toBe(200);
    const updated = await getBuild(env.db, container.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.error).toBe('github app uninstalled');
    expect(cancelledIds).toContain(container.id);
    expect((await getGitHubInstallation(env.db, '8001'))!.status).toBe('deleted');
  });

  it('cancels in-flight builds on installation:suspend (both executors)', async () => {
    const user = await createTestUser(env.db);
    const containerProject = await createTestProject(env.db, user.id, 'f18-1-susp-c');
    const actionsProject = await createTestProject(env.db, user.id, 'f18-1-susp-a');
    await seedInstallation(env.db, '8002');
    await createGitHubConnection(env.db, {
      projectId: containerProject.id,
      installationId: '8002',
      repoFullName: 'octo/susp-c',
      repositoryId: '8201',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: actionsProject.id,
      installationId: '8002',
      repoFullName: 'octo/susp-a',
      repositoryId: '8202',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const container = await createTestBuild(env.db, {
      projectId: containerProject.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-susp-c',
      branch: 'main',
    });
    const actions = await createTestBuild(env.db, {
      projectId: actionsProject.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-susp-a',
      branch: 'main',
      githubRunId: '82000',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation', {
      action: 'suspend',
      installation: { id: 8002 },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, container.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, container.id))!.error).toBe('github app suspended');
    expect((await getBuild(env.db, actions.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, actions.id))!.error).toBe('github app suspended');
    expect(cancelledIds).toEqual([container.id]);
    expect((await getGitHubInstallation(env.db, '8002'))!.status).toBe('suspended');
  });

  it('cancels only the removed repo build on installation_repositories:removed', async () => {
    const user = await createTestUser(env.db);
    const removedProject = await createTestProject(env.db, user.id, 'f18-1-rm-removed');
    const keptProject = await createTestProject(env.db, user.id, 'f18-1-rm-kept');
    await seedInstallation(env.db, '8003');
    await createGitHubConnection(env.db, {
      projectId: removedProject.id,
      installationId: '8003',
      repoFullName: 'octo/removed',
      repositoryId: '8301',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: keptProject.id,
      installationId: '8003',
      repoFullName: 'octo/kept',
      repositoryId: '8302',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const removedBuild = await createTestBuild(env.db, {
      projectId: removedProject.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-rm',
      branch: 'main',
    });
    const keptBuild = await createTestBuild(env.db, {
      projectId: keptProject.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-keep',
      branch: 'main',
      githubRunId: '83000',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'removed',
      installation: { id: 8003 },
      repositories_added: [],
      repositories_removed: [{ full_name: 'octo/removed', id: 8301 }],
      repository_selection: 'selected',
    });

    expect(res.status).toBe(200);
    const updatedRemoved = await getBuild(env.db, removedBuild.id);
    expect(updatedRemoved!.status).toBe('cancelled');
    expect(updatedRemoved!.error).toBe('repository removed from github app');
    expect(cancelledIds).toContain(removedBuild.id);
    expect((await getBuild(env.db, keptBuild.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(keptBuild.id);
  });

  it('does NOT downgrade an all install or revoke builds on a stale selected removal that missed a concurrent widen', async () => {
    // Decision: A stale `installation_repositories:removed` delivery that says `selected` arrives after the install
    // was widened to `all`. Its pre-tx snapshot still read `selected`, so the `all` -> `selected` refetch
    // gate didn't fire. The handler decides the persisted selection from the row re-read under the lock
    // (keeping `all`) and doesn't revoke the build for the "removed" repo, which `all` still covers.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f-stale-narrow');
    await seedInstallation(env.db, '8009', [], 'all');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8009',
      repoFullName: 'octo/keep',
      repositoryId: '8901',
      branch: 'main',
      buildExecutor: 'container',
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-stale-narrow',
      branch: 'main',
    });

    // Decision: Force the handler's pre-tx snapshot to read `selected` while the committed row stays `all`,
    // reproducing the missed concurrent widen. The under-lock re-read still hits the real `all` row.
    // One-shot: the later assertions read the real row.
    const realRow = await getGitHubInstallation(env.db, '8009');
    const spy = vi
      .spyOn(db, 'getGitHubInstallation')
      .mockResolvedValueOnce({ ...realRow!, repository_selection: 'selected' });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'removed',
      installation: { id: 8009 },
      repositories_added: [],
      repositories_removed: [{ full_name: 'octo/keep', id: 8901 }],
      repository_selection: 'selected',
    });
    spy.mockRestore();

    expect(res.status).toBe(200);
    expect((await getGitHubInstallation(env.db, '8009'))!.repository_selection).toBe('all');
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(build.id);
  });

  it('does NOT cancel builds on installation:unsuspend', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-1-unsusp');
    await seedInstallation(env.db, '8004');
    await env.db
      .update(githubInstallations)
      .set({ status: 'suspended' })
      .where(eq(githubInstallations.installation_id, '8004'));
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8004',
      repoFullName: 'octo/unsusp',
      repositoryId: '763767',
      branch: 'main',
      buildExecutor: 'container',
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-unsusp',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation', {
      action: 'unsuspend',
      installation: { id: 8004 },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).toEqual([]);
    expect((await getGitHubInstallation(env.db, '8004'))!.status).toBe('active');
  });

  it('does NOT cancel builds on installation_repositories:added (no removals)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-1-added');
    await seedInstallation(env.db, '8005');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8005',
      repoFullName: 'octo/added',
      repositoryId: '8501',
      branch: 'main',
      buildExecutor: 'container',
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-added',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'added',
      installation: { id: 8005 },
      repositories_added: [{ full_name: 'octo/another', id: 8502 }],
      repositories_removed: [],
      repository_selection: 'selected',
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).toEqual([]);
  });
});

// Decision: A push supersedes stale active github_actions builds for the same branch whose commit isn't the
// new head, so an older in-flight Actions build can't keep a live deploy token after a newer push.
// Same-commit builds (already exchanged OIDC for the new head) and cross-branch builds are spared.

describe('POST /webhooks/github — supersede stale actions builds on push', () => {
  it('supersedes an active actions build for an older commit on the pushed branch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-2-supersede');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8101',
      repoFullName: 'octo/sup',
      repositoryId: '8601',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '8101');
    const stale = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'c1',
      branch: 'main',
      githubRunId: '86001',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'c2',
      installation: { id: 8101 },
      repository: { full_name: 'octo/sup', id: 8601 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { executor?: string }).toMatchObject({
      executor: 'github_actions',
    });
    const updated = await getBuild(env.db, stale.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.error).toBe('superseded by newer push');
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(1);
  });

  it('spares an active actions build whose commit IS the new head', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-2-same-commit');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8102',
      repoFullName: 'octo/same',
      repositoryId: '8602',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '8102');
    const fresh = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'c2',
      branch: 'main',
      githubRunId: '86002',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'c2',
      installation: { id: 8102 },
      repository: { full_name: 'octo/same', id: 8602 },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, fresh.id))!.status).toBe('building');
  });

  it('spares an active actions build on a different branch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-2-cross-branch');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8103',
      repoFullName: 'octo/cross',
      repositoryId: '8603',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '8103');
    const devBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'devsha',
      branch: 'dev',
      githubRunId: '86003',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'mainsha',
      installation: { id: 8103 },
      repository: { full_name: 'octo/cross', id: 8603 },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, devBuild.id))!.status).toBe('building');
  });
});

describe('POST /webhooks/github — supersede stale container builds on push', () => {
  function recordingPokeApp(): {
    app: Hono<ApiEnv>;
    appEnv: TestEnv;
    cancelledIds: ReadonlyArray<string>;
  } {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const { namespace, cancelledIds } = recordingBuildManager();
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_MANAGER: namespace,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);
    return { app, appEnv, cancelledIds };
  }

  it('supersedes an active container build for an older commit + tears down its DO', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f19-1-supersede');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9101',
      repoFullName: 'octo/csup',
      repositoryId: '9601',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '9101');
    const stale = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'c1',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingPokeApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'c2',
      installation: { id: 9101 },
      repository: { full_name: 'octo/csup', id: 9601 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; buildIds: ReadonlyArray<string> };
    expect(json.ok).toBe(true);
    expect(json.buildIds).toHaveLength(1);
    const updated = await getBuild(env.db, stale.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.error).toBe('superseded by newer push');
    expect(cancelledIds).toContain(stale.id);
    const fresh = await getBuild(env.db, json.buildIds[0]);
    expect(fresh!.status).toBe('queued');
    expect(fresh!.commit_sha).toBe('c2');
  });

  it('spares an active container build whose commit IS the new head (exceptCommitSha)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f19-1-same-commit');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9102',
      repoFullName: 'octo/csame',
      repositoryId: '9602',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '9102');
    const fresh = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'c2',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingPokeApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'c2',
      installation: { id: 9102 },
      repository: { full_name: 'octo/csame', id: 9602 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toEqual([fresh.id]);
    expect((await getBuild(env.db, fresh.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(fresh.id);
  });

  it('spares an active container build on a different branch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f19-1-cross-branch');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9103',
      repoFullName: 'octo/ccross',
      repositoryId: '9603',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '9103');
    const devBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'devsha',
      branch: 'dev',
    });

    const { app, appEnv, cancelledIds } = recordingPokeApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'mainsha',
      installation: { id: 9103 },
      repository: { full_name: 'octo/ccross', id: 9603 },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, devBuild.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(devBuild.id);
  });

  it('same-commit redelivery of a building build reuses it (no cancel, no DO teardown)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f19-1-redeliver');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9104',
      repoFullName: 'octo/credeliver',
      repositoryId: '9604',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '9104');
    const building = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'c5',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingPokeApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'c5',
      installation: { id: 9104 },
      repository: { full_name: 'octo/credeliver', id: 9604 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toEqual([building.id]);
    expect((await getBuild(env.db, building.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(building.id);
    const rows = await env.db.select().from(builds).where(eq(builds.project_id, project.id));
    expect(rows.length).toBe(1);
  });
});

// Decision: The supersede/create tx re-checks installation status under the connection lock. A revocation can
// commit after the push resolver (which saw an active install) and before the build tx; the compare
// mock suspends the install in that window, so only the in-tx re-check catches it.

describe('POST /webhooks/github — in-tx install re-check', () => {
  it('does not enqueue a container build when the install is revoked between the resolver and the build tx', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f25-1-late-revoke');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9201',
      repoFullName: 'octo/late',
      repositoryId: '9701',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '9201');

    setCompareSideEffect(async () => {
      await markGitHubInstallationStatus(env.db, '9201', 'suspended');
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'c9',
      installation: { id: 9201 },
      repository: { full_name: 'octo/late', id: 9701 },
    });

    expect(res.status).toBe(200);
    expect(await getProjectBuilds(env.db, project.id)).toHaveLength(0);
  });
});

// Decision: The supersede/create tx asserts the locked connection is the same row the push resolver matched.
// `project_id` is UNIQUE, so a disconnect+reconnect (same branch, executor, installation_id and
// repository_id) deletes the old row and creates one with a fresh id between the resolver and the
// build tx. The install re-check keys on the passed installationId, so a same-install swap passes
// it; the id match is the only guard that catches it.

describe('POST /webhooks/github — in-tx connection id assertion', () => {
  it('does not enqueue a container build when the connection is replaced between the resolver and the build tx', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f26-2-replaced');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9201',
      repoFullName: 'octo/swap',
      repositoryId: '9702',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '9201');

    setCompareSideEffect(async () => {
      await deleteGitHubConnection(env.db, project.id);
      await createGitHubConnection(env.db, {
        projectId: project.id,
        installationId: '9201',
        repoFullName: 'octo/swap',
        repositoryId: '9702',
        branch: 'main',
        buildExecutor: 'container',
      });
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'c26',
      installation: { id: 9201 },
      repository: { full_name: 'octo/swap', id: 9702 },
    });

    expect(res.status).toBe(200);
    expect(await getProjectBuilds(env.db, project.id)).toHaveLength(0);
  });
});

// Decision: Repo removal matches the immutable repository_id, not the mutable repo_full_name. A
// rename-then-remove leaves the connection holding the old name while the payload carries the
// current name and id, so a name-only match would miss it and leave the in-flight build active.
// Legacy rows with a null repository_id still fall back to the name match.

describe('POST /webhooks/github — repo removal matches immutable repository_id', () => {
  function recordingApp(): {
    app: Hono<ApiEnv>;
    appEnv: TestEnv;
    cancelledIds: ReadonlyArray<string>;
  } {
    const { namespace, cancelledIds } = recordingBuildManager();
    const overrideEnv: TestEnv = { ...env, BUILD_MANAGER: namespace };
    const { app, appEnv } = makeApp(overrideEnv);
    return { app, appEnv, cancelledIds };
  }

  it('cancels a build for a renamed-then-removed repo via its immutable id', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f19-2-renamed');
    await seedInstallation(env.db, '9201');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9201',
      repoFullName: 'octo/old',
      repositoryId: '8401',
      branch: 'main',
      buildExecutor: 'container',
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-renamed',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'removed',
      installation: { id: 9201 },
      repositories_added: [],
      repositories_removed: [{ full_name: 'octo/new', id: 8401 }],
      repository_selection: 'selected',
    });

    expect(res.status).toBe(200);
    const updated = await getBuild(env.db, build.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.error).toBe('repository removed from github app');
    expect(cancelledIds).toContain(build.id);
  });

  it('spares a connection whose repository_id is NOT in the removed set', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f19-2-kept');
    await seedInstallation(env.db, '9203');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9203',
      repoFullName: 'octo/kept',
      repositoryId: '8403',
      branch: 'main',
      buildExecutor: 'container',
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-kept',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'removed',
      installation: { id: 9203 },
      repositories_added: [],
      repositories_removed: [{ full_name: 'octo/other', id: 8499 }],
      repository_selection: 'selected',
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(build.id);
  });
});

// Decision: Workflow_run completion uses a CAS (`markBuildTerminalIfActive`) so a concurrent terminalizer that
// flipped the row to cancelled between the active guard and the write isn't clobbered. A build
// already terminal at write time is ignored, and no deployment is linked to it.

describe('POST /webhooks/github — CAS workflow_run completion', () => {
  it('ignores a workflow_run for a build already cancelled (CAS no-op)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-3-cancelled');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8201',
      repoFullName: 'octo/cas',
      repositoryId: '791148',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '8201');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ commit: 'sha-cas' })
      .where(eq(deployments.id, deployment.id));
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'cancelled',
      commitSha: 'sha-cas',
      branch: 'main',
      githubRunId: '87001',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 8201 },
      repository: { full_name: 'octo/cas', id: 791_148 },
      workflow_run: { id: 87_001, run_attempt: 1, conclusion: 'success', head_sha: 'sha-cas' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'build already terminal' });
    const updated = await getBuild(env.db, build.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.deployment_id).toBeNull();
  });
});

// Decision: A branch-delete push (all-zero `after`) has nothing to build, but an in-flight build for the
// deleted branch still holds a live deploy token (the guard revokes a token only once its bound
// build isn't active), so it could keep publishing the deleted branch's SHA until its TTL or the
// reaper. The push handler terminalizes those builds (scoped to the deleted branch and this repo)
// and tears down their container DOs, like the App-removal and repo-removal paths.

describe('POST /webhooks/github — revoke builds on branch delete', () => {
  function recordingApp(): {
    app: Hono<ApiEnv>;
    appEnv: TestEnv;
    cancelledIds: ReadonlyArray<string>;
  } {
    const { namespace, cancelledIds } = recordingBuildManager();
    const overrideEnv: TestEnv = { ...env, BUILD_MANAGER: namespace };
    const { app, appEnv } = makeApp(overrideEnv);
    return { app, appEnv, cancelledIds };
  }

  it('cancels an in-flight container build for the deleted branch + tears down its DO', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-4-del');
    await seedInstallation(env.db, '8601', [{ full_name: 'octo/del-branch', id: 8611 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8601',
      repoFullName: 'octo/del-branch',
      repositoryId: '8611',
      branch: 'main',
      buildExecutor: 'container',
    });
    const inflight = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-del-branch',
      branch: 'main',
    });
    // Decision: No created_at backdating needed: the handler reads its fence from the DB clock (`select now()`),
    // the same clock that stamped this build, and captures it after createTestBuild ran, so
    // created_at <= fence holds.

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 8601 },
      repository: { full_name: 'octo/del-branch', id: 8611 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'branch delete' });
    const updated = await getBuild(env.db, inflight.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.error).toBe('branch deleted');
    expect(cancelledIds).toContain(inflight.id);
  });

  it('leaves an in-flight build for a DIFFERENT branch on the same repo untouched', async () => {
    const user = await createTestUser(env.db);
    const mainProject = await createTestProject(env.db, user.id, 'f18-4-other-main');
    const devProject = await createTestProject(env.db, user.id, 'f18-4-other-dev');
    await seedInstallation(env.db, '8602', [{ full_name: 'octo/other-branch', id: 8612 }]);
    await createGitHubConnection(env.db, {
      projectId: mainProject.id,
      installationId: '8602',
      repoFullName: 'octo/other-branch',
      repositoryId: '8612',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: devProject.id,
      installationId: '8602',
      repoFullName: 'octo/other-branch',
      repositoryId: '8612',
      branch: 'dev',
      buildExecutor: 'container',
    });
    const devBuild = await createTestBuild(env.db, {
      projectId: devProject.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-dev',
      branch: 'dev',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 8602 },
      repository: { full_name: 'octo/other-branch', id: 8612 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'branch delete' });
    expect((await getBuild(env.db, devBuild.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(devBuild.id);
  });

  it('no-ops when no connection matches the deleted branch (still ignored)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-4-nomatch');
    await seedInstallation(env.db, '8603', [{ full_name: 'octo/nomatch', id: 8613 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8603',
      repoFullName: 'octo/nomatch',
      repositoryId: '8613',
      branch: 'main',
      buildExecutor: 'container',
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-keep',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/feature',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 8603 },
      repository: { full_name: 'octo/nomatch', id: 8613 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'branch delete' });
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).toEqual([]);
  });

  it('leaves a terminal build for the deleted branch untouched (status guard)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-4-terminal');
    await seedInstallation(env.db, '8604', [{ full_name: 'octo/terminal', id: 8614 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8604',
      repoFullName: 'octo/terminal',
      repositoryId: '8614',
      branch: 'main',
      buildExecutor: 'container',
    });
    const done = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
      commitSha: 'sha-done',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 8604 },
      repository: { full_name: 'octo/terminal', id: 8614 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'branch delete' });
    expect((await getBuild(env.db, done.id))!.status).toBe('complete');
    expect(cancelledIds).not.toContain(done.id);
  });

  // Decision: GitHub doesn't guarantee webhook ordering. If the branch was deleted, recreated, and a new valid
  // build enqueued, a late delete event mustn't cancel that build. The handler re-verifies git state
  // (`getBranchExistence`) and skips cancellation unless the branch is confirmed absent.
  it('does NOT cancel a build when the branch currently exists (recreated; stale delete)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-4-recreated');
    await seedInstallation(env.db, '8605', [{ full_name: 'octo/recreated', id: 8615 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8605',
      repoFullName: 'octo/recreated',
      repositoryId: '8615',
      branch: 'main',
      buildExecutor: 'container',
    });
    const inflight = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-recreated',
      branch: 'main',
    });

    setBranchExistence('present');

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 8605 },
      repository: { full_name: 'octo/recreated', id: 8615 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'branch delete' });
    expect((await getBuild(env.db, inflight.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(inflight.id);
  });

  // Decision: Fail closed: when git state can't be confirmed ('unknown': transient failure or no access), the
  // handler doesn't cancel. The in-flight build's exposure is already bounded by the deploy-token TTL
  // and the hourly reaper, so leaving it is safer than clobbering a valid build off an unverifiable
  // event.
  it('does NOT cancel a build when branch existence is unknown (fail closed)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-4-unknown');
    await seedInstallation(env.db, '8606', [{ full_name: 'octo/unknown-del', id: 8616 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8606',
      repoFullName: 'octo/unknown-del',
      repositoryId: '8616',
      branch: 'main',
      buildExecutor: 'container',
    });
    const inflight = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-unknown',
      branch: 'main',
    });

    setBranchExistence('unknown');

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 8606 },
      repository: { full_name: 'octo/unknown-del', id: 8616 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'branch delete' });
    expect((await getBuild(env.db, inflight.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(inflight.id);
  });

  // Decision: TOCTOU fence: the absence check is point-in-time, so a build enqueued between 'absent' being
  // confirmed and the cancellation UPDATE (a branch recreated and pushed in that gap) mustn't be
  // cancelled. The handler captures a DB-clock fence (`select now()`) before the check and only
  // terminalizes builds created at or before it. Both created_at and the fence come from the one
  // Postgres clock, so there's no cross-clock skew.
  it('does NOT cancel a build created after the absence-check fence (recreate race)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-4-fence');
    await seedInstallation(env.db, '8608', [{ full_name: 'octo/fence-del', id: 8618 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8608',
      repoFullName: 'octo/fence-del',
      repositoryId: '8618',
      branch: 'main',
      buildExecutor: 'container',
    });
    // Decision: Seed created_at on the DB clock via `now()`, not a JS `...Z` string: the column is
    // `timestamp without time zone`, so a UTC string written directly loses its offset and lands at the
    // wrong instant under the harness's non-UTC session timezone. This mirrors how `defaultNow` writes.
    const orphan = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-orphan',
      branch: 'main',
    });
    await env.db
      .update(builds)
      .set({ created_at: sql`now() - interval '1 hour'` })
      .where(eq(builds.id, orphan.id));
    const recreated = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-recreated-race',
      branch: 'main',
    });
    await env.db
      .update(builds)
      .set({ created_at: sql`now() + interval '1 hour'` })
      .where(eq(builds.id, recreated.id));

    setBranchExistence('absent');

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 8608 },
      repository: { full_name: 'octo/fence-del', id: 8618 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'branch delete' });
    expect((await getBuild(env.db, orphan.id))!.status).toBe('cancelled');
    expect(cancelledIds).toContain(orphan.id);
    expect((await getBuild(env.db, recreated.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(recreated.id);
  });
});

describe('POST /webhooks/github — organization member_removed revocation', () => {
  function recordingApp(): {
    app: Hono<ApiEnv>;
    appEnv: TestEnv;
    cancelledIds: ReadonlyArray<string>;
  } {
    const { namespace, cancelledIds } = recordingBuildManager();
    const overrideEnv: TestEnv = { ...env, BUILD_MANAGER: namespace };
    const { app, appEnv } = makeApp(overrideEnv);
    return { app, appEnv, cancelledIds };
  }

  async function seedOrgInstall(installationId: string, orgId: string): Promise<void> {
    await upsertGitHubInstallation(env.db, {
      installationId,
      userId: null,
      accountLogin: `org-${orgId}`,
      accountId: orgId,
      accountType: 'Organization',
      repositories: [],
      repositorySelection: 'all',
    });
  }

  const ORG = '9100';
  const ORG2 = '9200';
  const G = '7777';

  it('severs the removed member: deletes the connection they authorized, membership, and terminates the in-flight build', async () => {
    const user = await createTestUser(env.db, 'org-removed', 'github', G);
    await seedOrgInstall('8100', ORG);
    const project = await createTestProject(env.db, user.id, 'org-sever');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8100',
      repoFullName: 'org/repo',
      repositoryId: '81001',
      branch: 'main',
      buildExecutor: 'container',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8100',
      userId: user.id,
      githubAccountId: G,
      ttlSeconds: 3600,
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-org',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
    const members = await getTestGitHubInstallationMembers(env.db, '8100');
    expect(members.some((m) => m.user_id === user.id)).toBe(false);
    const updated = await getBuild(env.db, build.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.error).toBe('org membership removed');
    expect(cancelledIds).toContain(build.id);
  });

  it('severs a shared-project connection authorized by the removed project admin', async () => {
    const owner = await createTestUser(env.db, 'org-shared-owner');
    const admin = await createTestUser(env.db, 'org-shared-admin', 'github', G);
    await seedOrgInstall('8101', ORG);
    const project = await createTestProject(env.db, owner.id, 'org-shared-sever');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: admin.id,
      role: 'admin',
      added_by_user_id: owner.id,
    });
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8101',
      repoFullName: 'org/shared-repo',
      repositoryId: '81011',
      branch: 'main',
      buildExecutor: 'container',
      authorizedByUserId: admin.id,
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8101',
      userId: admin.id,
      githubAccountId: G,
      ttlSeconds: 3600,
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: owner.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-org-shared',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    });

    expect(res.status).toBe(200);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
    expect((await getBuild(env.db, build.id))?.status).toBe('cancelled');
    expect(cancelledIds).toContain(build.id);
  });

  // Decision: A member_removed(X) whose affected-user set is empty (X has no oauth link and no membership
  // proof-id row) still writes a tombstone for (each org install, X). This is the pre-mint hole: a
  // soon-to-be-removed member pre-mints a join_code + connect_grant carrying X while still in the org,
  // without a Platform user, membership or oauth link. There's nobody to sever, but without the
  // tombstone the post-removal replay of those artifacts creates an auto-deploying connection.
  it('EXACT HOLE: writes a tombstone for (each org install, X) even when NO Platform user is affected', async () => {
    const X = '99999';
    const owner = await createTestUser(env.db, 'org-hole-owner', 'github', G);
    await seedOrgInstall('8110', ORG);
    await seedOrgInstall('8111', ORG);
    await seedOrgInstall('8112', ORG2);
    const project = await createTestProject(env.db, owner.id, 'org-hole-survives');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8110',
      repoFullName: 'org/survives',
      repositoryId: '81101',
      branch: 'main',
      buildExecutor: 'container',
    });

    expect(await getInstallationRevocationAt(env.db, '8110', X)).toBeNull();

    const { app, appEnv } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(X) } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await getInstallationRevocationAt(env.db, '8110', X)).not.toBeNull();
    expect(await getInstallationRevocationAt(env.db, '8111', X)).not.toBeNull();
    expect(await getInstallationRevocationAt(env.db, '8112', X)).toBeNull();
    expect(await getGitHubConnection(env.db, project.id)).not.toBeNull();
  });

  // Decision: A browser-proof-X membership doesn't back a connection, so X's removal doesn't sever a connection
  // reached only via that membership; it only voids the listing membership. Such a connection is
  // unreachable anyway: the connect gate can't mint a connection for a user whose own linked GitHub id
  // isn't the grant id.
  it('does NOT sever a connection for a member pulled in ONLY by a browser-proof-X membership; voids only the X membership + writes the tombstone', async () => {
    const X = '6551234';
    const v = await createTestUser(env.db, 'org-f1-v', 'google', 'google-f1-v');
    await seedOrgInstall('8190', ORG);
    const project = await createTestProject(env.db, v.id, 'org-f1-proj');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8190',
      repoFullName: 'org/f1',
      repositoryId: '81901',
      branch: 'main',
      buildExecutor: 'container',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8190',
      userId: v.id,
      githubAccountId: X,
      ttlSeconds: 3600,
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: v.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-f1',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(X) } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(
      (await getTestGitHubInstallationMembers(env.db, '8190')).some((m) => m.user_id === v.id),
    ).toBe(false);
    expect(await getInstallationRevocationAt(env.db, '8190', X)).not.toBeNull();
    expect(await getGitHubConnection(env.db, project.id)).not.toBeNull();
    const updated = await getBuild(env.db, build.id);
    expect(updated!.status).toBe('building');
    expect(cancelledIds).not.toContain(build.id);
  });

  it('severs the oauth-X user AND voids a distinct browser-proof-X membership, but spares that member’s oauth-backed connection', async () => {
    const X = '7551234';
    const u = await createTestUser(env.db, 'org-union-u', 'github', X);
    const v = await createTestUser(env.db, 'org-union-v', 'google', 'google-union-v');
    await seedOrgInstall('8200', ORG);
    const uProj = await createTestProject(env.db, u.id, 'org-union-u-proj');
    const vProj = await createTestProject(env.db, v.id, 'org-union-v-proj');
    await createGitHubConnection(env.db, {
      projectId: uProj.id,
      installationId: '8200',
      repoFullName: 'org/u',
      repositoryId: '82001',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: vProj.id,
      installationId: '8200',
      repoFullName: 'org/v',
      repositoryId: '82002',
      branch: 'main',
      buildExecutor: 'container',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8200',
      userId: u.id,
      githubAccountId: X,
      ttlSeconds: 3600,
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8200',
      userId: v.id,
      githubAccountId: X,
      ttlSeconds: 3600,
    });

    const { app, appEnv } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(X) } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await getGitHubConnection(env.db, uProj.id)).toBeNull();
    expect(await getGitHubConnection(env.db, vProj.id)).not.toBeNull();
    const members = await getTestGitHubInstallationMembers(env.db, '8200');
    expect(members.some((m) => m.user_id === u.id)).toBe(false);
    expect(members.some((m) => m.user_id === v.id)).toBe(false);
    expect(await getInstallationRevocationAt(env.db, '8200', X)).not.toBeNull();
  });

  it('spares a Z-backed connection when the SAME user’s X-keyed membership is voided (browser-proof ≠ oauth id)', async () => {
    const X = '3330001';
    const Z = '3330002';
    const v = await createTestUser(env.db, 'org-r8-v', 'github', Z);
    // Decision: Both installs resolve into orgInstallIds because getGitHubInstallationsByAccount has no status
    // filter.
    await seedOrgInstall('8210', ORG);
    await seedOrgInstall(
      '8211',
      ORG,
    ); /* Decision: Mark I1 deleted to mirror uninstall-then-reinstall history. installation.deleted doesn't remove
       membership rows, so V's stale X-membership persists on I1. */
    await markGitHubInstallationStatus(env.db, '8210', 'deleted');
    const vProj = await createTestProject(env.db, v.id, 'org-r8-v-proj');
    await createGitHubConnection(env.db, {
      projectId: vProj.id,
      installationId: '8211',
      repoFullName: 'org/v-legit',
      repositoryId: '82111',
      branch: 'main',
      buildExecutor: 'container',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8210',
      userId: v.id,
      githubAccountId: X,
      ttlSeconds: 3600,
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8211',
      userId: v.id,
      githubAccountId: Z,
      ttlSeconds: 3600,
    });
    const build = await createTestBuild(env.db, {
      projectId: vProj.id,
      userId: v.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-r8',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(X) } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await getGitHubConnection(env.db, vProj.id)).not.toBeNull();
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(build.id);
    expect(
      (await getTestGitHubInstallationMembers(env.db, '8210')).some((m) => m.user_id === v.id),
    ).toBe(false);
    expect(
      (await getTestGitHubInstallationMembers(env.db, '8211')).some(
        (m) => m.user_id === v.id && m.github_account_id === Z,
      ),
    ).toBe(true);
    expect(await getInstallationRevocationAt(env.db, '8210', X)).not.toBeNull();
    expect(await getInstallationRevocationAt(env.db, '8211', X)).not.toBeNull();
  });

  it('ignores member_removed when the org has no installs', async () => {
    const user = await createTestUser(env.db, 'org-noinstall', 'github', G);
    await seedOrgInstall('8120', ORG);
    const project = await createTestProject(env.db, user.id, 'org-other');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8120',
      repoFullName: 'org/other',
      repositoryId: '81201',
      branch: 'main',
      buildExecutor: 'container',
    });

    const { app, appEnv } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG2) },
      membership: { user: { id: Number(G) } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'organization: no org installs' });
    expect(await getGitHubConnection(env.db, project.id)).not.toBeNull();
  });

  it('ignores a non-removal action (member_added) — connection + membership survive', async () => {
    const user = await createTestUser(env.db, 'org-added', 'github', G);
    await seedOrgInstall('8130', ORG);
    const project = await createTestProject(env.db, user.id, 'org-added-proj');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8130',
      repoFullName: 'org/added',
      repositoryId: '81301',
      branch: 'main',
      buildExecutor: 'container',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8130',
      userId: user.id,
      githubAccountId: G,
      ttlSeconds: 3600,
    });

    const { app, appEnv } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_added',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'organization:member_added' });
    expect(await getGitHubConnection(env.db, project.id)).not.toBeNull();
    const members = await getTestGitHubInstallationMembers(env.db, '8130');
    expect(members.some((m) => m.user_id === user.id)).toBe(true);
  });

  it('SCOPE: does not sever the removed user’s connection under a DIFFERENT org', async () => {
    const user = await createTestUser(env.db, 'org-scope-org', 'github', G);
    await seedOrgInstall('8140', ORG);
    await seedOrgInstall('8141', ORG2);
    const inOrg = await createTestProject(env.db, user.id, 'org-scope-in');
    const inOrg2 = await createTestProject(env.db, user.id, 'org-scope-out');
    await createGitHubConnection(env.db, {
      projectId: inOrg.id,
      installationId: '8140',
      repoFullName: 'org/in',
      repositoryId: '81401',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: inOrg2.id,
      installationId: '8141',
      repoFullName: 'org2/out',
      repositoryId: '81411',
      branch: 'main',
      buildExecutor: 'container',
    });

    const { app, appEnv } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    });

    expect(res.status).toBe(200);
    expect(await getGitHubConnection(env.db, inOrg.id)).toBeNull();
    expect(await getGitHubConnection(env.db, inOrg2.id)).not.toBeNull();
  });

  it('SCOPE: leaves another user’s connection + membership under the same org intact', async () => {
    const removed = await createTestUser(env.db, 'org-scope-u', 'github', G);
    const other = await createTestUser(env.db, 'org-scope-v', 'github', '8888');
    await seedOrgInstall('8150', ORG);
    const removedProj = await createTestProject(env.db, removed.id, 'org-u-proj');
    const otherProj = await createTestProject(env.db, other.id, 'org-v-proj');
    await createGitHubConnection(env.db, {
      projectId: removedProj.id,
      installationId: '8150',
      repoFullName: 'org/u',
      repositoryId: '81501',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: otherProj.id,
      installationId: '8150',
      repoFullName: 'org/v',
      repositoryId: '81502',
      branch: 'main',
      buildExecutor: 'container',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8150',
      userId: removed.id,
      githubAccountId: G,
      ttlSeconds: 3600,
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8150',
      userId: other.id,
      githubAccountId: '8888',
      ttlSeconds: 3600,
    });

    const { app, appEnv } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    });

    expect(res.status).toBe(200);
    expect(await getGitHubConnection(env.db, removedProj.id)).toBeNull();
    expect(await getGitHubConnection(env.db, otherProj.id)).not.toBeNull();
    const members = await getTestGitHubInstallationMembers(env.db, '8150');
    expect(members.some((m) => m.user_id === removed.id)).toBe(false);
    expect(members.some((m) => m.user_id === other.id)).toBe(true);
  });

  it('is idempotent on redelivery: two deliveries both 200, single net effect', async () => {
    const user = await createTestUser(env.db, 'org-idem', 'github', G);
    await seedOrgInstall('8170', ORG);
    const project = await createTestProject(env.db, user.id, 'org-idem-proj');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8170',
      repoFullName: 'org/idem',
      repositoryId: '81701',
      branch: 'main',
      buildExecutor: 'container',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8170',
      userId: user.id,
      githubAccountId: G,
      ttlSeconds: 3600,
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-idem',
      branch: 'main',
    });

    const { app, appEnv } = recordingApp();
    const payload = {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    };
    const res1 = await post(app, appEnv, 'organization', payload);
    const res2 = await post(app, appEnv, 'organization', payload);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true });
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
    const members = await getTestGitHubInstallationMembers(env.db, '8170');
    expect(members.some((m) => m.user_id === user.id)).toBe(false);
    expect((await getBuild(env.db, build.id))!.status).toBe('cancelled');
  });

  it('ignores payloads missing organization.id or membership.user.id', async () => {
    await createTestUser(env.db, 'org-missing', 'github', G);
    await seedOrgInstall('8180', ORG);

    const { app, appEnv } = recordingApp();

    const resNoOrg = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      membership: { user: { id: Number(G) } },
    });
    expect(resNoOrg.status).toBe(200);
    expect(await resNoOrg.json()).toEqual({ ok: true, ignored: 'organization: missing ids' });

    const resNoUser = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: {},
    });
    expect(resNoUser.status).toBe(200);
    expect(await resNoUser.json()).toEqual({ ok: true, ignored: 'organization: missing ids' });
  });

  // Decision: Monotonic revocation: member_removed writes a durable tombstone for (each org install, removed
  // user), so a later replay of a pre-removal join_code or connect_grant (iat <= revoked_at) is
  // rejected.
  it('records a revocation tombstone for every org install of the removed user', async () => {
    await createTestUser(env.db, 'org-tomb', 'github', G);
    await seedOrgInstall('8190', ORG);
    await seedOrgInstall('8191', ORG);
    await seedOrgInstall('8192', ORG2);

    const before = Date.now();
    const { app, appEnv } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    });
    expect(res.status).toBe(200);

    const t8190 = await getInstallationRevocationAt(env.db, '8190', G);
    const t8191 = await getInstallationRevocationAt(env.db, '8191', G);
    expect(t8190).not.toBeNull();
    expect(t8191).not.toBeNull();
    expect(t8190!).toBeGreaterThan(before - 60_000);
    expect(await getInstallationRevocationAt(env.db, '8192', G)).toBeNull();
  });

  it('redelivery keeps a single tombstone and never regresses revoked_at (monotonic)', async () => {
    await createTestUser(env.db, 'org-tomb-idem', 'github', G);
    await seedOrgInstall('8195', ORG);

    const { app, appEnv } = recordingApp();
    const payload = {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    };

    await post(app, appEnv, 'organization', payload);
    const first = await getInstallationRevocationAt(env.db, '8195', G);
    expect(first).not.toBeNull();

    await post(app, appEnv, 'organization', payload);
    const second = await getInstallationRevocationAt(env.db, '8195', G);
    expect(second).not.toBeNull();
    expect(second!).toBeGreaterThanOrEqual(first!);
  });
});

// Decision: The check-run rerun reuses the push pipeline, so it inherits the freshness gate: a rerun can't
// deploy a commit a push couldn't.
describe('POST /webhooks/github — rerun from the check run', () => {
  function pokeEnvWith(base: TestEnv): { pokeEnv: TestEnv; pokes: Array<string> } {
    const pokes: Array<string> = [];
    const pokeEnv: TestEnv = {
      ...base,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (url: string) => {
            pokes.push(url);
            return Response.json({ ok: true });
          },
        }),
      } as unknown as DurableObjectNamespace,
    };
    return { pokeEnv, pokes };
  }

  const checkRunPayload = (overrides?: {
    name?: string;
    action?: string;
    headSha?: string;
    headBranch?: string | null;
    id?: number;
    // Decision: No default: a per-check rerun that can't name its build fails closed, so each test that expects
    // work passes a real build id.
    externalId?: string;
    conclusion?: string | null;
  }) => ({
    action: overrides?.action ?? 'rerequested',
    installation: { id: 900 },
    repository: { full_name: 'octo/site', id: 9001 },
    check_run: {
      id: overrides?.id ?? 55_001,
      name: overrides?.name ?? 'Platform Build',
      head_sha: overrides?.headSha ?? 'cafe1234',
      external_id: overrides?.externalId ?? 'bld_old',
      conclusion: overrides?.conclusion === undefined ? 'failure' : overrides.conclusion,
      check_suite: {
        head_branch: overrides?.headBranch === undefined ? 'main' : overrides.headBranch,
      },
    },
  });

  async function seedClickedBuild(
    project: { id: string },
    user: { id: string },
    status: 'queued' | 'failed' | 'complete' = 'failed',
  ) {
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    if (status !== 'queued') {
      await env.db.update(builds).set({ status }).where(eq(builds.id, build.id));
    }
    return build;
  }

  async function seedContainerProject(slug: string, branch = 'main') {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, slug);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '900',
      repoFullName: 'octo/site',
      repositoryId: '9001',
      branch,
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '900');
    return { user, project };
  }

  it('enqueues a fresh build when the previous build for the commit FAILED', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-failed');
    const failed = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    await env.db.update(builds).set({ status: 'failed' }).where(eq(builds.id, failed.id));

    const { pokeEnv, pokes } = pokeEnvWith(env);
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'check_run', checkRunPayload({ externalId: failed.id }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);
    expect(json.buildIds[0]).not.toBe(failed.id);
    const build = await getBuild(env.db, json.buildIds[0]);
    expect(build!.project_id).toBe(project.id);
    expect(build!.commit_sha).toBe('cafe1234');
    expect(build!.status).toBe('queued');
    expect(pokes).toHaveLength(1);
  });

  it('refuses to rerun a commit that is no longer the branch head', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-stale');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatus('behind');
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'check_run', checkRunPayload({ externalId: clicked.id }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
    expect((await getProjectBuilds(env.db, project.id)).map((b) => b.id)).toEqual([clicked.id]);
  });

  it('refuses to rerun when the compare API is unreachable (fail closed)', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-unknown');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatus(null);
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'check_run', checkRunPayload({ externalId: clicked.id }));

    expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
    expect((await getProjectBuilds(env.db, project.id)).map((b) => b.id)).toEqual([clicked.id]);
  });

  it('ignores a rerequest for a check run that is not ours', async () => {
    await seedContainerProject('wh-rerun-foreign');
    const { app, appEnv } = makeApp(env);

    const res = await post(
      app,
      appEnv,
      'check_run',
      checkRunPayload({ name: 'Socket Security: Project Report' }),
    );

    expect(await res.json()).toEqual({ ok: true, ignored: 'check_run is not the Platform build' });
  });

  it('ignores non-rerequested check_run actions', async () => {
    await seedContainerProject('wh-rerun-created');
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'check_run', checkRunPayload({ action: 'created' }));

    expect(await res.json()).toEqual({ ok: true, ignored: 'check_run:created' });
  });

  it('skips a connection whose branch head is not this commit', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-otherbranch', 'release');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatusByBranch({ release: 'behind' });
    const { app, appEnv } = makeApp(env);

    const res = await post(
      app,
      appEnv,
      'check_run',
      checkRunPayload({ headBranch: 'main', externalId: clicked.id }),
    );

    expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
    expect((await getProjectBuilds(env.db, project.id)).map((b) => b.id)).toEqual([clicked.id]);
  });

  it('reruns a project tracking another branch at the SAME commit', async () => {
    // Decision: GitHub keeps one suite per app per commit even when that commit heads several branches, so the
    // payload names only one of them. Treating `head_branch` as a filter would drop this project's
    // connection and break its button.
    const { project, user } = await seedContainerProject('wh-rerun-samesha', 'release');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatusByBranch({ release: 'identical' });
    const { pokeEnv } = pokeEnvWith(env);
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(
      app,
      appEnv,
      'check_run',
      checkRunPayload({ headBranch: 'main', externalId: clicked.id }),
    );

    const json = (await res.json()) as { buildIds?: Array<string> };
    expect(json.buildIds).toHaveLength(1);
    expect((await getBuild(env.db, json.buildIds![0]))!.project_id).toBe(project.id);
  });

  it('tells a github_actions project to rerun from Actions instead', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-rerun-actions');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '900',
      repoFullName: 'octo/site',
      repositoryId: '9001',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '900');
    const clicked = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'check_run', checkRunPayload({ externalId: clicked.id }));

    // Decision: Nothing in the Checks API can start a workflow run, so say so rather than return a silent success
    // the user would read as a working button.
    expect(await res.json()).toEqual({
      ok: true,
      ignored: 'github_actions rerun must be run from Actions',
    });
  });

  it('handles "Re-run all checks" (check_suite:rerequested) the same way', async () => {
    const { project } = await seedContainerProject('wh-rerun-suite');
    const { pokeEnv } = pokeEnvWith(env);
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'check_suite', {
      action: 'rerequested',
      installation: { id: 900 },
      repository: { full_name: 'octo/site', id: 9001 },
      check_suite: { head_sha: 'cafe1234', head_branch: 'main' },
    });

    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);
    const build = await getBuild(env.db, json.buildIds[0]);
    expect(build!.project_id).toBe(project.id);
  });

  it('ignores check_suite:requested so a push is not built twice', async () => {
    await seedContainerProject('wh-suite-requested');
    const { app, appEnv } = makeApp(env);

    // Decision: A suite is requested on each push, which the push handler already builds.
    const res = await post(app, appEnv, 'check_suite', {
      action: 'requested',
      installation: { id: 900 },
      repository: { full_name: 'octo/site', id: 9001 },
      check_suite: { head_sha: 'cafe1234', head_branch: 'main' },
    });

    expect(await res.json()).toEqual({ ok: true, ignored: 'check_suite:requested' });
  });

  it('self-heals a renamed repo on rerun, so the build fetches the right source', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-rerun-renamed');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '900',
      repoFullName: 'octo/old-site',
      repositoryId: '9001',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '900');
    const clicked = await seedClickedBuild(project, user);
    const { pokeEnv } = pokeEnvWith(env);
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'check_run', checkRunPayload({ externalId: clicked.id }));

    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);
    const connection = await getGitHubConnection(env.db, project.id);
    expect(connection!.repo_full_name).toBe('octo/site');
  });

  it('ignores a rerequest with missing routing fields', async () => {
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'check_run', {
      action: 'rerequested',
      check_run: { name: 'Platform Build' },
    });

    expect(await res.json()).toEqual({ ok: true, ignored: 'missing check_run routing fields' });
  });

  async function seedSiblingProject(
    slug: string,
    executor: 'container' | 'github_actions',
    branch = 'main',
  ) {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, slug);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '900',
      repoFullName: 'octo/site',
      repositoryId: '9001',
      branch,
      buildExecutor: executor,
    });
    return { user, project };
  }

  it('rebuilds only the project whose check run was clicked', async () => {
    const { project: clicked, user } = await seedContainerProject('wh-rerun-target');
    const { project: sibling } = await seedSiblingProject('wh-rerun-sibling', 'container');
    const failed = await createTestBuild(env.db, {
      projectId: clicked.id,
      userId: user.id,
      executor: 'container',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    await env.db.update(builds).set({ status: 'failed' }).where(eq(builds.id, failed.id));

    const { pokeEnv } = pokeEnvWith(env);
    const { app, appEnv } = makeApp(pokeEnv);
    const res = await post(app, appEnv, 'check_run', checkRunPayload({ externalId: failed.id }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds?: Array<string> };
    expect(json.buildIds).toHaveLength(1);
    expect(await getProjectBuilds(env.db, sibling.id)).toHaveLength(0);
    expect((await getBuild(env.db, json.buildIds![0]))!.project_id).toBe(clicked.id);
  });

  it('never enqueues a sibling container build from a click on an Actions check', async () => {
    const actions = await seedSiblingProject('wh-rerun-actions-owner', 'github_actions');
    await seedInstallation(env.db, '900');
    const { project: containerSibling } = await seedSiblingProject(
      'wh-rerun-container-sib',
      'container',
    );
    const actionsBuild = await createTestBuild(env.db, {
      projectId: actions.project.id,
      userId: actions.user.id,
      executor: 'github_actions',
      commitSha: 'cafe1234',
      branch: 'main',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(
      app,
      appEnv,
      'check_run',
      checkRunPayload({ externalId: actionsBuild.id }),
    );

    expect(await res.json()).toEqual({
      ok: true,
      ignored: 'github_actions rerun must be run from Actions',
    });
    expect(await getProjectBuilds(env.db, containerSibling.id)).toHaveLength(0);
  });

  it('fans out across sibling projects for "Re-run all checks"', async () => {
    const { project: first } = await seedContainerProject('wh-suite-first');
    const { project: second } = await seedSiblingProject('wh-suite-second', 'container');

    const { pokeEnv } = pokeEnvWith(env);
    const { app, appEnv } = makeApp(pokeEnv);
    const res = await post(app, appEnv, 'check_suite', {
      action: 'rerequested',
      installation: { id: 900 },
      repository: { full_name: 'octo/site', id: 9001 },
      check_suite: { head_sha: 'cafe1234', head_branch: 'main' },
    });

    const json = (await res.json()) as { buildIds?: Array<string> };
    expect(json.buildIds).toHaveLength(2);
    expect(await getProjectBuilds(env.db, first.id)).toHaveLength(1);
    expect(await getProjectBuilds(env.db, second.id)).toHaveLength(1);
  });

  it('compares every branch of a suite fan-out concurrently, not in series', async () => {
    // Decision: Two projects on the same repo tracking different branches. `head_branch` isn't a filter, so both
    // are candidates and the handler owes one branch-head compare each. GitHub drops a delivery it
    // hasn't answered in 10s and doesn't redeliver it, so awaiting those compares in series turns a
    // slow GitHub into a silently lost Re-run click.
    const { project: first } = await seedContainerProject('wh-suite-conc-main');
    const { project: second } = await seedSiblingProject(
      'wh-suite-conc-release',
      'container',
      'release',
    );
    setCompareStatusByBranch({ main: 'identical', release: 'identical' });
    armCompareConcurrencyProbe(2);

    const { pokeEnv } = pokeEnvWith(env);
    const { app, appEnv } = makeApp(pokeEnv);
    const res = await post(app, appEnv, 'check_suite', {
      action: 'rerequested',
      installation: { id: 900 },
      repository: { full_name: 'octo/site', id: 9001 },
      check_suite: { head_sha: 'cafe1234', head_branch: 'main' },
    });

    expect(compareConcurrencyPeak).toBe(2);
    const json = (await res.json()) as { buildIds?: Array<string> };
    expect(json.buildIds).toHaveLength(2);
    expect(await getProjectBuilds(env.db, first.id)).toHaveLength(1);
    expect(await getProjectBuilds(env.db, second.id)).toHaveLength(1);
  });

  it('refuses a per-check rerun whose build no longer exists', async () => {
    const { project } = await seedContainerProject('wh-rerun-orphan-check');
    const { project: sibling } = await seedSiblingProject('wh-rerun-orphan-sib', 'container');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(true);
    try {
      const { pokeEnv, pokes } = pokeEnvWith(env);
      const { app, appEnv } = makeApp(pokeEnv);

      // Decision: Deleting a project cascades its build rows away while GitHub keeps the check for months. Falling
      // back to the branch set here would rebuild, and could deploy, sibling projects owned by other
      // users.
      const res = await post(app, appEnv, 'check_run', checkRunPayload({ id: 77_004 }));

      expect(await res.json()).toEqual({ ok: true, ignored: 'originating build not found' });
      expect(await getProjectBuilds(env.db, project.id)).toHaveLength(0);
      expect(await getProjectBuilds(env.db, sibling.id)).toHaveLength(0);
      expect(pokes).toHaveLength(0);
      const [, , , , opts] = spy.mock.calls[0]!;
      expect(opts.conclusion).toBe('failure');
    } finally {
      spy.mockRestore();
    }
  });

  it('never writes a passing conclusion for a rerun it refused', async () => {
    // Decision: GitHub counts `neutral` as passing for a required status check. Writing one here would let anyone
    // with rerun rights clear branch protection on a commit that never built.
    const { project, user } = await seedContainerProject('wh-rerun-no-bypass');
    const failed = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    await env.db.update(builds).set({ status: 'failed' }).where(eq(builds.id, failed.id));
    setCompareStatus('behind');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(true);
    try {
      const { app, appEnv } = makeApp(env);
      const res = await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_005, externalId: failed.id, conclusion: 'failure' }),
      );

      expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
      const [, , , , opts] = spy.mock.calls[0]!;
      expect(opts.conclusion).toBe('failure');
      expect(opts.title).toBe('Commit is no longer the branch head');
    } finally {
      spy.mockRestore();
    }
  });

  it('maps an unwritable `stale` conclusion to cancelled', async () => {
    // Decision: GitHub reports `stale` on a run but rejects it on update, so echoing it back would 422 each time
    // and leave the rerequest unresolved.
    const { project, user } = await seedContainerProject('wh-rerun-stale-conclusion');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatus('behind');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(true);
    try {
      const { app, appEnv } = makeApp(env);
      await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_008, externalId: clicked.id, conclusion: 'stale' }),
      );

      const [, , , , opts] = spy.mock.calls[0]!;
      expect(opts.conclusion).toBe('cancelled');
    } finally {
      spy.mockRestore();
    }
  });

  it('completes a refused rerun as cancelled when the run had no conclusion', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-null-conclusion');
    const failed = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    await env.db.update(builds).set({ status: 'failed' }).where(eq(builds.id, failed.id));
    setCompareStatus('behind');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(true);
    try {
      const { app, appEnv } = makeApp(env);
      await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_006, externalId: failed.id, conclusion: null }),
      );

      const [, , , , opts] = spy.mock.calls[0]!;
      expect(opts.conclusion).toBe('cancelled');
    } finally {
      spy.mockRestore();
    }
  });

  it('treats a reused QUEUED build as work, not as already live', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-queued-reuse');
    const queued = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    expect((await getBuild(env.db, queued.id))!.status).toBe('queued');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(true);
    try {
      const { pokeEnv, pokes } = pokeEnvWith(env);
      const { app, appEnv } = makeApp(pokeEnv);

      const res = await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_007, externalId: queued.id }),
      );

      const json = (await res.json()) as { buildIds?: Array<string> };
      expect(json.buildIds).toEqual([queued.id]);
      expect(pokes).toHaveLength(1);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('reports success, not neutral, when the commit is already built and live', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-already-live');
    const done = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    // Decision: The project is live on this commit, so the supersede tx reuses the completed row and returns it
    // non-null, which mustn't read as an enqueue.
    await createTestDeployment(env.db, project.id, 'live', undefined, undefined, {
      commit: 'cafe1234',
    });

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(true);
    try {
      const { pokeEnv, pokes } = pokeEnvWith(env);
      const { app, appEnv } = makeApp(pokeEnv);

      const res = await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_003, externalId: done.id }),
      );

      expect(await res.json()).toEqual({ ok: true, enqueued: 0, reused: [done.id] });
      expect(pokes).toHaveLength(0);
      expect(spy).toHaveBeenCalledTimes(1);
      const [, , , checkRunId, opts] = spy.mock.calls[0]!;
      expect(checkRunId).toBe('77003');
      expect(opts.conclusion).toBe('success');
      expect(opts.title).toBe('Already built and live');
      expect(await getProjectBuilds(env.db, project.id)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('completes the clicked check run when a stale commit enqueues nothing', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-stale-reported');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatus('behind');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(true);
    try {
      const { app, appEnv } = makeApp(env);
      const res = await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_001, externalId: clicked.id, conclusion: 'neutral' }),
      );

      expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
      // Decision: GitHub reset the suite to `queued` on the click. Leaving it there makes the button look broken, so
      // the refusal is reported on the check.
      expect(spy).toHaveBeenCalledTimes(1);
      const [, , , checkRunId, opts] = spy.mock.calls[0]!;
      expect(checkRunId).toBe('77001');
      expect(opts.conclusion).toBe('neutral');
      expect(opts.title).toBe('Commit is no longer the branch head');
    } finally {
      spy.mockRestore();
    }
  });

  it('still returns 2xx when GitHub REJECTS the no-op report', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-report-false');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatus('behind');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(false);
    try {
      const { app, appEnv } = makeApp(env);
      const res = await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_009, externalId: clicked.id }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('answers the webhook without waiting for the no-op report', async () => {
    // Decision: GitHub drops a delivery we haven't answered in 10s and doesn't redeliver a failure automatically.
    // completeCheckRun mints a token and retries with no clock of its own, so the report goes to
    // waitUntil and the 2xx doesn't wait on it. `post` awaits waitUntil for determinism, so this calls
    // app.fetch directly.
    const { project, user } = await seedContainerProject('wh-rerun-report-deferred');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatus('behind');

    const checkRunModule = await import('../../src/github/check-run.ts');
    let settle: (v: boolean) => void = () => {};
    const spy = vi
      .spyOn(checkRunModule, 'completeCheckRun')
      .mockImplementation(() => new Promise<boolean>((resolve) => (settle = resolve)));
    try {
      const { app, appEnv } = makeApp(env);
      const payload = checkRunPayload({ id: 77_010, externalId: clicked.id });
      const body = JSON.stringify(payload);
      const pending: Array<Promise<unknown>> = [];
      const res = await app.fetch(
        new Request('http://localhost/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'check_run',
            'X-Hub-Signature-256': await sign(WEBHOOK_SECRET, body),
          },
          body,
        }),
        { ...appEnv, GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET },
        {
          waitUntil: (p: Promise<unknown>) => {
            pending.push(p);
          },
          passThroughOnException: () => {},
        } as unknown as ExecutionContext,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
      expect(pending).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(1);
      settle(true);
      await Promise.all(pending);
    } finally {
      spy.mockRestore();
    }
  });

  it('still returns 2xx when reporting the no-op to GitHub fails', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-report-throws');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatus('behind');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi
      .spyOn(checkRunModule, 'completeCheckRun')
      .mockRejectedValue(new Error('check-run PATCH exploded'));
    try {
      const { app, appEnv } = makeApp(env);
      const res = await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_002, externalId: clicked.id }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
    } finally {
      spy.mockRestore();
    }
  });
});
