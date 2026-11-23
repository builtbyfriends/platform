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
import { signDeployToken } from '../../src/auth/deploy-token.ts';
import { signJwt } from '../../src/auth/jwt.ts';
import { createDeployment } from '../../src/db.ts';
import * as db from '../../src/db.ts';
import rawApp from '../../src/index.ts';
import { builds, deployments } from '../../src/schema.ts';
import {
  createTestBuild,
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  cfSuccess,
  readAllEvents,
  rpcData,
  rpcRequest,
  withLegacyDeploy,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

const app = withLegacyDeploy(rawApp);

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  // Decision: builds references projects through an FK, and clearTables doesn't clear builds,
  // so delete them first.
  await env.db.delete(builds);
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Decision: A deploy token (aud:'deploy') authenticates as the project owner but only to run `bwf deploy`
// against one project. The authMiddleware allowlist lets the deploy flow's endpoints through and
// denies other owner-scoped /projects/* routes and any cross-project use.
describe('deploy token scope enforcement', () => {
  async function deployToken(
    projectId: string,
    userId: string,
    login = 'octocat',
    buildId?: string,
  ): Promise<string> {
    const boundBuildId =
      buildId ??
      (
        await createTestBuild(env.db, {
          projectId,
          userId,
          executor: 'github_actions',
          status: 'building',
        })
      ).id;
    return signDeployToken({ projectId, userId, login, buildId: boundBuildId }, env.JWT_SECRET);
  }

  it('lets the real deploy endpoint through (auth passes; not 403)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-app');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    // Decision: An empty body: the handler gives 400 or similar. The test only checks that the auth middleware
    // didn't reject it with 403.
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      env,
    );

    expect(res.status).not.toBe(403);
  });

  it('lets a deploy token request Worker module upload URLs', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-worker-upload');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/rpc/deploy.workerUploadUrls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          modules: [{ name: 'index.js', size: 18, sha256: 'a'.repeat(64) }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(rpcData(await res.json())).toMatchObject({
      id: expect.any(String),
      urls: [expect.any(Object)],
    });
  });

  it('lets the deploy sibling endpoints through (preflight, upload-urls)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-siblings');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const preflight = await app.fetch(
      new Request(`http://localhost/rpc/deploy.preflight`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, ...JSON.parse('{}') }),
      }),
      env,
    );
    expect(preflight.status).not.toBe(403);

    const uploadUrls = await app.fetch(
      new Request(`http://localhost/rpc/deploy.uploadUrls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, ...JSON.parse('{}') }),
      }),
      env,
    );
    expect(uploadUrls.status).not.toBe(403);
  });

  it('lets the deploy read endpoints through (resources, deployments, secrets list)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-reads');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    for (const name of ['projects.resources', 'deployments.list', 'secrets.list']) {
      const res = await app.fetch(
        new Request(`http://localhost/rpc/${name}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: project.id }),
        }),
        env,
      );
      expect(res.status).not.toBe(403);
    }
  });

  // Decision: The deployments endpoint is on the deploy-token allowlist, but manifest `vars` holds plaintext
  // env values. A leaked build token mustn't read them, so they're stripped. The CLI only needs
  // `manifest.live` to restore live bindings, so that stays.
  it('strips manifest.vars (plaintext env) for deploy-token callers but keeps manifest.live', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-vars-stripped');
    const manifest = JSON.stringify({
      version: 3,
      bindings: {},
      vars: { SECRET: 'super-secret-value', API_KEY: 'k-123' },
      live: {
        bindingName: 'LIVE',
        className: 'LiveObject',
        storage: 'sqlite',
        classes: ['LiveObject'],
      },
    });
    await createDeployment(env.db, project.id, manifest);
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/rpc/deployments.list`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = rpcData(await res.json()) as {
      deployments: ReadonlyArray<{ manifest: string | null }>;
    };
    expect(body.deployments).toHaveLength(1);
    const returned = JSON.parse(body.deployments[0].manifest!) as Record<string, unknown>;
    expect(returned.vars).toBeUndefined();
    expect('vars' in returned).toBe(false);
    expect(returned.live).toEqual({
      bindingName: 'LIVE',
      className: 'LiveObject',
      storage: 'sqlite',
      classes: ['LiveObject'],
    });
    expect(returned.version).toBe(3);
  });

  it('returns the FULL manifest (including vars) for a full api token', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-vars-full');
    const manifest = JSON.stringify({
      version: 3,
      bindings: {},
      vars: { SECRET: 'super-secret-value' },
      live: {
        bindingName: 'LIVE',
        className: 'LiveObject',
        storage: 'sqlite',
        classes: ['LiveObject'],
      },
    });
    await createDeployment(env.db, project.id, manifest);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/rpc/deployments.list`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = rpcData(await res.json()) as {
      deployments: ReadonlyArray<{ manifest: string | null }>;
    };
    expect(body.deployments).toHaveLength(1);
    const returned = JSON.parse(body.deployments[0].manifest!) as Record<string, unknown>;
    expect(returned.vars).toEqual({ SECRET: 'super-secret-value' });
  });

  it('returns manifest:null for deploy-token callers when the manifest is unparseable', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-vars-garbage');
    // Decision: A null manifest and a manifest that isn't JSON both fail safe to null, so the response doesn't
    // carry an unparseable string that might hold secrets.
    await createDeployment(env.db, project.id, null);
    await createDeployment(env.db, project.id, 'not-json-at-all{');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/rpc/deployments.list`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = rpcData(await res.json()) as {
      deployments: ReadonlyArray<{ manifest: string | null }>;
    };
    expect(body.deployments).toHaveLength(2);
    for (const deployment of body.deployments) {
      expect(deployment.manifest).toBeNull();
    }
  });

  it('lets listProjects through (slug→id resolution)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-list');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request('http://localhost/rpc/projects.list', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).not.toBe(403);
  });

  it('listProjects with a P-scoped deploy token returns ONLY P (no cross-project metadata)', async () => {
    const user = await createTestUser(env.db);
    const projectP = await createTestProject(env.db, user.id, 'scoped-listed');
    const projectQ = await createTestProject(env.db, user.id, 'sibling-hidden');
    const token = await deployToken(projectP.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request('http://localhost/rpc/projects.list', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = rpcData(await res.json()) as ReadonlyArray<{ id: string; slug: string }>;
    const ids = body.map((p) => p.id);
    expect(ids).toContain(projectP.id);
    expect(ids).not.toContain(projectQ.id);
    expect(ids).toHaveLength(1);
  });

  it('listProjects with a full api token returns ALL owner projects', async () => {
    const user = await createTestUser(env.db);
    const projectP = await createTestProject(env.db, user.id, 'api-listed-p');
    const projectQ = await createTestProject(env.db, user.id, 'api-listed-q');
    mockCfApi();

    const res = await app.fetch(
      new Request('http://localhost/rpc/projects.list', {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = rpcData(await res.json()) as ReadonlyArray<{ id: string; slug: string }>;
    const ids = body.map((p) => p.id);
    expect(ids).toContain(projectP.id);
    expect(ids).toContain(projectQ.id);
  });

  it('rejects DELETE /projects/:id (project takeover)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'delete-target');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('rejects PUT /projects/:id/secrets/:name (secret rewrite)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-target');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      rpcRequest('secrets.set', token, { projectId: project.id, name: 'FOO', value: 'pwned' }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('rejects POST /projects/:id/github (repoint GitHub connection)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'github-target');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: 1, repoFullName: 'evil/repo' }),
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('rejects a P-scoped token used against a different project (cross-project)', async () => {
    const user = await createTestUser(env.db);
    const projectP = await createTestProject(env.db, user.id, 'scoped-project');
    const projectOther = await createTestProject(env.db, user.id, 'other-project');
    const token = await deployToken(projectP.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${projectOther.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
  });

  // Decision: A deploy token can be bound to the build it was minted for. Once that build isn't active
  // (superseded or cancelled by a newer push or run), a stale runner that still holds the token is
  // rejected at deploy time. The DB supersede is only advisory until the deploy endpoint enforces it.
  it('rejects a deploy token whose bound build is cancelled (superseded runner)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'build-cancelled');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'cancelled',
    });
    const token = await deployToken(project.id, user.id, 'octocat', build.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('lets a deploy token whose bound build is still active (building) through the build guard', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'build-active');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });
    const token = await deployToken(project.id, user.id, 'octocat', build.id);
    mockCfApi();

    // Decision: An empty body: the handler 400s on manifest validation. The test only checks that the
    // build-state guard didn't reject it with 403.
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(res.status).not.toBe(403);
  });

  // Decision: A deploy token is bound to a build or a CI credential. One with neither would skip both the
  // build-state and the revocation checks.
  it('rejects a deploy token with neither a build nor a credential claim', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'build-unbound');
    const token = await signJwt(
      { sub: user.id, login: user.login, aud: 'deploy', project: project.id },
      env.JWT_SECRET,
      { ttlSeconds: 15 * 60 },
    );
    mockCfApi();

    const requests = [
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      new Request(`http://localhost/rpc/projects.get`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id }),
      }),
    ];
    for (const request of requests) {
      const res = await app.fetch(request, env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: 'invalid or expired token',
        message: 'This deploy credential is invalid. Ask the project owner to issue a replacement.',
      });
    }
    const [deployment] = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment).toBeUndefined();
  });

  // Decision: The build-state guard is in authMiddleware, so it gates each allowlisted route a deploy token
  // can reach, not only POST /deploy. A superseded or cancelled runner mustn't mutate project state
  // through these routes either.
  const ALLOWLISTED_MUTATING_ROUTES: ReadonlyArray<{ name: string; path: string; rpc?: string }> = [
    { name: 'POST /projects/:id/database', path: 'database', rpc: 'database.provision' },
    {
      name: 'POST /projects/:id/deploy/preflight',
      path: 'deploy/preflight',
      rpc: 'deploy.preflight',
    },
    {
      name: 'POST /projects/:id/deploy/upload-urls',
      path: 'deploy/upload-urls',
      rpc: 'deploy.uploadUrls',
    },
    {
      name: 'POST /projects/:id/deploy/worker-upload-urls',
      path: 'deploy/worker-upload-urls',
      rpc: 'deploy.workerUploadUrls',
    },
  ];

  for (const status of ['cancelled', 'failed'] as const) {
    for (const route of ALLOWLISTED_MUTATING_ROUTES) {
      it(`rejects a deploy token bound to a ${status} build on ${route.name}`, async () => {
        const user = await createTestUser(env.db);
        const project = await createTestProject(env.db, user.id, `build-${status}-${route.path}`);
        const build = await createTestBuild(env.db, {
          projectId: project.id,
          userId: user.id,
          executor: 'github_actions',
          status,
        });
        const token = await deployToken(project.id, user.id, 'octocat', build.id);
        mockCfApi();

        const res = await app.fetch(
          new Request(
            route.rpc
              ? `http://localhost/rpc/${route.rpc}`
              : `http://localhost/projects/${project.id}/${route.path}`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: route.rpc ? JSON.stringify({ projectId: project.id }) : '{}',
            },
          ),
          env,
        );
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error: 'deploy token build is no longer active',
          message: expect.stringMatching(/start a new build/i),
        });
      });
    }
  }

  for (const route of ALLOWLISTED_MUTATING_ROUTES) {
    it(`lets a deploy token bound to an active (building) build through to ${route.name}`, async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, `build-active-${route.path}`);
      const build = await createTestBuild(env.db, {
        projectId: project.id,
        userId: user.id,
        executor: 'github_actions',
        status: 'building',
      });
      const token = await deployToken(project.id, user.id, 'octocat', build.id);
      mockCfApi();

      // Decision: An empty body: the handler returns a non-403 (400 or similar). The test only checks that the
      // central build-state guard didn't reject it with 403.
      const res = await app.fetch(
        new Request(
          route.rpc
            ? `http://localhost/rpc/${route.rpc}`
            : `http://localhost/projects/${project.id}/${route.path}`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: route.rpc ? JSON.stringify({ projectId: project.id }) : '{}',
          },
        ),
        env,
      );
      expect(res.status).not.toBe(403);
    });
  }

  // Decision: The build claim has to belong to the token's scoped project. A bound build of another project
  // is rejected even when it's active, to block a build-id and project-scope mismatch.
  it('rejects a deploy token whose bound build belongs to a different project', async () => {
    const user = await createTestUser(env.db);
    const projectP = await createTestProject(env.db, user.id, 'build-scope-self');
    const projectOther = await createTestProject(env.db, user.id, 'build-scope-other');
    const build = await createTestBuild(env.db, {
      projectId: projectOther.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });
    const token = await deployToken(projectP.id, user.id, 'octocat', build.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${projectP.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  // Decision: No assets and a trivial default worker module, so `mockCfApi()` covers each CF call on the way
  // to the final publish transaction.
  function fullDeployRequest(projectId: string, token: string): Request {
    return new Request(`http://localhost/projects/${projectId}/deploy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: { version: 3, assetManifestVersion: 2, bindings: {} },
        assetManifest: {},
        workerFiles: {
          'index.js': btoa("export default { fetch() { return new Response('ok'); } }"),
        },
      }),
    });
  }

  // Decision: The up-front build guard checks the bound build once at request entry, and the request can then
  // take minutes. A newer run can cancel the build in that window, so the final publish transaction
  // re-checks it. Here the build is `building` at entry, so the up-front guard passes, and the
  // cancel is injected during the Worker upload, so only the final-tx re-check can catch it.
  it('rejects a deploy whose bound build is cancelled mid-flight (final-tx re-check)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'build-superseded-midflight');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });
    const token = await deployToken(project.id, user.id, 'octocat', build.id);
    let cancelInjected = false;
    mockCfApi({
      uploadWorker: async () => {
        await env.db
          .update(builds)
          .set({ status: 'cancelled', error: 'superseded by newer run' })
          .where(eq(builds.id, build.id));
        cancelInjected = true;
        return cfSuccess({ id: 'uploaded-worker' });
      },
    });

    const res = await app.fetch(fullDeployRequest(project.id, token), env);
    expect(res.status).toBe(200);

    const events = await readAllEvents(res);
    expect(cancelInjected).toBe(true);
    expect(events.some((e) => (e as { event: string }).event === 'done')).toBe(false);
    const errEvent = events.find((e) => (e as { event: string }).event === 'error') as
      | { event: string; message?: string }
      | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent!.message).toBe('bound build was superseded');

    const liveRows = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.status, 'live'));
    expect(liveRows).toHaveLength(0);

    const updatedProject = await db.getProject(env.db, project.id);
    expect(updatedProject?.active_deployment_id ?? null).toBeNull();
  });

  it('lets a deploy go live when the bound build stays active through the final tx', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'build-active-through');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });
    const token = await deployToken(project.id, user.id, 'octocat', build.id);
    mockCfApi();

    const res = await app.fetch(fullDeployRequest(project.id, token), env);
    expect(res.status).toBe(200);

    const events = await readAllEvents(res);
    const done = events.find((e) => (e as { event: string }).event === 'done') as
      | { event: string; deployment: string }
      | undefined;
    expect(done).toBeDefined();

    const [dpl] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, done!.deployment));
    expect(dpl?.status).toBe('live');
  });
});
