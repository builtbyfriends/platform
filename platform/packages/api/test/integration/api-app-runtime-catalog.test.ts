import { readFile } from 'node:fs/promises';
import { type } from 'arktype';
import { eq } from 'drizzle-orm';
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
import { registerOAuthClient } from '../../src/auth/oauth.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import { cloudflareCatalog } from '../../src/infrastructure/cloudflare-catalog.ts';
import {
  cloudflareOpenApiIndex,
  cloudflareOpenApiKey,
  cloudflareOperationSchema,
} from '../../src/infrastructure/cloudflare-openapi.ts';
import { durableObjectWorkerName } from '../../src/provisioning/durable-objects.ts';
import { appRuntimeCatalogRoutes } from '../../src/routes/app-runtime-catalog.ts';
import { appRuntimeOperationRoutes } from '../../src/routes/app-runtime-operations.ts';
import {
  deployments,
  platformSettings,
  projects,
  projectZeroTrust,
  resources,
} from '../../src/schema.ts';
import {
  clearTables,
  createMockExecutionContext,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv & { PLATFORM_PROXY?: Fetcher };
let registration: Awaited<ReturnType<typeof registerOAuthClient>>;
let project: { id: string };
let foreign: { id: string };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary fixtures deliberately include malformed requests.
const request = (body: unknown, authorization = true) => {
  const headers = new Headers({ 'Content-Type': 'application/json' });

  if (authorization) {
    headers.set(
      'authorization',
      'Basic ' + btoa(registration.client.id + ':' + registration.clientSecret),
    );
  }

  return new Request('https://platform.test/app-billing/projects.capabilities', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
};

const dataSchema = type({
  data: {
    available: 'boolean',
    scope: { resourceId: 'string | null', product: 'string | null' },
    operations: type({
      id: 'string',
      'command?': 'string',
      execution: "'discovery-only' | 'registered'",
    }).array(),
    capabilities: type({ id: 'string', kind: 'string', actions: 'unknown[]' }).array(),
    products: 'unknown[]',
    nextCursor: 'string | null',
  },
});

const read = async (response: Response) => dataSchema.assert(await response.json());
const resourcesSchema = type({ data: { resources: type({ id: 'string' }).array() } });

const input = () => ({
  project: project.id,
  owner: { person: 'person' },
  resourceId: 'res_connection',
  limit: 2,
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary fixtures deliberately include malformed requests.
const call = (body: unknown = input(), authorization = true) =>
  app.fetch(request(body, authorization), env, createMockExecutionContext());

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(teardownEnv);
afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  env.CF_ACCOUNT_ID = 'test-account-id';
  env.CF_API_TOKEN = 'test-cf-token';
  await clearTables(env.db);
  delete env.PLATFORM_PROXY;
  registration = await registerOAuthClient(env.db, {
    name: 'Discovery test',
    operator: 'Test',
    redirectUris: ['https://app.test/callback'],
    scopes: ['profile'],
  });

  const owner = await createTestUser(
    env.db,
    'catalog-owner',
    'app:' + registration.client.id,
    'person',
  );

  const other = await createTestUser(env.db, 'catalog-other');
  project = await createTestProject(env.db, owner.id);
  foreign = await createTestProject(env.db, other.id);
  const deployment = await createTestDeployment(env.db, project.id);
  await env.db
    .update(projects)
    .set({ active_deployment_id: deployment.id })
    .where(eq(projects.id, project.id));
  await env.db.insert(resources).values([
    {
      id: 'res_connection',
      project_id: project.id,
      type: 'hyperdrive',
      cf_id: 'private-connection-id',
      binding_name: 'CATALOG',
    },
    {
      id: 'res_files',
      project_id: project.id,
      type: 'r2',
      cf_id: 'private-bucket-name',
      binding_name: 'UPLOADS',
    },
    {
      id: 'res_database',
      project_id: project.id,
      type: 'd1',
      cf_id: 'private-database-id',
      binding_name: 'DATABASE',
    },
    {
      id: 'res_foreign',
      project_id: foreign.id,
      type: 'hyperdrive',
      cf_id: 'private-other-id',
      binding_name: 'OTHER',
    },
  ]);
  delete env.DEV_AUTH_BYPASS;
});

describe('owned operation discovery', () => {
  it('links executable provider entries to the authoritative resource descriptor only for a selected owned resource', async () => {
    env.CF_ACCOUNT_ID = 'a'.repeat(32);
    const entry = (await cloudflareOpenApiIndex()).find(
      (value) =>
        value.method === 'GET' && value.path === '/accounts/{account_id}/r2/buckets/{bucket_name}',
    );
    if (!entry) {
      throw Error('Missing R2 provider schema');
    }
    await env.STATIC_ASSETS_R2.put(
      cloudflareOpenApiKey(entry),
      await readFile(new URL('../fixtures/cloudflare-openapi/r2-get.json.gz', import.meta.url)),
    );
    const body = { ...input(), resourceId: 'res_files', limit: 50 };
    const catalogResponse = await call(body);
    expect(catalogResponse.status).toBe(200);
    const catalog = type({
      data: {
        operations: type({
          id: 'string',
          execution: 'string',
          'registeredOperation?': {
            id: 'string',
            version: 'string',
            effect: 'string',
            resourceId: 'string',
          },
        }).array(),
      },
    }).assert(await catalogResponse.json());
    const registered = catalog.data.operations.filter((value) => value.execution === 'registered');
    expect(registered).toHaveLength(1);
    expect(registered[0].registeredOperation).toMatchObject({
      id: entry.operationId,
      effect: 'read',
      resourceId: 'res_files',
    });
    const descriptorResponse = await app.fetch(
      new Request('https://platform.test/app-billing/projects.resourceOperations', {
        method: 'POST',
        headers: request(input()).headers,
        body: JSON.stringify({
          project: project.id,
          owner: { person: 'person' },
          resourceId: 'res_files',
        }),
      }),
      env,
      createMockExecutionContext(),
    );
    const descriptors = type({
      data: { operations: type({ id: 'string', version: 'string' }).array() },
    }).assert(await descriptorResponse.json());
    expect(registered[0].registeredOperation?.version).toBe(
      descriptors.data.operations.find((value) => value.id === entry.operationId)?.version,
    );
    const schemaResponse = await call({ ...body, operationId: registered[0].id });
    expect(await schemaResponse.json()).toMatchObject({ data: { execution: 'discovery-only' } });
    const broad = await read(
      await call({ project: project.id, owner: { person: 'person' }, product: 'r2', limit: 50 }),
    );
    expect(broad.data.operations.every((value) => value.execution === 'discovery-only')).toBe(true);
    env.CF_API_TOKEN = '';
    const disconnected = await read(await call(body));
    expect(
      disconnected.data.operations.every((value) => value.execution === 'discovery-only'),
    ).toBe(true);
  });

  it('reads a pinned full operation document after ownership checks and rejects missing or corrupted assets', async () => {
    const path = '/accounts/{account_id}/hyperdrive/configs/{hyperdrive_id}';
    const operation = (await cloudflareCatalog()).operations.find(
      (entry) => entry.httpMethod === 'GET' && entry.path === path,
    );
    const schema = (await cloudflareOpenApiIndex()).find(
      (entry) => entry.method === 'GET' && entry.path === path,
    );
    if (!operation || !schema) {
      throw Error('Expected the pinned Hyperdrive operation.');
    }
    const key = cloudflareOpenApiKey(schema);
    await env.STATIC_ASSETS_R2.delete(key);
    const body = { ...input(), operationId: operation.id };
    expect((await call(body)).status).toBe(503);
    await env.STATIC_ASSETS_R2.put(
      key,
      await readFile(
        new URL('../fixtures/cloudflare-openapi/hyperdrive-get.json.gz', import.meta.url),
      ),
    );
    const response = await call(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        requestedOperationId: operation.id,
        execution: 'discovery-only',
        sha256: schema.sha256,
        source: { kind: 'cloudflare-openapi' },
        document: {
          openapi: '3.0.3',
          paths: { [path]: { get: { operationId: schema.operationId } } },
          components: { schemas: expect.any(Object) },
        },
      },
    });
    expect((await call({ ...body, schemaSha256: '0'.repeat(64) })).status).toBe(409);
    const alias = operation.aliases[0];
    expect(alias).toBeTruthy();
    expect(
      await (await call({ ...body, operationId: alias, schemaSha256: schema.sha256 })).json(),
    ).toMatchObject({ data: { requestedOperationId: alias, operationId: schema.operationId } });
    expect((await call({ ...body, project: foreign.id })).status).toBe(404);
    expect((await call({ ...body, resourceId: 'res_files' })).status).toBe(404);
    expect((await call(body, false)).status).toBe(401);
    await expect(
      cloudflareOperationSchema(env.STATIC_ASSETS_R2, { ...schema, bytes: 1 }),
    ).rejects.toThrow('pinned size');
    await env.STATIC_ASSETS_R2.put(key, new Uint8Array(schema.gzipBytes));
    expect((await call(body)).status).toBe(503);
    await env.STATIC_ASSETS_R2.delete(key);
  });
  it('joins the pinned real CLI catalog with the same executable capabilities as resource discovery', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    const { data } = await read(response);
    expect(data).toMatchObject({
      appId: project.id,
      available: true,
      reason: null,
      source: {
        kind: 'cloudflare-cli',
        cliVersion: '1.0.0-rc.2',
        generatedAt: 'build-time',
        sha256: 'd399ac23573b5ac40f0ae7ad1752a5be036429e239de176af85cde4693498f2d',
      },
      scope: { resourceId: 'res_connection', product: 'hyperdrive' },
      capabilities: [
        {
          id: 'res_connection',
          kind: 'other',
          actions: [],
        },
      ],
    });
    expect(data.operations).toHaveLength(2);
    expect(
      data.operations.every(
        (operation: { execution: string; command?: string }) =>
          operation.execution === 'discovery-only' &&
          operation.command?.startsWith('cf hyperdrive '),
      ),
    ).toBe(true);
    expect(JSON.stringify(data)).not.toContain('private-');

    const resourcesResponse = await app.fetch(
      new Request('https://platform.test/app-billing/projects.resources', {
        method: 'POST',
        headers: request(input()).headers,
        body: JSON.stringify(input()),
      }),
      env,
      createMockExecutionContext(),
    );

    const resourceData = resourcesSchema.assert(await resourcesResponse.json());
    expect(data.capabilities[0]).toEqual(
      resourceData.data.resources.find((entry: { id: string }) => entry.id === 'res_connection'),
    );
  });

  it('preserves baseline database actions and does not promote unsupported products to executable resources', async () => {
    env.PLATFORM_PROXY = {
      fetch: async () => {
        throw new Error('Discovery must not call the proxy');
      },
      connect: () => {
        throw new Error('Discovery must not open a socket');
      },
    };
    const response = await call({ ...input(), resourceId: 'res_database' });
    expect(response.status).toBe(200);
    const { data } = await read(response);
    expect(data.scope.product).toBe('d1');
    expect(data.capabilities[0].kind).toBe('database');
    expect(data.capabilities[0].actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'database.schema', effect: 'read' }),
        expect.objectContaining({ id: 'database.cell.save', effect: 'write' }),
      ]),
    );
    const inventory = await app.fetch(
      new Request('https://platform.test/app-billing/projects.resources', {
        method: 'POST',
        headers: request(input()).headers,
        body: JSON.stringify({ project: project.id, owner: { person: 'person' } }),
      }),
      env,
      createMockExecutionContext(),
    );
    const result = resourcesSchema.assert(await inventory.json());
    expect(data.capabilities[0]).toEqual(
      result.data.resources.find((entry) => entry.id === 'res_database'),
    );
    const connection = await read(await call());
    expect(connection.data.capabilities[0]).toMatchObject({ kind: 'other', actions: [] });
  });

  it('pages all matching metadata without duplicates and binds cursors to resource and product', async () => {
    const ids = new Set<string>();
    let cursor: string | undefined;
    let firstCursor = '';

    do {
      const response = await call({ ...input(), cursor });
      expect(response.status).toBe(200);
      const { data } = await read(response);
      expect(data.operations.length).toBeLessThanOrEqual(2);

      for (const operation of data.operations) {
        expect(ids.has(operation.id)).toBe(false);
        ids.add(operation.id);
      }

      cursor = data.nextCursor ?? undefined;
      firstCursor ||= cursor ?? '';
    } while (cursor);

    expect(ids.size).toBe(8);
    expect((await call({ ...input(), resourceId: 'res_files', cursor: firstCursor })).status).toBe(
      400,
    );
    expect((await call({ ...input(), cursor: firstCursor + '9' })).status).toBe(400);
  });

  it('offers broader product metadata without inventing executable tenant resources', async () => {
    const response = await call({
      project: project.id,
      owner: { person: 'person' },
      product: 'vectorize',
      limit: 50,
    });

    const { data } = await read(response);
    expect(response.status).toBe(200);
    expect(data.scope).toMatchObject({ resourceId: null, product: 'vectorize' });
    expect(data.operations).toHaveLength(24);
    expect(data.capabilities).toEqual([]);
    expect(data.products).toEqual([]);
    const inventory = await call({ project: project.id, owner: { person: 'person' } });
    const inventoryData = await read(inventory);
    expect(inventoryData.data.products.length).toBeGreaterThan(100);
    expect(inventoryData.data.operations).toEqual([]);
  });

  it('rejects unauthenticated, foreign project, foreign owner and foreign resource discovery', async () => {
    expect((await call(input(), false)).status).toBe(401);
    expect((await call({ ...input(), project: foreign.id })).status).toBe(404);
    expect((await call({ ...input(), owner: { person: 'someone-else' } })).status).toBe(404);
    expect((await call({ ...input(), resourceId: 'res_foreign' })).status).toBe(404);
  });

  it.each([
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { cursor: 'made-up' },
    { product: 'r2' },
    { account_id: 'other-account' },
    { path: '/accounts/other' },
    { owner: { person: 'person', group: 'other' } },
  ])('rejects invalid scope or paging %j', async (change) => {
    expect((await call({ ...input(), ...change })).status).toBe(400);
  });

  it('keeps metadata available when provider credentials are missing without inventing an action', async () => {
    const response = await app.fetch(
      request(input()),
      { ...env, CF_API_TOKEN: '' },
      createMockExecutionContext(),
    );

    const { data } = await read(response);
    expect(data.available).toBe(true);
    expect(data.operations).toHaveLength(2);
    expect(data.capabilities[0].actions).toEqual([]);
  });

  it('rechecks ownership and resource identity after reading discovery inputs', async () => {
    const [owned] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    let resolutions = 0;

    const boundary = new Hono<ApiEnv>()
      .use('*', async (context, next) => {
        context.set('db', env.db);
        await next();
      })
      .route(
        '/app-billing',
        appRuntimeCatalogRoutes(async () => {
          resolutions++;

          return resolutions === 1 ? owned : null;
        }),
      );

    expect((await boundary.fetch(request(input()), env)).status).toBe(404);
    expect(resolutions).toBe(2);
  });

  it('rejects a resource replaced while its capabilities were being discovered', async () => {
    const [owned] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    let resolutions = 0;

    const boundary = new Hono<ApiEnv>()
      .use('*', async (context, next) => {
        context.set('db', env.db);
        await next();
      })
      .route(
        '/app-billing',
        appRuntimeCatalogRoutes(async () => {
          if (++resolutions === 2) {
            await env.db
              .update(resources)
              .set({ cf_id: 'replacement' })
              .where(eq(resources.id, 'res_connection'));
          }

          return owned;
        }),
      );

    expect((await boundary.fetch(request(input()), env)).status).toBe(409);
  });

  it('bounds project-wide executable descriptors and lets an omitted resource be selected directly', async () => {
    await env.db.insert(resources).values(
      Array.from({ length: 51 }, (_, index) => ({
        id: `res_extra_${index}`,
        project_id: project.id,
        type: 'hyperdrive' as const,
        cf_id: `private-extra-${index}`,
        binding_name: `EXTRA_${index}`,
      })),
    );

    const response = await call({
      project: project.id,
      owner: { person: 'person' },
      product: 'hyperdrive',
      limit: 1,
    });

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ data: { capabilitiesTruncated: true } });
    expect(dataSchema.assert(body).data.capabilities).toHaveLength(50);
    const selected = await call({ ...input(), resourceId: 'res_extra_50' });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({
      data: { capabilitiesTruncated: false, capabilities: [{ id: 'res_extra_50' }] },
    });
  });

  it('keeps active preview metadata separate from executable production actions and rejects expired previews', async () => {
    await env.db
      .update(projects)
      .set({
        preview_client_id: registration.client.id,
        preview_workspace_id: 'test-preview-workspace',
        slug: 'preview-catalog-test',
        preview_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .where(eq(projects.id, project.id));
    const response = await call();
    expect(response.status).toBe(200);
    expect((await read(response)).data.capabilities[0].actions).toEqual([]);
    await env.db
      .update(projects)
      .set({ preview_expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(projects.id, project.id));
    expect((await call()).status).toBe(404);
  });
});

describe('Durable Object discovery ownership', () => {
  const catalogSchema = type({
    data: {
      operations: type({
        id: 'string',
        execution: 'string',
        'registeredOperation?': {
          id: 'string',
          version: 'string',
          effect: 'string',
          resourceId: 'string',
        },
      }).array(),
    },
  });
  async function managed() {
    env.CF_ACCOUNT_ID = 'a'.repeat(32);
    const path = '/accounts/{account_id}/workers/durable_objects/namespaces/{id}/objects';
    const schema = (await cloudflareOpenApiIndex()).find(
      (entry) => entry.method === 'GET' && entry.path === path,
    );
    const operation = (await cloudflareCatalog()).operations.find(
      (entry) => entry.httpMethod === 'GET' && entry.path === path,
    );
    if (!schema || !operation) {
      throw Error('Missing pinned Durable Object operation');
    }
    await env.STATIC_ASSETS_R2.put(
      cloudflareOpenApiKey(schema),
      await readFile(
        new URL('../fixtures/cloudflare-openapi/durable-object-get.json.gz', import.meta.url),
      ),
    );
    const namespaceId = 'b'.repeat(32);
    const [current] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    const deploymentId = current.active_deployment_id;
    if (!deploymentId) {
      throw Error('Missing active test deployment');
    }
    const hostName = await durableObjectWorkerName(project.id, 'Room');
    const manifest = {
      durableObjects: {
        bindings: [{ bindingName: 'ROOMS', className: 'Room', storage: 'sqlite' }],
        runtime: { protocol: 1, namespaces: { Room: namespaceId } },
      },
    };
    await env.db
      .update(deployments)
      .set({ manifest: JSON.stringify(manifest) })
      .where(eq(deployments.id, deploymentId));
    const route = {
      projectId: project.id,
      userId: current.user_id,
      version: deploymentId,
      workerName: 'user-' + current.slug + '-' + deploymentId,
    };
    await env.ROUTING.put(current.slug, JSON.stringify(route));
    await env.db.insert(resources).values({
      id: 'res_rooms',
      project_id: project.id,
      type: 'durable-object',
      cf_id: hostName,
      binding_name: 'Room',
      metadata: { namespaceId, dispatchNamespace: 'platform-users' },
    });
    const appBindings: Array<unknown> = [
      { name: '__PROJECT_ID', type: 'plain_text', text: project.id },
      { name: 'ROOMS', type: 'durable_object_namespace', namespace_id: namespaceId },
    ];
    const hostBindings: Array<unknown> = [
      {
        name: '__PLATFORM_DURABLE_OWNER',
        type: 'plain_text',
        text: JSON.stringify({
          protocol: 1,
          projectId: project.id,
          dispatchNamespace: 'platform-users',
          className: 'Room',
        }),
      },
      { name: '__PLATFORM_DURABLE_DEPLOYMENT', type: 'plain_text', text: deploymentId },
      {
        name: 'SELF',
        type: 'durable_object_namespace',
        class_name: 'Room',
        namespace_id: namespaceId,
      },
    ];
    const host = vi.fn(async () => Response.json({ success: true, result: hostBindings }));
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      expect(
        url.startsWith('https://api.cloudflare.com/client/v4/accounts/' + env.CF_ACCOUNT_ID),
      ).toBe(true);
      if (url.endsWith('/scripts/' + route.workerName + '/bindings')) {
        return Response.json({ success: true, result: appBindings });
      }
      expect(url.endsWith('/scripts/' + hostName + '/bindings')).toBe(true);
      return host();
    });
    const body = { ...input(), resourceId: 'res_rooms', limit: 50 };
    return {
      body,
      namespaceId,
      hostName,
      schema,
      operation,
      host,
      provider,
      hostBindings,
      appBindings,
      deploymentId,
    };
  }

  it('advertises the same proven namespace operation and version as executable resource discovery', async () => {
    const fixture = await managed();
    const response = await call(fixture.body);
    expect(response.status).toBe(200);
    const catalog = catalogSchema.assert(await response.json());
    const entry = catalog.data.operations.find((item) => item.id === fixture.operation.id);
    expect(entry).toMatchObject({
      execution: 'registered',
      registeredOperation: {
        id: fixture.schema.operationId,
        effect: 'read',
        resourceId: 'res_rooms',
      },
    });
    expect(fixture.host).toHaveBeenCalledTimes(2);
    const descriptors = await app.fetch(
      new Request('https://platform.test/app-billing/projects.resourceOperations', {
        method: 'POST',
        headers: request(input()).headers,
        body: JSON.stringify({
          project: project.id,
          owner: { person: 'person' },
          resourceId: 'res_rooms',
        }),
      }),
      env,
      createMockExecutionContext(),
    );
    expect(descriptors.status).toBe(200);
    expect(await descriptors.json()).toMatchObject({
      data: {
        operations: [
          { id: fixture.schema.operationId, version: entry?.registeredOperation?.version },
        ],
      },
    });
    expect(JSON.stringify(catalog)).not.toContain(fixture.namespaceId);
    expect(JSON.stringify(catalog)).not.toContain(fixture.hostName);
    const calls = fixture.provider.mock.calls.length;
    const full = await call({ ...fixture.body, operationId: fixture.operation.id });
    expect(full.status).toBe(200);
    expect(await full.json()).toMatchObject({
      data: { execution: 'discovery-only', operationId: fixture.schema.operationId },
    });
    const broad = await read(
      await call({
        project: project.id,
        owner: { person: 'person' },
        product: 'durable-objects',
        limit: 50,
      }),
    );
    expect(broad.data.operations.every((entry) => entry.execution === 'discovery-only')).toBe(true);
    expect(fixture.provider).toHaveBeenCalledTimes(calls);
  });

  it.each(['stale-release', 'ambiguous-host', 'ambiguous-app', 'foreign-owner', 'missing-schema'])(
    'keeps %s evidence discovery-only',
    async (failure) => {
      const fixture = await managed();
      if (failure === 'stale-release') {
        fixture.hostBindings[1] = {
          name: '__PLATFORM_DURABLE_DEPLOYMENT',
          type: 'plain_text',
          text: 'old-release',
        };
      }
      if (failure === 'ambiguous-host') {
        fixture.hostBindings.push({
          name: 'ALIAS',
          type: 'durable_object_namespace',
          class_name: 'Room',
          namespace_id: fixture.namespaceId,
        });
      }
      if (failure === 'ambiguous-app') {
        fixture.appBindings.push({
          name: 'ALIAS',
          type: 'durable_object_namespace',
          namespace_id: fixture.namespaceId,
        });
      }
      if (failure === 'foreign-owner') {
        fixture.hostBindings[0] = {
          name: '__PLATFORM_DURABLE_OWNER',
          type: 'plain_text',
          text: 'foreign-project',
        };
      }
      if (failure === 'missing-schema') {
        await env.STATIC_ASSETS_R2.delete(cloudflareOpenApiKey(fixture.schema));
      }
      const response = await call(fixture.body);
      expect(response.status).toBe(200);
      expect(
        (await read(response)).data.operations.every(
          (entry) => entry.execution === 'discovery-only',
        ),
      ).toBe(true);
    },
  );

  it.each(['namespace', 'dispatch', 'manifest', 'host-release', 'host-ambiguity'])(
    'discards a registered hint when %s changes during final ownership verification',
    async (change) => {
      const fixture = await managed();
      fixture.host.mockImplementation(async () => {
        if (fixture.host.mock.calls.length === 2) {
          if (change === 'namespace' || change === 'dispatch') {
            await env.db
              .update(resources)
              .set({
                metadata: {
                  namespaceId: change === 'namespace' ? 'c'.repeat(32) : fixture.namespaceId,
                  dispatchNamespace: change === 'dispatch' ? 'other' : 'platform-users',
                },
              })
              .where(eq(resources.id, 'res_rooms'));
          }
          if (change === 'manifest') {
            await env.db
              .update(deployments)
              .set({ manifest: '{}' })
              .where(eq(deployments.id, fixture.deploymentId));
          }
          if (change === 'host-release') {
            fixture.hostBindings[1] = {
              name: '__PLATFORM_DURABLE_DEPLOYMENT',
              type: 'plain_text',
              text: 'changed-release',
            };
          }
          if (change === 'host-ambiguity') {
            fixture.hostBindings.push({
              name: 'ALIAS',
              type: 'durable_object_namespace',
              class_name: 'Room',
              namespace_id: fixture.namespaceId,
            });
          }
        }
        return Response.json({ success: true, result: fixture.hostBindings });
      });
      const response = await call(fixture.body);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'resource_changed' });
    },
  );

  it('does not accept a caller namespace override or a foreign owned-resource selection', async () => {
    const fixture = await managed();
    expect((await call({ ...fixture.body, namespaceId: fixture.namespaceId })).status).toBe(400);
    expect((await call({ ...fixture.body, resourceId: 'res_foreign' })).status).toBe(404);
    expect(fixture.provider).not.toHaveBeenCalled();
  });
});

it('searches API-only summaries and reads their complete schemas without an executable policy', async () => {
  const entry = (await cloudflareOpenApiIndex()).find(
    (value) => value.method === 'GET' && value.path === '/accounts/{account_id}/access/apps',
  );
  if (!entry) {
    throw Error('Missing API-only fixture');
  }
  await env.STATIC_ASSETS_R2.put(
    cloudflareOpenApiKey(entry),
    await readFile(new URL('../fixtures/cloudflare-openapi/access-list.json.gz', import.meta.url)),
  );
  const body = {
    project: project.id,
    owner: { person: 'person' },
    query: entry.operationId,
    method: 'GET',
    limit: 5,
  };
  const response = await call(body);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: {
      operations: expect.arrayContaining([
        expect.objectContaining({
          id: entry.operationId,
          execution: 'discovery-only',
          unavailableReason: 'resource_not_selected',
          aliases: [],
        }),
      ]),
    },
  });
  expect(
    await (
      await call({ ...body, operationId: entry.operationId, schemaSha256: entry.sha256 })
    ).json(),
  ).toMatchObject({
    data: { operationId: entry.operationId, sha256: entry.sha256, execution: 'discovery-only' },
  });
  expect(
    (await call({ ...body, operationId: entry.operationId, resourceId: 'res_files' })).status,
  ).toBe(404);
});
it('distinguishes absent policy, missing schema and missing installation configuration', async () => {
  const body = { ...input(), resourceId: 'res_files', limit: 50 };
  const entry = (await cloudflareOpenApiIndex()).find(
    (value) =>
      value.method === 'GET' && value.path === '/accounts/{account_id}/r2/buckets/{bucket_name}',
  );
  if (!entry) {
    throw Error('Missing R2 schema');
  }
  env.CF_ACCOUNT_ID = 'a'.repeat(32);
  await env.STATIC_ASSETS_R2.delete(cloudflareOpenApiKey(entry));
  expect(await (await call({ ...body, query: entry.operationId })).json()).toMatchObject({
    data: {
      operations: expect.arrayContaining([
        expect.objectContaining({ id: entry.operationId, unavailableReason: 'schema_unavailable' }),
      ]),
    },
  });
  env.CF_API_TOKEN = '';
  expect(await (await call({ ...body, query: entry.operationId })).json()).toMatchObject({
    data: {
      operations: expect.arrayContaining([
        expect.objectContaining({
          id: entry.operationId,
          unavailableReason: 'installation_not_configured',
        }),
      ]),
    },
  });
  expect(
    await (await call({ ...body, method: 'DELETE', query: '/r2/buckets' })).json(),
  ).toMatchObject({
    data: {
      operations: expect.arrayContaining([
        expect.objectContaining({ unavailableReason: 'policy_not_installed' }),
      ]),
    },
  });
});

it('allows API-derived product names that are absent from the CLI', async () => {
  const response = await call({
    project: project.id,
    owner: { person: 'person' },
    product: 'api_gateway',
    limit: 1,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: {
      scope: { product: 'api_gateway' },
      operations: [
        expect.objectContaining({ product: 'api_gateway', execution: 'discovery-only' }),
      ],
    },
  });
});

describe('project Access ownership references', () => {
  const applicationId = 'private-project-access-id';
  const inventorySchema = type({
    data: { resources: type({ id: 'string', name: 'string', kind: 'string' }).array() },
  });
  const configuration = () => ({
    version: 1,
    revision: 1,
    enabled: true,
    protectNewProjects: true,
    accountId: env.CF_ACCOUNT_ID,
    teamDomain: 'https://company.cloudflareaccess.com',
    identityProviderIds: ['private-idp'],
    policyIds: ['private-policy'],
    credential: { ciphertext: 'private-encrypted-token', iv: 'unused', keyVersion: 'v1' },
    wildcardApplicationName: 'private-installation-access',
    wildcardApplication: {
      id: 'private-wildcard-id',
      name: 'private-installation-access',
      audience: 'private-audience',
      destinations: ['*.example.com'],
    },
    operation: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  });
  const route = (path: string, body: object) => {
    const original = request(body);
    return app.fetch(new Request('https://platform.test/app-billing/' + path, original), env);
  };
  async function seed() {
    await env.db.insert(platformSettings).values({
      key: 'zeroTrust.configuration',
      value: configuration(),
    });
    await env.db.insert(projectZeroTrust).values({
      project_id: project.id,
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
      protected_application_id: applicationId,
      protected_application_name: 'private-project-access-name',
      protected_application_audience: 'private-project-audience',
      reconciled_operation: 'private-reconcile-generation',
    });
  }
  async function inventory() {
    const response = await route('projects.resources', {
      project: project.id,
      owner: { person: 'person' },
    });
    expect(response.status).toBe(200);
    return inventorySchema.assert(await response.json()).data.resources;
  }
  async function selected() {
    const resource = (await inventory()).find((entry) => entry.name === 'Project access');
    expect(resource).toBeDefined();
    if (!resource) {
      throw Error('Missing project access inventory reference');
    }
    return { ...input(), resourceId: resource.id };
  }

  it('discovers a new owned family with opaque identity and no invented executable operations', async () => {
    await seed();
    const body = await selected();
    expect(body.resourceId).toMatch(/^ref_[a-f0-9]{64}$/);
    const response = await call(body);
    expect(response.status).toBe(200);
    const discovery = await read(response);
    expect(discovery.data.scope).toMatchObject({ resourceId: body.resourceId, product: 'access' });
    expect(discovery.data.operations.length).toBeGreaterThan(0);
    expect(discovery.data.operations.every((entry) => entry.execution === 'discovery-only')).toBe(
      true,
    );
    expect(discovery.data.capabilities).toEqual([
      expect.objectContaining({ id: body.resourceId, kind: 'other', actions: [] }),
    ]);
    const publicData = JSON.stringify({ inventory: await inventory(), discovery });
    for (const privateValue of [
      applicationId,
      'private-project-access-name',
      'private-audience',
      'private-policy',
      'private-idp',
      'private-encrypted-token',
      'private-reconcile-generation',
    ]) {
      expect(publicData).not.toContain(privateValue);
    }
    const selection = { project: body.project, owner: body.owner, resourceId: body.resourceId };
    const installed = await route('projects.resourceOperations', selection);
    expect(installed.status).toBe(200);
    expect(await installed.json()).toMatchObject({ data: { available: false, operations: [] } });
    const invoked = await route('resources.invoke', {
      ...selection,
      operation: discovery.data.operations[0].id,
      version: 'a'.repeat(64),
      expectedEffect: 'read',
      input: {},
    });
    expect(invoked.status).toBe(404);
    expect(await invoked.json()).toEqual({ error: 'operation_unavailable' });
    expect((await call({ ...body, project: foreign.id })).status).toBe(404);
    expect((await call({ ...body, resourceId: applicationId })).status).toBe(404);
  });

  it('keeps saved reference identity stable across a provider replacement, scoped to the installation', async () => {
    await seed();
    const body = await selected();
    await env.db
      .update(projectZeroTrust)
      .set({ protected_application_id: 'replacement-id' })
      .where(eq(projectZeroTrust.project_id, project.id));
    expect((await selected()).resourceId).toBe(body.resourceId);
    const prior = env.PLATFORM_INSTALLATION_ID;
    env.PLATFORM_INSTALLATION_ID = 'different-installation';
    try {
      expect((await selected()).resourceId).not.toBe(body.resourceId);
      expect((await call(body)).status).toBe(404);
    } finally {
      env.PLATFORM_INSTALLATION_ID = prior;
    }
  });

  it('exposes the separately owned public application without its provider identity', async () => {
    await seed();
    await env.db
      .update(projectZeroTrust)
      .set({
        bypass_application_id: 'private-bypass-id',
        bypass_application_name: 'private-bypass-name',
      })
      .where(eq(projectZeroTrust.project_id, project.id));
    const applications = (await inventory()).filter((entry) => entry.id.startsWith('ref_'));
    expect(applications.map((entry) => entry.name)).toEqual(['Project access', 'Public access']);
    expect(new Set(applications.map((entry) => entry.id)).size).toBe(2);
    expect(JSON.stringify(applications)).not.toContain('private-bypass');
  });

  it.each(['projects.resourceOperations', 'resources.invoke'])(
    'rechecks late revocation at %s',
    async (path) => {
      await seed();
      const body = await selected();
      const [owned] = await env.db.select().from(projects).where(eq(projects.id, project.id));
      let resolutions = 0;
      const boundary = new Hono<ApiEnv>()
        .use('*', async (context, next) => {
          context.set('db', env.db);
          await next();
        })
        .route(
          '/app-billing',
          appRuntimeOperationRoutes(async () => {
            if (++resolutions === 2) {
              await env.db
                .delete(projectZeroTrust)
                .where(eq(projectZeroTrust.project_id, project.id));
            }
            return owned;
          }),
        );
      const response = await boundary.fetch(
        new Request(
          'https://platform.test/app-billing/' + path,
          request({
            project: body.project,
            owner: body.owner,
            resourceId: body.resourceId,
            ...(path === 'resources.invoke'
              ? {
                  operation: 'unregistered-access-read',
                  version: 'a'.repeat(64),
                  expectedEffect: 'read',
                  input: {},
                }
              : {}),
          }),
        ),
        env,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'resource_changed' });
    },
  );

  it.each(['reconciling', 'error'] as const)('withholds %s project records', async (status) => {
    await seed();
    const body = await selected();
    await env.db
      .update(projectZeroTrust)
      .set({ status })
      .where(eq(projectZeroTrust.project_id, project.id));
    expect((await inventory()).some((entry) => entry.id === body.resourceId)).toBe(false);
    expect((await call(body)).status).toBe(404);
  });

  it('withholds unreconciled, missing and ambiguous project ownership', async () => {
    await seed();
    const body = await selected();
    await env.db
      .update(projectZeroTrust)
      .set({ reconciled_operation: null })
      .where(eq(projectZeroTrust.project_id, project.id));
    expect((await call(body)).status).toBe(404);
    await env.db
      .update(projectZeroTrust)
      .set({ reconciled_operation: 'settled' })
      .where(eq(projectZeroTrust.project_id, project.id));
    await env.db
      .insert(projectZeroTrust)
      .values({ project_id: foreign.id, protected_application_id: applicationId });
    expect((await call(body)).status).toBe(404);
    await env.db.delete(projectZeroTrust).where(eq(projectZeroTrust.project_id, foreign.id));
    await env.db.delete(projectZeroTrust).where(eq(projectZeroTrust.project_id, project.id));
    expect((await call(body)).status).toBe(404);
  });

  it('does not turn shared installation applications or duplicate local roles into project resources', async () => {
    await seed();
    const body = await selected();
    for (const protected_application_id of ['private-wildcard-id', applicationId]) {
      await env.db
        .update(projectZeroTrust)
        .set({
          protected_application_id,
          bypass_application_id: protected_application_id === applicationId ? applicationId : null,
          bypass_application_name: 'private-bypass-name',
        })
        .where(eq(projectZeroTrust.project_id, project.id));
      expect((await call(body)).status).toBe(404);
    }
  });

  it.each(['application', 'generation', 'configuration', 'revocation'] as const)(
    'rejects late %s changes without publishing a stale capability',
    async (change) => {
      await seed();
      const body = await selected();
      const [owned] = await env.db.select().from(projects).where(eq(projects.id, project.id));
      let resolutions = 0;
      const boundary = new Hono<ApiEnv>()
        .use('*', async (context, next) => {
          context.set('db', env.db);
          await next();
        })
        .route(
          '/app-billing',
          appRuntimeCatalogRoutes(async () => {
            if (++resolutions === 2) {
              if (change === 'configuration') {
                await env.db
                  .update(platformSettings)
                  .set({ value: { ...configuration(), revision: 2 } })
                  .where(eq(platformSettings.key, 'zeroTrust.configuration'));
              } else if (change === 'revocation') {
                await env.db
                  .delete(projectZeroTrust)
                  .where(eq(projectZeroTrust.project_id, project.id));
              } else {
                await env.db
                  .update(projectZeroTrust)
                  .set(
                    change === 'application'
                      ? { protected_application_id: 'replacement-application' }
                      : { reconciled_operation: 'replacement-generation' },
                  )
                  .where(eq(projectZeroTrust.project_id, project.id));
              }
            }
            return owned;
          }),
        );
      const response = await boundary.fetch(request(body), env);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'resource_changed' });
    },
  );

  it('withholds disabled, malformed and reconciling installation configuration', async () => {
    await seed();
    const body = await selected();
    for (const value of [
      { ...configuration(), enabled: false },
      { ...configuration(), lastError: 'configuration failed' },
      {
        ...configuration(),
        operation: {
          id: 'pending-operation',
          kind: 'reconcile',
          phase: 'projects',
          owner: null,
          leaseExpiresAt: null,
          startedAt: new Date().toISOString(),
          existingProjects: null,
        },
      },
      { version: 'invalid' },
    ]) {
      await env.db
        .update(platformSettings)
        .set({ value })
        .where(eq(platformSettings.key, 'zeroTrust.configuration'));
      expect((await call(body)).status).toBe(404);
    }
  });
  describe('projected Access application reads', () => {
    const ownedApplicationId = '11111111-1111-4111-8111-111111111111';
    const descriptorSchema = type({
      data: { operations: type({ id: 'string', version: 'string', effect: "'read'" }).array() },
    });
    async function prepared() {
      env.CF_ACCOUNT_ID = 'a'.repeat(32);
      await seed();
      await env.db
        .update(projectZeroTrust)
        .set({ protected_application_id: ownedApplicationId })
        .where(eq(projectZeroTrust.project_id, project.id));
      const entry = (await cloudflareOpenApiIndex()).find(
        (entry) => entry.operationId === 'access-applications-get-an-access-application',
      );
      if (!entry) {
        throw Error('Missing pinned Access application operation');
      }
      await env.STATIC_ASSETS_R2.put(
        cloudflareOpenApiKey(entry),
        await readFile(
          new URL('../fixtures/cloudflare-openapi/access-get.json.gz', import.meta.url),
        ),
      );
      const selectedResource = await selected();
      const selection = {
        project: selectedResource.project,
        owner: selectedResource.owner,
        resourceId: selectedResource.resourceId,
      };
      const installed = await route('projects.resourceOperations', selection);
      expect(installed.status).toBe(200);
      const [descriptor] = descriptorSchema.assert(await installed.json()).data.operations;
      expect(descriptor.id).toBe(entry.operationId);
      const response = {
        id: ownedApplicationId,
        name: 'private-project-access-name',
        type: 'self_hosted',
        domain: 'private.example.com',
        session_duration: '24h',
        aud: 'private-audience',
        policies: [{ id: 'private-policy' }],
        allowed_idps: ['private-idp'],
      };
      return {
        entry,
        selection,
        descriptor,
        response,
        invocation: {
          ...selection,
          operation: descriptor.id,
          version: descriptor.version,
          expectedEffect: descriptor.effect,
          input: {},
        },
      };
    }
    afterEach(async () => {
      const entry = (await cloudflareOpenApiIndex()).find(
        (entry) => entry.operationId === 'access-applications-get-an-access-application',
      );
      if (entry) {
        await env.STATIC_ASSETS_R2.delete(cloudflareOpenApiKey(entry));
      }
    });

    it('advertises the pinned owned read and runs a saved descriptor without exposing private provider fields', async () => {
      const fixture = await prepared();
      const provider = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () =>
          Response.json({ success: true, errors: [], messages: [], result: fixture.response }),
        );
      const discovery = await read(
        await call({ ...fixture.selection, query: fixture.descriptor.id }),
      );
      expect(
        discovery.data.operations.filter((operation) => operation.execution === 'registered'),
      ).toEqual([expect.objectContaining({ id: fixture.descriptor.id, execution: 'registered' })]);
      expect(
        discovery.data.operations.find((operation) => operation.id.startsWith('zone-level-')),
      ).toMatchObject({ execution: 'discovery-only' });
      const invoked = await route('resources.invoke', fixture.invocation);
      expect(invoked.status).toBe(200);
      expect(await invoked.json()).toEqual({
        data: {
          appId: project.id,
          resourceId: fixture.selection.resourceId,
          action: fixture.descriptor.id,
          kind: 'provider-read',
          data: { name: 'Project access', type: 'self_hosted', session_duration: '24h' },
        },
      });
      expect(provider).toHaveBeenCalledTimes(1);
      expect(String(provider.mock.calls[0][0])).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/apps/${ownedApplicationId}`,
      );
      expect(
        (await route('resources.invoke', { ...fixture.invocation, resourceId: ownedApplicationId }))
          .status,
      ).toBe(404);
      expect(
        (
          await route('resources.invoke', {
            ...fixture.invocation,
            input: { app_id: ownedApplicationId },
          })
        ).status,
      ).toBe(400);
      expect(
        (await route('resources.invoke', { ...fixture.invocation, version: 'f'.repeat(64) }))
          .status,
      ).toBe(409);
      expect(
        (await route('resources.invoke', { ...fixture.invocation, expectedEffect: 'write' }))
          .status,
      ).toBe(400);
      expect(provider).toHaveBeenCalledTimes(1);
    });

    it.each(['application', 'generation', 'account', 'revocation'] as const)(
      'rejects late %s proof changes after the provider read',
      async (change) => {
        const fixture = await prepared();
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
          if (change === 'account') {
            await env.db
              .update(platformSettings)
              .set({ value: { ...configuration(), revision: 2, accountId: 'b'.repeat(32) } })
              .where(eq(platformSettings.key, 'zeroTrust.configuration'));
          } else if (change === 'revocation') {
            await env.db
              .delete(projectZeroTrust)
              .where(eq(projectZeroTrust.project_id, project.id));
          } else {
            await env.db
              .update(projectZeroTrust)
              .set(
                change === 'application'
                  ? { protected_application_id: 'replacement-application' }
                  : { reconciled_operation: 'replacement-generation' },
              )
              .where(eq(projectZeroTrust.project_id, project.id));
          }
          return Response.json({
            success: true,
            errors: [],
            messages: [],
            result: fixture.response,
          });
        });
        const response = await route('resources.invoke', fixture.invocation);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: 'RESOURCE_CHANGED',
          message: 'This resource changed. Refresh before continuing.',
        });
      },
    );
  });
});
