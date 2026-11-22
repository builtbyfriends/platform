import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vite-plus/test';
import { billedAccountPlanId, billedPlanId, billedPlanLimits } from '../../src/app-payer.ts';
import { registerOAuthClient, setOAuthPreviewPermission } from '../../src/auth/oauth.ts';
import rawApp from '../../src/index.ts';
import { resolvePlanLimits } from '../../src/plans.ts';
import { APP_PERSON_GRANT } from '../../src/routes/oauth-app-person.ts';
import { projects, users } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createMockExecutionContext,
  rpcData,
  withLegacyDeploy,
  type TestEnv,
} from './helpers.ts';

const app = withLegacyDeploy(rawApp);
const origin = 'https://platform.example.com';
const ctx = createMockExecutionContext();
let env: TestEnv & {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_SOLO?: string;
};
let registration: Awaited<ReturnType<typeof registerOAuthClient>>;

const basic = () => 'Basic ' + btoa(registration.client.id + ':' + registration.clientSecret);
type Hosted = {
  requests: number;
  projects: Array<{ projectId: string; slug: string; person: string }>;
};
type Answer = {
  hosted?: Hosted | null;
  breakdown: Array<{ model: string; source: string; aiNeurons: number; sandboxSeconds: number }>;
  caps: { aiNeuronsPerMonth: number };
  aiNeuronsUsed: number;
  used: { aiNeurons: number };
  billingPeriodStart: string;
  url: string;
};
const dataOf = async (response: Response | Promise<Response>) =>
  rpcData<Answer>(await (await response).json());

async function call(path: string, body: unknown, authorization = basic()) {
  return app.fetch(
    new Request(origin + '/app-billing' + path, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

async function preview(person: string, body: Record<string, unknown>) {
  (env as unknown as Record<string, string>).PLATFORM_APP_PERSON_CLIENTS = registration.client.id;
  await setOAuthPreviewPermission(env.db, registration.client.id, true);
  const issued = await app.fetch(
    new Request(origin + '/oauth/token', {
      method: 'POST',
      headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: APP_PERSON_GRANT, person }),
    }),
    env,
    ctx,
  );
  const { access_token } = (await issued.json()) as { access_token: string };
  const response = await app.fetch(
    new Request(origin + '/app-rpc/previews.create', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  if (response.status !== 200) {
    return { status: response.status, project: null, owner: null };
  }
  const { project_id } = rpcData<{ project_id: string }>(await response.json());
  const [project] = await env.db.select().from(projects).where(eq(projects.id, project_id));
  const [owner] = await env.db.select().from(users).where(eq(users.id, project!.user_id));
  return { status: 200, project: project!, owner: owner! };
}

// Decision: The dev bypass answers with zeros, which keeps the analytics backend out of the test.
async function hosted(person: string) {
  env.DEV_AUTH_BYPASS = 'true';
  try {
    return (await dataOf(call('/usage.status', { person, hosted: true }))).hosted;
  } finally {
    delete env.DEV_AUTH_BYPASS;
  }
}

async function webhook(event: unknown, secret = 'whsec_test') {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`));
  const v1 = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
  return app.fetch(
    new Request(origin + '/billing/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': `t=${t},v1=${v1}` },
      body,
    }),
    env,
    ctx,
  );
}

describe('app billing', () => {
  beforeAll(async () => {
    env = await setupEnv();
    env.STRIPE_SECRET_KEY = 'sk_test_x';
    env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    env.STRIPE_PRICE_SOLO = 'price_solo';
  });
  afterAll(teardownEnv);
  beforeEach(async () => {
    await clearTables(env.db);
    registration = await registerOAuthClient(env.db, {
      name: 'Example',
      operator: 'Example Co',
      redirectUris: ['https://example.com/callback'],
      scopes: ['profile'],
    });
  });

  it('needs the application to sign in', async () => {
    expect((await call('/usage.status', { person: 'p1' }, 'Basic bm9wZTpub3Bl')).status).toBe(401);
  });

  it('starts a person on the default plan, counts their use once per id, and flags the cap for them alone', async () => {
    const first = await dataOf(call('/usage.status', { person: 'p1' }));
    expect(first).toMatchObject({ plan: 'free', withinCaps: true, used: { aiNeurons: 0 } });

    const cap = first.caps.aiNeuronsPerMonth as number;
    const hit = await dataOf(call('/usage.record', { person: 'p1', id: 'e1', aiNeurons: cap }));
    expect(hit).toMatchObject({ aiNeuronsUsed: cap, withinCaps: false });

    const again = await dataOf(call('/usage.record', { person: 'p1', id: 'e1', aiNeurons: cap }));
    expect(again.aiNeuronsUsed).toBe(cap);
    const other = await dataOf(call('/usage.status', { person: 'p2' }));
    expect(other).toMatchObject({ withinCaps: true, aiWithinCap: true, used: { aiNeurons: 0 } });
    expect(await dataOf(call('/usage.status', { person: 'p1' }))).toMatchObject({
      aiWithinCap: false,
      sandboxWithinCap: true,
    });
  });

  it('keeps one application away from another one’s people', async () => {
    await call('/usage.record', { person: 'p1', aiNeurons: 5 });
    const second = await registerOAuthClient(env.db, {
      name: 'Other',
      operator: 'Other Co',
      redirectUris: ['https://other.example/callback'],
      scopes: ['profile'],
    });
    const asOther = 'Basic ' + btoa(second.client.id + ':' + second.clientSecret);
    const seen = await dataOf(call('/usage.status', { person: 'p1' }, asOther));
    expect(seen.used.aiNeurons).toBe(0);
  });

  it('refuses bad input', async () => {
    expect((await call('/usage.record', { aiNeurons: 1 })).status).toBe(400);
    expect((await call('/usage.record', { person: 'p1', aiNeurons: -1 })).status).toBe(400);
    expect(
      (await call('/billing.checkout', { person: 'p1', plan: 'solo', returnUrl: 'http://x.test' }))
        .status,
    ).toBe(400);
  });

  it('moves a person to the plan they bought and back when the subscription ends', async () => {
    const periodEnd = Date.UTC(2026, 11, 19, 12) / 1000;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === 'https://api.stripe.com/v1/subscriptions/sub_1') {
        return Response.json({ id: 'sub_1', items: { data: [{ current_period_end: periodEnd }] } });
      }
      if (String(input).startsWith('https://api.stripe.com/')) {
        return Response.json({ url: 'https://stripe.example/session' });
      }
      return Response.error();
    });
    const checkout = await call('/billing.checkout', {
      person: 'p1',
      plan: 'solo',
      returnUrl: 'https://example.com/plan',
    });
    expect((await dataOf(checkout)).url).toBe('https://stripe.example/session');
    expect(
      (await call('/billing.portal', { person: 'p1', returnUrl: 'https://example.com/plan' }))
        .status,
    ).toBe(404);

    const metadata = { clientId: registration.client.id, personId: 'p1', plan: 'solo' };
    expect(
      (
        await webhook({
          type: 'checkout.session.completed',
          data: { object: { metadata, customer: 'cus_1', subscription: 'sub_1' } },
        })
      ).status,
    ).toBe(200);
    const bought = await dataOf(call('/usage.status', { person: 'p1' }));
    expect(bought).toMatchObject({
      plan: 'solo',
      subscribed: true,
      renewsAt: '2026-12-19T12:00:00.000Z',
    });
    expect(bought).not.toHaveProperty('subscriptionId');
    expect(bought.billingPeriodStart).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    const portal = await call('/billing.portal', {
      person: 'p1',
      returnUrl: 'https://example.com/plan',
    });
    expect((await dataOf(portal)).url).toBe('https://stripe.example/session');
    fetchSpy.mockRestore();

    const offline = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.error());
    const unreachable = await dataOf(call('/usage.status', { person: 'p1' }));
    expect(unreachable).toMatchObject({ plan: 'solo', subscribed: true });
    expect(unreachable).not.toHaveProperty('renewsAt');
    offline.mockRestore();

    await webhook({ type: 'customer.subscription.deleted', data: { object: { metadata } } });
    const ended = await dataOf(call('/usage.status', { person: 'p1' }));
    expect(ended).toMatchObject({ plan: 'free', subscribed: false });
    expect(ended).not.toHaveProperty('renewsAt');
  });

  it('bills an old caller’s project to the person it was built for', async () => {
    const { project } = await preview('p1', { workspace: 'w1' });
    expect(project!.payer_person_id).toBeNull();
    expect(await dataOf(call('/usage.status', { person: 'p1' }))).not.toHaveProperty('hosted');
    expect(await hosted('p1')).toMatchObject({
      requests: 0,
      projects: [{ projectId: project!.id, slug: project!.slug, person: 'p1' }],
    });
  });

  it('bills a project to the payer the application names', async () => {
    expect((await preview('p1', { workspace: 'w1', payer: 'stranger' })).status).toBe(400);
    await call('/usage.record', { person: 'boss', aiNeurons: 1 });
    const { project } = await preview('p1', { workspace: 'w1', payer: 'boss' });
    expect(project!.payer_person_id).toBe('boss');
    expect((await hosted('boss'))!.projects).toEqual([
      expect.objectContaining({ projectId: project!.id, person: 'p1' }),
    ]);
    expect((await hosted('p1'))!.projects).toEqual([]);
  });

  it('leaves the hosted numbers out when the analytics backend is down', async () => {
    await preview('p1', { workspace: 'w1' });
    const offline = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.error());
    const answer = await dataOf(call('/usage.status', { person: 'p1', hosted: true }));
    offline.mockRestore();
    expect(answer).toMatchObject({ plan: 'free', hosted: null });
  });

  it('raises a hosted app’s limits when its payer buys a plan', async () => {
    await call('/usage.record', { person: 'boss', aiNeurons: 1 });
    const paid = await preview('p1', { workspace: 'w1', payer: 'boss' });
    const own = await preview('p1', { workspace: 'w2' });
    expect(await billedPlanId(env.db, paid.owner!, paid.project!)).toBe('free');

    const metadata = { clientId: registration.client.id, personId: 'boss', plan: 'solo' };
    await webhook({
      type: 'checkout.session.completed',
      data: { object: { metadata, customer: 'cus_1', subscription: 'sub_1' } },
    });
    const solo = await resolvePlanLimits(env.db, 'solo');
    expect(await billedPlanLimits(env.db, paid.owner!, paid.project!)).toEqual(solo);
    expect(solo.requestsPerMonth).not.toBe(
      (await resolvePlanLimits(env.db, 'free')).requestsPerMonth,
    );
    expect(await billedPlanId(env.db, own.owner!, own.project!)).toBe('free');
    expect(paid.owner!.plan).toBe('free');
    // Decision: The owner's two projects have different payers, so the shared monthly meters stay on the owner's plan.
    expect(await billedAccountPlanId(env.db, paid.owner!)).toBe('free');
    await env.db
      .update(projects)
      .set({ payer_person_id: 'boss' })
      .where(eq(projects.id, own.project!.id));
    expect(await billedAccountPlanId(env.db, paid.owner!)).toBe('solo');
  });

  it('keeps a report’s split by model and source', async () => {
    const report = {
      person: 'p1',
      aiNeurons: 7,
      breakdown: [
        { model: 'm1', source: 'bot-a', aiNeurons: 5 },
        { model: 'm2', source: 'bot-a', aiNeurons: 2, sandboxSeconds: 3 },
      ],
    };
    await call('/usage.record', report);
    expect(await dataOf(call('/usage.record', report))).toMatchObject({ aiNeuronsUsed: 14 });
    const { breakdown } = await dataOf(call('/usage.status', { person: 'p1' }));
    expect(breakdown).toHaveLength(2);
    expect(breakdown).toContainEqual({
      model: 'm1',
      source: 'bot-a',
      aiNeurons: 10,
      sandboxSeconds: 0,
    });
    expect(breakdown).toContainEqual({
      model: 'm2',
      source: 'bot-a',
      aiNeurons: 4,
      sandboxSeconds: 6,
    });
    expect((await call('/usage.record', { person: 'p1', breakdown: [{ model: 1 }] })).status).toBe(
      400,
    );
  });

  it('refuses an unsigned webhook', async () => {
    const response = await app.fetch(
      new Request(origin + '/billing/stripe', { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
  });
});
