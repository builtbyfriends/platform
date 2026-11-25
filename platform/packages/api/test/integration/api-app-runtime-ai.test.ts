import { isRecord } from '@builtbyfriends/deploy-core';
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
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import { getProject } from '../../src/db/projects.ts';
import app from '../../src/index.ts';
import { deriveProxyToken } from '../../src/proxy-token.ts';
import { aiModels } from '../../src/routes/app-runtime-ai.ts';
import { deployments, projects, resources } from '../../src/schema.ts';
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
let project: { id: string; slug: string };
let foreign: { id: string; slug: string };
let deploymentId: string;
const proxy = vi.fn<(request: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const basic = () => `Basic ${btoa(`${registration.client.id}:${registration.clientSecret}`)}`;
const call = (path: string, input: { [key: string]: unknown }, authorization = basic()) =>
  app.fetch(
    new Request(`https://platform.test/app-billing/${path}`, {
      method: 'POST',
      headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: { person: 'person' }, project: project.id, ...input }),
    }),
    env,
    createMockExecutionContext(),
  );
const payload = async (request: Promise<Response> | Response) => {
  const response = await request;
  expect(response.status).toBe(200);
  const value: unknown = await response.json();
  if (!isRecord(value) || !isRecord(value.data)) {
    throw Error('Missing runtime data');
  }
  return value.data;
};
const inventory = async () => {
  const data = await payload(call('projects.resources', {}));
  if (!Array.isArray(data.resources)) {
    throw Error('Missing inventory');
  }
  return data.resources;
};
const resourceId = async () => {
  const entry: unknown = (await inventory())[0];
  if (!isRecord(entry) || typeof entry.id !== 'string') {
    throw Error('Missing AI resource');
  }
  return entry.id;
};
const execute = (id: string, input: { [key: string]: unknown } = {}) =>
  call('resources.execute', { resourceId: id, action: 'ai.models', input });
const manifest = (value: unknown) =>
  env.db
    .update(deployments)
    .set({ manifest: JSON.stringify(value) })
    .where(eq(deployments.id, deploymentId));

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await clearTables(env.db);
  registration = await registerOAuthClient(env.db, {
    name: 'AI workspace',
    operator: 'Test',
    redirectUris: ['https://connected.test/callback'],
    scopes: ['profile'],
  });
  const owner = await createTestUser(env.db, 'owner', 'app:' + registration.client.id, 'person');
  const otherOwner = await createTestUser(env.db, 'foreign');
  project = await createTestProject(env.db, owner.id);
  foreign = await createTestProject(env.db, otherOwner.id);
  deploymentId = (await createTestDeployment(env.db, project.id)).id;
  await manifest({ bindings: { ai: true } });
  await env.db
    .update(projects)
    .set({ active_deployment_id: deploymentId })
    .where(eq(projects.id, project.id));
  proxy.mockReset();
  proxy.mockResolvedValue(
    Response.json([
      {
        name: '@cf/example/text',
        task: { name: 'Text Generation' },
        properties: [{ secret: 'not-for-client' }],
      },
    ]),
  );
  env.PLATFORM_PROXY = {
    fetch: proxy,
    connect: () => {
      throw Error('Unexpected socket');
    },
  };
  delete env.DEV_AUTH_BYPASS;
  delete env.PLATFORM_CAPABILITIES;
});

describe('owned AI model catalog', () => {
  it('discovers a stable published AI capability without provisioning or inference', async () => {
    const id = await resourceId();
    expect(await inventory()).toEqual([
      {
        id,
        name: 'AI models',
        kind: 'ai',
        browse: null,
        actions: [
          {
            id: 'ai.models',
            label: 'Find models',
            effect: 'read',
            fields: [
              {
                name: 'search',
                label: 'Search models',
                type: 'text',
                required: false,
                maxLength: 100,
              },
            ],
            view: { scope: 'resource', label: 'Models' },
            result: 'records',
          },
        ],
      },
    ]);
    expect(id).toMatch(/^ai_[A-Za-z0-9_-]{43}$/);
    expect(await env.db.select().from(resources)).toEqual([]);
    expect(proxy).not.toHaveBeenCalled();
    expect(
      (
        await call('resources.execute', {
          resourceId: id,
          action: 'ai.test',
          input: { prompt: 'hello' },
        })
      ).status,
    ).toBe(400);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('uses only the owned proxy identity and fixed catalog options, omitting provider metadata and tokens', async () => {
    const id = await resourceId();
    const data = await payload(execute(id, { search: ' text ' }));
    expect(data).toEqual({
      appId: project.id,
      resourceId: id,
      action: 'ai.models',
      kind: 'records',
      checkedAt: expect.any(Number),
      columns: [
        { id: 'model', label: 'Model' },
        { id: 'task', label: 'Task' },
      ],
      rows: [{ id: '@cf/example/text', cells: ['@cf/example/text', 'Text Generation'] }],
      truncated: false,
    });
    expect(proxy).toHaveBeenCalledTimes(1);
    const [url, init] = proxy.mock.calls[0]!;
    expect(url).toBe('https://proxy/ai/models');
    expect(typeof init?.body).toBe('string');
    const body: unknown = JSON.parse(String(init?.body));
    expect(body).toEqual({
      projectId: project.id,
      aiToken: await deriveProxyToken(env.JWT_SECRET, project.id, 0),
      inputs: { page: 1, per_page: 100, hide_experimental: true, search: 'text' },
    });
    expect(JSON.stringify(data)).not.toContain('not-for-client');
    expect(JSON.stringify(data)).not.toContain('aiToken');
  });

  it('retains unknown task metadata as null and marks a full bounded page incomplete', async () => {
    proxy.mockResolvedValueOnce(
      Response.json(Array.from({ length: 100 }, (_, i) => ({ name: 'model-' + i }))),
    );
    const data = await payload(execute(await resourceId()));
    expect(data.truncated).toBe(true);
    expect(data.rows).toHaveLength(100);
    expect(data.rows).toContainEqual({ id: 'model-0', cells: ['model-0', null] });
  });

  it('allows an empty catalog without claiming that model execution is supported', async () => {
    proxy.mockResolvedValueOnce(Response.json([]));
    expect(await payload(execute(await resourceId()))).toMatchObject({
      kind: 'records',
      rows: [],
      truncated: false,
    });
  });

  it('rejects unsupported caller options and overlong search before proxy access', async () => {
    const id = await resourceId();
    for (const input of [
      { search: 'a'.repeat(101) },
      { search: 1 },
      { projectId: foreign.id },
      { aiToken: 'override' },
      { page: 2 },
      { model: 'fake' },
      { options: { gateway: 'fake' } },
      { tools: [] },
    ]) {
      expect((await execute(id, input)).status).toBe(400);
    }
    expect(proxy).not.toHaveBeenCalled();
  });

  it('requires the connected client, expected owner, owned project and exact AI resource', async () => {
    const id = await resourceId();
    expect((await call('projects.resources', {}, 'Basic bad')).status).toBe(401);
    for (const extra of [
      { project: foreign.id },
      { owner: { person: 'someone-else' } },
      { owner: { group: 'person' } },
    ]) {
      expect(
        (
          await call('resources.execute', {
            resourceId: id,
            action: 'ai.models',
            input: {},
            ...extra,
          })
        ).status,
      ).toBe(404);
    }
    expect((await execute('ai_foreign')).status).toBe(404);
    const otherClient = await registerOAuthClient(env.db, {
      name: 'Other',
      operator: 'Test',
      redirectUris: ['https://other.test/callback'],
      scopes: ['profile'],
    });
    expect(
      (
        await call(
          'projects.resources',
          {},
          `Basic ${btoa(`${otherClient.client.id}:${otherClient.clientSecret}`)}`,
        )
      ).status,
    ).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('omits absent, malformed and foreign manifests and private previews', async () => {
    for (const value of [
      {},
      { bindings: { ai: false } },
      { bindings: { ai: 'true' } },
      { bindings: true },
    ]) {
      await manifest(value);
      expect(await inventory()).toEqual([]);
    }
    await manifest({ bindings: { ai: true } });
    const otherDeployment = await createTestDeployment(env.db, foreign.id);
    await env.db
      .update(projects)
      .set({ active_deployment_id: otherDeployment.id })
      .where(eq(projects.id, project.id));
    expect(await inventory()).toEqual([]);
    await env.db
      .update(projects)
      .set({ active_deployment_id: null })
      .where(eq(projects.id, project.id));
    expect(await inventory()).toEqual([]);
    await env.db
      .update(projects)
      .set({
        active_deployment_id: deploymentId,
        preview_client_id: registration.client.id,
        preview_workspace_id: 'ai-workspace',
        slug: 'preview-ai-workspace',
        preview_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .where(eq(projects.id, project.id));
    expect(await inventory()).toEqual([]);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('reports disabled, disconnected and malformed installation support without a proxy call', async () => {
    const id = await resourceId();
    env.PLATFORM_CAPABILITIES = JSON.stringify({ ...getPlatformCapabilities(env), ai: false });
    expect(await payload(execute(id))).toMatchObject({
      kind: 'unavailable',
      reason: 'AI is not enabled on this installation.',
    });
    env.PLATFORM_CAPABILITIES = '{invalid';
    expect(await payload(execute(id))).toMatchObject({ kind: 'unavailable' });
    delete env.PLATFORM_CAPABILITIES;
    delete env.PLATFORM_PROXY;
    expect(await payload(execute(id))).toMatchObject({
      kind: 'unavailable',
      reason: 'The model catalog is not connected on this installation.',
    });
    expect(proxy).not.toHaveBeenCalled();
  });

  it('bounds an unresponsive proxy and does not retry', async () => {
    const stored = await getProject(env.db, project.id);
    if (!stored) {
      throw Error('Missing project');
    }
    proxy.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    const result = aiModels(env, stored);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toMatchObject({ kind: 'unavailable' });
    expect(proxy).toHaveBeenCalledTimes(1);
    expect(proxy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each([429, 501, 401, 500])(
    'reports proxy failure %s without returning private error bodies',
    async (status) => {
      proxy.mockResolvedValueOnce(
        Response.json({ message: 'provider-secret-not-for-client' }, { status }),
      );
      const data = await payload(execute(await resourceId()));
      expect(data.kind).toBe('unavailable');
      expect(JSON.stringify(data)).not.toContain('provider-secret');
      if (status === 429) {
        expect(data.reason).toContain('limit');
      }
    },
  );

  it.each([
    { result: [{ name: 'unexpected-envelope' }] },
    [{ name: '' }],
    [{ name: 'x'.repeat(201) }],
    [{ name: 'bad\nname' }],
    [{ name: 'duplicate' }, { name: 'duplicate' }],
    Array.from({ length: 101 }, (_, i) => ({ name: 'model-' + i })),
    [{ name: 'valid', privatePayload: 'x'.repeat(512 * 1024) }],
  ])('rejects malformed or oversized model payload %#', async (value) => {
    proxy.mockResolvedValueOnce(Response.json(value));
    expect(await payload(execute(await resourceId()))).toMatchObject({
      kind: 'unavailable',
      reason: 'Could not read the model catalog. Refresh and try again.',
    });
  });

  it.each(['owner', 'deployment', 'token', 'manifest'])(
    'discards a read when %s changes in flight',
    async (change) => {
      const id = await resourceId();
      proxy.mockImplementationOnce(async () => {
        if (change === 'owner') {
          const next = await createTestUser(env.db, 'next-owner');
          await env.db
            .update(projects)
            .set({ user_id: next.id })
            .where(eq(projects.id, project.id));
        } else if (change === 'deployment') {
          const next = await createTestDeployment(env.db, project.id);
          await env.db
            .update(projects)
            .set({ active_deployment_id: next.id })
            .where(eq(projects.id, project.id));
        } else if (change === 'token') {
          await env.db
            .update(projects)
            .set({ proxy_token_gen: 1 })
            .where(eq(projects.id, project.id));
        } else {
          await manifest({ bindings: { ai: true }, vars: { changed: 'yes' } });
        }
        return Response.json([{ name: 'not-returned' }]);
      });
      const response = await execute(id);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'resource_changed' });
    },
  );
});
