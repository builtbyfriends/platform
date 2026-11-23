import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vite-plus/test';
import { createDomain, getProject } from '../../src/db.ts';
import { app } from '../../src/index.ts';
import { operatorEvents, projects } from '../../src/schema.ts';
import {
  clearTables,
  createOperatorToken,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
let token: string;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  const admin = await createTestUser(
    env.db,
    'takedown-admin',
    'github',
    undefined,
    'free',
    'admin',
  );
  token = await createOperatorToken(env.db, admin);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function req(path: string, body?: Record<string, unknown>) {
  return app.fetch(
    new Request(`http://localhost/operator/v1${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
  );
}

async function route(key: string) {
  return JSON.parse((await env.ROUTING.get(key))!) as { suspended?: string };
}

async function publishRoutes(project: { id: string; slug: string }, ownerId: string) {
  const value = JSON.stringify({ workerName: 'worker', projectId: project.id, userId: ownerId });
  await env.ROUTING.put(project.slug, value);
  return value;
}

test('previews a project suspend and restore without changing anything', async () => {
  const owner = await createTestUser(env.db, 'preview-owner');
  const project = await createTestProject(env.db, owner.id, 'preview-takedown');
  expect((await req(`/projects/${project.id}`)).status).toBe(200);
  const putSpy = vi.spyOn(env.ROUTING, 'put');
  const deleteSpy = vi.spyOn(env.ROUTING, 'delete');
  const suspend = await req(`/projects/${project.id}/suspend`, {
    note: 'Reported for phishing',
    dryRun: true,
  });
  expect(suspend.status).toBe(200);
  expect(await suspend.json()).toMatchObject({
    dryRun: true,
    action: 'project.suspend',
    target: { id: project.id },
    reason: 'operator_takedown',
    note: 'Reported for phishing',
    routes: [project.slug],
    effect: expect.stringContaining('Restore does not bring them back.'),
  });
  const restore = await req(`/projects/${project.id}/restore`, { dryRun: true });
  expect(await restore.json()).toMatchObject({ dryRun: true, action: 'project.restore' });
  expect(await getProject(env.db, project.id)).toMatchObject({ suspended_reason: null });
  expect(putSpy.mock.calls.map(([key]) => key)).not.toContainEqual(
    expect.not.stringContaining('fast-maintenance'),
  );
  expect(deleteSpy).not.toHaveBeenCalled();
  expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
});

test('takes one project offline, leaves its sibling serving, and restores it with an audit trail', async () => {
  const owner = await createTestUser(env.db, 'takedown-owner');
  const project = await createTestProject(env.db, owner.id, 'reported-app');
  const sibling = await createTestProject(env.db, owner.id, 'sibling-app');
  const value = await publishRoutes(project, owner.id);
  await publishRoutes(sibling, owner.id);
  await createDomain(env.db, project.id, 'reported.example.com', 'cf-host');
  await env.ROUTING.put('domain:reported.example.com', value);
  const markerKey = `project-suspended:${project.id}`;

  const suspended = await req(`/projects/${project.id}/suspend`, {
    note: 'Reported for phishing',
    operatorNote: 'Ticket 12',
  });
  expect(suspended.status).toBe(200);
  expect(await getProject(env.db, project.id)).toMatchObject({
    suspended_reason: 'operator_takedown',
    suspended_note: 'Reported for phishing',
  });
  expect((await route(project.slug)).suspended).toBe('operator_takedown');
  expect((await route('domain:reported.example.com')).suspended).toBe('operator_takedown');
  expect(await env.ROUTING.get(markerKey)).toBe('operator_takedown');
  expect((await route(sibling.slug)).suspended).toBeUndefined();
  expect(await env.ROUTING.get(`project-suspended:${sibling.id}`)).toBeNull();

  expect((await req(`/projects/${project.id}/restore`, {})).status).toBe(200);
  expect(await getProject(env.db, project.id)).toMatchObject({
    suspended_reason: null,
    suspended_note: null,
  });
  expect((await route(project.slug)).suspended).toBeUndefined();
  expect((await route('domain:reported.example.com')).suspended).toBeUndefined();
  expect(await env.ROUTING.get(markerKey)).toBeNull();

  const events = await env.db.select().from(operatorEvents);
  expect(events.map((event) => [event.action, event.status])).toEqual(
    expect.arrayContaining([
      [`projects/${project.id}/suspend`, 'success'],
      [`projects/${project.id}/restore`, 'success'],
    ]),
  );
  const suspendEvent = events.find((event) => event.action.endsWith('/suspend'))!;
  expect(JSON.parse(suspendEvent.target)).toEqual({
    projectId: project.id,
    note: 'Reported for phishing',
    operatorNote: 'Ticket 12',
  });
});

test("keeps a project takedown through the owner's suspension, restore and plan change", async () => {
  const owner = await createTestUser(env.db, 'account-owner');
  const project = await createTestProject(env.db, owner.id, 'held-app');
  const other = await createTestProject(env.db, owner.id, 'released-app');
  await publishRoutes(project, owner.id);
  await publishRoutes(other, owner.id);
  expect((await req(`/projects/${project.id}/suspend`, {})).status).toBe(200);

  expect((await req(`/users/${owner.id}/suspend`, { reason: 'review' })).status).toBe(200);
  const restorePreview = await (await req(`/users/${owner.id}/restore`, { dryRun: true })).json();
  expect(restorePreview).toMatchObject({
    projectsStillSuspended: [{ id: project.id, reason: 'operator_takedown' }],
  });
  expect((await req(`/users/${owner.id}/restore`, {})).status).toBe(200);
  expect((await route(project.slug)).suspended).toBe('operator_takedown');
  expect(await env.ROUTING.get(`project-suspended:${project.id}`)).toBe('operator_takedown');
  expect((await route(other.slug)).suspended).toBeUndefined();

  expect((await req(`/users/${owner.id}/plan`, { plan: 'pro' })).status).toBe(200);
  expect((await route(project.slug)).suspended).toBe('operator_takedown');
});

test('restoring a project keeps it offline while its owner is suspended', async () => {
  const owner = await createTestUser(env.db, 'suspended-owner');
  const project = await createTestProject(env.db, owner.id, 'owner-held-app');
  await publishRoutes(project, owner.id);
  expect((await req(`/projects/${project.id}/suspend`, {})).status).toBe(200);
  expect((await req(`/users/${owner.id}/suspend`, { reason: 'review' })).status).toBe(200);

  const restored = await req(`/projects/${project.id}/restore`, {});
  expect(await restored.json()).toMatchObject({ ownerSuspended: true });
  expect((await route(project.slug)).suspended).toBe('review');
  expect(await env.ROUTING.get(`project-suspended:${project.id}`)).toBe('review');
});

test('refuses to suspend a project that is being deleted', async () => {
  const owner = await createTestUser(env.db, 'deleting-owner');
  const project = await createTestProject(env.db, owner.id, 'deleting-app');
  await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
  expect((await req(`/projects/${project.id}/suspend`, {})).status).toBe(409);
  expect((await req(`/projects/missing/suspend`, { dryRun: true })).status).toBe(404);
});

test('finds a project from its platform address or a custom domain', async () => {
  const owner = await createTestUser(env.db, 'search-owner');
  const project = await createTestProject(env.db, owner.id, 'found-app');
  await createTestProject(env.db, owner.id, 'other-app');
  await createDomain(env.db, project.id, 'shop.example.org', 'cf-search');
  for (const search of [
    'shop.example.org',
    'https://shop.example.org/some/page?x=1',
    'https://found-app.example.net/',
  ]) {
    const response = await req(`/projects?search=${encodeURIComponent(search)}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { projects: Array<{ id: string }> };
    expect(body.projects.map((p) => p.id)).toEqual([project.id]);
  }
});
