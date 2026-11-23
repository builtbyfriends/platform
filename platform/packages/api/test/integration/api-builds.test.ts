import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { updateBuildStatus } from '../../src/db.ts';
import app from '../../src/index.ts';
import { builds } from '../../src/schema.ts';
import {
  createTestBuild,
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

function spyNamespace(payload: unknown): { ns: DurableObjectNamespace; calls: Array<string> } {
  const calls: Array<string> = [];
  const ns = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (_id: unknown) => ({
      fetch: async (input: Request | string) => {
        const u = typeof input === 'string' ? input : input.url;
        calls.push(u);
        return Response.json(payload);
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { ns, calls };
}

function authGet(path: string, jwt: string, env: TestEnv): Response | Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${jwt}` } }),
    env,
  );
}

describe('user-facing build routes', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupEnv();
  });
  afterAll(async () => {
    await teardownEnv();
  });
  beforeEach(async () => {
    await env.db.delete(builds);
    await clearTables(env.db);
  });

  it('lists a project builds newest-first for the owner', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const b1 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });
    const b2 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });

    const res = await authGet(`/projects/${project.id}/builds`, user.jwt, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { builds: Array<{ id: string }> };
    expect(body.builds.map((b) => b.id)).toEqual([b2.id, b1.id]);
    expect(body.builds[0]).not.toHaveProperty('user_id');
    expect(body.builds[0]).not.toHaveProperty('instance_type');
  });

  it('rejects listing another user builds with 403', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const other = await createTestUser(env.db, 'intruder');
    const project = await createTestProject(env.db, owner.id);
    const res = await authGet(`/projects/${project.id}/builds`, other.jwt, env);
    expect(res.status).toBe(403);
  });

  it('fronts the BuildManager DO for a container build logs', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });

    const base = spyNamespace({
      lines: [{ seq: 1, line: 'hi', stream: 'stdout', ts: 1 }],
      lastSeq: 1,
    });
    const large = spyNamespace({ lines: [], lastSeq: 0 });
    env.BUILD_MANAGER = base.ns;
    env.BUILD_MANAGER_LARGE = large.ns;

    const res = await authGet(
      `/projects/${project.id}/builds/${build.id}/logs?since=0`,
      user.jwt,
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<{ line: string }>;
      lastSeq: number;
      status: string;
      terminal: boolean;
      external: string | null;
    };
    expect(body.lines).toEqual([{ seq: 1, line: 'hi', stream: 'stdout', ts: 1 }]);
    expect(body.lastSeq).toBe(1);
    expect(body.terminal).toBe(false);
    expect(body.external).toBeNull();
    expect(base.calls[0]).toContain('/logs?since=0');
    expect(large.calls).toHaveLength(0);
  });

  it('honors the DO-authoritative terminal when the PG row still lags ACTIVE', async () => {
    // Decision: Stale-active window: a completion path set the DO terminal first, then its Postgres CAS write
    // threw, so the PG row is still non-terminal while the DO is 'complete'. The route has to OR in the
    // DO's terminal so `--follow` can finish after its log drain.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });

    const base = spyNamespace({
      lines: [],
      lastSeq: 0,
      status: 'complete',
      terminal: true,
      logsComplete: false,
    });
    env.BUILD_MANAGER = base.ns;

    const res = await authGet(
      `/projects/${project.id}/builds/${build.id}/logs?since=0`,
      user.jwt,
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      terminal: boolean;
      logsComplete: boolean | null;
    };
    expect(body.terminal).toBe(true);
    expect(body.status).toBe('complete');
    expect(body.logsComplete).toBe(false);

    env.BUILD_MANAGER = spyNamespace({
      lines: [{ seq: 1, line: 'final tail', stream: 'stdout', ts: 1 }],
      lastSeq: 1,
      status: 'complete',
      terminal: true,
      logsComplete: true,
    }).ns;
    const complete = await authGet(
      `/projects/${project.id}/builds/${build.id}/logs?since=0`,
      user.jwt,
      env,
    );
    expect(await complete.json()).toMatchObject({
      lines: [{ seq: 1, line: 'final tail' }],
      lastSeq: 1,
      terminal: true,
      logsComplete: true,
    });
  });

  it('lets fresh Postgres win the status word over a lost-CAS DO terminal', async () => {
    // Decision: A concurrent terminalizer commits `cancelled` while the route awaits the DO, and the DO reports
    // `complete` from a path that lost the PG CAS. The status word has to come from PG. The DO's fetch
    // callback runs during the route's await, so flipping the DB there makes the interleave
    // deterministic.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });

    const ns = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async () => {
          await updateBuildStatus(env.db, build.id, 'cancelled');
          return Response.json({
            lines: [],
            lastSeq: 0,
            status: 'complete',
            terminal: true,
            logsComplete: false,
          });
        },
      }),
    } as unknown as DurableObjectNamespace;
    env.BUILD_MANAGER = ns;

    const res = await authGet(
      `/projects/${project.id}/builds/${build.id}/logs?since=0`,
      user.jwt,
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      terminal: boolean;
      logsComplete: boolean | null;
    };
    expect(body.terminal).toBe(true);
    expect(body.status).toBe('cancelled');
    expect(body.logsComplete).toBe(false);
  });

  it('only infers completion for durable never-started terminal builds', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });
    await updateBuildStatus(env.db, build.id, 'cancelled');
    env.BUILD_MANAGER = spyNamespace({ lines: [], lastSeq: 0 }).ns;

    const neverStarted = await authGet(
      `/projects/${project.id}/builds/${build.id}/logs`,
      user.jwt,
      env,
    );
    expect(await neverStarted.json()).toMatchObject({ terminal: true, logsComplete: true });

    await env.db
      .update(builds)
      .set({ started_at: new Date().toISOString() })
      .where(eq(builds.id, build.id));
    const started = await authGet(`/projects/${project.id}/builds/${build.id}/logs`, user.jwt, env);
    expect(await started.json()).toMatchObject({ terminal: true, logsComplete: null });
  });

  it('normalizes a non-numeric since to 0 when fronting the DO', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });
    const base = spyNamespace({ lines: [], lastSeq: 0 });
    env.BUILD_MANAGER = base.ns;
    await authGet(`/projects/${project.id}/builds/${build.id}/logs?since=abc`, user.jwt, env);
    expect(base.calls[0]).toContain('/logs?since=0');
  });

  it('returns the external GitHub URL for a github_actions build without touching the DO', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      logsUrl: 'https://github.com/o/r/actions/runs/1',
    });
    const base = spyNamespace({
      lines: [{ seq: 1, line: 'x', stream: 'stdout', ts: 1 }],
      lastSeq: 1,
    });
    env.BUILD_MANAGER = base.ns;

    const res = await authGet(`/projects/${project.id}/builds/${build.id}/logs`, user.jwt, env);
    const body = (await res.json()) as { lines: Array<unknown>; external: string | null };
    expect(body.lines).toEqual([]);
    expect(body.external).toBe('https://github.com/o/r/actions/runs/1');
    expect(base.calls).toHaveLength(0);
  });

  it('404s a build that does not belong to the project', async () => {
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id, 'a');
    const projectB = await createTestProject(env.db, user.id, 'b');
    const build = await createTestBuild(env.db, {
      projectId: projectB.id,
      userId: user.id,
      executor: 'container',
    });
    const res = await authGet(`/projects/${projectA.id}/builds/${build.id}/logs`, user.jwt, env);
    expect(res.status).toBe(404);
  });

  it('403s build logs for a non-owner', async () => {
    const owner = await createTestUser(env.db, 'owner2');
    const other = await createTestUser(env.db, 'intruder2');
    const project = await createTestProject(env.db, owner.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: owner.id,
      executor: 'container',
    });
    const res = await authGet(`/projects/${project.id}/builds/${build.id}/logs`, other.jwt, env);
    expect(res.status).toBe(403);
  });
});
