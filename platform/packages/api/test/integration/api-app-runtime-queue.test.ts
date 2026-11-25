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
import app from '../../src/index.ts';
import { getProjectDeploymentWorkerName, getProjectQueueName } from '../../src/naming.ts';
import { deriveProxyToken } from '../../src/proxy-token.ts';
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
let project: { id: string; slug: string };
let foreign: { id: string; slug: string };
let route: string;
let name: string;
const queueId = 'a'.repeat(32);
const provider = vi.fn<typeof fetch>();
const metrics = {
  backlog_count: 4,
  backlog_bytes: 100,
  oldest_message_timestamp_ms: 1_700_000_000_000,
};
const queue = () => ({
  queue_id: queueId,
  queue_name: name,
  settings: { delivery_paused: false },
  secret: 'provider-private',
});
const consumers = () => [
  {
    type: 'worker',
    script: 'platform-dispatch',
    consumer_id: 'private-consumer',
    settings: { max_retries: 3, retry_delay: 30, batch_size: 10, max_wait_time_ms: 5000 },
  },
];
const ok = (result: unknown) => Response.json({ success: true, result });
function respond(input: RequestInfo | URL) {
  const path = new URL(String(input)).pathname;
  return Promise.resolve(
    ok(path.endsWith('/metrics') ? metrics : path.endsWith('/consumers') ? consumers() : queue()),
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
        resourceId: 'res_queue',
        owner: { person: 'person' },
        action: 'queue.status',
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
    name: 'Queue test',
    operator: 'Test',
    redirectUris: ['https://app.test/callback'],
    scopes: ['profile'],
  });
  const owner = await createTestUser(env.db, 'queue-owner', APP + registration.client.id, 'person');
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
      id: 'res_queue',
      project_id: project.id,
      type: 'queue',
      cf_id: queueId,
      binding_name: 'jobs',
    },
    {
      id: 'res_other',
      project_id: foreign.id,
      type: 'queue',
      cf_id: 'b'.repeat(32),
      binding_name: 'jobs',
    },
  ]);
  name = getProjectQueueName(project.id, 'jobs');
  route = JSON.stringify({
    projectId: project.id,
    queueName: 'jobs',
    workerName: getProjectDeploymentWorkerName(project.slug, deployment.id),
    proxyToken: await deriveProxyToken(env.JWT_SECRET, project.id, 0),
  });
  await env.ROUTING.put(`queue:${name}`, route);
  provider.mockReset().mockImplementation(respond);
  vi.stubGlobal('fetch', provider);
  delete env.DEV_AUTH_BYPASS;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('owned queue status', () => {
  it('advertises a read-only action without a storage proxy and returns bounded public status', async () => {
    expect(await payload(call({}, 'projects.resources'))).toMatchObject({
      data: {
        resources: [
          {
            id: 'res_queue',
            actions: [
              { id: 'queue.status', effect: 'read', fields: [], result: 'queue-status' },
              {
                id: 'queue.pause',
                effect: 'write',
                fields: [
                  {
                    name: 'expectedDelivery',
                    label: 'Current delivery state',
                    type: 'text',
                    required: true,
                    maxLength: 7,
                  },
                ],
                result: 'queue-status',
              },
              {
                id: 'queue.resume',
                effect: 'write',
                fields: [
                  {
                    name: 'expectedDelivery',
                    label: 'Current delivery state',
                    type: 'text',
                    required: true,
                    maxLength: 7,
                  },
                ],
                result: 'queue-status',
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
        resourceId: 'res_queue',
        action: 'queue.status',
        kind: 'queue-status',
        checkedAt: expect.any(Number),
        delivery: 'running',
        backlog: { count: 4, bytes: 100, oldestMessageAt: metrics.oldest_message_timestamp_ms },
        consumer: {
          connected: true,
          retryAttempts: 3,
          retryDelaySeconds: 30,
          batchSize: 10,
          batchWaitSeconds: 5,
          maxConcurrency: null,
        },
      },
    });
    for (const secret of [
      queueId,
      name,
      'platform-dispatch',
      'private-consumer',
      'provider-private',
      env.CF_API_TOKEN,
    ]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(provider).toHaveBeenCalledTimes(3);
    for (const [url, init] of provider.mock.calls) {
      expect(String(url)).toMatch(new RegExp(`/queues/${queueId}(/consumers|/metrics)?$`));
      expect(init?.method ?? 'GET').toBe('GET');
    }
  });
  it('reports pause and an observed empty backlog without inventing optional settings', async () => {
    provider.mockImplementation(async (input) =>
      ok(
        String(input).endsWith('/metrics')
          ? { backlog_count: 0, backlog_bytes: 0 }
          : String(input).endsWith('/consumers')
            ? [{ type: 'worker', script: 'platform-dispatch', settings: {} }]
            : { ...queue(), settings: { delivery_paused: true } },
      ),
    );
    expect(await payload(call())).toMatchObject({
      data: {
        delivery: 'paused',
        backlog: { count: 0, bytes: 0, oldestMessageAt: null },
        consumer: { retryAttempts: null, batchSize: null },
      },
    });
  });
  it.each([
    null,
    { backlog_count: -1, backlog_bytes: 0 },
    { ...metrics, backlog_bytes: Infinity },
    { ...metrics, oldest_message_timestamp_ms: -1 },
    { ...metrics, oldest_message_timestamp_ms: null },
  ])('keeps unavailable measurements distinct from zero (%j)', async (value) => {
    provider.mockImplementation(async (input) =>
      String(input).endsWith('/metrics') ? ok(value) : respond(input),
    );
    expect(await payload(call())).toMatchObject({
      data: { kind: 'queue-status', delivery: 'running', backlog: null },
    });
  });
  it('keeps verified settings when the metrics endpoint fails without exposing provider errors', async () => {
    provider.mockImplementation(async (input) =>
      String(input).endsWith('/metrics')
        ? Response.json(
            { success: false, errors: [{ code: 403, message: 'private-provider-error' }] },
            { status: 403 },
          )
        : respond(input),
    );
    const result = await payload(call());
    expect(result).toMatchObject({ data: { kind: 'queue-status', backlog: null } });
    expect(JSON.stringify(result)).not.toContain('private-provider-error');
  });
  it('rejects other owners, projects, resources and user-supplied provider selectors before fetching', async () => {
    expect((await call({ owner: { person: 'other' } })).status).toBe(404);
    expect((await call({ project: foreign.id })).status).toBe(404);
    expect((await call({ resourceId: 'res_other' })).status).toBe(404);
    expect((await call({ input: { queueId } })).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });
  it('retains fractional batch wait seconds', async () => {
    provider.mockImplementation(async (input) =>
      String(input).endsWith('/consumers')
        ? ok([{ ...consumers()[0], settings: { max_wait_time_ms: 1500 } }])
        : respond(input),
    );
    expect(await payload(call())).toMatchObject({ data: { consumer: { batchWaitSeconds: 1.5 } } });
  });
  it('keeps known backlog counts when the oldest timestamp is unknown and concurrency is automatic', async () => {
    provider.mockImplementation(async (input) => {
      if (String(input).endsWith('/metrics')) {
        return ok({ ...metrics, oldest_message_timestamp_ms: 0 });
      }
      if (String(input).endsWith('/consumers')) {
        return ok([{ ...consumers()[0], settings: { max_concurrency: null, max_retries: 3 } }]);
      }
      return respond(input);
    });
    expect(await payload(call())).toMatchObject({
      data: {
        kind: 'queue-status',
        backlog: { count: 4, bytes: 100, oldestMessageAt: null },
        consumer: { maxConcurrency: null, retryAttempts: 3 },
      },
    });
  });
  it('returns verified settings within the caller deadline when metrics stalls', async () => {
    provider.mockImplementation((input, init) => {
      if (!String(input).endsWith('/metrics')) {
        return respond(input);
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Metrics timed out.')), {
          once: true,
        });
      });
    });
    const started = Date.now();
    expect(await payload(call())).toMatchObject({ data: { kind: 'queue-status', backlog: null } });
    expect(Date.now() - started).toBeLessThan(7500);
  });
  it('keeps verified status when the provider omits delivery state and the concurrency cap', async () => {
    provider.mockImplementation(async (input) => {
      if (String(input).endsWith('/metrics')) {
        return ok({ backlog_count: 0, backlog_bytes: 0, oldest_message_timestamp_ms: 0 });
      }
      if (String(input).endsWith('/consumers')) {
        return ok([{ ...consumers()[0], settings: { max_retries: 3 } }]);
      }
      return ok({ ...queue(), settings: { delivery_delay: 0, message_retention_period: 345_600 } });
    });
    expect(await payload(call())).toMatchObject({
      data: {
        kind: 'queue-status',
        delivery: 'unknown',
        backlog: { count: 0, bytes: 0, oldestMessageAt: null },
        consumer: { connected: true, maxConcurrency: null, retryAttempts: 3 },
      },
    });
  });
  it.each(['unpublished', 'preview'])(
    'does not advertise or read queue status for %s apps',
    async (kind) => {
      await env.db
        .update(projects)
        .set(
          kind === 'unpublished'
            ? { active_deployment_id: null }
            : {
                slug: 'preview-queue-test',
                preview_client_id: registration.client.id,
                preview_workspace_id: 'workspace-test',
                preview_expires_at: new Date(Date.now() + 60_000).toISOString(),
              },
        )
        .where(eq(projects.id, project.id));
      expect(await payload(call({}, 'projects.resources'))).toMatchObject({
        data: { resources: [{ actions: [] }] },
      });
      expect(await payload(call())).toMatchObject({ data: { kind: 'unavailable' } });
      expect(provider).not.toHaveBeenCalled();
    },
  );
  it.each(['missing', 'project', 'worker', 'token', 'logical-name', 'legacy-id'])(
    'refuses unverified routing or queue identity (%s)',
    async (change) => {
      const parsed = JSON.parse(route);
      if (change === 'missing') {
        await env.ROUTING.delete(`queue:${name}`);
      } else if (change === 'legacy-id') {
        await env.db.update(resources).set({ cf_id: name }).where(eq(resources.id, 'res_queue'));
      } else {
        if (change === 'project') {
          parsed.projectId = foreign.id;
        }
        if (change === 'worker') {
          parsed.workerName = 'other-worker';
        }
        if (change === 'token') {
          parsed.proxyToken = 'other-token';
        }
        if (change === 'logical-name') {
          parsed.queueName = 'other-job';
        }
        await env.ROUTING.put(`queue:${name}`, JSON.stringify(parsed));
      }
      expect(await payload(call())).toMatchObject({ data: { kind: 'unavailable' } });
      expect(provider).not.toHaveBeenCalled();
    },
  );
  it.each(['name', 'id', 'pause', 'consumer', 'missing-consumer', 'settings', 'provider-error'])(
    'refuses ambiguous provider configuration (%s)',
    async (change) => {
      provider.mockImplementation(async (input) => {
        if (change === 'provider-error') {
          return Response.json(
            { success: false, errors: [{ code: 503, message: 'secret provider detail' }] },
            { status: 503 },
          );
        }
        if (String(input).endsWith('/consumers')) {
          return ok(
            change === 'missing-consumer'
              ? []
              : change === 'consumer'
                ? [{ ...consumers()[0], script: 'foreign-dispatch' }]
                : change === 'settings'
                  ? [{ ...consumers()[0], settings: { max_retries: -1 } }]
                  : consumers(),
          );
        }
        return ok(
          change === 'name'
            ? { ...queue(), queue_name: 'foreign-queue' }
            : change === 'id'
              ? { ...queue(), queue_id: 'b'.repeat(32) }
              : change === 'pause'
                ? { ...queue(), settings: { delivery_paused: 'false' } }
                : queue(),
        );
      });
      const result = await payload(call());
      expect(result).toMatchObject({ data: { kind: 'unavailable' } });
      expect(JSON.stringify(result)).not.toContain('secret provider detail');
      expect(provider.mock.calls.some(([url]) => String(url).endsWith('/metrics'))).toBe(false);
    },
  );
  it.each(['routing', 'binding', 'type', 'owner', 'deployment'])(
    'withholds stale status when %s changes during measurement',
    async (change) => {
      provider.mockImplementation(async (input) => {
        if (String(input).endsWith('/metrics')) {
          if (change === 'type') {
            await env.db.update(resources).set({ type: 'r2' }).where(eq(resources.id, 'res_queue'));
          }
          if (change === 'routing') {
            await env.ROUTING.put(`queue:${name}`, '{}');
          }
          if (change === 'binding') {
            await env.db
              .update(resources)
              .set({ cf_id: 'b'.repeat(32) })
              .where(eq(resources.id, 'res_queue'));
          }
          if (change === 'owner') {
            await env.db
              .update(projects)
              .set({ user_id: (await createTestUser(env.db, 'changed-owner')).id })
              .where(eq(projects.id, project.id));
          }
          if (change === 'deployment') {
            await env.db
              .update(projects)
              .set({ active_deployment_id: null })
              .where(eq(projects.id, project.id));
          }
        }
        return respond(input);
      });
      const result = await call();
      if (change === 'routing') {
        expect(await result.json()).toMatchObject({ data: { kind: 'unavailable' } });
      } else {
        expect(result.status).toBe(409);
      }
    },
  );
});

function delivery(initial: boolean | undefined = false) {
  let paused = initial;
  const patches: Array<unknown> = [];
  provider.mockImplementation(async (input, init) => {
    if (init?.method === 'PATCH') {
      const change = JSON.parse(String(init.body));
      patches.push(change);
      paused = change.settings.delivery_paused;
      return ok(queue());
    }
    if (String(input).endsWith('/consumers')) {
      return ok(consumers());
    }
    if (String(input).endsWith('/metrics')) {
      return ok(metrics);
    }
    return ok({
      ...queue(),
      settings: { delivery_paused: paused, delivery_delay: 27, message_retention_period: 604_800 },
    });
  });
  return patches;
}
const changeDelivery = (action: 'queue.pause' | 'queue.resume' = 'queue.pause') =>
  call({ action, input: { expectedDelivery: action === 'queue.pause' ? 'running' : 'paused' } });

describe('owned queue delivery changes', () => {
  it.each(['queue.pause', 'queue.resume'] as const)(
    'patches only delivery_paused once and returns a fresh verified %s snapshot',
    async (action) => {
      const patches = delivery(action === 'queue.resume');
      const result = await payload(changeDelivery(action));
      expect(result).toMatchObject({
        data: {
          appId: project.id,
          resourceId: 'res_queue',
          action,
          kind: 'queue-status',
          delivery: action === 'queue.pause' ? 'paused' : 'running',
          backlog: null,
          consumer: { connected: true },
        },
      });
      expect(patches).toEqual([{ settings: { delivery_paused: action === 'queue.pause' } }]);
      expect(provider.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
      expect(
        provider.mock.calls.filter(
          ([url, init]) => (init?.method ?? 'GET') === 'GET' && !String(url).endsWith('/consumers'),
        ),
      ).toHaveLength(2);
      expect(provider.mock.calls.some(([url]) => String(url).endsWith('/metrics'))).toBe(false);
      for (const privateValue of [queueId, name, 'platform-dispatch', env.CF_API_TOKEN]) {
        expect(JSON.stringify(result)).not.toContain(privateValue);
      }
    },
  );
  it.each([
    {},
    { expectedDelivery: 'unknown' },
    { expectedDelivery: 'paused' },
    { expectedDelivery: true },
    { expectedDelivery: 'running', queueId },
    { expectedDelivery: 'running', delivery_paused: true },
  ])('rejects invalid pause input without a provider call (%j)', async (input) => {
    expect((await call({ action: 'queue.pause', input })).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });
  it('requires paused as the expected state for resume', async () => {
    expect(
      (await call({ action: 'queue.resume', input: { expectedDelivery: 'running' } })).status,
    ).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });
  it.each([true, undefined])(
    'does not patch when the delivery state changed or is unknown (%s)',
    async (state) => {
      const patches = delivery();
      provider.mockImplementation(async (input) =>
        String(input).endsWith('/consumers')
          ? ok(consumers())
          : ok({ ...queue(), settings: { delivery_paused: state } }),
      );
      expect(await payload(changeDelivery())).toMatchObject({ data: { kind: 'conflict' } });
      expect(patches).toEqual([]);
      expect(provider.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    },
  );
  it.each(['owner', 'resource', 'preview', 'unpublished', 'route', 'consumer', 'queue-name'])(
    'refuses %s mismatch before a write',
    async (change) => {
      const patches = delivery();
      if (change === 'preview') {
        await env.db
          .update(projects)
          .set({
            slug: 'preview-queue-write-test',
            preview_client_id: registration.client.id,
            preview_workspace_id: 'workspace-test',
            preview_expires_at: new Date(Date.now() + 60_000).toISOString(),
          })
          .where(eq(projects.id, project.id));
      }
      if (change === 'unpublished') {
        await env.db
          .update(projects)
          .set({ active_deployment_id: null })
          .where(eq(projects.id, project.id));
      }
      if (change === 'route') {
        await env.ROUTING.put(
          `queue:${name}`,
          JSON.stringify({ ...JSON.parse(route), projectId: foreign.id }),
        );
      }
      if (change === 'consumer' || change === 'queue-name') {
        provider.mockImplementation(async (input) =>
          String(input).endsWith('/consumers')
            ? ok([
                {
                  ...consumers()[0],
                  script: change === 'consumer' ? 'other-dispatch' : 'platform-dispatch',
                },
              ])
            : ok({ ...queue(), queue_name: change === 'queue-name' ? 'other-queue' : name }),
        );
      }
      const response = await call({
        action: 'queue.pause',
        input: { expectedDelivery: 'running' },
        owner: { person: change === 'owner' ? 'other' : 'person' },
        resourceId: change === 'resource' ? 'res_other' : 'res_queue',
      });
      if (change === 'owner' || change === 'resource') {
        expect(response.status).toBe(404);
      } else {
        expect(await response.json()).toMatchObject({ data: { kind: 'unavailable' } });
      }
      expect(patches).toEqual([]);
      expect(provider.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    },
  );
  it.each(['route', 'owner', 'binding', 'deployment'])(
    'rechecks %s after preflight and before PATCH',
    async (change) => {
      const otherOwner = await createTestUser(env.db, 'new-owner');
      provider.mockImplementation(async (input) => {
        if (String(input).endsWith('/consumers')) {
          if (change === 'route') {
            await env.ROUTING.put(`queue:${name}`, '{}');
          }
          if (change === 'owner') {
            await env.db
              .update(projects)
              .set({ user_id: otherOwner.id })
              .where(eq(projects.id, project.id));
          }
          if (change === 'binding') {
            await env.db
              .update(resources)
              .set({ cf_id: 'b'.repeat(32) })
              .where(eq(resources.id, 'res_queue'));
          }
          if (change === 'deployment') {
            await env.db
              .update(projects)
              .set({ active_deployment_id: null })
              .where(eq(projects.id, project.id));
          }
          return ok(consumers());
        }
        return ok(queue());
      });
      expect(await payload(changeDelivery())).toMatchObject({ data: { kind: 'unavailable' } });
      expect(provider.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    },
  );
  it.each([
    'timeout',
    'rejected',
    'malformed',
    'wrong-state',
    'route',
    'owner',
    'binding',
    'deployment',
    'verification-failure',
  ])('reports unknown without retry after an uncertain write (%s)', async (change) => {
    const otherOwner = await createTestUser(env.db, 'post-write-owner');
    let attempted = false;
    provider.mockImplementation(async (input, init) => {
      if (init?.method === 'PATCH') {
        attempted = true;
        if (change === 'timeout') {
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('timeout')), {
              once: true,
            });
          });
        }
        if (change === 'rejected') {
          return Response.json(
            { success: false, errors: [{ message: 'provider-private-error' }] },
            { status: 503 },
          );
        }
        if (change === 'malformed') {
          return new Response('invalid-json');
        }
        if (change === 'route') {
          await env.ROUTING.put(`queue:${name}`, '{}');
        }
        if (change === 'owner') {
          await env.db
            .update(projects)
            .set({ user_id: otherOwner.id })
            .where(eq(projects.id, project.id));
        }
        if (change === 'binding') {
          await env.db
            .update(resources)
            .set({ cf_id: 'b'.repeat(32) })
            .where(eq(resources.id, 'res_queue'));
        }
        if (change === 'deployment') {
          await env.db
            .update(projects)
            .set({ active_deployment_id: null })
            .where(eq(projects.id, project.id));
        }
        return ok(queue());
      }
      if (attempted && change === 'verification-failure') {
        throw new Error('provider-private-error');
      }
      return String(input).endsWith('/consumers')
        ? ok(consumers())
        : ok({ ...queue(), settings: { delivery_paused: attempted && change !== 'wrong-state' } });
    });
    const start = Date.now();
    const result = await payload(changeDelivery());
    expect(result).toMatchObject({
      data: { kind: 'unknown', reason: expect.stringContaining('Refresh queue status') },
    });
    expect(JSON.stringify(result)).not.toContain('provider-private-error');
    expect(provider.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    expect(Date.now() - start).toBeLessThan(9000);
  });
  it('stops before PATCH when provider preflight times out', async () => {
    provider.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), {
            once: true,
          });
        }),
    );
    const start = Date.now();
    expect(await payload(changeDelivery())).toMatchObject({ data: { kind: 'unavailable' } });
    expect(provider.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    expect(Date.now() - start).toBeLessThan(9000);
  });
});
