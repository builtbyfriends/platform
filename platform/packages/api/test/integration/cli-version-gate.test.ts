import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vite-plus/test';
import type { Db } from '../../src/db.ts';
import rawApp from '../../src/index.ts';
import { MIN_CLI_VERSION } from '../../src/middleware/cli-version.ts';
import { projects } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  rpcRequest,
  withLegacyDeploy,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

const app = withLegacyDeploy(rawApp);
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

describe('cliVersionGate — deploy endpoints (passing the gate)', () => {
  it('rejects old X-Platform-CLI-Version header on deploy.finalize', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'finalize-old-app');

    const request = rpcRequest('deploy.finalize', user.jwt, { projectId: project.id, body: {} });
    request.headers.set('X-Platform-CLI-Version', '0.6.0');
    const res = await app.fetch(request, env);

    expect(res.status).toBe(426);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CLI_OUTDATED');
    expect(body.error.message).toContain(MIN_CLI_VERSION);
  });

  it('rejects old X-Platform-CLI-Version header on POST /deploy/upload-urls', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'old-app');

    const res = await app.fetch(
      new Request(`http://localhost/rpc/deploy.uploadUrls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
          'X-Platform-CLI-Version': '0.6.0',
        },
        body: JSON.stringify({ projectId: project.id, assets: [] }),
      }),
      env,
    );

    expect(res.status).toBe(426);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CLI_OUTDATED');
    expect(body.error.message).toContain(MIN_CLI_VERSION);
  });

  it('rejects old X-Platform-CLI-Version header on POST /deploy/preflight', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pf-app');

    const res = await app.fetch(
      new Request(`http://localhost/rpc/deploy.preflight`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
          'X-Platform-CLI-Version': '0.5.99',
        },
        body: JSON.stringify({ projectId: project.id, assetManifest: {} }),
      }),
      env,
    );

    expect(res.status).toBe(426);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CLI_OUTDATED');
  });

  it('rejects unparseable X-Platform-CLI-Version (fail closed)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'fail-closed-app');

    const res = await app.fetch(
      new Request(`http://localhost/rpc/deploy.uploadUrls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
          'X-Platform-CLI-Version': 'garbage',
        },
        body: JSON.stringify({ projectId: project.id, assets: [] }),
      }),
      env,
    );

    expect(res.status).toBe(426);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CLI_OUTDATED');
    expect(body.error.message).toMatch(/unrecognized/i);
  });

  it('does not gate me.get — old CLIs can still introspect their session', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/rpc/me.get', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'X-Platform-CLI-Version': '0.0.1',
        },
      }),
      env,
    );

    expect(res.status).toBe(200);
  });

  it('passes through requests with a current version header', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'curr-app');

    const res = await app.fetch(
      new Request(`http://localhost/rpc/deploy.uploadUrls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
          'X-Platform-CLI-Version': MIN_CLI_VERSION,
        },
        body: JSON.stringify({ projectId: project.id, assets: [] }),
      }),
      env,
    );

    expect(res.status).not.toBe(426);
  });
});

// Decision: Project-authorization checks run before the CLI version gate so a stale CLI hitting a missing,
// foreign or deleting project gets the more specific 404 / 403 / 410 instead of a misleading
// "upgrade your CLI" 426.
describe('cliVersionGate — defers to project authorization', () => {
  it('returns 403 (not 426) when project does not exist, even with a stale version header', async () => {
    const user = await createTestUser(env.db);

    const request = rpcRequest('deploy.finalize', user.jwt, {
      projectId: 'proj_nonexistent',
      body: {},
    });
    request.headers.set('X-Platform-CLI-Version', '0.6.0');
    const res = await app.fetch(request, env);

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 (not 426) when project belongs to another user, even with stale version header', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const aliceProject = await createTestProject(env.db, alice.id, 'alice-app');

    const res = await app.fetch(
      new Request(`http://localhost/rpc/deploy.uploadUrls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bob.jwt}`,
          'Content-Type': 'application/json',
          'X-Platform-CLI-Version': '0.0.1',
        },
        body: JSON.stringify({ projectId: aliceProject.id, assets: [] }),
      }),
      env,
    );

    expect(res.status).toBe(403);
  });

  it('returns 410 (not 426) when project is being deleted, even with a stale version header', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deleting-app');
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const request = rpcRequest('deploy.finalize', user.jwt, { projectId: project.id, body: {} });
    request.headers.set('X-Platform-CLI-Version', '0.6.0');
    const res = await app.fetch(request, env);

    expect(res.status).toBe(410);
  });

  it('returns 410 (not 426) on /deploy/preflight when project is being deleted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pf-deleting-app');
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const res = await app.fetch(
      new Request(`http://localhost/rpc/deploy.preflight`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
          'X-Platform-CLI-Version': '0.0.1',
        },
        body: JSON.stringify({ projectId: project.id, assetManifest: {} }),
      }),
      env,
    );

    expect(res.status).toBe(410);
  });

  // Decision: /upload-urls re-reads the project status under a FOR SHARE lock, so a teardown that commits after
  // the unlocked early-out 410 read but before the share lock still surfaces as 410 rather than
  // serving presigned URLs against a bucket being deleted. The test wraps env.db.transaction in a
  // Proxy that pauses before the real call, updates projects.status='deleting' through realDb, then
  // releases.
  it('returns 410 when project flips to deleting between handler entry and FOR-SHARE acquisition', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uu-race-app');

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
      const reqPromise = app.fetch(
        new Request(`http://localhost/rpc/deploy.uploadUrls`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
            'X-Platform-CLI-Version': MIN_CLI_VERSION,
          },
          body: JSON.stringify({ projectId: project.id, assets: [] }),
        }),
        env,
      );
      await beforeTxReachedPromise;

      await realDb.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

      beforeTxResolver?.();
      const res = await reqPromise;
      expect(res.status).toBe(410);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('PROJECT_DELETING');
    } finally {
      setTestDb(realDb);
    }
  });
});
