import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Decision: Exercises the real `check-run.ts` through a stubbed global `fetch`, unlike the unit harness
// (test/unit/build-manager.test.ts), so the BuildManager's create and finalize wiring and its
// best-effort handling are checked end to end.

// Decision: Same stub of the `@cloudflare/containers` Container base class as the unit harness: start()
// launches and then runs onStart before resolving, stop()/destroy() model SIGTERM/SIGKILL, and
// schedule()/_runDueSchedules() model the base alarm loop.
const containerCalls = {
  started: 0,
  stopped: 0,
  destroyed: 0,
  baseAlarms: 0,
};
type ScheduledTask = { whenSeconds: number; callback: string };
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    ctx: unknown;
    env: unknown;
    envVars: Record<string, string> = {};
    defaultPort?: number;
    enableInternet?: boolean;
    sleepAfter?: string | number;
    _schedules: Array<ScheduledTask> = [];
    _containerRunning = false;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    async start(): Promise<void> {
      containerCalls.started += 1;
      this._containerRunning = true;
      await (this as unknown as { onStart(): Promise<void> }).onStart();
    }
    async stop(): Promise<void> {
      containerCalls.stopped += 1;
      this._containerRunning = false;
    }
    async destroy(): Promise<void> {
      containerCalls.destroyed += 1;
      this._containerRunning = false;
    }
    async fetch(): Promise<Response> {
      return new Response('container', { status: 200 });
    }
    async schedule(whenSeconds: number, callback: string): Promise<void> {
      this._schedules.push({ whenSeconds, callback });
    }
    async alarm(): Promise<void> {
      containerCalls.baseAlarms += 1;
    }
    async _runDueSchedules(): Promise<void> {
      const due = this._schedules;
      this._schedules = [];
      for (const task of due) {
        const fn = (this as unknown as Record<string, () => Promise<void>>)[task.callback];
        await fn.call(this);
      }
    }
  },
}));

type StatusWrite = {
  id: string;
  status: string;
  opts?: {
    error?: string;
    exitCode?: number;
    deploymentId?: string | null;
    instanceType?: string | null;
  };
};
const ACTIVE_BUILD_STATUSES = new Set(['starting', 'building', 'deploying']);
const dbState = {
  writes: [] as Array<StatusWrite>,
  status: new Map<string, string>(),
  deployment: null as { id: string } | null,
  createdAt: new Date().toISOString(),
  requeued: [] as Array<string>,
  installationCovered: true,
  checkRunIds: new Map<string, string>(),
  setCheckRunIdThrows: false,
};
vi.mock('../../src/db.ts', () => ({
  createDb: () => ({ __mock: 'db' }),
  updateBuildStatus: vi.fn(async (_db: unknown, id: string, status: string, opts?: unknown) => {
    dbState.status.set(id, status);
    dbState.writes.push({ id, status, opts: opts as StatusWrite['opts'] });
  }),
  markBuildBuildingIfStarting: vi.fn(
    async (_db: unknown, id: string, opts?: { instanceType?: string | null }) => {
      if (dbState.status.get(id) !== 'starting') {
        return false;
      }
      dbState.status.set(id, 'building');
      dbState.writes.push({ id, status: 'building', opts });
      return true;
    },
  ),
  markBuildTerminalIfActive: vi.fn(
    async (_db: unknown, id: string, status: string, opts?: unknown) => {
      const current = dbState.status.get(id);
      if (current === undefined || !ACTIVE_BUILD_STATUSES.has(current)) {
        return false;
      }
      dbState.status.set(id, status);
      dbState.writes.push({ id, status, opts: opts as StatusWrite['opts'] });
      return true;
    },
  ),
  markBuildProgressIfActive: vi.fn(async (_db: unknown, id: string, status: string) => {
    const current = dbState.status.get(id);
    if (current === undefined || !ACTIVE_BUILD_STATUSES.has(current)) {
      return false;
    }
    dbState.status.set(id, status);
    dbState.writes.push({ id, status, opts: undefined });
    return true;
  }),
  getDeploymentByProjectAndCommit: vi.fn(async () => dbState.deployment),
  getBuild: vi.fn(async (_db: unknown, id: string) => {
    const status = dbState.status.get(id);
    if (status === undefined) {
      return null;
    }
    // Decision: Carry the persisted `check_run_id` (the real row does) so the finalizeCheckRun DO-storage-miss
    // fallback can recover it from Postgres.
    return {
      id,
      created_at: dbState.createdAt,
      status,
      check_run_id: dbState.checkRunIds.get(id) ?? null,
    };
  }),
  requeueBuildIfStarting: vi.fn(async (_db: unknown, id: string) => {
    if (dbState.status.get(id) !== 'starting') {
      return false;
    }
    dbState.status.set(id, 'queued');
    dbState.requeued.push(id);
    return true;
  }),
  installationCoversRepo: vi.fn(
    async (
      _db: unknown,
      connectionId: string,
      _projectId: string,
      _installationId: string,
      _repositoryId: string,
    ) => {
      if (!connectionId) {
        return false;
      }
      return dbState.installationCovered;
    },
  ),
  setBuildCheckRunId: vi.fn(async (_db: unknown, id: string, checkRunId: string) => {
    if (dbState.setCheckRunIdThrows) {
      throw new Error('postgres write failed');
    }
    dbState.checkRunIds.set(id, checkRunId);
  }),
}));

vi.mock('../../src/auth/deploy-token.ts', () => ({
  signDeployToken: vi.fn(async () => 'deploy-token'),
  DEPLOY_TOKEN_HARD_MAX_MINUTES: 60,
  deployTokenTtlSecondsForBuildMinutes: (timeoutMinutes: number) => {
    const buildMinutes = timeoutMinutes > 0 ? timeoutMinutes : Infinity;
    const cappedMinutes = Math.min(buildMinutes, 60);
    return cappedMinutes * 60 + 5 * 60;
  },
}));

// Decision: Provide a real `getInstallationToken` so the unmocked `check-run.ts` can mint a token and reach
// `fetch`. `check-run.ts` isn't mocked on purpose: this test drives the real module.
vi.mock('../../src/github/installation-token.ts', () => ({
  GITHUB_API_BASE: 'https://api.github.com',
  GITHUB_API_VERSION: '2026-03-10',
  getInstallationToken: vi.fn(async () => 'install-token'),
  generateSourceTarballUrl: vi.fn(
    (repo: string, sha: string) => `https://api.github.com/repos/${repo}/tarball/${sha}`,
  ),
  getBranchHeadComparisonStatus: vi.fn(async () => 'identical'),
}));

import { signDeployToken } from '../../src/auth/deploy-token.ts';
import { BuildManager } from '../../src/build-manager.ts';
import type { BuildConfig } from '../../src/build-types.ts';
import { getBuild, markBuildTerminalIfActive } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { getBranchHeadComparisonStatus } from '../../src/github/installation-token.ts';

type LogRow = { seq: number; line: string; stream: string; ts: number };

function makeStubCtx() {
  const kv = new Map<string, unknown>();
  const logs: Array<LogRow> = [];
  let seq = 0;
  const sockets: Array<FakeWebSocket> = [];

  const sql = {
    exec(query: string, ...bindings: Array<unknown>) {
      if (query.startsWith('INSERT INTO logs')) {
        seq += 1;
        logs.push({
          seq,
          line: bindings[0] as string,
          stream: bindings[1] as string,
          ts: bindings[2] as number,
        });
      }
      return { toArray: () => logs.slice().sort((a, b) => a.seq - b.seq) };
    },
  };

  return {
    _logs: logs,
    _sockets: sockets,
    _kv: kv,
    storage: {
      sql,
      get: vi.fn(async (k: string) => kv.get(k)),
      put: vi.fn(async (k: string, v: unknown) => {
        kv.set(k, v);
      }),
      getAlarm: vi.fn(async () => null),
      setAlarm: vi.fn(async () => {}),
      deleteAlarm: vi.fn(async () => {}),
    },
    acceptWebSocket: vi.fn((ws: FakeWebSocket) => {
      sockets.push(ws);
    }),
    getWebSockets: vi.fn(() => sockets),
  };
}

class FakeWebSocket {
  sent: Array<string> = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

function makeEnv() {
  const schedulerStub = { fetch: vi.fn(async () => new Response('ok')) };
  return {
    HYPERDRIVE: { connectionString: 'postgres://fake' },
    JWT_SECRET: 'secret',
    PLATFORM_ENV: undefined,
    BUILD_SCHEDULER: {
      idFromName: vi.fn((n: string) => ({ name: n })),
      get: vi.fn(() => schedulerStub),
    },
  } as unknown as ApiEnv['Bindings'] & {
    BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> };
  };
}

function makeConfig(overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    buildId: 'b1',
    projectId: 'p1',
    projectSlug: 'my-app',
    userId: 'u1',
    login: 'octocat',
    commitSha: 'sha1234567890',
    branch: 'main',
    repoFullName: 'owner/repo',
    connectionId: 'c1',
    installationId: 'inst1',
    repositoryId: 'repo1',
    instanceType: 'standard-1',
    timeoutMinutes: 10,
    ...overrides,
  };
}

function makeManager(ctx: ReturnType<typeof makeStubCtx>, env: ApiEnv['Bindings']) {
  return new BuildManager(ctx as unknown as ConstructorParameters<typeof BuildManager>[0], env);
}

async function runDueSchedules(m: BuildManager): Promise<void> {
  await (m as unknown as { _runDueSchedules: () => Promise<void> })._runDueSchedules();
}

function schedulerGet(env: ApiEnv['Bindings']): ReturnType<typeof vi.fn> {
  return (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
    .get;
}

type FetchCall = {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
};

const CHECK_RUN_ID = 99_001;

type FetchMatchers = {
  createStatus?: number;
  createBody?: Record<string, unknown> | null;
  completeStatus?: number;
};

function installFetch(matchers: FetchMatchers = {}): {
  posts: Array<FetchCall>;
  patches: Array<FetchCall>;
  calls: Array<FetchCall>;
} {
  const posts: Array<FetchCall> = [];
  const patches: Array<FetchCall> = [];
  const calls: Array<FetchCall> = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: Record<string, unknown> | undefined;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          body = undefined;
        }
      }
      const call: FetchCall = { method, url, body };
      calls.push(call);

      if (url.includes('/access_tokens') && method === 'POST') {
        return Response.json({
          token: 'tok',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }

      if (method === 'PATCH' && /\/check-runs\/[^/]+$/.test(url)) {
        patches.push(call);
        const status = matchers.completeStatus ?? 200;
        if (status >= 400) {
          return new Response('patch error', { status });
        }
        return Response.json({ id: CHECK_RUN_ID, status: 'completed' }, { status });
      }

      if (method === 'POST' && /\/check-runs$/.test(url)) {
        posts.push(call);
        const status = matchers.createStatus ?? 201;
        if (status >= 400) {
          return new Response('create error', { status });
        }
        const responseBody =
          matchers.createBody === undefined
            ? { id: CHECK_RUN_ID, status: 'in_progress' }
            : matchers.createBody;
        return Response.json(responseBody ?? {}, { status });
      }

      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );

  return { posts, patches, calls };
}

beforeEach(() => {
  dbState.writes = [];
  dbState.status = new Map<string, string>([['b1', 'starting']]);
  dbState.deployment = null;
  dbState.createdAt = new Date().toISOString();
  dbState.requeued = [];
  dbState.installationCovered = true;
  dbState.checkRunIds = new Map<string, string>();
  dbState.setCheckRunIdThrows = false;
  containerCalls.started = 0;
  containerCalls.stopped = 0;
  containerCalls.destroyed = 0;
  containerCalls.baseAlarms = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BuildManager check-run lifecycle — create', () => {
  it('POSTs one in_progress check-run once all rechecks pass and persists the id', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toMatch(/\/repos\/owner\/repo\/check-runs$/);
    expect(posts[0].body).toMatchObject({
      name: 'Platform Build',
      head_sha: 'sha1234567890',
      external_id: 'b1',
      status: 'in_progress',
    });
    expect(patches).toHaveLength(0);
    expect(dbState.checkRunIds.get('b1')).toBe(String(CHECK_RUN_ID));
    expect(ctx._kv.get('checkRunId')).toBe(String(CHECK_RUN_ID));
    expect(containerCalls.started).toBe(1);
  });

  it('does NOT POST when freshness is non-identical (no check-run, NULL id)', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce('ahead');
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(0);
    expect(dbState.checkRunIds.has('b1')).toBe(false);
    expect(ctx._kv.get('checkRunId')).toBeUndefined();
    expect(containerCalls.started).toBe(0);
  });

  it('does NOT POST when freshness is null (requeue path), NULL id', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(null);
    dbState.createdAt = new Date().toISOString();
    const { posts } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(dbState.requeued).toEqual(['b1']);
    expect(dbState.checkRunIds.has('b1')).toBe(false);
  });

  it('does NOT POST when the installation no longer covers the repo (uncovered cancel)', async () => {
    dbState.installationCovered = false;
    const { posts } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(dbState.checkRunIds.has('b1')).toBe(false);
    expect(containerCalls.started).toBe(0);
  });

  it('does NOT POST when the row was cancelled after the claim (no check-run)', async () => {
    dbState.status.set('b1', 'cancelled');
    const { posts } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(dbState.checkRunIds.has('b1')).toBe(false);
  });

  it('SHA guard — does NOT POST when commitSha is empty (head_sha:"" would 422)', async () => {
    const { posts } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ commitSha: '' }));

    expect(posts).toHaveLength(0);
    expect(dbState.checkRunIds.has('b1')).toBe(false);
    expect(containerCalls.started).toBe(1);
  });

  it('create returns 500 (single-shot, no retry) → build still starts, id NULL, finalizers no-op', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { posts, patches } = installFetch({ createStatus: 500 });
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(1);
    expect(containerCalls.started).toBe(1);
    expect(dbState.checkRunIds.has('b1')).toBe(false);
    expect(ctx._kv.get('checkRunId')).toBeUndefined();

    dbState.writes = [];
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(patches).toHaveLength(0);

    const githubWarn = warnSpy.mock.calls.some((c) =>
      typeof c[0] === 'string' ? c[0].includes('"area":"github"') : false,
    );
    expect(githubWarn).toBe(true);
    warnSpy.mockRestore();
  });

  it('4xx on create → no retry (exactly one POST), id NULL', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { posts } = installFetch({ createStatus: 422 });
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(1);
    expect(dbState.checkRunIds.has('b1')).toBe(false);
    expect(containerCalls.started).toBe(1);
    warnSpy.mockRestore();
  });

  it('still caches the id in DO storage when the Postgres persist throws (best-effort)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dbState.setCheckRunIdThrows = true;
    const { posts } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(1);
    expect(containerCalls.started).toBe(1);
    expect(dbState.checkRunIds.has('b1')).toBe(false);
    expect(ctx._kv.get('checkRunId')).toBe(String(CHECK_RUN_ID));
    warnSpy.mockRestore();
  });
});

describe('BuildManager check-run lifecycle — finalize terminal sites', () => {
  it('onStop exit 0 → PATCH conclusion:success with the dashboard details_url', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.deployment = { id: 'dpl_1' };

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({
      status: 'completed',
      conclusion: 'success',
      details_url: 'https://my-app.buildwf.dev',
    });
  });

  it('onStop exit 1 → PATCH conclusion:failure, summary mentions the exit code', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await m.onStop({ exitCode: 1, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'failure' });
    const output = patches[0].body?.output as { summary?: string };
    expect(output.summary).toMatch(/1/);
  });

  it('onError → PATCH conclusion:failure', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await m.onError(new Error('boom'));

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ conclusion: 'failure' });
    const output = patches[0].body?.output as { summary?: string };
    expect(output.summary).toBe('boom');
  });

  it('enforceTimeout → PATCH conclusion:failure, summary "build timed out"', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await runDueSchedules(m);

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ conclusion: 'failure' });
    const output = patches[0].body?.output as { summary?: string };
    expect(output.summary).toBe('build timed out');
  });

  it('cancelBuild on an active row → PATCH conclusion:cancelled, summary == reason', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await m.cancelBuild('project disconnected');

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({
      conclusion: 'cancelled',
      details_url: 'https://my-app.buildwf.dev',
    });
    const output = patches[0].body?.output as { summary?: string };
    expect(output.summary).toBe('project disconnected');
  });

  it('cancelBuild on an already-terminal row → re-PATCH original conclusion', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(patches).toHaveLength(1);

    // Decision: A late cancel may be recovering an invocation lost after the PostgreSQL commit but before its check
    // PATCH, so it re-PATCHes the authoritative conclusion instead of the cancellation reason.
    await m.cancelBuild('project disconnected');
    expect(patches).toHaveLength(2);
    expect(patches[1].body).toMatchObject({ conclusion: 'success' });
    const output = patches[1].body?.output as { summary?: string };
    expect(output.summary).toBe('Build complete.');
  });

  it('PATCH returns 500 in onStop → build still finalized, scheduler poked, no throw', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { patches } = installFetch({ completeStatus: 500 });
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    schedulerGet(env).mockClear();

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(dbState.status.get('b1')).toBe('complete');
    expect(patches).toHaveLength(3);
    expect(schedulerGet(env)).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('BuildManager check-run lifecycle — startBuild failures after create', () => {
  it('startBuild throws AFTER create (non-capacity) → build failed via catch, one failure PATCH, no stranded in_progress', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    schedulerGet(env).mockClear();

    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockRejectedValueOnce(new Error('image pull failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow('image pull failed');
    expect(startSpy).toHaveBeenCalled();

    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ conclusion: 'failure' });
    const output = patches[0].body?.output as { summary?: string };
    expect(output.summary).toBe('image pull failed');

    expect(dbState.status.get('b1')).toBe('failed');
    expect(schedulerGet(env)).toHaveBeenCalled();

    startSpy.mockRestore();
  });

  it('startBuild catch still pokes the scheduler when the terminal write throws (finalize never perturbs)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { posts } = installFetch({ completeStatus: 500 });
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    schedulerGet(env).mockClear();

    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockRejectedValueOnce(new Error('image pull failed'));
    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('terminal write failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow();

    expect(posts).toHaveLength(1);
    expect(schedulerGet(env)).toHaveBeenCalled();
    startSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('capacity error after create then requeue → reuses the DO-stored id, exactly one POST total, no PATCH', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockRejectedValueOnce(
        new Error('there is no container instance that can be provided to this durable object'),
      );

    await expect(m.startBuild(makeConfig())).rejects.toThrow(/no container instance/);
    expect(startSpy).toHaveBeenCalled();

    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(0);
    expect(ctx._kv.get('checkRunId')).toBe(String(CHECK_RUN_ID));
    expect(dbState.status.get('b1')).toBe('starting');

    startSpy.mockRestore();

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(0);
    expect(containerCalls.started).toBe(1);
  });
});

describe('BuildManager check-run lifecycle — CAS-lost finalize (matches the DB outcome)', () => {
  // Decision: Force the out-of-band terminalization by setting the DB row terminal before the handler runs, so
  // `markBuildTerminalIfActive` CAS-no-ops. The DO's in-memory `config.status` is still 'starting', so
  // the local TERMINAL_STATUSES fast path doesn't short-circuit and the lost-CAS branch runs.
  it('onStop exit 0 but row cancelled out-of-band → PATCH conclusion:cancelled (not success)', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    dbState.status.set('b1', 'cancelled');

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    expect(dbState.status.get('b1')).toBe('cancelled');
  });

  it('onStop exit 0 but row failed out-of-band → PATCH conclusion:failure (not success)', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    dbState.status.set('b1', 'failed');

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(dbState.status.get('b1')).toBe('failed');
  });
});

describe('BuildManager check-run lifecycle — cancel during create (post-create recheck)', () => {
  // Decision: The createCheckRun fetch yields the DO input gate, so a cancel can land mid-POST. Model it with the
  // fetch stub: the create handler flips the row to 'cancelled', so the pre-create recheck still sees
  // 'starting' and the POST happens, but the post-create recheck sees 'cancelled'.
  it('cancel lands during create → exactly one cancelled PATCH, no container, no token', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && /\/check-runs$/.test(url)) {
        dbState.status.set('b1', 'cancelled');
      }
      return original(input, init);
    });

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    expect(containerCalls.started).toBe(0);
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
  });
});

describe('BuildManager check-run lifecycle — best-effort DO-storage cache', () => {
  it('storage.put rejection for the check-run key does not fail the build', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { posts } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    schedulerGet(env).mockClear();

    const realPut = ctx.storage.put.getMockImplementation()!;
    let rejected = false;
    ctx.storage.put.mockImplementation(async (k: string, v: unknown) => {
      if (k === 'checkRunId' && !rejected) {
        rejected = true;
        throw new Error('DO storage put failed');
      }
      return realPut(k, v);
    });

    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(1);
    expect(rejected).toBe(true);
    expect(containerCalls.started).toBe(1);
    expect(ctx._kv.get('checkRunId')).toBeUndefined();
    expect(dbState.status.get('b1')).toBe('building');
    expect(dbState.checkRunIds.get('b1')).toBe(String(CHECK_RUN_ID));
    warnSpy.mockRestore();
  });
});

describe('BuildManager check-run lifecycle — redelivery (single build, single POST)', () => {
  it('a redelivered start on the same DO reuses the id → one POST total', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());
    expect(posts).toHaveLength(1);

    dbState.status.set('b1', 'starting');
    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(0);
  });
});

describe('BuildManager check-run lifecycle — finalize hardening (DO-miss fallback + lost-CAS throw)', () => {
  it('onStop exit 0 with the DO-storage id missing → finalize recovers it from builds.check_run_id, one success PATCH', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();

    const realPut = ctx.storage.put.getMockImplementation()!;
    let rejected = false;
    ctx.storage.put.mockImplementation(async (k: string, v: unknown) => {
      if (k === 'checkRunId' && !rejected) {
        rejected = true;
        throw new Error('DO storage put failed');
      }
      return realPut(k, v);
    });

    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    expect(rejected).toBe(true);
    expect(ctx._kv.get('checkRunId')).toBeUndefined();
    expect(dbState.checkRunIds.get('b1')).toBe(String(CHECK_RUN_ID));
    expect(containerCalls.started).toBe(1);

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(dbState.status.get('b1')).toBe('complete');
    warnSpy.mockRestore();
  });

  it('lost-CAS finalize getBuild throw is swallowed → onStop resolves, scheduler poked, no PATCH', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Decision: startBuild makes its own getBuild calls (the pre-start cancellation recheck); run it first so the
    // throw below hits only the finalize-path getBuild.
    await m.startBuild(makeConfig());

    dbState.status.set('b1', 'failed');

    // Decision: onStop's exit-0 path makes no other getBuild call (the deployment lookup is a separate mock), so
    // this rejection hits only the read inside finalizeCheckRunToRecordedOutcome.
    vi.mocked(getBuild).mockRejectedValueOnce(new Error('hyperdrive read failed'));

    schedulerGet(env).mockClear();

    await expect(m.onStop({ exitCode: 0, reason: 'exit' })).resolves.toBeUndefined();

    expect(schedulerGet(env)).toHaveBeenCalled();
    expect(patches).toHaveLength(0);
    expect(dbState.status.get('b1')).toBe('failed');
    warnSpy.mockRestore();
  });
});

describe('BuildManager check-run lifecycle — requeue/create-cancel id reuse', () => {
  // Decision: Model the requeue's starting state: seed `dbState.checkRunIds` (Postgres has the id from the first
  // run) while DO storage stays empty, as on a fresh DO.
  it('requeue with DO storage empty but builds.check_run_id set → reuses the persisted id, no second POST', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));
    expect(ctx._kv.get('checkRunId')).toBeUndefined();

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(0);
    expect(containerCalls.started).toBe(1);
    expect(dbState.status.get('b1')).toBe('building');

    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'success' });
  });

  it('cancel during create with BOTH persists failing → finalizes via the in-hand id, exactly one cancelled PATCH', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();

    const realPut = ctx.storage.put.getMockImplementation()!;
    let putRejected = false;
    ctx.storage.put.mockImplementation(async (k: string, v: unknown) => {
      if (k === 'checkRunId' && !putRejected) {
        putRejected = true;
        throw new Error('DO storage put failed');
      }
      return realPut(k, v);
    });
    dbState.setCheckRunIdThrows = true;

    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && /\/check-runs$/.test(url)) {
        dbState.status.set('b1', 'cancelled');
      }
      return original(input, init);
    });

    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    expect(containerCalls.started).toBe(0);
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(putRejected).toBe(true);
    expect(ctx._kv.get('checkRunId')).toBeUndefined();
    expect(dbState.checkRunIds.get('b1')).toBeUndefined();
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
    warnSpy.mockRestore();
  });
});

describe('BuildManager check-run lifecycle — dual persist fail, build continues', () => {
  it('build runs to completion → terminal finalize recovers the id from the in-memory field', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();

    const realPut = ctx.storage.put.getMockImplementation()!;
    let putRejected = false;
    ctx.storage.put.mockImplementation(async (k: string, v: unknown) => {
      if (k === 'checkRunId' && !putRejected) {
        putRejected = true;
        throw new Error('DO storage put failed');
      }
      return realPut(k, v);
    });
    dbState.setCheckRunIdThrows = true;

    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(1);
    expect(containerCalls.started).toBe(1);
    expect(putRejected).toBe(true);
    expect(ctx._kv.get('checkRunId')).toBeUndefined();
    expect(dbState.checkRunIds.get('b1')).toBeUndefined();
    expect(patches).toHaveLength(0);

    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'success' });
    warnSpy.mockRestore();
  });
});

describe('BuildManager check-run lifecycle — pre-start terminalize finalizes a PRIOR run', () => {
  it('requeue cancel-recheck finalizes the prior run → no create POST, one cancelled PATCH', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));
    // Decision: Freshness ('identical') and coverage (true) keep their defaults so the earlier pre-start gates
    // pass and the cancellation recheck is what fires.
    dbState.status.set('b1', 'cancelled');

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    expect(containerCalls.started).toBe(0);
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
  });

  it('non-identical head finalizes the prior run → no create POST, one cancelled PATCH', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce('behind');
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));

    await m.startBuild(makeConfig());

    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    expect(containerCalls.started).toBe(0);
  });

  it('first-attempt terminalize does NOT PATCH (nothing to finalize)', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce('behind');
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    expect(dbState.checkRunIds.has('b1')).toBe(false);
    expect(ctx._kv.get('checkRunId')).toBeUndefined();

    await m.startBuild(makeConfig());

    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });
});

describe('BuildManager check-run lifecycle — pre-start finalize is CAS-aware', () => {
  it('aged-out freshness, row cancelled out-of-band → PATCH cancelled (not the hardcoded failure)', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(null);
    dbState.createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));
    dbState.status.set('b1', 'cancelled');
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(containerCalls.started).toBe(0);
  });

  it('non-identical head, row failed out-of-band → PATCH failure (not the hardcoded cancelled)', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce('behind');
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));
    dbState.status.set('b1', 'failed');
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(dbState.status.get('b1')).toBe('failed');
    expect(containerCalls.started).toBe(0);
  });

  it('uncovered repo, row failed out-of-band → PATCH failure (not the hardcoded cancelled)', async () => {
    dbState.installationCovered = false;
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));
    dbState.status.set('b1', 'failed');
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(dbState.status.get('b1')).toBe('failed');
    expect(containerCalls.started).toBe(0);
  });

  it('aged-out freshness wins the CAS → PATCH failure (the aged-out conclusion)', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(null);
    dbState.createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(dbState.status.get('b1')).toBe('failed');
  });

  it('uncovered repo wins the CAS → PATCH cancelled (the uncovered conclusion)', async () => {
    dbState.installationCovered = false;
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    expect(dbState.status.get('b1')).toBe('cancelled');
  });
});

describe('BuildManager check-run lifecycle — details_url is env-aware (SITE_DOMAIN)', () => {
  it('staging SITE_DOMAIN → create + finalize link to {slug}.staging.buildwf.dev', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    env.SITE_DOMAIN = 'staging.buildwf.dev';
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ details_url: 'https://my-app.staging.buildwf.dev' });

    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ details_url: 'https://my-app.staging.buildwf.dev' });
  });

  it('unset SITE_DOMAIN → falls back to the production {slug}.buildwf.dev', async () => {
    const { posts } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ details_url: 'https://my-app.buildwf.dev' });
  });

  it('staging SITE_DOMAIN → finalizeCheckRunToStatus PATCH links to the staging domain', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce('behind');
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    env.SITE_DOMAIN = 'staging.buildwf.dev';
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({
      status: 'completed',
      conclusion: 'cancelled',
      details_url: 'https://my-app.staging.buildwf.dev',
    });
  });
});
