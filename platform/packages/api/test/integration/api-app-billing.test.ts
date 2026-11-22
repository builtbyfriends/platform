import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vite-plus/test';
import { addProjectUse, payerOutOfCredits } from '../../src/app-credits.ts';
import {
  billedAccountPlanId,
  billedAccountPlanLimits,
  billedPlanId,
  billedPlanLimits,
} from '../../src/app-payer.ts';
import { syncHostedUse } from '../../src/app-usage-sync.ts';
import { registerOAuthClient, setOAuthPreviewPermission } from '../../src/auth/oauth.ts';
import rawApp from '../../src/index.ts';
import { resolvePlanLimits } from '../../src/plans.ts';
import { APP_PERSON_GRANT } from '../../src/routes/oauth-app-person.ts';
import { setProjectAiBlock } from '../../src/routing.ts';
import { appPeople, oauthClients, projects, resources, users } from '../../src/schema.ts';
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
  hostedAsOf: string | null;
  withinCaps: boolean;
  outOfCredits: boolean;
  creditsRemainingMicros: number | null;
  credits: {
    includedMicros: number;
    usedMicros: number;
    remainingMicros: number;
    out: boolean;
  } | null;
  meters: Array<{ meter: string; quantity: number; costMicros: number }>;
  daily: Array<{ day: string; costMicros: number; meters: Record<string, number> }>;
  plans: Array<{ id: string; creditMicros: number }>;
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

const hosted = async (person: string) =>
  (await dataOf(call('/usage.status', { person, hosted: true }))).hosted;

async function sellCredits(person: string, plan: string, creditMicros: number) {
  await env.db
    .update(oauthClients)
    .set({
      plans: {
        solo: { stripePriceId: 'price_app_solo', creditMicros },
        pro: { stripePriceId: 'price_app_pro', creditMicros: creditMicros * 10 },
      },
    })
    .where(eq(oauthClients.id, registration.client.id));
  await webhook({
    type: 'checkout.session.completed',
    data: {
      object: {
        metadata: { clientId: registration.client.id, personId: person, plan },
        customer: 'cus_1',
      },
    },
  });
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

  it('stores what hosted apps used under their payer, and keeps the old numbers when analytics is down', async () => {
    const { project } = await preview('p1', { workspace: 'w1' });
    expect((await dataOf(call('/usage.status', { person: 'p1' }))).hostedAsOf).toBeNull();
    await env.db.insert(resources).values(
      (['d1', 'kv', 'r2'] as const).map((type) => ({
        id: `res_${type}`,
        project_id: project!.id,
        type,
        cf_id: `${type}-1`,
        binding_name: type,
      })),
    );
    const stored = (max: Record<string, number>, dimensions: Record<string, string>) => ({
      data: { viewer: { accounts: [{ storage: [{ max, dimensions }] }] } },
    });
    const analytics = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const query = String(init?.body);
      if (!String(input).endsWith('/graphql')) {
        return Response.json({
          data: query.includes('double3')
            ? [{ index1: `user-${project!.slug}`, cpu_ms: 2_000_000 }]
            : [{ blob1: project!.id, requests: 2_000_000, bandwidth_bytes: 500 }],
        });
      }
      if (query.includes('d1StorageAdaptiveGroups')) {
        return Response.json(stored({ databaseSizeBytes: 3e9 }, { databaseId: 'd1-1' }));
      }
      if (query.includes('kvStorageAdaptiveGroups')) {
        return Response.json(stored({ byteCount: 6e8 }, { namespaceId: 'kv-1' }));
      }
      if (query.includes('r2StorageAdaptiveGroups')) {
        return Response.json(
          stored({ payloadSize: 2.9e9, metadataSize: 1e8 }, { bucketName: 'r2-1' }),
        );
      }
      return Response.json({
        data: { viewer: { accounts: [{ aiGatewayRequests: [{ sum: { cost: 0.011 } }] }] } },
      });
    });
    const noon = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`);
    await syncHostedUse(env as never, env.db, noon);
    await syncHostedUse(env as never, env.db, noon);
    analytics.mockRestore();
    const offline = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.error());
    await syncHostedUse(env as never, env.db, noon);
    offline.mockRestore();
    await addProjectUse(env.db, project!.id, 'hostedSandboxSeconds', 7200);

    const answer = await dataOf(call('/usage.status', { person: 'p1', hosted: true, daily: true }));
    expect(answer.hostedAsOf).toBe(noon.toISOString());
    // Decision: The read covers today and yesterday, and reading twice doesn't count twice.
    const days = noon.getUTCDate() === 1 ? 1 : 2;
    expect(answer.hosted).toMatchObject({
      requests: 2_000_000 * days,
      bandwidthBytes: 500 * days,
      aiNeurons: 1000 * days,
      cpuMs: 2_000_000 * days,
      sandboxSeconds: 7200,
      d1Bytes: 3e9,
      kvBytes: 6e8,
      r2Bytes: 3e9,
      costMicros: 737_500 * days + 200_000,
      projects: [
        { projectId: project!.id, person: 'p1', requests: 2_000_000 * days, d1Bytes: 3e9 },
      ],
    });
    expect(answer.meters).toContainEqual({
      meter: 'hostedD1ByteDays',
      quantity: 3e9 * days,
      costMicros: 75_000 * days,
    });
    expect(answer.meters).toContainEqual({
      meter: 'hostedRequests',
      quantity: 2_000_000 * days,
      costMicros: 600_000 * days,
    });
    expect(answer.credits).toBeNull();
    expect(answer.daily).toHaveLength(new Date().getUTCDate());
    expect(answer.daily.at(-1)).toMatchObject({
      costMicros: 937_500,
      meters: {
        hostedRequests: 2_000_000,
        hostedAiNeurons: 1000,
        hostedCpuMs: 2_000_000,
        hostedSandboxSeconds: 7200,
        hostedKvByteDays: 6e8,
      },
    });
  });

  it('holds a plan with credits to one balance, and pauses hosted AI at zero', async () => {
    await sellCredits('p1', 'solo', 1_000_000);
    const { project, owner } = await preview('p1', { workspace: 'w1' });
    expect((await dataOf(call('/plans.list', {}))).plans).toEqual([
      { id: 'solo', creditMicros: 1_000_000 },
      { id: 'pro', creditMicros: 10_000_000 },
    ]);

    const some = await dataOf(call('/usage.record', { person: 'p1', aiNeurons: 50_000 }));
    expect(some).toMatchObject({
      withinCaps: true,
      outOfCredits: false,
      creditsRemainingMicros: 450_000,
    });
    expect(await payerOutOfCredits(env.db, project!.id)).toBe(false);
    expect(await billedAccountPlanLimits(env.db, owner!)).toMatchObject({
      requestsPerMonth: 0,
      aiNeuronsPerMonth: 0,
      sandboxRuntimeSecondsPerMonth: 0,
    });

    // Decision: 18,000 seconds is five hours of sandbox at $0.10, which takes the balance past zero. The solo
    // plan's own caps for AI and sandbox time are far above both numbers.
    const spent = await dataOf(call('/usage.record', { person: 'p1', sandboxSeconds: 18_000 }));
    expect(spent).toMatchObject({
      withinCaps: false,
      outOfCredits: true,
      creditsRemainingMicros: 0,
    });
    const status = await dataOf(call('/usage.status', { person: 'p1', daily: true }));
    expect(status).toMatchObject({
      plan: 'solo',
      withinCaps: false,
      aiWithinCap: false,
      sandboxWithinCap: false,
      credits: { includedMicros: 1_000_000, usedMicros: 1_050_000, remainingMicros: 0, out: true },
    });
    expect(status.meters).toHaveLength(10);
    expect(status.daily.at(-1)).toMatchObject({
      costMicros: 1_050_000,
      meters: { aiNeurons: 50_000, sandboxSeconds: 18_000 },
    });

    expect(await payerOutOfCredits(env.db, project!.id)).toBe(true);
    await setProjectAiBlock(env.ROUTING, env.db, project!.id, owner!.id, false);
    expect(await env.ROUTING.get(`ai-block:${project!.id}`)).toBe('1');

    await sellCredits('p1', 'pro', 1_000_000);
    expect(await payerOutOfCredits(env.db, project!.id)).toBe(false);
    const [person] = await env.db.select().from(appPeople);
    expect(person).toMatchObject({ plan: 'pro', out_of_credits_period: null });
    await setProjectAiBlock(env.ROUTING, env.db, project!.id, owner!.id, false);
    expect(await env.ROUTING.get(`ai-block:${project!.id}`)).toBeNull();
    expect((await dataOf(call('/usage.status', { person: 'p1' }))).withinCaps).toBe(true);
  });

  it('sells an application its own plans at its own prices', async () => {
    await sellCredits('p0', 'solo', 1_000_000);
    await env.db
      .update(oauthClients)
      .set({ plans: { solo: { stripePriceId: 'price_app_solo', creditMicros: 5 } } })
      .where(eq(oauthClients.id, registration.client.id));
    const stripe = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ url: 'https://stripe.example/session' }));
    const order = { person: 'p1', returnUrl: 'https://example.com/plan' };
    expect((await call('/billing.checkout', { ...order, plan: 'pro' })).status).toBe(400);
    expect((await call('/billing.checkout', { ...order, plan: 'solo' })).status).toBe(200);
    expect(String(stripe.mock.calls[0]![1]!.body)).toContain('price_app_solo');
    stripe.mockRestore();
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
