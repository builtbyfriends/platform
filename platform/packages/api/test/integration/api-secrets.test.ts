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
import { getProjectSecrets } from '../../src/db.ts';
import app from '../../src/index.ts';
import { deployments, projects } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  createTestProjectSecret,
  cfError,
  mockCfApi,
  rpcData,
  rpcRequest,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

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

describe('project secrets API', () => {
  it.each(['pending', 'cutover', 'compensating'] as const)(
    'rejects secret writes and deletes while deployment is %s without changing stored or live values',
    async (status) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, `secret-busy-${status}`);
      await createTestDeployment(env.db, project.id, 'live');
      const pending = await createTestDeployment(env.db, project.id, 'pending');
      await env.db.update(deployments).set({ status }).where(eq(deployments.id, pending.id));
      await createTestProjectSecret(env.db, env, project.id, 'API_KEY', 'old');
      const before = await getProjectSecrets(env.db, project.id);
      const fetchMock = mockCfApi();
      for (const method of ['PUT', 'DELETE']) {
        const response = await app.fetch(
          rpcRequest(method === 'PUT' ? 'secrets.set' : 'secrets.delete', user.jwt, {
            projectId: project.id,
            name: 'API_KEY',
            ...(method === 'PUT' ? { value: 'new' } : {}),
          }),
          env,
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: { code: 'DEPLOYMENT_IN_PROGRESS', message: expect.stringContaining(pending.id) },
        });
        expect(await getProjectSecrets(env.db, project.id)).toEqual(before);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('resolves the current active worker after a cutover during secret encryption', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-raced-cutover');
    const first = await createTestDeployment(env.db, project.id, 'live');
    const next = await createTestDeployment(env.db, project.id, 'pending');
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      const result = await encrypt(...args);
      await env.db.update(deployments).set({ status: 'live' }).where(eq(deployments.id, next.id));
      await env.db
        .update(projects)
        .set({ active_deployment_id: next.id })
        .where(eq(projects.id, project.id));
      return result;
    });
    const fetchMock = mockCfApi();
    const response = await app.fetch(
      rpcRequest('secrets.set', user.jwt, { projectId: project.id, name: 'API_KEY', value: 'new' }),
      env,
    );
    expect(response.status).toBe(200);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(
      urls.some((url) => url.includes(`/scripts/user-${project.slug}-${next.id}/secrets`)),
    ).toBe(true);
    expect(
      urls.some((url) => url.includes(`/scripts/user-${project.slug}-${first.id}/secrets`)),
    ).toBe(false);
  });

  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      rpcRequest('secrets.set', undefined, {
        projectId: 'proj_x',
        name: 'API_KEY',
        value: 'secret',
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  // Decision: Only names that also pass `isValidSecretName` (`^[A-Z][A-Z0-9_]*$`) reach this guard; the
  // `__PLATFORM_*` bindings are rejected a step earlier. Without it the row is encrypted and
  // persisted, then silently shadowed by the platform binding at the next deploy, with no clear error
  // near the PUT that caused it.
  it.each(['SEND_EMAIL', 'USAGE_EVENTS_QUEUE', 'ASSETS'])(
    'returns 400 for reserved binding name: %s',
    async (name) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(
        env.db,
        user.id,
        `secret-reserved-${name.toLowerCase().replaceAll('_', '-')}`,
      );
      const res = await app.fetch(
        rpcRequest('secrets.set', user.jwt, {
          projectId: project.id,
          name,
          value: 'whatever',
        }),
        env,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'RESERVED_NAME', message: 'reserved binding name' },
      });
    },
  );

  // Decision: Not reserved: the one project-slug binding is `__PLATFORM_PROJECT_SLUG`. Reserving an undotted
  // twin nothing injects would take a usable name away for no benefit.
  it('allows a secret named BWF_PROJECT_SLUG', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-bare-slug');
    const res = await app.fetch(
      rpcRequest('secrets.set', user.jwt, {
        projectId: project.id,
        name: 'BWF_PROJECT_SLUG',
        value: 'whatever',
      }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it('sets a secret for owned project', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-app');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      rpcRequest('secrets.set', user.jwt, {
        projectId: project.id,
        name: 'API_KEY',
        value: 'top-secret',
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(rpcData(await res.json())).toEqual({ ok: true, name: 'API_KEY' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists secrets for owned project', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-list-app');
    await createTestProjectSecret(env.db, env, project.id, 'BETTER_AUTH_SECRET', 'auth-secret');
    await createTestProjectSecret(env.db, env, project.id, 'API_KEY', 'top-secret');

    const res = await app.fetch(
      new Request(`http://localhost/rpc/secrets.list`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ projectId: project.id }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(rpcData(await res.json())).toEqual([
      { name: 'API_KEY' },
      { name: 'BETTER_AUTH_SECRET' },
    ]);
  });

  it('propagates secret updates to the active versioned worker', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-live-app');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      rpcRequest('secrets.set', user.jwt, {
        projectId: project.id,
        name: 'API_KEY',
        value: 'top-secret',
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(rpcData(await res.json())).toEqual({ ok: true, name: 'API_KEY' });

    const call = fetchMock.mock.calls.find((c) => {
      const method = (c[1] as RequestInit | undefined)?.method;
      const url = typeof c[0] === 'string' ? c[0] : String(c[0]);
      return (
        method === 'PUT' && url.includes(`/scripts/user-${project.slug}-${deployment.id}/secrets`)
      );
    });
    expect(call).toBeDefined();
  });

  it('returns 502 when live secret propagation fails after storing the value', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-fail-app');
    await createTestDeployment(env.db, project.id, 'live');
    mockCfApi({
      setWorkerSecret: () => cfError('boom', 500),
    });

    const res = await app.fetch(
      rpcRequest('secrets.set', user.jwt, {
        projectId: project.id,
        name: 'API_KEY',
        value: 'top-secret',
      }),
      env,
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: {
        code: 'PROPAGATION_FAILED',
        message: expect.stringContaining('secret stored but live propagation failed'),
      },
    });

    const listRes = await app.fetch(
      new Request(`http://localhost/rpc/secrets.list`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ projectId: project.id }),
      }),
      env,
    );
    expect(listRes.status).toBe(200);
    expect(rpcData(await listRes.json())).toEqual([{ name: 'API_KEY' }]);
  });

  it('deletes a secret for owned project', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-delete-app');
    await createTestProjectSecret(env.db, env, project.id, 'API_KEY', 'top-secret');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      rpcRequest('secrets.delete', user.jwt, { projectId: project.id, name: 'API_KEY' }),
      env,
    );

    expect(res.status).toBe(200);
    expect(rpcData(await res.json())).toEqual({ ok: true, name: 'API_KEY' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates secret deletes to the active versioned worker', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-delete-live-app');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await createTestProjectSecret(env.db, env, project.id, 'API_KEY', 'top-secret');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      rpcRequest('secrets.delete', user.jwt, { projectId: project.id, name: 'API_KEY' }),
      env,
    );

    expect(res.status).toBe(200);
    expect(rpcData(await res.json())).toEqual({ ok: true, name: 'API_KEY' });

    const call = fetchMock.mock.calls.find((c) => {
      const method = (c[1] as RequestInit | undefined)?.method;
      const url = typeof c[0] === 'string' ? c[0] : String(c[0]);
      return (
        method === 'DELETE' &&
        url.includes(`/scripts/user-${project.slug}-${deployment.id}/secrets/API_KEY`)
      );
    });
    expect(call).toBeDefined();
  });

  it('returns 403 for non-owner', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-secret-app');
    mockCfApi();

    const res = await app.fetch(
      rpcRequest('secrets.set', bob.jwt, { projectId: project.id, name: 'API_KEY', value: 'nope' }),
      env,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'FORBIDDEN', message: expect.any(String) } });
  });

  it('validates secret name', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-name-app');
    mockCfApi();

    const res = await app.fetch(
      rpcRequest('secrets.set', user.jwt, { projectId: project.id, name: 'not-valid', value: 'x' }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'INVALID_NAME', message: 'invalid secret name' },
    });
  });
});
