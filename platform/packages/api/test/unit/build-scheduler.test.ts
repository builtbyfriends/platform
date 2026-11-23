import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Decision: The DurableObject base class isn't available in unit tests, so it's mocked the same way as
// the other DO suites (cron-scheduler, usage-counter).
vi.mock('../../src/plans.ts', async () => {
  const { createDefaultPlanCatalog } = await import('@builtbyfriends/platform/plans');
  return {
    readPlanCatalog: vi.fn(async () => createDefaultPlanCatalog()),
    planFromCatalog: (catalog: ReturnType<typeof createDefaultPlanCatalog>, id: string) =>
      catalog.plans.find((plan) => plan.id === id) ??
      catalog.plans.find((plan) => plan.id === 'free')!,
  };
});

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Decision: db.ts is mocked so the queue, claim and concurrency logic runs against fakes instead of
// Postgres. tiers.ts stays real: its pure functions hold the per-plan concurrency the scheduler
// has to enforce.
type FakeBuild = {
  id: string;
  project_id: string;
  user_id: string;
  commit_sha: string | null;
  branch: string | null;
  executor?: 'container' | 'github_actions';
  instance_type?: string | null;
  age?: number;
};

const db = {
  // Decision: `queued` is every queued container build (what hasQueuedContainerBuilds sees). `startable` is
  // only the builds whose project is idle (what getQueuedBuilds returns). When `startable` is null
  // the two track together; set it to [] to model a fully blocked queue.
  queued: [] as Array<FakeBuild>,
  startable: null as Array<FakeBuild> | null,
  users: new Map<string, { plan: string; login: string; suspended_reason?: string | null }>(),
  activeByUser: new Map<string, number>(),
  connections: new Map<
    string,
    {
      id?: string;
      repo_full_name: string;
      installation_id: string;
      branch: string;
      build_executor?: 'container' | 'github_actions';
    } | null
  >(),
  projects: new Map<string, { slug: string } | null>(),
  unauthorizedConnectionIds: new Set<string>(),
  unclaimable: new Set<string>(),
  claimPlanByBuild: new Map<string, string>(),
  terminalized: new Set<string>(),
  failed: [] as Array<{ id: string; error: string }>,
  cancelled: [] as Array<{ id: string; error: string }>,
  requeued: [] as Array<string>,
  claimArgs: [] as Array<{
    buildId: string;
    userId: string;
    projectId: string;
  }>,
};

// Decision: The real claimBuildForStartWithinLimit checks the per-user cap and claims queued -> starting in
// one step, under the same per-user FOR UPDATE lock the OIDC path takes. This fake models the
// cap and race outcomes of that single primitive.
vi.mock('../../src/db.ts', () => ({
  createDb: () => ({ __mock: 'db' }),
  getQueuedBuilds: vi.fn(
    async (_db: unknown, limit: number, excludeUserIds: ReadonlyArray<string> = []) => {
      const exclude = new Set(excludeUserIds);
      return (db.startable ?? db.queued)
        .filter((b) => !exclude.has(b.user_id))
        .slice()
        .sort((a, b) => (b.age ?? 0) - (a.age ?? 0))
        .slice(0, limit);
    },
  ),
  getUsersWithQueuedContainerBuilds: vi.fn(async (_db: unknown) => {
    const ownerIds = new Set(db.queued.map((b) => b.user_id));
    return Array.from(ownerIds).map((userId) => ({
      userId,
      plan: db.users.get(userId)?.plan ?? 'free',
      suspendedReason: db.users.get(userId)?.suspended_reason ?? null,
      activeBuilds: db.activeByUser.get(userId) ?? 0,
    }));
  }),
  cancelQueuedContainerBuildsForUsers: vi.fn(
    async (_db: unknown, userIds: ReadonlyArray<string>) => {
      const suspended = new Set(userIds);
      const cancelled = db.queued.filter((build) => suspended.has(build.user_id));
      for (const build of cancelled) {
        db.cancelled.push({ id: build.id, error: 'project owner suspended' });
      }
      db.queued = db.queued.filter((build) => !suspended.has(build.user_id));
      if (db.startable) {
        db.startable = db.startable.filter((build) => !suspended.has(build.user_id));
      }
      return cancelled.length;
    },
  ),
  hasQueuedContainerBuilds: vi.fn(async (_db: unknown) => db.queued.length > 0),
  getUsersByIds: vi.fn(async (_db: unknown, ids: ReadonlyArray<string>) => {
    return ids.flatMap((id) => {
      const u = db.users.get(id);
      return u
        ? [{ id, plan: u.plan, login: u.login, suspended_reason: u.suspended_reason ?? null }]
        : [];
    });
  }),
  claimBuildForStartWithinLimit: vi.fn(
    async (
      _db: unknown,
      args: {
        buildId: string;
        userId: string;
        projectId: string;
      },
    ) => {
      db.claimArgs.push(args);
      const active = db.activeByUser.get(args.userId) ?? 0;
      const plan =
        db.claimPlanByBuild.get(args.buildId) ?? db.users.get(args.userId)?.plan ?? 'free';
      const limit =
        plan === 'custom'
          ? 0
          : plan === 'sponsored'
            ? 6
            : plan === 'pro'
              ? 3
              : plan === 'solo'
                ? 2
                : 1;
      if (limit > 0 && active >= limit) {
        return null;
      }
      if (db.unclaimable.has(args.buildId)) {
        return null;
      }
      const build = db.queued.find((candidate) => candidate.id === args.buildId)!;
      return {
        instanceType:
          build.instance_type ?? (plan === 'free' || plan === 'solo' ? 'standard-3' : 'standard-4'),
        ownerPlan: plan,
        timeoutMinutes:
          plan === 'custom' ? 0 : plan === 'sponsored' ? 20 : plan === 'free' ? 10 : 15,
      };
    },
  ),
  getGitHubConnection: vi.fn(async (_db: unknown, projectId: string) => {
    return db.connections.get(projectId) ?? null;
  }),
  hasGitHubConnectionAuthority: vi.fn(
    async (_db: unknown, connectionId: string) => !db.unauthorizedConnectionIds.has(connectionId),
  ),
  getProject: vi.fn(async (_db: unknown, id: string) => db.projects.get(id) ?? null),
  updateBuildStatus: vi.fn(
    async (_db: unknown, id: string, status: string, opts?: { error?: string }) => {
      if (status === 'failed') {
        db.failed.push({ id, error: opts?.error ?? '' });
      }
      if (status === 'cancelled') {
        db.cancelled.push({ id, error: opts?.error ?? '' });
      }
    },
  ),
  // Decision: Mirrors the real `UPDATE ... WHERE status IN (active)` guard: a row already driven terminal
  // (db.terminalized) is a no-op that returns false, so the RPC-failure catch can't overwrite a
  // committed 'cancelled' with 'failed'.
  markBuildTerminalIfActive: vi.fn(
    async (_db: unknown, id: string, status: string, opts?: { error?: string }) => {
      if (db.terminalized.has(id)) {
        return false;
      }
      if (status === 'failed') {
        db.failed.push({ id, error: opts?.error ?? '' });
      }
      if (status === 'cancelled') {
        db.cancelled.push({ id, error: opts?.error ?? '' });
      }
      return true;
    },
  ),
  // Decision: Mirrors the real `UPDATE ... WHERE status='starting'` guard: a row already driven terminal
  // (db.terminalized) is a no-op that returns false, so a capacity-shed build isn't resurrected.
  requeueBuildIfStarting: vi.fn(async (_db: unknown, id: string) => {
    if (db.terminalized.has(id)) {
      return false;
    }
    db.requeued.push(id);
    return true;
  }),
}));

import { BuildScheduler } from '../../src/build-scheduler.ts';
import {
  claimBuildForStartWithinLimit,
  getGitHubConnection,
  getQueuedBuilds,
  getUsersByIds,
  markBuildTerminalIfActive,
  requeueBuildIfStarting,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';

function makeStubCtx() {
  let alarmTime: number | null = null;
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: vi.fn(async (k: string) => store.get(k)),
      put: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
      getAlarm: vi.fn(async () => alarmTime),
      setAlarm: vi.fn(async (t: number) => {
        alarmTime = t;
      }),
      deleteAlarm: vi.fn(async () => {
        alarmTime = null;
      }),
    },
  };
}

// Decision: Base (free standard-3) and large (paid standard-4) namespaces each get their own spies, so a
// test can check which one a build went to. makeEnv(startBuild) gives both the same startBuild;
// makeEnv({ base, large }) gives each fleet its own, so one fleet can throw the capacity error
// while the other still starts.
function makeEnv(
  arg:
    | ReturnType<typeof vi.fn>
    | { base: ReturnType<typeof vi.fn>; large: ReturnType<typeof vi.fn> },
) {
  const baseStart = typeof arg === 'function' ? arg : arg.base;
  const largeStart = typeof arg === 'function' ? arg : arg.large;
  function makeNamespace(startBuild: ReturnType<typeof vi.fn>) {
    const stub = { startBuild };
    const idFromName = vi.fn((name: string) => ({ name }));
    const get = vi.fn(() => stub);
    return { idFromName, get };
  }
  const BUILD_MANAGER = makeNamespace(baseStart);
  const BUILD_MANAGER_LARGE = makeNamespace(largeStart);
  return {
    HYPERDRIVE: { connectionString: 'postgres://fake' },
    BUILD_MANAGER,
    BUILD_MANAGER_LARGE,
  } as unknown as ApiEnv['Bindings'] & {
    BUILD_MANAGER: typeof BUILD_MANAGER;
    BUILD_MANAGER_LARGE: typeof BUILD_MANAGER_LARGE;
  };
}

function makeScheduler(ctx: ReturnType<typeof makeStubCtx>, env: ApiEnv['Bindings']) {
  return new BuildScheduler(ctx as unknown as DurableObjectState, env);
}

function resetDb() {
  db.queued = [];
  db.startable = null;
  db.users = new Map();
  db.activeByUser = new Map();
  db.connections = new Map();
  db.projects = new Map();
  db.unauthorizedConnectionIds = new Set();
  db.unclaimable = new Set();
  db.claimPlanByBuild = new Map();
  db.terminalized = new Set();
  db.failed = [];
  db.cancelled = [];
  db.requeued = [];
  db.claimArgs = [];
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
});

describe('BuildScheduler.fetch', () => {
  it('POST /poke arms a near-immediate alarm', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv(vi.fn());
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    const res = await s.fetch(new Request('https://scheduler/poke', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now);
    expect(armed).toBeLessThanOrEqual(now + 1000);
  });

  it('GET /status returns the next alarm', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv(vi.fn());
    const s = makeScheduler(ctx, env);
    const res = await s.fetch(new Request('https://scheduler/status'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ nextAlarm: null });
  });

  it('unknown path 404s', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv(vi.fn());
    const s = makeScheduler(ctx, env);
    const res = await s.fetch(new Request('https://scheduler/nope'));
    expect(res.status).toBe(404);
  });
});

describe('BuildScheduler.alarm', () => {
  function enqueue(b: Partial<FakeBuild> & { id: string; user_id: string; project_id: string }) {
    const build: FakeBuild = {
      commit_sha: 'sha1',
      branch: 'main',
      ...b,
    };
    if (build.instance_type === undefined) {
      const plan = db.users.get(build.user_id)?.plan ?? 'free';
      build.instance_type = plan === 'free' || plan === 'solo' ? 'standard-3' : 'standard-4';
    }
    db.queued.push(build);
    if (!db.projects.has(build.project_id)) {
      db.projects.set(build.project_id, { slug: `slug-${build.project_id}` });
    }
    if (!db.connections.has(build.project_id)) {
      db.connections.set(build.project_id, {
        id: `connection-${build.project_id}`,
        repo_full_name: 'owner/repo',
        installation_id: 'inst1',
        branch: 'main',
      });
    }
  }

  it('does not reschedule when the queue is empty', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv(vi.fn());
    const s = makeScheduler(ctx, env);
    await s.alarm();
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
  });

  it('cancels a connection without current authority before claiming the build', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    db.unauthorizedConnectionIds.add('connection-p1');
    const startBuild = vi.fn(async () => {});
    const s = makeScheduler(makeStubCtx(), makeEnv(startBuild));

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.claimArgs).toEqual([]);
    expect(db.cancelled).toEqual([
      {
        id: 'b1',
        error: 'github repository authorization is no longer valid; reconnect the repository',
      },
    ]);
  });

  it('cancels a queued build owned by a manually suspended user before claiming it', async () => {
    db.users.set('u1', {
      plan: 'free',
      login: 'octocat',
      suspended_reason: 'platform policy violation',
    });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    db.activeByUser.set('u1', 1);
    db.startable = [];
    const startBuild = vi.fn(async () => {});
    const s = makeScheduler(makeStubCtx(), makeEnv(startBuild));

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.claimArgs).toEqual([]);
    expect(db.cancelled).toEqual([{ id: 'b1', error: 'project owner suspended' }]);
  });

  it('re-arms the alarm when the queue is fully blocked (nothing startable but queued work remains)', async () => {
    // Decision: When nothing is startable but queued builds remain, the alarm has to keep its heartbeat so the
    // blocked build starts when its project frees. A completion poke alone can get lost.
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    db.startable = [];
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now + 2000 - 500);
  });

  it('claims a startable build and invokes startBuild on the manager stub', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    const cfg = startBuild.mock.calls[0][0] as {
      buildId: string;
      projectSlug: string;
      login: string;
      repoFullName: string;
      installationId: string;
      instanceType: string;
      timeoutMinutes: number;
    };
    expect(cfg.buildId).toBe('b1');
    expect(cfg.projectSlug).toBe('slug-p1');
    expect(cfg.login).toBe('octocat');
    expect(cfg.repoFullName).toBe('owner/repo');
    expect(cfg.installationId).toBe('inst1');
    expect(cfg.instanceType).toBe('standard-3');
    expect(cfg.timeoutMinutes).toBe(10);
    expect(
      (env as unknown as { BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn> } }).BUILD_MANAGER
        .idFromName,
    ).toHaveBeenCalledWith('b1');
    expect(claimBuildForStartWithinLimit).toHaveBeenCalledOnce();
    expect(db.claimArgs).toEqual([{ buildId: 'b1', userId: 'u1', projectId: 'p1' }]);
  });

  it('enforces per-user tier concurrency (free plan = 1)', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    db.activeByUser.set('u1', 1);
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(getQueuedBuilds).toHaveBeenCalledWith(expect.anything(), expect.any(Number), ['u1']);
    expect(db.claimArgs).toEqual([]);
    expect(startBuild).not.toHaveBeenCalled();
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
  });

  it('starts only when claimBuildForStartWithinLimit returns a build', async () => {
    db.users.set('u1', { plan: 'pro', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    enqueue({ id: 'b2', user_id: 'u1', project_id: 'p2' });
    db.unclaimable.add('b2');
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(db.claimArgs).toEqual([
      { buildId: 'b1', userId: 'u1', projectId: 'p1' },
      { buildId: 'b2', userId: 'u1', projectId: 'p2' },
    ]);
    expect(startBuild).toHaveBeenCalledOnce();
    expect((startBuild.mock.calls[0][0] as { buildId: string }).buildId).toBe('b1');
    expect(db.failed.some((f) => f.id === 'b2')).toBe(false);
    expect(getUsersByIds).toHaveBeenCalledOnce();
    expect(getUsersByIds).toHaveBeenCalledWith(expect.anything(), ['u1']);
  });

  it('allows pro plan to start up to 3 concurrent builds', async () => {
    db.users.set('u1', { plan: 'pro', login: 'octocat' });
    db.activeByUser.set('u1', 2);
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    const cfg = startBuild.mock.calls[0][0] as { instanceType: string };
    expect(cfg.instanceType).toBe('standard-4');
  });

  it('routes a PAID-plan build to the BUILD_MANAGER_LARGE namespace (not BUILD_MANAGER)', async () => {
    db.users.set('u1', { plan: 'pro', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild) as unknown as {
      BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
      BUILD_MANAGER_LARGE: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    };
    const s = makeScheduler(ctx, env as unknown as ApiEnv['Bindings']);

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    expect(env.BUILD_MANAGER_LARGE.idFromName).toHaveBeenCalledWith('b1');
    expect(env.BUILD_MANAGER_LARGE.get).toHaveBeenCalledOnce();
    expect(env.BUILD_MANAGER.idFromName).not.toHaveBeenCalled();
    expect(env.BUILD_MANAGER.get).not.toHaveBeenCalled();
  });

  it('routes a FREE-plan build to the BUILD_MANAGER namespace (not BUILD_MANAGER_LARGE)', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild) as unknown as {
      BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
      BUILD_MANAGER_LARGE: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    };
    const s = makeScheduler(ctx, env as unknown as ApiEnv['Bindings']);

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    expect(env.BUILD_MANAGER.idFromName).toHaveBeenCalledWith('b1');
    expect(env.BUILD_MANAGER.get).toHaveBeenCalledOnce();
    expect(env.BUILD_MANAGER_LARGE.idFromName).not.toHaveBeenCalled();
    expect(env.BUILD_MANAGER_LARGE.get).not.toHaveBeenCalled();
  });

  it('routes by the PERSISTED instance_type (standard-4) even when the owner plan would recompute smaller', async () => {
    // Decision: The instance_type persisted at enqueue wins over a plan recompute, so a plan change can't move
    // an in-flight build to a different container size.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', instance_type: 'standard-4' });
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild) as unknown as {
      BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
      BUILD_MANAGER_LARGE: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    };
    const s = makeScheduler(ctx, env as unknown as ApiEnv['Bindings']);

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    const cfg = startBuild.mock.calls[0][0] as { instanceType: string };
    expect(cfg.instanceType).toBe('standard-4');
    expect(env.BUILD_MANAGER_LARGE.idFromName).toHaveBeenCalledWith('b1');
    expect(env.BUILD_MANAGER.idFromName).not.toHaveBeenCalled();
  });

  it('uses the locked owner plan for a legacy row when the earlier plan snapshot is stale', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', instance_type: null });
    db.claimPlanByBuild.set('b1', 'pro');
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild) as unknown as {
      BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
      BUILD_MANAGER_LARGE: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    };
    const s = makeScheduler(ctx, env as unknown as ApiEnv['Bindings']);

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    const cfg = startBuild.mock.calls[0][0] as {
      instanceType: string;
      timeoutMinutes: number;
    };
    expect(cfg.instanceType).toBe('standard-4');
    expect(cfg.timeoutMinutes).toBe(15);
    expect(env.BUILD_MANAGER_LARGE.idFromName).toHaveBeenCalledWith('b1');
    expect(env.BUILD_MANAGER.idFromName).not.toHaveBeenCalled();
  });

  it('fails a build with a missing user and continues', async () => {
    enqueue({ id: 'b1', user_id: 'u-missing', project_id: 'p1' });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.failed.some((f) => f.id === 'b1' && /user/.test(f.error))).toBe(true);
  });

  it('fails a build whose project has no github connection', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    db.connections.set('p1', null);
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.failed.some((f) => f.id === 'b1' && /connection/.test(f.error))).toBe(true);
  });

  it('leaves a build queued, keeps scanning and re-arms the alarm when a pre-claim lookup throws transiently', async () => {
    // Decision: getGitHubConnection and getProject run before the claim, so a transient DB throw leaves the
    // build queued. A claimed build with no BuildManager yet has nothing to own its timeout, and the
    // stale reaper only covers github_actions builds, so it would stay `starting` and block its project.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', age: 2 });
    enqueue({ id: 'b2', user_id: 'u1', project_id: 'p2', age: 1 });
    vi.mocked(getGitHubConnection).mockRejectedValueOnce(new Error('hyperdrive timeout'));
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(db.claimArgs.map((c) => c.buildId)).toEqual(['b2']);
    expect(startBuild).toHaveBeenCalledOnce();
    expect(db.failed).toHaveLength(0);
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
  });

  it('excludes a capped owner from the scan so an under-cap owner is not starved', async () => {
    // Decision: The per-user cap is only checked at claim time. If a capped owner held the first rows in the
    // scan, each tick would skip them and never reach an under-cap owner's build, so capped owners
    // are excluded from the scan up front.
    db.users.set('u1', { plan: 'free', login: 'capped' });
    db.users.set('u2', { plan: 'free', login: 'eligible' });
    db.activeByUser.set('u1', 1);
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', age: 2 });
    enqueue({ id: 'b2', user_id: 'u2', project_id: 'p2', age: 1 });
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(getQueuedBuilds).toHaveBeenCalledOnce();
    const [, , excludeUserIds] = vi.mocked(getQueuedBuilds).mock.calls[0];
    expect(excludeUserIds).toEqual(['u1']);

    expect(db.claimArgs).toEqual([{ buildId: 'b2', userId: 'u2', projectId: 'p2' }]);
    expect(startBuild).toHaveBeenCalledOnce();
    expect((startBuild.mock.calls[0][0] as { buildId: string }).buildId).toBe('b2');
  });

  it('requeues a build (not failed) and backs off when startBuild throws the container-capacity error', async () => {
    // Decision: When the fleet is at max_instances, @cloudflare/containers throws a capacity error from start().
    // That's transient pressure: the build goes back to `queued` through the guarded CAS instead of
    // failing, and the alarm backs off with jitter (>= CAPACITY_BACKOFF_BASE_MS) so the GitHub compare
    // and token mint don't run every 2s while the fleet is full.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    expect(db.requeued).toEqual(['b1']);
    expect(db.failed.some((f) => f.id === 'b1')).toBe(false);
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now + 20_000);
  });

  it('per-namespace shedding: a FREE fleet capacity error does NOT stall a later PAID build on LARGE', async () => {
    db.users.set('uf', { plan: 'free', login: 'freeuser' });
    db.users.set('up', { plan: 'pro', login: 'prouser' });
    enqueue({ id: 'b-free', user_id: 'uf', project_id: 'pf', age: 2 });
    enqueue({ id: 'b-paid', user_id: 'up', project_id: 'pp', age: 1 });
    const base = vi.fn(async (_cfg: unknown) => {
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const large = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv({ base, large }) as unknown as ApiEnv['Bindings'] & {
      BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn> };
      BUILD_MANAGER_LARGE: { idFromName: ReturnType<typeof vi.fn> };
    };
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    expect(base).toHaveBeenCalledOnce();
    expect((base.mock.calls[0][0] as { buildId: string }).buildId).toBe('b-free');
    expect(large).toHaveBeenCalledOnce();
    expect((large.mock.calls[0][0] as { buildId: string }).buildId).toBe('b-paid');
    expect(env.BUILD_MANAGER_LARGE.idFromName).toHaveBeenCalledWith('b-paid');
    expect(db.requeued).toEqual(['b-free']);
    expect(db.failed).toEqual([]);
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now + 20_000);
  });

  it('per-namespace shedding: a PAID fleet capacity error does NOT stall a later FREE build on base', async () => {
    db.users.set('up', { plan: 'pro', login: 'prouser' });
    db.users.set('uf', { plan: 'free', login: 'freeuser' });
    enqueue({ id: 'b-paid', user_id: 'up', project_id: 'pp', age: 2 });
    enqueue({ id: 'b-free', user_id: 'uf', project_id: 'pf', age: 1 });
    const base = vi.fn(async (_cfg: unknown) => {});
    const large = vi.fn(async (_cfg: unknown) => {
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const ctx = makeStubCtx();
    const env = makeEnv({ base, large }) as unknown as ApiEnv['Bindings'] & {
      BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn> };
    };
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    expect(large).toHaveBeenCalledOnce();
    expect((large.mock.calls[0][0] as { buildId: string }).buildId).toBe('b-paid');
    expect(base).toHaveBeenCalledOnce();
    expect((base.mock.calls[0][0] as { buildId: string }).buildId).toBe('b-free');
    expect(env.BUILD_MANAGER.idFromName).toHaveBeenCalledWith('b-free');
    expect(db.requeued).toEqual(['b-paid']);
    expect(db.failed).toEqual([]);
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now + 20_000);
  });

  it('skips a same-fleet build after that fleet saturated this tick (no second startBuild on the full fleet)', async () => {
    // Decision: Once a fleet is saturated in a tick, later builds for that fleet are skipped before the claim,
    // so they don't spend another GitHub compare and token mint against a full fleet.
    db.users.set('uf', { plan: 'free', login: 'freeuser' });
    enqueue({ id: 'b1', user_id: 'uf', project_id: 'p1', age: 2 });
    enqueue({ id: 'b2', user_id: 'uf', project_id: 'p2', age: 1 });
    const base = vi.fn(async (_cfg: unknown) => {
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const large = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv({ base, large });
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    expect(base).toHaveBeenCalledOnce();
    expect((base.mock.calls[0][0] as { buildId: string }).buildId).toBe('b1');
    expect(db.claimArgs).toEqual([{ buildId: 'b1', userId: 'uf', projectId: 'p1' }]);
    expect(db.requeued).toEqual(['b1']);
    expect(db.failed).toEqual([]);
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now + 20_000);
  });

  it('does NOT requeue a concurrently-cancelled build on the capacity path (guarded CAS no-ops)', async () => {
    // Decision: The capacity-shed retry can't use an unconditional updateBuildStatus('queued'). If a concurrent
    // terminalizer cancelled the `starting` row while startBuild was in flight, that write would bring
    // it back to queued and a superseded commit could deploy. requeueBuildIfStarting only moves
    // starting -> queued.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {
      db.terminalized.add('b1');
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(db.requeued).toEqual([]);
    expect(db.failed.some((f) => f.id === 'b1')).toBe(false);
  });

  it('fails a build (not requeued) when startBuild throws a deterministic error', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {
      throw new Error('boom');
    });
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(db.failed.some((f) => f.id === 'b1' && /boom/.test(f.error))).toBe(true);
    expect(db.requeued).toEqual([]);
  });

  // Decision: The RPC-failure catch finalizes through markBuildTerminalIfActive, not an unconditional
  // updateBuildStatus('failed'). A concurrent cancel may already have committed 'cancelled' while
  // startBuild was in flight, and an unconditional write would overwrite it.
  it('does NOT clobber a concurrently-cancelled build when the startBuild RPC throws a deterministic error', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {
      db.terminalized.add('b1');
      throw new Error('rpc transport failed');
    });
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(db.failed.some((f) => f.id === 'b1')).toBe(false);
    expect(db.requeued).toEqual([]);
  });

  // Decision: The terminal write in the RPC-failure catch is itself a Postgres call. If it throws, the error
  // mustn't escape alarm(): that would end the scan and skip the tail reschedule, so the scheduler
  // goes quiet while queued work remains. The write is best effort: log it and keep draining.
  it('keeps scanning and re-arms the alarm when the RPC-fail terminal write throws (slot-safe)', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    db.users.set('u2', { plan: 'free', login: 'hubot' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    enqueue({ id: 'b2', user_id: 'u2', project_id: 'p2' });
    const startBuild = vi.fn(async (cfg: { buildId: string }) => {
      if (cfg.buildId === 'b1') {
        throw new Error('rpc transport failed');
      }
    });
    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('hyperdrive timeout'));
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await expect(s.alarm()).resolves.toBeUndefined();

    expect(startBuild).toHaveBeenCalledTimes(2);
    expect(startBuild.mock.calls[1][0].buildId).toBe('b2');

    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
  });

  // Decision: The fleet is marked saturated before the best-effort requeueBuildIfStarting write. If that write
  // throws and escapes, later same-fleet builds aren't skipped and the tail backoff doesn't run.
  it('keeps the fleet saturated and re-arms the backoff when the capacity requeue write throws (slot-safe)', async () => {
    db.users.set('uf', { plan: 'free', login: 'freeuser' });
    db.users.set('up', { plan: 'pro', login: 'prouser' });
    enqueue({ id: 'b-free', user_id: 'uf', project_id: 'pf', age: 3 });
    enqueue({ id: 'b-free2', user_id: 'uf', project_id: 'pf2', age: 2 });
    enqueue({ id: 'b-paid', user_id: 'up', project_id: 'pp', age: 1 });
    const base = vi.fn(async (_cfg: unknown) => {
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const large = vi.fn(async (_cfg: unknown) => {});
    vi.mocked(requeueBuildIfStarting).mockRejectedValueOnce(new Error('hyperdrive timeout'));
    const ctx = makeStubCtx();
    const env = makeEnv({ base, large });
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await expect(s.alarm()).resolves.toBeUndefined();

    expect(base).toHaveBeenCalledOnce();
    expect((base.mock.calls[0][0] as { buildId: string }).buildId).toBe('b-free');
    expect(db.claimArgs.some((a) => a.buildId === 'b-free2')).toBe(false);

    expect(large).toHaveBeenCalledOnce();
    expect((large.mock.calls[0][0] as { buildId: string }).buildId).toBe('b-paid');

    expect(db.requeued).toEqual([]);
    expect(db.failed).toEqual([]);

    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now + 20_000);
  });

  it('cancels a queued build whose branch no longer matches the connection (DiD)', async () => {
    // Decision: Defense in depth: if the connection's branch changed after the build was queued, the scheduler
    // cancels it ('github connection config changed') instead of starting it. It's not a failure, and
    // BuildManager's just-in-time check only compares the branch head, so it wouldn't catch this.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', branch: 'main' });
    db.connections.set('p1', {
      repo_full_name: 'owner/repo',
      installation_id: 'inst1',
      branch: 'develop',
    });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.claimArgs).toEqual([]);
    expect(db.cancelled).toEqual([{ id: 'b1', error: 'github connection config changed' }]);
    expect(db.failed).toEqual([]);
  });

  it('cancels a queued build without a branch instead of starting it', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', branch: null });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.claimArgs).toEqual([]);
    expect(db.cancelled).toEqual([{ id: 'b1', error: 'github connection config changed' }]);
    expect(db.failed).toEqual([]);
  });

  it('cancels a queued build whose executor no longer matches the connection (DiD)', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', branch: 'main', executor: 'container' });
    db.connections.set('p1', {
      repo_full_name: 'owner/repo',
      installation_id: 'inst1',
      branch: 'main',
      build_executor: 'github_actions',
    });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.claimArgs).toEqual([]);
    expect(db.cancelled).toEqual([{ id: 'b1', error: 'github connection config changed' }]);
    expect(db.failed).toEqual([]);
  });

  it('reschedules a +2s alarm while the queue still has work', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    db.users.set('u2', { plan: 'free', login: 'hubot' });
    db.activeByUser.set('u2', 1);
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    enqueue({ id: 'b2', user_id: 'u2', project_id: 'p2' });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now + 2000 - 500);
  });
});
