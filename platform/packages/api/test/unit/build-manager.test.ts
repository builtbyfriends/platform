import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderCapturedLog } from './log-tail-helpers.ts';

// Decision: A minimal stub of the `@cloudflare/containers` Container base class: ctx/env wiring plus
// `start`/`stop`/`fetch`.
//
// The real base Container owns the single DO alarm for its monitor loop and onStop dispatch. The
// manager doesn't override `alarm()`. It arms the timeout with the base `schedule(seconds,
// methodName)` API, and the base alarm loop calls that method when due. The stub records
// scheduled callbacks, and `_runDueSchedules()` calls them as the base alarm loop would.
const containerCalls = {
  started: 0,
  stopped: 0,
  destroyed: 0,
  baseAlarms: 0,
};
type ScheduledTask = { whenSeconds: number; callback: string };

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock('@cloudflare/containers', () => ({
  Container: class {
    ctx: unknown;
    env: unknown;
    envVars: Record<string, string> = {};
    defaultPort?: number;
    enableInternet?: boolean;
    sleepAfter?: string | number;
    _schedules: Array<ScheduledTask> = [];
    // Decision: Tracks whether the container was launched. The base `start()` launches the container and only
    // then runs onStart, so an onStart reject after launch leaves a live container, modeled by this
    // flag staying true after start() rejects.
    _containerRunning = false;
    // Decision: `init` is forwarded, not dropped, so a test can assert the abort signal that timeboxes each pull.
    _portFetch: ((url: string, port: number, init?: RequestInit) => Promise<Response>) | null =
      null;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    // Decision: `getTcpPort().fetch()` is the non-starting port fetch. It doesn't auto-start, because the real
    // raw port fetch fails (instead of starting) when the container is down.
    get container() {
      return {
        running: this._containerRunning,
        getTcpPort: (port: number) => ({
          fetch: (url: string, init?: RequestInit) => {
            if (!this._portFetch) {
              throw new Error('container port fetch not stubbed');
            }
            return this._portFetch(url, port, init);
          },
        }),
      };
    }
    // Decision: Models the base `start()`: it launches the container and then runs onStart inside
    // `ctx.blockConcurrencyWhile` before start() resolves. An onStart throw rejects start() while the
    // container is already running, which lets tests tell a failure before launch (capacity, token mint)
    // from an onStart reject after launch.
    async start(): Promise<void> {
      containerCalls.started += 1;
      this._containerRunning = true;
      await (this as unknown as { onStart(): Promise<void> }).onStart();
    }
    async stop(): Promise<void> {
      containerCalls.stopped += 1;
      this._containerRunning = false;
    }
    // Decision: The real base only sends SIGTERM in stop(). destroy() is the only SIGKILL, and it's what kills a
    // container that ignores SIGTERM.
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
  // Decision: Authoritative per-build DB status, so the CAS helpers model the real `UPDATE ... WHERE status = ?`
  // guard: a write that doesn't match is a no-op (no write recorded, returns false), as in Postgres.
  status: new Map<string, string>(),
  deployment: null as { id: string } | null,
  createdAt: new Date().toISOString(),
  requeued: [] as Array<string>,
  installationCovered: true,
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
      dbState.writes.push({ id, status: 'building', opts: opts as StatusWrite['opts'] });
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
  // Decision: Models the real `UPDATE ... WHERE status IN (active)` guard: a forged or late progress report
  // against a row a concurrent terminalizer already finished is a no-op (no write, returns false).
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
    return { id, created_at: dbState.createdAt, status };
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
      connectionId: string | undefined,
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
}));

// Decision: vi.mock is hoisted, so the mock is declared inline in the factory and can't close over an outer
// variable. Tests read its call args later with `vi.mocked(signDeployToken)`.
vi.mock('../../src/auth/deploy-token.ts', () => ({
  signDeployToken: vi.fn(
    async (
      _ident: { projectId: string; userId: string; login: string; buildId?: string },
      _secret: string,
      _opts?: { ttlSeconds?: number },
    ) => 'deploy-token',
  ),
  // Decision: Mirrors the real constant, so the timeout cap that's always armed holds.
  DEPLOY_TOKEN_HARD_MAX_MINUTES: 60,
  // Decision: Mirrors the pure TTL formula in deploy-token.ts, so the sizing assertions hold.
  deployTokenTtlSecondsForBuildMinutes: (timeoutMinutes: number) => {
    const buildMinutes = timeoutMinutes > 0 ? timeoutMinutes : Infinity;
    const cappedMinutes = Math.min(buildMinutes, 60);
    return cappedMinutes * 60 + 5 * 60;
  },
}));
vi.mock('../../src/github/installation-token.ts', () => ({
  // Decision: The module is mocked whole, but the log-tail suite routes completeCheckRun to the real
  // implementation, which builds its PATCH URL and version header from these.
  GITHUB_API_BASE: 'https://api.github.com',
  GITHUB_API_VERSION: '2026-03-10',
  getInstallationToken: vi.fn(async () => 'install-token'),
  generateSourceTarballUrl: vi.fn(
    (repo: string, sha: string) => `https://api.github.com/repos/${repo}/tarball/${sha}`,
  ),
  getBranchHeadComparisonStatus: vi.fn(async () => 'identical'),
}));
// Decision: Partial mock: stub the two network calls and keep the rest real, so startBuild's check-run create
// makes no outbound `fetch` here. `PLATFORM_BUILD_CHECK_RUN_NAME` stays real: a second spelling
// here could drift from the name `check_run:rerequested` matches on, and that name is what makes
// GitHub's "Re-run" button work. The real wiring is covered by
// test/integration/api-check-runs.test.ts.
vi.mock('../../src/github/check-run.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/github/check-run.ts')>()),
  createCheckRun: vi.fn(async () => null),
  completeCheckRun: vi.fn(async () => false),
}));

// eslint-disable-next-line import/no-relative-packages -- intentional cross-package contract reference
import bwfPackageJson from '../../../../../packages/bwf/package.json' with { type: 'json' };
// Decision: Importing the .mjs only pulls in its exported helpers: the entrypoint guard keeps `main()` from
// starting the control server on import. Types come from the sibling build-agent.d.mts.
import {
  BUILDER_GID,
  BUILDER_HOME,
  BUILDER_UID,
  builderCacheEnv,
  childSpawnOptions,
  DEFAULT_PLATFORM_CLI_VERSION,
  clearBufferedLogLines,
  closeControlServer,
  getAckedLogSeq,
  getBufferedLogLines,
  getPendingLogLineCount,
  getServedLogSeq,
  installShutdownHandlers,
  LOG_DRAIN_ABSOLUTE_TIMEOUT_MS,
  LOG_DRAIN_IDLE_TIMEOUT_MS,
  MAX_BUFFERED_LOG_BYTES,
  MAX_BUFFERED_LOG_LINES,
  MAX_PARTIAL_LINE_CHARS,
  MAX_LOG_RESPONSE_BYTES,
  MAX_LOG_RESPONSE_LINES,
  MAX_PENDING_LOG_LINES,
  nonInteractiveEnv,
  parseProcStatusUid,
  pipeStream,
  record,
  runBuild,
  SCRUBBED_ENV_VARS,
  sanitizeChildEnv,
  startControlServer,
  waitForLogDrain,
} from '../../container/build-agent.mjs';
import { signDeployToken } from '../../src/auth/deploy-token.ts';
import {
  BuildManager,
  CHECK_RUN_LOG_TAIL_LINES,
  CHECK_RUN_LOG_TAIL_MAX_BYTES,
  CHECK_RUN_OUTPUT_TEXT_MAX_BYTES,
  formatLogTailMarkdown,
  LOG_DRAIN_BUDGET_MS,
  LOG_DRAIN_GRACE_SECONDS,
  LOG_PULL_TIMEOUT_MS,
  LOG_SINK_OP_PAYLOAD_BYTES,
  LOG_TERMINAL_DRAIN_RETRY_WINDOW_MS,
  MAX_LOG_PULL_PAGES,
  MAX_LOG_SINK_OPS_PER_DRAIN,
  MAX_STORED_LOG_LINES,
  PINNED_PLATFORM_CLI_VERSION,
  TERMINAL_RENDER_COLUMNS,
  TERMINAL_RENDER_MAX_INPUT_CODE_UNITS,
  TERMINAL_RENDER_MAX_PARAMETER_WORK,
  TERMINAL_RENDER_MAX_REPEAT_CODE_UNITS,
  TERMINAL_TAIL_MAX_INPUT_CODE_UNITS,
  TERMINAL_WRITE_TIMEOUT_MS,
} from '../../src/build-manager.ts';
import type { BuildConfig } from '../../src/build-types.ts';
import {
  getBuild,
  getDeploymentByProjectAndCommit,
  installationCoversRepo,
  markBuildBuildingIfStarting,
  markBuildTerminalIfActive,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { completeCheckRun } from '../../src/github/check-run.ts';
import {
  getBranchHeadComparisonStatus,
  getInstallationToken,
} from '../../src/github/installation-token.ts';

type LogRow = {
  seq: number;
  line: string;
  stream: string;
  ts: number;
  lineEnding?: 'cr' | 'lf' | 'crlf' | 'none' | null;
};

function makeStubCtx(options: { legacyLogSchema?: boolean; initialLogs?: Array<LogRow> } = {}) {
  const kv = new Map<string, unknown>();
  let alarmTime: number | null = null;
  const logs: Array<LogRow> = options.initialLogs?.map((row) => ({ ...row })) ?? [];
  let seq = logs.reduce((max, row) => Math.max(max, row.seq), 0);
  let hasLineEndingColumn = !options.legacyLogSchema;
  const sqlQueries: Array<string> = [];
  const sockets: Array<FakeWebSocket> = [];

  const sql = {
    exec(query: string, ...bindings: Array<unknown>) {
      sqlQueries.push(query);
      if (query.startsWith('CREATE TABLE')) {
        return { toArray: () => [] };
      }
      if (query.startsWith('PRAGMA table_info')) {
        return {
          toArray: () => [
            { name: 'seq' },
            { name: 'line' },
            { name: 'stream' },
            { name: 'ts' },
            ...(hasLineEndingColumn ? [{ name: 'line_ending' }] : []),
          ],
        };
      }
      if (query.startsWith('ALTER TABLE logs ADD COLUMN line_ending')) {
        hasLineEndingColumn = true;
        for (const row of logs) {
          row.lineEnding ??= null;
        }
        return { toArray: () => [] };
      }
      if (query.startsWith('INSERT INTO logs')) {
        seq += 1;
        logs.push({
          seq,
          line: bindings[0] as string,
          stream: bindings[1] as string,
          ts: bindings[2] as number,
          lineEnding: bindings[3] as LogRow['lineEnding'],
        });
        return { toArray: () => [] };
      }
      if (query.startsWith('DELETE FROM logs')) {
        // Decision: Model the cap's DELETE, keeping only the newest N rows by seq. Without it the cap would no-op in
        // tests (see the rowCount/PGlite lesson).
        const keep = bindings[0] as number;
        if (logs.length > 0) {
          const maxSeq = logs.reduce((m, r) => (r.seq > m ? r.seq : m), 0);
          const threshold = maxSeq - keep;
          for (let i = logs.length - 1; i >= 0; i--) {
            if (logs[i].seq <= threshold) {
              logs.splice(i, 1);
            }
          }
        }
        return { toArray: () => [] };
      }
      if (query.startsWith('SELECT MAX(seq)')) {
        const max = logs.length > 0 ? logs.reduce((m, r) => (r.seq > m ? r.seq : m), 0) : null;
        return { toArray: () => [{ max }] };
      }
      if (query.startsWith('SELECT COUNT(*)')) {
        return { toArray: () => [{ count: logs.length }] };
      }
      if (query.startsWith('SELECT line, line_ending AS lineEnding')) {
        // Decision: Match the check-run log tail query before the generic SELECT branch, which would misread the
        // LIMIT binding as a `seq > ?` bound.
        const limit = bindings[0] as number;
        return {
          toArray: () =>
            logs
              .slice()
              .sort((a, b) => b.seq - a.seq)
              .slice(0, limit)
              .map((r) => ({ line: r.line, lineEnding: r.lineEnding ?? null })),
        };
      }
      if (query.startsWith('SELECT')) {
        // Decision: Honor a `WHERE seq > ?` bound when present (the GET /logs poll read). Without it the filter would
        // no-op in tests. The WS-replay SELECT has no binding, so every row passes.
        const since = bindings.length > 0 ? (bindings[0] as number) : Number.NEGATIVE_INFINITY;
        return {
          toArray: () =>
            logs
              .slice()
              .sort((a, b) => a.seq - b.seq)
              .filter((r) => r.seq > since)
              .map(({ seq, line, stream, ts }) => ({ seq, line, stream, ts })),
        };
      }
      return { toArray: () => [] };
    },
  };

  return {
    _logs: logs,
    _sockets: sockets,
    _kv: kv,
    _sqlQueries: sqlQueries,
    storage: {
      sql,
      get: vi.fn(async (k: string) => kv.get(k)),
      put: vi.fn(async (k: string, v: unknown) => {
        kv.set(k, v);
      }),
      getAlarm: vi.fn(async () => alarmTime),
      setAlarm: vi.fn(async (t: number) => {
        alarmTime = t;
      }),
      deleteAlarm: vi.fn(async () => {
        alarmTime = null;
      }),
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
    commitSha: 'sha1',
    branch: 'main',
    repoFullName: 'owner/repo',
    installationId: 'inst1',
    connectionId: 'connection-1',
    repositoryId: 'repo1',
    instanceType: 'standard-1',
    timeoutMinutes: 10,
    ...overrides,
  };
}

function makeManager(ctx: ReturnType<typeof makeStubCtx>, env: ApiEnv['Bindings']) {
  return new BuildManager(ctx as unknown as ConstructorParameters<typeof BuildManager>[0], env);
}

function scheduledTasks(m: BuildManager): Array<ScheduledTask> {
  return (m as unknown as { _schedules: Array<ScheduledTask> })._schedules;
}

async function runDueSchedules(m: BuildManager): Promise<void> {
  await (m as unknown as { _runDueSchedules: () => Promise<void> })._runDueSchedules();
}

function lastWrite(status: string): StatusWrite | undefined {
  return [...dbState.writes].reverse().find((w) => w.status === status);
}

function agentToken(ctx: ReturnType<typeof makeStubCtx>): string {
  return ctx._kv.get('agentToken') as string;
}

function agentRequest(
  ctx: ReturnType<typeof makeStubCtx>,
  url: string,
  init: RequestInit = {},
): Request {
  return new Request(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${agentToken(ctx)}` },
  });
}

class FakeWebSocketPair {
  0 = new FakeWebSocket();
  1 = new FakeWebSocket();
}

// Decision: The Workers runtime accepts `new Response(null, { status: 101, webSocket })` for upgrades, but
// the Node/undici `Response` in unit tests rejects status 101. This lenient Response lets the real
// upgrade path run here.
class FakeUpgradeResponse {
  status: number;
  webSocket: unknown;
  constructor(_body: unknown, init?: { status?: number; webSocket?: unknown }) {
    this.status = init?.status ?? 200;
    this.webSocket = init?.webSocket;
  }
}
const RealResponse = globalThis.Response;

beforeEach(() => {
  dbState.writes = [];
  // Decision: The scheduler's claim (`claimBuildForStartWithinLimit`) flips the row `queued -> starting` before
  // calling startBuild, so the row is already `starting` when the DO runs.
  dbState.status = new Map<string, string>([['b1', 'starting']]);
  dbState.deployment = null;
  dbState.createdAt = new Date().toISOString();
  dbState.requeued = [];
  dbState.installationCovered = true;
  containerCalls.started = 0;
  containerCalls.stopped = 0;
  containerCalls.destroyed = 0;
  containerCalls.baseAlarms = 0;
  vi.clearAllMocks();
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = FakeWebSocketPair;
  (globalThis as unknown as { Response: unknown }).Response = new Proxy(RealResponse, {
    construct(target, args) {
      const init = args[1] as { status?: number } | undefined;
      if (init?.status === 101) {
        return new FakeUpgradeResponse(args[0], init as { webSocket?: unknown });
      }
      return Reflect.construct(target, args, target);
    },
    get(target, prop, receiver) {
      return Reflect.get(target, prop, receiver);
    },
  });
});

afterEach(() => {
  (globalThis as unknown as { Response: unknown }).Response = RealResponse;
});

describe('BuildManager.startBuild', () => {
  it('persists config, sets env vars, starts the container, arms timeout — and does NOT write starting', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(containerCalls.started).toBe(1);
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    expect(envVars.BUILD_ID).toBe('b1');
    expect(envVars.PROJECT_ID).toBe('p1');
    expect(envVars.PROJECT_SLUG).toBe('my-app');
    expect(envVars.BWF_PROJECT).toBe('my-app');
    expect(envVars.BWF_TOKEN).toBe('deploy-token');
    expect(envVars.SOURCE_TOKEN).toBe('install-token');
    expect(envVars.SOURCE_TARBALL_URL).toBe('https://api.github.com/repos/owner/repo/tarball/sha1');
    expect(envVars.BWF_API_URL).toBe('https://platform.buildwithfriends.dev');
    // Decision: The fallback bwf CLI version is pinned (not `latest`), so a moving npm dist-tag can't change
    // deploy behavior with no repo diff.
    expect(envVars.BWF_CLI_VERSION).toBeDefined();
    expect(envVars.BWF_CLI_VERSION).not.toBe('latest');
    expect(envVars.BWF_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(envVars.DO_LOG_URL).toBe('https://manager/logs');
    // Decision: Commit metadata is forwarded so `bwf deploy` stamps the deployment's commit (the tarball has no
    // `.git`; the CLI reads GITHUB_SHA first). Without it the deployment records a NULL commit and
    // onStop can't link the build.
    expect(envVars.GITHUB_SHA).toBe('sha1');
    expect(envVars.GITHUB_REPOSITORY).toBe('owner/repo');
    expect(envVars.GITHUB_REF).toBe('refs/heads/main');
    // Decision: The base Container owns the single DO alarm for its monitor and onStop loop, so the manager arms
    // the timeout through the base scheduler and doesn't write the alarm directly.
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
    expect(scheduledTasks(m)).toEqual([
      { whenSeconds: 1, callback: 'pollLogs' },
      { whenSeconds: 10 * 60 + LOG_DRAIN_GRACE_SECONDS, callback: 'enforceTimeout' },
    ]);
    const ident = vi.mocked(signDeployToken).mock.calls[0]?.[0];
    expect(ident?.buildId).toBe('b1');
    expect(ident?.projectId).toBe('p1');
    // Decision: startBuild doesn't write `starting`: the scheduler's claim already set it. A redundant write after
    // start could downgrade a row that a fast onStart or onStop already moved on, stranding it and
    // leaking a concurrency slot.
    expect(dbState.writes.some((w) => w.status === 'starting')).toBe(false);
    // Decision: onStart's `starting -> building` CAS runs inside the base `start()` and is the only place the
    // instance_type is saved (the claim flips status without it).
    expect(lastWrite('building')?.opts?.instanceType).toBe('standard-1');
  });

  it('uses the staging API URL when PLATFORM_ENV=staging', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    Object.assign(env as object, {
      PLATFORM_ENV: 'staging',
      CF_ACCESS_CLIENT_ID_STAGING: 'svc-id.access',
      CF_ACCESS_CLIENT_SECRET_STAGING: 'svc-secret',
    });
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    expect(envVars.BWF_API_URL).toBe('https://api.staging.void.cloud');
  });

  it('forwards the staging CF Access service token into the container (staging hosts are Access-gated)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    Object.assign(env as object, {
      PLATFORM_ENV: 'staging',
      CF_ACCESS_CLIENT_ID_STAGING: 'svc-id.access',
      CF_ACCESS_CLIENT_SECRET_STAGING: 'svc-secret',
      PROXY_URL: 'https://proxy.staging.void.cloud',
    });
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    // Decision: The CLI reads the names without a suffix. The worker holds the *_STAGING secrets.
    expect(envVars.CF_ACCESS_CLIENT_ID).toBe('svc-id.access');
    expect(envVars.CF_ACCESS_CLIENT_SECRET).toBe('svc-secret');
    expect(envVars.PLATFORM_PROXY_URL).toBe('https://proxy.staging.void.cloud');
  });

  it('does NOT forward CF Access creds on production builds (platform.buildwithfriends.dev is not Access-gated)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    Object.assign(env as object, {
      PLATFORM_ENV: undefined,
      CF_ACCESS_CLIENT_ID_STAGING: 'svc-id.access',
      CF_ACCESS_CLIENT_SECRET_STAGING: 'svc-secret',
    });
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    expect(envVars.CF_ACCESS_CLIENT_ID).toBeUndefined();
    expect(envVars.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
  });

  it('fails fast (does NOT start) on staging when the service token is unconfigured', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    (env as unknown as { PLATFORM_ENV?: string }).PLATFORM_ENV = 'staging';
    const m = makeManager(ctx, env);
    // Decision: Staging is Access-gated and the container can't authenticate without the service token, so a
    // staging worker without it is a misconfiguration. Fail the build up front instead of using a slot
    // to fail at the Access edge.
    await expect(m.startBuild(makeConfig())).rejects.toThrow(/staging build misconfigured/);
    expect(containerCalls.started).toBe(0);
    const failed = lastWrite('failed');
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toMatch(/CF_ACCESS_CLIENT_ID_STAGING/);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('fails fast on staging when the service token is half-configured (id without secret)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    Object.assign(env as object, {
      PLATFORM_ENV: 'staging',
      CF_ACCESS_CLIENT_ID_STAGING: 'svc-id.access',
      // Decision: A half pair is as broken as none (cfAccessHeaders needs both).
    });
    const m = makeManager(ctx, env);
    await expect(m.startBuild(makeConfig())).rejects.toThrow(/staging build misconfigured/);
    expect(containerCalls.started).toBe(0);
    expect(lastWrite('failed')?.id).toBe('b1');
  });

  it('arms the hard-max timeout when timeoutMinutes is 0 (unlimited)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig({ timeoutMinutes: 0 }));
    // Decision: Even an "unlimited" custom plan gets a hard ceiling: the base `sleepAfter` idle stop doesn't fire
    // for a busy container, so an orphaned build could run without bound. It falls back to
    // DEPLOY_TOKEN_HARD_MAX_MINUTES (60).
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
    expect(scheduledTasks(m)).toContainEqual({
      whenSeconds: 60 * 60 + LOG_DRAIN_GRACE_SECONDS,
      callback: 'enforceTimeout',
    });
  });

  it('caps the timeout at the hard max when timeoutMinutes exceeds it', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig({ timeoutMinutes: 120 }));
    expect(scheduledTasks(m)).toContainEqual({
      whenSeconds: 60 * 60 + LOG_DRAIN_GRACE_SECONDS,
      callback: 'enforceTimeout',
    });
  });

  // Decision: The deploy token is minted before download, install and deploy, so its TTL has to cover the whole
  // build (plan timeout plus margin).
  it('sizes the deploy token TTL to the plan build timeout + margin', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ timeoutMinutes: 20 }));

    const opts = vi.mocked(signDeployToken).mock.calls[0]?.[2];
    expect(opts?.ttlSeconds).toBe(20 * 60 + 5 * 60);
    expect(opts?.ttlSeconds).toBeGreaterThan(15 * 60);
  });

  // Decision: The plan budget bounds build execution. The agent's exit-time drain barrier runs after that, with
  // the container still `running` and the DO status still `deploying`, since the agent can't report a
  // terminal status. An `enforceTimeout` due inside the barrier would win its CAS and overwrite a
  // successful live deploy with 'build timed out'.
  it('arms the wall-clock timeout PAST the build budget, so the agent drain cannot trip it', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ timeoutMinutes: 10 }));

    // Decision: Assert the slack, not the literal, so the relation survives a retune of either constant.
    const armed = scheduledTasks(m).find((t) => t.callback === 'enforceTimeout');
    expect(armed?.whenSeconds).toBeGreaterThanOrEqual(
      10 * 60 + LOG_DRAIN_ABSOLUTE_TIMEOUT_MS / 1000,
    );
  });

  it('keeps the drain grace inside the deploy token TTL — a build still cannot outlive its token', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ timeoutMinutes: 10 }));

    // Decision: Read the TTL from the spy instead of importing DEPLOY_TOKEN_MARGIN_SECONDS, which the deploy-token
    // mock doesn't re-export (it would be undefined).
    const armed = scheduledTasks(m).find((t) => t.callback === 'enforceTimeout');
    const ttlSeconds = vi.mocked(signDeployToken).mock.calls[0]?.[2]?.ttlSeconds;
    expect(ttlSeconds).toBeGreaterThan(0);
    expect(armed?.whenSeconds).toBeLessThan(ttlSeconds ?? 0);
  });

  it('grants enough grace to cover the agent drain barrier — two processes, one relation, so a test holds it', () => {
    // Decision: `container/build-agent.mjs` is plain JS copied into the image and can't import from `src/`, so the
    // DO's grace and the agent's barrier deadline are separate literals. Use `>=`, not `===`: the grace
    // also covers the final closeControlServer after the barrier.
    expect(LOG_DRAIN_GRACE_SECONDS * 1000).toBeGreaterThanOrEqual(
      LOG_DRAIN_ABSOLUTE_TIMEOUT_MS + 5000,
    );
  });

  it('keeps the agent alive past one full paginated drain and its acknowledgement tick', () => {
    // Decision: Worst case starts just after a poll: one second to the next callback, up to LOG_DRAIN_BUDGET_MS
    // inside it, then one second until a follow-up request can acknowledge the cursor. Equality leaves
    // no slack and lets the agent close on the boundary.
    expect(LOG_DRAIN_IDLE_TIMEOUT_MS).toBeGreaterThan(LOG_DRAIN_BUDGET_MS + 2000);
    expect(LOG_DRAIN_ABSOLUTE_TIMEOUT_MS).toBeGreaterThan(
      MAX_LOG_PULL_PAGES * (LOG_PULL_TIMEOUT_MS + 1000),
    );
    expect(LOG_TERMINAL_DRAIN_RETRY_WINDOW_MS + 1000).toBeLessThanOrEqual(
      LOG_DRAIN_IDLE_TIMEOUT_MS,
    );
  });

  it('caps the deploy token TTL at the hard max for unlimited (timeoutMinutes=0) builds', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ timeoutMinutes: 0 }));

    const opts = vi.mocked(signDeployToken).mock.calls[0]?.[2];
    expect(opts?.ttlSeconds).toBe(60 * 60 + 5 * 60);
  });

  it('fails the build (freeing the concurrency slot) when start-up throws before the timeout alarm is armed', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Decision: onError and onStop don't fire here (the container isn't running yet), so startBuild itself has to
    // fail the row and free the slot, or it stays `starting`.
    vi.mocked(getInstallationToken).mockRejectedValueOnce(new Error('token mint failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow('token mint failed');

    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toBe('token mint failed');

    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();

    const activeWrite = dbState.writes.find((w) =>
      ['starting', 'building', 'deploying'].includes(w.status),
    );
    expect(activeWrite).toBeUndefined();

    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
  });

  // Decision: A failure after this.start() succeeded has to stop the running container before finalizing.
  // Otherwise it keeps running `bwf deploy` with a live token and can publish while Postgres records
  // the build as `failed`.
  it('stops the container when a step AFTER start() throws, then still fails + pokes', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    const scheduleSpy = vi
      .spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule')
      .mockRejectedValueOnce(new Error('postgres write failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow('postgres write failed');
    expect(scheduleSpy).toHaveBeenCalled();

    expect(containerCalls.started).toBe(1);
    expect(containerCalls.stopped).toBe(1);

    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toBe('postgres write failed');

    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();

    scheduleSpy.mockRestore();
  });

  // Decision: If the terminal Postgres write in the startBuild catch hits a transient outage, pokeScheduler
  // still fires (it's in a `finally`) so the queue scan re-arms. Otherwise the row is stranded
  // `starting` and pins the user's slot until the stale reaper.
  it('still pokes the scheduler when the terminal write throws in the startBuild catch (slot-safe)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    const scheduleSpy = vi
      .spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule')
      .mockRejectedValueOnce(new Error('postgres write failed'));
    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('terminal write failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow();

    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();

    scheduleSpy.mockRestore();
  });

  // Decision: `builds.status` is the deploy token's authority, and the teardown drains logs for up to
  // 2x LOG_DRAIN_BUDGET_MS before it signals. While the row is still `starting`/`building`, a runner at
  // final publish passes `middleware/auth.ts` and the go-live re-check and ships, though this manager
  // has already decided startup failed. So the row is revoked before the drain.
  it('revokes the build row BEFORE draining logs in the startBuild catch', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    const order: Array<string> = [];
    vi.mocked(markBuildTerminalIfActive).mockImplementationOnce(async () => {
      order.push('revoke');
      return true;
    });
    const scheduleSpy = vi
      .spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule')
      .mockRejectedValueOnce(new Error('schedule arming failed'));
    const fetchFn = vi.fn(async () => {
      order.push('drain');
      return new RealResponse(JSON.stringify({ lines: [], lastSeq: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    await expect(m.startBuild(makeConfig())).rejects.toThrow('schedule arming failed');

    expect(order).toEqual(['revoke', 'drain']);

    scheduleSpy.mockRestore();
  });

  it('does not let a stop() failure mask the original post-start error', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    const scheduleSpy = vi
      .spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule')
      .mockRejectedValueOnce(new Error('postgres write failed'));
    const stopSpy = vi
      .spyOn(m as unknown as { stop: () => Promise<void> }, 'stop')
      .mockRejectedValueOnce(new Error('container stop failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow('postgres write failed');
    expect(stopSpy).toHaveBeenCalled();

    const failed = lastWrite('failed');
    expect(failed?.opts?.error).toBe('postgres write failed');

    scheduleSpy.mockRestore();
    stopSpy.mockRestore();
  });

  // Decision: When the BuildManager fleet is at its `max_instances` cap, `@cloudflare/containers` throws its
  // capacity error out of start(). That's transient pressure, not a build failure: the manager
  // doesn't mark the row failed (which would race the scheduler's requeue) or stop() (nothing
  // started). It re-throws so the scheduler's catch requeues it.
  it('does NOT fail or stop on the container-capacity error from start(); re-throws (load shed)', async () => {
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

    expect(lastWrite('failed')).toBeUndefined();
    expect(dbState.writes).toEqual([]);
    expect(dbState.status.get('b1')).toBe('starting');

    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);

    // Decision: The scheduler's own catch handles the requeue, so a poke from the capacity path would only churn
    // the alarm.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).not.toHaveBeenCalled();

    startSpy.mockRestore();
  });

  // Decision: The container launches, then onStart's `markBuildBuildingIfStarting` throws, so the base start()
  // rejects with the container already live. The catch has to force the container down (SIGTERM, then
  // SIGKILL), or it keeps running `bwf deploy` with a live token while Postgres records `failed`. If
  // `containerStarted` flipped only after start() resolved, this case would skip the teardown.
  it('force-stops the live container + fails + pokes when onStart throws inside start()', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    vi.mocked(markBuildBuildingIfStarting).mockRejectedValueOnce(
      new Error('postgres write failed'),
    );

    await expect(m.startBuild(makeConfig())).rejects.toThrow('postgres write failed');

    expect(containerCalls.started).toBe(1);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);

    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toBe('postgres write failed');
    expect(dbState.status.get('b1')).toBe('failed');

    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('does NOT tear down anything on a pre-launch failure (token mint throws before start())', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    vi.mocked(getInstallationToken).mockRejectedValueOnce(new Error('token mint failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow('token mint failed');

    const failed = lastWrite('failed');
    expect(failed?.opts?.error).toBe('token mint failed');
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
    expect(containerCalls.destroyed).toBe(0);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  // Decision: The startBuild catch finalizes with the CAS `markBuildTerminalIfActive`, not an unconditional
  // write. If a concurrent cancel committed 'cancelled' out of band (terminateBuildsForProject ->
  // cancelBuild RPC) while startBuild was failing, an unconditional 'failed' write would clobber it.
  it('does NOT clobber a concurrently-cancelled row in the startBuild catch', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockImplementationOnce(async () => {
        dbState.status.set('b1', 'cancelled');
        throw new Error('image pull failed');
      });

    await expect(m.startBuild(makeConfig())).rejects.toThrow('image pull failed');

    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(dbState.writes.some((w) => w.status === 'failed')).toBe(false);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();

    startSpy.mockRestore();
  });

  // Decision: `sleepAfter` is an idle safety net, not the wall-clock cap. It sits above the deploy-token hard
  // max, so a busy build that runs up to the hard max isn't idle-stopped before `enforceTimeout` fires
  // (a fixed '30m' would stop a 60-minute custom-plan build at 30m).
  it('sizes sleepAfter ABOVE the deploy-token hard max', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    const sleepAfter = (m as unknown as { sleepAfter: string }).sleepAfter;
    expect(sleepAfter).toMatch(/^\d+m$/);
    const sleepAfterMinutes = Number.parseInt(sleepAfter, 10);
    expect(sleepAfterMinutes).toBeGreaterThan(60);
  });

  // Decision: The scheduler may have claimed the row about 30 minutes ago, and a disconnect or executor change
  // could have cancelled it out of band since. startBuild re-reads builds.status after the branch-head
  // and coverage rechecks and before minting the deploy token.
  it('mints no token + starts no container when the row was cancelled after the claim', async () => {
    dbState.status.set('b1', 'cancelled');
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(dbState.writes).toEqual([]);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('does not launch after cancellation completes while the source token is awaiting', async () => {
    const tokenStarted = createDeferred<void>();
    const releaseToken = createDeferred<void>();
    vi.mocked(getInstallationToken).mockImplementationOnce(async () => {
      tokenStarted.resolve(undefined);
      await releaseToken.promise;
      return 'late-install-token';
    });

    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    const starting = m.startBuild(makeConfig());
    await tokenStarted.promise;

    await m.cancelBuild('build superseded');
    expect(dbState.status.get('b1')).toBe('cancelled');
    releaseToken.resolve(undefined);
    await starting;

    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
    expect(dbState.writes.some((write) => write.status === 'building')).toBe(false);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
    expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'complete' });
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('does not mint a source token when cancellation finishes during deploy-token signing', async () => {
    const signing = createDeferred<void>();
    const releaseToken = createDeferred<string>();
    vi.mocked(signDeployToken).mockImplementationOnce(async () => {
      signing.resolve(undefined);
      return releaseToken.promise;
    });
    const ctx = makeStubCtx();
    const m = makeManager(ctx, makeEnv());
    const starting = m.startBuild(makeConfig());
    await signing.promise;
    await m.cancelBuild('build superseded');
    releaseToken.resolve('late-deploy-token');
    await starting;

    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'complete' });
  });

  it('coalesces duplicate scheduler deliveries and allows a fresh capacity retry', async () => {
    const tokenStarted = createDeferred<void>();
    const releaseToken = createDeferred<string>();
    vi.mocked(getInstallationToken).mockImplementationOnce(async () => {
      tokenStarted.resolve(undefined);
      return releaseToken.promise;
    });
    const m = makeManager(makeStubCtx(), makeEnv());
    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockRejectedValueOnce(
        new Error('there is no container instance that can be provided to this durable object'),
      );
    const first = m.startBuild(makeConfig());
    const firstResult = expect(first).rejects.toThrow('no container instance');
    await tokenStarted.promise;
    const duplicate = m.startBuild(makeConfig());
    const duplicateResult = expect(duplicate).rejects.toThrow('no container instance');
    releaseToken.resolve('install-token');
    await Promise.all([firstResult, duplicateResult]);
    expect(getInstallationToken).toHaveBeenCalledOnce();
    expect(startSpy).toHaveBeenCalledOnce();
    expect(dbState.status.get('b1')).toBe('starting');

    // Decision: The scheduler reclaims the requeued row before its next RPC. The rejected attempt has to release
    // the coalescing gate and its aborted generation.
    startSpy.mockRestore();
    await m.startBuild(makeConfig());
    expect(getInstallationToken).toHaveBeenCalledTimes(2);
    expect(containerCalls.started).toBe(1);
    expect(dbState.status.get('b1')).toBe('building');
  });

  it('kills a producer launched after cancellation saw no container, before completing its logs', async () => {
    const preparingLaunch = createDeferred<void>();
    const releaseLaunch = createDeferred<void>();
    const ctx = makeStubCtx();
    ctx._kv.set('checkRunId', '99001');
    const m = makeManager(ctx, makeEnv());
    const startSpy = vi
      .spyOn(
        m as unknown as {
          start: (options?: unknown, wait?: { signal?: AbortSignal }) => Promise<void>;
        },
        'start',
      )
      .mockImplementationOnce(async (_options, wait) => {
        // Decision: The real base awaits scheduleNextAlarm/refreshOutboundInterception before container.start(), and
        // checks abort only during readiness.
        preparingLaunch.resolve(undefined);
        await releaseLaunch.promise;
        containerCalls.started += 1;
        (m as unknown as { _containerRunning: boolean })._containerRunning = true;
        expect(wait?.signal?.aborted).toBe(true);
        throw new Error('Aborted waiting for container to start');
      });
    const starting = m.startBuild(makeConfig());
    await preparingLaunch.promise;
    await m.cancelBuild('build superseded');
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
    expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'open' });
    expect(completeCheckRun).not.toHaveBeenCalled();

    releaseLaunch.resolve(undefined);
    await starting;

    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
    expect((m as unknown as { _containerRunning: boolean })._containerRunning).toBe(false);
    expect(ctx._logs.filter((row) => row.line.includes('container terminated'))).toEqual([
      expect.objectContaining({
        line: '[build-manager] container terminated: build superseded',
      }),
    ]);
    expect(ctx._kv.get('logDrainState')).toMatchObject({
      state: 'complete',
      finalSeq: ctx._logs.at(-1)?.seq,
    });
    expect(completeCheckRun).toHaveBeenCalledOnce();
    expect(vi.mocked(completeCheckRun).mock.calls[0][4]).toMatchObject({
      conclusion: 'cancelled',
      text: expect.stringContaining('container terminated: build superseded'),
    });
    expect(scheduledTasks(m).some((task) => task.callback === 'enforceTimeout')).toBe(false);
    startSpy.mockRestore();
  });

  it.each(['cancelled', 'failed', 'complete', 'queued', null])(
    'tears down an unclaimed launch when onStart finds an out-of-band %s row',
    async (status) => {
      const tokenStarted = createDeferred<void>();
      const releaseToken = createDeferred<string>();
      vi.mocked(getInstallationToken).mockImplementationOnce(async () => {
        tokenStarted.resolve(undefined);
        return releaseToken.promise;
      });
      const ctx = makeStubCtx();
      ctx._kv.set('checkRunId', '99001');
      const m = makeManager(ctx, makeEnv());
      const starting = m.startBuild(makeConfig());
      await tokenStarted.promise;
      // Decision: The transaction committed, but its cancel RPC hasn't arrived. Only the onStart CAS can detect this
      // remote winner.
      if (status === null) {
        dbState.status.delete('b1');
      } else {
        dbState.status.set('b1', status);
      }
      releaseToken.resolve('install-token');
      await starting;

      expect(containerCalls.started).toBe(1);
      expect(containerCalls.stopped).toBe(1);
      expect(containerCalls.destroyed).toBe(1);
      expect(dbState.status.get('b1')).toBe(status ?? undefined);
      expect(dbState.writes).toEqual([]);
      expect(ctx._logs.filter((row) => row.line.includes('container terminated'))).toHaveLength(1);
      expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'complete' });
      expect(scheduledTasks(m).some((task) => task.callback === 'enforceTimeout')).toBe(false);
      if (status === 'cancelled' || status === 'failed' || status === 'complete') {
        expect(completeCheckRun).toHaveBeenCalledOnce();
        expect(vi.mocked(completeCheckRun).mock.calls[0][4]).toMatchObject({
          conclusion:
            status === 'complete' ? 'success' : status === 'failed' ? 'failure' : 'cancelled',
        });
      }
    },
  );

  it('bounds a hung startup CAS and tears down before its late result can restore authority', async () => {
    vi.useFakeTimers();
    const claimed = createDeferred<void>();
    const releaseClaim = createDeferred<void>();
    vi.mocked(markBuildBuildingIfStarting).mockImplementationOnce(async (_db, id) => {
      claimed.resolve(undefined);
      await releaseClaim.promise;
      if (dbState.status.get(id) !== 'starting') {
        return false;
      }
      dbState.status.set(id, 'building');
      return true;
    });
    const ctx = makeStubCtx();
    const m = makeManager(ctx, makeEnv());
    try {
      const starting = m.startBuild(makeConfig());
      const result = expect(starting).rejects.toThrow('startup claim did not settle');
      await claimed.promise;
      await vi.advanceTimersByTimeAsync(TERMINAL_WRITE_TIMEOUT_MS);
      await result;
      expect(dbState.status.get('b1')).toBe('failed');
      expect(containerCalls.stopped).toBe(1);
      expect(containerCalls.destroyed).toBe(1);
      releaseClaim.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(dbState.status.get('b1')).toBe('failed');
      expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'complete' });
    } finally {
      releaseClaim.resolve(undefined);
      vi.useRealTimers();
    }
  });

  it('tears down a cancelled launch when the real-class start order reaches onStart late', async () => {
    const launched = createDeferred<void>();
    const releaseOnStart = createDeferred<void>();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    const startSpy = vi
      .spyOn(
        m as unknown as {
          start: (options?: unknown, wait?: { signal?: AbortSignal }) => Promise<void>;
        },
        'start',
      )
      .mockImplementationOnce(async (_options, wait) => {
        // Decision: Match @cloudflare/containers: launch first, await readiness, then call onStart before resolving.
        // Cancellation lands in that middle window.
        containerCalls.started += 1;
        (m as unknown as { _containerRunning: boolean })._containerRunning = true;
        launched.resolve(undefined);
        await releaseOnStart.promise;
        expect(wait?.signal?.aborted).toBe(true);
        await m.onStart();
      });

    const starting = m.startBuild(makeConfig());
    await launched.promise;
    await m.cancelBuild('build superseded');
    releaseOnStart.resolve(undefined);
    await starting;

    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(dbState.writes.some((write) => write.status === 'building')).toBe(false);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
    expect((m as unknown as { _containerRunning: boolean })._containerRunning).toBe(false);
    expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'complete' });
    expect(ctx._logs.filter((row) => row.line.includes('container terminated'))).toHaveLength(1);
    expect(scheduledTasks(m).some((task) => task.callback === 'enforceTimeout')).toBe(false);
    startSpy.mockRestore();
  });

  it('still tears down a cancelled launch when the Postgres revocation fails', async () => {
    const launched = createDeferred<void>();
    const releaseOnStart = createDeferred<void>();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(
      new Error('postgres cancellation failed'),
    );
    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockImplementationOnce(async () => {
        containerCalls.started += 1;
        (m as unknown as { _containerRunning: boolean })._containerRunning = true;
        launched.resolve(undefined);
        await releaseOnStart.promise;
        await m.onStart();
      });

    const starting = m.startBuild(makeConfig());
    await launched.promise;
    await expect(m.cancelBuild('build superseded')).rejects.toThrow('postgres cancellation failed');
    releaseOnStart.resolve(undefined);
    await starting;

    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
    expect((m as unknown as { _containerRunning: boolean })._containerRunning).toBe(false);
    expect(dbState.writes.some((write) => write.status === 'building')).toBe(false);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    startSpy.mockRestore();
  });
});

// Decision: The build agent uses SOURCE_TOKEN only to download the one repo's tarball, but it's in the
// container env, where a malicious dependency `postinstall` could read it. To limit the damage,
// startBuild mints it repo-scoped and read-only, and a build without a repository id is cancelled
// before any token is minted.
describe('BuildManager.startBuild source-token scoping', () => {
  it('mints a repo-scoped, read-only source token when repositoryId is non-null', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ repositoryId: 'repo1' }));

    expect(vi.mocked(getInstallationToken)).toHaveBeenCalledWith(expect.anything(), 'inst1', {
      repositoryIds: ['repo1'],
      permissions: { contents: 'read' },
    });
    expect(containerCalls.started).toBe(1);
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    expect(envVars.SOURCE_TOKEN).toBe('install-token');
  });

  it('passes the connection repositoryId straight through to the scope', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ repositoryId: 'repo-42' }));

    expect(vi.mocked(getInstallationToken)).toHaveBeenCalledWith(expect.anything(), 'inst1', {
      repositoryIds: ['repo-42'],
      permissions: { contents: 'read' },
    });
  });
});

// Decision: The container executor starts from the queued row's stored commit_sha. The push webhook checks at
// enqueue, but a missed or delayed newer-push webhook can leave a stale queued build. So startBuild
// does a branch-head recheck before minting BWF_TOKEN (like the OIDC path): only 'identical'
// proceeds, ahead/behind/diverged cancels, and null requeues or age-fails.
describe('BuildManager.startBuild freshness recheck', () => {
  for (const comparison of ['ahead', 'behind', 'diverged'] as const) {
    it(`cancels (no mint, no start) when the branch head is '${comparison}' (stale commit)`, async () => {
      vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(comparison);
      const ctx = makeStubCtx();
      const env = makeEnv();
      const m = makeManager(ctx, env);

      await m.startBuild(makeConfig());

      const cancelled = lastWrite('cancelled');
      expect(cancelled).toBeDefined();
      expect(cancelled?.id).toBe('b1');
      expect(cancelled?.opts?.error).toMatch(/no longer the branch head/);
      expect(dbState.status.get('b1')).toBe('cancelled');
      expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
      expect(containerCalls.started).toBe(0);
      expect(containerCalls.stopped).toBe(0);
      expect(
        (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
          .get,
      ).toHaveBeenCalled();
    });
  }

  it('requeues a FRESH build (no mint, no start) when the head comparison is unverifiable (null)', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(null);
    dbState.createdAt = new Date().toISOString();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(dbState.requeued).toEqual(['b1']);
    expect(dbState.status.get('b1')).toBe('queued');
    expect(lastWrite('failed')).toBeUndefined();
    expect(lastWrite('cancelled')).toBeUndefined();
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('fails an OLD build (older than the max age) when the head comparison stays unverifiable (null)', async () => {
    // Decision: A comparison that stays null can't loop forever: no container starts on this path, so nothing
    // would reap it. Past the max age, it fails.
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(null);
    dbState.createdAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toMatch(/could not verify branch head/);
    expect(dbState.status.get('b1')).toBe('failed');
    expect(dbState.requeued).toEqual([]);
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it("proceeds to mint + start when the branch head is 'identical' (default)", async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(vi.mocked(signDeployToken)).toHaveBeenCalledOnce();
    expect(containerCalls.started).toBe(1);
    expect(scheduledTasks(m)).toContainEqual({
      whenSeconds: 10 * 60 + LOG_DRAIN_GRACE_SECONDS,
      callback: 'enforceTimeout',
    });
  });
});

// Decision: startBuild mints the deploy and source tokens after a queue wait (seconds to about 30 minutes
// under capacity backoff), so the enqueue-time `installationCoversRepoInTx` check is stale by then.
// An uninstall, App suspension or repo removal in that window mustn't lead to a deploy after access
// was revoked, so startBuild re-reads coverage before minting and fails closed when it's gone.
describe('BuildManager.startBuild installation coverage recheck (TOCTOU)', () => {
  it('cancels (no mint, no start) when the App installation no longer covers the repo', async () => {
    dbState.installationCovered = false;
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    const cancelled = lastWrite('cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled?.id).toBe('b1');
    expect(cancelled?.opts?.error).toMatch(/reconnect the repository/i);
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
    expect(vi.mocked(installationCoversRepo)).toHaveBeenCalledWith(
      expect.anything(),
      'connection-1',
      'p1',
      'inst1',
      'repo1',
    );
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('fails closed (cancels) when a stored build config has no connection id', async () => {
    // Decision: Durable Object state written before the connection id was recorded can still be replayed once. It
    // has to cancel, not crash or start.
    dbState.installationCovered = true;
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ connectionId: undefined }));

    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(lastWrite('cancelled')?.opts?.error).toMatch(/reconnect the repository/i);
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
  });

  it('proceeds to mint + start when the installation still covers the repo (happy path)', async () => {
    dbState.installationCovered = true;
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(vi.mocked(installationCoversRepo)).toHaveBeenCalledWith(
      expect.anything(),
      'connection-1',
      'p1',
      'inst1',
      'repo1',
    );
    expect(vi.mocked(signDeployToken)).toHaveBeenCalledOnce();
    expect(containerCalls.started).toBe(1);
    expect(scheduledTasks(m)).toContainEqual({
      whenSeconds: 10 * 60 + LOG_DRAIN_GRACE_SECONDS,
      callback: 'enforceTimeout',
    });
  });
});

describe('BuildManager.onStop', () => {
  it('exit code 0 → complete and links the deployment', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];
    dbState.deployment = { id: 'dpl_123' };

    await m.onStop({ exitCode: 0, reason: 'exit' });

    const complete = lastWrite('complete');
    expect(complete).toBeDefined();
    expect(complete?.opts?.exitCode).toBe(0);
    expect(complete?.opts?.deploymentId).toBe('dpl_123');
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('non-zero exit code → failed with the exit code and reason', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    await m.onStop({ exitCode: 137, reason: 'runtime_signal' });

    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.opts?.exitCode).toBe(137);
    expect(failed?.opts?.error).toMatch(/137/);
  });

  it('does not overwrite an already-terminal status (timeout then onStop)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    await runDueSchedules(m);
    dbState.writes = [];

    await m.onStop({ exitCode: 137, reason: 'runtime_signal' });

    expect(dbState.writes.filter((w) => w.status === 'complete' || w.status === 'failed')).toEqual(
      [],
    );
  });

  // Decision: `markBuildTerminalIfActive` has no internal try/catch, so a transient Postgres throw on the exit-0
  // terminal write mustn't skip pokeScheduler(). Otherwise the row stays active and pins the slot
  // until the 75m idle reaper, though the deploy is live.
  it('still pokes the scheduler when the exit-0 terminal DB write throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));

    await expect(m.onStop({ exitCode: 0, reason: 'exit' })).rejects.toThrow(
      'postgres write failed',
    );

    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'complete' });
  });

  it('still terminalizes and releases the scheduler when log completion persistence fails', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();
    dbState.writes = [];

    const originalPut = ctx.storage.put.getMockImplementation()!;
    ctx.storage.put.mockImplementation(async (key: string, value: unknown) => {
      if (
        key === 'logDrainState' &&
        typeof value === 'object' &&
        value !== null &&
        (value as { state?: string }).state === 'complete'
      ) {
        throw new Error('sqlite metadata unavailable');
      }
      await originalPut(key, value);
    });

    await expect(m.onStop({ exitCode: 0, reason: 'exit' })).resolves.toBeUndefined();

    expect(lastWrite('complete')).toBeDefined();
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('still pokes the scheduler when the non-zero terminal DB write throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));

    await expect(m.onStop({ exitCode: 137, reason: 'runtime_signal' })).rejects.toThrow(
      'postgres write failed',
    );

    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
  });

  // Decision: The exit-0 deployment lookup runs after `bwf deploy` already exited 0. A transient Hyperdrive or
  // Postgres throw on it mustn't strand the build: onStop still finalizes 'complete' (with a null
  // link) and pokes the scheduler.
  it('finalizes complete + pokes the scheduler when the exit-0 deployment lookup throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];
    dbState.deployment = { id: 'dpl_123' };
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(getDeploymentByProjectAndCommit).mockRejectedValueOnce(
      new Error('hyperdrive lookup failed'),
    );

    await m.onStop({ exitCode: 0, reason: 'exit' });

    const complete = lastWrite('complete');
    expect(complete).toBeDefined();
    expect(complete?.opts?.exitCode).toBe(0);
    expect(complete?.opts?.deploymentId).toBeNull();
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'complete' });
  });
});

describe('BuildManager.onError', () => {
  it('records failed with the error message', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];
    // Decision: The container is still live here, so onError drains before it finalizes. An unstubbed port fetch
    // would throw and use up the whole retry window on real timers, so answer at once with nothing.
    (m as unknown as { _portFetch: () => Promise<Response> })._portFetch = async () =>
      new RealResponse(JSON.stringify({ lines: [], lastSeq: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    await m.onError(new Error('boom'));

    const failed = lastWrite('failed');
    expect(failed?.opts?.error).toBe('boom');
  });

  // Decision: `onError` is the one terminalizer that doesn't force-stop, so nothing else has drained when it
  // finalizes. `pollLogs`' terminal branch pulls up to POLL_SECONDS later, after the check run is
  // completed, so that tail would be missing from the check run a reader opens.
  it('drains the log tail BEFORE completing the check run', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');
    ctx._kv.set('checkRunId', '99001');

    const order: Array<string> = [];
    const fetchFn = vi.fn(async () => {
      order.push('drain');
      return new RealResponse(
        JSON.stringify({
          lines: [{ seq: 4, line: 'FATAL: out of memory', stream: 'stderr', ts: 4 }],
          lastSeq: 4,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    vi.mocked(completeCheckRun).mockImplementationOnce(async () => {
      order.push('finalize');
      return false;
    });

    await m.onError(new Error('container crashed'));

    expect(order).toEqual(['drain', 'finalize']);
    expect(ctx._logs.map((r) => r.line)).toContain('FATAL: out of memory');
  });

  it('retries a transient terminal pull before completing the check run', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');
    ctx._kv.set('checkRunId', '99001');

    const order: Array<string> = [];
    let fetchAttempt = 0;
    const fetchFn = vi.fn(async (_url: string, _port: number, _init?: RequestInit) => {
      fetchAttempt += 1;
      const attempt = fetchAttempt;
      if (attempt === 1) {
        order.push('pull-failed');
        throw new Error('agent port temporarily unavailable');
      }
      if (attempt === 2) {
        order.push('pull-tail');
        return new RealResponse(
          JSON.stringify({
            lines: [{ seq: 7, line: 'FATAL: recovered tail', stream: 'stderr', ts: 7 }],
            lastSeq: 7,
            hasMore: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      order.push('pull-ack');
      return new RealResponse(JSON.stringify({ lines: [], lastSeq: 7, hasMore: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    vi.mocked(completeCheckRun).mockImplementationOnce(async () => {
      order.push('finalize');
      return false;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.useFakeTimers();
    try {
      const run = m.onError(new Error('container crashed'));
      await vi.advanceTimersByTimeAsync(LOG_TERMINAL_DRAIN_RETRY_WINDOW_MS);
      await run;
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      'http://manager/logs?since=0',
      'http://manager/logs?since=0',
      'http://manager/logs?since=7',
    ]);
    expect(ctx._logs.map((row) => row.line)).toContain('FATAL: recovered tail');
    expect(order).toEqual(['pull-failed', 'pull-tail', 'pull-ack', 'finalize']);
  });

  it('does not start a fresh onError pull while a concurrent teardown owns the tail', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');
    ctx._kv.set('checkRunId', '99001');
    vi.mocked(completeCheckRun).mockClear();

    let releaseTerminalWrite!: () => void;
    const terminalWriteGate = new Promise<void>((resolve) => {
      releaseTerminalWrite = resolve;
    });
    let markTerminalWriteEntered!: () => void;
    const terminalWriteEntered = new Promise<void>((resolve) => {
      markTerminalWriteEntered = resolve;
    });
    vi.mocked(markBuildTerminalIfActive).mockImplementationOnce(async () => {
      dbState.status.set('b1', 'failed');
      markTerminalWriteEntered();
      await terminalWriteGate;
      return true;
    });

    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let markStopEntered!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      markStopEntered = resolve;
    });
    (m as unknown as { stop: () => Promise<void> }).stop = vi.fn(async () => {
      containerCalls.stopped += 1;
      markStopEntered();
      await stopGate;
      (m as unknown as { _containerRunning: boolean })._containerRunning = false;
    });

    const fetchFn = vi.fn(
      async () =>
        new RealResponse(JSON.stringify({ lines: [], lastSeq: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    const onError = m.onError(new Error('container crashed'));
    await terminalWriteEntered;
    const cancel = m.cancelBuild('build superseded');
    await stopEntered;

    releaseTerminalWrite();
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    // Decision: The teardown already took the only final snapshot. onError joins it instead of opening a second
    // request during stop(), so it can't finalize yet.
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(vi.mocked(completeCheckRun)).not.toHaveBeenCalled();

    releaseStop();
    await Promise.all([onError, cancel]);

    expect(fetchFn).toHaveBeenCalledOnce();
    // Decision: Both surviving terminalizers can send the same idempotent PATCH: cancel recovers when onError was
    // lost, and onError still finalizes when it survives.
    expect(vi.mocked(completeCheckRun)).toHaveBeenCalled();
  });

  it('joins a teardown that begins during a successful onError pull', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');
    ctx._kv.set('checkRunId', '99001');
    vi.mocked(completeCheckRun).mockClear();

    let releaseOnErrorPull!: () => void;
    const onErrorPullGate = new Promise<void>((resolve) => {
      releaseOnErrorPull = resolve;
    });
    let markOnErrorPullEntered!: () => void;
    const onErrorPullEntered = new Promise<void>((resolve) => {
      markOnErrorPullEntered = resolve;
    });
    let releaseTeardownPull!: () => void;
    const teardownPullGate = new Promise<void>((resolve) => {
      releaseTeardownPull = resolve;
    });
    let markTeardownPullEntered!: () => void;
    const teardownPullEntered = new Promise<void>((resolve) => {
      markTeardownPullEntered = resolve;
    });

    let fetchAttempt = 0;
    const fetchFn = vi.fn(async (_url: string, _port: number, _init?: RequestInit) => {
      fetchAttempt += 1;
      if (fetchAttempt === 1) {
        markOnErrorPullEntered();
        await onErrorPullGate;
      } else {
        markTeardownPullEntered();
        await teardownPullGate;
      }
      return new RealResponse(JSON.stringify({ lines: [], lastSeq: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    const onError = m.onError(new Error('container crashed'));
    await onErrorPullEntered;
    const cancel = m.cancelBuild('build superseded');

    releaseOnErrorPull();
    await teardownPullEntered;
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(completeCheckRun)).not.toHaveBeenCalled();

    releaseTeardownPull();
    await Promise.all([onError, cancel]);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(completeCheckRun)).toHaveBeenCalled();
  });

  it('still pokes the scheduler + sets local failed when the onError terminal DB write throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));
    (m as unknown as { _portFetch: (url: string) => Promise<Response> })._portFetch = vi.fn(
      async () =>
        new RealResponse(JSON.stringify({ lines: [], lastSeq: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await expect(m.onError(new Error('boom'))).rejects.toThrow('postgres write failed');

    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
  });
});

// Decision: The base `start()` runs onStart inside `blockConcurrencyWhile` before resolving, and a fast-exiting
// container's onStop can fire too. The DB row mustn't go back to `starting`/`building` after a
// terminal outcome, and a duplicate terminal write mustn't clobber the first. The guard is the CAS
// in db.ts, not the in-memory `config.status` early returns (which only see the DO copy).
describe('BuildManager lifecycle status-race CAS guards', () => {
  it.each(['building', 'deploying'])(
    'preserves a legitimate late onStart callback for %s',
    async (status) => {
      const ctx = makeStubCtx();
      const m = makeManager(ctx, makeEnv());
      await m.startBuild(makeConfig());
      dbState.status.set('b1', status);
      dbState.writes = [];

      await m.onStart();

      expect(dbState.status.get('b1')).toBe(status);
      expect(ctx._kv.get('buildConfig')).toMatchObject({ status });
      expect(containerCalls.stopped).toBe(0);
      expect(containerCalls.destroyed).toBe(0);
      expect(dbState.writes).toEqual([]);
      expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'open' });
    },
  );

  it('a fast-exit onStop right after startBuild lands a terminal row that is never reset to starting', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());
    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(dbState.status.get('b1')).toBe('complete');
    expect(dbState.writes.some((w) => w.status === 'starting')).toBe(false);
    expect(lastWrite('complete')).toBeDefined();
  });

  it('onStart does NOT resurrect a row a fast-exit onStop already drove terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Decision: The in-memory config still says active ('building'), so the in-memory guard wouldn't catch this.
    // Only the DB-level CAS does.
    dbState.status.set('b1', 'failed');
    dbState.writes = [];

    await m.onStart();

    expect(dbState.status.get('b1')).toBe('failed');
    expect(dbState.writes).toEqual([]);
  });

  it('a duplicate/late terminal write does not clobber the first terminal outcome', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    dbState.deployment = { id: 'dpl_first' };
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(dbState.status.get('b1')).toBe('complete');
    dbState.writes = [];

    await m.onStop({ exitCode: 137, reason: 'runtime_signal' });
    const { markBuildTerminalIfActive } = await import('../../src/db.ts');
    const moved = await markBuildTerminalIfActive(
      {} as unknown as Parameters<typeof markBuildTerminalIfActive>[0],
      'b1',
      'failed',
      { exitCode: 137 },
    );

    expect(moved).toBe(false);
    expect(dbState.status.get('b1')).toBe('complete');
    expect(dbState.writes).toEqual([]);
  });
});

describe('BuildManager timeout integration (base-owned alarm + scheduled enforceTimeout)', () => {
  it('does NOT override alarm() — the base Container owns the DO alarm loop', () => {
    // Decision: A manager-level alarm() override would treat each base monitor tick as a timeout (failing healthy
    // builds) and starve the base loop that dispatches onStop. The manager inherits the base alarm.
    const proto = Object.getPrototypeOf(BuildManager.prototype) as Record<string, unknown>;
    expect(Object.hasOwn(BuildManager.prototype, 'alarm')).toBe(false);
    expect(typeof proto.alarm).toBe('function');
  });

  it('a base alarm BEFORE the deadline does not fail a healthy build, and onStop still finalizes', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    await m.alarm();
    expect(containerCalls.baseAlarms).toBe(1);
    expect(dbState.writes).toEqual([]);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'building' });

    dbState.deployment = { id: 'dpl_ok' };
    await m.onStop({ exitCode: 0, reason: 'exit' });
    const complete = lastWrite('complete');
    expect(complete).toBeDefined();
    expect(complete?.opts?.deploymentId).toBe('dpl_ok');
    expect(dbState.writes.some((w) => w.opts?.error === 'build timed out')).toBe(false);
  });

  it('crossing the deadline fails the build, stops the container, and frees the slot', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    await runDueSchedules(m);

    expect(containerCalls.stopped).toBe(1);
    const failed = lastWrite('failed');
    expect(failed?.opts?.error).toMatch(/timed out/);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('force-kills the container via destroy() (SIGKILL) on timeout, not just stop() (SIGTERM)', async () => {
    // Decision: The real base `stop()` only sends SIGTERM. A build whose PID-1 agent ignores SIGTERM survives it
    // and pins a fleet slot, since the stale reaper only re-cancels active rows and this one is
    // terminal. So enforceTimeout escalates to destroy() (SIGKILL).
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    await runDueSchedules(m);

    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });

  it('enforceTimeout is a no-op once the build is already terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    await m.onStop({ exitCode: 0, reason: 'exit' });
    // Decision: A real onStop callback means the producer is already gone. The unit stub calls the hook directly,
    // so model that liveness change of the base class.
    (m as unknown as { _containerRunning: boolean })._containerRunning = false;
    dbState.writes = [];
    containerCalls.stopped = 0;

    await m.enforceTimeout();

    expect(containerCalls.stopped).toBe(0);
    expect(dbState.writes).toEqual([]);
  });

  it('recovers a live producer even when local cancellation was already persisted', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._kv.set('checkRunId', '99001');

    await ctx.storage.put('buildConfig', {
      ...makeConfig(),
      status: 'cancelled',
    });
    dbState.status.set('b1', 'building');
    dbState.writes = [];
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    await m.enforceTimeout();

    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(lastWrite('cancelled')).toBeDefined();
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
    expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'complete' });
    expect(completeCheckRun).toHaveBeenCalledOnce();
    expect(vi.mocked(completeCheckRun).mock.calls[0][4]).toMatchObject({
      conclusion: 'cancelled',
      text: expect.stringContaining('container terminated'),
    });
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it.each(['failed', 'cancelled'])(
    'recovers a locally %s producer when its Postgres revocation rejects',
    async (status) => {
      const ctx = makeStubCtx();
      const env = makeEnv();
      const m = makeManager(ctx, env);
      await m.startBuild(makeConfig());
      await ctx.storage.put('buildConfig', { ...makeConfig(), status });
      vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres offline'));
      const portFetch = vi.fn();
      (m as unknown as { _portFetch: unknown })._portFetch = portFetch;

      await expect(m.enforceTimeout()).rejects.toThrow('postgres offline');

      expect(dbState.status.get('b1')).toBe('building');
      expect(containerCalls.stopped).toBe(1);
      expect(containerCalls.destroyed).toBe(1);
      // Decision: An uncertain revocation mustn't open another log fetch with live token authority. The durable
      // reconciler sees any later terminal write.
      expect(portFetch).not.toHaveBeenCalled();
      expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'complete' });
      expect(scheduledTasks(m).some((task) => task.callback === 'reconcileTerminalWrite')).toBe(
        true,
      );
      expect(
        (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
          .get,
      ).toHaveBeenCalled();
    },
  );

  it('stops the container AND pokes the scheduler even when the terminal DB write throws', async () => {
    // Decision: `markBuildTerminalIfActive` has no internal try/catch. A Hyperdrive or Postgres throw mustn't skip
    // container teardown (a timed-out container would keep running with a valid deploy token) or the
    // scheduler poke, so the local setStatus, stop() and poke don't depend on the DB write.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));

    await expect(runDueSchedules(m)).rejects.toThrow('postgres write failed');

    expect(containerCalls.stopped).toBe(1);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
  });

  // Decision: `createDb()` is a bare `drizzle(connectionString)` over a `pg.Pool` with no
  // `connectionTimeoutMillis` and no `query_timeout`, so a revocation can pend instead of rejecting.
  // Then the catch doesn't run, `forceStopContainer()` isn't reached, and the timed-out container
  // keeps its deploy token and fleet slot. A retry after the runtime kills the invocation hits
  // `enforceTimeout`'s own terminal guard and returns, so teardown falls to the hourly stale reaper.
  // A deadline turns this into the throw path.
  it('stops the container AND pokes the scheduler when the terminal DB write never settles', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockReturnValueOnce(new Promise<boolean>(() => {}));

    vi.useFakeTimers();
    try {
      const run = runDueSchedules(m);
      const settled = expect(run).rejects.toThrow('did not settle');
      await vi.advanceTimersByTimeAsync(TERMINAL_WRITE_TIMEOUT_MS);
      await settled;
    } finally {
      vi.useRealTimers();
    }

    expect(containerCalls.stopped).toBe(1);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
  });
});

// Decision: cancelBuild is the trusted DO-to-DO and API-to-DO cancel path that github.ts calls when a project
// is disconnected or its branch or executor changes. It needs no agent secret, unlike POST /cancel.
describe('BuildManager.cancelBuild (internal RPC)', () => {
  // Decision: Once a hung `enforceTimeout` has written the DO-local 'failed', `cancelBuild` skips its own
  // revocation and goes straight to teardown. A cancel that arrives first owns the revocation, and
  // mustn't inherit the same stall.
  it('stops the container AND pokes the scheduler when its own terminal write never settles', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockReturnValueOnce(new Promise<boolean>(() => {}));

    vi.useFakeTimers();
    try {
      const run = m.cancelBuild('project disconnected');
      const settled = expect(run).rejects.toThrow('did not settle');
      await vi.advanceTimersByTimeAsync(TERMINAL_WRITE_TIMEOUT_MS);
      await settled;
    } finally {
      vi.useRealTimers();
    }

    expect(containerCalls.stopped).toBe(1);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
  });

  it('stops the container, records cancelled via the CAS, and pokes the scheduler', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    await m.cancelBuild('project disconnected');

    expect(containerCalls.stopped).toBe(1);
    const cancelled = lastWrite('cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled?.id).toBe('b1');
    expect(cancelled?.opts?.error).toBe('project disconnected');
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('force-kills the container via destroy() (SIGKILL) on cancel, not just stop() (SIGTERM)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    await m.cancelBuild('project disconnected');

    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });

  it('defaults the reason to "build cancelled" when none is given', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    await m.cancelBuild();

    expect(lastWrite('cancelled')?.opts?.error).toBe('build cancelled');
  });

  it('is a no-op (no clobber) once the build is already terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(dbState.status.get('b1')).toBe('complete');
    dbState.writes = [];
    containerCalls.stopped = 0;

    await m.cancelBuild('project disconnected');

    expect(dbState.status.get('b1')).toBe('complete');
    expect(dbState.writes.some((w) => w.status === 'cancelled')).toBe(false);
    expect(dbState.writes).toEqual([]);
  });

  it('reconciles a check run when local terminal state still has an active DB row', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._kv.set('checkRunId', '99001');
    vi.mocked(completeCheckRun).mockClear();

    // Decision: Model an invocation lost after the durable local write but before its terminal write and
    // check-run completion reached Postgres and GitHub.
    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('failed');
    dbState.status.set('b1', 'building');
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await m.cancelBuild('build superseded');

    expect(vi.mocked(completeCheckRun)).not.toHaveBeenCalled();
    expect(
      scheduledTasks(m).filter((task) => task.callback === 'reconcileTerminalWrite'),
    ).toHaveLength(1);

    dbState.status.set('b1', 'failed');
    await runDueSchedules(m);

    expect(vi.mocked(completeCheckRun)).toHaveBeenCalledOnce();
    expect(vi.mocked(completeCheckRun).mock.calls[0][4]).toMatchObject({ conclusion: 'failure' });
    expect(scheduledTasks(m).some((task) => task.callback === 'reconcileTerminalWrite')).toBe(
      false,
    );
  });

  it('finalizes a terminal DB row found behind local terminal state', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._kv.set('checkRunId', '99001');
    vi.mocked(completeCheckRun).mockClear();

    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('failed');
    dbState.status.set('b1', 'failed');
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await m.cancelBuild('build superseded');

    expect(vi.mocked(completeCheckRun)).toHaveBeenCalledOnce();
    expect(vi.mocked(completeCheckRun).mock.calls[0][4]).toMatchObject({ conclusion: 'failure' });
    expect(ctx._logs.map((row) => row.line)).toContain(
      '[build-manager] container terminated: build terminated out of band',
    );
    expect(ctx._logs.map((row) => row.line)).not.toContain(
      '[build-manager] container terminated: build superseded',
    );
    expect(scheduledTasks(m).some((task) => task.callback === 'reconcileTerminalWrite')).toBe(
      false,
    );
  });

  it('stops the container AND pokes the scheduler even when the terminal DB write throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));

    await expect(m.cancelBuild('project disconnected')).rejects.toThrow('postgres write failed');

    expect(containerCalls.stopped).toBe(1);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
    expect(ctx._logs.map((row) => row.line)).toContain(
      '[build-manager] container terminated: build terminated out of band',
    );
  });
});

describe('BuildManager log ingest + WebSocket replay', () => {
  it('appends ingested log lines to SQLite and replays them on WS upgrade', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'installing deps', stream: 'stdout', ts: 1 } as unknown as LogRow,
      { line: 'build done', stream: 'stdout', ts: 2 } as unknown as LogRow,
    ]);
    expect(ctx._logs).toHaveLength(2);

    const upgrade = await m.fetch(
      new Request('https://manager/', { headers: { Upgrade: 'websocket' } }),
    );
    expect(upgrade.status).toBe(101);
    const server = ctx._sockets[0];
    expect(server).toBeDefined();
    const messages = server.sent.map((s) => JSON.parse(s));
    expect(messages[0]).toMatchObject({ type: 'log', line: 'installing deps' });
    expect(messages[1]).toMatchObject({ type: 'log', line: 'build done' });
    expect(messages[2]).toEqual({ type: 'caught_up' });
  });

  it('caps stored logs at MAX_STORED_LOG_LINES so storage + replay stay bounded', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const total = MAX_STORED_LOG_LINES + 250;
    const batch: Array<{ line: string; stream: string; ts: number }> = [];
    for (let i = 1; i <= total; i++) {
      batch.push({ line: `line ${i}`, stream: 'stdout', ts: i });
    }
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines(
      batch as unknown as Array<LogRow>,
    );

    expect(ctx._logs.length).toBe(MAX_STORED_LOG_LINES);
    expect(ctx._logs.some((r) => r.line === `line ${total}`)).toBe(true);
    expect(ctx._logs.some((r) => r.line === 'line 1')).toBe(false);

    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    const logMsgs = server.sent.map((s) => JSON.parse(s)).filter((msg) => msg.type === 'log');
    expect(logMsgs.length).toBe(MAX_STORED_LOG_LINES);
  });

  it('broadcasts new log lines to attached sockets', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    server.sent = [];

    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'live line', stream: 'stderr', ts: 3 } as unknown as LogRow,
    ]);

    const live = server.sent.map((s) => JSON.parse(s));
    expect(live.some((msg) => msg.type === 'log' && msg.line === 'live line')).toBe(true);
  });

  it('POST /cancel stops the container and records cancelled', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(agentRequest(ctx, 'https://manager/cancel', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(containerCalls.stopped).toBe(1);
    expect(lastWrite('cancelled')).toBeDefined();
  });
});

// Decision: The admin worker (which holds the DO binding) polls the DO's stored logs with an unauthenticated
// `GET /logs?since=N`. It's read-only: no inserts, status writes or broadcast. It coexists with the
// WS upgrade, which branches first on the `Upgrade` header.
describe('BuildManager.fetch GET /logs?since=N (admin poll read)', () => {
  async function seedLogs(
    _ctx: ReturnType<typeof makeStubCtx>,
    m: BuildManager,
    lines: Array<{ line: string; stream: string; ts: number }>,
  ): Promise<void> {
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines(
      lines as unknown as Array<LogRow>,
    );
  }

  it('since=0 returns all stored rows (seq+line+stream+ts) and the max seq as lastSeq', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await seedLogs(ctx, m, [
      { line: 'installing deps', stream: 'stdout', ts: 10 },
      { line: 'build done', stream: 'stdout', ts: 20 },
    ]);

    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<{ seq: number; line: string; stream: string; ts: number }>;
      lastSeq: number;
      logsComplete: boolean | null;
    };
    expect(body.lines).toEqual([
      { seq: 1, line: 'installing deps', stream: 'stdout', ts: 10 },
      { seq: 2, line: 'build done', stream: 'stdout', ts: 20 },
    ]);
    expect(body.lastSeq).toBe(2);
    expect(body.logsComplete).toBe(false);
  });

  it('keeps terminal reads incomplete until delayed diagnostics are drained and the producer stops', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    let releaseTerminalWrite!: () => void;
    const terminalWriteGate = new Promise<void>((resolve) => {
      releaseTerminalWrite = resolve;
    });
    let terminalWriteEntered!: () => void;
    const terminalWriteStarted = new Promise<void>((resolve) => {
      terminalWriteEntered = resolve;
    });
    vi.mocked(markBuildTerminalIfActive).mockImplementationOnce(async () => {
      terminalWriteEntered();
      await terminalWriteGate;
      dbState.status.set('b1', 'failed');
      return true;
    });
    (m as unknown as { _portFetch: (url: string) => Promise<Response> })._portFetch = vi.fn(
      async () =>
        new RealResponse(
          JSON.stringify({
            lines: [{ seq: 1, line: 'delayed diagnostic', stream: 'stderr', ts: 1 }],
            lastSeq: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const failing = m.onError(new Error('container runtime error'));
    await terminalWriteStarted;

    const pending = (await (await m.fetch(new Request('https://manager/logs?since=0'))).json()) as {
      lines: Array<LogRow>;
      terminal: boolean;
      logsComplete: boolean | null;
    };
    expect(pending).toMatchObject({ lines: [], terminal: true, logsComplete: false });

    releaseTerminalWrite();
    await failing;
    const drained = (await (await m.fetch(new Request('https://manager/logs?since=0'))).json()) as {
      lines: Array<LogRow>;
      logsComplete: boolean | null;
    };
    expect(drained.lines.map((line) => line.line)).toEqual(['delayed diagnostic']);
    expect(drained.logsComplete).toBe(false);

    // Decision: onError leaves the container to the base lifecycle. Its later onStop is the producer barrier that
    // makes the drained snapshot final.
    (m as unknown as { _containerRunning: boolean })._containerRunning = false;
    await m.onStop({ exitCode: 1, reason: 'exit' });
    const complete = (await (
      await m.fetch(new Request('https://manager/logs?since=1'))
    ).json()) as { lines: Array<LogRow>; lastSeq: number; logsComplete: boolean | null };
    expect(complete).toMatchObject({ lines: [], lastSeq: 1, logsComplete: true });
  });

  it('since=K returns ONLY rows with seq > K (asc), with lastSeq = max seq', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await seedLogs(ctx, m, [
      { line: 'a', stream: 'stdout', ts: 1 },
      { line: 'b', stream: 'stdout', ts: 2 },
      { line: 'c', stream: 'stderr', ts: 3 },
    ]);

    const res = await m.fetch(new Request('https://manager/logs?since=1', { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<{ seq: number; line: string; stream: string; ts: number }>;
      lastSeq: number;
    };
    expect(body.lines).toEqual([
      { seq: 2, line: 'b', stream: 'stdout', ts: 2 },
      { seq: 3, line: 'c', stream: 'stderr', ts: 3 },
    ]);
    expect(body.lastSeq).toBe(3);
  });

  it('empty table returns { lines: [], lastSeq: <since> } (cursor held at the request)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: Array<unknown>; lastSeq: number };
    expect(body.lines).toEqual([]);
    expect(body.lastSeq).toBe(0);

    const res2 = await m.fetch(new Request('https://manager/logs?since=7', { method: 'GET' }));
    const body2 = (await res2.json()) as { lines: Array<unknown>; lastSeq: number };
    expect(body2.lines).toEqual([]);
    expect(body2.lastSeq).toBe(7);
  });

  it('treats a missing/NaN since as 0 (returns everything)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await seedLogs(ctx, m, [{ line: 'only', stream: 'stdout', ts: 1 }]);

    const missing = await m.fetch(new Request('https://manager/logs', { method: 'GET' }));
    const missingBody = (await missing.json()) as {
      lines: Array<{ seq: number }>;
      lastSeq: number;
    };
    expect(missingBody.lines.map((r) => r.seq)).toEqual([1]);
    expect(missingBody.lastSeq).toBe(1);

    const nan = await m.fetch(new Request('https://manager/logs?since=abc', { method: 'GET' }));
    const nanBody = (await nan.json()) as { lines: Array<{ seq: number }>; lastSeq: number };
    expect(nanBody.lines.map((r) => r.seq)).toEqual([1]);
    expect(nanBody.lastSeq).toBe(1);
  });

  it('is READ-ONLY: no status write, no new rows, no broadcast to attached sockets', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    await seedLogs(ctx, m, [{ line: 'x', stream: 'stdout', ts: 1 }]);

    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    server.sent = [];
    dbState.writes = [];
    const rowsBefore = ctx._logs.length;

    await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));

    expect(ctx._logs.length).toBe(rowsBefore);
    expect(dbState.writes).toEqual([]);
    expect(server.sent).toEqual([]);
  });

  it('surfaces the DO-local status + terminal from config (non-terminal while running)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('building');

    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    const body = (await res.json()) as { status: string | null; terminal: boolean };
    expect(body.status).toBe('building');
    expect(body.terminal).toBe(false);
  });

  it('surfaces terminal:true once the DO config reaches a terminal status (DO-authoritative)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('complete');

    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    const body = (await res.json()) as { status: string | null; terminal: boolean };
    expect(body.status).toBe('complete');
    expect(body.terminal).toBe(true);
  });

  it('returns status:null, terminal:false when no build config exists yet', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    const body = (await res.json()) as {
      status: string | null;
      terminal: boolean;
      logsComplete: boolean | null;
    };
    expect(body.status).toBeNull();
    expect(body.terminal).toBe(false);
    expect(body.logsComplete).toBeNull();
  });

  it('read-only infers completion for a legacy terminal config with a stopped container', async () => {
    const ctx = makeStubCtx({
      initialLogs: [{ seq: 1, line: 'legacy tail', stream: 'stdout', ts: 1 }],
    });
    ctx._kv.set('buildConfig', { ...makeConfig(), status: 'complete' });
    const m = makeManager(ctx, makeEnv());
    ctx.storage.put.mockClear();

    const body = (await (await m.fetch(new Request('https://manager/logs?since=0'))).json()) as {
      lines: Array<LogRow>;
      logsComplete: boolean | null;
    };

    expect(body.logsComplete).toBe(true);
    expect(body.lines.map((line) => line.line)).toEqual(['legacy tail']);
    expect(ctx.storage.put).not.toHaveBeenCalled();
  });

  it('does NOT collide with the WS upgrade: a GET WITHOUT the Upgrade header reads logs', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    await seedLogs(ctx, m, [{ line: 'log', stream: 'stdout', ts: 1 }]);

    const read = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    expect(read.status).toBe(200);
    expect(ctx._sockets.length).toBe(0);

    const upgrade = await m.fetch(
      new Request('https://manager/logs', { headers: { Upgrade: 'websocket' } }),
    );
    expect(upgrade.status).toBe(101);
    expect(ctx._sockets.length).toBe(1);
  });
});

// Decision: The DO pulls build-log lines from the in-container agent over the non-starting raw port fetch
// (`container.getTcpPort(port).fetch(url)`), not the auto-starting `containerFetch`, so a poll that
// races a just-exited container can't bring it back. It re-arms through the base scheduler, like
// `enforceTimeout`.
describe('BuildManager.pollLogs (DO log pull-loop)', () => {
  function stubPortFetch(
    m: BuildManager,
    responses: Array<{ lines: Array<LogRow>; lastSeq: number } | Error>,
  ): ReturnType<typeof vi.fn> {
    let call = 0;
    const fn = vi.fn(async (_url: string, _port?: number) => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (next instanceof Error) {
        throw next;
      }
      return new RealResponse(JSON.stringify(next), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fn })._portFetch = fn;
    return fn;
  }

  function logCursor(m: BuildManager): number {
    return (m as unknown as { logCursor: number }).logCursor;
  }

  it('pulls two batches: ingests lines, advances the cursor, and re-arms', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    server.sent = [];

    // Decision: Call pollLogs directly, not through runDueSchedules, which would also fire the 600s enforceTimeout
    // armed at startBuild.
    const fetchFn = stubPortFetch(m, [
      {
        lines: [
          { seq: 1, line: 'installing deps', stream: 'stdout', ts: 1 },
          { seq: 2, line: 'compiling', stream: 'stdout', ts: 2 },
        ],
        lastSeq: 2,
      },
      {
        lines: [{ seq: 3, line: 'uploading', stream: 'stdout', ts: 3 }],
        lastSeq: 3,
      },
    ]);
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('http://manager/logs?since=0');
    expect(fetchFn.mock.calls[0][1]).toBe(4000);

    expect(ctx._logs.map((r) => r.line)).toEqual(['installing deps', 'compiling']);
    const broadcast = server.sent.map((s) => JSON.parse(s));
    expect(broadcast.some((m) => m.type === 'log' && m.line === 'installing deps')).toBe(true);
    expect(broadcast.some((m) => m.type === 'log' && m.line === 'compiling')).toBe(true);

    expect(logCursor(m)).toBe(2);
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(true);

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    expect(fetchFn.mock.calls[1][0]).toBe('http://manager/logs?since=2');
    expect(ctx._logs.map((r) => r.line)).toEqual(['installing deps', 'compiling', 'uploading']);
    expect(logCursor(m)).toBe(3);
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(true);
  });

  it('returns without rescheduling when the build status is terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const fetchFn = stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);

    dbState.status.set('b1', 'building');
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'complete' });
    // Decision: `onStop` fires because the container exited, so it's gone here. The base stub only flips
    // `_containerRunning` in stop()/destroy(), so set it explicitly. Otherwise this would model a
    // terminal build with a live container, which is the cancel/timeout case tested below.
    (m as unknown as { _containerRunning: boolean })._containerRunning = false;

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(false);
  });

  it('issues ONE final pull (no re-arm) when the status went terminal while the container is still running', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Decision: Reach `terminal status + live container` through a real production path instead of setStatus.
    // onError drains once before finalizing but doesn't stop, and this terminal backstop catches a line
    // produced after that snapshot.
    dbState.writes = [];
    stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);
    await m.onError(new Error('container runtime error'));
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
    expect((m as unknown as { _containerRunning: boolean })._containerRunning).toBe(true);

    const fetchFn = stubPortFetch(m, [
      { lines: [{ seq: 7, line: 'vite build failed', stream: 'stderr', ts: 7 }], lastSeq: 7 },
    ]);
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('http://manager/logs?since=0');
    expect(ctx._logs.map((r) => r.line)).toContain('vite build failed');
    expect(logCursor(m)).toBe(7);
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(false);
  });

  it('swallows a throw from the final terminal-status pull (must not escape the alarm)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('cancelled');

    const fetchFn = stubPortFetch(m, [new Error('container gone mid-teardown')]);
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await expect(
      (m as unknown as { pollLogs: () => Promise<void> }).pollLogs(),
    ).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(false);
  });

  it('never uses the auto-starting containerFetch for the final terminal-status pull', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('cancelled');

    const autoStart = vi.fn(async () => new RealResponse('{}', { status: 200 }));
    (m as unknown as { containerFetch: typeof autoStart }).containerFetch = autoStart;
    const portFetch = stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    expect(portFetch).toHaveBeenCalledTimes(1);
    expect(autoStart).not.toHaveBeenCalled();
  });

  it('does not pull (clean early-out) once the container has exited, even if status is not yet terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const fetchFn = stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);

    // Decision: The container exited between polls but onStop hasn't run yet, so the saved status is still
    // `building`. The running guard skips the fetch and ends the loop, and onStop finalizes the build.
    (m as unknown as { _containerRunning: boolean })._containerRunning = false;

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(false);
  });

  it('swallows a port-fetch throw (no unhandled throw) and re-arms', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const fetchFn = stubPortFetch(m, [new Error('container mid-start')]);

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    await expect(
      (m as unknown as { pollLogs: () => Promise<void> }).pollLogs(),
    ).resolves.toBeUndefined();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(ctx._logs).toHaveLength(0);
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(true);
  });

  it('leaves the cursor UNADVANCED when a 200 body cannot be parsed — the agent reads this cursor as its drain ack', async () => {
    // Decision: The agent's exit barrier treats a later `since=N` as proof the DO stored everything below N. That
    // holds only because `logCursor` is written after `res.json()` and `ingestLines()` succeed. So a 200
    // whose body isn't JSON ingests nothing and doesn't move the cursor.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const fetchFn = vi.fn(
      async () => new RealResponse('not json at all', { status: 200 }),
    ) as ReturnType<typeof vi.fn>;
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    await expect(
      (m as unknown as { pollLogs: () => Promise<void> }).pollLogs(),
    ).resolves.toBeUndefined();

    expect(ctx._logs).toHaveLength(0);
    expect(logCursor(m)).toBe(0);
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(true);
    expect(fetchFn.mock.calls[0][0]).toBe('http://manager/logs?since=0');
  });

  it('uses the non-starting port fetch (never the auto-starting containerFetch) so a poll cannot resurrect the container', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const autoStart = vi.fn(async () => new RealResponse('{}', { status: 200 }));
    (m as unknown as { containerFetch: typeof autoStart }).containerFetch = autoStart;

    const portFetch = stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    expect(portFetch).toHaveBeenCalledTimes(1);
    expect(autoStart).not.toHaveBeenCalled();
  });

  it('arms the first pollLogs tick in startBuild (after the CAS to building)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    expect(scheduledTasks(m)).toContainEqual({ whenSeconds: 1, callback: 'pollLogs' });
    expect(scheduledTasks(m).some((t) => t.callback === 'enforceTimeout')).toBe(true);
  });

  it('timeboxes every pull with an abort signal so a wedged agent cannot stall the alarm chain or a teardown', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Decision: An agent that accepts the TCP connection but doesn't answer would hang the pull. On the poll path
    // that stalls the alarm chain, and on the teardown path it stalls the SIGTERM and SIGKILL, pinning a
    // fleet instance slot.
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchFn = stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    const init = fetchFn.mock.calls[0][2] as RequestInit | undefined;
    const signal = init?.signal as AbortSignal | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(timeoutSpy).toHaveBeenCalledWith(LOG_PULL_TIMEOUT_MS);
    // Decision: A healthy in-container buffer read is sub-millisecond, so a generous budget would be useless as
    // a bound.
    expect(LOG_PULL_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    timeoutSpy.mockRestore();
  });

  // Decision: Ordering is the assertion for the teardown drain, not only that a fetch happened: a drain that
  // runs after the signals reaches a dead agent.
  function stubPagedPortFetch(m: BuildManager, pages: Array<Array<LogRow>>) {
    let call = 0;
    const fetchFn = vi.fn(async (_url: string, _port?: number, _init?: RequestInit) => {
      const page = pages[call] ?? [];
      const more = call < pages.length - 1;
      call++;
      return new RealResponse(
        JSON.stringify({
          lines: page,
          lastSeq: page.at(-1)?.seq ?? 0,
          hasMore: more,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    return fetchFn;
  }

  function stubOrderedPortFetch(m: BuildManager, lines: Array<LogRow>) {
    const teardownAtPull: Array<{ stopped: number; destroyed: number }> = [];
    const fetchFn = vi.fn(async (_url: string, _port?: number, _init?: RequestInit) => {
      teardownAtPull.push({
        stopped: containerCalls.stopped,
        destroyed: containerCalls.destroyed,
      });
      return new RealResponse(JSON.stringify({ lines, lastSeq: lines.at(-1)?.seq ?? 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    return { fetchFn, teardownAtPull };
  }

  // Decision: `forceStopContainer` pulls once before its SIGTERM, for all three teardown sites. The agent's
  // exit-time `waitForLogDrain()` barrier doesn't run on this path: SIGTERM lands in
  // `onShutdownSignal`, which ends in `process.exit(1)` and skips main()'s `finally`. pollLogs can't
  // cover it either, since its next tick is up to POLL_SECONDS away and by then the `running` guard
  // returns early. Without this pull a cancelled or timed-out build loses up to a second of tail,
  // which on a fast failure is all of the error output.
  //
  // The agent's own `received SIGTERM` line is created after this pull and lost with the process, so
  // the DO writes its own `container terminated` marker instead.
  it('cancelBuild drains the log tail BEFORE the SIGTERM/SIGKILL teardown', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    const { fetchFn, teardownAtPull } = stubOrderedPortFetch(m, [
      { seq: 4, line: 'vp build failed: Unexpected token', stream: 'stderr', ts: 4 },
    ]);

    await m.cancelBuild('build superseded');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('http://manager/logs?since=0');
    expect(fetchFn.mock.calls[0][1]).toBe(4000);
    expect(teardownAtPull).toEqual([{ stopped: 0, destroyed: 0 }]);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
    expect(ctx._logs.map((r) => r.line)).toContain('vp build failed: Unexpected token');
    expect(logCursor(m)).toBe(4);
  });

  it('enforceTimeout drains the log tail BEFORE the SIGTERM/SIGKILL teardown', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    const { fetchFn, teardownAtPull } = stubOrderedPortFetch(m, [
      { seq: 9, line: 'still installing deps at the 10m mark', stream: 'stdout', ts: 9 },
    ]);

    await m.enforceTimeout();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(teardownAtPull).toEqual([{ stopped: 0, destroyed: 0 }]);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
    expect(ctx._logs.map((r) => r.line)).toContain('still installing deps at the 10m mark');
    expect(logCursor(m)).toBe(9);
  });

  // Decision: `builds.status` is the deploy token's authority: `middleware/auth.ts` honors a build-bound token
  // while the row is active, and `routes/deploy.ts` re-checks inside its go-live transaction. The drain
  // puts up to 2x LOG_DRAIN_BUDGET_MS before the SIGTERM, so an active row across it lets a `bwf
  // deploy` go live and then be recorded 'build timed out'. So revoke first.
  it('revokes the build row in Postgres BEFORE draining logs, so the deploy token cannot outlive the timeout', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    const order: Array<string> = [];
    vi.mocked(markBuildTerminalIfActive).mockImplementationOnce(async () => {
      order.push('revoke');
      return true;
    });
    const fetchFn = vi.fn(async () => {
      order.push('drain');
      return new RealResponse(JSON.stringify({ lines: [], lastSeq: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    await m.enforceTimeout();

    expect(order).toEqual(['revoke', 'drain']);
    expect(containerCalls.stopped).toBe(1);
  });

  it('still tears the container down when the Postgres revocation throws', async () => {
    // Decision: The revocation runs before the teardown, so it can't be allowed to gate it: a Hyperdrive blip
    // would leave a timed-out container alive on a pinned fleet slot.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('hyperdrive blip'));
    stubOrderedPortFetch(m, []);

    await expect(m.enforceTimeout()).rejects.toThrow('hyperdrive blip');
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });

  it('does not pull during teardown when the container is already gone', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Decision: A cancel that races an already-exited container: the agent's natural-exit `waitForLogDrain()`
    // already handed over the tail, so a pull here would be a doomed fetch.
    (m as unknown as { _containerRunning: boolean })._containerRunning = false;
    const { fetchFn } = stubOrderedPortFetch(m, []);

    await m.cancelBuild('build superseded');

    expect(fetchFn).not.toHaveBeenCalled();
    expect(ctx._logs).toHaveLength(0);
  });

  it('does not mark a natural exit that lands while the teardown drain is in progress', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    const fetchFn = vi.fn(async () => {
      // Decision: The agent reaches natural exit while the manager awaits its final pull. Its own barrier owns this
      // ending, and later container controls are no-ops that mustn't create a cancellation marker.
      (m as unknown as { _containerRunning: boolean })._containerRunning = false;
      return new RealResponse(
        JSON.stringify({
          lines: [{ seq: 1, line: 'bwf deploy exited with code 0', stream: 'stdout', ts: 1 }],
          lastSeq: 1,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    await m.cancelBuild('build superseded');

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(containerCalls.stopped).toBe(0);
    expect(containerCalls.destroyed).toBe(0);
    expect(ctx._logs.map((row) => row.line)).toEqual(['bwf deploy exited with code 0']);
  });

  // Decision: The DO's marker lands after the drained tail, so it reads as the last line.
  it('appends a terminated marker after the drained tail, naming the cancel reason', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    stubOrderedPortFetch(m, [
      { seq: 4, line: 'vp build failed: Unexpected token', stream: 'stderr', ts: 4 },
    ]);

    await m.cancelBuild('build superseded');

    expect(ctx._logs.map((r) => r.line)).toEqual([
      'vp build failed: Unexpected token',
      '[build-manager] container terminated: build superseded',
    ]);
    expect(ctx._logs[1].stream).toBe('stderr');
    expect(
      await (
        m as unknown as { readLogTailMarkdown: () => Promise<string | null> }
      ).readLogTailMarkdown(),
    ).toContain('[build-manager] container terminated: build superseded');
  });

  it('does not claim the container terminated when both control signals fail', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    stubOrderedPortFetch(m, []);

    const stop = vi
      .spyOn(m as unknown as { stop: () => Promise<void> }, 'stop')
      .mockRejectedValueOnce(new Error('SIGTERM control failed'));
    const destroy = vi
      .spyOn(m as unknown as { destroy: () => Promise<void> }, 'destroy')
      .mockRejectedValueOnce(new Error('SIGKILL control failed'));

    await m.cancelBuild('build superseded');

    expect(stop).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect((m as unknown as { _containerRunning: boolean })._containerRunning).toBe(true);
    expect(ctx._logs.map((row) => row.line)).not.toContain(
      '[build-manager] container terminated: build superseded',
    );
    // Decision: The failed owner releases both its signal gate and marker claim, so a later successful retry can
    // write the first true marker. `mockRejectedValueOnce` falls through to the real methods on this
    // second call.
    await m.cancelBuild('project deleted');
    expect((m as unknown as { _containerRunning: boolean })._containerRunning).toBe(false);
    expect(ctx._logs.map((row) => row.line)).toContain(
      '[build-manager] container terminated: build terminated out of band',
    );
  });

  // Decision: Each teardown site passes its own reason: a timeout isn't a cancellation.
  it('names the timeout (not a cancellation) in the terminated marker', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');

    stubOrderedPortFetch(m, [
      { seq: 9, line: 'still installing deps at the 10m mark', stream: 'stdout', ts: 9 },
    ]);

    await m.enforceTimeout();

    expect(ctx._logs.map((r) => r.line)).toEqual([
      'still installing deps at the 10m mark',
      '[build-manager] container terminated: build timed out',
    ]);
  });

  // Decision: `pullLogsOnce` reads `logCursor` to build the URL and writes it three awaits later, and a
  // `fetch()` isn't storage I/O, so it doesn't hold the DO input gate. A `cancelBuild` RPC can land
  // while a scheduled `pollLogs` is mid-fetch, and both would request the same `since` and ingest the
  // same lines. Nothing downstream dedupes (the source `seq` is stripped and `logs` is keyed by its own
  // AUTOINCREMENT), so duplicates would use up the stored-line and check-run budgets.
  //
  // Joining the in-flight pull would lose the tail instead, since the agent freezes a body at receipt
  // and there's no later poll on teardown. So teardown awaits the in-flight pull and then takes a
  // fresh snapshot. The tests below cover no duplicate, no loss, and no unbounded chain of pulls.
  it('sequences a teardown pull behind an already in-flight scheduled pull', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    // Decision: Hold the scheduled pull open at the fetch await, the window the DO input gate doesn't cover, so the
    // cancel path overlaps it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const firstPullEntered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    // Decision: Models the agent's handler, which snapshots at receipt (`lastSeq = logSeq`,
    // `logBuffer.filter(e => e.seq > since)`). A stub that ignores `since` would hide both the duplicate
    // and the staleness.
    const buffer: Array<{ seq: number; line: string; stream: string; ts: number }> = [
      { seq: 3, line: 'ERR_MODULE_NOT_FOUND', stream: 'stderr', ts: 3 },
    ];
    let calls = 0;
    const fetchFn = vi.fn(async (url: string, _port?: number, _init?: RequestInit) => {
      const since = Number(new URL(url).searchParams.get('since') ?? '0');
      const lines = buffer.filter((entry) => entry.seq > since);
      const lastSeq = buffer.at(-1)?.seq ?? since;
      calls += 1;
      if (calls === 1) {
        markEntered();
        await gate;
      }
      return new RealResponse(JSON.stringify({ lines, lastSeq }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    const poll = (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    await firstPullEntered;

    const cancel = m.cancelBuild('build superseded');
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    release();
    await Promise.all([poll, cancel]);

    // Decision: `forceStopContainer`'s explicit `await this.pullInFlight` keeps the teardown pull behind the
    // in-flight one, so it asks from the advanced cursor. The `??=` gate alone would let teardown join
    // the stale request and lose the tail. The gate's job is bounding concurrent teardowns, tested below.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][0]).toBe('http://manager/logs?since=0');
    expect(fetchFn.mock.calls[1][0]).toBe('http://manager/logs?since=3');
    expect(ctx._logs.filter((r) => r.line === 'ERR_MODULE_NOT_FOUND')).toHaveLength(1);
    expect(logCursor(m)).toBe(3);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });

  it('joins an active pull even when terminal-write failure forbids a fresh drain', async () => {
    const ctx = makeStubCtx();
    const m = makeManager(ctx, makeEnv());
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    let releaseJson!: () => void;
    const jsonGate = new Promise<void>((resolve) => {
      releaseJson = resolve;
    });
    let markJsonEntered!: () => void;
    const jsonEntered = new Promise<void>((resolve) => {
      markJsonEntered = resolve;
    });
    const fetchFn = vi.fn(async () => {
      return {
        ok: true,
        json: async () => {
          markJsonEntered();
          await jsonGate;
          return {
            lines: [{ seq: 1, line: 'active tail', stream: 'stderr', ts: 1 }],
            lastSeq: 1,
          };
        },
      } as Response;
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    const container = (
      m as unknown as {
        rawContainer: () => { getTcpPort: (port: number) => { fetch: typeof fetchFn } };
      }
    ).rawContainer();
    const activePull = (
      m as unknown as {
        pullLogsOnce: (target: {
          getTcpPort: (port: number) => { fetch: typeof fetchFn };
        }) => Promise<void>;
      }
    ).pullLogsOnce(container);
    await jsonEntered;

    const teardown = (
      m as unknown as {
        forceStopContainer: (
          reason: string,
          markerAuthoritative?: boolean,
          drainFirst?: boolean,
        ) => Promise<void>;
      }
    ).forceStopContainer('terminal write failed', true, false);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    // Decision: `drainFirst=false` forbids only a new request. The response already in the DO has to finish
    // parsing and ingesting before the signals or the final marker.
    expect(containerCalls.stopped).toBe(0);
    expect(containerCalls.destroyed).toBe(0);
    expect(ctx._logs).toHaveLength(0);

    releaseJson();
    await Promise.all([activePull, teardown]);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(ctx._logs.map((row) => row.line)).toEqual([
      'active tail',
      '[build-manager] container terminated: terminal write failed',
    ]);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });

  it('takes a FRESH snapshot after joining an in-flight pull, so lines written during it are not killed with the container', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const firstPullEntered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });

    const buffer: Array<{ seq: number; line: string; stream: string; ts: number }> = [
      { seq: 1, line: 'vite building for production', stream: 'stdout', ts: 1 },
    ];
    let calls = 0;
    const stoppedAtPull: Array<number> = [];
    const fetchFn = vi.fn(async (url: string, _port?: number, _init?: RequestInit) => {
      const since = Number(new URL(url).searchParams.get('since') ?? '0');
      const lines = buffer.filter((entry) => entry.seq > since);
      const lastSeq = buffer.at(-1)?.seq ?? since;
      stoppedAtPull.push(containerCalls.stopped);
      calls += 1;
      if (calls === 1) {
        markEntered();
        await gate;
      }
      return new RealResponse(JSON.stringify({ lines, lastSeq }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    const poll = (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    await firstPullEntered;

    buffer.push({
      seq: 2,
      line: 'ERROR: Unexpected token in vite.config.ts',
      stream: 'stderr',
      ts: 2,
    });

    const cancel = m.cancelBuild('build superseded');
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    release();
    await Promise.all([poll, cancel]);

    expect(ctx._logs.map((r) => r.line)).toEqual([
      'vite building for production',
      'ERROR: Unexpected token in vite.config.ts',
      '[build-manager] container terminated: build superseded',
    ]);
    expect(fetchFn.mock.calls[1][0]).toBe('http://manager/logs?since=1');
    expect(logCursor(m)).toBe(2);
    expect(stoppedAtPull).toEqual([0, 0]);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });

  it('coalesces two concurrent teardowns onto ONE fresh pull, so the bound stays per-teardown', async () => {
    // Decision: Don't turn the join into a serialized chain: N concurrent cancels (webhook supersede, the stale
    // reaper, the agent's POST /cancel) would cost N x LOG_PULL_TIMEOUT_MS before the SIGKILL.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const firstPullEntered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });

    let calls = 0;
    const fetchFn = vi.fn(async (url: string, _port?: number, _init?: RequestInit) => {
      const since = Number(new URL(url).searchParams.get('since') ?? '0');
      calls += 1;
      if (calls === 1) {
        markEntered();
        await gate;
      }
      return new RealResponse(JSON.stringify({ lines: [], lastSeq: since }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    const poll = (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    await firstPullEntered;

    const cancelA = m.cancelBuild('build superseded');
    const cancelB = m.cancelBuild('project deleted');
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    release();
    await Promise.all([poll, cancelA, cancelB]);

    expect(fetchFn).toHaveBeenCalledTimes(2);

    // Decision: Only the caller that won the terminal CAS can claim the marker, so one termination doesn't get two
    // contradictory explanations.
    const markers = ctx._logs
      .map((r) => r.line)
      .filter((line) => line.startsWith('[build-manager] container terminated:'));
    expect(markers).toHaveLength(1);
  });

  it('does not start a late drain after the shared teardown has entered container control', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let markStopEntered!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      markStopEntered = resolve;
    });
    (m as unknown as { stop: () => Promise<void> }).stop = vi.fn(async () => {
      containerCalls.stopped += 1;
      markStopEntered();
      await stopGate;
    });

    let releaseLatePull!: () => void;
    const latePullGate = new Promise<void>((resolve) => {
      releaseLatePull = resolve;
    });
    let fetches = 0;
    const fetchFn = vi.fn(async (url: string) => {
      fetches += 1;
      if (fetches === 1) {
        return new RealResponse(
          JSON.stringify({
            lines: [{ seq: 1, line: 'first tail', stream: 'stderr', ts: 1 }],
            lastSeq: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      await latePullGate;
      return new RealResponse(
        JSON.stringify({
          lines: [{ seq: 2, line: 'late line', stream: 'stderr', ts: 2 }],
          lastSeq: 2,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    const forceStop = (
      m as unknown as {
        forceStopContainer: (
          reason: string,
          markerAuthoritative?: boolean,
          drainFirst?: boolean,
        ) => Promise<void>;
      }
    ).forceStopContainer.bind(m);

    const first = forceStop('build superseded', true, true);
    await stopEntered;
    const second = forceStop('peer teardown', false, true);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    const fetchesBeforeSignal = fetches;

    releaseStop();
    await first;
    releaseLatePull();
    await second;

    expect(fetchesBeforeSignal).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(ctx._logs.map((row) => row.line)).toEqual([
      'first tail',
      '[build-manager] container terminated: build superseded',
    ]);
  });

  it('does not let a scheduled terminal backstop pull escape an active teardown', async () => {
    const ctx = makeStubCtx();
    const m = makeManager(ctx, makeEnv());
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let markStopEntered!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      markStopEntered = resolve;
    });
    (m as unknown as { stop: () => Promise<void> }).stop = vi.fn(async () => {
      containerCalls.stopped += 1;
      markStopEntered();
      await stopGate;
    });

    let releaseLatePull!: () => void;
    const latePullGate = new Promise<void>((resolve) => {
      releaseLatePull = resolve;
    });
    let fetches = 0;
    const fetchFn = vi.fn(async () => {
      fetches += 1;
      if (fetches === 1) {
        return new RealResponse(
          JSON.stringify({
            lines: [{ seq: 1, line: 'first tail', stream: 'stderr', ts: 1 }],
            lastSeq: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      await latePullGate;
      return new RealResponse(
        JSON.stringify({
          lines: [{ seq: 2, line: 'late line', stream: 'stderr', ts: 2 }],
          lastSeq: 2,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    const cancel = m.cancelBuild('build superseded');
    await stopEntered;
    const poll = (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    const fetchesDuringTeardown = fetches;

    releaseStop();
    await cancel;
    releaseLatePull();
    await poll;

    expect(fetchesDuringTeardown).toBe(1);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(ctx._logs.map((row) => row.line)).toEqual([
      'first tail',
      '[build-manager] container terminated: build superseded',
    ]);
  });

  it('keeps the first caller drain policy for the entire shared teardown', async () => {
    const ctx = makeStubCtx();
    const m = makeManager(ctx, makeEnv());
    await m.startBuild(makeConfig());

    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let markStopEntered!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      markStopEntered = resolve;
    });
    (m as unknown as { stop: () => Promise<void> }).stop = vi.fn(async () => {
      markStopEntered();
      await stopGate;
    });
    const fetchFn = vi.fn(
      async () =>
        new RealResponse(JSON.stringify({ lines: [], lastSeq: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    const forceStop = (
      m as unknown as {
        forceStopContainer: (
          reason: string,
          markerAuthoritative?: boolean,
          drainFirst?: boolean,
        ) => Promise<void>;
      }
    ).forceStopContainer.bind(m);

    const first = forceStop('startup failed before revocation', false, false);
    await stopEntered;
    const second = forceStop('peer requested a drain', false, true);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(fetchFn).not.toHaveBeenCalled();

    releaseStop();
    await Promise.all([first, second]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('emits no marker from a cancel whose peer teardown already claimed it', async () => {
    // Decision: A startup-failure teardown has already made the row terminal and is still draining a live
    // container when a cancel arrives. Having no CAS to lose mustn't count as authority, or both
    // teardowns append a different reason for the same termination.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;

    // Decision: A startup-failure teardown claims the marker synchronously at the top of the catch, before
    // `setStatus`. Model both halves: exclusion here comes from the claim, not the status.
    (m as unknown as { claimTerminationMarker: () => boolean }).claimTerminationMarker();
    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('failed');
    stubOrderedPortFetch(m, []);

    await m.cancelBuild('project deleted');

    const markers = ctx._logs
      .map((r) => r.line)
      .filter((line) => line.startsWith('[build-manager] container terminated:'));
    expect(markers).toEqual([]);
    expect(containerCalls.stopped).toBe(1);
  });

  it('emits the marker when a cancel kills the live container onError left behind', async () => {
    // Decision: `onError` is a terminal transition that doesn't stop the container and doesn't reserve the marker,
    // so a later cancel sees `shouldTerminalize === false`. Gating the claim on that status killed a
    // container that was still producing output and wrote no explanation.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;

    stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);
    await m.onError(new Error('container runtime error'));
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
    expect((m as unknown as { _containerRunning: boolean })._containerRunning).toBe(true);
    ctx._logs.length = 0;
    const { fetchFn } = stubOrderedPortFetch(m, []);

    await m.cancelBuild('project deleted');

    const markers = ctx._logs
      .map((r) => r.line)
      .filter((line) => line.startsWith('[build-manager] container terminated:'));
    expect(markers).toEqual(['[build-manager] container terminated: build terminated out of band']);
    // Decision: onError already committed the terminal row, so the bounded verification keeps the teardown tail
    // drain on this path.
    expect(fetchFn).toHaveBeenCalled();
    expect(containerCalls.stopped).toBe(1);
  });

  it('still emits the marker when an external caller pre-terminalized the row', async () => {
    // Decision: The normal cancellation path: `cancelContainerBuildDos` commits the terminal row and only then calls
    // this RPC. That DB-first order is what revokes the deploy token, so the CAS here always loses.
    // Losing it doesn't mean someone else explained the kill, so the marker still has to be written.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;

    vi.mocked(markBuildTerminalIfActive).mockResolvedValueOnce(false);
    stubOrderedPortFetch(m, []);

    await m.cancelBuild('build superseded');

    // Decision: The reason defers to the CAS though ownership doesn't: losing it means the outcome was recorded
    // elsewhere, and this site's `reason` would contradict the check run that finalizes from it.
    const markers = ctx._logs
      .map((r) => r.line)
      .filter((line) => line.startsWith('[build-manager] container terminated:'));
    expect(markers).toEqual(['[build-manager] container terminated: build terminated out of band']);
    expect(containerCalls.stopped).toBe(1);
  });

  it('does not assert a startup reason it lost the CAS for', async () => {
    // Decision: This catch claims the marker synchronously, before any await, so an external cancel that arrives
    // later finds it taken and stays silent. The local reason is then the only explanation, under a
    // check run that finalized to the recorded cancellation, so it has to defer to the CAS too.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    vi.mocked(markBuildTerminalIfActive).mockResolvedValueOnce(false);
    const scheduleSpy = vi
      .spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule')
      .mockRejectedValueOnce(new Error('schedule arming failed'));
    stubOrderedPortFetch(m, []);

    await expect(m.startBuild(makeConfig())).rejects.toThrow('schedule arming failed');

    const markers = ctx._logs
      .map((r) => r.line)
      .filter((line) => line.startsWith('[build-manager] container terminated:'));
    expect(markers).toEqual(['[build-manager] container terminated: build terminated out of band']);

    scheduleSpy.mockRestore();
  });

  it('skips the drain when the terminal write never settled, so the live token dies sooner', async () => {
    // Decision: The drain sits before the SIGTERM and costs up to 2x LOG_DRAIN_BUDGET_MS. That's only safe
    // because the row was revoked first (`builds.status` is the deploy token's authority). When the
    // revocation throws or times out the row stays active and the token stays honored, so there's no
    // drain without a revocation.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('hyperdrive blip'));
    const { fetchFn } = stubOrderedPortFetch(m, []);

    await expect(m.enforceTimeout()).rejects.toThrow('hyperdrive blip');

    expect(fetchFn).not.toHaveBeenCalled();
    expect(containerCalls.stopped).toBe(1);
  });

  it('uses a neutral marker when an unknown timeout revocation loses to cancellation', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._kv.set('checkRunId', '99001');
    vi.mocked(completeCheckRun).mockClear();

    // Decision: A deadline or transport error doesn't cancel the underlying CAS. Before its result is known,
    // another terminal writer wins with the authoritative outcome.
    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(
      new Error('build b1: terminal status write did not settle within 5000ms'),
    );
    dbState.status.set('b1', 'cancelled');
    stubOrderedPortFetch(m, []);

    await expect(m.enforceTimeout()).rejects.toThrow('did not settle');

    expect(ctx._logs.map((row) => row.line)).toContain(
      '[build-manager] container terminated: build terminated out of band',
    );
    expect(vi.mocked(completeCheckRun)).toHaveBeenCalledOnce();
    expect(vi.mocked(completeCheckRun).mock.calls[0][4]).toMatchObject({
      conclusion: 'cancelled',
    });
  });

  it('still explains the kill when a peer teardown destroyed the container first', async () => {
    // Decision: A cancel arrives while enforceTimeout is parked on Hyperdrive. The cancel sees the terminal local
    // status, so it doesn't claim, drains and destroys. enforceTimeout then resumes holding the claim
    // but finds `running === false`.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;

    let releaseRevocation!: () => void;
    const revocationParked = new Promise<void>((resolve) => {
      releaseRevocation = resolve;
    });
    vi.mocked(markBuildTerminalIfActive).mockImplementationOnce(async () => {
      await revocationParked;
      return true;
    });
    const { fetchFn } = stubOrderedPortFetch(m, []);

    const timeout = m.enforceTimeout();
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await m.cancelBuild('project deleted');
    // Decision: The DO-local status is already failed, but the timeout CAS is still parked and Postgres still
    // authorizes the deploy token. The peer signals at once instead of draining in that window.
    expect(fetchFn).not.toHaveBeenCalled();
    const beforeOwner = (await (
      await m.fetch(new Request('https://manager/logs?since=0'))
    ).json()) as { logsComplete: boolean | null };
    expect(beforeOwner.logsComplete).toBe(false);
    releaseRevocation();
    await timeout;

    const markers = ctx._logs
      .map((r) => r.line)
      .filter((line) => line.startsWith('[build-manager] container terminated:'));
    expect(markers).toEqual(['[build-manager] container terminated: build timed out']);
    const afterOwner = (await (
      await m.fetch(new Request('https://manager/logs?since=0'))
    ).json()) as { lines: Array<LogRow>; logsComplete: boolean | null };
    expect(afterOwner.logsComplete).toBe(true);
    expect(afterOwner.lines.at(-1)?.line).toBe(
      '[build-manager] container terminated: build timed out',
    );
  });

  it('explains the kill on a startup-failure teardown, and skips its drain on failed revocation', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    vi.spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule').mockRejectedValueOnce(
      new Error('schedule arming failed'),
    );
    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('hyperdrive blip'));
    const { fetchFn } = stubOrderedPortFetch(m, []);

    // Decision: The catch rethrows `terminalError` ahead of the original cause once teardown has run.
    await expect(m.startBuild(makeConfig())).rejects.toThrow('hyperdrive blip');

    const markers = ctx._logs
      .map((r) => r.line)
      .filter((line) => line.startsWith('[build-manager] container terminated:'));
    expect(markers).toEqual(['[build-manager] container terminated: build terminated out of band']);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('finalizes the check run when the terminal write commits after its deadline', async () => {
    // Decision: `withDeadline` rejects at TERMINAL_WRITE_TIMEOUT_MS but can't cancel the query, so a slow write can
    // commit afterward. The rejection leaves `terminal` null, so nothing finalizes, and once the late
    // write lands the row is terminal, so retries and `onStop` return early and the stale reaper (active
    // rows only) skips it. Without the re-read the check run stays `in_progress`.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    vi.mocked(completeCheckRun).mockClear();
    // Decision: The check run has to be resolvable, or the PATCH no-ops for want of an id and the test would pass
    // for the wrong reason.
    ctx._kv.set('checkRunId', '99001');

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(
      new Error('build b1: terminal status write did not settle within 5000ms'),
    );
    dbState.status.set('b1', 'failed');
    stubOrderedPortFetch(m, []);

    await expect(m.enforceTimeout()).rejects.toThrow('did not settle');

    expect(vi.mocked(completeCheckRun)).toHaveBeenCalledTimes(1);
  });

  it('finalizes the check run when the terminal write commits AFTER the re-read', async () => {
    // Decision: The likelier order: the re-read runs within milliseconds of the 5s rejection, so a query that
    // missed that deadline usually hasn't committed yet. A single re-read sees an active row and
    // returns, and when the write lands every other actor has returned early on the DO-local terminal
    // status. Reconciling once would leave the check `in_progress`.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    vi.mocked(completeCheckRun).mockClear();
    ctx._kv.set('checkRunId', '99001');

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(
      new Error('build b1: terminal status write did not settle within 5000ms'),
    );
    dbState.status.set('b1', 'building');
    stubOrderedPortFetch(m, []);
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await expect(m.enforceTimeout()).rejects.toThrow('did not settle');

    expect(vi.mocked(completeCheckRun)).not.toHaveBeenCalled();
    expect(scheduledTasks(m).some((t) => t.callback === 'reconcileTerminalWrite')).toBe(true);

    dbState.status.set('b1', 'failed');
    await runDueSchedules(m);

    expect(vi.mocked(completeCheckRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(completeCheckRun).mock.calls[0][4]).toMatchObject({
      conclusion: 'failure',
    });
  });

  it('keeps looking while the terminal write has still not landed', async () => {
    // Decision: The re-arm has to survive a pass that learns nothing. It ends on its own: a write that really
    // died leaves the row active until the hourly stale reaper marks it `failed`, and the next pass
    // finalizes from that.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    vi.mocked(completeCheckRun).mockClear();
    ctx._kv.set('checkRunId', '99001');
    dbState.status.set('b1', 'building');

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    await m.reconcileTerminalWrite();

    expect(vi.mocked(completeCheckRun)).not.toHaveBeenCalled();
    expect(scheduledTasks(m).filter((t) => t.callback === 'reconcileTerminalWrite')).toHaveLength(
      1,
    );

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    await m.reconcileTerminalWrite();
    expect(scheduledTasks(m).filter((t) => t.callback === 'reconcileTerminalWrite')).toHaveLength(
      1,
    );

    dbState.status.set('b1', 'failed');
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    await m.reconcileTerminalWrite();
    expect(vi.mocked(completeCheckRun)).toHaveBeenCalledTimes(1);
    expect(scheduledTasks(m).some((t) => t.callback === 'reconcileTerminalWrite')).toBe(false);
  });

  it('reuses the check-run id from the bounded reconciliation row', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    ctx._kv.delete('checkRunId');
    (m as unknown as { activeCheckRunId: string | null }).activeCheckRunId = null;
    vi.mocked(getBuild).mockClear();
    vi.mocked(completeCheckRun).mockClear();
    vi.mocked(getBuild).mockResolvedValueOnce({
      id: 'b1',
      created_at: dbState.createdAt,
      status: 'failed',
      check_run_id: '99001',
    } as never);

    await m.reconcileTerminalWrite();

    expect(vi.mocked(getBuild)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(completeCheckRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(completeCheckRun).mock.calls[0][3]).toBe('99001');
  });

  it('does not re-read a bounded reconciliation row whose check-run id is null', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    ctx._kv.delete('checkRunId');
    (m as unknown as { activeCheckRunId: string | null }).activeCheckRunId = null;
    vi.mocked(getBuild).mockClear();
    vi.mocked(completeCheckRun).mockClear();
    vi.mocked(getBuild).mockResolvedValueOnce({
      id: 'b1',
      created_at: dbState.createdAt,
      status: 'failed',
      check_run_id: null,
    } as never);

    await m.reconcileTerminalWrite();

    expect(vi.mocked(getBuild)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(completeCheckRun)).not.toHaveBeenCalled();
  });

  it('stops reconciling once the build row is gone', async () => {
    // Decision: `deleteProjectCascade` deletes build rows during project teardown, so an armed reconcile can
    // outlive its row. A missing row isn't a pending one: no write or reaper will touch it, so
    // re-arming would fire an alarm every RECONCILE_RETRY_SECONDS forever.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    vi.mocked(completeCheckRun).mockClear();
    dbState.status.delete('b1');

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    await m.reconcileTerminalWrite();

    expect(scheduledTasks(m).some((t) => t.callback === 'reconcileTerminalWrite')).toBe(false);
    expect(vi.mocked(completeCheckRun)).not.toHaveBeenCalled();
  });

  it('re-arms when the reconciliation read itself never settles', async () => {
    // Decision: This runs when Postgres is already stalling (the stall that made the terminal write miss its
    // deadline). An unbounded SELECT that pends reaches neither `schedule()` call, so the invocation
    // dies with no retry armed and the check run is orphaned.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    vi.mocked(completeCheckRun).mockClear();
    vi.mocked(getBuild).mockReturnValueOnce(new Promise(() => {}) as never);

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    vi.useFakeTimers();
    try {
      const pending = m.reconcileTerminalWrite();
      await vi.advanceTimersByTimeAsync(TERMINAL_WRITE_TIMEOUT_MS + 10);
      await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(scheduledTasks(m).some((t) => t.callback === 'reconcileTerminalWrite')).toBe(true);
  });

  it('drains every page of a backlog in one pull, not one page per tick', async () => {
    // Decision: The agent caps a response so an oversized body can't exceed the per-request timeout. At one page
    // per POLL_SECONDS tick, acknowledgement would lag and a deep backlog would need many callbacks.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._logs.length = 0;

    const pages = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [
      { seq: n, line: `page-${n}`, stream: 'stdout' as const, ts: n },
    ]);
    const fetchFn = stubPagedPortFetch(m, pages);

    await (m as unknown as { pullLogsOnce: (c: unknown) => Promise<void> }).pullLogsOnce({
      getTcpPort: () => ({ fetch: fetchFn }),
      running: true,
    });

    // Decision: One final empty request carries `since=<last ingested seq>` back to the agent, acknowledging the
    // last page without waiting for another scheduled callback.
    expect(fetchFn).toHaveBeenCalledTimes(pages.length + 1);
    expect(fetchFn.mock.calls.at(-1)?.[0]).toBe(`http://manager/logs?since=${pages.length}`);
    expect(ctx._logs.map((r) => r.line)).toEqual(pages.map((_, i) => `page-${i + 1}`));
  });

  it('bounds the whole paginated drain by wall clock, not per page', async () => {
    // Decision: The page cap bounds work, not latency. A fresh `AbortSignal.timeout` per request lets
    // MAX_LOG_PULL_PAGES pages that each answer just under LOG_PULL_TIMEOUT_MS hold one callback for 64s,
    // and `forceStopContainer` runs two of them before a SIGTERM. `pollLogs` and `enforceTimeout` run one
    // at a time, so that also delays the Postgres revocation.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._logs.length = 0;

    // Decision: A productive but slow agent: each page delivers and reports more, so neither the `hasMore` guard
    // nor the cursor-not-advancing guard fires. A wedged agent aborts at the per-request timeout instead.
    const perPageMs = 1500;
    let clock = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let seq = 0;
    const fetchFn = vi.fn(async (_url: string, _port?: number, _init?: RequestInit) => {
      clock += perPageMs;
      seq += 1;
      return new RealResponse(
        JSON.stringify({
          lines: [{ seq, line: `page-${seq}`, stream: 'stdout', ts: seq }],
          lastSeq: seq,
          hasMore: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    try {
      await (m as unknown as { pullLogsOnce: (c: unknown) => Promise<void> }).pullLogsOnce({
        getTcpPort: () => ({ fetch: fetchFn }),
        running: true,
      });
    } finally {
      nowSpy.mockRestore();
    }

    const affordable = Math.ceil(LOG_DRAIN_BUDGET_MS / perPageMs);
    expect(fetchFn.mock.calls.length).toBe(affordable);
    expect(fetchFn.mock.calls.length).toBeLessThan(MAX_LOG_PULL_PAGES);
    expect(fetchFn.mock.calls.at(-1)?.[0]).toBe(`http://manager/logs?since=${affordable - 1}`);
  });

  // Decision: A deployed Worker's clock advances on I/O, not during CPU work, so time spent parsing, inserting
  // and fanning out between fetches is invisible to LOG_DRAIN_BUDGET_MS. Freezing `Date.now()`
  // reproduces that, so what stops the loop is a deterministic work bound.
  function withFrozenWorkerClock<T>(run: () => Promise<T>): Promise<T> {
    const frozen = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => frozen);
    return run().finally(() => spy.mockRestore());
  }

  function stubEndlessPages(
    m: BuildManager,
    rows: number,
    line: (seq: number) => string = (seq) => `line-${seq}`,
  ): ReturnType<typeof vi.fn> {
    let seq = 0;
    const fn = vi.fn(async (_url: string, _port?: number, _init?: RequestInit) => {
      const lines = Array.from({ length: rows }, () => {
        seq += 1;
        return { seq, line: line(seq), stream: 'stdout', ts: seq };
      });
      return new RealResponse(JSON.stringify({ lines, lastSeq: seq, hasMore: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fn })._portFetch = fn;
    return fn;
  }

  function pullOnce(m: BuildManager, fetchFn: unknown): Promise<boolean> {
    return (m as unknown as { pullLogsOnce: (c: unknown) => Promise<boolean> }).pullLogsOnce({
      getTcpPort: () => ({ fetch: fetchFn }),
    });
  }

  it('bounds ingestion by a deterministic sink budget the frozen Workers clock cannot see', async () => {
    // Decision: LOG_DRAIN_BUDGET_MS bounds latency, not work, and can't: its clock stands still while the CPU
    // runs. With an instant agent, a maximum-shape backlog would put MAX_LOG_PULL_PAGES x
    // MAX_LOG_RESPONSE_LINES rows through JSON.parse, SQLite and the WS fan-out in one callback, before
    // a teardown's SIGTERM.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._logs.length = 0;

    // Decision: No subscribers and short lines, so a row costs one sink op and the expected page count is the
    // budget divided by the agent's page cap.
    const fetchFn = stubEndlessPages(m, MAX_LOG_RESPONSE_LINES);
    const pages = MAX_LOG_SINK_OPS_PER_DRAIN / MAX_LOG_RESPONSE_LINES;

    await withFrozenWorkerClock(() => pullOnce(m, fetchFn));

    expect(fetchFn).toHaveBeenCalledTimes(pages);
    expect(pages).toBeLessThan(MAX_LOG_PULL_PAGES);
    expect(logCursor(m)).toBe(MAX_LOG_SINK_OPS_PER_DRAIN);
    expect(ctx._logs.length).toBe(MAX_LOG_SINK_OPS_PER_DRAIN);

    await withFrozenWorkerClock(() => pullOnce(m, fetchFn));
    expect(fetchFn.mock.calls[pages][0]).toBe(
      `http://manager/logs?since=${MAX_LOG_SINK_OPS_PER_DRAIN}`,
    );
    const seqs = ctx._logs.map((row) => Number(row.line.slice('line-'.length)));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => seqs[0] + i));
  });

  it('charges WebSocket fan-out against the sink budget', async () => {
    // Decision: Each ingested row is one insert plus one send per live subscriber, so a page's CPU cost scales
    // with the tail audience. A row-count budget would let N subscribers multiply the work by (1 + N).
    const rowsPerPage = 1000;
    const subscribers = 4;

    const quiet = makeStubCtx();
    const quietManager = makeManager(quiet, makeEnv());
    await quietManager.startBuild(makeConfig());
    const quietFetch = stubEndlessPages(quietManager, rowsPerPage);
    await withFrozenWorkerClock(() => pullOnce(quietManager, quietFetch));

    const watched = makeStubCtx();
    const watchedManager = makeManager(watched, makeEnv());
    await watchedManager.startBuild(makeConfig());
    for (let i = 0; i < subscribers; i++) {
      await watchedManager.fetch(
        new Request('https://manager/', { headers: { Upgrade: 'websocket' } }),
      );
    }
    expect(watched._sockets.length).toBe(subscribers);
    const watchedFetch = stubEndlessPages(watchedManager, rowsPerPage);
    await withFrozenWorkerClock(() => pullOnce(watchedManager, watchedFetch));

    expect(quietFetch).toHaveBeenCalledTimes(MAX_LOG_SINK_OPS_PER_DRAIN / rowsPerPage);
    expect(watchedFetch).toHaveBeenCalledTimes(
      MAX_LOG_SINK_OPS_PER_DRAIN / (rowsPerPage * (1 + subscribers)),
    );
  });

  it('charges row payload bytes against the sink budget', async () => {
    // Decision: A row-count bound doesn't bound the work either: the agent caps a page at MAX_LOG_RESPONSE_BYTES,
    // not a row count, so two 1 MiB lines are a full page a per-row budget prices at 2.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._logs.length = 0;

    const megabyteLine = 'x'.repeat(LOG_SINK_OP_PAYLOAD_BYTES * 1024);
    const rowCost = megabyteLine.length / LOG_SINK_OP_PAYLOAD_BYTES;
    const rowsPerPage = MAX_LOG_RESPONSE_BYTES / megabyteLine.length;
    const fetchFn = stubEndlessPages(m, rowsPerPage, () => megabyteLine);

    await withFrozenWorkerClock(() => pullOnce(m, fetchFn));

    const pages = Math.ceil(MAX_LOG_SINK_OPS_PER_DRAIN / (rowsPerPage * rowCost));
    expect(fetchFn).toHaveBeenCalledTimes(pages);
    expect(pages).toBeLessThan(MAX_LOG_PULL_PAGES);
    expect(ctx._logs.length).toBe(pages * rowsPerPage);
  });

  it('caps the teardown drain so the SIGTERM is not held behind unbounded sink work', async () => {
    // Decision: `forceStopContainer` drains before the stop/destroy that frees a fleet slot. On a frozen clock the
    // drain has no deadline it can see, so only the work budget returns control to the signals.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._logs.length = 0;
    containerCalls.stopped = 0;

    const fetchFn = stubEndlessPages(m, MAX_LOG_RESPONSE_LINES);

    await withFrozenWorkerClock(() => m.cancelBuild('user cancelled'));

    expect(fetchFn.mock.calls.length).toBe(MAX_LOG_SINK_OPS_PER_DRAIN / MAX_LOG_RESPONSE_LINES);
    expect(containerCalls.stopped).toBe(1);
    expect(ctx._logs.map((row) => row.line)).toContain(
      '[build-manager] container terminated: user cancelled',
    );
  });

  it('re-arms the single-flight gate so a later pull is not swallowed', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Decision: Coalescing mustn't become a one-shot latch: the gate is released in a `finally`, so the next tick
    // pulls again.
    const fetchFn = stubPortFetch(m, [
      { lines: [{ seq: 1, line: 'first', stream: 'stdout', ts: 1 }], lastSeq: 1 },
      { lines: [{ seq: 2, line: 'second', stream: 'stdout', ts: 2 }], lastSeq: 2 },
    ]);

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][0]).toBe('http://manager/logs?since=1');
    expect(ctx._logs.map((r) => r.line)).toEqual(['first', 'second']);
  });

  it('releases the single-flight gate even when the pull throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Decision: A rejected pull mustn't leave `pullInFlight` pinned to a settled promise, which would mute the log
    // loop for the rest of the build.
    const fetchFn = stubPortFetch(m, [
      new Error('agent unreachable'),
      { lines: [{ seq: 1, line: 'back online', stream: 'stdout', ts: 1 }], lastSeq: 1 },
    ]);

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(ctx._logs.map((r) => r.line)).toEqual(['back online']);
  });

  it('tears the container down even when the teardown drain pull throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    // Decision: A wedged or unreachable agent mustn't cost the SIGKILL: an escaping throw here would skip
    // stop()/destroy() and leave the container pinning a fleet slot.
    const fetchFn = stubPortFetch(m, [new Error('agent unreachable')]);

    await expect(m.cancelBuild('build superseded')).resolves.toBeUndefined();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });
});

describe('BuildManager.ingestLines (the pull-loop sink)', () => {
  it('upgrades a legacy log table once without fabricating a final delimiter', async () => {
    const ctx = makeStubCtx({
      legacyLogSchema: true,
      initialLogs: [{ seq: 1, line: '\u001b[?1049hERR', stream: 'stdout', ts: 1 }],
    });
    const m = makeManager(ctx, makeEnv());
    const readTail = () =>
      (m as unknown as { readLogTailMarkdown: () => Promise<string | null> }).readLogTailMarkdown;

    const first = await readTail().call(m);
    expect(parseFence(first as string).content).toEqual(['ERR']);
    await readTail().call(m);
    expect(
      ctx._sqlQueries.filter((query) => query.startsWith('ALTER TABLE logs ADD COLUMN')),
    ).toHaveLength(1);
    expect(ctx._logs[0].lineEnding).toBeNull();
  });

  it('inserts each line into SQLite and broadcasts it (sole producer is pollLogs)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    server.sent = [];

    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'a', stream: 'stdout', ts: 1 } as unknown as LogRow,
      { line: 'b', stream: 'stderr', ts: 2 } as unknown as LogRow,
    ]);

    expect(ctx._logs.map((r) => r.line)).toEqual(['a', 'b']);
    const sent = server.sent.map((s) => JSON.parse(s));
    expect(sent).toContainEqual({ type: 'log', line: 'a', stream: 'stdout', ts: 1 });
    expect(sent).toContainEqual({ type: 'log', line: 'b', stream: 'stderr', ts: 2 });
  });
});

// Decision: Six backticks is the minimum fence, so it survives log lines that contain ``` (build tools echo
// markdown). Runs of 6 or more backticks grow the fence past the longest run.
const SIX_BACKTICKS = '``````';

// Decision: GitHub checks output.text in UTF-8 bytes ("maximum bytesize of 65535"), so the byte-cap tests
// measure results the way GitHub does.
const utf8 = new TextEncoder();

// Decision: A manual `String.prototype.isWellFormed()` (typing it needs lib es2024, which this package's
// tsconfig doesn't enable). True when the string holds an unpaired surrogate, which is what a byte
// truncation that splits an emoji pair leaves behind.
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd8_00 && code <= 0xdb_ff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc_00 && next <= 0xdf_ff)) {
        return true;
      }
      i++; /* Decision: A complete pair: skip its low half. */
    } else if (code >= 0xdc_00 && code <= 0xdf_ff) {
      return true;
    }
  }
  return false;
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
}

// Decision: Fence delimiters are dynamic (max(6, longest content run + 1)), so parse them from the output
// instead of assuming six.
function parseFence(out: string): { fenceLen: number; content: Array<string> } {
  const rendered = out.split('\n');
  const openIdx = rendered.findIndex((line) => /^`+text$/.test(line));
  expect(openIdx).toBeGreaterThan(-1);
  const fenceLen = rendered[openIdx].length - 'text'.length;
  expect(rendered.at(-1)).toBe('`'.repeat(fenceLen));
  return { fenceLen, content: rendered.slice(openIdx + 1, rendered.length - 1) };
}

describe('formatLogTailMarkdown (pure check-run output.text renderer)', () => {
  it('returns null when nothing was captured (PATCH omits text)', async () => {
    expect(await formatLogTailMarkdown([], 0)).toBe(null);
  });

  it('renders header + six-backtick text fence, lines in given order, no marker when all captured lines are shown', async () => {
    expect(await formatLogTailMarkdown(['a', 'b', 'c'], 3)).toBe(
      `**Last 3 log lines:**\n\n${SIX_BACKTICKS}text\na\nb\nc\n${SIX_BACKTICKS}`,
    );
  });

  it('adds the omission marker when more lines were captured than are rendered', async () => {
    expect(await formatLogTailMarkdown(['b', 'c'], 5)).toBe(
      `**Last 2 log lines:**\n\n_…earlier lines omitted._\n\n${SIX_BACKTICKS}text\nb\nc\n${SIX_BACKTICKS}`,
    );
  });

  it('drops the OLDEST lines until the joined content fits the char cap (result under GitHub 65535)', async () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) => `${String(i).padStart(4, '0')}${'x'.repeat(996)}`,
    );
    const out = await formatLogTailMarkdown(lines, 100);
    expect(out).not.toBe(null);
    expect(out).toContain('**Last 59 log lines:**');
    expect(out).toContain('_…earlier lines omitted._');
    expect(out).toContain(lines[99]);
    expect(out).toContain(lines[41]);
    expect(out).not.toContain(lines[40]);
    expect((out as string).length).toBeLessThan(65_535);
  });

  it('keeps the LAST 60000 chars of a single over-cap line', async () => {
    const big = 'h'.repeat(5000) + 't'.repeat(CHECK_RUN_LOG_TAIL_MAX_BYTES);
    expect(await formatLogTailMarkdown([big], 1)).toBe(
      `**Last 1 log lines:**\n\n${SIX_BACKTICKS}text\n${'t'.repeat(CHECK_RUN_LOG_TAIL_MAX_BYTES)}\n${SIX_BACKTICKS}`,
    );
    const atCap = 'e'.repeat(CHECK_RUN_LOG_TAIL_MAX_BYTES);
    expect(await formatLogTailMarkdown([atCap], 1)).toContain(`\n${atCap}\n`);
  });

  it('grows the fence to 7 backticks when a content line contains a 6-backtick run (no breakout)', async () => {
    const line = `fence bait: ${SIX_BACKTICKS} tail`;
    const out = (await formatLogTailMarkdown([line], 1)) as string;
    const { fenceLen, content } = parseFence(out);
    expect(fenceLen).toBe(7);
    expect(content).toEqual([line]);
    expect(Math.max(...content.map(longestBacktickRun))).toBeLessThan(fenceLen);
  });

  it('grows the fence to 13 backticks for a 12-backtick content run', async () => {
    const out = (await formatLogTailMarkdown(['a', `x${'`'.repeat(12)}y`, 'b'], 3)) as string;
    const { fenceLen, content } = parseFence(out);
    expect(fenceLen).toBe(13);
    expect(content).toEqual(['a', `x${'`'.repeat(12)}y`, 'b']);
  });

  it('keeps the fence at exactly six backticks when the content has no backticks', async () => {
    const { fenceLen } = parseFence((await formatLogTailMarkdown(['plain', 'lines'], 2)) as string);
    expect(fenceLen).toBe(6);
  });

  it('holds the WHOLE string under GitHub’s 65535 cap for a pathological all-backtick line', async () => {
    const out = (await formatLogTailMarkdown(['`'.repeat(61_000)], 1)) as string;
    expect(out.length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
    expect(out.split('\n')[0]).toBe('**Last 1 log lines:**');
    const { fenceLen, content } = parseFence(out);
    expect(content.length).toBeGreaterThan(0);
    expect(fenceLen).toBeGreaterThan(Math.max(...content.map(longestBacktickRun)));
  });

  // Decision: GitHub checks output.text in bytes, not UTF-16 code units (its 422 reads "maximum bytesize of
  // 65535"). CJK is 3 bytes per code unit and emoji 4 bytes per 2 units, so caps measured in units let
  // such content pass GitHub's real limit.

  it('drops oldest lines by UTF-8 BYTE measure, not code units (CJK content)', async () => {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `${String(i).padStart(4, '0')}${'语'.repeat(998)}`,
    );
    const out = (await formatLogTailMarkdown(lines, 40)) as string;
    expect(out).toContain('**Last 20 log lines:**');
    expect(out).toContain('_…earlier lines omitted._');
    expect(out).toContain(lines[39]);
    expect(out).toContain(lines[20]);
    expect(out).not.toContain(lines[19]);
    expect(utf8.encode(out).length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
  });

  it('tail-truncates a lone CJK line to its LAST ~60000 UTF-8 bytes (under 65535 total)', async () => {
    const out = (await formatLogTailMarkdown(['好'.repeat(30_000)], 1)) as string;
    expect(utf8.encode(out).length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
    const { content } = parseFence(out);
    expect(content).toHaveLength(1);
    expect(/^好+$/.test(content[0])).toBe(true);
    const contentBytes = utf8.encode(content[0]).length;
    expect(contentBytes).toBeLessThanOrEqual(60_000);
    expect(contentBytes).toBeGreaterThanOrEqual(59_990);
  });

  it('never leaves a split surrogate pair at a truncation cut (emoji at the boundary)', async () => {
    // Decision: '🚀' is 2 UTF-16 units and 4 UTF-8 bytes, so the byte cap cuts inside the emoji run. A cut
    // mid-pair would leave a lone surrogate (re-encoded as a 3-byte U+FFFD).
    const out = (await formatLogTailMarkdown(['🚀'.repeat(20_000)], 1)) as string;
    expect(utf8.encode(out).length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('converges the WHOLE string under 65535 BYTES when the dynamic fence eats the byte headroom (emoji + backtick run)', async () => {
    // Decision: 13500 emoji (54000 bytes) plus a 6000-backtick run is exactly 60000 bytes, so it passes the content
    // cap. The 6001-backtick fence then pushes the byte length past 65535 while the UTF-16 length stays
    // far under, so the loop has to cut the line by bytes without splitting an emoji pair.
    const out = (await formatLogTailMarkdown(
      ['🚀'.repeat(13_500) + '`'.repeat(6000)],
      1,
    )) as string;
    expect(utf8.encode(out).length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
    expect(hasLoneSurrogate(out)).toBe(false);
    const { fenceLen, content } = parseFence(out);
    expect(fenceLen).toBeGreaterThan(Math.max(...content.map(longestBacktickRun)));
  });
});

// Decision: A terminal consumes escape sequences, but a markdown code fence prints them. The container
// captures build output verbatim (piped, not a pty), so colors and animations land in the check run
// as literal `^[[32m` / `^[[1G` noise, with erased spinner frames glued onto one line (the agent
// splits on CR/LF, and a clack spinner separates frames with `ESC[1G ESC[J` and no newline).
describe('renderCapturedLog (terminal-visible text for the check run)', () => {
  const ESC = '\u001b';

  it('leaves a plain line untouched', async () => {
    expect(await renderCapturedLog('[build-agent] source extracted')).toBe(
      '[build-agent] source extracted',
    );
  });

  it('collapses a clack spinner line to its LAST frame (the erased ones are gone on screen)', async () => {
    const line =
      `◒  Hashing assets (100/281)${ESC}[1G${ESC}[J` +
      `◐  Hashing assets (200/281)${ESC}[1G${ESC}[J` +
      `◓  Hashing assets (281/281)${ESC}[1G${ESC}[J` +
      '◇  Checked for changes';
    expect(await renderCapturedLog(line)).toBe('◇  Checked for changes');
  });

  it('renders a trailing erase as the blank row a terminal would show', async () => {
    // Decision: The writer moved to column 1 and erased from there, so the row is blank (xterm.js agrees, see
    // sanitize-log-line-oracle.test.ts). clack erases before writing each frame, so the final message
    // lands after the last erase and survives.
    expect(await renderCapturedLog(`◆  Deployed!${ESC}[1G${ESC}[J`)).toBe('');
    expect(await renderCapturedLog(`◒ Hash${ESC}[1G${ESC}[J◆  Deployed!`)).toBe('◆  Deployed!');
  });

  it('strips SGR color codes emitted by third-party build tools', async () => {
    // Decision: vitepress and rolldown colorize despite piped (non-TTY) stdio and don't read CI, which is why the
    // strip at render time exists.
    expect(
      await renderCapturedLog(`${ESC}[32m✓${ESC}[0m building client + server bundles...`),
    ).toBe('✓ building client + server bundles...');
  });

  it('strips DEC private cursor hide/show, which clack emits around every spinner', async () => {
    expect(await renderCapturedLog(`${ESC}[?25l│`)).toBe('│');
    expect(await renderCapturedLog(`${ESC}[?25h└  Done!`)).toBe('└  Done!');
  });

  it('strips OSC sequences (window title / hyperlink) under both BEL and ST terminators', async () => {
    expect(await renderCapturedLog(`${ESC}]0;building\u0007done`)).toBe('done');
    expect(await renderCapturedLog(`${ESC}]8;;https://buildwf.dev${ESC}\\link`)).toBe('link');
  });

  // Decision: The expectations for string controls come from @xterm/headless (a full VT500 parser), not pyte,
  // which only implements OSC and has no DCS/SOS/PM/APC handling.
  it('consumes every C1 string control WHOLE, payload included', async () => {
    // Decision: A terminal shows nothing for these. Leaving the payload behind spends the check-run tail budget on
    // bytes no reader sees.
    expect(await renderCapturedLog(`before${ESC}Pq#0;2;0;0;0payload${ESC}\\after`)).toBe(
      'beforeafter',
    );
    expect(await renderCapturedLog(`before${ESC}_Ga=T,f=100;BASE64${ESC}\\after`)).toBe(
      'beforeafter',
    );
    expect(await renderCapturedLog(`before${ESC}Xsos${ESC}\\after`)).toBe('beforeafter');
    expect(await renderCapturedLog(`before${ESC}^pm${ESC}\\after`)).toBe('beforeafter');
    expect(await renderCapturedLog(`${ESC}P1$r0m${ESC}\\ok`)).toBe('ok');
  });

  it('consumes an UNTERMINATED string control to end of line', async () => {
    // Decision: `pipeStream` caps a line at MAX_PARTIAL_LINE_CHARS and splits on LF, so a long payload can arrive
    // with its ST cut off. A VT parser stays in the string state to end of input, so this is faithful,
    // and it keeps a 128KB truncated blob out of the fence.
    expect(await renderCapturedLog(`before${ESC}_Gpayload with no terminator`)).toBe('before');
    expect(await renderCapturedLog(`before${ESC}]0;title never closed`)).toBe('before');
  });

  it('terminates on BEL for OSC only — DCS/SOS/PM/APC run to ST', async () => {
    // Decision: xterm's VT500 table exits OSC_STRING on BEL but treats BEL as IGNORE / DCS_PUT in
    // SOS_PM_APC_STRING and each DCS state, so the payload after an embedded BEL stays invisible. BEL is
    // also an ordinary data byte inside sixel, so real payloads reach this.
    for (const intro of ['P', 'X', '^', '_']) {
      expect(await renderCapturedLog(`before${ESC}${intro}hidden\u0007still${ESC}\\after`)).toBe(
        'beforeafter',
      );
    }
    expect(await renderCapturedLog(`${ESC}Pabc\u0007def`)).toBe('');
    // Decision: OSC keeps BEL as a terminator (the legacy xterm convention).
    expect(await renderCapturedLog(`${ESC}]0;title\u0007visible`)).toBe('visible');
  });

  it('aborts a string control on an embedded ESC, as a VT parser does', async () => {
    expect(await renderCapturedLog(`${ESC}Pq${ESC}[2Kmore${ESC}\\tail`)).toBe('moretail');
  });

  it('treats bare CR as a rewrite too (progress bars that never emit LF)', async () => {
    expect(await renderCapturedLog('12%\r45%\r100%')).toBe('100%');
  });

  it('returns empty for a line that was pure control output', async () => {
    expect(await renderCapturedLog(`${ESC}[?25l${ESC}[1G${ESC}[J`)).toBe('');
    expect(await renderCapturedLog('')).toBe('');
  });

  it('does not mistake ordinary text for an escape sequence', async () => {
    expect(await renderCapturedLog(String.raw`cost [32m] and \x1b are literal`)).toBe(
      String.raw`cost [32m] and \x1b are literal`,
    );
  });

  // Decision: These expectations come from a real VT emulator. An erase is a frame boundary only when it reaches
  // back past the cursor; erase-forward leaves the prefix on screen.
  //
  // pyte handles the EL cases and ED 0/1/2 but not ED 3: its `erase_in_display` hardcodes
  // `how == 2 or how == 3`, so it reports 3J as a full-screen erase. The 3J expectation comes from
  // @xterm/headless, which leaves the cursor row untouched.
  it('keeps the prefix across erase-FORWARD, which clears only from the cursor on', async () => {
    expect(await renderCapturedLog(`Downloading${ESC}[K done`)).toBe('Downloading done');
    expect(await renderCapturedLog(`Downloading${ESC}[0K done`)).toBe('Downloading done');
    expect(await renderCapturedLog(`Downloading${ESC}[J done`)).toBe('Downloading done');
    expect(await renderCapturedLog(`Downloading${ESC}[0J done`)).toBe('Downloading done');
    // Decision: ED 3 ("Erase Saved Lines", an xterm extension) drops scrollback rows above the viewport and writes
    // no visible cell, so the prefix survives.
    expect(await renderCapturedLog(`Downloading${ESC}[3J done`)).toBe('Downloading done');
  });

  it('drops the prefix for erases that reach back past the cursor', async () => {
    // Decision: 2J clears the whole screen, including the cursor's own row, so it blanks the prefix and 3J doesn't.
    for (const seq of ['[1K', '[2K', '[1J', '[2J']) {
      expect((await renderCapturedLog(`Downloading${ESC}${seq} done`)).trim()).toBe('done');
    }
  });

  it('still terminalizes the frame for the clear-screen combos that carry 3J', async () => {
    // Decision: The real emitters in the dep tree (vite, tsc, playwright, /usr/bin/clear) pair 3J with 2J, whose
    // boundary still applies.
    for (const combo of [
      `${ESC}[2J${ESC}[3J${ESC}[H`,
      `${ESC}[3J${ESC}[H${ESC}[2J`,
      `${ESC}[H${ESC}[2J${ESC}[3J`,
    ]) {
      expect((await renderCapturedLog(`Downloading${combo} done`)).trim()).toBe('done');
    }
  });

  it('overwrites in place on a partial column move', async () => {
    // Decision: `ESC[5G` parks the cursor at column 5 and the following text overwrites from there, leaving the
    // tail of the old content visible, so a terminal shows the splice.
    expect(await renderCapturedLog(`Downloading${ESC}[5G done`)).toBe('Down doneng');
  });

  it('bounds the row against a hostile cursor parameter', async () => {
    // Decision: Build output is untrusted, and a CSI parameter is only digits. Growing the row to the requested
    // column let one crafted line ask for a billion array pushes, and enough digits parse to Infinity.
    // This runs inside the DO while it finalizes the check run, so it could take out the BuildManager.
    for (const seq of ['[999999999G', '[1;999999999H', '[999999999C', `[${'9'.repeat(400)}G`]) {
      const out = await renderCapturedLog(`x${ESC}${seq}y`);
      // Decision: Rows that hit a resource bound drop fail-closed instead of partly applying a terminal change.
      expect(out).toBe('');
    }
  });

  it('preflights every parameter-driven loop before xterm executes it', async () => {
    for (const final of ['S', 'T', 'L', 'M', 'I', 'Z', 'b', '@', 'P', 'X']) {
      await expect(renderCapturedLog(`SECRET${ESC}[999999999${final}`)).resolves.toBe('');
    }
  });

  it('bounds repeated DEC selective erases that scan protection metadata', async () => {
    for (const final of ['J', 'K']) {
      const selectiveEraseFlood = `x${`${ESC}[?2${final}`.repeat(2700)}ERR`;
      expect(selectiveEraseFlood.length).toBeLessThanOrEqual(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS);
      await expect(renderCapturedLog(selectiveEraseFlood)).resolves.toBe('');
    }
  });

  it('bounds REP allocation by preceding-grapheme length as well as Ps', async () => {
    const combining = `a${'\u0301'.repeat(131)}`;
    expect(combining.length * 8000).toBeGreaterThan(TERMINAL_RENDER_MAX_REPEAT_CODE_UNITS);
    expect(await renderCapturedLog(`${combining}${ESC}[8000b`)).toBe('');
  });

  it('does not treat adjacent REP commands as repeated allocations', async () => {
    // Decision: xterm clears its preceding-join state after CSI dispatch, so only the first REP can repeat the
    // preceding grapheme and an adjacent REP is a no-op. Preflight resets the source at the same boundary
    // instead of charging an allocation the parser won't perform.
    expect(await renderCapturedLog(`a${ESC}[2b${ESC}[2b`)).toBe('aaa');
  });

  it('preserves the REP source across an aborted or ignored escape sequence', async () => {
    expect(await renderCapturedLog(`a${ESC}[${ESC}[2b`)).toBe('aaa');
    expect(await renderCapturedLog(`a${ESC}[??x${ESC}[2b`)).toBe('aaa');

    const grapheme = `a${'\u0301'.repeat(131)}`;
    expect(await renderCapturedLog(`${grapheme}${ESC}[${ESC}[8000b`)).toBe('');
    expect(await renderCapturedLog(`${grapheme}${ESC}[??x${ESC}[8000b`)).toBe('');
  });

  it('does not charge a whole ordinary ASCII run as REP source', async () => {
    const text = 'a'.repeat(132);
    expect(await renderCapturedLog(`${text}${ESC}[8000b`)).toBe(`${text}${'a'.repeat(8000)}`);
  });

  it('does not charge unsupported private REP identities', async () => {
    const grapheme = `a${'\u0301'.repeat(131)}`;
    expect(await renderCapturedLog(`${grapheme}${ESC}[?8000b`)).toBe(grapheme);
  });

  it('bounds cumulative REP expansion from distinct printable graphemes', async () => {
    const grapheme = `a${'\u0301'.repeat(2000)}`;
    const allocation = grapheme.length * 200;
    expect(allocation).toBeLessThan(TERMINAL_RENDER_MAX_REPEAT_CODE_UNITS);
    expect(allocation * 3).toBeGreaterThan(TERMINAL_RENDER_MAX_REPEAT_CODE_UNITS);
    const segment = `${grapheme}${ESC}[200b${ESC}[2K`;
    expect(await renderCapturedLog(segment.repeat(3))).toBe('');
  });

  it('drops insert mode because printable writes would shift the full dense row', async () => {
    expect(await renderCapturedLog(`${ESC}[4hSECRET`)).toBe('');
  });

  it('uses a fixed right margin independent of non-painting control bytes', async () => {
    const raw = `SECRET${ESC}[200GZ`;
    const padded = `SECRET${ESC}[m${ESC}[m${ESC}[m${ESC}[m${ESC}[m${ESC}[200GZ`;
    const expected = await renderCapturedLog(raw);
    expect(await renderCapturedLog(padded)).toBe(expected);
    expect(expected).toHaveLength(200);
  });

  it('keeps a long diagnostic with harmless SGR instead of charging queue latency', async () => {
    const text = 'x'.repeat(10_000);
    expect(await renderCapturedLog(`${text}${ESC}[0m`)).toBe(text);
  });

  it('does not charge truecolor values as parser work', async () => {
    const truecolor = `${ESC}[38;2;255;255;255m`;
    expect(await renderCapturedLog(`${truecolor.repeat(11)}VISIBLE${ESC}[0m`)).toBe('VISIBLE');
  });

  it('rejects repeated full terminal resets before allocating the xterm grid', async () => {
    const resets = `${ESC}c`.repeat(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS / 2);
    expect(resets).toHaveLength(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS);
    expect(await renderCapturedLog(resets)).toBe('');
  });

  it('bounds tab searches after output clears every configured stop', async () => {
    const prefix = `${ESC}[3g`;
    const hostile = `${prefix}${'\r\t'.repeat(
      Math.floor((TERMINAL_RENDER_MAX_INPUT_CODE_UNITS - prefix.length) / 2),
    )}`;
    expect(hostile.length).toBeLessThanOrEqual(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS);
    expect(await renderCapturedLog(hostile)).toBe('');
  });

  it('does not let tab expansion amplify a hostile line', async () => {
    // Decision: Tabs advance 8 columns per byte, so bounding the row at `length * 8` would let a 128KB line of tabs
    // (the agent's per-line capture cap) expand to a row of about 1M cells.
    const hostile = '\t'.repeat(MAX_PARTIAL_LINE_CHARS) + 'END';
    const row = await renderCapturedLog(hostile);
    expect(hostile.length).toBeGreaterThan(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS);
    expect(row).toBe('');

    const out = await formatLogTailMarkdown(
      Array.from({ length: CHECK_RUN_LOG_TAIL_LINES }, () => hostile),
      CHECK_RUN_LOG_TAIL_LINES,
    );
    expect(out).toBeNull();
  });

  it('skips repeated ICH at the row end instead of growing the row per command', async () => {
    // Decision: ICH at the content end inserts only trailing blanks and leaves the cursor put. Materializing them
    // grew the row on each command, and spreading the insert into `splice` hit V8's argument limit for a
    // count near the row bound.
    const hostile = `seed${`${ESC}[130000@`.repeat(2000)}END`;
    expect(await renderCapturedLog(hostile)).toBe('');
  });

  it('skips visually inert ICH beyond the modeled row instead of allocating blanks', async () => {
    // Decision: EL2 empties the row without moving the cursor. ICH on that empty suffix changes no visible cell,
    // but allocating its full count bypassed the shift budget: this line asked for about 1.3 billion
    // blank assignments.
    const pair = `${ESC}[2K${ESC}[131072@`;
    const hostile = pair.repeat(Math.floor(MAX_PARTIAL_LINE_CHARS / pair.length));
    const out = await renderCapturedLog(hostile);
    expect(out).toBe('');
  });

  it('charges ICH row growth as well as retained-suffix movement', async () => {
    // Decision: Seeding one cell after EL2 makes `ichMoved === 1`, but ICH then filled the rest of the 131K row.
    // Repeated near the capture limit this asked for about a billion assignments while barely touching
    // the budget.
    const pair = `${ESC}[2Kx${ESC}[G${ESC}[131071@`;
    const hostile = pair.repeat(Math.floor(MAX_PARTIAL_LINE_CHARS / pair.length));
    const out = await renderCapturedLog(hostile);
    // Decision: Once growth spends the cumulative work budget, fail closed instead of keeping a cell that a later
    // terminal change could hide.
    expect(out).toBe('');
  });

  it('bounds the CUMULATIVE cost of many shifts on a long row', async () => {
    // Decision: Bounding the row isn't the same as bounding the work. Each DCH/ICH shifts the retained suffix, so N
    // commands on an L-cell row cost N x L, and both come from the same repo-controlled line, so the
    // total is quadratic in the input.
    const hostile = `${'a'.repeat(65_000)}${ESC}[G${`${ESC}[@`.repeat(20_000)}`;
    expect(hostile.length).toBeLessThanOrEqual(MAX_PARTIAL_LINE_CHARS);
    const out = await renderCapturedLog(hostile);
    // Decision: The first over-budget shift clears the row instead of keeping content a real terminal went on
    // changing.
    expect(out).toBe('');
  });

  it('bounds the cumulative cost of repeated erases on a long row', async () => {
    // Decision: EL, ED and ECH rewrite cells too, so they share the budget. This input is under the 128KiB capture
    // ceiling but asks ECH to rewrite most of a 100,000-cell row 3,000 times.
    const hostile = `SECRET${'a'.repeat(99_994)}${ESC}[7G${`${ESC}[999999X`.repeat(3000)}`;
    const out = await renderCapturedLog(hostile);
    // Decision: Once the budget is spent, fail closed by dropping the modeled row. Ignoring an over-budget erase
    // could bring back text a real terminal hid.
    expect(out).toBe('');
  });

  it('spends the shift budget on ordinary work before the fail-closed limit', async () => {
    expect(await renderCapturedLog(`abcdef${ESC}[3D${ESC}[2@`)).toBe('abc  def');
    expect(await renderCapturedLog(`abcdef${ESC}[6D${ESC}[2P`)).toBe('cdef');
  });

  it('fails closed when aggregate CSI parameter work exceeds its deterministic budget', async () => {
    const command = `${ESC}[64@`;
    const hostile = command.repeat(Math.floor(TERMINAL_RENDER_MAX_PARAMETER_WORK / 64) + 1);
    expect(hostile.length).toBeLessThan(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS);
    expect(await renderCapturedLog(hostile)).toBe('');
    expect(TERMINAL_RENDER_COLUMNS).toBe(32 * 1024);
  });

  it('strips colon-form truecolor SGR (ITU-T T.416)', async () => {
    expect(await renderCapturedLog(`${ESC}[38:2::255:0:0mRED${ESC}[0m done`)).toBe('RED done');
  });

  it('strips private-parameter CSI', async () => {
    expect(await renderCapturedLog(`${ESC}[>4;2mtext`)).toBe('text');
    expect(await renderCapturedLog(`${ESC}[=7htext`)).toBe('text');
  });

  it('leaves no ESC byte behind for any sequence it handles', async () => {
    const line = `${ESC}[?25l${ESC}[38:2::0:255:0m✓${ESC}[0m built${ESC}[K${ESC}[?25h`;
    expect(await renderCapturedLog(line)).toBe('✓ built');
    expect(await renderCapturedLog(line)).not.toContain(ESC);
  });
});

describe('formatLogTailMarkdown sanitizes before measuring', () => {
  const ESC = '\u001b';

  it('renders the visible frame, not the erased ones', async () => {
    const spinner = `◒  Uploading${ESC}[1G${ESC}[J◐  Uploading (59/59)${ESC}[1G${ESC}[J◆  Deployed!`;
    expect(await formatLogTailMarkdown([spinner], 1)).toBe(
      `**Last 1 log lines:**\n\n${SIX_BACKTICKS}text\n◆  Deployed!\n${SIX_BACKTICKS}`,
    );
  });

  it('keeps diagnostics visible after a tool leaves a wide terminal margin', async () => {
    const margin = ' '.repeat(512);
    const out = (await formatLogTailMarkdown(
      [
        { line: `${ESC}[?25l${margin}build finished`, lineEnding: 'crlf' },
        { line: `${margin}deploy: output missing`, lineEnding: 'none' },
      ],
      2,
    )) as string;
    expect(parseFence(out).content).toEqual([
      `${' '.repeat(32)}build finished`,
      `${' '.repeat(32)}deploy: output missing`,
    ]);
  });

  it('drops lines that carried nothing but control output', async () => {
    const out = (await formatLogTailMarkdown(
      ['real output', `${ESC}[?25h`, 'more output'],
      3,
    )) as string;
    expect(parseFence(out).content).toEqual(['real output', 'more output']);
  });

  it('returns null when every captured line was pure control output (PATCH omits text)', async () => {
    expect(await formatLogTailMarkdown([`${ESC}[?25l`, `${ESC}[1G${ESC}[J`], 2)).toBe(null);
  });

  it('spends the byte budget on visible text only — an erased-frame flood must not evict real lines', async () => {
    // Decision: One spinner line whose raw form is about 1.4MB of erased frames but whose visible text is 12 chars.
    // Counting bytes before sanitizing would blow the content cap and shift out each line before it.
    const flood =
      Array.from({ length: 20_000 }, (_, i) => `frame ${i}${ESC}[1G${ESC}[J`).join('') +
      'Deployed!';
    expect(flood.length).toBeGreaterThan(CHECK_RUN_LOG_TAIL_MAX_BYTES);
    const out = await formatLogTailMarkdown(['first real line', flood, 'last real line'], 3);
    // Decision: The unsafe stateful group makes the later terminal state unknowable. Even rendering only the newer
    // plain row could be wrong under a persisted mode.
    expect(out).toBeNull();
  });

  it('a terminal-only string-control payload must not evict real diagnostics either', async () => {
    // Decision: One 120KB Kitty graphics blob, under pipeStream's 128KB per-line cap, so it arrives intact. Its
    // visible width is zero, but left as text it alone exceeds the tail budget.
    const blob = `${ESC}_Ga=T,f=100;${'QUJDRA'.repeat(20_000)}${ESC}\\`;
    expect(blob.length).toBeGreaterThan(CHECK_RUN_LOG_TAIL_MAX_BYTES);
    const lines = [...Array.from({ length: 9 }, (_, i) => `[vite] error detail ${i}`), blob];
    const out = await formatLogTailMarkdown(lines, lines.length);
    // Decision: The newest group itself is unsafe, so there's no sound terminal suffix to render. Live and admin
    // logs still keep the original bounded record.
    expect(out).toBeNull();
  });

  it('preserves parser state when a 7-bit string control spans captured rows', async () => {
    for (const [intro, terminator] of [
      [`${ESC}]0;title=`, `${ESC}\\`],
      [`${ESC}Pq`, `${ESC}\\`],
      [`${ESC}X`, `${ESC}\\`],
      [`${ESC}^`, `${ESC}\\`],
      [`${ESC}_G`, `${ESC}\\`],
    ]) {
      const out = (await formatLogTailMarkdown(
        ['first', `before${intro}SECRET`, `MORE${terminator}after`, 'last'],
        4,
      )) as string;
      expect(parseFence(out).content).toEqual(['first', 'beforeafter', 'last']);
      expect(out).not.toContain('SECRET');
      expect(out).not.toContain('MORE');
    }
  });

  it('preserves parser state for the 8-bit C1 forms across captured rows', async () => {
    for (const intro of ['\u009d0;title=', '\u0090q', '\u0098', '\u009e', '\u009fG']) {
      const out = (await formatLogTailMarkdown(
        ['first', `before${intro}SECRET`, 'MORE', `PAYLOAD\u009cafter`, 'last'],
        5,
      )) as string;
      expect(parseFence(out).content).toEqual(['first', 'beforeafter', 'last']);
      expect(out).not.toContain('SECRET');
      expect(out).not.toContain('MORE');
      expect(out).not.toContain('PAYLOAD');
    }
  });

  it('preserves incomplete ESC and CSI state across captured rows', async () => {
    for (const lines of [
      [`before${ESC}`, '[31mRED'],
      [`before${ESC}[`, '31mRED'],
    ]) {
      const out = (await formatLogTailMarkdown(lines, lines.length)) as string;
      expect(parseFence(out).content).toEqual(['before', 'RED']);
      expect(out).not.toContain('31m');
    }
  });

  it('renders captured newlines without losing CSI state or bare-CR rewrites', async () => {
    const first = { line: `before${ESC}[`, lineEnding: 'cr' as const };
    const bareCr = (await formatLogTailMarkdown(
      [first, { line: '31mRED', lineEnding: 'none' }],
      2,
    )) as string;
    expect(parseFence(bareCr).content).toEqual(['REDore']);

    const bareLf = (await formatLogTailMarkdown(
      [
        { ...first, lineEnding: 'lf' as const },
        { line: '31mRED', lineEnding: 'none' },
      ],
      2,
    )) as string;
    expect(parseFence(bareLf).content).toEqual(['before', 'RED']);

    const crlf = (await formatLogTailMarkdown(
      [
        { ...first, lineEnding: 'crlf' as const },
        { line: '31mRED', lineEnding: 'none' },
      ],
      2,
    )) as string;
    expect(parseFence(crlf).content).toEqual(['before', 'RED']);
  });

  it('starts plain LF-delimited log lines at column zero', async () => {
    const out = (await formatLogTailMarkdown(
      [
        { line: 'abc', lineEnding: 'lf' },
        { line: 'X', lineEnding: 'none' },
      ],
      2,
    )) as string;
    expect(parseFence(out).content).toEqual(['abc', 'X']);
  });

  it('keeps plain LF-delimited logs on the text path beyond the terminal input budget', async () => {
    const lines = Array.from(
      { length: CHECK_RUN_LOG_TAIL_LINES },
      (_, index) => `${index}: ${'x'.repeat(400)}`,
    );
    expect(lines.join('\n').length).toBeGreaterThan(TERMINAL_TAIL_MAX_INPUT_CODE_UNITS);
    const out = (await formatLogTailMarkdown(
      lines.map((line) => ({ line, lineEnding: 'lf' })),
      lines.length,
    )) as string;
    expect(parseFence(out).content).toEqual(lines);
  });

  it('does not invent a REP source across a captured LF inside CSI', async () => {
    const grapheme = `a${'\u0301'.repeat(8200)}`;
    const out = (await formatLogTailMarkdown(
      [
        { line: `${grapheme}${ESC}[`, lineEnding: 'lf' },
        { line: `128b${ESC}[2K${ESC}[1GERR`, lineEnding: 'none' },
      ],
      2,
    )) as string;
    expect(parseFence(out).content).toEqual([grapheme, 'ERR']);
  });

  it('preserves protection and configured tab stops across parser-ground rows', async () => {
    const protectedOut = (await formatLogTailMarkdown(
      [`${ESC}[1"q`, `SECRET${ESC}[?2K`],
      2,
    )) as string;
    expect(parseFence(protectedOut).content).toEqual(['SECRET']);

    const tabsOut = (await formatLogTailMarkdown(
      [`${ESC}[3g${ESC}[21G${ESC}H`, `SECRET_TOKEN_ABCDEFG\r\t${ESC}[1K${ESC}[1GERR`],
      2,
    )) as string;
    expect(parseFence(tabsOut).content).toEqual(['ERR']);
    expect(tabsOut).not.toContain('KEN_ABCDEFG');
  });

  it('retains a normal 100-row tail when the newest diagnostic uses color', async () => {
    const lines = [
      ...Array.from({ length: CHECK_RUN_LOG_TAIL_LINES - 1 }, (_, index) => `error ${index}`),
      `${ESC}[31mFAILED${ESC}[0m`,
    ];
    const out = (await formatLogTailMarkdown(lines, lines.length)) as string;
    const content = parseFence(out).content;
    expect(content).toHaveLength(CHECK_RUN_LOG_TAIL_LINES);
    expect(content.at(0)).toBe('error 0');
    expect(content.at(-1)).toBe('FAILED');
  });

  it('does not resurrect cached rows cleared by later terminal history controls', async () => {
    const ris = (await formatLogTailMarkdown([`SECRET${ESC}`, 'cERR'], 2)) as string;
    expect(parseFence(ris).content).toEqual(['ERR']);

    const ed3 = (await formatLogTailMarkdown(['SECRET', `${ESC}[3JERR`], 2)) as string;
    expect(parseFence(ed3).content).toEqual(['ERR']);
  });

  it('keeps captured normal and alternate-buffer histories separate', async () => {
    const staysAlternate = (await formatLogTailMarkdown(
      ['SECRET', `${ESC}[?1049hERR`],
      2,
    )) as string;
    expect(parseFence(staysAlternate).content).toEqual(['ERR']);

    const returnsToNormal = (await formatLogTailMarkdown(
      ['normal', `${ESC}[?1049hALT${ESC}[3J${ESC}[?1049lERR`],
      2,
    )) as string;
    expect(parseFence(returnsToNormal).content).toEqual(['normal', 'ERR']);

    const alternateScroll = (await formatLogTailMarkdown(
      [`${ESC}[?1049hALT1`, { line: 'ALT2', lineEnding: 'none' }],
      2,
    )) as string;
    expect(parseFence(alternateScroll).content).toEqual(['ALT2']);

    const reentersClearedAlternate = (await formatLogTailMarkdown(
      [`${ESC}[?1049hOLD`, `${ESC}[?1049l`, `${ESC}[?1049hNEW`],
      3,
    )) as string;
    expect(parseFence(reentersClearedAlternate).content).toEqual(['NEW']);
  });

  it('does not resurrect a row scrolled away by control input within one capture', async () => {
    const out = (await formatLogTailMarkdown([`SECRET\u0085ERR`], 1)) as string;
    expect(parseFence(out).content).toEqual(['ERR']);
  });

  it('charges raw in-record vertical controls even though captured endings are bounded', async () => {
    const hostile = `SECRET${'\u0085'.repeat(TERMINAL_RENDER_MAX_PARAMETER_WORK / 2048 + 1)}ERR`;
    expect(await formatLogTailMarkdown([{ line: hostile, lineEnding: 'none' }], 1)).toBeNull();
  });

  it('drops an over-budget multiline string group whole and resumes after its terminator', async () => {
    const payload = 'SECRET'.repeat(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS);
    const out = await formatLogTailMarkdown(
      ['first diagnostic', `${ESC}_G`, payload, `${ESC}\\`, 'latest failure'],
      5,
    );
    expect(out).toBeNull();
  });

  it('spends the controlled-input budget on newest whole parser groups first', async () => {
    const olderControlled = Array.from(
      { length: 6 },
      (_, index) => `${ESC}[0mold-${index}-${'x'.repeat(7000)}`,
    );
    const out = await formatLogTailMarkdown(
      [...olderControlled, `before${ESC}_GSECRET`, `MORE${ESC}\\latest failure`],
      olderControlled.length + 2,
    );
    // Decision: A fresh terminal after the omitted controlled prefix could expose text whose meaning depends on
    // persistent state from that prefix.
    expect(out).toBeNull();
  });

  it('fails closed instead of starting after an omitted state-setting group', async () => {
    const setup = `${ESC}[3g${ESC}[21G${ESC}H${'x'.repeat(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS)}`;
    const dependent = `SECRET_TOKEN_ABCDEFG\r\t${ESC}[1K${ESC}[1GERR`;
    expect(await formatLogTailMarkdown([setup, dependent], 2)).toBeNull();
  });

  it('can omit an oversized plain prefix because it cannot mutate terminal state', async () => {
    const out = (await formatLogTailMarkdown(
      ['x'.repeat(TERMINAL_TAIL_MAX_INPUT_CODE_UNITS), `${ESC}[31mFAILED${ESC}[0m`],
      2,
    )) as string;
    expect(parseFence(out).content).toEqual(['FAILED']);
  });
});

describe('BuildManager finalizeCheckRun log tail (output.text)', () => {
  // Decision: The file-level check-run mock is routed to the real completeCheckRun (importActual) and global
  // fetch captures the PATCH. `getInstallationToken` stays mocked, so the real module runs offline.
  let patches: Array<{ url: string; body: { output: Record<string, unknown> } }>;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('../../src/github/check-run.ts')>(
      '../../src/github/check-run.ts',
    );
    vi.mocked(completeCheckRun).mockImplementation(actual.completeCheckRun);
    patches = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (method === 'PATCH' && /\/check-runs\/[^/]+$/.test(url)) {
          patches.push({ url, body: JSON.parse(String(init?.body)) });
          return new Response('{}', { status: 200 });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Decision: Restore the file-level no-op default so the other suites keep it.
    vi.mocked(completeCheckRun).mockImplementation(async () => false);
  });

  it('embeds the stored log tail as output.text in the completion PATCH', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    // Decision: Finalize reads the run id from DO storage (create is inert in this file).
    ctx._kv.set('checkRunId', '99001');
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'installing deps', stream: 'stdout', ts: 1 } as unknown as LogRow,
      { line: 'building app', stream: 'stdout', ts: 2 } as unknown as LogRow,
      { line: 'deploy complete', stream: 'stdout', ts: 3 } as unknown as LogRow,
    ]);

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(patches[0].body.output.text).toBe(
      `**Last 3 log lines:**\n\n${SIX_BACKTICKS}text\ninstalling deps\nbuilding app\ndeploy complete\n${SIX_BACKTICKS}`,
    );
  });

  it('omits output.text entirely when no log lines were captured', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._kv.set('checkRunId', '99001');

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect('text' in patches[0].body.output).toBe(false);
  });

  it('still PATCHes (without text) when the log-tail read throws (best-effort)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._kv.set('checkRunId', '99001');
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'installing deps', stream: 'stdout', ts: 1 } as unknown as LogRow,
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(
      m as unknown as { readLogTailMarkdown: () => Promise<string | null> },
      'readLogTailMarkdown',
    ).mockRejectedValue(new Error('sqlite read failed'));

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect('text' in patches[0].body.output).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'finalizeCheckRun: log tail read failed (best-effort)',
      expect.any(Error),
    );
    warn.mockRestore();
  });
});

describe('BuildManager agent-control auth + transition guards', () => {
  it('rejects POST /status without the agent secret (401) and leaves status unchanged', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(
      new Request('https://manager/status', {
        method: 'POST',
        body: JSON.stringify({ status: 'deploying' }),
      }),
    );

    expect(res.status).toBe(401);
    expect(dbState.writes).toEqual([]);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'building' });
  });

  it('rejects POST /cancel without the agent secret (401) and does not stop the container', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const res = await m.fetch(new Request('https://manager/cancel', { method: 'POST' }));

    expect(res.status).toBe(401);
    expect(containerCalls.stopped).toBe(0);
  });

  it('rejects POST /status with a WRONG agent secret (401)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(
      new Request('https://manager/status', {
        method: 'POST',
        headers: { Authorization: 'Bearer not-the-real-token' },
        body: JSON.stringify({ status: 'deploying' }),
      }),
    );

    expect(res.status).toBe(401);
    expect(dbState.writes).toEqual([]);
  });

  it('rejects a terminal status from the agent even WITH the secret (4xx) and keeps status unchanged', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    for (const status of ['complete', 'failed', 'cancelled'] as const) {
      const res = await m.fetch(
        agentRequest(ctx, 'https://manager/status', {
          method: 'POST',
          body: JSON.stringify({ status }),
        }),
      );
      expect(res.status).toBe(400);
    }

    expect(dbState.writes).toEqual([]);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'building' });
  });

  it('accepts a non-terminal status WITH the secret', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(
      agentRequest(ctx, 'https://manager/status', {
        method: 'POST',
        body: JSON.stringify({ status: 'deploying' }),
      }),
    );

    expect(res.status).toBe(200);
    expect(lastWrite('deploying')).toBeDefined();
  });

  // Decision: The DO's local status can still say active (its setStatus didn't run for the out-of-band cancel),
  // so only the guarded CAS stands between a forged or late 'deploying' and a re-enabled deploy token.
  it('POST /status on an out-of-band cancelled row → 409, row stays cancelled, no write, container stopped', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    dbState.status.set('b1', 'cancelled');
    dbState.writes = [];
    containerCalls.stopped = 0;

    const res = await m.fetch(
      agentRequest(ctx, 'https://manager/status', {
        method: 'POST',
        body: JSON.stringify({ status: 'deploying' }),
      }),
    );

    expect(res.status).toBe(409);
    expect(dbState.writes.some((w) => w.status === 'deploying')).toBe(false);
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(containerCalls.stopped).toBe(1);
  });

  // Decision: The agent param is limited to progress statuses, so a buggy or malicious agent can't write an
  // arbitrary lifecycle state (such as resetting a row to 'queued').
  it('rejects a non-whitelist status (queued) WITH the secret (400) and writes nothing', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(
      agentRequest(ctx, 'https://manager/status', {
        method: 'POST',
        body: JSON.stringify({ status: 'queued' }),
      }),
    );

    expect(res.status).toBe(400);
    expect(dbState.writes).toEqual([]);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'building' });
  });
});

// Decision: The build agent mustn't hand the control-plane secrets to untrusted repo child processes (install,
// `bwf deploy`), or a malicious postinstall could read DO_LOG_URL/AGENT_TOKEN and forge build status.
describe('build-agent sanitizeChildEnv (env scrub)', () => {
  const fullEnv = {
    PATH: '/usr/bin',
    HOME: '/root',
    DO_LOG_URL: 'https://manager/logs',
    SOURCE_TOKEN: 'ghs_secret',
    AGENT_TOKEN: 'agent-secret',
    BWF_TOKEN: 'deploy-jwt',
    CF_ACCESS_CLIENT_ID: 'svc-id.access',
    CF_ACCESS_CLIENT_SECRET: 'svc-secret',
    PLATFORM_ACCESS_CREDENTIALS: '{"https://proxy.example.com":{"CF_ACCESS_TOKEN":"private"}}',
    BWF_API_URL: 'https://platform.buildwithfriends.dev',
    BWF_PROJECT: 'my-app',
  };

  it('drops every control-plane + credential secret from the (install) child env', () => {
    const child = sanitizeChildEnv(fullEnv);
    expect(child.DO_LOG_URL).toBeUndefined();
    expect(child.SOURCE_TOKEN).toBeUndefined();
    expect(child.AGENT_TOKEN).toBeUndefined();
    // Decision: The live deploy token mustn't reach untrusted install lifecycle scripts, which could exfiltrate it
    // or publish to the scoped project within the TTL. Only the deploy step re-injects it.
    expect(child.BWF_TOKEN).toBeUndefined();
    // Decision: The shared staging CF Access service token is as sensitive (a leaked pair reaches each
    // Access-gated staging host), so it's scrubbed too.
    expect(child.CF_ACCESS_CLIENT_ID).toBeUndefined();
    expect(child.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
    expect(child.PLATFORM_ACCESS_CREDENTIALS).toBeUndefined();
    expect([...SCRUBBED_ENV_VARS].sort()).toEqual([
      'AGENT_TOKEN',
      'BWF_TOKEN',
      'CF_ACCESS_CLIENT_ID',
      'CF_ACCESS_CLIENT_SECRET',
      'DO_LOG_URL',
      'PLATFORM_ACCESS_CREDENTIALS',
      'SOURCE_TOKEN',
    ]);
  });

  it('re-injects BWF_TOKEN + CF Access creds only for the trusted deploy step (via extra overrides)', () => {
    // Decision: runBuild captures the deploy token and CF Access pair into locals and deletes them from
    // process.env before any child spawns, so the deploy spawn passes them as extra.
    const deployEnv = sanitizeChildEnv(fullEnv, {
      BWF_TOKEN: fullEnv.BWF_TOKEN,
      CF_ACCESS_CLIENT_ID: fullEnv.CF_ACCESS_CLIENT_ID,
      CF_ACCESS_CLIENT_SECRET: fullEnv.CF_ACCESS_CLIENT_SECRET,
    });
    expect(deployEnv.BWF_TOKEN).toBe('deploy-jwt');
    expect(deployEnv.CF_ACCESS_CLIENT_ID).toBe('svc-id.access');
    expect(deployEnv.CF_ACCESS_CLIENT_SECRET).toBe('svc-secret');
    expect(deployEnv.DO_LOG_URL).toBeUndefined();
    expect(deployEnv.SOURCE_TOKEN).toBeUndefined();
    expect(deployEnv.AGENT_TOKEN).toBeUndefined();
  });

  it('drops re-inject overrides whose value is undefined (off-staging CF Access)', () => {
    // Decision: On production and dev the captured CF Access locals are undefined. sanitizeChildEnv treats an
    // undefined override as a delete, so passing them doesn't bring back an empty value.
    const deployEnv = sanitizeChildEnv(fullEnv, {
      BWF_TOKEN: fullEnv.BWF_TOKEN,
      CF_ACCESS_CLIENT_ID: undefined,
      CF_ACCESS_CLIENT_SECRET: undefined,
    });
    expect(deployEnv.BWF_TOKEN).toBe('deploy-jwt');
    expect(deployEnv.CF_ACCESS_CLIENT_ID).toBeUndefined();
    expect(deployEnv.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
  });

  it('keeps non-secret deploy + system vars the build legitimately needs', () => {
    const child = sanitizeChildEnv(fullEnv);
    expect(child.BWF_API_URL).toBe('https://platform.buildwithfriends.dev');
    expect(child.BWF_PROJECT).toBe('my-app');
    expect(child.PATH).toBe('/usr/bin');
    expect(child.HOME).toBe('/root');
  });

  it('does not mutate the source env object', () => {
    const copy = { ...fullEnv };
    sanitizeChildEnv(fullEnv);
    expect(fullEnv).toEqual(copy);
  });
});

// Decision: The agent deletes the control-plane and credential secrets from its own `process.env`:
// AGENT_TOKEN/DO_LOG_URL at module load, SOURCE_TOKEN/BWF_TOKEN inside runBuild before any child
// spawns. This only covers spawn inheritance (`sanitizeChildEnv` already strips each child's copy).
// It doesn't scrub `/proc/self/environ`: `unsetenv()` changes only the heap `environ`, so a same-uid
// child can still read `/proc/<ppid>/environ`, which is why untrusted children run under a non-root
// uid. It doesn't cover BWF_TOKEN passing from the deploy child to the vite build.
describe('build-agent shutdown handlers (PID-1 SIGTERM delivery)', () => {
  it('registers SIGTERM + SIGINT listeners so the DO stop() SIGTERM is not dropped by PID 1', () => {
    // Decision: The agent is PID 1 in the container, and Linux delivers a signal to PID 1 only if a handler is
    // installed. Without these listeners the DO's stop() (a bare SIGTERM) is ignored and the container
    // leaks a
    const beforeTerm = process.rawListeners('SIGTERM');
    const beforeInt = process.rawListeners('SIGINT');
    try {
      installShutdownHandlers();
      const addedTerm = process.rawListeners('SIGTERM').filter((l) => !beforeTerm.includes(l));
      const addedInt = process.rawListeners('SIGINT').filter((l) => !beforeInt.includes(l));
      expect(addedTerm).toHaveLength(1);
      expect(addedInt).toHaveLength(1);
    } finally {
      for (const l of process.rawListeners('SIGTERM').filter((x) => !beforeTerm.includes(x))) {
        process.removeListener('SIGTERM', l as (...args: Array<unknown>) => void);
      }
      for (const l of process.rawListeners('SIGINT').filter((x) => !beforeInt.includes(x))) {
        process.removeListener('SIGINT', l as (...args: Array<unknown>) => void);
      }
    }
  });
});

describe('build-agent parent-process secret scrub', () => {
  it('deletes AGENT_TOKEN and DO_LOG_URL from process.env at module load', async () => {
    // Decision: Both are read into module-level consts at import, then deleted from process.env at load, before
    // any child spawns. Re-import the module with both set to prove the delete.
    const saved = { AGENT_TOKEN: process.env.AGENT_TOKEN, DO_LOG_URL: process.env.DO_LOG_URL };
    process.env.AGENT_TOKEN = 'agent-secret';
    process.env.DO_LOG_URL = 'https://manager/logs';
    try {
      vi.resetModules();
      await import('../../container/build-agent.mjs');
      expect(process.env.AGENT_TOKEN).toBeUndefined();
      expect(process.env.DO_LOG_URL).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      vi.resetModules();
    }
  });

  it('deletes BWF_TOKEN and SOURCE_TOKEN from process.env during runBuild — while the deploy child still receives BWF_TOKEN', async () => {
    const saved = {
      BWF_TOKEN: process.env.BWF_TOKEN,
      SOURCE_TOKEN: process.env.SOURCE_TOKEN,
      BWF_API_URL: process.env.BWF_API_URL,
      BWF_PROJECT: process.env.BWF_PROJECT,
    };
    process.env.BWF_TOKEN = 'deploy-jwt';
    process.env.SOURCE_TOKEN = 'ghs_secret';
    process.env.BWF_API_URL = 'https://platform.buildwithfriends.dev';
    process.env.BWF_PROJECT = 'my-app';
    try {
      const seen: Array<{ cmd: string; env: NodeJS.ProcessEnv | undefined }> = [];
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild: vi.fn(
          async (cmd: string, _args: ReadonlyArray<string>, opts?: { env?: NodeJS.ProcessEnv }) => {
            seen.push({ cmd, env: opts?.env });
            return 0;
          },
        ),
        reportStatus: vi.fn(async () => {}),
        hasLocalBwf: () => true,
      });
      expect(code).toBe(0);

      expect(process.env.BWF_TOKEN).toBeUndefined();
      expect(process.env.SOURCE_TOKEN).toBeUndefined();

      const install = seen.find((s) => s.cmd === 'npm');
      expect(install?.env?.BWF_TOKEN).toBeUndefined();
      expect(install?.env?.SOURCE_TOKEN).toBeUndefined();

      const deploy = [...seen].reverse().find((s) => s.cmd === 'npx');
      expect(deploy?.env?.BWF_TOKEN).toBe('deploy-jwt');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

// Decision: The build container is a CI environment and has to say so, or interactive CLIs animate into a piped
// stdout: `@clack/prompts`' spinner redraws with `ESC[1G ESC[J` and no newline, so the agent's CR/LF
// splitter glues the frames into one line. The CLI's `createSpinner()` falls back to plain output
// behind clack's `isCI`. `github_actions` builds get `CI=true` from the runner; container builds
// don't, so the agent sets it.
describe('PINNED_PLATFORM_CLI_VERSION (fallback CLI ↔ SDK package contract)', () => {
  it('matches the workspace SDK package the platform deploys against', () => {
    expect(PINNED_PLATFORM_CLI_VERSION).toBe(bwfPackageJson.version);
  });

  it('matches the container agent’s own backstop default', () => {
    expect(DEFAULT_PLATFORM_CLI_VERSION).toBe(PINNED_PLATFORM_CLI_VERSION);
  });
});

describe('build-agent nonInteractiveEnv (CI-safe child output)', () => {
  it('sets CI to the exact string "true" — clack compares by identity, so "1" is a no-op', () => {
    expect(nonInteractiveEnv()).toEqual({ CI: 'true' });
  });

  it('survives the env scrub (CI is not a secret)', () => {
    expect(sanitizeChildEnv({ PATH: '/usr/bin' }, nonInteractiveEnv()).CI).toBe('true');
  });

  it('reaches BOTH build children — the deploy child renders the spinner, the install child its own progress', async () => {
    const saved = {
      BWF_TOKEN: process.env.BWF_TOKEN,
      SOURCE_TOKEN: process.env.SOURCE_TOKEN,
      BWF_API_URL: process.env.BWF_API_URL,
      BWF_PROJECT: process.env.BWF_PROJECT,
    };
    process.env.BWF_TOKEN = 'deploy-jwt';
    process.env.SOURCE_TOKEN = 'ghs_secret';
    process.env.BWF_API_URL = 'https://platform.buildwithfriends.dev';
    process.env.BWF_PROJECT = 'my-app';
    try {
      const seen: Array<{ cmd: string; env: NodeJS.ProcessEnv | undefined }> = [];
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild: vi.fn(
          async (cmd: string, _args: ReadonlyArray<string>, opts?: { env?: NodeJS.ProcessEnv }) => {
            seen.push({ cmd, env: opts?.env });
            return 0;
          },
        ),
        reportStatus: vi.fn(async () => {}),
        hasLocalBwf: () => true,
      });
      expect(code).toBe(0);
      expect(seen.map((s) => s.cmd)).toEqual(['npm', 'npx', 'npx']);
      for (const child of seen) {
        expect(child.env?.CI).toBe('true');
      }
      expect(seen[0]?.env?.HOME).toBe(BUILDER_HOME);
      expect(seen[1]?.env?.HOME).toBe(BUILDER_HOME);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

// Decision: Untrusted build children run as a non-root uid. `delete process.env.X` can't scrub
// `/proc/<ppid>/environ`, so a same-uid child of the root agent could recover
// AGENT_TOKEN/SOURCE_TOKEN. The install and deploy children drop to BUILDER_UID with a
// writable cache HOME, and the root-extracted source tree is chowned to the builder. Real
// setuid only works as root, so the unit tests check the helpers and the wiring, not a
// live uid drop.
describe('build-agent non-root child isolation', () => {
  it('childSpawnOptions drops untrusted children to the non-root builder uid/gid', () => {
    const opts = childSpawnOptions();
    expect(opts.uid).toBe(BUILDER_UID);
    expect(opts.gid).toBe(BUILDER_GID);
    expect(BUILDER_UID).toBe(1000);
    expect(BUILDER_GID).toBe(1000);
    expect(opts.uid).toBeGreaterThan(0);
    expect(opts.cwd).toBe('/tmp/build/src');
  });

  it('builderCacheEnv points every package-manager cache at the builder home', () => {
    // Decision: Without these the non-root builder gets EPERM writing corepack/npm/yarn/bun caches: the image
    // defaults include BUN_INSTALL=/usr/local (root-owned).
    const env = builderCacheEnv();
    expect(env.HOME).toBe(BUILDER_HOME);
    expect(env.HOME).toBe('/home/builder');
    expect(env.XDG_CACHE_HOME).toBe('/home/builder/.cache');
    expect(env.npm_config_cache).toBe('/home/builder/.npm');
    expect(env.COREPACK_HOME).toBe('/home/builder/.cache/node/corepack');
    expect(env.YARN_CACHE_FOLDER).toBe('/home/builder/.cache/yarn');
    expect(env.BUN_INSTALL).toBe('/home/builder/.bun');
  });

  it('the install AND deploy children run with the builder cache env (HOME=/home/builder)', async () => {
    const saved = {
      BWF_TOKEN: process.env.BWF_TOKEN,
      SOURCE_TOKEN: process.env.SOURCE_TOKEN,
      BWF_API_URL: process.env.BWF_API_URL,
      BWF_PROJECT: process.env.BWF_PROJECT,
    };
    process.env.BWF_TOKEN = 'deploy-jwt';
    process.env.SOURCE_TOKEN = 'ghs_secret';
    process.env.BWF_API_URL = 'https://platform.buildwithfriends.dev';
    process.env.BWF_PROJECT = 'my-app';
    try {
      const seen: Array<{ cmd: string; env: NodeJS.ProcessEnv | undefined }> = [];
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild: vi.fn(
          async (cmd: string, _args: ReadonlyArray<string>, opts?: { env?: NodeJS.ProcessEnv }) => {
            seen.push({ cmd, env: opts?.env });
            return 0;
          },
        ),
        reportStatus: vi.fn(async () => {}),
        hasLocalBwf: () => true,
      });
      expect(code).toBe(0);

      const install = seen.find((s) => s.cmd === 'npm');
      expect(install?.env?.HOME).toBe('/home/builder');
      expect(install?.env?.COREPACK_HOME).toBe('/home/builder/.cache/node/corepack');
      expect(install?.env?.BUN_INSTALL).toBe('/home/builder/.bun');

      const deploy = [...seen].reverse().find((s) => s.cmd === 'npx');
      expect(deploy?.env?.HOME).toBe('/home/builder');
      expect(deploy?.env?.BWF_TOKEN).toBe('deploy-jwt');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('hands the extracted tree to the builder (chown) after download, before the install child', async () => {
    const saved = {
      BWF_TOKEN: process.env.BWF_TOKEN,
      SOURCE_TOKEN: process.env.SOURCE_TOKEN,
      BWF_API_URL: process.env.BWF_API_URL,
      BWF_PROJECT: process.env.BWF_PROJECT,
    };
    process.env.BWF_TOKEN = 'deploy-jwt';
    process.env.SOURCE_TOKEN = 'ghs_secret';
    process.env.BWF_API_URL = 'https://platform.buildwithfriends.dev';
    process.env.BWF_PROJECT = 'my-app';
    try {
      const order: Array<string> = [];
      const code = await runBuild({
        downloadSource: vi.fn(async () => {
          order.push('download');
        }),
        chownWorkDir: vi.fn(async () => {
          order.push('chown');
        }),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild: vi.fn(async (cmd: string) => {
          order.push(`child:${cmd}`);
          return 0;
        }),
        reportStatus: vi.fn(async () => {}),
        hasLocalBwf: () => true,
      });
      expect(code).toBe(0);
      // Decision: chown runs between the source download and the first untrusted child, so the root-extracted tree
      // is builder-owned before the non-root install writes.
      expect(order[0]).toBe('download');
      expect(order[1]).toBe('chown');
      expect(order.indexOf('chown')).toBeLessThan(order.indexOf('child:npm'));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  // Decision: A dependency lifecycle script that daemonizes during install survives as a same-uid sibling of the
  // deploy child and could read its /proc/<deploy-pid>/environ (BWF_TOKEN and staging CF Access). So
  // runBuild reaps BUILDER_UID processes after the install child closes and before the deploy spawns.
  it('reaps leftover builder processes between install and the deploy spawn', async () => {
    const saved = {
      BWF_TOKEN: process.env.BWF_TOKEN,
      BWF_API_URL: process.env.BWF_API_URL,
      BWF_PROJECT: process.env.BWF_PROJECT,
    };
    process.env.BWF_TOKEN = 'deploy-jwt';
    process.env.BWF_API_URL = 'https://platform.buildwithfriends.dev';
    process.env.BWF_PROJECT = 'my-app';
    try {
      const order: Array<string> = [];
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        chownWorkDir: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild: vi.fn(async (cmd: string) => {
          order.push(`child:${cmd}`);
          return 0;
        }),
        killBuilderProcesses: vi.fn(async () => {
          order.push('reap');
        }),
        reportStatus: vi.fn(async (status: string) => {
          order.push(`status:${status}`);
        }),
        hasLocalBwf: () => true,
      });
      expect(code).toBe(0);
      expect(order.indexOf('child:npm')).toBeLessThan(order.indexOf('reap'));
      expect(order.indexOf('reap')).toBeLessThan(order.indexOf('status:deploying'));
      expect(order.indexOf('reap')).toBeLessThan(order.indexOf('child:npx'));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('does NOT reap (or deploy) when the install fails', async () => {
    const saved = {
      BWF_TOKEN: process.env.BWF_TOKEN,
      BWF_API_URL: process.env.BWF_API_URL,
      BWF_PROJECT: process.env.BWF_PROJECT,
    };
    process.env.BWF_TOKEN = 'deploy-jwt';
    process.env.BWF_API_URL = 'https://platform.buildwithfriends.dev';
    process.env.BWF_PROJECT = 'my-app';
    try {
      const reap = vi.fn(async () => {});
      const runChild = vi.fn(async () => 19);
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        chownWorkDir: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild,
        killBuilderProcesses: reap,
        reportStatus: vi.fn(async () => {}),
        hasLocalBwf: () => true,
      });
      expect(code).toBe(19);
      expect(reap).not.toHaveBeenCalled();
      expect(runChild).toHaveBeenCalledTimes(1);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

describe('parseProcStatusUid', () => {
  it('parses the real uid from the Uid line', () => {
    const status =
      'Name:\tnode\nUmask:\t0022\nState:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n';
    expect(parseProcStatusUid(status)).toBe(1000);
  });

  it('parses a root (uid 0) process', () => {
    expect(parseProcStatusUid('Name:\tagent\nUid:\t0\t0\t0\t0\n')).toBe(0);
  });

  it('returns null when there is no Uid line (kernel-thread / torn read)', () => {
    expect(parseProcStatusUid('Name:\tkworker\nState:\tI (idle)\n')).toBeNull();
  });
});

// Decision: The build agent has to resolve to an exit code and close its control server on each failure path,
// so the container doesn't hang on an open listening socket (which would leak a build slot until the
// DO's `sleepAfter`, or longer for unlimited plans).
describe('build-agent lifecycle (container must always exit)', () => {
  const REQUIRED_ENV = [
    'BWF_TOKEN',
    'BWF_API_URL',
    'BWF_PROJECT',
    'PLATFORM_PROXY_URL',
    'CF_ACCESS_CLIENT_ID',
    'CF_ACCESS_CLIENT_SECRET',
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of REQUIRED_ENV) {
      savedEnv[key] = process.env[key];
    }
    process.env.BWF_TOKEN = 'deploy-jwt';
    process.env.BWF_API_URL = 'https://platform.buildwithfriends.dev';
    process.env.BWF_PROJECT = 'my-app';
  });

  afterEach(() => {
    for (const key of REQUIRED_ENV) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('resolves to the non-zero install exit code (no hang) when install fails', async () => {
    const deploy = vi.fn(async () => 0);
    const runChild = vi.fn(async (cmd: string) => {
      return cmd === 'npx' ? await deploy() : 17;
    });

    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
      runChild,
      reportStatus: vi.fn(async () => {}),
      hasLocalBwf: () => true,
    });

    expect(code).toBe(17);
    expect(deploy).not.toHaveBeenCalled();
    expect(runChild).toHaveBeenCalledTimes(1);
  });

  it.each([0, 19])(
    'connects before deploy and stops if connection fails (exit %s)',
    async (connectExit) => {
      const runChild = vi.fn(
        async (_cmd: string, args: ReadonlyArray<string>, _opts?: { env?: NodeJS.ProcessEnv }) =>
          args.includes('connect') ? connectExit : 0,
      );
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild,
        reportStatus: vi.fn(async () => {}),
        hasLocalBwf: () => true,
      });
      expect(code).toBe(connectExit);
      const calls = runChild.mock.calls;
      expect(calls[1]?.[1]).toEqual([
        '--yes',
        'bwf',
        'connect',
        'https://platform.buildwithfriends.dev',
        '--no-login',
      ]);
      expect(calls[1]?.[2]?.env?.BWF_TOKEN).toBeUndefined();
      expect(calls[1]?.[2]?.env?.PLATFORM_ACCESS_ORIGIN).toBe(
        'https://platform.buildwithfriends.dev',
      );
      expect(calls.some(([, args]) => args.includes('deploy'))).toBe(connectExit === 0);
    },
  );

  it('scopes captured Access credentials to the configured API and proxy only for deployment', async () => {
    process.env.PLATFORM_PROXY_URL = 'https://proxy.example.com';
    process.env.CF_ACCESS_CLIENT_ID = 'service-id';
    process.env.CF_ACCESS_CLIENT_SECRET = 'service-secret';
    const runChild = vi.fn(
      async (_cmd: string, _args: ReadonlyArray<string>, _opts?: { env?: NodeJS.ProcessEnv }) => 0,
    );
    expect(
      await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild,
        reportStatus: vi.fn(async () => {}),
        hasLocalBwf: () => true,
      }),
    ).toBe(0);
    const [install, connect, deploy] = runChild.mock.calls;
    expect(install?.[2]?.env?.PLATFORM_ACCESS_CREDENTIALS).toBeUndefined();
    expect(connect?.[2]?.env?.PLATFORM_ACCESS_CREDENTIALS).toBeUndefined();
    expect(JSON.parse(deploy?.[2]?.env?.PLATFORM_ACCESS_CREDENTIALS ?? 'null')).toEqual({
      'https://platform.buildwithfriends.dev': {
        CF_ACCESS_CLIENT_ID: 'service-id',
        CF_ACCESS_CLIENT_SECRET: 'service-secret',
      },
      'https://proxy.example.com': {
        CF_ACCESS_CLIENT_ID: 'service-id',
        CF_ACCESS_CLIENT_SECRET: 'service-secret',
      },
    });
  });

  it('passes BWF_TOKEN to the DEPLOY child but NOT the INSTALL child', async () => {
    const seen: Array<{ cmd: string; env: NodeJS.ProcessEnv | undefined }> = [];
    const runChild = vi.fn(
      async (cmd: string, _args: ReadonlyArray<string>, opts?: { env?: NodeJS.ProcessEnv }) => {
        seen.push({ cmd, env: opts?.env });
        return 0;
      },
    );

    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
      runChild,
      reportStatus: vi.fn(async () => {}),
      hasLocalBwf: () => true,
    });
    expect(code).toBe(0);

    const install = seen.find((s) => s.cmd === 'npm');
    const deploy = [...seen].reverse().find((s) => s.cmd === 'npx');
    expect(install).toBeDefined();
    expect(deploy).toBeDefined();
    expect(install?.env?.BWF_TOKEN).toBeUndefined();
    expect(deploy?.env?.BWF_TOKEN).toBe('deploy-jwt');
  });

  it('falls back to the PINNED void@<version> (never @latest) when the repo has no local void', async () => {
    // Decision: BuildManager injects BWF_CLI_VERSION, and the agent spawns that exact pinned version, not a moving
    // `@builtbyfriends/bwf@latest` dist-tag.
    const savedCliVersion = process.env.BWF_CLI_VERSION;
    process.env.BWF_CLI_VERSION = '0.9.1';
    try {
      const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
      const runChild = vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      });

      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild,
        reportStatus: vi.fn(async () => {}),
        hasLocalBwf: () => false,
      });
      expect(code).toBe(0);

      const deploy = [...seen].reverse().find((s) => s.cmd === 'npx');
      expect(deploy).toBeDefined();
      expect(deploy?.args).toContain('@builtbyfriends/bwf@0.9.1');
      expect(deploy?.args.some((a) => a === '@builtbyfriends/bwf@latest')).toBe(false);
    } finally {
      if (savedCliVersion === undefined) {
        delete process.env.BWF_CLI_VERSION;
      } else {
        process.env.BWF_CLI_VERSION = savedCliVersion;
      }
    }
  });

  it('resolves to the deploy exit code on a successful install + failed deploy', async () => {
    const runChild = vi.fn(async (cmd: string) => (cmd === 'npx' ? 1 : 0));
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
      runChild,
      reportStatus: vi.fn(async () => {}),
      hasLocalBwf: () => true,
    });
    expect(code).toBe(1);
  });

  it('resolves to 0 on a fully successful build', async () => {
    const runChild = vi.fn(async () => 0);
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
      runChild,
      reportStatus: vi.fn(async () => {}),
      hasLocalBwf: () => true,
    });
    expect(code).toBe(0);
  });

  it('resolves to non-zero (1) when a build step throws — never leaves the driver unresolved', async () => {
    const code = await runBuild({
      downloadSource: vi.fn(async () => {
        throw new Error('source download failed: HTTP 404');
      }),
    });
    expect(code).toBe(1);
  });

  it('closeControlServer invokes server.close and resolves (server-close path on every exit)', async () => {
    let closed = false;
    const fakeServer = {
      close(cb: () => void) {
        closed = true;
        cb();
      },
    };
    await expect(closeControlServer(fakeServer)).resolves.toBeUndefined();
    expect(closed).toBe(true);
  });

  it('closeControlServer is a no-op for a null server (best-effort)', async () => {
    await expect(closeControlServer(null)).resolves.toBeUndefined();
    await expect(closeControlServer(undefined)).resolves.toBeUndefined();
  });
});

// Decision: The DO pulls logs (`GET /logs?since=N`) about once a second and can't pull once the container
// exits, so without a barrier the lines after the last poll are lost, including the error output.
// `waitForLogDrain` keeps the control server open at exit until the DO has acknowledged each line.
// The ack is the `since` cursor on a later request, which the DO advances only after a successful
// `res.json()` and `ingestLines()`. `servedLogSeq` doesn't gate the barrier: `res.end`'s callback
// fires even when the peer read nothing.
describe('build-agent exit-time log drain barrier', () => {
  it('waits until the DO puller catches up, then resolves true', async () => {
    let served = 0;
    const recorded = 5;
    const sleeps: Array<number> = [];

    const drained = await waitForLogDrain({
      timeoutMs: 4000,
      pollMs: 100,
      served: () => served,
      recorded: () => recorded,
      now: (() => {
        let t = 0;
        return () => (t += 10);
      })(),
      sleep: async (ms) => {
        sleeps.push(ms);
        served += 2;
      },
    });

    expect(drained).toBe(true);
    expect(sleeps).toEqual([100, 100, 100]);
  });

  it('returns immediately when the puller is already caught up', async () => {
    const sleep = vi.fn(async () => {});
    await expect(waitForLogDrain({ served: () => 9, recorded: () => 9, sleep })).resolves.toBe(
      true,
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up at the deadline (bounded — a dead/absent DO must never hang the container)', async () => {
    // Decision: `served` doesn't advance: the DO is gone, already terminal, or not wired. An unbounded wait here
    // would pin a fleet container slot per build.
    const sleep = vi.fn(async () => {});
    let clock = 0;

    const drained = await waitForLogDrain({
      timeoutMs: 4000,
      pollMs: 100,
      served: () => 0,
      recorded: () => 1,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        await sleep();
      },
    });

    expect(drained).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(40);
    expect(clock).toBe(4000);
  });

  it('resets the idle deadline while acknowledged progress continues across slow callbacks', async () => {
    let clock = 0;
    const acknowledgedAt = [7000, 14_000, 21_000];
    const served = (): number => acknowledgedAt.filter((at) => at <= clock).length;

    const drained = await waitForLogDrain({
      timeoutMs: 30_000,
      idleTimeoutMs: 8000,
      pollMs: 1000,
      served,
      recorded: () => acknowledgedAt.length,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    expect(drained).toBe(true);
    expect(clock).toBe(21_000);
  });

  it('still releases a dead DO at the short idle deadline, not the absolute cap', async () => {
    let clock = 0;
    const drained = await waitForLogDrain({
      timeoutMs: LOG_DRAIN_ABSOLUTE_TIMEOUT_MS,
      idleTimeoutMs: LOG_DRAIN_IDLE_TIMEOUT_MS,
      pollMs: 1000,
      served: () => 0,
      recorded: () => 1,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    expect(drained).toBe(false);
    expect(clock).toBe(LOG_DRAIN_IDLE_TIMEOUT_MS);
  });

  it('enforces the non-resettable absolute cap despite continual partial progress', async () => {
    let clock = 0;
    let acknowledged = 0;
    let nextProgress = 7000;
    const drained = await waitForLogDrain({
      timeoutMs: 20_000,
      idleTimeoutMs: 8000,
      pollMs: 1000,
      served: () => acknowledged,
      recorded: () => 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock >= nextProgress) {
          acknowledged += 1;
          nextProgress += 7000;
        }
      },
    });

    expect(drained).toBe(false);
    expect(acknowledged).toBeGreaterThan(0);
    expect(clock).toBe(20_000);
  });

  it('uses real timers by default without hanging when the deadline is short', async () => {
    await expect(
      waitForLogDrain({ timeoutMs: 30, pollMs: 5, served: () => 0, recorded: () => 1 }),
    ).resolves.toBe(false);
  });
});

// Decision: The lines recorded after the build child closes (`bwf deploy exited with code N` is emitted after
// `child.on('close')`) have to stay retrievable while the server is open. That's what the drain
// barrier is for.
describe('build-agent GET /logs serves post-child-close lines', () => {
  const REQUIRED_ENV = ['BWF_TOKEN', 'BWF_API_URL', 'BWF_PROJECT'] as const;
  let savedEnv: Record<string, string | undefined>;
  let server: import('node:http').Server | null = null;

  beforeEach(() => {
    savedEnv = {};
    for (const key of REQUIRED_ENV) {
      savedEnv[key] = process.env[key];
    }
    process.env.BWF_TOKEN = 'deploy-jwt';
    process.env.BWF_API_URL = 'https://platform.buildwithfriends.dev';
    process.env.BWF_PROJECT = 'my-app';
  });

  afterEach(async () => {
    await closeControlServer(server);
    server = null;
    for (const key of REQUIRED_ENV) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('budgets a page by serialized bytes, not UTF-16 code units', async () => {
    // Decision: `entry.line.length` counts UTF-16 code units of the raw string, not wire bytes: JSON escaping turns
    // one control character into six bytes, and each entry has about 61 bytes of envelope. The DO
    // advances its cursor only after a successful parse, so a body too large to read inside
    // LOG_PULL_TIMEOUT_MS is a livelock, not a slow transfer.
    const before = getBufferedLogLines();
    const since = before.length > 0 ? before.at(-1).seq : 0;

    // Decision: Each NUL serializes as `\\u0000` (six bytes), so these 2000 x 1048-char lines make a body of
    // about 12.6 MB, though their code units fit one page.
    const control = '\u0000'.repeat(1048);
    // Decision: record() mirrors each line to stderr. Keep the NUL bytes out of the test output.
    const mirror = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      for (let i = 0; i < MAX_LOG_RESPONSE_LINES; i++) {
        record(control, 'stdout');
      }
    } finally {
      mirror.mockRestore();
    }

    server = await startControlServer(0);
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('expected a TCP address');
    }
    const res = await fetch(`http://127.0.0.1:${address.port}/logs?since=${since}`);
    const text = await res.text();

    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_LOG_RESPONSE_BYTES);
    const body = JSON.parse(text) as { lines: Array<{ seq: number }>; hasMore: boolean };
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.lines.length).toBeLessThan(MAX_LOG_RESPONSE_LINES);
    expect(body.hasMore).toBe(true);
  });

  it('pages an oversized backlog so each pull advances the cursor', async () => {
    // Decision: Unpaged, the response would hold each retained line above the cursor, up to MAX_BUFFERED_LOG_LINES
    // x MAX_PARTIAL_LINE_CHARS. The DO aborts at LOG_PULL_TIMEOUT_MS and advances `logCursor` only after a
    // successful parse, so an oversized body is a livelock: each retry asks for the same backlog until
    // the drain barrier expires and the tail is lost.
    const before = getBufferedLogLines();
    let since = before.length > 0 ? before.at(-1).seq : 0;
    const start = since;

    const big = 'x'.repeat(128 * 1024);
    for (let i = 0; i < 40; i++) {
      record(big, 'stdout');
    }
    const finalSeq = getBufferedLogLines().at(-1).seq;

    server = await startControlServer(0);
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('expected a TCP address');
    }
    const pull = async (
      from: number,
    ): Promise<{ lines: Array<{ seq: number }>; lastSeq: number }> =>
      (await (await fetch(`http://127.0.0.1:${address.port}/logs?since=${from}`)).json()) as {
        lines: Array<{ seq: number }>;
        lastSeq: number;
      };

    const first = await pull(since);
    expect(JSON.stringify(first.lines).length).toBeLessThanOrEqual(MAX_LOG_RESPONSE_BYTES * 1.1);
    expect(first.lastSeq).toBeLessThan(finalSeq);
    expect(first.lastSeq).toBe(first.lines.at(-1).seq);

    let rounds = 0;
    since = first.lastSeq;
    while (since < finalSeq && rounds < 50) {
      const next = await pull(since);
      expect(next.lastSeq).toBeGreaterThan(since);
      since = next.lastSeq;
      rounds++;
    }
    expect(since).toBe(finalSeq);
    expect(start).toBeLessThan(finalSeq);
  });

  it("serves the post-close `bwf deploy exited with code N` line, and releases the barrier only on the DO's ACK, not on serving it", async () => {
    // Decision: The module-level ring is shared across this file's suites, so poll from the current high-water
    // mark instead of 0.
    const before = getBufferedLogLines();
    const since = before.length > 0 ? before.at(-1).seq : 0;

    // Decision: Ephemeral port: the container's fixed 4000 could collide in CI.
    server = await startControlServer(0);
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('expected a TCP address');
    }

    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
      runChild: vi.fn(async () => 0),
      reportStatus: vi.fn(async () => {}),
      hasLocalBwf: () => true,
    });
    expect(code).toBe(0);

    const res = await fetch(`http://127.0.0.1:${address.port}/logs?since=${since}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<{ seq: number; line: string }>;
      lastSeq: number;
    };

    expect(body.lines.map((l) => l.line)).toContain('[build-agent] bwf deploy exited with code 0');
    expect(body.lastSeq).toBeGreaterThan(since);
    expect(getServedLogSeq()).toBe(body.lastSeq);

    // Decision: Serving the tail mustn't release the barrier. The DO has received bytes but hasn't said it stored
    // them, and if its `res.json()` or `ingestLines()` throws it retries with its cursor unadvanced,
    // against an agent that would be gone.
    expect(getAckedLogSeq()).toBe(since);
    await expect(waitForLogDrain({ timeoutMs: 50, pollMs: 5 })).resolves.toBe(false);

    // Decision: The DO's next poll carries the advanced cursor. That's the acknowledgement, and only then can the
    // container die. The DO stores `lastSeq` verbatim, so it comes back as `since=lastSeq`.
    const ack = await fetch(`http://127.0.0.1:${address.port}/logs?since=${body.lastSeq}`);
    expect(ack.status).toBe(200);
    const ackBody = (await ack.json()) as { lines: Array<unknown>; lastSeq: number };
    expect(ackBody.lines).toEqual([]);
    expect(getAckedLogSeq()).toBe(body.lastSeq);
    await expect(waitForLogDrain({ timeoutMs: 50, pollMs: 5 })).resolves.toBe(true);
  });

  it('clamps a forged /logs cursor to recorded lines — it cannot ack the future', async () => {
    // Decision: This server is unauthenticated, binds all interfaces on a fixed port, and untrusted build children
    // share its network namespace, so `since` is attacker-reachable. Unclamped, one
    // `?since=MAX_SAFE_INTEGER` would mark each future line acked and release the exit barrier.
    server = await startControlServer(0);
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('expected a TCP address');
    }

    const forged = await fetch(
      `http://127.0.0.1:${address.port}/logs?since=${Number.MAX_SAFE_INTEGER}`,
    );
    expect(forged.status).toBe(200);

    record('[build-agent] bwf deploy exited with code 1', 'stdout');

    // Decision: The honest DO's cursor is a previously served `lastSeq`, so the clamp is a no-op for it.
    await expect(waitForLogDrain({ timeoutMs: 50, pollMs: 5 })).resolves.toBe(false);
  });
});

// Decision: The real package-manager and deploy-command resolution reads the repo files in WORK_DIR
// (`/tmp/build/src`). WORK_DIR is wiped before and after each case, so a stray `.pnp.cjs` or lockfile
// can't leak into another test's deploy-command branch (which keys off `existsSync('.pnp.cjs')`).
describe('build-agent install + deploy resolution', () => {
  const WORK_DIR = '/tmp/build/src';
  const REQUIRED_ENV = ['BWF_TOKEN', 'BWF_API_URL', 'BWF_PROJECT'] as const;
  let savedEnv: Record<string, string | undefined>;

  function resetWorkDir(): void {
    rmSync(WORK_DIR, { recursive: true, force: true });
    mkdirSync(WORK_DIR, { recursive: true });
  }

  async function runAndCapture(
    hasLocalBwf: () => boolean,
  ): Promise<Array<{ cmd: string; args: ReadonlyArray<string> }>> {
    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      hasLocalBwf,
    });
    expect(code).toBe(0);
    return seen;
  }

  beforeEach(() => {
    savedEnv = {};
    for (const key of REQUIRED_ENV) {
      savedEnv[key] = process.env[key];
    }
    process.env.BWF_TOKEN = 'deploy-jwt';
    process.env.BWF_API_URL = 'https://platform.buildwithfriends.dev';
    process.env.BWF_PROJECT = 'my-app';
    resetWorkDir();
  });

  afterEach(() => {
    for (const key of REQUIRED_ENV) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(WORK_DIR, { recursive: true, force: true });
  });

  // Decision: Yarn Classic (1.x) doesn't recognize Berry's `--immutable` and would silently run a mutable
  // install, so a yarn.lock repo pinned to 1.x installs with `--frozen-lockfile`.
  it('yarn.lock + packageManager yarn@1.x → install with --frozen-lockfile', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@1.22.19' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install).toBeDefined();
    expect(install?.args).toEqual(['yarn', 'install', '--frozen-lockfile']);
  });

  it('yarn.lock + packageManager yarn@4.x → install with --immutable', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install?.args).toEqual(['yarn', 'install', '--immutable']);
  });

  // Decision: Without a packageManager pin, the flag comes from the yarn.lock header. Corepack's unpinned default
  // is Yarn 1.22, and a v1 lockfile has a `# yarn lockfile v1` header, so it installs
  // `--frozen-lockfile`.
  it('yarn.lock (v1 header) + NO pin → install with --frozen-lockfile', async () => {
    writeFileSync(
      `${WORK_DIR}/yarn.lock`,
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n',
    );
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ name: 'app' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install?.args).toEqual(['yarn', 'install', '--frozen-lockfile']);
  });

  // Decision: A Berry lockfile with no pin and no `.yarnrc.yml` yarnPath has no resolvable Yarn version:
  // corepack's default 1.22 ignores `--immutable` and can't parse a Berry lock. So resolveInstall fails
  // fast with guidance instead of breaking mid-install.
  it('yarn.lock (Berry __metadata) + NO pin + no yarnrc → fails fast, no install spawned', async () => {
    writeFileSync(
      `${WORK_DIR}/yarn.lock`,
      '# This file is generated by running "yarn install".\n\n__metadata:\n  version: 8\n',
    );
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ name: 'app' }));

    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      hasLocalBwf: () => true,
    });
    expect(code).toBe(1);
    expect(seen.some((s) => s.cmd === 'corepack' && s.args[0] === 'yarn')).toBe(false);
  });

  // Decision: With a `.yarnrc.yml` yarnPath, corepack's default Yarn 1.22 re-execs the bundled Berry release,
  // which honors `--immutable`.
  it('yarn.lock (Berry __metadata) + NO pin + .yarnrc.yml yarnPath → install with --immutable', async () => {
    writeFileSync(
      `${WORK_DIR}/yarn.lock`,
      '# This file is generated by running "yarn install".\n\n__metadata:\n  version: 8\n',
    );
    writeFileSync(`${WORK_DIR}/.yarnrc.yml`, 'yarnPath: .yarn/releases/yarn-4.3.1.cjs\n');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ name: 'app' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install?.args).toEqual(['yarn', 'install', '--immutable']);
  });

  // Decision: With no lockfile, the packageManager pin is still honored: defaulting to `npm install` would break
  // a pnpm `workspace:*` repo or install a different graph.
  it('no lockfile + packageManager pnpm@9 → corepack pnpm install (no frozen flag)', async () => {
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'pnpm@9.1.0' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'pnpm');
    expect(install).toBeDefined();
    expect(install?.args).toEqual(['pnpm', 'install']);
    expect(seen.some((s) => s.cmd === 'npm')).toBe(false);
  });

  it('no lockfile + packageManager yarn@4 → corepack yarn install --no-immutable (CI=true would otherwise forbid creating the lockfile)', async () => {
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    const seen = await runAndCapture(() => true);

    // Decision: Berry >= 3.0.0 defaults `enableImmutableInstalls` to true under CI, and `nonInteractiveEnv()` sets
    // `CI=true` on this child, so a bare `yarn install` aborts with YN0028 on the plan whose job is to
    // create the missing lockfile. Checked against Berry 3.0.0, 3.6.4, 4.14.1 and 4.18.0.
    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install?.args).toEqual(['yarn', 'install', '--no-immutable']);
  });

  it('keeps the LOCKFILE yarn plans immutable — the escape hatch is scoped to the no-lockfile plan', async () => {
    // Decision: Relaxing these would let a build change a committed lockfile and deploy resolutions the repo
    // didn't pin.
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));
    writeFileSync(`${WORK_DIR}/yarn.lock`, '__metadata:\n  version: 8\n');

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install?.args).toEqual(['yarn', 'install', '--immutable']);
    expect(install?.args).not.toContain('--no-immutable');
  });

  it('no lockfile + NO packageManager pin → npm install (default preserved)', async () => {
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ name: 'app' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'npm');
    expect(install?.args).toEqual(['install']);
  });

  // Decision: A Yarn Berry PnP repo (`.pnp.cjs`, no node_modules) runs the deploy through the package manager,
  // so PnP is active and the build children `bwf deploy` spawns inherit it.
  it('PnP repo (.pnp.cjs present) runs deploy via corepack yarn, not bare npx', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    const seen = await runAndCapture(() => true);

    const deploy = seen.find((s) => s.cmd === 'corepack' && s.args.includes('deploy'));
    expect(deploy).toBeDefined();
    expect(deploy?.args).toEqual(['yarn', 'bwf', 'deploy', '--project', 'my-app']);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  it('PnP repo without resolvable void falls back to yarn dlx', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    const seen = await runAndCapture(() => false);

    const deploy = seen.find((s) => s.cmd === 'corepack' && s.args.includes('deploy'));
    expect(deploy?.args.slice(0, 2)).toEqual(['yarn', 'dlx']);
    expect(deploy?.args.some((a) => a.startsWith('@builtbyfriends/bwf@'))).toBe(true);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  // Decision: Under PnP there's no `node_modules/.bin/bwf`, so the default `hasLocalBwf` doesn't take `.pnp.cjs`
  // as proof. It checks whether the repo declares `platform`.
  it('default hasLocalBwf: PnP repo that DECLARES void → corepack yarn bwf deploy', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
    writeFileSync(
      `${WORK_DIR}/package.json`,
      JSON.stringify({
        packageManager: 'yarn@4.3.1',
        dependencies: { '@builtbyfriends/bwf': '^0.9.0' },
      }),
    );

    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
    });
    expect(code).toBe(0);

    const deploy = seen.find((s) => s.cmd === 'corepack' && s.args.includes('deploy'));
    expect(deploy?.args).toEqual(['yarn', 'bwf', 'deploy', '--project', 'my-app']);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  it('default hasLocalBwf: PnP repo that does NOT declare void → corepack yarn dlx', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
    });
    expect(code).toBe(0);

    const deploy = seen.find((s) => s.cmd === 'corepack' && s.args.includes('deploy'));
    expect(deploy?.args.slice(0, 2)).toEqual(['yarn', 'dlx']);
    expect(deploy?.args.some((a) => a.startsWith('@builtbyfriends/bwf@'))).toBe(true);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  // Decision: `pnpPresent` is computed after download() fills WORK_DIR. At runBuild entry WORK_DIR is empty, and
  // a false reading sends a PnP repo down the bare-`npx` path, which can't resolve PnP deps.
  it('detects PnP created by download() (not pre-existing) → corepack yarn', async () => {
    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {
        writeFileSync(`${WORK_DIR}/yarn.lock`, '');
        writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
        writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));
      }),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      hasLocalBwf: () => true,
    });
    expect(code).toBe(0);

    const deploy = seen.find((s) => s.args.includes('deploy'));
    expect(deploy?.cmd).toBe('corepack');
    expect(deploy?.args).toEqual(['yarn', 'bwf', 'deploy', '--project', 'my-app']);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  // Decision: `pnpPresent` is computed after the install step too. A Yarn Berry PnP repo can gitignore
  // `.pnp.cjs` and let `yarn install` generate it, so a snapshot before install would send the deploy
  // down the bare-`npx` path.
  it('detects PnP created by yarn install (not committed) → corepack yarn', async () => {
    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {
        writeFileSync(`${WORK_DIR}/yarn.lock`, '');
        writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));
      }),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        if (cmd === 'corepack' && args[0] === 'yarn' && args[1] === 'install') {
          writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
        }
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      hasLocalBwf: () => true,
    });
    expect(code).toBe(0);

    const deploy = seen.find((s) => s.args.includes('deploy'));
    expect(deploy?.cmd).toBe('corepack');
    expect(deploy?.args).toEqual(['yarn', 'bwf', 'deploy', '--project', 'my-app']);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });
});

// Decision: An unbounded `logBuffer` lets a verbose build OOM the agent on the memory-constrained standard-1
// container, so the buffer is capped at MAX_BUFFERED_LOG_LINES (oldest evicted in a chunk).
describe('build-agent log buffer is bounded', () => {
  it('caps logBuffer at MAX_BUFFERED_LOG_LINES while keeping the most recent line', () => {
    const flood = MAX_BUFFERED_LOG_LINES * 2 + 137;
    for (let i = 0; i < flood; i += 1) {
      record(`line ${i}`, 'stdout');
    }
    const buf = getBufferedLogLines();
    expect(buf.length).toBeLessThanOrEqual(MAX_BUFFERED_LOG_LINES);
    expect(buf.at(-1)?.line).toBe(`line ${flood - 1}`);
    expect(buf[0].seq).toBeGreaterThan(1);
    expect(buf.at(-1)!.seq - buf[0].seq + 1).toBe(buf.length);
  });

  it('caps logBuffer by BYTES as well, so few huge lines cannot pin the heap', () => {
    // Decision: The line cap bounds only the count: at MAX_PARTIAL_LINE_CHARS each, 10000 lines are about
    // 1.22 GiB, and a puller would need about 19 callbacks to clear it. Capping bytes makes "one drain
    // covers the ring" hold by construction.
    const huge = 'x'.repeat(128 * 1024);
    const flood = Math.ceil((MAX_BUFFERED_LOG_BYTES / huge.length) * 2);
    expect(flood).toBeLessThan(MAX_BUFFERED_LOG_LINES);
    for (let i = 0; i < flood; i += 1) {
      record(`${huge}${i}`, 'stdout');
    }

    const buf = getBufferedLogLines();
    // Decision: Measure the way `/logs` budgets a page, in serialized bytes, not UTF-16 code units. Code units
    // would let the ring hold up to 6x this on the wire.
    const retained = buf.reduce(
      (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)) + 1,
      0,
    );
    expect(retained).toBeLessThanOrEqual(MAX_BUFFERED_LOG_BYTES);
    expect(buf.at(-1)?.line.endsWith(`${flood - 1}`)).toBe(true);
    expect(buf.at(-1)!.seq - buf[0].seq + 1).toBe(buf.length);

    // Decision: The ring is module state shared with later tests and is now at the cap. Leaving it there makes the
    // next big line evict from the front and shift the indices those tests slice from.
    clearBufferedLogLines();
  });

  it('measures the ring in the same unit a page is budgeted in', () => {
    // Decision: The byte cap exists so the ring fits in what one drain can fetch, and a drain is budgeted in
    // serialized bytes. Control characters JSON-escape to six bytes each, so a ring counted in code units
    // could hold up to 6x its nominal size on the wire.
    const control = '\u0000'.repeat(64 * 1024);
    const flood = Math.ceil((MAX_BUFFERED_LOG_BYTES / (control.length * 6)) * 2);
    expect(flood).toBeLessThan(MAX_BUFFERED_LOG_LINES);
    // Decision: record() mirrors each line to stderr. Keep the NUL bytes out of the test output.
    const mirror = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      for (let i = 0; i < flood; i += 1) {
        record(control, 'stdout');
      }
    } finally {
      mirror.mockRestore();
    }

    const wire = getBufferedLogLines().reduce(
      (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)) + 1,
      0,
    );
    expect(wire).toBeLessThanOrEqual(MAX_BUFFERED_LOG_BYTES);
    expect(wire).toBeLessThanOrEqual(MAX_LOG_PULL_PAGES * MAX_LOG_RESPONSE_BYTES);

    clearBufferedLogLines();
  });

  // Decision: record() also mirrors each line to process.stderr (the last-resort log path). process.stderr.write
  // queues in Node's Writable buffer when the sink drains slowly, so a flood with a blocked consumer
  // would grow that buffer without bound. record() latches on write()'s false return and skips the
  // mirror until 'drain'.
  it('stops mirroring to stderr under backpressure instead of buffering per line', () => {
    // Decision: Clear any saturation latched by an earlier test (fires the registered once-'drain' if set), so this
    // test starts unsaturated.
    process.stderr.emit('drain');
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(false);
    try {
      const flood = 5000;
      for (let i = 0; i < flood; i += 1) {
        record(`line ${i}`, 'stdout');
      }
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      spy.mockRestore();
      // Decision: Release the latch for later tests (fires the once-'drain' set above).
      process.stderr.emit('drain');
    }
  });
});

// Decision: pipeStream splits on CR/LF/CRLF, so `\\r` progress frames reach the live tail before the process
// exits. The line ring caps count, not bytes, so the partial-line buffer has its own cap, or a
// `\
// `-free run can OOM the standard-1 container. Past MAX_PARTIAL_LINE_CHARS it records one truncated
// line and drops the rest until the terminator. The CR of a torn CRLF is tracked in a flag, not
// buffered as data, so it isn't emitted mid-line or at EOF.
describe('build-agent pipeStream line splitting + tail cap', () => {
  class FakeReadable extends EventEmitter {
    setEncoding() {}
    feed(...chunks: Array<string>) {
      for (const chunk of chunks) {
        this.emit('data', chunk);
      }
    }
    end() {
      this.emit('end');
    }
  }

  // Decision: Module log state (logBuffer/logSeq) is shared across tests and not reset, so capture only the lines
  // recorded after this point.
  function capture(run: (src: FakeReadable) => void): Array<string> {
    const before = getBufferedLogLines().length;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    run(src);
    return getBufferedLogLines()
      .slice(before)
      .map((l) => l.line);
  }

  function captureRows(run: (src: FakeReadable) => void) {
    const before = getBufferedLogLines().length;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    run(src);
    return getBufferedLogLines().slice(before);
  }

  it('flushes bare-CR progress frames as lines instead of holding them until end', () => {
    const src = new FakeReadable();
    const before = getBufferedLogLines().length;
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    src.feed('a\rb\rc');
    expect(
      getBufferedLogLines()
        .slice(before)
        .map((l) => l.line),
    ).toEqual(['a', 'b']);
    src.end();
    expect(
      getBufferedLogLines()
        .slice(before)
        .map((l) => l.line),
    ).toEqual(['a', 'b', 'c']);
  });

  it('preserves exact same-chunk CR, LF, CRLF, and EOF delimiters', () => {
    const rows = captureRows((src) => {
      src.feed('a\rb\nc\r\nd');
      src.end();
    });
    expect(rows.map(({ line, lineEnding }) => ({ line, lineEnding }))).toEqual([
      { line: 'a', lineEnding: 'cr' },
      { line: 'b', lineEnding: 'lf' },
      { line: 'c', lineEnding: 'crlf' },
      { line: 'd', lineEnding: 'none' },
    ]);
  });

  it.each(['\n', '\r\n'])(
    'renders piped build output without staircase indentation (%j)',
    async (ending) => {
      const lines = [
        'dependencies:',
        '+ vue 3.5.44',
        '+ void 1.1.11',
        '[build-agent] $ bwf deploy --project example',
        '\u001b[32m✓ built in 119ms\u001b[0m',
        'dist/client/index.html  0.57 kB',
        '  at build (build.ts:10:2)',
        'Uploading 1/2\r\u001b[2K✓ Uploaded 2/2',
        '╭─ https://example.buildwf.dev ─╮',
        '│  2 static assets          │',
        '╰───────────────────────────╯',
        '✓ Successfully deployed!',
      ];
      const rows = captureRows((src) => {
        const raw = lines.join(ending);
        for (let offset = 0; offset < raw.length; offset += 7) {
          src.feed(raw.slice(offset, offset + 7));
        }
        src.end();
      });
      const out = (await formatLogTailMarkdown(rows, rows.length)) as string;
      expect(parseFence(out).content).toEqual([
        ...lines.slice(0, 4),
        '✓ built in 119ms',
        ...lines.slice(5, 7),
        '✓ Uploaded 2/2',
        ...lines.slice(8),
      ]);
      expect(rows[0].lineEnding).toBe(ending === '\n' ? 'lf' : 'crlf');
      expect(rows.some((row) => row.line.includes('\u001b[32m'))).toBe(true);
    },
  );

  it('classifies a CR at a chunk seam after one-byte lookahead', () => {
    const before = getBufferedLogLines().length;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    src.feed('torn\r');
    expect(getBufferedLogLines()).toHaveLength(before);
    src.feed('\nrewrite\r');
    expect(
      getBufferedLogLines()
        .slice(before)
        .map(({ line, lineEnding }) => ({ line, lineEnding })),
    ).toEqual([{ line: 'torn', lineEnding: 'crlf' }]);
    src.feed('next');
    src.end();
    expect(
      getBufferedLogLines()
        .slice(before)
        .map(({ line, lineEnding }) => ({ line, lineEnding })),
    ).toEqual([
      { line: 'torn', lineEnding: 'crlf' },
      { line: 'rewrite', lineEnding: 'cr' },
      { line: 'next', lineEnding: 'none' },
    ]);
  });

  it('keeps an over-cap row bounded while its final CR awaits lookahead', () => {
    const before = getBufferedLogLines().length;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    src.feed(`${'x'.repeat(MAX_PARTIAL_LINE_CHARS * 3)}\r`);
    expect(getBufferedLogLines()).toHaveLength(before);
    src.feed('next');
    src.end();
    const rows = getBufferedLogLines().slice(before);
    expect(rows).toHaveLength(2);
    expect(rows[0].line.length).toBeLessThanOrEqual(MAX_PARTIAL_LINE_CHARS + 32);
    expect(rows[0].line.endsWith('truncated]')).toBe(true);
    expect(rows[0].lineEnding).toBe('cr');
    expect(rows[1]).toMatchObject({ line: 'next', lineEnding: 'none' });
  });

  it('bounds a terminator-free flood to ONE truncated record (memory cap)', () => {
    const before = getBufferedLogLines().length;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    for (let i = 0; i < 200; i++) {
      src.feed('y'.repeat(64 * 1024));
    }
    src.end();
    const recorded = getBufferedLogLines().slice(before);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].line.length).toBeLessThanOrEqual(MAX_PARTIAL_LINE_CHARS + 32);
    expect(recorded[0].line.endsWith('truncated]')).toBe(true);
  });

  it('resumes normal recording after the dropped over-cap line hits a newline', () => {
    const lines = capture((src) => {
      src.feed('z'.repeat(MAX_PARTIAL_LINE_CHARS + 10), 'still-dropped\nafter\n');
      src.end();
    });
    expect(lines).toHaveLength(2);
    expect(lines[0].endsWith('truncated]')).toBe(true);
    expect(lines[1]).toBe('after');
  });

  it('does not flush a carried CR as data at the force-flush boundary (torn CRLF)', () => {
    // Decision: Carrying the `\\r` into `tail` would let the force-flush emit a line ending in `\\r`, and the next
    // chunk's `\
    // ` would open a spurious empty line. The CR is a flag, not buffered.
    const lines = capture((src) => {
      src.feed('x'.repeat(MAX_PARTIAL_LINE_CHARS) + '\r', '\nZ');
      src.end();
    });
    expect(lines.some((l) => l.endsWith('\r'))).toBe(false);
    expect(lines.some((l) => l === '')).toBe(false);
    expect(lines.at(-1)).toBe('Z');
  });

  it('treats a stream ending on a bare CR as a delimiter, not trailing data', () => {
    const lines = capture((src) => {
      src.feed('a\r');
      src.end();
    });
    expect(lines).toEqual(['a']);
  });

  it('does not emit empty lines for a CRLF split across a chunk boundary at the CR|LF seam', () => {
    // Decision: Hold back the first chunk's trailing `\\r`, so the next chunk's `\
    // ` completes the CRLF without a
    // spurious empty record.
    const lines = capture((src) => {
      src.feed('x\r', '\ny\r\n');
      src.end();
    });
    expect(lines).toEqual(['x', 'y']);
  });

  it('preserves plain newline splitting (no behavior change for LF streams)', () => {
    const withTrailing = capture((src) => {
      src.feed('a\nb\nc\n');
      src.end();
    });
    expect(withTrailing).toEqual(['a', 'b', 'c']);

    const noTrailing = capture((src) => {
      src.feed('a\nb\nc');
      src.end();
    });
    expect(noTrailing).toEqual(['a', 'b', 'c']);
  });

  it('flushes a partial tail with no trailing newline on end', () => {
    const lines = capture((src) => {
      src.feed('partial-no-newline');
      src.end();
    });
    expect(lines).toEqual(['partial-no-newline']);
  });

  // Decision: A bare-CR flood (a runaway spinner or a malicious build) emits one record() per CR. The per-line
  // byte cap can't help, since each line is short. The hazard is the count of lines piling into the
  // unflushed PUSH batch inside one synchronous 'data' handler (the flush timer can't fire until it
  // yields). MAX_PENDING_LOG_LINES bounds the batch.
  it('bounds the pending PUSH batch under a bare-CR delimiter flood', () => {
    const flood = MAX_PENDING_LOG_LINES * 3 + 11;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    src.feed('\r'.repeat(flood));
    expect(getPendingLogLineCount()).toBeLessThanOrEqual(MAX_PENDING_LOG_LINES);
  });
});
