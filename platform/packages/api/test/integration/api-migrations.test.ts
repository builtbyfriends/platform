import { createHash } from 'node:crypto';
import { canonicalJson } from '@builtbyfriends/deploy-core';
import { eq } from 'drizzle-orm';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import { deleteRollbackLease } from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
import app from '../../src/index.ts';
import * as projectAccess from '../../src/project-access.ts';
import {
  deployments,
  domains,
  projectMembers,
  projectMigrations,
  projects,
  resources,
  users,
} from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  mockCfApi,
  cfSuccess,
  cfError,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { setTestDb } from './setup.ts';

let env: TestEnv;

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
});

// Decision: Stateful D1 mock with just enough of the D1 REST query surface to run runRemoteMigrations end to
// end through the Hono app: the tracking-table create, legacy-table detection and upgrade, the
// `_void_migrations` select, per-migration execution, the atomic SQL/tracking batch, and the
// rename UPDATE. It doesn't parse or execute application SQL on purpose: it records the SQL,
// tracks `_void_migrations` and (optionally) `_migrations` rows as in-memory maps, and returns
// success for unknown application SQL unless a failing pattern says otherwise.
type FailingRule = {
  match: RegExp;
  message: string;
  status?: number;
  maxHits?: number;
  hits?: number;
};

type D1MockState = {
  trackingRows: Map<string, string>;
  legacyRows?: Map<string, string>;
  failingSqlPatterns: Array<FailingRule>;
  queries: Array<{ sql: string; params?: Array<unknown> }>;
  // Decision: Models whether `_void_migrations` exists on the remote DB. A SELECT, INSERT or UPDATE on it while
  // this is false returns "no such table", like D1. The flag flips to true the first time the mock
  // sees `CREATE TABLE IF NOT EXISTS _void_migrations`, so a change that reorders
  // `ensureTrackingTable()` and drops the CREATE breaks on the downstream queries. Defaults to true
  // when `trackingRows` is pre-populated and false otherwise.
  bwfTableExists: boolean;
  // Decision: Simulates real concurrent-CREATE races, where the first request commits the DDL before the
  // second runs the same statement.
  simulateDuplicateCreate?: boolean;
  _seenCreateSql?: Set<string>;
};

function createD1State(init: Partial<D1MockState> = {}): D1MockState {
  const trackingRows = new Map(init.trackingRows ?? []);
  return {
    trackingRows,
    legacyRows: init.legacyRows ? new Map(init.legacyRows) : undefined,
    failingSqlPatterns: init.failingSqlPatterns ?? [],
    queries: [],
    bwfTableExists: init.bwfTableExists ?? trackingRows.size > 0,
    simulateDuplicateCreate: init.simulateDuplicateCreate,
    _seenCreateSql: init.simulateDuplicateCreate ? new Set() : undefined,
  };
}

function makeQueryD1(state: D1MockState) {
  const noBwfTable = () => cfError('no such table: _void_migrations', 400);

  return (_url: string, init?: RequestInit): Response => {
    const parsed = init?.body ? JSON.parse(String(init.body)) : {};
    const sql = String(parsed.sql ?? '');
    const params = parsed.params;
    state.queries.push({ sql, params });

    for (const rule of state.failingSqlPatterns) {
      if (rule.match.test(sql)) {
        rule.hits = (rule.hits ?? 0) + 1;
        if (rule.maxHits !== undefined && rule.hits > rule.maxHits) {
          continue;
        }
        return cfError(rule.message, rule.status ?? 500);
      }
    }

    if (/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+_void_migrations/i.test(sql)) {
      state.bwfTableExists = true;
      return cfSuccess([{ results: [] }]);
    }

    if (/sqlite_master[\s\S]*_migrations/i.test(sql)) {
      const legacyPresent = !!state.legacyRows;
      return cfSuccess([{ results: legacyPresent ? [{ name: '_migrations' }] : [] }]);
    }

    // Decision: Gated on _void_migrations existing: if production code issues this before the CREATE, the mock
    // returns "no such table" like real D1 would.
    if (/INSERT\s+OR\s+IGNORE\s+INTO\s+_void_migrations[\s\S]*FROM\s+_migrations/i.test(sql)) {
      if (!state.bwfTableExists) {
        return noBwfTable();
      }
      if (state.legacyRows) {
        for (const [name, appliedAt] of state.legacyRows) {
          if (!state.trackingRows.has(name)) {
            state.trackingRows.set(name, appliedAt);
          }
        }
      }
      return cfSuccess([{ results: [] }]);
    }

    if (/DROP\s+TABLE\s+_migrations\b/i.test(sql)) {
      state.legacyRows = undefined;
      return cfSuccess([{ results: [] }]);
    }

    if (/SELECT\s+name\s+FROM\s+_void_migrations\s*$/i.test(sql.trim())) {
      if (!state.bwfTableExists) {
        return noBwfTable();
      }
      const results = Array.from(state.trackingRows.keys()).map((name) => ({ name }));
      return cfSuccess([{ results }]);
    }

    // Decision: Multi-statement recovery recheck. Reads the live trackingRows so a concurrent winner's tracking
    // row that landed between the loser's preflight and its failing SQL is observed.
    if (/SELECT\s+name\s+FROM\s+_void_migrations\s+WHERE\s+name\s*=\s*\?/i.test(sql)) {
      if (!state.bwfTableExists) {
        return noBwfTable();
      }
      const name = Array.isArray(params) ? (params[0] as string | undefined) : undefined;
      const found = name !== undefined && state.trackingRows.has(name) ? [{ name }] : [];
      return cfSuccess([{ results: found }]);
    }

    if (/SELECT\s+name,\s*applied_at\s+FROM\s+_void_migrations/i.test(sql)) {
      if (!state.bwfTableExists) {
        return noBwfTable();
      }
      const results = Array.from(state.trackingRows.entries()).map(([name, applied_at]) => ({
        name,
        applied_at,
      }));
      return cfSuccess([{ results }]);
    }

    if (/SELECT\s+name,\s*applied_at\s+FROM\s+_migrations/i.test(sql)) {
      if (!state.legacyRows) {
        return cfError('no such table: _migrations', 400);
      }
      const results = Array.from(state.legacyRows.entries()).map(([name, applied_at]) => ({
        name,
        applied_at,
      }));
      return cfSuccess([{ results }]);
    }

    if (/UPDATE\s+_void_migrations\s+SET\s+name\s*=\s*\?\s+WHERE\s+name\s*=\s*\?/i.test(sql)) {
      if (!state.bwfTableExists) {
        return noBwfTable();
      }
      let changes = 0;
      if (Array.isArray(params) && typeof params[0] === 'string' && typeof params[1] === 'string') {
        const [to, from] = params as [string, string];
        const appliedAt = state.trackingRows.get(from);
        if (appliedAt !== undefined) {
          state.trackingRows.delete(from);
          state.trackingRows.set(to, appliedAt);
          changes = 1;
        }
      }
      return cfSuccess([{ results: [], meta: { changes } }]);
    }

    if (
      /SELECT\s+name\s+FROM\s+_void_migrations\s+WHERE\s+name\s*=\s*\?\s+OR\s+name\s*=\s*\?/i.test(
        sql,
      )
    ) {
      if (!state.bwfTableExists) {
        return noBwfTable();
      }
      const results: Array<{ name: string }> = [];
      if (Array.isArray(params)) {
        for (const p of params) {
          if (typeof p === 'string' && state.trackingRows.has(p)) {
            results.push({ name: p });
          }
        }
      }
      return cfSuccess([{ results }]);
    }

    // Decision: The migration SQL and tracking row share one atomic request. Failure injection above rejects the
    // whole request before either is persisted.
    const tracking =
      /\n;\nINSERT INTO _void_migrations \(name, applied_at\) VALUES \('((?:[^']|'')*)', '([^']+)'\);$/.exec(
        sql,
      );
    if (tracking) {
      if (!state.bwfTableExists) {
        return noBwfTable();
      }
      const name = tracking[1].replaceAll("''", "'");
      if (state.trackingRows.has(name)) {
        return cfError('UNIQUE constraint failed: _void_migrations.name', 500);
      }
      state.trackingRows.set(name, tracking[2]);
      return cfSuccess([{ results: [] }]);
    }

    if (state.simulateDuplicateCreate && /^\s*CREATE\s+TABLE\b/i.test(sql)) {
      const seen = state._seenCreateSql!;
      if (seen.has(sql)) {
        return cfError('table already exists', 500);
      }
      seen.add(sql);
    }

    return cfSuccess([{ results: [] }]);
  };
}

async function insertD1Resource(
  db: TestEnv['db'],
  projectId: string,
  overrides: { id?: string; cfId?: string; binding?: string } = {},
): Promise<void> {
  await db.insert(resources).values({
    id: overrides.id ?? `res_${projectId}`,
    project_id: projectId,
    type: 'd1',
    cf_id: overrides.cfId ?? `${projectId}-d1`,
    binding_name: overrides.binding ?? 'DB',
  });
}

async function insertHyperdriveResource(db: TestEnv['db'], projectId: string): Promise<void> {
  await db.insert(resources).values({
    id: `res_${projectId}_hyperdrive`,
    project_id: projectId,
    type: 'hyperdrive',
    cf_id: `${projectId}-hyperdrive`,
    binding_name: 'HYPERDRIVE',
  });
}

function authedReq(path: string, jwt: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${jwt}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

function sha256Hex(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function buildTestExecutionPlan(input: {
  name: string;
  sql: string;
  kind: 'single-statement' | 'breakpoint-framed' | 'legacy-unsplit-multi-statement';
  stability: 'stable' | 'legacy';
  statements?: Array<string>;
}): Record<string, unknown> {
  const plan: Record<string, unknown> = {
    classifierVersion: 1,
    dialect: 'sqlite',
    kind: input.kind,
    name: input.name,
    sqlHash: sha256Hex(input.sql.replaceAll(/\r\n?/g, '\n')),
    stability: input.stability,
  };
  if (input.kind === 'breakpoint-framed') {
    plan.statements = input.statements ?? [];
  }
  plan.planHash = sha256Hex(canonicalJson(plan));
  return plan;
}

describe('GET /projects/:id/migrations', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/projects/proj_fake/migrations'), env);
    expect(res.status).toBe(401);
  });

  it('returns 403 for wrong user', async () => {
    const alice = await createTestUser(env.db, 'alice-mig');
    const bob = await createTestUser(env.db, 'bob-mig');
    const project = await createTestProject(env.db, alice.id, 'alice-mig-app');

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, bob.jwt), env);
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown project id', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(authedReq('/projects/proj_nonexistent/migrations', user.jwt), env);
    expect(res.status).toBe(404);
  });

  it('returns empty applied when no D1 resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-d1-app');

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, user.jwt), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: [] });
  });

  it('returns applied migrations from platform metadata for external database projects', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-mig-status');
    await insertHyperdriveResource(env.db, project.id);
    await env.db.insert(projectMigrations).values([
      {
        project_id: project.id,
        name: '002_alter.sql',
        applied_at: '2025-01-02T00:00:00Z',
      },
      {
        project_id: project.id,
        name: '001_create.sql',
        applied_at: '2025-01-01T00:00:00Z',
      },
    ]);

    const expected = {
      applied: [
        { name: '001_create.sql', applied_at: '2025-01-01 00:00:00' },
        { name: '002_alter.sql', applied_at: '2025-01-02 00:00:00' },
      ],
    };

    for (const dialect of ['postgresql', 'mysql']) {
      const explicitDialect = await app.fetch(
        authedReq(`/projects/${project.id}/migrations?dialect=${dialect}`, user.jwt),
        env,
      );
      expect(explicitDialect.status).toBe(200);
      expect(await explicitDialect.json()).toEqual(expected);
    }

    const inferredDialect = await app.fetch(
      authedReq(`/projects/${project.id}/migrations`, user.jwt),
      env,
    );
    expect(inferredDialect.status).toBe(200);
    expect(await inferredDialect.json()).toEqual(expected);
  });

  it('returns applied migrations from _void_migrations', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-mig-app');
    await insertD1Resource(env.db, project.id);

    mockCfApi({
      queryD1: () =>
        cfSuccess([
          {
            results: [
              { name: '001_create.sql', applied_at: '2025-01-01T00:00:00Z' },
              { name: '002_alter.sql', applied_at: '2025-01-02T00:00:00Z' },
            ],
          },
        ]),
    });

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, user.jwt), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      applied: [
        { name: '001_create.sql', applied_at: '2025-01-01T00:00:00Z' },
        { name: '002_alter.sql', applied_at: '2025-01-02T00:00:00Z' },
      ],
    });
  });

  it('merges rows from _void_migrations and legacy _migrations without duplicates and sorts by name', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-mig-merge');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      trackingRows: new Map([
        ['002_alter.sql', '2025-01-02T00:00:00Z'],
        ['003_index.sql', '2025-01-03T00:00:00Z'],
      ]),
      legacyRows: new Map([
        ['001_init.sql', '2024-12-31T00:00:00Z'],
        ['002_alter.sql', '2024-12-31T10:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, user.jwt), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applied: Array<{ name: string; applied_at: string }>;
    };
    // Decision: _void_migrations is primary, so a duplicate keeps its timestamp.
    expect(body.applied).toEqual([
      { name: '001_init.sql', applied_at: '2024-12-31T00:00:00Z' },
      { name: '002_alter.sql', applied_at: '2025-01-02T00:00:00Z' },
      { name: '003_index.sql', applied_at: '2025-01-03T00:00:00Z' },
    ]);
  });

  it('tolerates a missing _void_migrations table and returns only legacy rows', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-mig-legacy-only');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      legacyRows: new Map([['001_init.sql', '2024-06-01T00:00:00Z']]),
      failingSqlPatterns: [
        {
          match: /SELECT\s+name,\s*applied_at\s+FROM\s+_void_migrations/i,
          message: 'no such table: _void_migrations',
          status: 400,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, user.jwt), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      applied: [{ name: '001_init.sql', applied_at: '2024-06-01T00:00:00Z' }],
    });
  });

  it('surfaces a non-missing-table D1 failure on _void_migrations as 500', async () => {
    // Decision: CF API token expired, quota hit, "database is locked" and similar mustn't be reported as
    // `{ applied: [] }`, which looks the same as "nothing applied yet" and leads callers to re-run
    // migrations. GET surfaces anything that isn't a plain missing-table error. GET reads `_migrations`
    // first (torn-read safety); here that read returns "no such table" (no legacyRows) and is
    // swallowed, then the _void_migrations auth error has to surface as a 500.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-mig-auth-fail');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      failingSqlPatterns: [
        {
          match: /SELECT\s+name,\s*applied_at\s+FROM\s+_void_migrations/i,
          message: 'Authentication error: bad token',
          status: 401,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, user.jwt), env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Authentication error');
  });

  it('reads legacy _migrations before _void_migrations (torn-read safety)', async () => {
    // Decision: GET reads the legacy table first so an in-flight upgrade racing past `DROP TABLE _migrations`
    // doesn't make applied migrations disappear for a moment. The upgrade is three non-atomic D1
    // calls: CREATE _void_migrations, INSERT OR IGNORE ... FROM _migrations, DROP TABLE _migrations.
    // Reading _void_migrations first can see an empty result (table just created) and then find
    // _migrations gone, returning `{ applied: [] }`. Reading legacy first is race-free because
    // _migrations can only disappear after its rows were copied.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-mig-read-order');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      trackingRows: new Map([['001_init.sql', '2025-01-01T00:00:00Z']]),
      legacyRows: new Map([['000_bootstrap.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, user.jwt), env);
    expect(res.status).toBe(200);

    const reads = state.queries
      .map((q) => q.sql)
      .filter((s) => /SELECT\s+name,\s*applied_at\s+FROM\s+_(?:void_)?migrations/i.test(s));
    expect(reads[0]).toMatch(/FROM\s+_migrations\b/i);
    expect(reads[1]).toMatch(/FROM\s+_void_migrations\b/i);
  });

  it('surfaces a non-missing-table D1 failure on legacy _migrations as 500', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-mig-legacy-fail');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      failingSqlPatterns: [
        {
          match: /SELECT\s+name,\s*applied_at\s+FROM\s+_void_migrations/i,
          message: 'no such table: _void_migrations',
          status: 400,
        },
        {
          match: /SELECT\s+name,\s*applied_at\s+FROM\s+_migrations/i,
          message: 'D1_ERROR: network timeout',
          status: 504,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, user.jwt), env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('network timeout');
  });
});

describe('POST /projects/:id/migrations/apply', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_fake/migrations/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ migrations: [] }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for wrong user', async () => {
    const alice = await createTestUser(env.db, 'alice-apply');
    const bob = await createTestUser(env.db, 'bob-apply');
    const project = await createTestProject(env.db, alice.id, 'alice-apply-app');

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, bob.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: [] }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown project id', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      authedReq('/projects/proj_nope/migrations/apply', user.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: [] }),
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('preserves the owner-suspension error from the locked capability recheck', async () => {
    const owner = await createTestUser(env.db, 'suspended-apply-owner');
    const collaborator = await createTestUser(env.db, 'suspended-apply-collaborator');
    const project = await createTestProject(env.db, owner.id, 'suspended-apply-project');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });

    const requireCapability = projectAccess.requireProjectCapability;
    let suspended = false;
    vi.spyOn(projectAccess, 'requireProjectCapability').mockImplementation(async (...args) => {
      const access = await requireCapability(...args);
      if (!suspended && args[3] === 'configure') {
        suspended = true;
        await env.db
          .update(users)
          .set({ suspended_reason: 'platform policy violation' })
          .where(eq(users.id, owner.id));
      }
      return access;
    });

    const response = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, collaborator.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: [] }),
      }),
      env,
    );

    expect(suspended).toBe(true);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'project owner suspended',
      message: expect.stringMatching(/contact the platform administrator/i),
    });
  });

  it('returns 400 when no D1 resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-d1-apply');

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: [{ name: '001.sql', sql: 'SELECT 1' }] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no D1 database found for this project' });
  });

  it('returns 400 for invalid payload (missing migrations array)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bad-payload-1');
    await insertD1Resource(env.db, project.id);

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'migrations array required' });
  });

  it('returns 400 for invalid payload (non-array migrations)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bad-payload-2');
    await insertD1Resource(env.db, project.id);

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: 'nope' }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when a migration entry has a missing or non-string name', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bad-payload-3');
    await insertD1Resource(env.db, project.id);

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: [{ sql: 'SELECT 1' }] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'each migration must have a non-empty string "name" and string "sql"',
    });
  });

  it('returns 400 when a migration entry has a non-string sql', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bad-payload-4');
    await insertD1Resource(env.db, project.id);

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001.sql', sql: 42 }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when a migration entry has an empty name', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bad-payload-5');
    await insertD1Resource(env.db, project.id);

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '', sql: 'SELECT 1' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when the payload contains duplicate migration names', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dup-names');
    await insertD1Resource(env.db, project.id);

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001.sql', sql: 'SELECT 1' },
            { name: '001.sql', sql: 'SELECT 2' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'duplicate migration name: 001.sql' });
  });

  it('accepts protocol v2 execution plans only after server classification matches', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'v2-plan-ok');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const sql = 'CREATE TABLE a (id TEXT);\n--> statement-breakpoint\nCREATE TABLE b (id TEXT);';
    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrationProtocolVersion: 2,
          migrations: [{ name: '001_breakpoints.sql', sql }],
          executionPlans: [
            buildTestExecutionPlan({
              name: '001_breakpoints.sql',
              sql,
              kind: 'breakpoint-framed',
              stability: 'stable',
              statements: ['CREATE TABLE a (id TEXT);', 'CREATE TABLE b (id TEXT);'],
            }),
          ],
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings?: Array<string>; applied: Array<string> };
    expect(body.applied).toEqual(['001_breakpoints.sql']);
    expect(body.warnings?.[0]).toContain('legacy compensating runner');
    expect(state.trackingRows.has('001_breakpoints.sql')).toBe(true);
  });

  it('rejects execution plans whose breakpoint statements only match marker-shaped strings', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'v2-plan-bad');
    const sql =
      "INSERT INTO logs(message) VALUES('--> statement-breakpoint');\n" +
      'CREATE TABLE later (id TEXT);';

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrationProtocolVersion: 2,
          migrations: [{ name: '001_bad_plan.sql', sql }],
          executionPlans: [
            buildTestExecutionPlan({
              name: '001_bad_plan.sql',
              sql,
              kind: 'breakpoint-framed',
              stability: 'stable',
              statements: [
                "INSERT INTO logs(message) VALUES('",
                "');\nCREATE TABLE later (id TEXT);",
              ],
            }),
          ],
        }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      'kind does not match server classification',
    );
  });

  it('accepts an empty migrations array and reports zero applied and zero skipped', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'empty-apply');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: [] }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: [], skipped: [] });
  });

  it('applies a fresh migration end-to-end and writes the tracking row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'fresh-apply');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_init.sql'],
      skipped: [],
    });
    expect(state.trackingRows.has('001_init.sql')).toBe(true);
  });

  it('skips migrations already recorded in the tracking table', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'skip-applied');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      trackingRows: new Map([['001_init.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT)' },
            { name: '002_new.sql', sql: 'CREATE TABLE posts (id TEXT)' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['002_new.sql'],
      skipped: ['001_init.sql'],
    });
  });

  it('upgrades the legacy _migrations table into _void_migrations before applying', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-upgrade');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      legacyRows: new Map([['001_init.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT)' },
            { name: '002_posts.sql', sql: 'CREATE TABLE posts (id TEXT)' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['002_posts.sql'],
      skipped: ['001_init.sql'],
    });
    expect(state.legacyRows).toBeUndefined();
    expect(state.trackingRows.get('001_init.sql')).toBe('2024-01-01T00:00:00Z');
    expect(state.trackingRows.has('002_posts.sql')).toBe(true);

    const upgradeSteps = state.queries
      .map((q) => q.sql)
      .filter((s) =>
        /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+_void_migrations|FROM\s+sqlite_master|INSERT\s+OR\s+IGNORE\s+INTO\s+_void_migrations[\s\S]*FROM\s+_migrations|DROP\s+TABLE\s+_migrations\b|^\s*SELECT\s+name\s+FROM\s+_void_migrations\s*$/i.test(
          s,
        ),
      );
    expect(upgradeSteps[0]).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+_void_migrations/i);
    expect(upgradeSteps[1]).toMatch(/FROM\s+sqlite_master/i);
    expect(upgradeSteps[2]).toMatch(
      /INSERT\s+OR\s+IGNORE\s+INTO\s+_void_migrations[\s\S]*FROM\s+_migrations/i,
    );
    expect(upgradeSteps[3]).toMatch(/DROP\s+TABLE\s+_migrations\b/i);
    expect(upgradeSteps[4]).toMatch(/^\s*SELECT\s+name\s+FROM\s+_void_migrations\s*$/i);
  });

  it('upgrade preserves existing _void_migrations timestamps when legacy has a conflicting row', async () => {
    // Decision: Real-world path: a project ran the old `_migrations` table, partly upgraded, and now has both
    // tables with an overlapping row. Production uses `INSERT OR IGNORE ... FROM _migrations`, so the
    // existing `_void_migrations` row wins on the overlap and missing legacy rows are copied verbatim.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-overlap');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      trackingRows: new Map([
        ['001_init.sql', '2025-06-01T00:00:00Z'],
        ['002_alter.sql', '2025-06-02T00:00:00Z'],
      ]),
      legacyRows: new Map([
        ['001_init.sql', '2024-01-01T00:00:00Z'],
        ['003_index.sql', '2024-02-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: [] }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: [], skipped: [] });

    expect(state.legacyRows).toBeUndefined();
    expect(state.trackingRows.size).toBe(3);
    expect(state.trackingRows.get('001_init.sql')).toBe('2025-06-01T00:00:00Z');
    expect(state.trackingRows.get('002_alter.sql')).toBe('2025-06-02T00:00:00Z');
    expect(state.trackingRows.get('003_index.sql')).toBe('2024-02-02T00:00:00Z');
  });

  it('tolerates a concurrent legacy-upgrade race where the winner already copied and dropped', async () => {
    // Decision: Two overlapping /migrations/apply calls both pass the sqlite_master probe for `_migrations`. The
    // winner copies and drops the legacy table; the loser's copy INSERT then fails with
    // `no such table: _migrations`. The loser's copy catches only `no such table` and continues, the
    // DROP fails safely via its catch, and the loser completes with 200.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-upgrade-race');
    await insertD1Resource(env.db, project.id);

    // Decision: Simulates the winner's outcome: rows already in trackingRows and the legacy table dropped, but
    // the sqlite_master probe still reports the legacy table (both callers probed before either
    // upgrade ran). The probe checks `!!state.legacyRows`, and an empty Map is truthy, so keep it
    // defined for the probe; the failing pattern clears it so a later DROP also sees it gone.
    const state = createD1State({
      trackingRows: new Map([['001_init.sql', '2024-01-01T00:00:00Z']]),
      legacyRows: new Map(),
      failingSqlPatterns: [
        {
          match: /INSERT\s+OR\s+IGNORE\s+INTO\s+_void_migrations[\s\S]*FROM\s+_migrations/i,
          message: 'no such table: _migrations',
          status: 400,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT)' },
            { name: '002_posts.sql', sql: 'CREATE TABLE posts (id TEXT)' },
          ],
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['002_posts.sql'],
      skipped: ['001_init.sql'],
    });
    expect(state.trackingRows.get('001_init.sql')).toBe('2024-01-01T00:00:00Z');
    expect(state.trackingRows.has('002_posts.sql')).toBe(true);
  });

  it('blocks a pending destructive migration without the pragma', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'destructive-block');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_drop.sql', sql: 'DROP TABLE users' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('001_drop.sql');
    expect(body.error).toContain('platform:allow-destructive');
    const appSql = state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql));
    expect(appSql).toBeUndefined();
  });

  it('blocks a destructive migration with a malformed pragma (missing space after --)', async () => {
    // Decision: Production uses `sql.includes(DESTRUCTIVE_PRAGMA)` with the exact literal
    // `-- platform:allow-destructive`. `--platform:allow-destructive` (no space after `--`) isn't a
    // valid SQL comment in SQLite and mustn't unlock the destructive path.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'destructive-near-miss-1');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop.sql',
              sql: '--platform:allow-destructive\nDROP TABLE users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('001_drop.sql');
    const droppedReached = state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql));
    expect(droppedReached).toBeUndefined();
  });

  it('blocks a destructive migration whose pragma is hidden in a string literal (not a real comment)', async () => {
    // Decision: Attack: the pragma appears inside a string literal, not as a SQL comment. A raw
    // `sql.includes('-- platform:allow-destructive')` check would authorize it. The route tokenizes
    // strings and comments and only honors the pragma when it's a real comment.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'destructive-literal-attack');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_sneaky.sql',
              sql:
                "INSERT INTO notes(txt) VALUES('-- platform:allow-destructive');\n" +
                'DROP TABLE users;',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('001_sneaky.sql');
    expect(body.error).toContain('platform:allow-destructive');
    const droppedReached = state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql));
    expect(droppedReached).toBeUndefined();
  });

  it('blocks a destructive migration whose pragma is inside an identifier quote', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'destructive-ident-attack');
    await insertD1Resource(env.db, project.id);

    mockCfApi({ queryD1: makeQueryD1(createD1State()) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_ident.sql',
              sql: 'CREATE TABLE "-- platform:allow-destructive" (id TEXT);\nDROP TABLE users;',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('does not false-positive on a destructive pattern that only appears inside a string literal', async () => {
    // Decision: DESTRUCTIVE_PATTERNS mustn't match inside a string literal.
    // `INSERT INTO audit_log VALUES('DROP TABLE users')` is logging data, not destructive DDL, and
    // applies without the pragma.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-false-positive');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_audit.sql',
              sql:
                'CREATE TABLE audit_log (msg TEXT);\n' +
                "INSERT INTO audit_log (msg) VALUES ('DROP TABLE users');",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_audit.sql'],
      skipped: [],
    });
  });

  it('blocks a destructive migration with an upper-case pragma variant', async () => {
    // Decision: The pragma match is case-sensitive on purpose. This pins the matcher so it can't silently become
    // a case-insensitive `toLowerCase().includes(...)`.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'destructive-near-miss-2');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop.sql',
              sql: '-- PLATFORM:ALLOW-DESTRUCTIVE\nDROP TABLE users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const droppedReached = state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql));
    expect(droppedReached).toBeUndefined();
  });

  it('allows a destructive migration when the pragma is present', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'destructive-ok');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop.sql',
              sql: '-- platform:allow-destructive\nDROP TABLE legacy_users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_drop.sql'],
      skipped: [],
    });
  });

  it('covers the DROP COLUMN destructive pattern', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'drop-col-block');
    await insertD1Resource(env.db, project.id);

    mockCfApi({ queryD1: makeQueryD1(createD1State()) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop_col.sql',
              sql: 'ALTER TABLE users DROP COLUMN email',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('covers the ALTER TABLE RENAME destructive pattern', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'alter-rename-block');
    await insertD1Resource(env.db, project.id);

    mockCfApi({ queryD1: makeQueryD1(createD1State()) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: 'ALTER TABLE users RENAME TO customers',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('covers the TRUNCATE destructive pattern', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'truncate-block');
    await insertD1Resource(env.db, project.id);

    mockCfApi({ queryD1: makeQueryD1(createD1State()) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_trunc.sql',
              sql: 'TRUNCATE TABLE sessions',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('blocks a DROP VIEW migration without the pragma', async () => {
    // Decision: Views can be load-bearing parts of an app schema (materialized lookups, exposed read APIs), so
    // dropping one needs the same explicit opt-in as DROP TABLE.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'drop-view-block');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop_view.sql',
              sql: 'DROP VIEW active_users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /DROP\s+VIEW/i.test(q.sql))).toBeUndefined();
  });

  it('blocks a quoted-identifier ALTER TABLE RENAME', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'alter-rename-quoted');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_quoted_rename.sql',
              sql: 'ALTER TABLE "user data" RENAME TO users_archive',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /RENAME/i.test(q.sql))).toBeUndefined();
  });

  it('blocks destructive SQL whose pragma is documentation inside a block comment', async () => {
    // Decision: Only a standalone `-- platform:allow-destructive` line comment authorizes. The text inside a
    // block comment is documentation, not authorization.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pragma-in-block');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop.sql',
              sql:
                '/* docs: use -- platform:allow-destructive to permit table drops */\n' +
                'DROP TABLE users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql))).toBeUndefined();
  });

  it('blocks destructive SQL whose pragma is part of a longer line comment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pragma-in-line-doc');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop.sql',
              sql:
                '-- TODO: maybe add -- @builtbyfriends/bwf:allow-destructive here?\n' +
                'DROP TABLE users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql))).toBeUndefined();
  });

  it('blocks DROP TABLE separated from its keyword by a block comment', async () => {
    // Decision: SQLite parses `DROP/**/TABLE users` as a real DROP TABLE. Block comments have to be replaced
    // with a single space (not deleted) so `DROP/**/TABLE` becomes `DROP TABLE` in the tokenized
    // stream and the guard regex fires.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'block-comment-bypass');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_drop.sql', sql: 'DROP/**/TABLE users' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /DROP[\s\S]*TABLE/i.test(q.sql))).toBeUndefined();
  });

  it('blocks ALTER TABLE RENAME TO separated by a block comment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'block-comment-rename');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: 'ALTER/**/TABLE users RENAME TO users_archive',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /RENAME/i.test(q.sql))).toBeUndefined();
  });

  it('blocks destructive SQL with a trailing pragma on the same line', async () => {
    // Decision: The standalone-pragma rule checks that the `--` starts its line. Otherwise
    // `CREATE TABLE t (id TEXT); -- platform:allow-destructive` followed by `DROP TABLE users` would
    // take the pragma from the trailing comment on line 1 and authorize the DROP on line 2.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'trailing-pragma');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop.sql',
              sql: 'CREATE TABLE t (id TEXT); -- platform:allow-destructive\nDROP TABLE users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql))).toBeUndefined();
  });

  it('still authorizes a standalone-line pragma directive', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'standalone-pragma');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop.sql',
              sql: '-- platform:allow-destructive\nDROP TABLE users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql))).toBeDefined();
    expect(state.trackingRows.has('001_drop.sql')).toBe(true);
  });

  it('does NOT block ALTER TABLE ADD COLUMN named "rename"', async () => {
    // Decision: A broad regex like `/\bALTER\s+TABLE\b[^;]*?\bRENAME\b/i` would match any later token named
    // `rename`, not actual rename syntax. `ALTER TABLE users ADD COLUMN rename TEXT` is a legal additive
    // migration and has to pass.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'add-col-named-rename');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_add_col_rename.sql',
              sql: 'ALTER TABLE users ADD COLUMN rename TEXT',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(
      state.queries.find((q) => /ALTER\s+TABLE\s+users\s+ADD\s+COLUMN\s+rename/i.test(q.sql)),
    ).toBeDefined();
    expect(state.trackingRows.has('001_add_col_rename.sql')).toBe(true);
  });

  it('still blocks ALTER TABLE RENAME COLUMN', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rename-column-still-blocked');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename_col.sql',
              sql: 'ALTER TABLE users RENAME COLUMN name TO full_name',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /RENAME\s+COLUMN/i.test(q.sql))).toBeUndefined();
  });

  it('blocks legacy ALTER TABLE RENAME <col> TO <col> without COLUMN keyword', async () => {
    // Decision: SQLite still accepts the legacy bare column rename `ALTER TABLE t RENAME old_col TO new_col` (no
    // `COLUMN` keyword). The destructive regex has to catch it alongside RENAME TO and RENAME COLUMN.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-rename-bare');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: 'ALTER TABLE users RENAME old_col TO new_col',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /RENAME/i.test(q.sql))).toBeUndefined();
  });

  it('allows legacy ALTER TABLE RENAME <col> TO <col> with the pragma', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-rename-bare-ok');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: '-- platform:allow-destructive\nALTER TABLE users RENAME old_col TO new_col',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(state.trackingRows.has('001_rename.sql')).toBe(true);
  });

  it('blocks legacy ALTER TABLE RENAME with double-quoted identifiers', async () => {
    // Decision: The tokenizer replaces quoted identifier bodies with `"_"`, so the legacy branch
    // `[^;\s]+\s+TO\b` matches on the placeholder.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-rename-quoted');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: 'ALTER TABLE users RENAME "old col" TO "new col"',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('platform:allow-destructive');
  });

  it('blocks legacy ALTER TABLE RENAME with bracketed identifiers', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-rename-bracket');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: 'ALTER TABLE users RENAME [old col] TO [new col]',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('platform:allow-destructive');
  });

  it('does NOT block ALTER TABLE ADD COLUMN rename TEXT under the widened regex', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'add-col-rename-r6');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_add.sql', sql: 'ALTER TABLE users ADD COLUMN rename TEXT' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(state.trackingRows.has('001_add.sql')).toBe(true);
  });

  it('does NOT block ALTER TABLE ADD COLUMN rename_col TEXT NOT NULL DEFAULT', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'add-col-rename-default');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_add.sql',
              sql: "ALTER TABLE users ADD COLUMN rename_col TEXT NOT NULL DEFAULT ''",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(state.trackingRows.has('001_add.sql')).toBe(true);
  });

  it('blocks ALTER TABLE RENAME TO with a semicolon inside a double-quoted identifier', async () => {
    // Decision: A semicolon inside a quoted identifier mustn't cut short the `[^;]*?` lookahead in the ALTER
    // RENAME regex. Identifier bodies become a neutral `_` placeholder, so the code stream reads
    // `ALTER TABLE "_" RENAME TO users_archive` and the guard fires.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'quoted-semicolon-rename');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: 'ALTER TABLE "user;data" RENAME TO users_archive',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /RENAME\s+TO/i.test(q.sql))).toBeUndefined();
  });

  it('blocks ALTER TABLE RENAME COLUMN with a semicolon inside a square-bracket identifier', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bracket-semicolon-rename');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename_col.sql',
              sql: 'ALTER TABLE [user;data] RENAME COLUMN a TO b',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /RENAME\s+COLUMN/i.test(q.sql))).toBeUndefined();
  });

  it('blocks ALTER TABLE RENAME TO with a semicolon inside a backtick identifier', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'backtick-semicolon-rename');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: 'ALTER TABLE `user;data` RENAME TO x',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /RENAME\s+TO/i.test(q.sql))).toBeUndefined();
  });

  it('does NOT block CREATE TABLE with a destructive keyword inside the identifier', async () => {
    // Decision: Identifier bodies are replaced with a neutral placeholder so destructive keywords inside
    // identifiers don't false-positive. `CREATE TABLE "DROP TABLE users" (x INT)` is benign, and the code
    // stream sees `CREATE TABLE "_" (x INT)`.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'identifier-false-positive');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_weird_name.sql',
              sql: 'CREATE TABLE "DROP TABLE users" (x INT)',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(state.queries.find((q) => /CREATE\s+TABLE/i.test(q.sql))).toBeDefined();
    expect(state.trackingRows.has('001_weird_name.sql')).toBe(true);
  });

  it('does not block a destructive migration that is already recorded as applied', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'destructive-already-applied');
    await insertD1Resource(env.db, project.id);

    // Decision: 001 is already in _void_migrations, so its destructive SQL isn't in the pending slice and the
    // filter-then-check path lets the request through.
    const state = createD1State({
      trackingRows: new Map([['001_drop.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_drop.sql', sql: 'DROP TABLE users' },
            { name: '002_add.sql', sql: 'CREATE TABLE posts (id TEXT)' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['002_add.sql'],
      skipped: ['001_drop.sql'],
    });
  });

  it('blocks unbounded DELETE FROM without a WHERE clause', async () => {
    // Decision: An unbounded `DELETE FROM users` silently empties a table, the same irreversible blast radius as
    // DROP TABLE, so it needs the same explicit pragma opt-in.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-unbounded-delete');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_delete.sql', sql: 'DELETE FROM users' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('001_delete.sql');
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /DELETE\s+FROM\s+users/i.test(q.sql))).toBeUndefined();
  });

  it('blocks unbounded UPDATE without a WHERE clause', async () => {
    // Decision: A bare `UPDATE users SET email = NULL` mass-mutates each row. That's the blast radius of DROP
    // COLUMN, so it needs the pragma.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-unbounded-update');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_update.sql', sql: 'UPDATE users SET email = NULL' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('001_update.sql');
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /UPDATE\s+users\s+SET/i.test(q.sql))).toBeUndefined();
  });

  it('blocks unbounded DELETE even when a later statement has a WHERE clause', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f4-delete-later-where');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_mixed.sql',
              sql: "DELETE FROM users; UPDATE posts SET name = 'ok' WHERE id = '1';",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /DELETE\s+FROM\s+users/i.test(q.sql))).toBeUndefined();
  });

  it('blocks unbounded UPDATE when WHERE only appears inside a subquery', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f4-update-subquery-where');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_update.sql',
              sql: "UPDATE users SET name = (SELECT name FROM posts WHERE id = '1');",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /UPDATE\s+users\s+SET/i.test(q.sql))).toBeUndefined();
  });

  it('blocks INSERT OR REPLACE INTO without the pragma', async () => {
    // Decision: `INSERT OR REPLACE` silently deletes any row that collides with the inserted primary key: a
    // destructive overwrite dressed up as an insert.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-insert-or-replace');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_replace.sql',
              sql: "INSERT OR REPLACE INTO users (id, name) VALUES (1, 'x')",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('001_replace.sql');
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /INSERT\s+OR\s+REPLACE\s+INTO/i.test(q.sql))).toBeUndefined();
  });

  it('blocks a trigger body containing unbounded DELETE', async () => {
    // Decision: The outer `CREATE TRIGGER` is benign DDL, but its body can hold any statement, including
    // unbounded DELETE, UPDATE or DROP. The guard has to catch destructive DML nested in a BEGIN...END
    // block.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-trigger-delete');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_trigger.sql',
              sql: 'CREATE TRIGGER t AFTER INSERT ON logs BEGIN DELETE FROM old_logs; END',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('001_trigger.sql');
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /DELETE\s+FROM\s+old_logs/i.test(q.sql))).toBeUndefined();
  });

  it('blocks a TEMP TRIGGER body containing unbounded UPDATE', async () => {
    // Decision: SQLite accepts `TEMP` and `TEMPORARY` between CREATE and TRIGGER. The trigger-body detector
    // accepts both so the qualifier can't sidestep the recursion.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-temp-trigger');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_temp_trigger.sql',
              sql: 'CREATE TEMP TRIGGER t AFTER INSERT ON x BEGIN UPDATE x SET y = NULL; END',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('001_temp_trigger.sql');
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /UPDATE\s+x\s+SET/i.test(q.sql))).toBeUndefined();
  });

  it('blocks a trigger body containing DROP TABLE', async () => {
    // Decision: Triggers can run DDL as well as DML, and a CREATE TRIGGER whose body drops a table slips past the
    // outer destructive-DDL regexes. The recursion re-runs the full destructive check on the body.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-trigger-drop');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_trigger_drop.sql',
              sql: 'CREATE TRIGGER t AFTER INSERT ON x BEGIN DROP TABLE legacy; END',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('001_trigger_drop.sql');
    expect(body.error).toContain('platform:allow-destructive');
    expect(state.queries.find((q) => /DROP\s+TABLE\s+legacy/i.test(q.sql))).toBeUndefined();
  });

  it('does NOT block a bounded DELETE with a WHERE clause', async () => {
    // Decision: We treat `WHERE` anywhere in the statement as bounded. The rare WHERE-in-subquery false negative
    // is acceptable because the pragma stays available.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-bounded-delete');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_delete.sql', sql: 'DELETE FROM users WHERE id = 1' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_delete.sql'],
      skipped: [],
    });
  });

  it('does NOT block a bounded UPDATE with a WHERE clause', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-bounded-update');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_update.sql',
              sql: "UPDATE users SET email = 'x' WHERE id = 1",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_update.sql'],
      skipped: [],
    });
  });

  it('does NOT block a plain INSERT INTO', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-plain-insert');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_insert.sql',
              sql: "INSERT INTO users (id, name) VALUES (1, 'x')",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_insert.sql'],
      skipped: [],
    });
  });

  it('does NOT false-positive on a DML keyword inside a string literal', async () => {
    // Decision: The DML detectors run against the tokenizer output (string literals neutralized), so an audit-log
    // insert containing the text "DELETE FROM users" isn't classed as an unbounded DELETE.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-dml-in-literal');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_audit.sql',
              sql: "INSERT INTO audit_log VALUES ('DELETE FROM users')",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_audit.sql'],
      skipped: [],
    });
  });

  it('does NOT block a benign trigger body with additive DML', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-benign-trigger');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_benign_trigger.sql',
              sql: 'CREATE TRIGGER t AFTER INSERT ON x BEGIN INSERT INTO log VALUES (NEW.id); END',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_benign_trigger.sql'],
      skipped: [],
    });
  });

  it('allows unbounded DELETE when the pragma is present', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-delete-ok');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_delete.sql',
              sql: '-- platform:allow-destructive\nDELETE FROM users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_delete.sql'],
      skipped: [],
    });
    expect(state.queries.find((q) => /DELETE\s+FROM\s+users/i.test(q.sql))).toBeDefined();
    expect(state.trackingRows.has('001_delete.sql')).toBe(true);
  });

  it('requires a tracking row before accepting an existing schema object', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'recovery-single');
    await insertD1Resource(env.db, project.id);

    // Decision: Simulates a prior deploy where the CREATE TABLE committed but the tracking INSERT failed: tracking
    // is empty, but the next application-SQL run returns "already exists".
    const state = createD1State({
      failingSqlPatterns: [
        {
          match: /CREATE\s+TABLE\s+users\s*\(/i,
          message: 'table users already exists',
          status: 500,
          maxHits: 1,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_init.sql',
              sql: 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(state.trackingRows.has('001_init.sql')).toBe(false);
  });

  it('does NOT use the recovery path for a multi-statement migration and surfaces the error', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'recovery-multi');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      failingSqlPatterns: [
        {
          match: /CREATE\s+TABLE\s+users\s*\(/i,
          message: 'table users already exists',
          status: 500,
          maxHits: 1,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const multiSql = [
      'CREATE TABLE users (id TEXT PRIMARY KEY);',
      '--> statement-breakpoint',
      'CREATE INDEX users_idx ON users(id);',
    ].join('\n');

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_init.sql', sql: multiSql }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('already exists');
    expect(state.trackingRows.has('001_init.sql')).toBe(false);
  });

  it('two concurrent /apply requests serialize via a project row lock and end with exactly one tracking row', async () => {
    // Decision: The per-project pg transaction-scoped row lock serializes two near-simultaneous
    // `/migrations/apply` calls: the second blocks at the transaction boundary until the first commits
    // its D1 writes and its pg metadata append, then sees the winner's tracking row and skips.
    // Without the lock, the loser hits "already exists" at the D1 layer, and the single-statement
    // recovery path (`runRemoteMigrations` + `INSERT OR IGNORE`) still saves it; that path has its own
    // test above.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'concurrent-apply');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({ simulateDuplicateCreate: true });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const body = JSON.stringify({
      migrations: [{ name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)' }],
    });

    const [resA, resB] = await Promise.all([
      app.fetch(
        authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
          method: 'POST',
          body,
        }),
        env,
      ),
      app.fetch(
        authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
          method: 'POST',
          body,
        }),
        env,
      ),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    expect(state.trackingRows.size).toBe(1);
    expect(state.trackingRows.has('001_init.sql')).toBe(true);

    const createCalls = state.queries.filter((q) => /CREATE\s+TABLE\s+users\b/i.test(q.sql)).length;
    expect(createCalls).toBe(1);

    const bodyA = (await resA.json()) as { applied: Array<string>; skipped: Array<string> };
    const bodyB = (await resB.json()) as { applied: Array<string>; skipped: Array<string> };
    expect([...bodyA.applied, ...bodyB.applied].sort()).toEqual(['001_init.sql']);
    expect([...bodyA.skipped, ...bodyB.skipped].sort()).toEqual(['001_init.sql']);
  });

  it('two concurrent /apply requests on a multi-statement migration both succeed', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'concurrent-multi');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({ simulateDuplicateCreate: true });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const multiSql = [
      'CREATE TABLE users (id TEXT PRIMARY KEY);',
      '--> statement-breakpoint',
      'CREATE INDEX users_idx ON users(id);',
    ].join('\n');

    const body = JSON.stringify({
      migrations: [{ name: '001_init.sql', sql: multiSql }],
    });

    const [resA, resB] = await Promise.all([
      app.fetch(
        authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
          method: 'POST',
          body,
        }),
        env,
      ),
      app.fetch(
        authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
          method: 'POST',
          body,
        }),
        env,
      ),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    expect(state.trackingRows.size).toBe(1);
    expect(state.trackingRows.has('001_init.sql')).toBe(true);

    const bodyA = (await resA.json()) as { applied: Array<string>; skipped: Array<string> };
    const bodyB = (await resB.json()) as { applied: Array<string>; skipped: Array<string> };
    expect([...bodyA.applied, ...bodyB.applied]).toEqual(['001_init.sql']);
    expect([...bodyA.skipped, ...bodyB.skipped]).toEqual(['001_init.sql']);

    const multiCalls = state.queries.filter((q) => q.sql.startsWith(multiSql)).length;
    expect(multiCalls).toBe(1);
  });

  it('propagates non-recoverable D1 errors as 500 and does not write the tracking row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'generic-fail');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      failingSqlPatterns: [
        {
          match: /CREATE\s+TABLE\s+posts/i,
          message: 'syntax error near BOOM',
          status: 500,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_init.sql', sql: 'CREATE TABLE posts (id TEXT, BOOM)' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('syntax error');
    expect(state.trackingRows.has('001_init.sql')).toBe(false);
  });

  it('updates the active deployment applied_migrations metadata after a successful apply', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'meta-update');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT)' },
            { name: '002_posts.sql', sql: 'CREATE TABLE posts (id TEXT)' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const updated = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    expect(updated[0]?.applied_migrations).not.toBeNull();
    expect(JSON.parse(updated[0].applied_migrations!)).toEqual(['001_init.sql', '002_posts.sql']);
  });

  it('merges newly-applied migrations with existing deployment metadata without duplicates', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'meta-merge');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['001_init.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([['001_init.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT)' },
            { name: '002_posts.sql', sql: 'CREATE TABLE posts (id TEXT)' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const updated = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    expect(JSON.parse(updated[0].applied_migrations!)).toEqual(['001_init.sql', '002_posts.sql']);
  });

  it('two concurrent /apply requests union their names into applied_migrations without lost updates', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'concurrent-meta');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const bodyA = JSON.stringify({
      migrations: [{ name: '001_a.sql', sql: 'CREATE TABLE a (id TEXT)' }],
    });
    const bodyB = JSON.stringify({
      migrations: [{ name: '002_b.sql', sql: 'CREATE TABLE b (id TEXT)' }],
    });

    const [resA, resB] = await Promise.all([
      app.fetch(
        authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
          method: 'POST',
          body: bodyA,
        }),
        env,
      ),
      app.fetch(
        authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
          method: 'POST',
          body: bodyB,
        }),
        env,
      ),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const updated = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    const merged: Array<string> = JSON.parse(updated[0].applied_migrations!);
    expect(merged.slice().sort()).toEqual(['001_a.sql', '002_b.sql']);
  });

  it('heals deployment metadata from skipped migrations even when nothing is newly applied', async () => {
    // Decision: A retry where the migration is classified `skipped` (D1 row already present) still heals pg
    // metadata: the handler appends the union of applied + skipped so pg reconciles from D1 as the
    // source of truth.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'meta-heal');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const state = createD1State({
      trackingRows: new Map([['001_init.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT)' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const updated = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    expect(updated[0]?.applied_migrations).not.toBeNull();
    expect(JSON.parse(updated[0].applied_migrations!)).toEqual(['001_init.sql']);
  });

  it('applies even when there is no active deployment yet (first-deploy edge case)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-active-deploy');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT)' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_init.sql'],
      skipped: [],
    });
  });

  it('persists committed prefix to pg metadata even when a mid-batch migration fails', async () => {
    // Decision: When migration 001 commits to D1 (SQL and tracking row) and 002 hits a hard error, pg's
    // applied_migrations still has to end up with 001, or rollback diffs and rename corroboration work
    // on corrupt metadata. Two parts: (1) runRemoteMigrations returns `result.failed` instead of
    // throwing on per-migration errors, so the committed prefix stays on `result.applied` /
    // `result.skipped`; (2) /apply appends applied + skipped to pg before surfacing the failure via a
    // `return` (tx-committing) outcome.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r10f1-heal-prefix');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const state = createD1State({
      failingSqlPatterns: [
        { match: /CREATE\s+TABLE\s+posts/i, message: 'no such column: nonsense' },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_users.sql', sql: 'CREATE TABLE users (id TEXT)' },
            { name: '002_posts.sql', sql: 'CREATE TABLE posts (nonsense TEXT)' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      applied: Array<string>;
      skipped: Array<string>;
      failed?: { name: string; error: string };
    };
    expect(body.ok).toBe(false);
    expect(body.applied).toEqual(['001_users.sql']);
    expect(body.skipped).toEqual([]);
    expect(body.failed?.name).toBe('002_posts.sql');

    expect(state.trackingRows.has('001_users.sql')).toBe(true);
    expect(state.trackingRows.has('002_posts.sql')).toBe(false);

    const row = await env.db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(JSON.parse(row[0].applied_migrations!)).toEqual(['001_users.sql']);

    const retry = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_users.sql', sql: 'CREATE TABLE users (id TEXT)' },
            { name: '002_posts.sql', sql: 'CREATE TABLE posts (nonsense TEXT)' },
          ],
        }),
      }),
      env,
    );
    expect(retry.status).toBe(500);
    const retryBody = (await retry.json()) as {
      ok: boolean;
      applied: Array<string>;
      skipped: Array<string>;
      failed?: { name: string };
    };
    expect(retryBody.skipped).toEqual(['001_users.sql']);
    expect(retryBody.applied).toEqual([]);
    expect(retryBody.failed?.name).toBe('002_posts.sql');

    const afterRetry = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    expect(JSON.parse(afterRetry[0].applied_migrations!)).toEqual(['001_users.sql']);
  });
});

describe('POST /projects/:id/migrations/rename', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_x/migrations/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ renames: [{ from: 'a', to: 'b' }] }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for wrong user', async () => {
    const alice = await createTestUser(env.db, 'alice-rn');
    const bob = await createTestUser(env.db, 'bob-rn');
    const project = await createTestProject(env.db, alice.id, 'alice-rn-app');

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, bob.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'a', to: 'b' }] }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown project id', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      authedReq('/projects/proj_none/migrations/rename', user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'a', to: 'b' }] }),
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when no D1 resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-no-d1');
    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'a', to: 'b' }] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no D1 database found for this project' });
  });

  it('returns 400 for an empty renames array', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-empty');
    await insertD1Resource(env.db, project.id);
    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'renames array required' });
  });

  it('returns 400 for a missing renames field', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-missing');
    await insertD1Resource(env.db, project.id);
    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid rename entry (empty from or to)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-bad-entry');
    await insertD1Resource(env.db, project.id);

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: '', to: 'x' }] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'each rename must have non-empty string "from" and "to"',
    });
  });

  it('renames tracking rows and updates the active deployment metadata', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-happy');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql', '002_alter.sql']),
      })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([
        ['001_init.sql', '2024-01-01T00:00:00Z'],
        ['002_alter.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: '001_init.sql', to: '001_create_users.sql' },
            { from: '002_alter.sql', to: '002_add_email.sql' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(state.trackingRows.has('001_init.sql')).toBe(false);
    expect(state.trackingRows.has('002_alter.sql')).toBe(false);
    expect(state.trackingRows.get('001_create_users.sql')).toBe('2024-01-01T00:00:00Z');
    expect(state.trackingRows.get('002_add_email.sql')).toBe('2024-01-02T00:00:00Z');

    const updated = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    expect(JSON.parse(updated[0].applied_migrations!)).toEqual([
      '001_create_users.sql',
      '002_add_email.sql',
    ]);
  });

  it('upgrades the legacy _migrations table before renaming', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-legacy');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      legacyRows: new Map([['001_init.sql', '2023-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '001_renamed.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(state.legacyRows).toBeUndefined();
    expect(state.trackingRows.has('001_init.sql')).toBe(false);
    expect(state.trackingRows.get('001_renamed.sql')).toBe('2023-01-01T00:00:00Z');
  });

  it('propagates a D1 UPDATE failure as 500', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-fail');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      trackingRows: new Map([['001_init.sql', '2024-01-01T00:00:00Z']]),
      failingSqlPatterns: [
        {
          match: /UPDATE\s+_void_migrations/i,
          message: 'database is locked',
          status: 500,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '001_renamed.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('database is locked');
  });

  it('rejects a rename whose "from" is unknown and whose "to" is also unknown', async () => {
    // Decision: A rename where neither side exists in `_void_migrations` is an operator error: the caller names
    // migrations that never landed. Return 400 so the mistake is visible instead of a silent no-op.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-unknown');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: 'does_not_exist.sql', to: 'still_nothing.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('does_not_exist.sql');
    expect(state.queries.find((q) => /UPDATE\s+_void_migrations/i.test(q.sql))).toBeUndefined();
    expect(state.trackingRows.size).toBe(0);
  });

  it('rewrites applied_migrations across active AND retained deployments', async () => {
    // Decision: Each project deployment (active and retained/inactive) is rewritten inside one transaction.
    // Otherwise rollback diffs that compare `applied_migrations` arrays across deployments produce
    // phantom deltas.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-all-deployments');
    await insertD1Resource(env.db, project.id);

    const activeDeployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql', '002_users.sql']),
      })
      .where(eq(deployments.id, activeDeployment.id));

    const retainedDeployment = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql']),
        retained: true,
      })
      .where(eq(deployments.id, retainedDeployment.id));

    const state = createD1State({
      trackingRows: new Map([
        ['001_init.sql', '2024-01-01T00:00:00Z'],
        ['002_users.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '001_create_users.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    expect(state.trackingRows.has('001_init.sql')).toBe(false);
    expect(state.trackingRows.get('001_create_users.sql')).toBe('2024-01-01T00:00:00Z');

    const activeRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, activeDeployment.id));
    expect(JSON.parse(activeRow[0].applied_migrations!)).toEqual([
      '001_create_users.sql',
      '002_users.sql',
    ]);
    const retainedRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, retainedDeployment.id));
    expect(JSON.parse(retainedRow[0].applied_migrations!)).toEqual(['001_create_users.sql']);
  });

  it('rejects a duplicate "from" in the rename batch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-dup-from');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: '001.sql', to: '002.sql' },
            { from: '001.sql', to: '003.sql' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('duplicate "from"');
    expect(state.queries.length).toBe(0);
  });

  it('rejects a duplicate "to" in the rename batch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-dup-to');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: '001.sql', to: '999.sql' },
            { from: '002.sql', to: '999.sql' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('duplicate "to"');
    expect(state.queries.length).toBe(0);
  });

  it('rejects a chain [a→b, b→c] in the rename batch', async () => {
    // Decision: Chains need two-phase renames across non-atomic D1 calls. They're rejected up front to keep the
    // execution path linear and rule out a mid-batch PK collision.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-chain');
    await insertD1Resource(env.db, project.id);
    const state = createD1State({
      trackingRows: new Map([
        ['a.sql', '2024-01-01T00:00:00Z'],
        ['b.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: 'a.sql', to: 'b.sql' },
            { from: 'b.sql', to: 'c.sql' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('chains not supported');
    expect(state.queries.length).toBe(0);
    expect(state.trackingRows.has('a.sql')).toBe(true);
    expect(state.trackingRows.has('b.sql')).toBe(true);
  });

  it('rejects when "to" collides with an existing unrenamed migration', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-collide');
    await insertD1Resource(env.db, project.id);
    const state = createD1State({
      trackingRows: new Map([
        ['001_init.sql', '2024-01-01T00:00:00Z'],
        ['002_existing.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '002_existing.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('already exist');
    expect(state.queries.find((q) => /UPDATE\s+_void_migrations/i.test(q.sql))).toBeUndefined();
    expect(state.trackingRows.has('001_init.sql')).toBe(true);
    expect(state.trackingRows.has('002_existing.sql')).toBe(true);
  });

  it('idempotent retry of an already-landed rename is a no-op 200', async () => {
    // Decision: After a successful rename, a retry of the same payload finds `from` missing and `to` present. It's
    // only classed as "already landed" when pg still references `from` somewhere: corroboration that
    // it's a retry after a prior D1-succeeded / pg-failed run.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-idempotent');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['001_init.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([['001_renamed.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '001_renamed.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(state.queries.find((q) => /UPDATE\s+_void_migrations/i.test(q.sql))).toBeUndefined();
    expect(state.trackingRows.has('001_renamed.sql')).toBe(true);
  });

  it('partial-failure retry lands the remaining rename', async () => {
    // Decision: Prior run: rename 1 (001 to 001_new) landed but rename 2 failed mid-batch. Retrying the batch
    // detects rename 1 as done (pg still has the old name `001.sql`, the fingerprint of a pg write that
    // never committed) and applies rename 2 for real.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-partial');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['001.sql', '002.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([
        ['001_new.sql', '2024-01-01T00:00:00Z'],
        ['002.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: '001.sql', to: '001_new.sql' },
            { from: '002.sql', to: '002_new.sql' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const updateCalls = state.queries.filter((q) => /UPDATE\s+_void_migrations/i.test(q.sql));
    expect(updateCalls.length).toBe(1);
    expect(state.trackingRows.has('001_new.sql')).toBe(true);
    expect(state.trackingRows.has('002.sql')).toBe(false);
    expect(state.trackingRows.has('002_new.sql')).toBe(true);
  });

  it('happy path: two independent renames update remote + active + retained deployments', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-two-independent');
    await insertD1Resource(env.db, project.id);

    const active = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql', '002_alter.sql']),
      })
      .where(eq(deployments.id, active.id));

    const retained = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql', '002_alter.sql']),
        retained: true,
      })
      .where(eq(deployments.id, retained.id));

    const state = createD1State({
      trackingRows: new Map([
        ['001_init.sql', '2024-01-01T00:00:00Z'],
        ['002_alter.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: '001_init.sql', to: '001_create_users.sql' },
            { from: '002_alter.sql', to: '002_add_email.sql' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    expect(state.trackingRows.get('001_create_users.sql')).toBe('2024-01-01T00:00:00Z');
    expect(state.trackingRows.get('002_add_email.sql')).toBe('2024-01-02T00:00:00Z');

    const activeRow = await env.db.select().from(deployments).where(eq(deployments.id, active.id));
    expect(JSON.parse(activeRow[0].applied_migrations!)).toEqual([
      '001_create_users.sql',
      '002_add_email.sql',
    ]);
    const retainedRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, retained.id));
    expect(JSON.parse(retainedRow[0].applied_migrations!)).toEqual([
      '001_create_users.sql',
      '002_add_email.sql',
    ]);
  });

  it('returns 409 when a concurrent rename redirected the same "from" to a different target', async () => {
    // Decision: Two concurrent /rename requests target the same `from` with different `to` values. Both
    // pre-validation snapshots pass, but only one UPDATE changes a row. The loser's UPDATE returns
    // `meta.changes === 0`, and the handler rechecks `_void_migrations`: when the winner picked a
    // different target, return 409 without rewriting pg metadata so pg and D1 don't diverge. The test
    // forces the race by stubbing the UPDATE to report zero changes and pre-seeding the winner's target.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-r7f1-conflict');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['old.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([
        ['old.sql', '2024-01-01T00:00:00Z'],
        ['to_a', '2024-01-01T00:00:00Z'],
      ]),
    });
    const base = makeQueryD1(state);

    // Decision: Force a zero-changes response for the `to_b` UPDATE: the caller's pre-validation passed on an
    // older snapshot, but the winner already moved `old.sql` to `to_a`, so a real UPDATE reports 0
    // changes.
    mockCfApi({
      queryD1: (url, init) => {
        const parsed = init?.body ? JSON.parse(String(init.body)) : {};
        const sql = String(parsed.sql ?? '');
        const params = parsed.params;
        if (
          /UPDATE\s+_void_migrations\s+SET\s+name\s*=\s*\?\s+WHERE\s+name\s*=\s*\?/i.test(sql) &&
          Array.isArray(params) &&
          params[0] === 'to_b'
        ) {
          state.queries.push({ sql, params });
          state.trackingRows.delete('old.sql');
          return cfSuccess([{ results: [], meta: { changes: 0 } }]);
        }
        return base(url, init);
      },
    });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'old.sql', to: 'to_b' }] }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('rename conflict');
    expect(body.error).toContain('old.sql');

    expect(state.trackingRows.has('to_a')).toBe(true);
    expect(state.trackingRows.has('to_b')).toBe(false);
    expect(state.trackingRows.has('old.sql')).toBe(false);

    const row = await env.db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(JSON.parse(row[0].applied_migrations!)).toEqual(['old.sql']);
  });

  it('persists committed prefix to pg metadata when a later rename pair conflicts', async () => {
    // Decision: /rename loops over pairs in order, and earlier pairs can land their UPDATE in D1 (durable) before
    // a later pair fails. The handler catches per-pair failures, stops the loop, persists the committed
    // prefix via renameAppliedMigrationsForProject inside the same row-locked tx, then returns the
    // 409/500 outcome so the tx commits. Otherwise pg's applied_migrations would still reference old
    // names for pairs whose D1 UPDATE already committed.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r10f2-rename-heal');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['a.sql', 'b.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([
        ['a.sql', '2024-01-01T00:00:00Z'],
        ['b.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    const base = makeQueryD1(state);

    mockCfApi({
      queryD1: (url, init) => {
        const parsed = init?.body ? JSON.parse(String(init.body)) : {};
        const sql = String(parsed.sql ?? '');
        const params = parsed.params;
        if (
          /UPDATE\s+_void_migrations\s+SET\s+name\s*=\s*\?\s+WHERE\s+name\s*=\s*\?/i.test(sql) &&
          Array.isArray(params) &&
          params[0] === 'b1.sql'
        ) {
          state.queries.push({ sql, params });
          state.trackingRows.delete('b.sql');
          state.trackingRows.set('b_winner.sql', '2024-01-02T00:00:00Z');
          return cfSuccess([{ results: [], meta: { changes: 0 } }]);
        }
        return base(url, init);
      },
    });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: 'a.sql', to: 'a1.sql' },
            { from: 'b.sql', to: 'b1.sql' },
          ],
        }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      committed: Array<{ from: string; to: string }>;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('rename conflict');
    expect(body.error).toContain('b.sql');
    expect(body.committed).toEqual([{ from: 'a.sql', to: 'a1.sql' }]);

    expect(state.trackingRows.has('a.sql')).toBe(false);
    expect(state.trackingRows.has('a1.sql')).toBe(true);
    expect(state.trackingRows.has('b.sql')).toBe(false);
    expect(state.trackingRows.has('b1.sql')).toBe(false);
    expect(state.trackingRows.has('b_winner.sql')).toBe(true);

    const row = await env.db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(JSON.parse(row[0].applied_migrations!)).toEqual(['a1.sql', 'b.sql']);
  });

  it('same-payload retry reaches uncommitted suffix after partial-failure heal', async () => {
    // Decision: After the partial-failure heal, the active deployment references `to`, not `from`, so
    // `activeDeploymentContainsMigration(from)` no longer corroborates the `!fromExists && toExists`
    // branch on retry. The `migration_renames` audit log is a second corroboration source: a matching
    // row proves the exact (project_id, from, to) pair was committed here, so a retry can treat it as
    // idempotent and move on to the still-failing suffix.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r11f1-retry-heal');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['a.sql', 'b.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([
        ['a.sql', '2024-01-01T00:00:00Z'],
        ['b.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    const base = makeQueryD1(state);

    // Decision: The interceptor fails the `b -> b1` UPDATE once. It reports zero changes without mutating D1, so
    // the recheck still sees `b` and classes the pair as a conflict (409). Later requests go through
    // base().
    let interceptFires = 0;
    mockCfApi({
      queryD1: (url, init) => {
        const parsed = init?.body ? JSON.parse(String(init.body)) : {};
        const sql = String(parsed.sql ?? '');
        const params = parsed.params;
        if (
          interceptFires === 0 &&
          /UPDATE\s+_void_migrations\s+SET\s+name\s*=\s*\?\s+WHERE\s+name\s*=\s*\?/i.test(sql) &&
          Array.isArray(params) &&
          params[0] === 'b1.sql' &&
          params[1] === 'b.sql'
        ) {
          interceptFires++;
          state.queries.push({ sql, params });
          return cfSuccess([{ results: [], meta: { changes: 0 } }]);
        }
        return base(url, init);
      },
    });

    const firstRes = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: 'a.sql', to: 'a1.sql' },
            { from: 'b.sql', to: 'b1.sql' },
          ],
        }),
      }),
      env,
    );
    expect(firstRes.status).toBe(409);
    const firstBody = (await firstRes.json()) as {
      ok: boolean;
      error: string;
      committed: Array<{ from: string; to: string }>;
    };
    expect(firstBody.ok).toBe(false);
    expect(firstBody.committed).toEqual([{ from: 'a.sql', to: 'a1.sql' }]);

    expect(state.trackingRows.has('a.sql')).toBe(false);
    expect(state.trackingRows.has('a1.sql')).toBe(true);
    expect(state.trackingRows.has('b.sql')).toBe(true);
    expect(state.trackingRows.has('b1.sql')).toBe(false);

    const midRow = await env.db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(JSON.parse(midRow[0].applied_migrations!)).toEqual(['a1.sql', 'b.sql']);

    const secondRes = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: 'a.sql', to: 'a1.sql' },
            { from: 'b.sql', to: 'b1.sql' },
          ],
        }),
      }),
      env,
    );
    expect(secondRes.status).toBe(200);
    const secondBody = (await secondRes.json()) as { ok: boolean };
    expect(secondBody.ok).toBe(true);

    const updateCalls = state.queries.filter((q) =>
      /UPDATE\s+_void_migrations\s+SET\s+name\s*=\s*\?\s+WHERE\s+name\s*=\s*\?/i.test(q.sql),
    );
    expect(updateCalls.length).toBe(3);
    expect(
      updateCalls.filter(
        (q) => Array.isArray(q.params) && q.params[0] === 'a1.sql' && q.params[1] === 'a.sql',
      ).length,
    ).toBe(1);

    expect(state.trackingRows.has('a.sql')).toBe(false);
    expect(state.trackingRows.has('a1.sql')).toBe(true);
    expect(state.trackingRows.has('b.sql')).toBe(false);
    expect(state.trackingRows.has('b1.sql')).toBe(true);

    const finalRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    expect(JSON.parse(finalRow[0].applied_migrations!)).toEqual(['a1.sql', 'b1.sql']);
  });

  it('invalidates stale audit rows when a prior landing is recycled as a new source', async () => {
    // Decision: Migration_renames audit rows mustn't act as permanent corroboration across name recycling. When
    // committed pair X -> Y is recorded, earlier audit rows with to_name = X are deleted, since the
    // landing at X is no longer valid. Otherwise a fat-fingered retry of a -> a1 could corroborate
    // against a stale row after a1 was renamed elsewhere and a different migration renamed into a1.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r12f2-lineage');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['a.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([['a.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const step1 = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'a.sql', to: 'a1.sql' }] }),
      }),
      env,
    );
    expect(step1.status).toBe(200);
    expect(state.trackingRows.has('a.sql')).toBe(false);
    expect(state.trackingRows.has('a1.sql')).toBe(true);

    const step2 = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'a1.sql', to: 'b.sql' }] }),
      }),
      env,
    );
    expect(step2.status).toBe(200);
    expect(state.trackingRows.has('a1.sql')).toBe(false);
    expect(state.trackingRows.has('b.sql')).toBe(true);

    // Decision: Pre-seed x.sql in D1 as if a separate /apply had added it. The rename classifier only cares that
    // D1 has a tracking row for `from`, so the /apply call is skipped.
    state.trackingRows.set('x.sql', '2024-01-03T00:00:00Z');

    const step3 = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'x.sql', to: 'a1.sql' }] }),
      }),
      env,
    );
    expect(step3.status).toBe(200);
    expect(state.trackingRows.has('x.sql')).toBe(false);
    expect(state.trackingRows.has('a1.sql')).toBe(true);
    expect(state.trackingRows.has('b.sql')).toBe(true);

    const step4 = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'a.sql', to: 'a1.sql' }] }),
      }),
      env,
    );
    expect(step4.status).toBe(400);
    const body = (await step4.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('ambiguous');
    expect(body.error).toContain('a.sql');
    expect(body.error).toContain('a1.sql');

    expect(state.trackingRows.has('a.sql')).toBe(false);
    expect(state.trackingRows.has('a1.sql')).toBe(true);
    expect(state.trackingRows.has('b.sql')).toBe(true);
  });

  it('apply-then-rename interleave: per-project row lock keeps D1 and pg in sync', async () => {
    // Decision: Without per-project serialization, an /apply that landed the migration in D1 but hadn't appended
    // to pg yet could be overtaken by a /rename that snapshots D1, rewrites pg, and returns 200. /apply
    // would then append the pre-rename name, leaving D1 with the new name and pg with the old one for
    // good. The transaction-scoped row lock on the `projects` row serializes /apply and /rename.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r7f2-apply-rename');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const state = createD1State();
    const base = makeQueryD1(state);

    // Decision: Hold /apply inside its application SQL call so /rename starts second. Without the lock /rename
    // would race past /apply's pending pg append; with it, /rename blocks at the transaction boundary
    // until /apply commits.
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let holdsFired = 0;

    mockCfApi({
      queryD1: async (url, init) => {
        const parsed = init?.body ? JSON.parse(String(init.body)) : {};
        const sql = String(parsed.sql ?? '');
        if (holdsFired === 0 && /CREATE\s+TABLE\s+users\b/i.test(sql)) {
          holdsFired++;
          await hold;
        }
        return base(url, init);
      },
    });

    const applyBody = JSON.stringify({
      migrations: [{ name: '001_old.sql', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)' }],
    });
    const renameBody = JSON.stringify({
      renames: [{ from: '001_old.sql', to: '001_new.sql' }],
    });

    const applyPromise = app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: applyBody,
      }),
      env,
    );
    await new Promise((r) => setTimeout(r, 20));
    const renamePromise = app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: renameBody,
      }),
      env,
    );
    await new Promise((r) => setTimeout(r, 20));
    release();

    const [applyRes, renameRes] = await Promise.all([applyPromise, renamePromise]);

    expect(applyRes.status).toBe(200);
    expect(renameRes.status).toBe(200);

    expect(state.trackingRows.has('001_old.sql')).toBe(false);
    expect(state.trackingRows.has('001_new.sql')).toBe(true);

    const row = await env.db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(JSON.parse(row[0].applied_migrations!)).toEqual(['001_new.sql']);
  });

  it('rejects an ambiguous rename when pg has no reference to "from"', async () => {
    // Decision: The `!fromExists && toExists` branch needs corroboration from pg: a real retry after a prior
    // D1-succeeded / pg-failed run still has `from` in some deployment's `applied_migrations`. If no
    // deployment references `from`, reject with 400 rather than rewriting blindly against an unrelated
    // D1 migration.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r8f2-ambiguous');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['999_unrelated.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([['002_add_email.sql', '2024-02-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '002_add_email.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('ambiguous');
    expect(body.error).toContain('001_init.sql');
    expect(body.error).toContain('002_add_email.sql');

    expect(state.trackingRows.has('002_add_email.sql')).toBe(true);
    expect(state.trackingRows.has('001_init.sql')).toBe(false);
    expect(state.queries.find((q) => /UPDATE\s+_void_migrations/i.test(q.sql))).toBeUndefined();

    const row = await env.db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(JSON.parse(row[0].applied_migrations!)).toEqual(['999_unrelated.sql']);
  });

  it('heals a legitimate retry where pg still references "from" on the active deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r8f2-heal-active');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['001_init.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([['001_create_users.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '001_create_users.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    expect(state.queries.find((q) => /UPDATE\s+_void_migrations/i.test(q.sql))).toBeUndefined();
    expect(state.trackingRows.has('001_create_users.sql')).toBe(true);

    const row = await env.db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(JSON.parse(row[0].applied_migrations!)).toEqual(['001_create_users.sql']);
  });

  it('rejects rename when "from" only appears on a retained deployment', async () => {
    // Decision: Corroboration is narrowed to the active deployment. Retained-only references aren't enough: they
    // may be inaccurate from the era when /rename only updated the active deployment, which is the state
    // the batch rewrite was introduced to heal.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r9f1-reject-retained');
    await insertD1Resource(env.db, project.id);

    const activeDeployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['001_create_users.sql']) })
      .where(eq(deployments.id, activeDeployment.id));

    const retainedDeployment = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql']),
        retained: true,
      })
      .where(eq(deployments.id, retainedDeployment.id));

    const state = createD1State({
      trackingRows: new Map([['001_create_users.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '001_create_users.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('ambiguous');
    expect(body.error).toContain('001_init.sql');
    expect(body.error).toContain('001_create_users.sql');

    expect(state.queries.find((q) => /UPDATE\s+_void_migrations/i.test(q.sql))).toBeUndefined();
    expect(state.trackingRows.has('001_create_users.sql')).toBe(true);

    const activeRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, activeDeployment.id));
    expect(JSON.parse(activeRow[0].applied_migrations!)).toEqual(['001_create_users.sql']);

    const retainedRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, retainedDeployment.id));
    expect(JSON.parse(retainedRow[0].applied_migrations!)).toEqual(['001_init.sql']);
  });

  it('rejects fat-fingered rename targeting a historically-present migration', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r9f1-fat-finger');
    await insertD1Resource(env.db, project.id);

    const activeDeployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['001_create_users.sql']) })
      .where(eq(deployments.id, activeDeployment.id));

    const retainedDeployment = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql']),
        retained: true,
      })
      .where(eq(deployments.id, retainedDeployment.id));

    const state = createD1State({
      trackingRows: new Map([
        ['001_create_users.sql', '2024-01-01T00:00:00Z'],
        ['002_add_email.sql', '2024-02-01T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '002_add_email.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('ambiguous');
    expect(body.error).toContain('001_init.sql');
    expect(body.error).toContain('002_add_email.sql');

    expect(state.queries.find((q) => /UPDATE\s+_void_migrations/i.test(q.sql))).toBeUndefined();
    expect(state.trackingRows.has('001_create_users.sql')).toBe(true);
    expect(state.trackingRows.has('002_add_email.sql')).toBe(true);
    expect(state.trackingRows.has('001_init.sql')).toBe(false);

    const activeRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, activeDeployment.id));
    expect(JSON.parse(activeRow[0].applied_migrations!)).toEqual(['001_create_users.sql']);

    const retainedRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, retainedDeployment.id));
    expect(JSON.parse(retainedRow[0].applied_migrations!)).toEqual(['001_init.sql']);
  });

  it('rollback/apply interleave: row lock keeps setActiveDeployment atomic with apply metadata', async () => {
    // Decision: Rollback's pointer flip and /apply's metadata append serialize on the per-project row lock.
    // /apply re-reads `locked.active_deployment_id` after taking the lock, so either (a) /apply runs
    // first and appends to the old active, then rollback flips, or (b) rollback flips first and /apply
    // appends to the new active. Case (a) is fine: the new active has its own migration history from
    // the deploy that created it. This test pins case (b).
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r8f3-rollback-apply');
    await insertD1Resource(env.db, project.id);

    const oldActive = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, oldActive.id));

    const target = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, target.id));

    // Decision: Simulates a prior /apply that succeeded in D1 and landed the tracking row for `002_new.sql` but
    // had its pg append rolled back.
    const state = createD1State({
      trackingRows: new Map([
        ['001_init.sql', '2024-01-01T00:00:00Z'],
        ['002_new.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    // Decision: Start rollback first so it reaches its row-locked setActiveDeployment (after the KV work) before
    // /apply tries to take the same lock.
    const rollbackPromise = app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: target.id }),
      }),
      env,
    );
    await new Promise((r) => setTimeout(r, 20));
    const applyPromise = app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '002_new.sql', sql: 'CREATE TABLE posts (id TEXT)' }],
        }),
      }),
      env,
    );

    const [rollbackRes, applyRes] = await Promise.all([rollbackPromise, applyPromise]);
    expect(rollbackRes.status).toBe(200);
    expect(applyRes.status).toBe(200);

    const targetRow = await env.db.select().from(deployments).where(eq(deployments.id, target.id));
    const oldActiveRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, oldActive.id));

    const targetMigrations: Array<string> = JSON.parse(targetRow[0].applied_migrations!);
    const oldActiveMigrations: Array<string> = JSON.parse(oldActiveRow[0].applied_migrations!);

    expect(targetMigrations).toContain('002_new.sql');
    expect(oldActiveMigrations).toEqual(['001_init.sql']);
  });

  it('rollback currentActive read and migrationDiff are computed inside the row lock', async () => {
    // Decision: Rollback's row lock covers the whole cutover: target and currentActive re-reads, diff, pg flip,
    // and external writes. An /apply that commits before the lock is visible when the diff is computed,
    // and an /apply racing during rollback blocks on the same lock and runs after rollback commits.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r12f1-diff-lock');
    await insertD1Resource(env.db, project.id);

    const oldActive = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, oldActive.id));

    const target = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, target.id));

    const state = createD1State({
      trackingRows: new Map([['m1.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const applyRes = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: 'm3.sql', sql: 'CREATE TABLE posts (id TEXT)' }],
        }),
      }),
      env,
    );
    expect(applyRes.status).toBe(200);

    const oldActiveMid = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, oldActive.id));
    expect(JSON.parse(oldActiveMid[0].applied_migrations!)).toEqual(['m1.sql', 'm3.sql']);

    // Decision: target has [m1] and currentActive has [m1, m3], so the diff is non-empty and the destructive
    // guard would reject without an opt-in. That's unrelated to this test's invariant, so echo the
    // expected diff via `allowDestructive`.
    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: target.id, allowDestructive: ['m3.sql'] }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);

    const rollbackBody = (await rollbackRes.json()) as {
      ok: boolean;
      deploymentId: string;
      migrationDiff: Array<string>;
    };
    expect(rollbackBody.ok).toBe(true);
    expect(rollbackBody.deploymentId).toBe(target.id);
    expect(rollbackBody.migrationDiff).toEqual(['m3.sql']);
  });

  it('two rollbacks in sequence keep pg and ROUTING in sync, the second after the first has finished', async () => {
    // Decision: The row lock covers the whole cutover (pg flip, ROUTING.put, cron, queue, ISR), so after two
    // rollbacks pg's active deployment, ROUTING's worker and both returned diffs agree. The test holds
    // rollback A inside its locked tx (after the pg flip, during `ROUTING.put(slug, ...)`) and starts
    // rollback B while A is paused. B starts only after A has fully finished, post-commit lease cleanup
    // included.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r13f1-rb-rb');
    await insertD1Resource(env.db, project.id);

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql', 'm2.sql', 'm3.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql', 'm2.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depB.id));
    const depC = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depC.id));

    // Decision: Holds the first ROUTING.put for project.slug: rollback A's in-lock external write, which runs
    // after the pg flip. Later calls pass through.
    let releaseA: () => void = () => {};
    const aHold = new Promise<void>((r) => {
      releaseA = r;
    });
    let holdFired: (() => void) | undefined;
    const aReachedPut = new Promise<void>((r) => {
      holdFired = r;
    });
    let aHoldFired = false;
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    vi.spyOn(env.ROUTING, 'put').mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (key: string, value: any, options?: any) => {
        if (!aHoldFired && key === project.slug) {
          aHoldFired = true;
          holdFired?.();
          await aHold;
        }
        return originalPut(key, value, options);
      },
    );

    // Decision: Both rollbacks here carry non-empty diffs (A -> B drops m3; B -> C drops m2), so the destructive
    // guard would reject them without an opt-in. That's unrelated to this test, so echo each diff via
    // `allowDestructive`.
    const rollbackAPromise = app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id, allowDestructive: ['m3.sql'] }),
      }),
      env,
    );
    await aReachedPut;

    // Decision: B is held between its pre-lock reads and its row-lock acquisition, so it can only run once A's
    // rollback, post-commit lease cleanup included, has finished. The wrapper is installed after A's
    // transaction started, so the first transaction it sees is B's.
    //
    // Without the hold the driver decides the order: PGlite queues statements, so B's in-lock read runs
    // after A's cleanup, while a pooled Postgres grants the queued row lock at A's commit, so B resumes
    // before that cleanup, reads A's rollback lease and answers 409 `deploy in progress`. That fence is
    // real, but it's driver order rather than the sequence under test. So this test doesn't exercise
    // row-lock contention between rollbacks; the `/apply` contention tests cover the row lock.
    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    let releaseB: () => void = () => {};
    const bHold = new Promise<void>((r) => {
      releaseB = r;
    });
    let bHoldFired = false;
    const wrappedDb: Db = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return async (fn: any) => {
            if (!bHoldFired) {
              bHoldFired = true;
              await bHold;
            }
            return realTransaction(fn);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    setTestDb(wrappedDb);

    const rollbackBPromise = app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depC.id, allowDestructive: ['m2.sql'] }),
      }),
      env,
    );

    releaseA();
    const resA = await rollbackAPromise;
    expect(resA.status).toBe(200);
    releaseB();
    const resB = await rollbackBPromise;
    setTestDb(realDb);
    expect(resB.status).toBe(200);

    const bodyA = (await resA.json()) as {
      ok: boolean;
      deploymentId: string;
      migrationDiff: Array<string>;
    };
    const bodyB = (await resB.json()) as {
      ok: boolean;
      deploymentId: string;
      migrationDiff: Array<string>;
    };
    expect(bodyA.deploymentId).toBe(depB.id);
    expect(bodyA.migrationDiff).toEqual(['m3.sql']);
    expect(bodyB.deploymentId).toBe(depC.id);
    expect(bodyB.migrationDiff).toEqual(['m2.sql']);

    const finalPg = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(finalPg[0].active_deployment_id).toBe(depC.id);

    const finalRouting = (await env.ROUTING.get(project.slug, 'json')) as {
      workerName: string;
      version: string;
    };
    expect(finalRouting.version).toBe(depC.id);
    expect(finalRouting.workerName).toBe(`user-r13f1-rb-rb-${depC.id}`);
  });

  it('rollback target.applied_migrations is re-read inside the row lock so /rename cannot stale the diff', async () => {
    // Decision: Rollback re-reads `target` inside the row-locked tx. A concurrent /rename that commits lands
    // before rollback takes the lock (both take the same per-project row lock). The test wraps
    // `db.transaction(fn)` to pause before the real transaction, rewrites both deployments'
    // applied_migrations directly (as /rename would) in the gap between rollback's pre-lock reads and
    // its lock, then releases; the in-lock re-read sees the change.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r13f2-rb-rename');
    await insertD1Resource(env.db, project.id);

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql', 'm2.sql', 'm3.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql', 'm2.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depB.id));

    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    let beforeTxResolver: (() => void) | undefined;
    let beforeTxReached: (() => void) | undefined;
    const beforeTxReachedPromise = new Promise<void>((r) => {
      beforeTxReached = r;
    });
    let beforeTxHoldFired = false;
    const wrappedDb: Db = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return async (fn: any) => {
            if (!beforeTxHoldFired) {
              beforeTxHoldFired = true;
              beforeTxReached?.();
              await new Promise<void>((r) => {
                beforeTxResolver = r;
              });
            }
            return realTransaction(fn);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    setTestDb(wrappedDb);

    try {
      const rollbackPromise = app.fetch(
        authedReq(`/projects/${project.id}/rollback`, user.jwt, {
          method: 'POST',
          body: JSON.stringify({ deploymentId: depB.id, allowDestructive: ['m3.sql'] }),
        }),
        env,
      );
      await beforeTxReachedPromise;

      // Decision: Write through `realDb` (bypassing the proxy) so the UPDATEs commit at once instead of going
      // through the transaction wrapper.
      await realDb
        .update(deployments)
        .set({ applied_migrations: JSON.stringify(['m1x.sql', 'm2x.sql', 'm3.sql']) })
        .where(eq(deployments.id, depA.id));
      await realDb
        .update(deployments)
        .set({ applied_migrations: JSON.stringify(['m1x.sql', 'm2x.sql']) })
        .where(eq(deployments.id, depB.id));

      beforeTxResolver?.();
      const rollbackRes = await rollbackPromise;
      expect(rollbackRes.status).toBe(200);
      const body = (await rollbackRes.json()) as {
        ok: boolean;
        deploymentId: string;
        migrationDiff: Array<string>;
      };
      expect(body.ok).toBe(true);
      expect(body.deploymentId).toBe(depB.id);
      expect(body.migrationDiff).toEqual(['m3.sql']);
    } finally {
      setTestDb(realDb);
    }
  });

  it('compensates external state when the rollback transaction rejects after its callback', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-commit-failure');
    await insertD1Resource(env.db, project.id);
    const current = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, current.id));
    const target = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, target.id));
    const previousRouting = JSON.stringify({
      workerName: `user-${project.slug}-${current.id}`,
      version: current.id,
    });
    await env.ROUTING.put(project.slug, previousRouting);

    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    let transactionCount = 0;
    const lateHostname = 'late-rollback-domain.example.com';
    const commitRejection = new Error('injected commit rejection');
    const wrappedDb: Db = new Proxy(realDb, {
      get(targetDb, prop, receiver) {
        if (prop === 'transaction') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return async (fn: any) => {
            transactionCount++;
            const rejectsCutover = transactionCount === 2;
            try {
              return await realTransaction(async (tx) => {
                const result = await fn(tx);
                if (rejectsCutover) {
                  // Decision: The cutover callback finished and wrote external state, but PostgreSQL rejects before
                  // committing its project flip.
                  throw commitRejection;
                }
                return result;
              });
            } catch (error) {
              if (error === commitRejection) {
                // Decision: Models domain activation winning the gap between the failed rollback tx releasing the project
                // lock and outer compensation taking it again. It copies target routing that the rollback wrote
                // externally even though PostgreSQL stayed on current.
                await realTransaction(async (tx) => {
                  await tx.insert(domains).values({
                    id: 'dom_late_rollback_compensation',
                    project_id: project.id,
                    hostname: lateHostname,
                    cf_hostname_id: 'ch-late-rollback-compensation',
                    status: 'active',
                  });
                  const temporaryTargetRouting = await env.ROUTING.get(project.slug);
                  expect(temporaryTargetRouting).toContain(target.id);
                  await env.ROUTING.put(`domain:${lateHostname}`, temporaryTargetRouting!);
                });
              }
              throw error;
            }
          };
        }
        return Reflect.get(targetDb, prop, receiver);
      },
    });
    setTestDb(wrappedDb);

    try {
      const response = await app.fetch(
        authedReq(`/projects/${project.id}/rollback`, user.jwt, {
          method: 'POST',
          body: JSON.stringify({ deploymentId: target.id }),
        }),
        env,
      );
      expect(response.status).toBe(500);
      expect((await env.ROUTING.get(project.slug))!).toBe(previousRouting);
      expect(await env.ROUTING.get(`domain:${lateHostname}`)).toBe(previousRouting);
      const restored = await env.db
        .select({ activeDeploymentId: projects.active_deployment_id })
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(restored[0]?.activeDeploymentId).toBe(current.id);
      const leases = await env.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.source, 'rollback-lease'));
      expect(leases).toHaveLength(0);
    } finally {
      setTestDb(realDb);
    }
  });

  it('preserves the rollback lease when the outer compensation transaction fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-compensation-tx-failure');
    await insertD1Resource(env.db, project.id);
    const current = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ retained: true, manifest: JSON.stringify({ version: 4, type: 'platform' }) })
      .where(eq(deployments.id, current.id));
    const target = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({ retained: true, manifest: JSON.stringify({ version: 4, type: 'platform' }) })
      .where(eq(deployments.id, target.id));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: `user-${project.slug}-${current.id}`, version: current.id }),
    );

    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    let transactionCount = 0;
    const wrappedDb: Db = new Proxy(realDb, {
      get(targetDb, prop, receiver) {
        if (prop === 'transaction') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return async (fn: any) => {
            transactionCount++;
            if (transactionCount === 3) {
              // Decision: Lease creation is transaction #1, rollback cutover is #2, and the guarded outer compensation
              // lock is #3.
              throw new Error('injected compensation transaction failure');
            }
            return realTransaction(async (tx) => {
              const result = await fn(tx);
              if (transactionCount === 2) {
                throw new Error('injected rollback commit rejection');
              }
              return result;
            });
          };
        }
        return Reflect.get(targetDb, prop, receiver);
      },
    });
    setTestDb(wrappedDb);

    try {
      const response = await app.fetch(
        authedReq(`/projects/${project.id}/rollback`, user.jwt, {
          method: 'POST',
          body: JSON.stringify({ deploymentId: target.id }),
        }),
        env,
      );
      expect(response.status).toBe(500);
    } finally {
      setTestDb(realDb);
    }

    const [lease] = await env.db
      .select({ id: deployments.id, manifest: deployments.manifest })
      .from(deployments)
      .where(eq(deployments.source, 'rollback-lease'));
    expect(lease).toBeDefined();
    expect(JSON.parse(lease.manifest!)).toMatchObject({
      targetDeploymentId: target.id,
      state: 'retryable',
    });
    const [storedProject] = await env.db
      .select({ activeDeploymentId: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(storedProject?.activeDeploymentId).toBe(current.id);
  });

  it('preserves a rollback whose COMMIT succeeded when its acknowledgement is lost', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-lost-commit-ack');
    await insertD1Resource(env.db, project.id);
    const current = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ retained: true, manifest: JSON.stringify({ version: 4, type: 'platform' }) })
      .where(eq(deployments.id, current.id));
    const target = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({ retained: true, manifest: JSON.stringify({ version: 4, type: 'platform' }) })
      .where(eq(deployments.id, target.id));
    await env.db
      .update(projects)
      .set({ active_deployment_id: current.id })
      .where(eq(projects.id, project.id));
    const previousRouting = JSON.stringify({
      workerName: `user-${project.slug}-${current.id}`,
      version: current.id,
    });
    await env.ROUTING.put(project.slug, previousRouting);

    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    let transactionCount = 0;
    const wrappedDb: Db = new Proxy(realDb, {
      get(targetDb, prop, receiver) {
        if (prop === 'transaction') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return async (fn: any) => {
            transactionCount++;
            const result = await realTransaction(fn);
            if (transactionCount === 2) {
              throw new Error('database connection lost after COMMIT');
            }
            return result;
          };
        }
        return Reflect.get(targetDb, prop, receiver);
      },
    });
    setTestDb(wrappedDb);

    try {
      const response = await app.fetch(
        authedReq(`/projects/${project.id}/rollback`, user.jwt, {
          method: 'POST',
          body: JSON.stringify({ deploymentId: target.id }),
        }),
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, deploymentId: target.id });

      const routing = await env.ROUTING.get(project.slug);
      expect(routing).toContain(target.id);
      const [updatedProject] = await env.db
        .select({ activeDeploymentId: projects.active_deployment_id })
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(updatedProject?.activeDeploymentId).toBe(target.id);
      const leases = await env.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.source, 'rollback-lease'));
      expect(leases).toHaveLength(0);
    } finally {
      setTestDb(realDb);
    }
  });

  it('keeps an adopted rollback lease when its retry fails before a durable commit', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-adopted-lease-failure');
    await insertD1Resource(env.db, project.id);
    const current = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ retained: true, manifest: JSON.stringify({ version: 4, type: 'platform' }) })
      .where(eq(deployments.id, current.id));
    const target = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({ retained: true, manifest: JSON.stringify({ version: 4, type: 'platform' }) })
      .where(eq(deployments.id, target.id));

    // Decision: Models an earlier rollback whose COMMIT outcome was unreadable: PostgreSQL still points at
    // `current`, external routing may already point at `target`, and a retryable lease fences that
    // divergence.
    const lease = await createTestDeployment(env.db, project.id, 'pending', 'rollback-lease');
    await env.db
      .update(deployments)
      .set({
        manifest: JSON.stringify({
          version: 1,
          targetDeploymentId: target.id,
          state: 'retryable',
          ownerId: 'abandoned-owner',
        }),
      })
      .where(eq(deployments.id, lease.id));
    const divergentRouting = JSON.stringify({
      workerName: `user-${project.slug}-${target.id}`,
      version: target.id,
    });
    await env.ROUTING.put(project.slug, divergentRouting);

    // Decision: The same-target retry adopts the lease, then fails on its first external write. Its compensation
    // snapshot is already the divergent target route, so releasing the adopted lease here would make
    // the split brain permanent and let unrelated operations through.
    const putSpy = vi
      .spyOn(env.ROUTING, 'put')
      .mockRejectedValueOnce(new Error('injected KV failure'));
    const response = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: target.id }),
      }),
      env,
    );
    expect(response.status).toBe(500);
    expect(await env.ROUTING.get(project.slug)).toBe(divergentRouting);
    putSpy.mockRestore();

    const [preservedLease] = await env.db
      .select({ id: deployments.id, manifest: deployments.manifest })
      .from(deployments)
      .where(eq(deployments.id, lease.id));
    expect(preservedLease?.id).toBe(lease.id);
    expect(JSON.parse(preservedLease.manifest!)).toMatchObject({
      targetDeploymentId: target.id,
      state: 'retryable',
    });

    const blocked = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: current.id }),
      }),
      env,
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: `deploy in progress: ${lease.id}` });

    // Decision: The abandoned request's `finally` is owner-scoped and can't delete the fence after this retry
    // atomically adopted it.
    expect(await deleteRollbackLease(env.db, lease.id, 'abandoned-owner')).toBe(false);
    expect(
      await env.db.select().from(deployments).where(eq(deployments.id, lease.id)),
    ).toHaveLength(1);
  });

  it('rollback deletes stale queue KV routes that only the previous active deployment bound', async () => {
    // Decision: Rollback diffs `currentActive.manifest.queues` against `target.manifest.queues` by name and
    // deletes queue KV routes that A bound but B doesn't. Otherwise `queue:<stale>` would still point
    // at A's evicted worker and the dispatch relay would forward messages to it. The diff runs inside
    // the locked tx after the pg flip, so a concurrent deploy or rollback can't race the sweep.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r14f1-queue-sweep');
    await insertD1Resource(env.db, project.id);

    // Decision: Without resource rows, rollback's PUT loop for B skips queues that lack a matching resource; we
    // want B to write its routes.
    await env.db.insert(resources).values([
      {
        id: `res_${project.id}_q1`,
        project_id: project.id,
        type: 'queue',
        cf_id: '11111111111111111111111111111111',
        binding_name: 'q1',
      },
      {
        id: `res_${project.id}_q2`,
        project_id: project.id,
        type: 'queue',
        cf_id: '22222222222222222222222222222222',
        binding_name: 'q2',
      },
      {
        id: `res_${project.id}_q3`,
        project_id: project.id,
        type: 'queue',
        cf_id: '33333333333333333333333333333333',
        binding_name: 'q3',
      },
    ]);

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [
            { name: 'q1', bindingName: 'Q1' },
            { name: 'q2', bindingName: 'Q2' },
          ],
        }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [
            { name: 'q2', bindingName: 'Q2' },
            { name: 'q3', bindingName: 'Q3' },
          ],
        }),
      })
      .where(eq(deployments.id, depB.id));

    // Decision: The KV key shape production uses; see `getProjectQueueName` in packages/api/src/naming.ts.
    const queueKey = (name: string): string => {
      const normalized = `${project.id}-${name}`.toLowerCase().replaceAll('_', '-');
      return `queue:${normalized}`;
    };

    const workerA = `user-r14f1-queue-sweep-${depA.id}`;
    const workerB = `user-r14f1-queue-sweep-${depB.id}`;
    await env.ROUTING.put(
      queueKey('q1'),
      JSON.stringify({ workerName: workerA, projectId: project.id, queueName: 'q1' }),
    );
    await env.ROUTING.put(
      queueKey('q2'),
      JSON.stringify({ workerName: workerA, projectId: project.id, queueName: 'q2' }),
    );

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);

    const q2Entry = (await env.ROUTING.get(queueKey('q2'), 'json')) as {
      workerName: string;
      projectId: string;
      queueName: string;
    } | null;
    expect(q2Entry).not.toBeNull();
    expect(q2Entry!.workerName).toBe(workerB);
    expect(q2Entry!.queueName).toBe('q2');

    const q3Entry = (await env.ROUTING.get(queueKey('q3'), 'json')) as {
      workerName: string;
      projectId: string;
      queueName: string;
    } | null;
    expect(q3Entry).not.toBeNull();
    expect(q3Entry!.workerName).toBe(workerB);
    expect(q3Entry!.queueName).toBe('q3');

    const q1Entry = await env.ROUTING.get(queueKey('q1'));
    expect(q1Entry).toBeNull();
  });

  it('rollback cron reconciliation is driven by the pg manifest, not stale ROUTING KV', async () => {
    // Decision: The clear-vs-sync decision uses `currentActive.manifest.schedules` in pg, the authoritative
    // record of what A registered. KV's `hasCrons` flag can be wrong (an earlier deploy flipped pg but
    // crashed before rewriting KV), so the reconciliation ignores it and still clears the DO when pg
    // says the outgoing active had schedules.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r14f2-cron-manifest');
    await insertD1Resource(env.db, project.id);

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          schedules: [{ name: 'a-cron', cron: '*/5 * * * *' }],
        }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depB.id));

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        workerName: `user-${project.slug}-${depA.id}`,
        version: depA.id,
        hasCrons: false,
      }),
    );

    const doCalls: Array<{ url: string; method: string; body: string | null }> = [];
    const originalGet = env.CRON_SCHEDULER.get.bind(env.CRON_SCHEDULER);
    vi.spyOn(env.CRON_SCHEDULER, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        ...stub,
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          doCalls.push({
            url: url.pathname,
            method: req.method,
            body: req.body ? await req.text() : null,
          });
          return new Response('{}', { status: 200 });
        },
      };
    });

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);

    expect(doCalls.map((call) => call.url)).toEqual(['/snapshot', '/clear']);
    expect(doCalls[1].method).toBe('POST');
  });

  it('rollback queue sweep unions manifests from activated deployments and deletes historical orphans', async () => {
    // Decision: Rollback's queue sweep candidates are the union of queue names across deployments that have been
    // live (`deployed_at IS NOT NULL`). A plain current-vs-target diff would miss routes left by older
    // deployments neither side references. Enumerating the pg `resources` table would race a
    // mid-provisioning deploy (resource rows are written before the deployment goes live). The
    // deployed_at union catches historical orphans without catching an in-flight deploy.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r15f1-queue-orphan');
    await insertD1Resource(env.db, project.id);
    await env.db.insert(resources).values({
      id: `res_${project.id}_q3`,
      project_id: project.id,
      type: 'queue',
      cf_id: '33333333333333333333333333333333',
      binding_name: 'q3',
    });

    const depC = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [{ name: 'q1', bindingName: 'Q1' }],
        }),
      })
      .where(eq(deployments.id, depC.id));

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [{ name: 'q2', bindingName: 'Q2' }],
        }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [{ name: 'q3', bindingName: 'Q3' }],
        }),
      })
      .where(eq(deployments.id, depB.id));

    const queueKey = (name: string): string => {
      const normalized = `${project.id}-${name}`.toLowerCase().replaceAll('_', '-');
      return `queue:${normalized}`;
    };

    const workerC = `user-r15f1-queue-orphan-${depC.id}`;
    const workerA = `user-r15f1-queue-orphan-${depA.id}`;
    const workerB = `user-r15f1-queue-orphan-${depB.id}`;
    await env.ROUTING.put(
      queueKey('q1'),
      JSON.stringify({ workerName: workerC, projectId: project.id, queueName: 'q1' }),
    );
    await env.ROUTING.put(
      queueKey('q2'),
      JSON.stringify({ workerName: workerA, projectId: project.id, queueName: 'q2' }),
    );

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);

    const q3Entry = (await env.ROUTING.get(queueKey('q3'), 'json')) as {
      workerName: string;
      projectId: string;
      queueName: string;
    } | null;
    expect(q3Entry).not.toBeNull();
    expect(q3Entry!.workerName).toBe(workerB);

    const q2Entry = await env.ROUTING.get(queueKey('q2'));
    expect(q2Entry).toBeNull();

    const q1Entry = await env.ROUTING.get(queueKey('q1'));
    expect(q1Entry).toBeNull();
  });

  it('rollback rejects while a queue deployment is in flight', async () => {
    // Decision: Rollback mustn't race an in-flight deployment. Rejecting before any cutover write protects both
    // the current active routes and the in-flight deployment's pre-staged queue route.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r16f2-inflight');
    await insertD1Resource(env.db, project.id);

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [{ name: 'q1', bindingName: 'Q1' }],
        }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [{ name: 'q5', bindingName: 'Q5' }],
        }),
      })
      .where(eq(deployments.id, depB.id));

    // Decision: `createTestDeployment` only stamps `deployed_at` for status 'live', so D has `deployed_at = null`
    // and the sweep excludes it even though its manifest lists q4 and its resources row exists.
    const depD = await createTestDeployment(env.db, project.id, 'uploading');
    await env.db
      .update(deployments)
      .set({
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [{ name: 'q4', bindingName: 'Q4' }],
        }),
      })
      .where(eq(deployments.id, depD.id));
    await env.db.insert(resources).values({
      id: `res_${project.id}_q4`,
      project_id: project.id,
      type: 'queue',
      cf_id: 'cf-q4',
      binding_name: 'q4',
    });

    const queueKey = (name: string): string => {
      const normalized = `${project.id}-${name}`.toLowerCase().replaceAll('_', '-');
      return `queue:${normalized}`;
    };

    const workerA = `user-r16f2-inflight-${depA.id}`;
    const workerD = `user-r16f2-inflight-${depD.id}`;
    await env.ROUTING.put(
      queueKey('q1'),
      JSON.stringify({ workerName: workerA, projectId: project.id, queueName: 'q1' }),
    );
    await env.ROUTING.put(
      queueKey('q4'),
      JSON.stringify({ workerName: workerD, projectId: project.id, queueName: 'q4' }),
    );

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(409);

    const q1Entry = await env.ROUTING.get(queueKey('q1'));
    expect(q1Entry).not.toBeNull();

    const q5Entry = await env.ROUTING.get(queueKey('q5'));
    expect(q5Entry).toBeNull();

    const q4Entry = await env.ROUTING.get(queueKey('q4'));
    expect(q4Entry).not.toBeNull();
  });

  it('rollback queue sweep reclaims KV routes from terminal-failed deployments', async () => {
    // Decision: The sweep's candidate set unions `getActivatedDeployments` with `getTerminalFailedDeployments`
    // (failed/canceled with `deployed_at = null`): defense in depth to reclaim queue KV routes left by a
    // deploy that wrote routes at step 2b (queue_setup) and failed later without its eager cleanup. The
    // deploy-side cleanup is still the primary reclaim path.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r17f1-terminal-failed');
    await insertD1Resource(env.db, project.id);
    await env.db.insert(resources).values({
      id: `res_${project.id}_q2`,
      project_id: project.id,
      type: 'queue',
      cf_id: '22222222222222222222222222222222',
      binding_name: 'q2',
    });

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [{ name: 'q1', bindingName: 'Q1' }],
        }),
      })
      .where(eq(deployments.id, depA.id));

    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [{ name: 'q2', bindingName: 'Q2' }],
        }),
      })
      .where(eq(deployments.id, depB.id));

    const depC = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [{ name: 'q3', bindingName: 'Q3' }],
        }),
      })
      .where(eq(deployments.id, depC.id));

    const queueKey = (name: string): string => {
      const normalized = `${project.id}-${name}`.toLowerCase().replaceAll('_', '-');
      return `queue:${normalized}`;
    };

    const workerA = `user-r17f1-terminal-failed-${depA.id}`;
    const workerC = `user-r17f1-terminal-failed-${depC.id}`;
    await env.ROUTING.put(
      queueKey('q1'),
      JSON.stringify({ workerName: workerA, projectId: project.id, queueName: 'q1' }),
    );
    await env.ROUTING.put(
      queueKey('q3'),
      JSON.stringify({ workerName: workerC, projectId: project.id, queueName: 'q3' }),
    );

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);

    expect(await env.ROUTING.get(queueKey('q1'))).toBeNull();

    expect(await env.ROUTING.get(queueKey('q2'))).not.toBeNull();

    expect(await env.ROUTING.get(queueKey('q3'))).toBeNull();
  });

  it('rollback remains blocked by in-flight deploys when terminal failures exist', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r17f1-inflight-negative');
    await insertD1Resource(env.db, project.id);

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [{ name: 'q1', bindingName: 'Q1' }],
        }),
      })
      .where(eq(deployments.id, depA.id));

    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [{ name: 'q2', bindingName: 'Q2' }],
        }),
      })
      .where(eq(deployments.id, depB.id));

    const depD = await createTestDeployment(env.db, project.id, 'uploading');
    await env.db
      .update(deployments)
      .set({
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [{ name: 'q4', bindingName: 'Q4' }],
        }),
      })
      .where(eq(deployments.id, depD.id));

    const queueKey = (name: string): string => {
      const normalized = `${project.id}-${name}`.toLowerCase().replaceAll('_', '-');
      return `queue:${normalized}`;
    };

    const workerA = `user-r17f1-inflight-negative-${depA.id}`;
    const workerD = `user-r17f1-inflight-negative-${depD.id}`;
    await env.ROUTING.put(
      queueKey('q1'),
      JSON.stringify({ workerName: workerA, projectId: project.id, queueName: 'q1' }),
    );
    await env.ROUTING.put(
      queueKey('q4'),
      JSON.stringify({ workerName: workerD, projectId: project.id, queueName: 'q4' }),
    );

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(409);

    expect(await env.ROUTING.get(queueKey('q1'))).not.toBeNull();

    expect(await env.ROUTING.get(queueKey('q4'))).not.toBeNull();
  });

  it('rollback leaves deployment-scoped ISR caches untouched', async () => {
    // Decision: ISR keys include the deployment id, so switching routing to the rollback target switches cache
    // namespaces. The replaced deployment's warmed HTML can stay in KV because dispatch can't select it
    // while a different deployment id is active.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r15f2-isr-purge');
    await insertD1Resource(env.db, project.id);

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depB.id));

    const isrKey = `${project.id}/isr/v2/${depA.id}/page1`;
    await env.ISR_CACHE.put(isrKey, 'previous-deployment-html');

    const isrDeleteSpy = vi.spyOn(env.ISR_CACHE, 'delete');

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);

    expect(isrDeleteSpy).not.toHaveBeenCalledWith(isrKey);

    const afterIsr = await env.ISR_CACHE.get(isrKey);
    expect(afterIsr).toBe('previous-deployment-html');
  });

  it('rollback unconditionally clears cron DO when target has no schedules', async () => {
    // Decision: When target has no schedules, rollback calls `/clear` on the CronScheduler DO unconditionally.
    // `/clear` is idempotent (deletes all storage, returns ok), so it's a cheap no-op on an empty DO,
    // but it heals a DO carrying ghost schedules from a partial earlier cutover that the
    // last-committed active's manifest no longer mentions.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r15f3-cron-clear');
    await insertD1Resource(env.db, project.id);

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depB.id));

    const doCalls: Array<{ url: string; method: string }> = [];
    const originalGet = env.CRON_SCHEDULER.get.bind(env.CRON_SCHEDULER);
    vi.spyOn(env.CRON_SCHEDULER, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        ...stub,
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          doCalls.push({ url: url.pathname, method: req.method });
          return new Response('{}', { status: 200 });
        },
      };
    });

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);

    expect(doCalls.map((call) => call.url)).toEqual(['/snapshot', '/clear']);
    expect(doCalls[1].method).toBe('POST');
  });

  it('rollback destructive diff is rejected server-side without explicit override', async () => {
    // Decision: Rolling back when the current active deployment has migrations the target doesn't include is
    // destructive: the target's worker code expects the old schema, but live D1 has moved past it. When
    // `diff.length > 0` and the caller didn't echo the exact server-computed diff via
    // `allowDestructive`, reject with 400 before flipping pg or writing external state. This matches
    // the `platform:allow-destructive` opt-in /migrations/apply requires.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f1-destructive');
    await insertD1Resource(env.db, project.id);

    // Decision: A binds a queue (`work-queue`) that B doesn't. If rollback got past the destructive guard, the
    // queue sweep would `ROUTING.delete` that key, which is what makes the `routingDeleteSpy`
    // zero-call assertion meaningful. Without the binding difference, `ROUTING.delete` would never fire
    // here whatever the guard did.
    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql', 'm2.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [{ name: 'work-queue' }],
        }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depB.id));

    // Decision: Spy on each external write surface the handler touches after the destructive guard. pg state
    // alone doesn't catch a refactor that moves the guard below the ROUTING.put / CRON_SCHEDULER.fetch
    // calls (split brain: pg unchanged, KV and DO already pointed at the rollback target). Preventing
    // that partial cutover is the guard's purpose, so the test checks external writes directly.
    const routingPutSpy = vi.spyOn(env.ROUTING, 'put');
    const routingDeleteSpy = vi.spyOn(env.ROUTING, 'delete');
    // Decision: Cron sync and clear in /rollback start with `CRON_SCHEDULER.idFromName(projectId)` before
    // `.get(id).fetch(...)`, so a zero-call assertion on `idFromName` proves no DO traffic without
    // wrapping the stub `.get()` returns.
    const cronIdFromNameSpy = vi.spyOn(env.CRON_SCHEDULER, 'idFromName');

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );

    expect(rollbackRes.status).toBe(400);
    const body = (await rollbackRes.json()) as {
      error?: string;
      destructiveMigrations?: Array<string>;
    };
    expect(body.error).toBeTruthy();
    expect(body.error).toMatch(/m2\.sql/);
    expect(body.error).toMatch(/allowDestructive/);
    expect(body.destructiveMigrations).toEqual(['m2.sql']);

    const proj = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(proj[0].active_deployment_id).toBe(depA.id);

    const rowA = await env.db.select().from(deployments).where(eq(deployments.id, depA.id));
    const rowB = await env.db.select().from(deployments).where(eq(deployments.id, depB.id));
    expect(JSON.parse(rowA[0].applied_migrations!)).toEqual(['m1.sql', 'm2.sql']);
    expect(JSON.parse(rowB[0].applied_migrations!)).toEqual(['m1.sql']);

    expect(routingPutSpy).not.toHaveBeenCalled();
    expect(routingDeleteSpy).not.toHaveBeenCalled();
    expect(cronIdFromNameSpy).not.toHaveBeenCalled();
  });

  it('rollback destructive diff is allowed when caller echoes the diff via allowDestructive', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f1-override');
    await insertD1Resource(env.db, project.id);

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql', 'm2.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depB.id));

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id, allowDestructive: ['m2.sql'] }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);
    const body = (await rollbackRes.json()) as {
      ok: boolean;
      deploymentId: string;
      migrationDiff: Array<string>;
    };
    expect(body.ok).toBe(true);
    expect(body.deploymentId).toBe(depB.id);
    expect(body.migrationDiff).toEqual(['m2.sql']);

    const proj = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(proj[0].active_deployment_id).toBe(depB.id);
  });

  it('rollback destructive diff rejects allowDestructive snapshot mismatch', async () => {
    // Decision: `allowDestructive` isn't a blanket boolean: it's an echo of the migrations the caller believes the
    // server-computed diff contains. The server accepts only a set-equal echo (same size, same
    // elements). A partial or mismatched set gets 400 and leaves each external write surface untouched.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f1-mismatch');
    await insertD1Resource(env.db, project.id);

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql', 'm2.sql', 'm3.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'platform',
          queues: [{ name: 'work-queue' }],
        }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depB.id));

    const routingPutSpy = vi.spyOn(env.ROUTING, 'put');
    const routingDeleteSpy = vi.spyOn(env.ROUTING, 'delete');
    const cronIdFromNameSpy = vi.spyOn(env.CRON_SCHEDULER, 'idFromName');

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id, allowDestructive: ['m2.sql'] }),
      }),
      env,
    );

    expect(rollbackRes.status).toBe(400);
    const body = (await rollbackRes.json()) as {
      error?: string;
      destructiveMigrations?: Array<string>;
    };
    expect(body.error).toBeTruthy();
    expect(body.error).toMatch(/m2\.sql/);
    expect(body.error).toMatch(/m3\.sql/);
    expect(body.error).toMatch(/allowDestructive/);
    expect(body.destructiveMigrations).toEqual(['m2.sql', 'm3.sql']);

    const proj = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(proj[0].active_deployment_id).toBe(depA.id);

    const rowA = await env.db.select().from(deployments).where(eq(deployments.id, depA.id));
    const rowB = await env.db.select().from(deployments).where(eq(deployments.id, depB.id));
    expect(JSON.parse(rowA[0].applied_migrations!)).toEqual(['m1.sql', 'm2.sql', 'm3.sql']);
    expect(JSON.parse(rowB[0].applied_migrations!)).toEqual(['m1.sql']);

    expect(routingPutSpy).not.toHaveBeenCalled();
    expect(routingDeleteSpy).not.toHaveBeenCalled();
    expect(cronIdFromNameSpy).not.toHaveBeenCalled();
  });

  it('rollback destructive rejection is JSON-safe for exotic migration names', async () => {
    // Decision: Migration names are arbitrary non-empty strings (/rename accepts any). A retry hint built by
    // string concatenation breaks for names with quotes, backslashes or newlines: the suggested
    // `allowDestructive: [...]` literal becomes invalid JSON. The server formats the hint via
    // JSON.stringify and also exposes the diff as `destructiveMigrations`, so programmatic callers
    // don't parse strings.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f1-exotic');
    await insertD1Resource(env.db, project.id);

    const exoticName = `weird"name\\with\nnewline.sql`;
    const safeName = 'm_safe.sql';

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify([safeName, exoticName]),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify([safeName]),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'platform' }),
      })
      .where(eq(deployments.id, depB.id));

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );

    expect(rollbackRes.status).toBe(400);
    const body = (await rollbackRes.json()) as {
      error?: string;
      destructiveMigrations?: Array<string>;
    };

    expect(body.destructiveMigrations).toEqual([exoticName]);

    expect(body.error).toBeTruthy();
    const match = body.error!.match(/allowDestructive:\s*(\[[^\]]*\])/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]) as Array<string>;
    expect(parsed).toEqual([exoticName]);
  });
});
