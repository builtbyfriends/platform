import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { type } from 'arktype';
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
import { registerOAuthClient } from '../../src/auth/oauth.ts';
import app from '../../src/index.ts';
import {
  cloudflareOpenApiIndex,
  cloudflareOpenApiKey,
} from '../../src/infrastructure/cloudflare-openapi.ts';
import { cloudflareProviderReadSelections } from '../../src/infrastructure/cloudflare-provider-read.ts';
import { durableObjectWorkerName } from '../../src/provisioning/durable-objects.ts';
import { deployments, projects, resources, users } from '../../src/schema.ts';
import {
  clearTables,
  createMockExecutionContext,
  createTestProject,
  createTestDeployment,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv & { PLATFORM_PROXY?: Fetcher };
let registration: Awaited<ReturnType<typeof registerOAuthClient>>;
let project: { id: string };
let other: { id: string };
let ownerId: string;
const proxy = vi.fn<(request: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const auth = () => 'Basic ' + btoa(registration.client.id + ':' + registration.clientSecret);
const scope = () => ({ project: project.id, owner: { person: 'person' }, resourceId: 'res_files' });
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- These requests test malformed JSON boundaries.
const call = (path: string, body: unknown, authorization = auth()) =>
  app.fetch(
    new Request(`https://platform.test/app-billing/${path}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    createMockExecutionContext(),
  );
const descriptorSchema = type({
  id: 'string',
  version: 'string',
  effect: "'read' | 'write'",
  inputSchema: 'unknown',
  outputSchema: 'unknown',
});
const catalogSchema = type({ data: { operations: descriptorSchema.array() } });
async function catalog() {
  const response = await call('projects.resourceOperations', scope());
  expect(response.status).toBe(200);
  return catalogSchema.assert(await response.json()).data.operations;
}
async function invocation(operation = 'files.readText') {
  const descriptor = (await catalog()).find((entry) => entry.id === operation);
  if (!descriptor) {
    throw Error('Missing registered operation');
  }
  return {
    ...scope(),
    operation,
    version: descriptor.version,
    expectedEffect: descriptor.effect,
    ...(descriptor.effect === 'write' ? { confirmation: 'reviewed' } : {}),
    input:
      descriptor.effect === 'write'
        ? { key: 'note.txt', text: 'Changed', expectedEtag: 'opened' }
        : { key: 'note.txt' },
  };
}
function file(content = 'Hello', etag = 'opened') {
  return new Response(content, {
    headers: {
      'content-type': 'text/plain',
      etag: `"${etag}"`,
      'x-platform-r2-object': encodeURIComponent(
        JSON.stringify({
          key: 'note.txt',
          etag,
          size: new TextEncoder().encode(content).length,
          httpMetadata: { contentType: 'text/plain' },
          customMetadata: { author: 'owner' },
        }),
      ),
    },
  });
}

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
afterEach(() => vi.restoreAllMocks());
afterEach(async () => {
  for (const entry of await cloudflareOpenApiIndex()) {
    if (
      [
        'r2-get-bucket-public-policy',
        'r2-get-bucket-cors-policy',
        'r2-put-bucket-cors-policy',
        "workers-kv-namespace-list-a-namespace'-s-keys",
        'queues-list-consumers',
        'r2-list-custom-domains',
      ].includes(entry.operationId)
    ) {
      await env.STATIC_ASSETS_R2.delete(cloudflareOpenApiKey(entry));
    }
  }
});
beforeEach(async () => {
  await clearTables(env.db);
  registration = await registerOAuthClient(env.db, {
    name: 'Operations test',
    operator: 'Test',
    redirectUris: ['https://app.test/callback'],
    scopes: ['profile'],
  });
  const owner = await createTestUser(env.db, 'owner', 'app:' + registration.client.id, 'person');
  ownerId = owner.id;
  project = await createTestProject(env.db, owner.id);
  const stranger = await createTestUser(env.db, 'other');
  other = await createTestProject(env.db, stranger.id);
  await env.db.insert(resources).values([
    {
      id: 'res_files',
      project_id: project.id,
      type: 'r2',
      cf_id: 'private-bucket',
      binding_name: 'FILES',
    },
    {
      id: 'res_database',
      project_id: project.id,
      type: 'd1',
      cf_id: 'private-db',
      binding_name: 'DB',
    },
    {
      id: 'res_foreign',
      project_id: other.id,
      type: 'r2',
      cf_id: 'private-other',
      binding_name: 'FILES',
    },
    {
      id: 'res_keys',
      project_id: project.id,
      type: 'kv',
      cf_id: 'private-keys',
      binding_name: 'KEYS',
    },
  ]);
  proxy.mockReset();
  env.PLATFORM_PROXY = {
    fetch: proxy,
    connect: () => {
      throw Error('Unexpected socket');
    },
  };
  delete env.DEV_AUTH_BYPASS;
  env.CF_ACCOUNT_ID = 'test-account-id';
  env.CF_API_TOKEN = 'test-cf-token';
});

async function providerResource(kind: 'd1' | 'r2' | 'kv' | 'queue' | 'hyperdrive') {
  const selected = cloudflareProviderReadSelections(kind)[0];
  const entry = (await cloudflareOpenApiIndex()).find(
    (candidate) => candidate.method === selected?.method && candidate.path === selected.path,
  );
  if (!entry) {
    throw Error('Missing pinned provider operation');
  }
  const key = cloudflareOpenApiKey(entry);
  const asset = await readFile(
    new URL(`../fixtures/cloudflare-openapi/${kind}-get.json.gz`, import.meta.url),
  );
  await env.STATIC_ASSETS_R2.put(key, asset);
  env.CF_ACCOUNT_ID = 'a'.repeat(32);
  const cfId =
    kind === 'r2'
      ? 'owned-bucket'
      : kind === 'd1'
        ? '11111111-1111-4111-8111-111111111111'
        : 'b'.repeat(32);
  const resourceId = 'res_provider';
  await env.db.insert(resources).values({
    id: resourceId,
    project_id: project.id,
    type: kind,
    cf_id: cfId,
    binding_name: 'My resource',
    metadata: kind === 'r2' ? { jurisdiction: 'eu' } : {},
  });
  const selection = { ...scope(), resourceId };
  const response = await call('projects.resourceOperations', selection);
  expect(response.status).toBe(200);
  const descriptor = catalogSchema
    .assert(await response.json())
    .data.operations.find((operation) => operation.id === entry.operationId);
  if (!descriptor) {
    throw Error('Provider operation was not registered');
  }
  const body = {
    ...selection,
    operation: descriptor.id,
    version: descriptor.version,
    expectedEffect: 'read',
    input: {},
  };
  const data =
    kind === 'r2'
      ? { name: cfId, jurisdiction: 'eu', storage_class: 'Standard' }
      : kind === 'd1'
        ? { uuid: cfId, name: 'private-name', num_tables: 3 }
        : kind === 'kv'
          ? { id: cfId, title: 'private-name', supports_url_encoding: true }
          : kind === 'hyperdrive'
            ? {
                id: cfId,
                name: 'private-name',
                origin: {
                  host: 'private-database.example.com',
                  port: 5432,
                  scheme: 'postgres',
                  user: 'private-user',
                  database: 'private-database',
                },
                caching: { disabled: false, max_age: 120, stale_while_revalidate: 30 },
                origin_connection_limit: 20,
              }
            : { queue_id: cfId, queue_name: 'private-name', consumers_total_count: 2 };
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({
      success: true,
      errors: [],
      messages: [],
      result: { ...data, secret: 'private-provider-secret' },
    }),
  );
  return { entry, key, asset, body, descriptor, provider, cfId, data };
}

async function managedDomainResource() {
  const metadata = await providerResource('r2');
  const entry = (await cloudflareOpenApiIndex()).find(
    (candidate) => candidate.operationId === 'r2-get-bucket-public-policy',
  );
  if (!entry) {
    throw Error('Missing pinned managed-domain operation');
  }
  const key = cloudflareOpenApiKey(entry);
  const asset = await readFile(
    new URL('../fixtures/cloudflare-openapi/r2-managed-domain-get.json.gz', import.meta.url),
  );
  await env.STATIC_ASSETS_R2.put(key, asset);
  const data = {
    bucketId: 'c'.repeat(32),
    domain: 'pub-' + 'c'.repeat(32) + '.r2.dev',
    enabled: false,
  };
  metadata.provider.mockImplementation(async (url) =>
    Response.json({
      success: true,
      errors: [],
      messages: [],
      result: String(url).endsWith('/domains/managed') ? data : metadata.data,
    }),
  );
  const list = async () => {
    const response = await call('projects.resourceOperations', {
      ...scope(),
      resourceId: metadata.body.resourceId,
    });
    expect(response.status).toBe(200);
    return catalogSchema.assert(await response.json()).data.operations;
  };
  const operations = await list();
  const descriptor = operations.find((operation) => operation.id === entry.operationId);
  if (!descriptor) {
    throw Error('Managed-domain operation was not registered');
  }
  const body = { ...metadata.body, operation: descriptor.id, version: descriptor.version };
  return { metadata, entry, key, asset, data, body, descriptor, operations, list };
}

async function corsResource() {
  const fixture = await managedDomainResource();
  const entry = (await cloudflareOpenApiIndex()).find(
    (candidate) => candidate.operationId === 'r2-get-bucket-cors-policy',
  );
  if (!entry) {
    throw Error('Missing pinned CORS operation');
  }
  await env.STATIC_ASSETS_R2.put(
    cloudflareOpenApiKey(entry),
    await readFile(new URL('../fixtures/cloudflare-openapi/r2-cors-get.json.gz', import.meta.url)),
  );
  const rules = [
    { allowed: { methods: ['GET'], origins: ['https://example.test'] }, maxAgeSeconds: 0 },
  ];
  fixture.metadata.provider.mockImplementation(async () =>
    Response.json({
      success: true,
      errors: [],
      messages: [],
      result: { rules, privateToken: 'private' },
    }),
  );
  const operations = await fixture.list();
  const descriptor = operations.find((operation) => operation.id === entry.operationId);
  if (!descriptor) {
    throw Error('CORS operation was not registered');
  }
  return {
    fixture,
    rules,
    operations,
    descriptor,
    body: { ...fixture.body, operation: descriptor.id, version: descriptor.version },
  };
}

async function corsWriteResource() {
  const fixture = await corsResource();
  const entry = (await cloudflareOpenApiIndex()).find(
    (candidate) => candidate.operationId === 'r2-put-bucket-cors-policy',
  );
  if (!entry) {
    throw Error('Missing pinned CORS write');
  }
  await env.STATIC_ASSETS_R2.put(
    cloudflareOpenApiKey(entry),
    await readFile(new URL('../fixtures/cloudflare-openapi/r2-cors-put.json.gz', import.meta.url)),
  );
  const descriptor = (await fixture.fixture.list()).find(
    (candidate) => candidate.id === entry.operationId,
  );
  if (!descriptor) {
    throw Error('Missing CORS write descriptor');
  }
  const input = { body: { rules: [] }, expected: { rules: fixture.rules } };
  const request = {
    ...fixture.body,
    operation: descriptor.id,
    version: descriptor.version,
    expectedEffect: 'write',
    confirmation: 'reviewed',
    input,
  };
  return { ...fixture, descriptor, request, provider: fixture.fixture.metadata.provider, entry };
}

describe('reviewed schema-backed configuration writes', () => {
  it('discovers nested editable inputs and applies only the reviewed scoped replacement', async () => {
    const { descriptor, request, provider, rules } = await corsWriteResource();
    expect(descriptor.effect).toBe('write');
    expect(descriptor.inputSchema).toMatchObject({
      required: ['body', 'expected'],
      properties: { body: { required: ['rules'] } },
    });
    provider
      .mockResolvedValueOnce(
        Response.json({ success: true, errors: [], messages: [], result: { rules } }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, errors: [], messages: [], result: {} }))
      .mockResolvedValueOnce(
        Response.json({ success: true, errors: [], messages: [], result: { rules: [] } }),
      );
    const response = await call('resources.invoke', request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { kind: 'provider-write', data: { name: 'My resource', rules: [] } },
    });
    expect(provider.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(String(provider.mock.calls[1][0])).toContain('/r2/buckets/owned-bucket/cors');
    expect(JSON.parse(String(provider.mock.calls[1][1]?.body))).toEqual({ rules: [] });
  });

  it('rejects unreviewed, stale, cross-tenant, scope and input overrides before provider traffic', async () => {
    const { request, provider } = await corsWriteResource();
    for (const [change, status] of [
      [{ confirmation: undefined }, 403],
      [{ expectedEffect: 'read' }, 400],
      [{ version: '0'.repeat(64) }, 409],
      [{ resourceId: 'res_foreign' }, 404],
      [{ owner: { person: 'stranger' } }, 404],
      [{ input: { ...request.input, account_id: 'foreign' } }, 400],
      [{ input: { ...request.input, headers: { 'cf-r2-jurisdiction': 'default' } } }, 400],
      [{ input: { ...request.input, body: { rules: [], password: 'private' } } }, 400],
      [{ input: { body: { rules: [] } } }, 400],
    ] as const) {
      expect((await call('resources.invoke', { ...request, ...change })).status).toBe(status);
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it('reports stale configuration as a conflict without submitting a replacement', async () => {
    const { request, provider } = await corsWriteResource();
    provider.mockResolvedValueOnce(
      Response.json({ success: true, errors: [], messages: [], result: {} }),
    );
    const response = await call('resources.invoke', request);
    expect(await response.json()).toMatchObject({ data: { kind: 'conflict' } });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it.each(['bucket', 'jurisdiction', 'owner'] as const)(
    'does not write when %s changes during preflight',
    async (change) => {
      const { request, provider, rules } = await corsWriteResource();
      provider.mockImplementationOnce(async () => {
        if (change === 'owner') {
          await env.db
            .update(projects)
            .set({ proxy_token_gen: 99 })
            .where(eq(projects.id, project.id));
        } else {
          await env.db
            .update(resources)
            .set(
              change === 'bucket'
                ? { cf_id: 'foreign' }
                : { metadata: { jurisdiction: 'default' } },
            )
            .where(eq(resources.id, request.resourceId));
        }
        return Response.json({ success: true, errors: [], messages: [], result: { rules } });
      });
      const response = await call('resources.invoke', request);
      expect(await response.json()).toMatchObject({ data: { kind: 'unavailable' } });
      expect(provider).toHaveBeenCalledTimes(1);
    },
  );

  it('returns an unconfirmed receipt after transport failure without retrying the write', async () => {
    const { request, provider, rules } = await corsWriteResource();
    provider
      .mockResolvedValueOnce(
        Response.json({ success: true, errors: [], messages: [], result: { rules } }),
      )
      .mockRejectedValueOnce(Error('private diagnostic'));
    const response = await call('resources.invoke', request);
    const result = await response.json();
    expect(result).toMatchObject({ data: { kind: 'unknown' } });
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('hides a damaged write artifact while keeping the independently verified read', async () => {
    const { fixture, entry, descriptor } = await corsWriteResource();
    await env.STATIC_ASSETS_R2.put(cloudflareOpenApiKey(entry), 'invalid');
    const operations = await fixture.list();
    expect(operations.some((operation) => operation.id === descriptor.id)).toBe(false);
    expect(operations.some((operation) => operation.id === 'r2-get-bucket-cors-policy')).toBe(true);
  });
});

describe('structured provider operations', () => {
  it('discovers and executes pinned nested data beside the other resource operations', async () => {
    const { fixture, rules, operations, descriptor, body } = await corsResource();
    expect(operations).toHaveLength(5);
    expect(operations.find((operation) => operation.id === fixture.descriptor.id)).toEqual(
      fixture.descriptor,
    );
    expect(operations.find((operation) => operation.id === fixture.metadata.descriptor.id)).toEqual(
      fixture.metadata.descriptor,
    );
    expect(descriptor.outputSchema).toMatchObject({
      properties: { data: { properties: { rules: { type: 'array', maxItems: 200 } } } },
    });
    const response = await call('resources.invoke', body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        appId: project.id,
        resourceId: body.resourceId,
        action: descriptor.id,
        kind: 'provider-read',
        data: { name: 'My resource', rules },
      },
    });
    expect(String(fixture.metadata.provider.mock.calls[0][0])).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/owned-bucket/cors`,
    );
  });

  it('rejects pagination, scope and effect overrides without making a provider request', async () => {
    const { fixture, body } = await corsResource();
    for (const [request, status] of [
      [{ ...body, input: { query: { cursor: 'fake-page', limit: 10 } } }, 400],
      [{ ...body, input: { path: { bucket_name: 'foreign' } } }, 400],
      [{ ...body, input: { headers: { 'cf-r2-jurisdiction': 'default' } } }, 400],
      [{ ...body, expectedEffect: 'write' }, 400],
      [{ ...body, version: fixture.descriptor.version }, 409],
    ] as const) {
      expect((await call('resources.invoke', request)).status).toBe(status);
    }
    expect(fixture.metadata.provider).not.toHaveBeenCalled();
  });

  it.each(['bucket', 'jurisdiction', 'owner'] as const)(
    'discards nested data after the selected %s changes',
    async (change) => {
      const { fixture, rules, body } = await corsResource();
      fixture.metadata.provider.mockImplementationOnce(async () => {
        if (change === 'owner') {
          await env.db
            .update(projects)
            .set({ proxy_token_gen: 99 })
            .where(eq(projects.id, project.id));
        } else {
          await env.db
            .update(resources)
            .set(
              change === 'bucket'
                ? { cf_id: 'foreign' }
                : { metadata: { jurisdiction: 'default' } },
            )
            .where(eq(resources.id, body.resourceId));
        }
        return Response.json({ success: true, errors: [], messages: [], result: { rules } });
      });
      const response = await call('resources.invoke', body);
      expect(response.status).toBe(409);
      expect(JSON.stringify(await response.json())).not.toContain('example.test');
    },
  );

  it('returns a bounded safe failure for a provider result above the supported item limit', async () => {
    const { fixture, rules, body } = await corsResource();
    fixture.metadata.provider.mockImplementationOnce(async () =>
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { rules: Array.from({ length: 201 }, () => rules[0]) },
      }),
    );
    const response = await call('resources.invoke', body);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'PROVIDER_UNAVAILABLE',
      message: 'Could not load this resource. Try again.',
    });
  });
});

describe('schema-backed provider operations', () => {
  it('discovers distinct R2 reads from available pinned artifacts and routes each to its own handler', async () => {
    const fixture = await managedDomainResource();
    const get = vi.spyOn(env.STATIC_ASSETS_R2, 'get');
    const operations = await fixture.list();
    const cors = (await cloudflareOpenApiIndex()).find(
      (entry) => entry.operationId === 'r2-get-bucket-cors-policy',
    );
    if (!cors) {
      throw Error('Missing pinned CORS operation');
    }
    expect(get.mock.calls.map(([key]) => key)).toEqual([
      fixture.metadata.key,
      fixture.key,
      cloudflareOpenApiKey(cors),
      cloudflareOpenApiKey(
        (await cloudflareOpenApiIndex()).find(
          (entry) => entry.operationId === 'r2-list-custom-domains',
        )!,
      ),
      cloudflareOpenApiKey(
        (await cloudflareOpenApiIndex()).find(
          (entry) => entry.operationId === 'r2-put-bucket-cors-policy',
        )!,
      ),
    ]);
    expect(operations).toEqual(fixture.operations);
    expect(operations).toHaveLength(4);
    expect(operations.find((entry) => entry.id === fixture.metadata.entry.operationId)).toEqual(
      fixture.metadata.descriptor,
    );
    expect(fixture.descriptor.effect).toBe('read');
    expect(fixture.descriptor.version).not.toBe(fixture.metadata.descriptor.version);
    for (const [body, action, data] of [
      [
        fixture.metadata.body,
        fixture.metadata.entry.operationId,
        { name: 'My resource', jurisdiction: 'eu', storage_class: 'Standard' },
      ],
      [
        fixture.body,
        fixture.entry.operationId,
        { name: 'My resource', domain: fixture.data.domain, enabled: false },
      ],
    ] as const) {
      const response = await call('resources.invoke', body);
      expect(response.status).toBe(200);
      const output = await response.json();
      expect(output).toEqual({
        data: {
          appId: project.id,
          resourceId: body.resourceId,
          action,
          kind: 'provider-read',
          data,
        },
      });
      expect(JSON.stringify(output)).not.toContain(fixture.metadata.cfId);
      expect(output).not.toHaveProperty('data.data.bucketId');
    }
    expect(fixture.metadata.provider.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.cloudflare.com/client/v4/accounts/' +
        env.CF_ACCOUNT_ID +
        '/r2/buckets/owned-bucket',
      'https://api.cloudflare.com/client/v4/accounts/' +
        env.CF_ACCOUNT_ID +
        '/r2/buckets/owned-bucket/domains/managed',
    ]);
  });

  it('does not cross-invoke provider IDs, versions, effects or caller-controlled scope', async () => {
    const fixture = await managedDomainResource();
    for (const [body, status] of [
      [{ ...fixture.body, version: fixture.metadata.descriptor.version }, 409],
      [{ ...fixture.metadata.body, version: fixture.descriptor.version }, 409],
      [{ ...fixture.body, operation: 'r2-put-bucket-public-policy' }, 404],
      [{ ...fixture.body, expectedEffect: 'write' }, 400],
      [{ ...fixture.body, input: { account_id: 'other' } }, 400],
      [{ ...fixture.body, input: { path: { bucket_name: 'other' } } }, 400],
      [{ ...fixture.body, input: { headers: { 'cf-r2-jurisdiction': 'default' } } }, 400],
      [{ ...fixture.body, resourceId: 'res_foreign' }, 404],
      [{ ...fixture.body, owner: { person: 'someone-else' } }, 404],
    ] as const) {
      expect((await call('resources.invoke', body)).status).toBe(status);
    }
    expect(fixture.metadata.provider).not.toHaveBeenCalled();
  });

  it('omits a missing or damaged artifact independently while the other R2 read keeps its version and handler', async () => {
    const fixture = await managedDomainResource();
    for (const [unavailable, available] of [
      [fixture, fixture.metadata],
      [fixture.metadata, fixture],
    ] as const) {
      for (const corruption of ['missing', 'damaged'] as const) {
        if (corruption === 'missing') {
          await env.STATIC_ASSETS_R2.delete(unavailable.key);
        } else {
          await env.STATIC_ASSETS_R2.put(
            unavailable.key,
            new Uint8Array(unavailable.asset.byteLength),
          );
        }
        const operations = await fixture.list();
        expect(operations.some((entry) => entry.id === unavailable.entry.operationId)).toBe(false);
        expect(operations.find((entry) => entry.id === available.entry.operationId)).toEqual(
          available.descriptor,
        );
        expect((await call('resources.invoke', unavailable.body)).status).toBe(404);
        const response = await call('resources.invoke', available.body);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          data: { action: available.entry.operationId },
        });
      }
      await env.STATIC_ASSETS_R2.put(unavailable.key, unavailable.asset);
    }
  });

  it.each(['jurisdiction', 'bucket', 'owner'] as const)(
    'discards managed-domain data when selected %s changes during the request',
    async (change) => {
      const fixture = await managedDomainResource();
      fixture.metadata.provider.mockImplementationOnce(async () => {
        if (change === 'owner') {
          await env.db
            .update(projects)
            .set({ proxy_token_gen: 99 })
            .where(eq(projects.id, project.id));
        } else {
          await env.db
            .update(resources)
            .set(
              change === 'jurisdiction'
                ? { metadata: { jurisdiction: 'default' } }
                : { cf_id: 'other-bucket' },
            )
            .where(eq(resources.id, fixture.body.resourceId));
        }
        return Response.json({ success: true, errors: [], messages: [], result: fixture.data });
      });
      const response = await call('resources.invoke', fixture.body);
      expect(response.status).toBe(409);
      expect(JSON.stringify(await response.json())).not.toContain(fixture.data.domain);
      expect(fixture.metadata.provider).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['d1', 'r2', 'kv', 'queue', 'hyperdrive'] as const)(
    'discovers and invokes the pinned %s operation through the same registry',
    async (kind) => {
      const { body, provider, entry, cfId } = await providerResource(kind);
      const response = await call('resources.invoke', body);
      expect(response.status).toBe(200);
      const output = await response.json();
      expect(output).toMatchObject({
        data: { kind: 'provider-read', data: { name: 'My resource' } },
      });
      expect(JSON.stringify(output)).not.toContain('private-');
      expect(JSON.stringify(output)).not.toContain(cfId);
      expect(provider).toHaveBeenCalledTimes(1);
      const [url, options] = provider.mock.calls[0];
      expect(String(url)).toBe(
        'https://api.cloudflare.com/client/v4' +
          entry.path.replace('{account_id}', env.CF_ACCOUNT_ID).replace(/\{[^}]+\}/, cfId),
      );
      expect(options).toMatchObject({ method: 'GET', redirect: 'error' });
      if (kind === 'r2') {
        expect(new Headers(options?.headers).get('cf-r2-jurisdiction')).toBe('eu');
      }
      expect(proxy).not.toHaveBeenCalled();
    },
  );

  it('rejects stale versions, effect changes, caller-selected scope and mismatched resource types before provider requests', async () => {
    const { body, provider } = await providerResource('r2');
    for (const [changed, status] of [
      [{ version: '0'.repeat(64) }, 409],
      [{ expectedEffect: 'write' }, 400],
      [{ confirmation: 'reviewed' }, 400],
      [{ input: { headers: { 'cf-r2-jurisdiction': 'default' } } }, 400],
      [{ input: { account_id: 'other' } }, 400],
      [{ resourceId: 'res_database' }, 404],
      [{ resourceId: 'res_foreign' }, 404],
    ] as const) {
      expect((await call('resources.invoke', { ...body, ...changed })).status).toBe(status);
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it.each(['kv', 'hyperdrive'] as const)(
    'stops advertising and invoking %s when credentials or the verified schema are unavailable',
    async (kind) => {
      const { body, key, asset, provider } = await providerResource(kind);
      const unavailable = async () => {
        const response = await call('projects.resourceOperations', {
          ...scope(),
          resourceId: body.resourceId,
        });
        expect(await response.json()).toMatchObject({ data: { available: false, operations: [] } });
        expect((await call('resources.invoke', body)).status).toBe(404);
      };
      env.CF_API_TOKEN = '';
      await unavailable();
      env.CF_API_TOKEN = 'test-cf-token';
      env.CF_ACCOUNT_ID = 'invalid';
      await unavailable();
      env.CF_ACCOUNT_ID = 'a'.repeat(32);
      await env.STATIC_ASSETS_R2.delete(key);
      await unavailable();
      await env.STATIC_ASSETS_R2.put(key, new Uint8Array(asset.byteLength));
      await unavailable();
      expect(provider).not.toHaveBeenCalled();
    },
  );

  it('keeps Hyperdrive reads owned and does not expose origin configuration or provider permission errors', async () => {
    const { body, provider } = await providerResource('hyperdrive');
    for (const changed of [{ resourceId: 'res_foreign' }, { owner: { person: 'someone-else' } }]) {
      expect((await call('resources.invoke', { ...body, ...changed })).status).toBe(404);
    }
    expect(provider).not.toHaveBeenCalled();
    const response = await call('resources.invoke', body);
    expect(await response.json()).toMatchObject({
      data: {
        data: { caching_disabled: false, caching_max_age: 120, origin_connection_limit: 20 },
      },
    });
    provider.mockResolvedValueOnce(
      Response.json({ errors: [{ message: 'private-permission-diagnostic' }] }, { status: 403 }),
    );
    const denied = await call('resources.invoke', body);
    expect(denied.status).toBe(502);
    expect(JSON.stringify(await denied.json())).not.toContain('private-');
  });

  it('rechecks ownership metadata after the provider response before exposing data', async () => {
    const { body, provider, data } = await providerResource('r2');
    provider.mockImplementationOnce(async () => {
      await env.db
        .update(resources)
        .set({ metadata: { jurisdiction: 'default' } })
        .where(eq(resources.id, body.resourceId));
      return Response.json({ success: true, errors: [], messages: [], result: data });
    });
    expect((await call('resources.invoke', body)).status).toBe(409);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('validates provider data and reports failures without leaking its response', async () => {
    const { body, provider } = await providerResource('kv');
    provider.mockResolvedValueOnce(
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { id: 'foreign', title: 'private-provider-secret' },
      }),
    );
    const response = await call('resources.invoke', body);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('owned provider collection operations', () => {
  async function keys() {
    const metadata = await providerResource('kv');
    const entry = (await cloudflareOpenApiIndex()).find(
      (candidate) => candidate.operationId === "workers-kv-namespace-list-a-namespace'-s-keys",
    );
    if (!entry) {
      throw Error('Missing pinned key list schema');
    }
    const key = cloudflareOpenApiKey(entry);
    const asset = await readFile(
      new URL('../fixtures/cloudflare-openapi/kv-keys-get.json.gz', import.meta.url),
    );
    await env.STATIC_ASSETS_R2.put(key, asset);
    const selection = { ...scope(), resourceId: metadata.body.resourceId };
    const list = async () => {
      const response = await call('projects.resourceOperations', selection);
      expect(response.status).toBe(200);
      return catalogSchema.assert(await response.json()).data.operations;
    };
    const descriptor = (await list()).find((operation) => operation.id === entry.operationId);
    if (!descriptor) {
      throw Error('Key list operation was not registered');
    }
    const body = {
      ...selection,
      operation: descriptor.id,
      version: descriptor.version,
      expectedEffect: 'read',
      input: { query: { prefix: 'session:', limit: 10 } },
    };
    const page = {
      success: true,
      errors: [],
      messages: [],
      result: [{ name: 'session:one', metadata: { secret: 'private-value' } }],
      result_info: { count: 1, cursor: 'next+/=' },
    };
    metadata.provider.mockImplementation(async () => Response.json(page));
    return { metadata, body, list, key, asset, page };
  }

  it('discovers independent metadata and collection capabilities, then pages the owned namespace', async () => {
    const { metadata, body, list } = await keys();
    expect(await list()).toEqual(
      expect.arrayContaining([
        metadata.descriptor,
        expect.objectContaining({ id: body.operation, effect: 'read' }),
      ]),
    );
    const response = await call('resources.invoke', body);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      data: {
        appId: project.id,
        resourceId: body.resourceId,
        action: body.operation,
        kind: 'provider-read',
        data: {
          records: [{ name: 'session:one' }],
          pagination: { limit: 10, nextCursor: 'next+/=', hasMore: true },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(new URL(String(metadata.provider.mock.calls[0][0])).pathname).toBe(
      `/client/v4/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${metadata.cfId}/keys`,
    );
    metadata.provider.mockResolvedValueOnce(
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [{ name: 'session:two', expiration: 0 }],
        result_info: { count: 1, cursor: '' },
      }),
    );
    const last = await call('resources.invoke', {
      ...body,
      input: { query: { ...body.input.query, cursor: 'next+/=' } },
    });
    expect(last.status).toBe(200);
    expect(await last.json()).toMatchObject({
      data: {
        data: {
          records: [{ name: 'session:two', expiration: 0 }],
          pagination: { nextCursor: null, hasMore: false },
        },
      },
    });
    expect(new URL(String(metadata.provider.mock.calls[1][0])).searchParams.get('prefix')).toBe(
      'session:',
    );
    expect(proxy).not.toHaveBeenCalled();
  });

  it('rejects stale versions, changed effects and cross-tenant or provider scope overrides before access', async () => {
    const { metadata, body } = await keys();
    for (const [change, status] of [
      [{ version: '0'.repeat(64) }, 409],
      [{ expectedEffect: 'write' }, 400],
      [{ resourceId: 'res_foreign' }, 404],
      [{ owner: { person: 'someone-else' } }, 404],
      [{ input: { query: { namespace_id: 'c'.repeat(32) } } }, 400],
      [{ input: { account_id: 'c'.repeat(32) } }, 400],
      [{ input: { query: { limit: 201 } } }, 400],
    ] as const) {
      expect((await call('resources.invoke', { ...body, ...change })).status).toBe(status);
    }
    expect(metadata.provider).not.toHaveBeenCalled();
  });

  it('keeps metadata usable when the collection schema disappears or fails integrity checks', async () => {
    const { metadata, body, list, key, asset } = await keys();
    for (const broken of ['missing', 'damaged']) {
      if (broken === 'missing') {
        await env.STATIC_ASSETS_R2.delete(key);
      } else {
        await env.STATIC_ASSETS_R2.put(key, new Uint8Array(asset.length));
      }
      expect(await list()).toEqual([metadata.descriptor]);
      expect((await call('resources.invoke', body)).status).toBe(404);
    }
    expect(metadata.provider).not.toHaveBeenCalled();
  });

  it('withholds returned keys after ownership changes and reports provider errors without their content', async () => {
    const { metadata, body, page } = await keys();
    metadata.provider.mockResolvedValueOnce(
      Response.json({ error: 'private-diagnostic' }, { status: 403 }),
    );
    const failure = await call('resources.invoke', body);
    expect(failure.status).toBe(502);
    expect(JSON.stringify(await failure.json())).not.toContain('private-');
    metadata.provider.mockImplementationOnce(async () => {
      await env.db
        .update(resources)
        .set({ cf_id: 'c'.repeat(32) })
        .where(eq(resources.id, body.resourceId));
      return Response.json(page);
    });
    const changed = await call('resources.invoke', body);
    expect(changed.status).toBe(409);
    expect(JSON.stringify(await changed.json())).not.toContain('session:one');
  });
});

describe('registered resource operations', () => {
  it('discovers complete bounded schemas and stable versions without reading files or leaking provider identity', async () => {
    const operations = await catalog();
    expect(operations).toHaveLength(2);
    expect(operations).toEqual(await catalog());
    const save = operations.find((entry) => entry.id === 'files.saveText');
    expect(save?.version).toMatch(/^[a-f0-9]{64}$/);
    expect(save?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining(['key', 'text', 'expectedEtag']),
      properties: {
        expectedEtag: { type: 'string', minLength: 1, maxLength: 200 },
        text: { type: 'string', maxLength: 65_536, 'x-maxUtf8Bytes': 65_536 },
      },
    });
    expect(save?.outputSchema).toHaveProperty('anyOf');
    expect(JSON.stringify(operations)).not.toContain('private-');
    expect(proxy).not.toHaveBeenCalled();
  });

  it('does not present discovery-only or unsupported operations as executable', async () => {
    const database = await call('projects.resourceOperations', {
      ...scope(),
      resourceId: 'res_database',
    });
    expect(await database.json()).toMatchObject({
      data: {
        available: true,
        operations: [{ id: 'database.query', effect: 'read' }],
        coverage: 'registered-operations',
      },
    });
    const body = await invocation();
    expect((await call('resources.invoke', { ...body, resourceId: 'res_database' })).status).toBe(
      404,
    );
    expect(
      (await call('resources.invoke', { ...body, operation: 'cloudflare-delete-bucket' })).status,
    ).toBe(404);
    delete env.PLATFORM_PROXY;
    expect(await (await call('projects.resourceOperations', scope())).json()).toMatchObject({
      data: { available: false, operations: [] },
    });
    expect((await call('resources.invoke', body)).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('uses the same resource and connectivity selection for advertised and invoked operations', async () => {
    const database = await call('projects.resourceOperations', {
      ...scope(),
      resourceId: 'res_database',
    });
    const descriptors = [
      ...(await catalog()),
      ...catalogSchema.assert(await database.json()).data.operations,
    ];
    for (const connected of [true, false]) {
      if (!connected) {
        delete env.PLATFORM_PROXY;
      }
      for (const [resourceId, supported] of [
        ['res_files', ['files.readText', 'files.saveText']],
        ['res_database', ['database.query']],
        ['res_keys', []],
      ] as const) {
        const advertised = connected ? [...supported] : [];
        const response = await call('projects.resourceOperations', { ...scope(), resourceId });
        const body = await response.json();
        expect(body).toMatchObject({ data: { available: advertised.length > 0 } });
        expect(catalogSchema.assert(body).data.operations.map((entry) => entry.id)).toEqual(
          advertised,
        );
        for (const descriptor of descriptors) {
          const response = await call('resources.invoke', {
            ...scope(),
            resourceId,
            operation: descriptor.id,
            version: descriptor.version,
            expectedEffect: descriptor.effect,
            ...(descriptor.effect === 'write' ? { confirmation: 'reviewed' } : {}),
            input: {},
          });
          expect(response.status).toBe(advertised.some((id) => id === descriptor.id) ? 400 : 404);
        }
      }
    }
    expect(proxy).not.toHaveBeenCalled();
  });

  it('authenticates the client and rejects other owners, projects and resources for both routes', async () => {
    const body = await invocation();
    for (const [path, input] of [
      ['projects.resourceOperations', scope()],
      ['resources.invoke', body],
    ] as const) {
      expect((await call(path, input, 'Basic invalid')).status).toBe(401);
      expect(
        (await call(path, { ...input, project: other.id, resourceId: 'res_foreign' })).status,
      ).toBe(404);
      expect((await call(path, { ...input, resourceId: 'res_foreign' })).status).toBe(404);
      expect((await call(path, { ...input, owner: { person: 'someone-else' } })).status).toBe(404);
    }
    expect(proxy).not.toHaveBeenCalled();
  });

  it('rejects stale descriptors, forged read effects and unreviewed writes before provider requests', async () => {
    const body = await invocation('files.saveText');
    expect((await call('resources.invoke', { ...body, version: '0'.repeat(64) })).status).toBe(409);
    expect((await call('resources.invoke', { ...body, expectedEffect: 'read' })).status).toBe(400);
    expect((await call('resources.invoke', { ...body, confirmation: undefined })).status).toBe(403);
    expect(
      (await call('resources.invoke', { ...(await invocation()), confirmation: 'reviewed' }))
        .status,
    ).toBe(400);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('rejects malformed, extra, provider-selected and oversized input before effects', async () => {
    const body = await invocation('files.saveText');
    for (const input of [
      null,
      [],
      { ...body.input, key: '' },
      { ...body.input, expectedEtag: undefined },
      { ...body.input, cf_id: 'other-bucket' },
      { ...body.input, text: 'a'.repeat(65_537) },
      { ...body.input, text: '€'.repeat(30_000) },
    ]) {
      expect((await call('resources.invoke', { ...body, input })).status).toBe(400);
    }
    expect((await call('resources.invoke', { ...body, url: 'https://foreign.test' })).status).toBe(
      400,
    );
    expect(proxy).not.toHaveBeenCalled();
  });

  it('reads, conditionally saves, and reads back through the discovered registry operations', async () => {
    const read = await invocation();
    proxy.mockResolvedValueOnce(file());
    expect(await (await call('resources.invoke', read)).json()).toMatchObject({
      data: { kind: 'file-text', text: 'Hello', etag: 'opened', editable: true },
    });
    proxy
      .mockResolvedValueOnce(file())
      .mockResolvedValueOnce(Response.json({ key: 'note.txt', etag: 'saved' }));
    expect(
      await (await call('resources.invoke', await invocation('files.saveText'))).json(),
    ).toMatchObject({ data: { kind: 'file-saved', etag: 'saved' } });
    const [url, init] = proxy.mock.calls[2];
    expect(String(url)).toBe('https://proxy/r2/put-conditional');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      key: 'note.txt',
      value: 'Changed',
      onlyIf: { etagMatches: 'opened' },
      customMetadata: { author: 'owner' },
    });
    proxy.mockResolvedValueOnce(file('Changed', 'saved'));
    expect(await (await call('resources.invoke', read)).json()).toMatchObject({
      data: { kind: 'file-text', text: 'Changed', etag: 'saved' },
    });
  });

  it('keeps concurrent edits and uncertain writes distinct', async () => {
    const body = await invocation('files.saveText');
    proxy.mockResolvedValueOnce(file('Other change', 'newer'));
    expect(await (await call('resources.invoke', body)).json()).toMatchObject({
      data: { kind: 'conflict' },
    });
    expect(proxy).toHaveBeenCalledTimes(1);
    proxy.mockResolvedValueOnce(file()).mockResolvedValueOnce(new Response(null, { status: 412 }));
    expect(await (await call('resources.invoke', body)).json()).toMatchObject({
      data: { kind: 'conflict' },
    });
    proxy.mockResolvedValueOnce(file()).mockRejectedValueOnce(Error('Connection lost'));
    expect(await (await call('resources.invoke', body)).json()).toMatchObject({
      data: { kind: 'unknown' },
    });
  });

  it('does not expose content to another connected client or accept oversized envelopes', async () => {
    const body = await invocation();
    const foreign = await registerOAuthClient(env.db, {
      name: 'Other client',
      operator: 'Test',
      redirectUris: ['https://other.test/callback'],
      scopes: ['profile'],
    });
    const authorization = 'Basic ' + btoa(foreign.client.id + ':' + foreign.clientSecret);
    expect((await call('resources.invoke', body, authorization)).status).toBe(404);
    expect((await call('projects.resourceOperations', scope(), authorization)).status).toBe(404);
    expect(
      (await call('resources.invoke', { ...body, input: { key: 'a'.repeat(820_001) } })).status,
    ).toBe(413);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('reports uncertainty when the connection changes during the actual write', async () => {
    const body = await invocation('files.saveText');
    proxy.mockResolvedValueOnce(file()).mockImplementationOnce(async () => {
      await env.db.update(projects).set({ proxy_token_gen: 1 }).where(eq(projects.id, project.id));
      return Response.json({ key: 'note.txt', etag: 'saved' });
    });
    expect(await (await call('resources.invoke', body)).json()).toMatchObject({
      data: { kind: 'unknown' },
    });
  });

  it('rechecks ownership after reads and before conditional writes', async () => {
    const read = await invocation();
    proxy.mockImplementationOnce(async () => {
      await env.db.update(resources).set({ cf_id: 'moved' }).where(eq(resources.id, 'res_files'));
      return file();
    });
    expect((await call('resources.invoke', read)).status).toBe(409);
    const save = await invocation('files.saveText');
    proxy.mockImplementationOnce(async () => {
      await env.db
        .update(resources)
        .set({ cf_id: 'moved-again' })
        .where(eq(resources.id, 'res_files'));
      return file();
    });
    expect(await (await call('resources.invoke', save)).json()).toMatchObject({
      data: { kind: 'unknown' },
    });
    expect(proxy).toHaveBeenCalledTimes(2);
  });

  it('refuses suspended owners and expired previews', async () => {
    const body = await invocation();
    await env.db.update(users).set({ suspended_reason: 'admin:test' }).where(eq(users.id, ownerId));
    expect((await call('resources.invoke', body)).status).toBe(403);
    expect((await call('projects.resourceOperations', scope())).status).toBe(409);
    await env.db.update(users).set({ suspended_reason: null }).where(eq(users.id, ownerId));
    await env.db
      .update(projects)
      .set({
        preview_client_id: registration.client.id,
        preview_workspace_id: 'operation-test-workspace',
        slug: 'preview-operation-test',
        preview_expires_at: new Date(0).toISOString(),
      })
      .where(eq(projects.id, project.id));
    expect((await call('resources.invoke', body)).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });
});

async function queryInvocation(sql = 'SELECT * FROM notes') {
  const resourceId = 'res_database';
  const response = await call('projects.resourceOperations', { ...scope(), resourceId });
  const descriptor = catalogSchema.assert(await response.json()).data.operations[0];
  if (!descriptor) {
    throw Error('Missing query operation');
  }
  return {
    ...scope(),
    resourceId,
    operation: descriptor.id,
    version: descriptor.version,
    expectedEffect: 'read',
    input: { sql },
  };
}
function queryDatabaseFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(
    "CREATE TABLE notes(title TEXT, category TEXT, score INTEGER, password TEXT, visible_copy TEXT GENERATED ALWAYS AS (password)); INSERT INTO notes(title, category, score, password) VALUES ('first', 'bug', 1, 'private-value'), ('second', 'bug', 3, 'private-value'), ('third', 'idea', 4, 'private-value'); CREATE VIEW visible_notes AS SELECT * FROM notes; CREATE TABLE _void_migrations(secret TEXT)",
  );
  const input = type({ sql: 'string', 'params?': '(string | number)[]' });
  proxy.mockImplementation(async (_url, init) => {
    const body = input.assert(JSON.parse(String(init?.body)));
    return Response.json({ results: database.prepare(body.sql).all(...(body.params ?? [])) });
  });
  return database;
}

describe('registered database SELECT queries', () => {
  it('executes its schema checks and compiled query on real Workerd D1', async () => {
    const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        compatibilityDate: '2026-10-01',
        d1Databases: ['DB'],
      }),
    );
    try {
      const database = await runtime.getD1Database('DB');
      await database.prepare('CREATE TABLE notes(title TEXT, password TEXT)').run();
      await database.prepare("INSERT INTO notes VALUES ('Hello', 'private')").run();
      const queryErrors: Array<unknown> = [];
      const input = type({ sql: 'string', 'params?': '(string | number)[]' });
      proxy.mockImplementation(async (_url, init) => {
        const body = input.assert(JSON.parse(String(init?.body)));
        try {
          return Response.json(
            await database
              .prepare(body.sql)
              .bind(...(body.params ?? []))
              .all(),
          );
        } catch (error) {
          queryErrors.push({ sql: body.sql, error });
          throw error;
        }
      });
      const response = await call('resources.invoke', await queryInvocation());
      expect(queryErrors).toEqual([]);
      expect(await response.json()).toMatchObject({
        data: { kind: 'query-rows', columns: ['title'], rows: [['Hello']] },
      });
    } finally {
      await runtime.dispose();
    }
  });
  it('runs real SQLite public reads, groups, bounded pages and empty-result schemas through the advertised operation', async () => {
    const database = queryDatabaseFixture();
    try {
      const request = await queryInvocation();
      expect(await (await call('resources.invoke', request)).json()).toMatchObject({
        data: {
          kind: 'query-rows',
          columns: ['title', 'category', 'score'],
          rows: [
            ['first', 'bug', 1],
            ['second', 'bug', 3],
            ['third', 'idea', 4],
          ],
          truncated: false,
        },
      });
      const grouped = await queryInvocation(
        'SELECT category, COUNT(*) AS total FROM notes WHERE score > 0 GROUP BY category ORDER BY total DESC LIMIT 1',
      );
      expect(await (await call('resources.invoke', grouped)).json()).toMatchObject({
        data: {
          columns: ['category', 'total'],
          rows: [['bug', 2]],
          truncated: true,
          limit: 1,
        },
      });
      expect(
        await (
          await call(
            'resources.invoke',
            await queryInvocation("SELECT title FROM notes WHERE title = 'missing'"),
          )
        ).json(),
      ).toMatchObject({ data: { columns: ['title'], rows: [], truncated: false } });
      const signals = proxy.mock.calls.slice(0, 6).map(([, init]) => init?.signal);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(new Set(signals).size).toBe(1);
    } finally {
      database.close();
    }
  });

  it('rejects mutations and unsupported statements without making provider requests', async () => {
    for (const sql of [
      'DELETE FROM notes',
      'SELECT * FROM notes; DROP TABLE notes',
      'WITH n AS (SELECT * FROM notes) SELECT * FROM n',
    ]) {
      const response = await call('resources.invoke', await queryInvocation(sql));
      expect(await response.json()).toMatchObject({
        data: { kind: 'unavailable', reason: expect.stringContaining('one SELECT') },
      });
    }
    expect(proxy).not.toHaveBeenCalled();
  });

  it('refuses protected references, generated columns, internal tables and views before any customer query', async () => {
    const database = queryDatabaseFixture();
    try {
      for (const sql of [
        'SELECT password AS title FROM notes',
        "SELECT title FROM notes WHERE password = 'guess'",
        'SELECT visible_copy FROM notes',
        'SELECT * FROM _void_migrations',
        'SELECT * FROM visible_notes',
      ]) {
        proxy.mockClear();
        expect(
          await (await call('resources.invoke', await queryInvocation(sql))).json(),
        ).toMatchObject({ data: { kind: 'unavailable' } });
        expect(proxy.mock.calls.some(([, init]) => String(init?.body).includes(' AS '))).toBe(
          false,
        );
      }
      expect(database.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 3 });
    } finally {
      database.close();
    }
  });

  it('pins effect, operation version, selected resource and owner before queries', async () => {
    const request = await queryInvocation();
    for (const [change, status] of [
      [{ version: '0'.repeat(64) }, 409],
      [{ expectedEffect: 'write' }, 400],
      [{ confirmation: 'reviewed' }, 400],
      [{ resourceId: 'res_files' }, 404],
      [{ project: other.id }, 404],
      [{ owner: { person: 'someone-else' } }, 404],
      [{ input: { sql: 'SELECT * FROM notes', binding: 'OTHER' } }, 400],
      [{ input: { sql: '€'.repeat(3000) } }, 400],
    ] as const) {
      expect((await call('resources.invoke', { ...request, ...change })).status).toBe(status);
    }
    expect(proxy).not.toHaveBeenCalled();
  });

  it('discards query results when schema changes during the read', async () => {
    const database = queryDatabaseFixture();
    const bridge = proxy.getMockImplementation();
    if (!bridge) {
      throw Error('Missing fixture');
    }
    proxy.mockImplementation(async (url, init) => {
      const response = await bridge(url, init);
      if (String(init?.body).includes(' AS ')) {
        database.exec('ALTER TABLE notes ADD COLUMN later TEXT');
      }
      return response;
    });
    try {
      expect(await (await call('resources.invoke', await queryInvocation())).json()).toMatchObject({
        data: { kind: 'unavailable', reason: expect.stringContaining('schema changed') },
      });
    } finally {
      database.close();
    }
  });

  it('discards results after resource rebinding or revoked ownership', async () => {
    const replacement = await createTestUser(env.db, 'replacement-owner');
    for (const changed of ['resource', 'owner']) {
      const database = queryDatabaseFixture();
      const request = await queryInvocation();
      const bridge = proxy.getMockImplementation();
      if (!bridge) {
        throw Error('Missing fixture');
      }
      proxy.mockImplementation(async (url, init) => {
        const response = await bridge(url, init);
        if (String(init?.body).includes(' AS ')) {
          if (changed === 'resource') {
            await env.db
              .update(resources)
              .set({ cf_id: 'changed-database' })
              .where(eq(resources.id, 'res_database'));
          } else {
            await env.db
              .update(projects)
              .set({ user_id: replacement.id })
              .where(eq(projects.id, project.id));
          }
        }
        return response;
      });
      try {
        expect((await call('resources.invoke', request)).status).toBe(409);
      } finally {
        database.close();
      }
    }
  });

  it('bounds large result pages and reports long-cell truncation without leaking provider errors', async () => {
    const database = queryDatabaseFixture();
    try {
      database.prepare('UPDATE notes SET title = ? WHERE score = 1').run('x'.repeat(5000));
      const response = await call(
        'resources.invoke',
        await queryInvocation('SELECT title FROM notes LIMIT 1'),
      );
      const output = type({ data: { rows: 'string[][]', cellsTruncated: 'boolean' } }).assert(
        await response.json(),
      );
      expect(output.data.rows[0][0]).toHaveLength(4096);
      expect(output.data.cellsTruncated).toBe(true);
      proxy.mockResolvedValue(new Response('private-db token=hidden', { status: 500 }));
      const failed = await (await call('resources.invoke', await queryInvocation())).text();
      expect(failed).toContain('unavailable');
      expect(failed).not.toMatch(/private-db|token=hidden/);
    } finally {
      database.close();
    }
  });
});

describe('owned Durable Object instance operations', () => {
  async function managed() {
    const selected = cloudflareProviderReadSelections('durable-object')[0];
    const entry = (await cloudflareOpenApiIndex()).find(
      (candidate) => candidate.method === selected?.method && candidate.path === selected.path,
    );
    if (!entry) {
      throw Error('Missing pinned instance operation');
    }
    const key = cloudflareOpenApiKey(entry);
    await env.STATIC_ASSETS_R2.put(
      key,
      await readFile(
        new URL('../fixtures/cloudflare-openapi/durable-object-get.json.gz', import.meta.url),
      ),
    );
    env.CF_ACCOUNT_ID = 'a'.repeat(32);
    const namespaceId = 'b'.repeat(32);
    const instanceId = 'c'.repeat(64);
    const deployment = await createTestDeployment(env.db, project.id);
    const [current] = await env.db
      .update(projects)
      .set({ active_deployment_id: deployment.id })
      .where(eq(projects.id, project.id))
      .returning();
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
      .where(eq(deployments.id, deployment.id));
    const route = {
      projectId: project.id,
      userId: ownerId,
      version: deployment.id,
      workerName: `user-${current.slug}-${deployment.id}`,
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
    const appBindings = [
      { name: '__PROJECT_ID', type: 'plain_text', text: project.id },
      { name: 'ROOMS', type: 'durable_object_namespace', namespace_id: namespaceId },
    ];
    const hostBindings = [
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
      { name: '__PLATFORM_DURABLE_DEPLOYMENT', type: 'plain_text', text: deployment.id },
      {
        name: 'SELF',
        type: 'durable_object_namespace',
        class_name: 'Room',
        namespace_id: namespaceId,
      },
    ];
    const read = vi.fn(async () =>
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [{ id: instanceId, hasStoredData: true }],
        result_info: { count: 1, cursor: 'next-page' },
      }),
    );
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/scripts/' + route.workerName + '/bindings')) {
        return Response.json({ success: true, result: appBindings });
      }
      if (url.endsWith('/scripts/' + hostName + '/bindings')) {
        return Response.json({ success: true, result: hostBindings });
      }
      expect(url).toContain(`/durable_objects/namespaces/${namespaceId}/objects?`);
      expect(url).not.toContain(hostName);
      return read();
    });
    const selection = { ...scope(), resourceId: 'res_rooms' };
    const response = await call('projects.resourceOperations', selection);
    expect(response.status).toBe(200);
    const descriptor = catalogSchema.assert(await response.json()).data.operations[0];
    expect(descriptor?.id).toBe(entry.operationId);
    const body = {
      ...selection,
      operation: descriptor.id,
      version: descriptor.version,
      expectedEffect: 'read',
      input: { query: { limit: 10 } },
    };
    return {
      body,
      selection,
      key,
      provider,
      read,
      hostBindings,
      appBindings,
      instanceId,
      namespaceId,
      route,
      current,
      deployment,
    };
  }

  it('discovers, reads a bounded page, and rechecks live app and host ownership', async () => {
    const fixture = await managed();
    expect(fixture.read).not.toHaveBeenCalled();
    fixture.provider.mockClear();
    const response = await call('resources.invoke', fixture.body);
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value).toMatchObject({
      data: {
        kind: 'provider-read',
        data: {
          records: [{ id: fixture.instanceId, hasStoredData: true }],
          pagination: { limit: 10, nextCursor: 'next-page', hasMore: true },
        },
      },
    });
    expect(JSON.stringify(value)).not.toContain(fixture.namespaceId);
    expect(fixture.read).toHaveBeenCalledTimes(1);
    const urls = fixture.provider.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.endsWith('/bindings'))).toHaveLength(6);
    expect(urls.at(-1)).toContain('/bindings');
    const next = await call('resources.invoke', {
      ...fixture.body,
      input: { query: { limit: 10, cursor: 'previous-page' } },
    });
    expect(next.status).toBe(200);
    expect(
      fixture.provider.mock.calls.some(([url]) => String(url).includes('cursor=previous-page')),
    ).toBe(true);
  });

  it.each(['missing-host', 'changed-namespace', 'stale-release', 'missing-schema'])(
    'withdraws catalog and refuses execution for %s evidence',
    async (failure) => {
      const fixture = await managed();
      if (failure === 'missing-host') {
        fixture.hostBindings.length = 0;
      }
      if (failure === 'changed-namespace') {
        await env.db
          .update(resources)
          .set({ metadata: { namespaceId: 'd'.repeat(32), dispatchNamespace: 'platform-users' } })
          .where(eq(resources.id, 'res_rooms'));
      }
      if (failure === 'stale-release') {
        fixture.hostBindings[1].text = 'other-deployment';
      }
      if (failure === 'missing-schema') {
        await env.STATIC_ASSETS_R2.delete(fixture.key);
      }
      const response = await call('projects.resourceOperations', fixture.selection);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { available: false, operations: [] } });
      expect((await call('resources.invoke', fixture.body)).status).toBe(404);
      expect(fixture.read).not.toHaveBeenCalled();
    },
  );

  it.each(['host', 'inventory', 'deployment', 'owner'])(
    'discards instance data when %s changes during the provider read',
    async (change) => {
      const fixture = await managed();
      fixture.read.mockImplementationOnce(async () => {
        if (change === 'host') {
          fixture.hostBindings[1].text = 'different-release';
        }
        if (change === 'inventory') {
          await env.db
            .update(resources)
            .set({ metadata: { namespaceId: 'd'.repeat(32), dispatchNamespace: 'platform-users' } })
            .where(eq(resources.id, 'res_rooms'));
        }
        if (change === 'deployment') {
          await env.db
            .update(deployments)
            .set({ manifest: '{}' })
            .where(eq(deployments.id, fixture.deployment.id));
        }
        if (change === 'owner') {
          await env.db
            .update(users)
            .set({ suspended_reason: 'admin:test' })
            .where(eq(users.id, ownerId));
        }
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: [{ id: fixture.instanceId, hasStoredData: true }],
          result_info: { count: 1, cursor: '' },
        });
      });
      const response = await call('resources.invoke', fixture.body);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await response.json())).not.toContain(fixture.instanceId);
      expect(fixture.read).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects foreign owners and invalid query arguments without instance reads', async () => {
    const fixture = await managed();
    expect(
      (await call('resources.invoke', { ...fixture.body, owner: { person: 'stranger' } })).status,
    ).toBe(404);
    expect(
      (await call('resources.invoke', { ...fixture.body, input: { query: { limit: 10000 } } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call('resources.invoke', {
          ...fixture.body,
          input: { namespace: fixture.namespaceId },
        })
      ).status,
    ).toBe(400);
    expect(fixture.read).not.toHaveBeenCalled();
  });
});

describe.each([
  {
    kind: 'queue',
    id: 'queues-list-consumers',
    file: 'queue-consumers-get',
    records: [
      {
        consumer_id: 'c'.repeat(32),
        type: 'worker',
        settings: { max_retries: 3, max_concurrency: null },
        script_name: 'private-worker',
      },
    ],
    expected: [
      {
        consumer_id: 'c'.repeat(32),
        type: 'worker',
        settings_max_retries: 3,
        settings_max_concurrency: null,
      },
    ],
  },
  {
    kind: 'r2',
    id: 'r2-list-custom-domains',
    file: 'r2-custom-domains-get',
    records: [
      {
        domain: 'files.example.com',
        enabled: false,
        status: { ownership: 'active', ssl: 'pending' },
        zoneId: 'private-zone',
      },
    ],
    expected: [
      {
        domain: 'files.example.com',
        enabled: false,
        status_ownership: 'active',
        status_ssl: 'pending',
      },
    ],
  },
] as const)('registered $kind complete child collections', (fixture) => {
  async function setupCollection() {
    const metadata = await providerResource(fixture.kind);
    const entry = (await cloudflareOpenApiIndex()).find((item) => item.operationId === fixture.id);
    if (!entry) {
      throw Error('Missing pinned child collection');
    }
    const key = cloudflareOpenApiKey(entry);
    const bytes = await readFile(
      new URL(`../fixtures/cloudflare-openapi/${fixture.file}.json.gz`, import.meta.url),
    );
    await env.STATIC_ASSETS_R2.put(key, bytes);
    const selection = { ...scope(), resourceId: metadata.body.resourceId };
    const list = async () => {
      const response = await call('projects.resourceOperations', selection);
      expect(response.status).toBe(200);
      return catalogSchema.assert(await response.json()).data.operations;
    };
    const descriptor = (await list()).find((item) => item.id === fixture.id);
    if (!descriptor) {
      throw Error('Missing registered child collection');
    }
    const body = {
      ...selection,
      operation: descriptor.id,
      version: descriptor.version,
      expectedEffect: 'read',
      input: {},
    };
    const envelope = {
      success: true,
      errors: [],
      messages: [],
      result: fixture.kind === 'r2' ? { domains: fixture.records } : fixture.records,
      ...(fixture.kind === 'queue'
        ? {
            errors: null,
            messages: null,
            result_info: { page: 1, per_page: 20, count: 1, total_count: 1, total_pages: 1 },
          }
        : {}),
    };
    metadata.provider.mockImplementation(async () => Response.json(envelope));
    return { metadata, key, bytes, list, body, envelope };
  }

  it('registers independent complete-list descriptors and reads only the owned parent', async () => {
    const { metadata, list, body } = await setupCollection();
    expect(await list()).toEqual(
      expect.arrayContaining([
        metadata.descriptor,
        expect.objectContaining({ id: fixture.id, effect: 'read' }),
      ]),
    );
    const response = await call('resources.invoke', body);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      data: {
        kind: 'provider-read',
        action: fixture.id,
        data: {
          records: fixture.expected,
          pagination: { limit: null, count: 1, nextCursor: null, hasMore: false },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-');
    const url = new URL(String(metadata.provider.mock.calls[0][0]));
    expect(url.pathname).toBe(
      `/client/v4/accounts/${env.CF_ACCOUNT_ID}/${fixture.kind === 'r2' ? `r2/buckets/${metadata.cfId}/domains/custom` : `queues/${metadata.cfId}/consumers`}`,
    );
    expect(url.search).toBe('');
    expect(proxy).not.toHaveBeenCalled();
  });

  it('rejects stale versions, effects, pagination and cross-tenant selections before access', async () => {
    const { metadata, body } = await setupCollection();
    for (const [change, status] of [
      [{ version: '0'.repeat(64) }, 409],
      [{ expectedEffect: 'write' }, 400],
      [{ resourceId: 'res_foreign' }, 404],
      [{ owner: { person: 'someone-else' } }, 404],
      [{ input: { query: { limit: 10 } } }, 400],
      [{ input: { account_id: 'other' } }, 400],
    ] as const) {
      expect((await call('resources.invoke', { ...body, ...change })).status).toBe(status);
    }
    expect(metadata.provider).not.toHaveBeenCalled();
  });

  it('keeps existing metadata usable when the collection artifact is missing or corrupt', async () => {
    const { metadata, key, bytes, list, body } = await setupCollection();
    for (const mode of ['missing', 'corrupt']) {
      if (mode === 'missing') {
        await env.STATIC_ASSETS_R2.delete(key);
      } else {
        await env.STATIC_ASSETS_R2.put(key, new Uint8Array(bytes.length));
      }
      expect(await list()).toEqual(expect.arrayContaining([metadata.descriptor]));
      expect((await list()).some((item) => item.id === fixture.id)).toBe(false);
      expect((await call('resources.invoke', body)).status).toBe(404);
    }
    expect(metadata.provider).not.toHaveBeenCalled();
  });

  it('withholds child data after ownership changes and hides provider diagnostics', async () => {
    const { metadata, body, envelope } = await setupCollection();
    metadata.provider.mockResolvedValueOnce(
      Response.json({ message: 'private-provider-error' }, { status: 403 }),
    );
    const failed = await call('resources.invoke', body);
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toContain('private-');
    metadata.provider.mockImplementationOnce(async () => {
      await env.db
        .update(resources)
        .set({ cf_id: 'changed-resource' })
        .where(eq(resources.id, body.resourceId));
      return Response.json(envelope);
    });
    const changed = await call('resources.invoke', body);
    expect(changed.status).toBe(409);
    expect(JSON.stringify(await changed.json())).not.toContain(
      fixture.kind === 'r2' ? 'files.example.com' : 'c'.repeat(32),
    );
  });
});
