import { eq } from 'drizzle-orm';
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
import { APP } from '../../src/app-credits.ts';
import { registerOAuthClient } from '../../src/auth/oauth.ts';
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import { cleanupJobsForResource } from '../../src/db/resources.ts';
import app from '../../src/index.ts';
import { provisionBindings } from '../../src/provisioning/provision.ts';
import {
  deleteOwnedVectorize,
  ensureVectorize,
  vectorizeIdentity,
} from '../../src/provisioning/vectorize.ts';
import { deployments, projects, resources } from '../../src/schema.ts';
import {
  clearTables,
  createMockExecutionContext,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  mockCfApi,
  readAllEvents,
  teardownEnv,
  withLegacyDeploy,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
let registration: Awaited<ReturnType<typeof registerOAuthClient>>;
let project: { id: string; slug: string };
let foreign: { id: string; slug: string };
let deployment: { id: string };
let identity: Awaited<ReturnType<typeof vectorizeIdentity>>;
const config = { dimensions: 3, metric: 'cosine' as const };
const provider = vi.fn<typeof fetch>();
const ok = (result: unknown) => Response.json({ success: true, result });
const missing = () =>
  Response.json({ success: false, errors: [{ code: 404, message: 'Not found' }] }, { status: 404 });
const index = () => ({ ...identity, config });
const info = () => ({
  dimensions: 3,
  vectorCount: 7,
  processedUpToDatetime: '2026-11-25T12:00:00.000Z',
});
const matches = () => ({
  matches: [{ id: 'record-one', score: 0.9, metadata: { secret: 'hidden' }, values: [1, 0, 0] }],
});
function respond(input: RequestInfo | URL) {
  const path = new URL(String(input)).pathname;
  return Promise.resolve(
    ok(path.endsWith('/info') ? info() : path.endsWith('/query') ? matches() : index()),
  );
}
const call = (
  body: {
    project?: string;
    resourceId?: string;
    owner?: { person: string };
    input?: unknown;
    action?: string;
  } = {},
  path = 'resources.execute',
) =>
  app.fetch(
    new Request(`https://platform.test/app-billing/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${registration.client.id}:${registration.clientSecret}`)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        project: project.id,
        resourceId: 'res_index',
        owner: { person: 'person' },
        action: 'index.info',
        input: {},
        ...body,
      }),
    }),
    env,
    createMockExecutionContext(),
  );
const payload = async (response: Promise<Response> | Response) => {
  const result = await response;
  expect(result.status).toBe(200);
  return result.json();
};
const resource = async () =>
  (await env.db.select().from(resources).where(eq(resources.id, 'res_index')))[0];
const provision = () =>
  ensureVectorize(env.db, env.CF_ACCOUNT_ID, env.CF_API_TOKEN, project.id, 'SEARCH', config);

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  registration = await registerOAuthClient(env.db, {
    name: 'Search test',
    operator: 'Test',
    redirectUris: ['https://app.test/callback'],
    scopes: ['profile'],
  });
  const owner = await createTestUser(
    env.db,
    'search-owner',
    APP + registration.client.id,
    'person',
  );
  const other = await createTestUser(env.db, 'other-owner');
  project = await createTestProject(env.db, owner.id);
  foreign = await createTestProject(env.db, other.id);
  deployment = await createTestDeployment(env.db, project.id);
  await env.db
    .update(deployments)
    .set({
      manifest: JSON.stringify({ version: 6, vectorize: [{ bindingName: 'SEARCH', ...config }] }),
    })
    .where(eq(deployments.id, deployment.id));
  identity = await vectorizeIdentity(project.id, 'SEARCH');
  await env.db.insert(resources).values({
    id: 'res_index',
    project_id: project.id,
    type: 'vectorize',
    cf_id: identity.name,
    binding_name: 'SEARCH',
    metadata: { ...config, provisioned: true },
  });
  env.PLATFORM_CAPABILITIES = JSON.stringify({ ...getPlatformCapabilities({}), vectorize: true });
  provider.mockReset().mockImplementation(respond);
  vi.stubGlobal('fetch', provider);
  delete env.DEV_AUTH_BYPASS;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('owned search index runtime', () => {
  it('advertises resource-scoped actions and returns only public index facts', async () => {
    expect(await payload(call({}, 'projects.resources'))).toMatchObject({
      data: {
        resources: [
          {
            id: 'res_index',
            kind: 'vector-index',
            browse: null,
            actions: [
              {
                id: 'index.info',
                effect: 'read',
                fields: [],
                view: { scope: 'resource', label: 'Overview' },
                result: 'records',
              },
              {
                id: 'index.query',
                effect: 'read',
                view: { scope: 'resource', label: 'Search' },
                result: 'records',
              },
            ],
          },
        ],
      },
    });
    const result = await payload(call());
    expect(result).toMatchObject({
      data: {
        appId: project.id,
        resourceId: 'res_index',
        action: 'index.info',
        kind: 'records',
        truncated: false,
        rows: [
          { id: 'dimensions', cells: ['Dimensions', 3] },
          { id: 'metric', cells: ['Distance metric', 'cosine'] },
          { id: 'vectors', cells: ['Indexed vectors', 7] },
          { id: 'processed', cells: ['Changes processed through', '2026-11-25T12:00:00.000Z'] },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain(identity.name);
    expect(result).not.toHaveProperty('data.table');
  });
  it('distinguishes missing provider measurements from zero', async () => {
    provider.mockImplementation(async (input) =>
      String(input).endsWith('/info') ? ok({}) : ok(index()),
    );
    expect(await payload(call())).toMatchObject({
      data: {
        rows: expect.arrayContaining([
          { id: 'vectors', cells: ['Indexed vectors', null] },
          { id: 'processed', cells: ['Changes processed through', null] },
        ]),
      },
    });
    provider.mockImplementation(async (input) =>
      String(input).endsWith('/info') ? ok({ vectorCount: 0 }) : ok(index()),
    );
    expect(await payload(call())).toHaveProperty('data.rows.2.cells.1', 0);
  });
  it('queries with bounded public IDs and scores, excluding metadata and vector values', async () => {
    const result = await payload(call({ action: 'index.query', input: { vector: '[1,0,0]' } }));
    expect(result).toHaveProperty('data.rows', [{ id: 'record-one', cells: ['record-one', 0.9] }]);
    const request = provider.mock.calls.find(([url]) => String(url).endsWith('/query'));
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      vector: [1, 0, 0],
      topK: 5,
      returnValues: false,
      returnMetadata: 'none',
    });
    expect(JSON.stringify(result)).not.toContain('hidden');
    expect(result).not.toHaveProperty('data.table');
  });
  it.each([
    {},
    { vector: '[]' },
    { vector: '["1",0,0]' },
    { vector: '[1e100,0,0]' },
    { vector: '[1,0,0]', topK: '0' },
    { vector: '[1,0,0]', topK: '21' },
    { vector: '[1,0,0]', topK: '1.5' },
    { vector: '[1,0,0]', topK: 2 },
    { vector: '[1,0,0]', table: 'secret' },
    { vector: '[1,0,0]', returnMetadata: 'all' },
  ])('rejects invalid query input before contacting the provider: %j', async (input) => {
    expect((await call({ action: 'index.query', input })).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });
  it('rejects a valid numeric vector with the wrong dimensions before querying', async () => {
    expect(
      await payload(call({ action: 'index.query', input: { vector: '[1,0]' } })),
    ).toMatchObject({
      data: { kind: 'unavailable', reason: expect.stringContaining('exactly 3 numbers') },
    });
    expect(provider.mock.calls.some(([url]) => String(url).endsWith('/query'))).toBe(false);
  });
  it.each([
    'capability',
    'preview',
    'suspended',
    'deleting',
    'pending',
    'manifest',
    'foreign-deployment',
  ])('hides actions and refuses %s resources', async (mode) => {
    if (mode === 'capability') {
      delete env.PLATFORM_CAPABILITIES;
    }
    if (mode === 'preview') {
      await env.db
        .update(projects)
        .set({
          preview_client_id: registration.client.id,
          preview_workspace_id: 'test',
          slug: 'preview-test',
          preview_expires_at: new Date(Date.now() + 60_000).toISOString(),
        })
        .where(eq(projects.id, project.id));
    }
    if (mode === 'suspended') {
      await env.db
        .update(projects)
        .set({ suspended_reason: 'test' })
        .where(eq(projects.id, project.id));
    }
    if (mode === 'deleting') {
      await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    }
    if (mode === 'pending') {
      await env.db
        .update(resources)
        .set({ metadata: { ...config, provisioned: false } })
        .where(eq(resources.id, 'res_index'));
    }
    if (mode === 'manifest') {
      await env.db
        .update(deployments)
        .set({ manifest: '{}' })
        .where(eq(deployments.id, deployment.id));
    }
    if (mode === 'foreign-deployment') {
      await env.db
        .update(deployments)
        .set({ project_id: foreign.id })
        .where(eq(deployments.id, deployment.id));
    }
    const inventory = await call({}, 'projects.resources');
    if (inventory.status === 200) {
      expect(await inventory.json()).toHaveProperty('data.resources.0.actions', []);
    }
    const result = await call();
    if (result.status === 200) {
      expect(await result.json()).toHaveProperty('data.kind', 'unavailable');
    } else {
      expect(result.status).toBe(404);
    }
    expect(provider).not.toHaveBeenCalled();
  });
  it('rejects foreign owners and resource IDs', async () => {
    expect((await call({ project: foreign.id })).status).toBe(404);
    expect((await call({ owner: { person: 'other' } })).status).toBe(404);
    expect((await call({ resourceId: 'res_foreign' })).status).toBe(404);
    expect(provider).not.toHaveBeenCalled();
  });
  it.each(['name', 'description', 'config'])('refuses provider %s drift', async (field) => {
    provider.mockResolvedValue(
      ok({ ...index(), [field]: field === 'config' ? { ...config, dimensions: 4 } : 'foreign' }),
    );
    expect(await payload(call())).toMatchObject({ data: { kind: 'unavailable' } });
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each([
    {
      matches: [
        { id: 'a', score: 1 },
        { id: 'a', score: 0.1 },
      ],
    },
    { matches: [{ id: 'a', score: '0.9' }] },
    { matches: [{ id: 'a'.repeat(65), score: 0.9 }] },
    { matches: Array.from({ length: 6 }, (_, i) => ({ id: String(i), score: 1 })) },
  ])('rejects malformed provider results', async (result) => {
    provider.mockImplementation(async (input) =>
      String(input).endsWith('/query') ? ok(result) : ok(index()),
    );
    expect(
      await payload(call({ action: 'index.query', input: { vector: '[1,0,0]' } })),
    ).toMatchObject({ data: { kind: 'unavailable' } });
  });
  it.each(['owner', 'deployment', 'metadata', 'suspension'])(
    'discards results after a concurrent %s change',
    async (change) => {
      provider.mockImplementation(async (input) => {
        if (String(input).endsWith('/info')) {
          if (change === 'owner') {
            const [other] = await env.db.select().from(projects).where(eq(projects.id, foreign.id));
            await env.db
              .update(projects)
              .set({ user_id: other.user_id })
              .where(eq(projects.id, project.id));
          }
          if (change === 'deployment') {
            await env.db
              .update(projects)
              .set({ active_deployment_id: null })
              .where(eq(projects.id, project.id));
          }
          if (change === 'metadata') {
            await env.db
              .update(resources)
              .set({ metadata: { ...config, dimensions: 4, provisioned: true } })
              .where(eq(resources.id, 'res_index'));
          }
          if (change === 'suspension') {
            await env.db
              .update(projects)
              .set({ suspended_reason: 'test' })
              .where(eq(projects.id, project.id));
          }
          return ok(info());
        }
        return ok(index());
      });
      expect((await call()).status).toBe(409);
    },
  );
});

describe('owned search index provisioning and cleanup', () => {
  it('deploys, reuses, and retains the owned binding after a failed Worker upload', async () => {
    const user = await createTestUser(env.db, 'published-search');
    const target = await createTestProject(env.db, user.id);
    const owned = await vectorizeIdentity(target.id, 'SEARCH');
    const cf = mockCfApi();
    const fallback = globalThis.fetch;
    let created = false;
    let failUpload = false;
    provider.mockImplementation(async (input, options) => {
      const url = String(input);
      if (url.includes('/vectorize/v2/indexes')) {
        if (options?.method === 'POST') {
          created = true;
          return ok({ ...owned, config });
        }
        return created ? ok({ ...owned, config }) : missing();
      }
      if (failUpload && url.includes('/workers/dispatch/') && options?.method === 'PUT') {
        return Response.json(
          { success: false, errors: [{ code: 10_021, message: 'Invalid test Worker' }] },
          { status: 400 },
        );
      }
      return fallback(input, options);
    });
    vi.stubGlobal('fetch', provider);
    const deploy = () =>
      withLegacyDeploy(app).fetch(
        new Request('https://platform.test/projects/' + target.id + '/deploy', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + user.jwt, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manifest: {
              version: 6,
              assetManifestVersion: 2,
              bindings: {},
              vectorize: [{ bindingName: 'SEARCH', ...config }],
            },
            assetManifest: {},
            workerFiles: {
              'index.js': btoa('export default {fetch(){return new Response("ok")}}'),
            },
          }),
        }),
        env,
      );
    const firstEvents = await readAllEvents(await deploy());
    expect(firstEvents.at(-1), JSON.stringify(firstEvents)).toMatchObject({ event: 'done' });
    expect([...cf.state.hostScripts.values()].flatMap((script) => script.bindings)).toContainEqual({
      type: 'vectorize',
      name: 'SEARCH',
      index_name: owned.name,
    });
    const [first] = await env.db
      .select()
      .from(resources)
      .where(eq(resources.project_id, target.id));
    expect((await readAllEvents(await deploy())).at(-1)).toMatchObject({ event: 'done' });
    const [second] = await env.db
      .select()
      .from(resources)
      .where(eq(resources.project_id, target.id));
    expect(second).toEqual(first);
    const [before] = await env.db.select().from(projects).where(eq(projects.id, target.id));
    failUpload = true;
    expect((await readAllEvents(await deploy())).at(-1)).toMatchObject({ event: 'error' });
    const [after] = await env.db.select().from(projects).where(eq(projects.id, target.id));
    expect(after.active_deployment_id).toBe(before.active_deployment_id);
    expect(
      await env.db.select().from(resources).where(eq(resources.project_id, target.id)),
    ).toEqual([first]);
    expect(
      provider.mock.calls.filter(
        ([url, options]) => String(url).includes('/vectorize/') && options?.method === 'POST',
      ),
    ).toHaveLength(1);
    expect(
      provider.mock.calls.filter(
        ([url, options]) => String(url).includes('/vectorize/') && options?.method === 'DELETE',
      ),
    ).toHaveLength(0);
  });

  it('uploads a real Vectorize binding with only the provider configuration fields', async () => {
    await env.db.delete(resources).where(eq(resources.id, 'res_index'));
    provider.mockResolvedValueOnce(missing()).mockImplementation(async () => ok(index()));
    const bindings = await provisionBindings(
      env.db,
      env.CF_ACCOUNT_ID,
      env.CF_API_TOKEN,
      project.id,
      { version: 6, bindings: {}, vectorize: [{ bindingName: 'SEARCH', ...config }] },
      'proxy',
      { projectSlug: project.slug, proxyToken: 'test' },
    );
    expect(bindings).toContainEqual({
      type: 'vectorize',
      name: 'SEARCH',
      index_name: identity.name,
    });
    const create = provider.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(JSON.parse(String(create?.[1]?.body))).toEqual({ ...identity, config });
  });
  it('serializes concurrent deploys to create one index', async () => {
    await env.db.delete(resources).where(eq(resources.id, 'res_index'));
    let created = false;
    provider.mockImplementation(async (_input, options) => {
      if (options?.method === 'POST') {
        created = true;
        return ok(index());
      }
      return created ? ok(index()) : missing();
    });
    const [first, second] = await Promise.all([provision(), provision()]);
    expect(first.id).toBe(second.id);
    expect(provider.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
  it('rejects deploy and rollback when installation support is absent', async () => {
    const user = await createTestUser(env.db, 'direct');
    const target = await createTestProject(env.db, user.id);
    const manifest = {
      version: 6,
      assetManifestVersion: 2,
      bindings: {},
      vectorize: [{ bindingName: 'SEARCH', ...config }],
    };
    const disabled = { ...env, PLATFORM_CAPABILITIES: JSON.stringify(getPlatformCapabilities({})) };
    const request = (path: string, body: unknown) =>
      new Request('https://platform.test/projects/' + target.id + '/' + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + user.jwt, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const rejected = await withLegacyDeploy(app).fetch(
      request('deploy', { manifest, assetManifest: {}, workerFiles: {} }),
      disabled,
    );
    expect(rejected.status).toBe(501);
    const retained = await createTestDeployment(env.db, target.id);
    await env.db
      .update(deployments)
      .set({ retained: true, manifest: JSON.stringify(manifest) })
      .where(eq(deployments.id, retained.id));
    const rollback = await withLegacyDeploy(app).fetch(
      request('rollback', { deploymentId: retained.id }),
      disabled,
    );
    expect(rollback.status).toBe(501);
    expect(provider).not.toHaveBeenCalled();
  });

  it('creates once and preserves the existing index on redeploy', async () => {
    await env.db.delete(resources).where(eq(resources.id, 'res_index'));
    provider
      .mockResolvedValueOnce(missing())
      .mockResolvedValueOnce(ok(index()))
      .mockImplementation(async () => ok(index()));
    const created = await provision();
    expect(created.metadata).toEqual({ ...config, provisioned: true });
    expect(await provision()).toEqual(created);
    expect(provider.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(String(provider.mock.calls[1][1]?.body))).toEqual({ ...identity, config });
  });
  it('keeps creation intent after an uncertain write and reconciles without creating again', async () => {
    await env.db.delete(resources).where(eq(resources.id, 'res_index'));
    provider
      .mockResolvedValueOnce(missing())
      .mockRejectedValueOnce(new Error('network interrupted'));
    await expect(provision()).rejects.toThrow('network interrupted');
    const [pending] = await env.db
      .select()
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(pending.metadata).toEqual({ ...config, provisioned: false });
    provider.mockReset().mockResolvedValue(ok(index()));
    expect((await provision()).metadata.provisioned).toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0][1]?.method).toBeUndefined();
  });
  it('rejects a changed deployment owner before provisioning', async () => {
    await expect(
      ensureVectorize(
        env.db,
        env.CF_ACCOUNT_ID,
        env.CF_API_TOKEN,
        project.id,
        'SEARCH',
        config,
        'previous-owner',
      ),
    ).rejects.toThrow('cannot provision');
    await expect(
      provisionBindings(
        env.db,
        env.CF_ACCOUNT_ID,
        env.CF_API_TOKEN,
        project.id,
        { version: 6, bindings: {}, vectorize: [{ bindingName: 'SEARCH', ...config }] },
        'proxy',
        { projectSlug: project.slug, proxyToken: 'test', ownerUserId: 'previous-owner' },
      ),
    ).rejects.toThrow('cannot provision');
    expect(provider).not.toHaveBeenCalled();
  });
  it('refuses to recreate a missing established index as empty data', async () => {
    provider.mockResolvedValue(missing());
    await expect(provision()).rejects.toThrow();
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each([
    { dimensions: 4, metric: 'cosine' as const },
    { dimensions: 3, metric: 'euclidean' as const },
  ])('rejects immutable configuration changes before provider calls', async (next) => {
    await expect(
      ensureVectorize(env.db, env.CF_ACCOUNT_ID, env.CF_API_TOKEN, project.id, 'SEARCH', next),
    ).rejects.toThrow('cannot be changed');
    expect(provider).not.toHaveBeenCalled();
  });
  it('does not adopt a foreign index matching the deterministic name', async () => {
    await env.db.delete(resources).where(eq(resources.id, 'res_index'));
    provider.mockResolvedValue(ok({ ...index(), description: 'someone else' }));
    await expect(provision()).rejects.toThrow('ownership changed');
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each(['preview', 'suspended', 'deleting'])(
    'refuses provisioning into %s projects',
    async (kind) => {
      if (kind === 'preview') {
        await env.db
          .update(projects)
          .set({
            preview_client_id: registration.client.id,
            preview_workspace_id: 'test',
            slug: 'preview-test',
            preview_expires_at: new Date(Date.now() + 60_000).toISOString(),
          })
          .where(eq(projects.id, project.id));
      }
      if (kind === 'suspended') {
        await env.db
          .update(projects)
          .set({ suspended_reason: 'test' })
          .where(eq(projects.id, project.id));
      }
      if (kind === 'deleting') {
        await env.db
          .update(projects)
          .set({ status: 'deleting' })
          .where(eq(projects.id, project.id));
      }
      await expect(provision()).rejects.toThrow('cannot provision');
      expect(provider).not.toHaveBeenCalled();
    },
  );
  it('persists cleanup identity and verifies it before deleting', async () => {
    const entry = await resource();
    expect(cleanupJobsForResource(project.id, entry)).toMatchObject([
      {
        payload: {
          type: 'vectorize',
          cfId: identity.name,
          bindingName: 'SEARCH',
          metadata: JSON.stringify(entry.metadata),
        },
      },
    ]);
    await deleteOwnedVectorize(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, project.id, entry);
    expect(provider.mock.calls[1][1]?.method).toBe('DELETE');
  });
  it('does not delete an index with changed provider ownership', async () => {
    provider.mockResolvedValue(ok({ ...index(), description: 'someone else' }));
    await expect(
      deleteOwnedVectorize(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, project.id, await resource()),
    ).rejects.toThrow('ownership changed');
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('tolerates an already deleted owned index', async () => {
    provider.mockResolvedValue(missing());
    await deleteOwnedVectorize(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, project.id, await resource());
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('does not contact the provider for a forged stored index name', async () => {
    await expect(
      deleteOwnedVectorize(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, project.id, {
        ...(await resource()),
        cf_id: 'foreign',
      }),
    ).rejects.toThrow('ownership');
    expect(provider).not.toHaveBeenCalled();
  });
});
