import { isRecord } from '@builtbyfriends/deploy-core';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { registerOAuthClient } from '../../src/auth/oauth.ts';
import { getProject } from '../../src/db/projects.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import { appRuntimeRoutes } from '../../src/routes/app-runtime.ts';
import { deployments, projects } from '../../src/schema.ts';
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
const basic = () => `Basic ${btoa(`${registration.client.id}:${registration.clientSecret}`)}`;
const request = (input: { [key: string]: unknown } = {}, authorization = basic()) =>
  new Request('https://platform.test/app-billing/projects.releases', {
    method: 'POST',
    headers: { authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: project.id, owner: { person: 'person' }, ...input }),
  });
const call = (input: { [key: string]: unknown } = {}, authorization = basic()) =>
  app.fetch(request(input, authorization), env, createMockExecutionContext());
const payload = async (response: Promise<Response> | Response) => {
  const result = await response;
  expect(result.status).toBe(200);
  const body: unknown = await result.json();
  if (!isRecord(body) || !isRecord(body.data)) {
    throw Error('Missing release data');
  }
  return body.data;
};
const activate = (id: string | null) =>
  env.db.update(projects).set({ active_deployment_id: id }).where(eq(projects.id, project.id));

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  registration = await registerOAuthClient(env.db, {
    name: 'Release workspace',
    operator: 'Test',
    redirectUris: ['https://connected.test/callback'],
    scopes: ['profile'],
  });
  const owner = await createTestUser(env.db, 'owner', 'app:' + registration.client.id, 'person');
  const other = await createTestUser(env.db, 'foreign');
  project = await createTestProject(env.db, owner.id);
  foreign = await createTestProject(env.db, other.id);
  delete env.DEV_AUTH_BYPASS;
});

describe('owned release history', () => {
  it('returns an empty published history before deployment', async () => {
    expect(await payload(call())).toEqual({
      appId: project.id,
      checkedAt: expect.any(Number),
      environment: 'published',
      available: true,
      current: null,
      history: [],
      truncated: false,
    });
  });

  it('separates the recorded current release from a newer failed attempt and omits sensitive fields', async () => {
    const current = await createTestDeployment(env.db, project.id);
    await activate(current.id);
    await env.db
      .update(deployments)
      .set({
        created_at: '2026-11-01 12:30:40.123456',
        updated_at: '2026-11-01 12:31:40',
        deployed_at: '2026-11-01 12:31:40',
      })
      .where(eq(deployments.id, current.id));
    const failed = await createTestDeployment(
      env.db,
      project.id,
      'failed',
      'cli',
      'SECRET failure',
    );
    await env.db
      .update(deployments)
      .set({
        manifest: 'SECRET manifest',
        commit: 'SECRET commit',
        repository_url: 'https://SECRET',
        asset_hashes: 'SECRET assets',
      })
      .where(eq(deployments.id, failed.id));
    await createTestDeployment(env.db, project.id, 'pending', 'rollback-lease');
    await createTestDeployment(env.db, foreign.id);
    const data = await payload(call());
    expect(data.current).toEqual({
      id: current.id,
      status: 'live',
      createdAt: '2026-11-01T12:30:40.123Z',
      updatedAt: '2026-11-01T12:31:40.000Z',
      publishedAt: '2026-11-01T12:31:40.000Z',
    });
    expect(data.history).toEqual([
      expect.objectContaining({ id: failed.id, status: 'failed', publishedAt: null }),
      data.current,
    ]);
    expect(JSON.stringify(data)).not.toContain('SECRET');
    expect(Object.keys(data.current as { id: string })).toEqual([
      'id',
      'status',
      'createdAt',
      'updatedAt',
      'publishedAt',
    ]);
  });

  it('bounds history, orders timestamp ties by id, and includes an older current release separately', async () => {
    const current = await createTestDeployment(env.db, project.id);
    await activate(current.id);
    await env.db
      .update(deployments)
      .set({ created_at: '2020-01-01 00:00:00' })
      .where(eq(deployments.id, current.id));
    const ids: Array<string> = [];
    for (let index = 0; index < 20; index++) {
      const row = await createTestDeployment(env.db, project.id, 'failed');
      ids.push(row.id);
      await env.db
        .update(deployments)
        .set({ created_at: '2026-11-01 00:00:00' })
        .where(eq(deployments.id, row.id));
    }
    const data = await payload(call());
    expect(data.truncated).toBe(true);
    expect(data.current).toMatchObject({ id: current.id });
    expect(data.history).toEqual(
      ids
        .sort()
        .reverse()
        .map((id) => expect.objectContaining({ id })),
    );
    await env.db.delete(deployments).where(eq(deployments.id, ids[0]));
    expect((await payload(call())).truncated).toBe(false);
  });

  it.each([
    'pending',
    'uploading',
    'migrating',
    'cutover',
    'compensating',
    'canceling',
    'live',
    'failed',
    'canceled',
  ] as const)('returns the recorded %s status without claiming health', async (status) => {
    const row = await createTestDeployment(env.db, project.id, 'pending');
    await env.db.update(deployments).set({ status }).where(eq(deployments.id, row.id));
    expect((await payload(call())).history).toEqual([expect.objectContaining({ status })]);
  });

  it('requires the connected client and exact owner, including group ownership', async () => {
    expect((await call({}, '')).status).toBe(401);
    expect((await call({ owner: { person: 'wrong' } })).status).toBe(404);
    expect((await call({ project: foreign.id })).status).toBe(404);
    expect((await call({ owner: { person: 'group:team' } })).status).toBe(400);
    const owner = await createTestUser(
      env.db,
      'group',
      'app:' + registration.client.id,
      'group:team',
    );
    const group = await createTestProject(env.db, owner.id);
    expect((await payload(call({ project: group.id, owner: { group: 'team' } }))).appId).toBe(
      group.id,
    );
    const client = await registerOAuthClient(env.db, {
      name: 'Other',
      operator: 'Test',
      redirectUris: ['https://other.test/callback'],
      scopes: ['profile'],
    });
    expect(
      (await call({}, `Basic ${btoa(`${client.client.id}:${client.clientSecret}`)}`)).status,
    ).toBe(404);
  });

  it.each(['foreign', 'failed', 'lease', 'unpublished'] as const)(
    'withholds an inconsistent %s current pointer',
    async (kind) => {
      const row = await createTestDeployment(
        env.db,
        kind === 'foreign' ? foreign.id : project.id,
        kind === 'failed' ? 'failed' : 'live',
        kind === 'lease' ? 'rollback-lease' : undefined,
      );
      if (kind === 'unpublished') {
        await env.db
          .update(deployments)
          .set({ deployed_at: null })
          .where(eq(deployments.id, row.id));
      }
      await activate(row.id);
      const data = await payload(call());
      expect(data.available).toBe(false);
      expect(data.current).toBeUndefined();
      expect(data.history).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain(row.id);
    },
  );

  it('distinguishes active owned previews and rejects expired or foreign-client previews', async () => {
    await env.db
      .update(projects)
      .set({
        preview_client_id: registration.client.id,
        preview_workspace_id: 'release-workspace',
        slug: 'preview-release-workspace',
        preview_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .where(eq(projects.id, project.id));
    expect((await payload(call())).environment).toBe('preview');
    await env.db
      .update(projects)
      .set({ preview_expires_at: '2020-01-01 00:00:00' })
      .where(eq(projects.id, project.id));
    expect((await call()).status).toBe(404);
    const other = await registerOAuthClient(env.db, {
      name: 'Other preview client',
      operator: 'Test',
      redirectUris: ['https://other.test/callback'],
      scopes: ['profile'],
    });
    await env.db
      .update(projects)
      .set({
        preview_client_id: other.client.id,
        preview_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .where(eq(projects.id, project.id));
    expect((await call()).status).toBe(404);
  });

  it.each(['owner', 'deployment', 'revoked'] as const)(
    'withholds history when the %s changes during the read',
    async (change) => {
      await createTestDeployment(env.db, project.id);
      let reads = 0;
      const isolated = new Hono<ApiEnv>()
        .use('*', async (context, next) => {
          context.set('db', env.db);
          await next();
        })
        .route(
          '/app-billing',
          appRuntimeRoutes(async () => {
            const value = await getProject(env.db, project.id);
            if (++reads < 2 || !value) {
              return value;
            }
            if (change === 'revoked') {
              return null;
            }
            return {
              ...value,
              ...(change === 'owner' ? { user_id: 'other' } : { active_deployment_id: 'other' }),
            };
          }),
        );
      const data = await payload(isolated.fetch(request(), env, createMockExecutionContext()));
      expect(data.available).toBe(false);
      expect(data.history).toBeUndefined();
      expect(reads).toBe(2);
    },
  );
});
