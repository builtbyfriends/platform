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
import { projects, resources } from '../../src/schema.ts';
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

let env: TestEnv;
let registration: Awaited<ReturnType<typeof registerOAuthClient>>;
let project: { id: string };
let foreign: { id: string };
const configId = 'a'.repeat(32);
const provider = vi.fn<typeof fetch>();

const config = () => ({
  id: configId,
  name: 'internal-provider-name',
  origin: {
    database: 'catalog',
    host: 'db.example.com',
    port: 5432,
    scheme: 'postgres',
    user: 'private-user',
    password: 'private-password',
    access_client_id: 'private-access-id',
    access_client_secret: 'private-access-secret',
  },
  caching: { disabled: true, max_age: 60 },
  connectionString: 'postgres://private-user:private-password@db.example.com/catalog',
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Provider fixtures deliberately include malformed response bodies.
const ok = (result: unknown) => Response.json({ success: true, result });

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
        resourceId: 'res_connection',
        owner: { person: 'person' },
        action: 'database.connection',
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

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(teardownEnv);

beforeEach(async () => {
  await clearTables(env.db);
  registration = await registerOAuthClient(env.db, {
    name: 'Connection test',
    operator: 'Test',
    redirectUris: ['https://app.test/callback'],
    scopes: ['profile'],
  });

  const owner = await createTestUser(
    env.db,
    'connection-owner',
    'app:' + registration.client.id,
    'person',
  );

  const other = await createTestUser(env.db, 'other-owner');
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
      cf_id: configId,
      binding_name: 'HYPERDRIVE',
    },
    {
      id: 'res_foreign',
      project_id: foreign.id,
      type: 'hyperdrive',
      cf_id: 'b'.repeat(32),
      binding_name: 'HYPERDRIVE',
    },
  ]);
  provider.mockReset().mockImplementation(async () => ok(config()));
  vi.stubGlobal('fetch', provider);
  delete env.DEV_AUTH_BYPASS;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('owned external database connection', () => {
  it('advertises configuration records without a storage proxy and exposes no credentials or health claim', async () => {
    expect(await payload(call({}, 'projects.resources'))).toMatchObject({
      data: {
        resources: [
          {
            id: 'res_connection',
            kind: 'external-database',
            browse: null,
            actions: [
              {
                id: 'database.connection',
                effect: 'read',
                fields: [],
                view: { scope: 'resource', label: 'Overview' },
                result: 'records',
              },
            ],
          },
        ],
      },
    });
    const reading = await payload(call());
    expect(reading).toEqual({
      data: {
        appId: project.id,
        resourceId: 'res_connection',
        action: 'database.connection',
        kind: 'records',
        checkedAt: expect.any(Number),
        columns: [
          { id: 'property', label: 'Property' },
          { id: 'value', label: 'Value' },
        ],
        rows: [
          { id: 'engine', cells: ['Engine', 'PostgreSQL'] },
          { id: 'database', cells: ['Database', 'catalog'] },
          { id: 'host', cells: ['Host', 'db.example.com'] },
          { id: 'port', cells: ['Port', '5432'] },
          { id: 'cache', cells: ['Query cache', 'Disabled'] },
          {
            id: 'scope',
            cells: ['Reading', 'Configuration only; connection health has not been checked.'],
          },
        ],
        truncated: false,
      },
    });
    expect(JSON.stringify(reading)).not.toMatch(/private-|internal-provider|aaaaaaaa/);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]?.[0]).toBe(
      `https://api.cloudflare.com/client/v4/accounts/test-account-id/hyperdrive/configs/${configId}`,
    );
    expect(provider.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

  it('does not invent a public host or port for private connections', async () => {
    provider.mockResolvedValue(
      ok({
        ...config(),
        origin: {
          database: 'inventory',
          scheme: 'mysql',
          service_id: 'private-service',
          user: 'private-user',
        },
        caching: { disabled: false },
      }),
    );
    expect(await payload(call())).toMatchObject({
      data: {
        rows: [
          { id: 'engine', cells: ['Engine', 'MySQL'] },
          { id: 'database', cells: ['Database', 'inventory'] },
          { id: 'host', cells: ['Host', null] },
          { id: 'port', cells: ['Port', null] },
          { id: 'cache', cells: ['Query cache', 'Enabled'] },
          { id: 'scope' },
        ],
      },
    });
  });

  it.each([
    { id: 'b'.repeat(32) },
    { origin: { ...config().origin, host: 'postgres://user:password@db.example.com' } },
    { origin: { ...config().origin, database: 'x'.repeat(2049) } },
    { origin: { ...config().origin, database: 'postgres://user:password@host/db' } },
    { origin: { ...config().origin, port: 0 } },
    { origin: { ...config().origin, scheme: 'http' } },
    { origin: { ...config().origin, scheme: ['postgres'] } },
    { origin: { database: 'catalog', scheme: 'postgres' } },
    { caching: {} },
  ])('refuses malformed or mismatched configuration %j', async (change) => {
    provider.mockResolvedValue(ok({ ...config(), ...change }));
    expect(await payload(call())).toMatchObject({
      data: {
        kind: 'unavailable',
        reason: 'Could not read the database connection. Refresh and try again.',
      },
    });
  });

  it('keeps provider errors private', async () => {
    provider.mockResolvedValue(
      Response.json(
        { success: false, errors: [{ code: 1000, message: 'private-password private-user' }] },
        { status: 403 },
      ),
    );
    const reading = await payload(call());
    expect(reading).toMatchObject({ data: { kind: 'unavailable' } });
    expect(JSON.stringify(reading)).not.toContain('private-');
  });

  it('rejects another owner and another project resource before provider access', async () => {
    expect((await call({ owner: { person: 'other' } })).status).toBe(404);
    expect((await call({ project: foreign.id })).status).toBe(404);
    expect((await call({ resourceId: 'res_foreign' })).status).toBe(404);
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects supplied provider targets and SQL', async () => {
    expect((await call({ input: { cf_id: configId } })).status).toBe(400);
    expect((await call({ input: { sql: 'SELECT 1' } })).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not inspect a different resource kind', async () => {
    await env.db.update(resources).set({ type: 'd1' }).where(eq(resources.id, 'res_connection'));

    expect(await payload(call())).toMatchObject({ data: { kind: 'unavailable' } });
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not advertise or call the provider without inspection credentials', async () => {
    const token = env.CF_API_TOKEN;
    env.CF_API_TOKEN = '';

    try {
      expect(await payload(call({}, 'projects.resources'))).toMatchObject({
        data: { resources: [{ actions: [] }] },
      });
      expect(await payload(call())).toMatchObject({
        data: {
          kind: 'unavailable',
          reason: 'Connection inspection is not enabled on this installation.',
        },
      });
      expect(provider).not.toHaveBeenCalled();
    } finally {
      env.CF_API_TOKEN = token;
    }
  });

  it('rechecks ownership after a provider read', async () => {
    provider.mockImplementation(async () => {
      const newOwner = await createTestUser(env.db, 'transferred-owner');
      await env.db
        .update(projects)
        .set({ user_id: newOwner.id })
        .where(eq(projects.id, project.id));

      return ok(config());
    });
    expect((await call()).status).toBe(409);
  });

  it('rechecks the resource identity after a provider read', async () => {
    provider.mockImplementation(async () => {
      await env.db
        .update(resources)
        .set({ cf_id: 'c'.repeat(32) })
        .where(eq(resources.id, 'res_connection'));

      return ok(config());
    });
    expect((await call()).status).toBe(409);
  });

  it('does not advertise or call the provider for a preview', async () => {
    await env.db
      .update(projects)
      .set({
        slug: 'preview-connection',
        preview_client_id: registration.client.id,
        preview_workspace_id: 'connection-test',
        preview_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .where(eq(projects.id, project.id));
    expect(await payload(call({}, 'projects.resources'))).toMatchObject({
      data: { resources: [{ actions: [] }] },
    });
    expect(await payload(call())).toMatchObject({
      data: { kind: 'unavailable', reason: 'Connection details are available for published apps.' },
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not advertise or call the provider before publishing', async () => {
    await env.db
      .update(projects)
      .set({ active_deployment_id: null })
      .where(eq(projects.id, project.id));
    expect(await payload(call({}, 'projects.resources'))).toMatchObject({
      data: { resources: [{ actions: [] }] },
    });
    expect(await payload(call())).toMatchObject({
      data: { kind: 'unavailable', reason: 'Publish this app to inspect its database connection.' },
    });
    expect(provider).not.toHaveBeenCalled();
  });
});
