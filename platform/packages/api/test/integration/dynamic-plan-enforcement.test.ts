import { createDefaultPlanCatalog } from '@builtbyfriends/platform/plans';
import type { PlatformPlanCatalog } from '@builtbyfriends/platform/plans';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  claimBuildForStartWithinLimit,
  createUser,
  createUserForPlatform,
  updateUserPlan,
} from '../../src/db.ts';
import app from '../../src/index.ts';
import { writePlanCatalog } from '../../src/plans.ts';
import { builds } from '../../src/schema.ts';
import { adminHtml } from '../helpers/admin-html.tsx';
import {
  clearTables,
  createTestUser,
  createTestProject,
  setupEnv,
  teardownEnv,
  rpcData,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
});
afterAll(async () => {
  await teardownEnv();
});

function studioCatalog(): PlatformPlanCatalog {
  const catalog = createDefaultPlanCatalog();
  const source = catalog.plans.find((plan) => plan.id === 'pro')!;
  return {
    ...catalog,
    defaultPlanId: 'studio',
    plans: [
      ...catalog.plans,
      {
        ...source,
        id: 'studio',
        name: 'Studio',
        limits: {
          ...source.limits,
          requestsPerMonth: 42,
          concurrentBuilds: 1,
          buildTimeoutMinutes: 7,
        },
      },
    ],
  };
}

describe('dynamic plan enforcement', () => {
  it('assigns the configured default on hosted and self-hosted signup', async () => {
    await writePlanCatalog(env.db, studioCatalog());
    const hosted = await createUser(env.db, 'github', 'one', 'one', null);
    const installed = await env.db.transaction((tx) =>
      createUserForPlatform(tx, 'github', 'two', 'two', null, 'installation-test', {
        additionalSignupAllowed: true,
        bootstrapGitHubId: 'two',
      }),
    );
    expect(hosted.plan).toBe('studio');
    expect(installed.plan).toBe('studio');
  });

  it('shows effective limits without changing existing account plan IDs', async () => {
    const user = await createTestUser(env.db, 'studio-user', 'github', undefined, 'studio');
    await writePlanCatalog(env.db, studioCatalog());
    const response = await app.fetch(
      new Request('http://localhost/rpc/me.get', {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(rpcData(await response.json())).toMatchObject({
      plan: 'studio',
      limits: { requestsPerMonth: 42 },
    });
  });

  it('renders configured plan choices and effective limits in the administrator user page', async () => {
    await writePlanCatalog(env.db, studioCatalog());
    const admin = await createTestUser(
      env.db,
      'plan-admin',
      'github',
      undefined,
      'custom',
      'admin',
    );
    const user = await createTestUser(env.db, 'plan-customer', 'github', undefined, 'studio');
    const response = await app.fetch(
      new Request(`http://localhost/admin/users/${user.id}`, {
        headers: { Cookie: `admin_token=${admin.adminJwt}` },
      }),
      env,
    );
    expect(response.status).toBe(200);
    const html = await adminHtml(response);
    expect(html).toContain('Studio');
    expect(html).toMatch(/Requests \/ month[\s\S]*?>42</);
  });

  it.each([
    ['free', 403],
    ['pro', 200],
  ] as const)(
    'preserves short-slug eligibility when copying %s to a new plan ID',
    async (sourceId, status) => {
      const catalog = createDefaultPlanCatalog();
      const source = catalog.plans.find((plan) => plan.id === sourceId)!;
      await writePlanCatalog(env.db, {
        ...catalog,
        plans: [...catalog.plans, { ...source, id: 'copied', name: 'Copied plan' }],
      });
      const user = await createTestUser(env.db, 'copied-user', 'github', undefined, 'copied');
      const response = await app.fetch(
        new Request('http://localhost/rpc/projects.create', {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: 'tiny1' }),
        }),
        env,
      );
      expect(response.status, await response.clone().text()).toBe(status);
      if (status === 403) {
        expect(await response.json()).toMatchObject({
          error: { message: expect.stringContaining('selected plan') },
        });
      }
    },
  );

  it('rejects assigning an archived or absent plan', async () => {
    const user = await createTestUser(env.db);
    const catalog = studioCatalog();
    await writePlanCatalog(env.db, {
      ...catalog,
      defaultPlanId: 'free',
      plans: catalog.plans.map((plan) =>
        plan.id === 'studio' ? { ...plan, archived: true } : plan,
      ),
    });
    await expect(updateUserPlan(env.db, user.id, 'studio')).rejects.toThrow('archived');
    await expect(updateUserPlan(env.db, user.id, 'missing')).rejects.toThrow('Unknown plan');
  });

  it('uses dynamic concurrency and captures admitted timeout while preserving running builds', async () => {
    await writePlanCatalog(env.db, studioCatalog());
    const user = await createTestUser(env.db, 'builder', 'github', undefined, 'studio');
    const first = await createTestProject(env.db, user.id);
    const second = await createTestProject(env.db, user.id);
    await env.db.insert(builds).values([
      { id: 'build-one', user_id: user.id, project_id: first.id },
      { id: 'build-two', user_id: user.id, project_id: second.id },
    ]);
    const admitted = await claimBuildForStartWithinLimit(env.db, {
      buildId: 'build-one',
      userId: user.id,
      projectId: first.id,
    });
    expect(admitted).toMatchObject({
      timeoutMinutes: 7,
      instanceType: 'standard-4',
      ownerPlan: 'studio',
    });
    expect(
      await claimBuildForStartWithinLimit(env.db, {
        buildId: 'build-two',
        userId: user.id,
        projectId: second.id,
      }),
    ).toBeNull();
    const catalog = studioCatalog();
    await writePlanCatalog(env.db, {
      ...catalog,
      plans: catalog.plans.map((plan) =>
        plan.id === 'studio'
          ? { ...plan, limits: { ...plan.limits, concurrentBuilds: 2, buildTimeoutMinutes: 3 } }
          : plan,
      ),
    });
    const next = await claimBuildForStartWithinLimit(env.db, {
      buildId: 'build-two',
      userId: user.id,
      projectId: second.id,
    });
    expect(next).toMatchObject({ timeoutMinutes: 3 });
    expect(admitted?.timeoutMinutes).toBe(7);
    expect((await env.db.select().from(builds).where(eq(builds.id, 'build-one')))[0]?.status).toBe(
      'starting',
    );
  });
});
