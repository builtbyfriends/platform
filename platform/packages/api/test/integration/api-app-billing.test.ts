import { createDefaultPlanCatalog } from '@builtbyfriends/platform/plans';
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
import { addProjectUse, addUse, payerOutOfCredits, type Meter } from '../../src/app-credits.ts';
import {
  accountPlanLimits,
  billedAccountPlanId,
  billedAccountPlanLimits,
  billedPlanId,
  billedPlanLimits,
} from '../../src/app-payer.ts';
import { syncHostedUse } from '../../src/app-usage-sync.ts';
import { registerOAuthClient, setOAuthPreviewPermission } from '../../src/auth/oauth.ts';
import { grantCredits } from '../../src/credit-ledger.ts';
import { setAutoTopUp } from '../../src/credit-purchase.ts';
import rawApp from '../../src/index.ts';
import { installationDefaultPlan, resolvePlanLimits, writePlanCatalog } from '../../src/plans.ts';
import { APP_PERSON_GRANT } from '../../src/routes/oauth-app-person.ts';
import { projectRouteKey, setProjectAiBlock } from '../../src/routing.ts';
import {
  appBuyers,
  appCreditGrants,
  appPayers,
  appPeople,
  appUsageDaily,
  oauthClients,
  projects,
  resources,
  users,
} from '../../src/schema.ts';
import { projectSuspensionKey } from '../../src/suspension.ts';
import {
  setupEnv,
  teardownEnv,
  cfSuccess,
  clearTables,
  createMockExecutionContext,
  createTestProject,
  createTestUser,
  mockCfApi,
  rpcData,
  withLegacyDeploy,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

const app = withLegacyDeploy(rawApp);
const origin = 'https://platform.example.com';
const ctx = createMockExecutionContext();
let env: TestEnv & {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
};
let registration: Awaited<ReturnType<typeof registerOAuthClient>>;

const basic = () => 'Basic ' + btoa(registration.client.id + ':' + registration.clientSecret);
type Hosted = {
  requests: number;
  projects: Array<{ projectId: string; slug: string; person: string }>;
};
type Answer = {
  plan: string;
  paid: boolean;
  subscribed: boolean;
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
  seats: { count: number; priceCents: number | null; nextBillCents: number | null } | null;
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

async function savePlans(creditMicros = 0) {
  await env.db
    .update(oauthClients)
    .set({
      plans: {
        solo: { stripePriceId: 'price_app_solo', creditMicros },
        pro: { stripePriceId: 'price_app_pro', creditMicros: creditMicros * 10 },
      },
    })
    .where(eq(oauthClients.id, registration.client.id));
}

async function sellCredits(person: string, plan: string, creditMicros: number) {
  await savePlans(creditMicros);
  await webhook({
    type: 'checkout.session.completed',
    data: {
      object: {
        metadata: { clientId: registration.client.id, personId: person, plan },
        customer: 'cus_1',
        subscription: `sub_${person}`,
        payment_status: 'paid',
      },
    },
  });
  await webhook(invoicePaid(person, `price_app_${plan}`));
}

const DAY = 86_400;

const subscription = (extra: object = {}) => ({
  id: 'sub_1',
  status: 'active',
  customer: 'cus_1',
  cancel_at_period_end: false,
  items: {
    data: [
      { current_period_end: Math.floor(Date.now() / 1000) + 30 * DAY, price: { id: 'price_solo' } },
    ],
  },
  ...extra,
});

function invoicePaid(
  person: string,
  price: string,
  {
    id = 'in_' + crypto.randomUUID(),
    start = Math.floor(Date.now() / 1000) - DAY,
    end = start + 30 * DAY,
    reason = 'subscription_create',
  }: { id?: string; start?: number; end?: number; reason?: string } = {},
) {
  return {
    type: 'invoice.paid',
    data: {
      object: {
        id,
        billing_reason: reason,
        payment_intent: `pi_${id}`,
        lines: {
          data: [
            { period: { start, end }, pricing: { price_details: { price } } } as {
              amount?: number;
              period: { start: number; end: number };
              pricing: { price_details: { price: string } };
            },
          ],
        },
        parent: {
          subscription_details: {
            metadata: { clientId: registration.client.id, personId: person, plan: 'solo' },
          },
        },
      },
    },
  };
}

const paidCheckout = { customer: 'cus_1', subscription: 'sub_1', payment_status: 'paid' };

async function webhook(event: object, secret = 'whsec_test') {
  const body = JSON.stringify({ id: 'evt_' + crypto.randomUUID(), livemode: false, ...event });
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

    const cap = first.caps.aiNeuronsPerMonth;
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

  it('sells nothing when the application has no plan list', async () => {
    expect(await dataOf(call('/plans.list', {}))).toEqual({ plans: [], creditPurchase: null });
    const order = { person: 'p1', plan: 'solo', returnUrl: 'https://example.com/plan' };
    const checkout = await call('/billing.checkout', order);
    expect(checkout.status).toBe(400);
    expect(await checkout.json()).toEqual({ error: 'no_plans' });

    const metadata = { clientId: registration.client.id, personId: 'p1', plan: 'solo' };
    await webhook({ type: 'checkout.session.completed', data: { object: { metadata } } });
    expect(await env.db.select().from(appPeople)).toEqual([]);
  });

  it('moves a person to the plan they bought and back when the subscription ends', async () => {
    await savePlans();
    const periodEnd = Date.UTC(2026, 11, 19, 12) / 1000;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === 'https://api.stripe.com/v1/subscriptions/sub_1') {
        return Response.json(
          subscription({
            items: { data: [{ current_period_end: periodEnd, price: { id: 'price_solo' } }] },
          }),
        );
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
          data: { object: { ...paidCheckout, metadata } },
        })
      ).status,
    ).toBe(200);
    await webhook({
      type: 'customer.subscription.created',
      data: { object: { id: 'sub_1', metadata } },
    });
    fetchSpy.mockClear();
    const bought = await dataOf(call('/usage.status', { person: 'p1' }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(bought).toMatchObject({
      plan: 'solo',
      subscribed: true,
      subscriptionStatus: 'active',
      cancelAtPeriodEnd: false,
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

    await webhook({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_older', metadata } },
    });
    expect(await dataOf(call('/usage.status', { person: 'p1' }))).toMatchObject({
      plan: 'solo',
      subscribed: true,
    });

    await webhook({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', metadata } },
    });
    const ended = await dataOf(call('/usage.status', { person: 'p1' }));
    expect(ended).toMatchObject({ plan: 'free', subscribed: false });
    expect(ended).not.toHaveProperty('renewsAt');
  });

  it('says plainly whether a person pays, whatever the default plan is called', async () => {
    env.PLATFORM_INSTALLATION_ID = 'installation-1';
    try {
      const status = (person: string) => dataOf(call('/usage.status', { person }));
      expect(await status('p1')).toMatchObject({ plan: 'custom', paid: false, credits: null });
      expect(await dataOf(call('/usage.record', { person: 'p1' }))).toMatchObject({ paid: false });

      await sellCredits('p1', 'solo', 20_000_000);
      expect(await status('p1')).toMatchObject({ plan: 'solo', paid: true });
      const metadata = { clientId: registration.client.id, personId: 'p1' };
      await webhook({
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_p1', metadata } },
      });
      // Decision: A cancelled person keeps what's left of the month they paid for, so only paid changes.
      expect(await status('p1')).toMatchObject({ plan: 'custom', paid: false });

      // Decision: A default plan that shares an id with the app's list still leaves a cancelled person unpaid.
      await writePlanCatalog(env.db, {
        ...createDefaultPlanCatalog('custom'),
        defaultPlanId: 'solo',
      });
      await sellCredits('p2', 'pro', 20_000_000);
      expect(await status('p2')).toMatchObject({ plan: 'pro', paid: true });
      await webhook({
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_p2', metadata: { ...metadata, personId: 'p2' } } },
      });
      expect(await status('p2')).toMatchObject({ plan: 'solo', paid: false });
    } finally {
      delete env.PLATFORM_INSTALLATION_ID;
    }
  });

  it('grants a plan’s credits whatever tax or a promotion code did to the total', async () => {
    await sellCredits('p0', 'solo', 20_000_000);
    const totals = [
      {
        amount_subtotal: 2000,
        amount_total: 2165,
        total_details: { amount_discount: 0, amount_tax: 165 },
      },
      {
        amount_subtotal: 2000,
        amount_total: 1000,
        total_details: { amount_discount: 1000, amount_tax: 0 },
      },
      {
        amount_subtotal: 2000,
        amount_total: 0,
        total_details: { amount_discount: 2000, amount_tax: 0 },
      },
    ];
    for (const [index, total] of totals.entries()) {
      const person = `p${index + 1}`;
      await webhook({
        type: 'checkout.session.completed',
        data: {
          object: {
            ...total,
            metadata: { clientId: registration.client.id, personId: person, plan: 'solo' },
            customer: `cus_${person}`,
            payment_status: total.amount_total > 0 ? 'paid' : 'no_payment_required',
          },
        },
      });
      const invoice = invoicePaid(person, 'price_app_solo');
      await webhook({
        ...invoice,
        data: { object: { ...invoice.data.object, amount_paid: total.amount_total } },
      });
      expect((await dataOf(call('/usage.status', { person }))).credits).toMatchObject({
        includedMicros: 20_000_000,
        remainingMicros: 20_000_000,
      });
    }
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
      data: { viewer: { accounts: [{ groups: [{ max, dimensions }] }] } },
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
      credits: {
        includedMicros: 1_000_000,
        usedMicros: 1_050_000,
        remainingMicros: 0,
        balanceMicros: -50_000,
        out: true,
      },
    });
    expect(status.meters).toHaveLength(17);
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

  it('slows a payer’s hosted apps at zero, pauses them after the grace days, and lifts both on a new grant', async () => {
    const give = (amountMicros: number) =>
      grantCredits(env.db, {
        clientId: registration.client.id,
        payer: 'boss',
        livemode: false,
        source: 'given',
        amountMicros,
      });
    await give(100_000);
    await call('/usage.record', { person: 'boss', aiNeurons: 1 });
    const mine = (await preview('p1', { workspace: 'w1', payer: 'boss' })).project!;
    const taken = (await preview('p1', { workspace: 'w2', payer: 'boss' })).project!;
    const theirs = (await preview('p1', { workspace: 'w3' })).project!;
    for (const project of [mine, taken, theirs]) {
      await env.ROUTING.put(
        projectRouteKey(project),
        JSON.stringify({ workerName: 'w', projectId: project.id }),
      );
    }
    const state = async (project: typeof mine) => {
      const [row] = await env.db.select().from(projects).where(eq(projects.id, project.id));
      const route = JSON.parse((await env.ROUTING.get(projectRouteKey(project)))!);
      return {
        row: row!.suspended_reason,
        route: route.suspended ?? null,
        background: await env.ROUTING.get(projectSuspensionKey(project.id)),
      };
    };
    const outFor = async (days: number) => {
      await env.db
        .update(appPayers)
        .set({ out_since: new Date(Date.now() - days * 86_400_000).toISOString() })
        .where(eq(appPayers.payer_id, 'boss'));
      await call('/usage.status', { person: 'boss' });
    };
    const grace = { row: 'credits_grace', route: 'credits_grace', background: null };
    const paused = { row: 'credits_paused', route: 'credits_paused', background: 'credits_paused' };
    const clear = { row: null, route: null, background: null };

    await call('/usage.record', { person: 'boss', aiNeurons: 20_000 });
    expect(await state(mine)).toEqual(grace);
    expect(await state(theirs)).toEqual(clear);
    await outFor(1);
    expect(await state(mine)).toEqual(grace);
    await outFor(4);
    expect(await state(mine)).toEqual(paused);
    expect(await state(taken)).toEqual(paused);
    expect(await state(theirs)).toEqual(clear);

    const takedown = 'operator_takedown';
    await env.db
      .update(projects)
      .set({ suspended_reason: takedown })
      .where(eq(projects.id, taken.id));
    await env.ROUTING.put(
      projectRouteKey(taken),
      JSON.stringify({ workerName: 'w', projectId: taken.id, suspended: takedown }),
    );
    await env.ROUTING.put(projectSuspensionKey(taken.id), takedown);

    await give(1_000_000);
    await call('/usage.status', { person: 'boss' });
    expect(await state(mine)).toEqual(clear);
    expect(await state(taken)).toEqual({ row: takedown, route: takedown, background: takedown });
  });

  it('moves a paused project to a payer with credits, and charges them from then on', async () => {
    const client = registration.client.id;
    await call('/wallets.open', { payer: 'server:1' });
    const project = (await preview('p1', { workspace: 'w1', payer: 'server:1' })).project!;
    await env.ROUTING.put(
      projectRouteKey(project),
      JSON.stringify({ workerName: 'w', projectId: project.id }),
    );
    await env.db
      .update(appPayers)
      .set({ out_since: new Date(Date.now() - 5 * 86_400_000).toISOString() })
      .where(eq(appPayers.payer_id, 'server:1'));
    await call('/usage.status', { person: 'server:1' });
    const reason = async () =>
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0]!
        .suspended_reason;
    expect(await reason()).toBe('credits_paused');

    const unknown = await call('/projects.payer', { project: project.id, payer: 'nobody' });
    expect(await unknown.json()).toEqual({ error: 'unknown_payer' });
    expect((await call('/projects.payer', { project: 'nope', payer: 'p1' })).status).toBe(404);

    await grantCredits(env.db, {
      clientId: client,
      payer: 'ana',
      livemode: false,
      source: 'given',
      amountMicros: 1_000_000,
    });
    await call('/usage.record', { person: 'ana', aiNeurons: 1 });
    const moved = await call('/projects.payer', { project: project.slug, payer: 'ana' });
    expect(await moved.json()).toEqual({
      data: { projectId: project.id, payer: 'ana', changed: true },
    });
    expect(await reason()).toBeNull();
    expect(
      JSON.parse((await env.ROUTING.get(projectRouteKey(project)))!).suspended,
    ).toBeUndefined();

    await addProjectUse(env.db, project.id, 'hostedRequests', 1_000_000);
    const hosted = await env.db
      .select()
      .from(appUsageDaily)
      .where(eq(appUsageDaily.project_id, project.id));
    expect(hosted.map((row) => [row.person_id, row.meter])).toEqual([['ana', 'hostedRequests']]);
  });

  it('holds each payer to their own plan’s monthly caps, across owners, and leaves the others running', async () => {
    const limits = await resolvePlanLimits(env.db, (await installationDefaultPlan(env.db, env)).id);
    expect(limits.requestsPerMonth).toBeGreaterThan(0);
    expect(limits.aiNeuronsPerMonth).toBeGreaterThan(0);
    for (const person of ['a', 'b']) {
      await call('/usage.record', { person, aiNeurons: 1 });
    }
    const aOfP1 = (await preview('p1', { workspace: 'w1', payer: 'a' })).project!;
    const bOfP1 = (await preview('p1', { workspace: 'w2', payer: 'b' })).project!;
    const aOfP2 = (await preview('p2', { workspace: 'w1', payer: 'a' })).project!;
    const reason = async (project: typeof aOfP1) =>
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0]!
        .suspended_reason;
    const use = (project: typeof aOfP1, payer: string, meter: Meter, quantity: number) =>
      addUse(env.db, {
        clientId: registration.client.id,
        person: payer,
        projectId: project.id,
        meter,
        quantity,
      });
    const owner = (await env.db.select().from(users).where(eq(users.id, aOfP1.user_id)))[0]!;
    expect(await accountPlanLimits(env.db, owner, owner.plan)).toMatchObject({
      requestsPerMonth: 0,
      aiNeuronsPerMonth: 0,
      sandboxRuntimeSecondsPerMonth: 0,
    });
    expect(await accountPlanLimits(env.db, { provider: 'github' }, owner.plan)).toEqual(
      await resolvePlanLimits(env.db, owner.plan),
    );

    const half = Math.ceil(limits.requestsPerMonth / 2);
    await use(aOfP1, 'a', 'hostedRequests', half);
    await call('/usage.status', { person: 'a' });
    expect(await reason(aOfP1)).toBeNull();
    await use(aOfP2, 'a', 'hostedRequests', half);
    await use(bOfP1, 'b', 'hostedAiNeurons', limits.aiNeuronsPerMonth);
    await call('/usage.status', { person: 'a' });
    await call('/usage.status', { person: 'b' });
    expect(await reason(aOfP1)).toBe('credits_paused');
    expect(await reason(aOfP2)).toBe('credits_paused');
    expect(await reason(bOfP1)).toBeNull();
    expect(await payerOutOfCredits(env.db, bOfP1.id)).toBe(true);
    expect(await payerOutOfCredits(env.db, bOfP1.id, 'sandbox')).toBe(false);
    expect(await payerOutOfCredits(env.db, aOfP1.id)).toBe(false);
  });

  it('counts a hosted app’s database rows and storage operations, and keeps the others when one read fails', async () => {
    const { project } = await preview('p1', { workspace: 'w1' });
    await env.db.insert(resources).values(
      (['d1', 'kv', 'r2', 'queue'] as const).map((type) => ({
        id: `res_${type}`,
        project_id: project!.id,
        type,
        cf_id: `${type}-1`,
        binding_name: type,
      })),
    );
    const groups = (...rows: Array<Record<string, unknown>>) =>
      Response.json({ data: { viewer: { accounts: [{ groups: rows }] } } });
    const analytics = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const query = String(init?.body);
      if (query.includes('d1AnalyticsAdaptiveGroups')) {
        return groups({
          sum: { rowsRead: 2e6, rowsWritten: 1e6 },
          dimensions: { databaseId: 'd1-1' },
        });
      }
      if (query.includes('r2OperationsAdaptiveGroups')) {
        return groups(
          { sum: { requests: 1e6 }, dimensions: { bucketName: 'r2-1', actionType: 'PutObject' } },
          { sum: { requests: 1e6 }, dimensions: { bucketName: 'r2-1', actionType: 'GetObject' } },
          { sum: { requests: 9 }, dimensions: { bucketName: 'r2-1', actionType: 'DeleteObject' } },
          { sum: { requests: 1e6 }, dimensions: { bucketName: 'other', actionType: 'PutObject' } },
        );
      }
      if (query.includes('queueMessageOperationsAdaptiveGroups')) {
        return groups({ sum: { billableOperations: 1e6 }, dimensions: { queueId: 'queue-1' } });
      }
      return Response.json({ errors: [{ message: 'unavailable' }] }, { status: 500 });
    });
    const noon = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`);
    await syncHostedUse(env as never, env.db, noon);
    analytics.mockRestore();

    const days = noon.getUTCDate() === 1 ? 1 : 2;
    const { hosted, meters } = await dataOf(call('/usage.status', { person: 'p1', hosted: true }));
    expect(hosted).toMatchObject({
      d1RowsRead: 2e6 * days,
      d1RowsWritten: 1e6 * days,
      r2ClassAOps: 1e6 * days,
      r2ClassBOps: 1e6 * days,
      kvReads: 0,
      kvWrites: 0,
      queueOps: 1e6 * days,
      requests: 0,
      costMicros: (1_000_000 + 2_000 + 4_500_000 + 360_000 + 400_000) * days,
    });
    expect(meters).toContainEqual({
      meter: 'hostedD1RowsWritten',
      quantity: 1e6 * days,
      costMicros: 1_000_000 * days,
    });
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

    await savePlans();
    const metadata = { clientId: registration.client.id, personId: 'boss', plan: 'solo' };
    await webhook({
      type: 'checkout.session.completed',
      data: { object: { ...paidCheckout, metadata } },
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

  describe('credit ledger', () => {
    const setPlans = () =>
      env.db
        .update(oauthClients)
        .set({ plans: { solo: { stripePriceId: 'price_app_solo', creditMicros: 1_000_000 } } })
        .where(eq(oauthClients.id, registration.client.id));
    const credits = async (person: string) =>
      (await dataOf(call('/usage.status', { person }))).credits as unknown as {
        remainingMicros: number;
        balanceMicros: number;
        out: boolean;
        grants: Array<{ source: string; remainingMicros: number; expiresAt: string | null }>;
      } | null;
    // Decision: 100,000 neurons cost $1.10 at the default price, past a $1 grant.
    const spend = (person: string, aiNeurons: number) =>
      call('/usage.record', { person, aiNeurons });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('gives a plan bought on the 30th one month of credits, with no refill on the 1st', async () => {
      await setPlans();
      vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 30, 12) });
      const start = Date.UTC(2026, 10, 30, 12) / 1000;
      await webhook(invoicePaid('p1', 'price_app_solo', { start, end: start + 30 * DAY }));
      await spend('p1', 10_000);
      expect(await credits('p1')).toMatchObject({ remainingMicros: 890_000, out: false });
      vi.setSystemTime(Date.UTC(2026, 11, 1, 12));
      expect(await credits('p1')).toMatchObject({ remainingMicros: 890_000, out: false });
      vi.setSystemTime(Date.UTC(2026, 11, 30, 13));
      expect(await credits('p1')).toMatchObject({ remainingMicros: 0, out: true, grants: [] });
    });

    it('adds a grant for each paid invoice, once per invoice', async () => {
      await setPlans();
      const first = invoicePaid('p1', 'price_app_solo', { id: 'in_1' });
      await webhook({ id: 'evt_in_1', ...first });
      expect(await (await webhook({ id: 'evt_in_1', ...first })).json()).toEqual({
        ok: true,
        duplicate: true,
      });
      await webhook(first);
      expect((await credits('p1'))!.grants).toHaveLength(1);
      await webhook(
        invoicePaid('p1', 'price_app_solo', { id: 'in_2', reason: 'subscription_cycle' }),
      );
      expect(await credits('p1')).toMatchObject({ remainingMicros: 2_000_000 });
      await webhook(invoicePaid('p1', 'price_app_solo', { id: 'in_3', reason: 'manual' }));
      expect((await credits('p1'))!.grants).toHaveLength(2);
    });

    it('spends the grant that ends soonest first', async () => {
      const now = Date.now();
      const payer = { clientId: registration.client.id, payer: 'p1', livemode: false };
      await grantCredits(env.db, {
        ...payer,
        source: 'given',
        amountMicros: 1_000_000,
        expiresAt: new Date(now + 300 * DAY * 1000),
      });
      await grantCredits(env.db, {
        ...payer,
        source: 'plan',
        amountMicros: 500_000,
        expiresAt: new Date(now + 10 * DAY * 1000),
      });
      await spend('p1', 20_000);
      expect((await credits('p1'))!.grants).toMatchObject([
        { source: 'plan', remainingMicros: 280_000 },
        { source: 'given', remainingMicros: 1_000_000 },
      ]);
      await spend('p1', 40_000);
      expect((await credits('p1'))!.grants).toMatchObject([
        { source: 'given', remainingMicros: 840_000 },
      ]);
    });

    it('runs out a payer who holds a grant and no plan', async () => {
      await grantCredits(env.db, {
        clientId: registration.client.id,
        payer: 'p1',
        livemode: false,
        source: 'given',
        amountMicros: 1_000_000,
      });
      const answer = await dataOf(spend('p1', 100_000));
      expect(answer).toMatchObject({ outOfCredits: true, creditsRemainingMicros: 0 });
      const status = await dataOf(call('/usage.status', { person: 'p1' }));
      expect(status).toMatchObject({ plan: 'free', withinCaps: false });
      expect(await credits('p1')).toMatchObject({ balanceMicros: -100_000, out: true });
      const [payer] = await env.db.select().from(appPayers);
      expect(payer).toMatchObject({ owed_micros: 100_000 });
      expect(payer!.out_since).not.toBeNull();
    });

    it('charges a hosted read once, and only what it adds', async () => {
      const { project } = await preview('p1', { workspace: 'w1' });
      await grantCredits(env.db, {
        clientId: registration.client.id,
        payer: 'p1',
        livemode: false,
        source: 'given',
        amountMicros: 10_000_000,
      });
      let requests = 1_000_000;
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      const analytics = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) =>
        !String(input).endsWith('/graphql')
          ? Response.json({
              data: String(init?.body).includes('double3')
                ? []
                : [{ blob1: project!.id, requests, bandwidth_bytes: 0 }],
            })
          : String(init?.body).includes('StorageAdaptiveGroups')
            ? Response.error()
            : Response.json({
                data: { viewer: { accounts: [{ aiGatewayRequests: [{ sum: { cost: 0 } }] }] } },
              }),
      );
      const noon = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`);
      const days = noon.getUTCDate() === 1 ? 1 : 2;
      await syncHostedUse(env as never, env.db, noon);
      await syncHostedUse(env as never, env.db, noon);
      expect((await credits('p1'))!.remainingMicros).toBe(10_000_000 - 300_000 * days);
      requests = 2_000_000;
      await syncHostedUse(env as never, env.db, noon);
      analytics.mockRestore();
      quiet.mockRestore();
      expect((await credits('p1'))!.remainingMicros).toBe(10_000_000 - 600_000 * days);
    });
  });

  describe('subscriptions', () => {
    const metadata = () => ({ clientId: registration.client.id, personId: 'p1', plan: 'solo' });
    const order = { person: 'p1', plan: 'solo', returnUrl: 'https://example.com/plan' };
    let stripe: ReturnType<typeof subscription>;
    let calls: Array<[string, RequestInit | undefined]>;

    beforeEach(async () => {
      await env.db
        .update(oauthClients)
        .set({
          plans: {
            solo: { stripePriceId: 'price_app_solo', creditMicros: 1_000_000 },
            pro: { stripePriceId: 'price_app_pro', creditMicros: 5_000_000 },
          },
        })
        .where(eq(oauthClients.id, registration.client.id));
      stripe = subscription({
        items: { data: [{ current_period_end: 1_900_000_000, price: { id: 'price_app_solo' } }] },
      });
      calls = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        calls.push([String(input), init]);
        return String(input).includes('/subscriptions/')
          ? Response.json(stripe)
          : Response.json({ url: 'https://stripe.example/session' });
      });
      await webhook({
        type: 'checkout.session.completed',
        data: { object: { ...paidCheckout, metadata: metadata() } },
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('refuses a second Checkout and reuses the Stripe customer', async () => {
      expect(await (await call('/billing.checkout', order)).json()).toEqual({
        error: 'already_subscribed',
      });
      expect(calls).toEqual([]);
      await webhook({
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_1', metadata: metadata() } },
      });
      expect((await call('/billing.checkout', order)).status).toBe(200);
      const form = new URLSearchParams(String(calls[0]![1]!.body));
      expect(form.get('customer')).toBe('cus_1');
      expect(form.has('customer_email')).toBe(false);
    });

    it('leaves the plan when another subscription is deleted', async () => {
      const answer = await webhook({
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_old', metadata: metadata() } },
      });
      expect(await answer.json()).toEqual({ ok: true, ignored: true });
      expect(await dataOf(call('/usage.status', { person: 'p1' }))).toMatchObject({
        plan: 'solo',
        subscribed: true,
      });
    });

    it('follows a plan changed in the portal, and grants the difference Stripe charged', async () => {
      await webhook(invoicePaid('p1', 'price_app_solo', { id: 'in_1' }));
      stripe = subscription({
        cancel_at_period_end: true,
        items: { data: [{ current_period_end: 1_900_000_000, price: { id: 'price_app_pro' } }] },
      });
      await webhook({
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_1', metadata: metadata() } },
      });
      expect(await dataOf(call('/usage.status', { person: 'p1' }))).toMatchObject({
        plan: 'pro',
        cancelAtPeriodEnd: true,
        renewsAt: new Date(1_900_000_000_000).toISOString(),
      });
      const change = invoicePaid('p1', 'price_app_pro', {
        id: 'in_2',
        reason: 'subscription_update',
      });
      Object.assign(change.data.object.lines.data[0]!, { amount: 2000 });
      change.data.object.lines.data.unshift({
        amount: -500,
        period: { start: 0, end: 1 },
        pricing: { price_details: { price: 'price_app_solo' } },
      });
      await webhook({ ...change, data: { object: { ...change.data.object, amount_paid: 1500 } } });
      expect((await dataOf(call('/usage.status', { person: 'p1' }))).credits).toMatchObject({
        remainingMicros: 5_000_000,
      });
    });

    it('keeps the plan while a failed renewal is retried, with no new credits', async () => {
      await webhook(invoicePaid('p1', 'price_app_solo', { id: 'in_1' }));
      stripe = subscription({
        status: 'past_due',
        items: { data: [{ current_period_end: 1_900_000_000, price: { id: 'price_app_solo' } }] },
      });
      await webhook({
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: 'in_2',
            parent: { subscription_details: { subscription: 'sub_1', metadata: metadata() } },
          },
        },
      });
      expect(await dataOf(call('/usage.status', { person: 'p1' }))).toMatchObject({
        plan: 'solo',
        subscriptionStatus: 'past_due',
        credits: { remainingMicros: 1_000_000 },
      });
      expect((await call('/billing.checkout', order)).status).toBe(409);
    });
  });

  describe('refunds and disputes', () => {
    const charge = (type: string, object: object) => ({
      type,
      data: { object: { payment_intent: 'pi_in_r', amount: 2000, ...object } },
    });
    const balance = async () =>
      (await dataOf(call('/usage.status', { person: 'p1' }))).credits as unknown as {
        balanceMicros: number;
        out: boolean;
      };
    let stripeCalls: Array<string>;

    beforeEach(async () => {
      await env.db
        .update(oauthClients)
        .set({ plans: { solo: { stripePriceId: 'price_app_solo', creditMicros: 20_000_000 } } })
        .where(eq(oauthClients.id, registration.client.id));
      stripeCalls = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        stripeCalls.push(`${init?.method ?? 'GET'} ${String(input)}`);
        return Response.json({ url: 'https://stripe.example/session' });
      });
      await webhook({
        type: 'checkout.session.completed',
        data: {
          object: {
            ...paidCheckout,
            metadata: { clientId: registration.client.id, personId: 'p1', plan: 'solo' },
          },
        },
      });
      await webhook(invoicePaid('p1', 'price_app_solo', { id: 'in_r' }));
      // Decision: 288,000 seconds is 80 hours of sandbox at $0.10, so $8 of the $20 grant is spent.
      await call('/usage.record', { person: 'p1', sandboxSeconds: 288_000 });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('takes back what is left of a fully refunded grant', async () => {
      await webhook(charge('charge.refunded', { amount_refunded: 2000 }));
      expect(await balance()).toMatchObject({ balanceMicros: 0, out: true });
    });

    it('takes back a refund once, working from the total refunded', async () => {
      const half = { id: 'evt_half', ...charge('charge.refunded', { amount_refunded: 1000 }) };
      await webhook(half);
      await webhook(half);
      await webhook({ ...half, id: 'evt_half_again' });
      expect((await balance()).balanceMicros).toBe(2_000_000);
      await webhook(charge('charge.refunded', { amount_refunded: 2000 }));
      expect((await balance()).balanceMicros).toBe(0);
    });

    it('takes back a disputed grant, blocks the buyer, and gives it back when won', async () => {
      await webhook(charge('charge.dispute.created', { status: 'needs_response' }));
      expect(await balance()).toMatchObject({ balanceMicros: -8_000_000, out: true });
      expect(stripeCalls).toContain('DELETE https://api.stripe.com/v1/subscriptions/sub_1');
      await webhook({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_1',
            metadata: { clientId: registration.client.id, personId: 'p1', plan: 'solo' },
          },
        },
      });
      const order = { person: 'p1', plan: 'solo', returnUrl: 'https://example.com/plan' };
      expect(await (await call('/billing.checkout', order)).json()).toEqual({ error: 'blocked' });
      await webhook(
        invoicePaid('p1', 'price_app_solo', { id: 'in_after', reason: 'subscription_cycle' }),
      );
      expect((await balance()).balanceMicros).toBe(-8_000_000);

      await webhook(charge('charge.dispute.closed', { status: 'won' }));
      expect(await balance()).toMatchObject({ balanceMicros: 12_000_000, out: false });
    });

    it('leaves a spent grant below zero after a dispute', async () => {
      await call('/usage.record', { person: 'p1', sandboxSeconds: 432_000 });
      await webhook(charge('charge.dispute.created', { status: 'needs_response' }));
      expect(await balance()).toMatchObject({ balanceMicros: -20_000_000, out: true });
      await webhook(charge('charge.dispute.closed', { status: 'lost' }));
      expect((await balance()).balanceMicros).toBe(-20_000_000);
    });

    it('reads the payment from Stripe when the invoice leaves it out', async () => {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        Response.json({ payments: { data: [{ payment: { payment_intent: 'pi_new' } }] } }),
      );
      const invoice = invoicePaid('p2', 'price_app_solo', { id: 'in_new' });
      const { payment_intent: _, ...object } = invoice.data.object;
      await webhook({ ...invoice, data: { object: { ...object, amount_paid: 2000 } } });
      await webhook(charge('charge.refunded', { payment_intent: 'pi_new', amount_refunded: 2000 }));
      expect((await dataOf(call('/usage.status', { person: 'p2' }))).credits).toMatchObject({
        balanceMicros: 0,
      });
    });
  });

  describe('deleting a person', () => {
    let stripeCalls: Array<string>;
    let stripe: ReturnType<typeof subscription>;
    const forget = async (body: object = {}, authorization?: string) =>
      call('/people.delete', { person: 'p1', ...body }, authorization);

    beforeEach(async () => {
      await savePlans(20_000_000);
      stripeCalls = [];
      stripe = subscription({ status: 'active' });
      const real = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (!String(input).startsWith('https://api.stripe.com/')) {
          return real(input, init);
        }
        stripeCalls.push(`${init?.method ?? 'GET'} ${String(input)}`);
        return String(input).includes('/subscriptions/')
          ? Response.json(stripe)
          : Response.json({ id: 'cus_1', deleted: true });
      });
      await sellCredits('p1', 'solo', 20_000_000);
      await call('/usage.record', { person: 'p1', sandboxSeconds: 36_000, breakdown: [] });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('cancels the subscription, removes the apps and answers like a new person after', async () => {
      const own = await preview('p1', { workspace: 'w1' });
      await call('/usage.record', { person: 'boss', aiNeurons: 1 });
      const paid = await preview('p2', { workspace: 'w2', payer: 'p1' });
      const preview_ = await dataOf(forget({ dryRun: true }));
      expect(stripeCalls).toEqual([]);
      expect(preview_).toEqual({
        dryRun: true,
        subscription: 'sub_p1',
        stripeCustomer: true,
        autoTopUp: false,
        plan: 'solo',
        unspentMicros: 19_000_000,
        grants: [expect.objectContaining({ source: 'plan', remainingMicros: 19_000_000 })],
        projects: [{ id: own.project!.id, slug: own.project!.slug }],
        payerCleared: [{ id: paid.project!.id, slug: paid.project!.slug }],
      });

      const { dryRun: _, ...removes } = preview_ as unknown as Record<string, unknown>;
      const deleted = await forget();
      expect(deleted.status).toBe(200);
      expect(await dataOf(deleted)).toEqual({ deleted: true, ...removes });
      expect(stripeCalls).toEqual([
        'DELETE https://api.stripe.com/v1/subscriptions/sub_p1',
        'DELETE https://api.stripe.com/v1/customers/cus_1',
      ]);
      expect(await env.db.select().from(projects).where(eq(projects.id, own.project!.id))).toEqual(
        [],
      );
      const [kept] = await env.db.select().from(projects).where(eq(projects.id, paid.project!.id));
      expect(kept!.payer_person_id).toBeNull();
      expect(await env.db.select().from(users).where(eq(users.id, own.owner!.id))).toEqual([]);

      const fresh = await dataOf(call('/usage.status', { person: 'p1', daily: true }));
      const stranger = await dataOf(call('/usage.status', { person: 'never-seen', daily: true }));
      expect(fresh).toEqual(stranger);
      const grants = await env.db.select().from(appCreditGrants);
      expect(grants).toEqual([
        expect.objectContaining({
          payer_id: expect.stringMatching(/^deleted_/),
          void_reason: 'account_deleted',
          voided_remaining_micros: 19_000_000,
          stripe_payment_intent_id: expect.any(String),
        }),
      ]);

      stripeCalls = [];
      const again = await forget();
      expect(await dataOf(again)).toMatchObject({
        deleted: true,
        subscription: null,
        stripeCustomer: false,
        projects: [],
        payerCleared: [],
        unspentMicros: 0,
      });
      expect(stripeCalls).toEqual([]);
      expect(await env.db.select().from(appCreditGrants)).toEqual(grants);
    });

    it('ends bought credits and auto top-up with the subscription, and deletes the buyer’s card', async () => {
      await grantCredits(env.db, {
        clientId: registration.client.id,
        payer: 'p1',
        source: 'bought',
        amountMicros: 5_000_000,
        livemode: false,
        stripePaymentIntentId: 'pi_bought',
      });
      await setAutoTopUp(
        env.db,
        { clientId: registration.client.id, payer: 'p1' },
        {
          buyer: 'p1',
          thresholdMicros: 1_000_000,
          amountMicros: 5_000_000,
          monthlyLimitMicros: 20_000_000,
        },
      );
      await env.db.insert(appBuyers).values({
        client_id: registration.client.id,
        buyer_id: 'p1',
        livemode: false,
        stripe_customer_id: 'cus_buyer',
        stripe_payment_method_id: 'pm_1',
      });
      expect(await dataOf(forget({ dryRun: true }))).toMatchObject({
        autoTopUp: true,
        unspentMicros: 24_000_000,
        grants: expect.arrayContaining([expect.objectContaining({ source: 'bought' })]),
      });
      expect((await forget()).status).toBe(200);
      expect(stripeCalls).toEqual([
        'DELETE https://api.stripe.com/v1/subscriptions/sub_p1',
        'DELETE https://api.stripe.com/v1/customers/cus_1',
        'DELETE https://api.stripe.com/v1/customers/cus_buyer',
      ]);
      expect(await env.db.select().from(appBuyers)).toEqual([]);
      expect(
        (await env.db.select().from(appCreditGrants)).every(
          (grant) => grant.void_reason === 'account_deleted' && grant.remaining_micros === 0,
        ),
      ).toBe(true);
      expect(await env.db.select().from(appPayers).where(eq(appPayers.payer_id, 'p1'))).toEqual([]);
    });

    it('keeps a late subscription event from bringing the person back', async () => {
      await forget();
      stripe = subscription({ id: 'sub_p1', status: 'canceled' });
      const metadata = { clientId: registration.client.id, personId: 'p1', plan: 'solo' };
      for (const type of ['customer.subscription.updated', 'customer.subscription.deleted']) {
        await webhook({ type, data: { object: { id: 'sub_p1', metadata } } });
      }
      expect(await env.db.select().from(appPeople)).toEqual([]);
      expect(await dataOf(call('/usage.status', { person: 'p1' }))).toMatchObject({
        plan: 'free',
        subscribed: false,
        credits: null,
      });
    });

    it('leaves another application’s person with the same id alone', async () => {
      const second = await registerOAuthClient(env.db, {
        name: 'Other',
        operator: 'Other Co',
        redirectUris: ['https://other.example/callback'],
        scopes: ['profile'],
      });
      const asOther = 'Basic ' + btoa(second.client.id + ':' + second.clientSecret);
      expect(await dataOf(forget({}, asOther))).toMatchObject({ subscription: null, plan: null });
      expect(stripeCalls).toEqual([]);
      expect(await dataOf(call('/usage.status', { person: 'p1' }))).toMatchObject({
        plan: 'solo',
        subscribed: true,
        credits: { remainingMicros: 19_000_000 },
      });
    });

    it('keeps a dispute block on the person id, and reports what is left when Stripe fails', async () => {
      await env.db
        .update(appPayers)
        .set({ blocked_at: new Date().toISOString(), blocked_reason: 'dispute' });
      stripe = subscription({ status: 'active' });
      vi.restoreAllMocks();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        Response.json({ error: {} }, { status: 500 }),
      );
      const failed = await forget();
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({
        error: 'partial_failure',
        step: 'subscription',
        left: { subscription: 'sub_p1', unspentMicros: 19_000_000 },
      });
      vi.restoreAllMocks();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
      expect((await forget()).status).toBe(200);
      const order = { person: 'p1', plan: 'solo', returnUrl: 'https://example.com/plan' };
      expect(await (await call('/billing.checkout', order)).json()).toEqual({ error: 'blocked' });
      expect((await dataOf(call('/usage.status', { person: 'p1' }))).credits).toBeNull();
    });
  });

  describe('starter credit', () => {
    const starter = async (amount: number | null) =>
      env.db
        .update(oauthClients)
        .set({ starter_credit_micros: amount })
        .where(eq(oauthClients.id, registration.client.id));

    it('answers that there is none when the operator set no amount', async () => {
      const answer = await call('/credits.starter', { person: 'p1' });
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ error: 'no_starter_credit' });
      expect((await dataOf(call('/usage.status', { person: 'p1' }))).credits).toBeNull();
    });

    it('gives a person the starter credit once, spends it, and runs them out at zero', async () => {
      await starter(1_000_000);
      expect(await dataOf(call('/credits.starter', { person: 'p1' }))).toEqual({
        granted: true,
        amountMicros: 1_000_000,
      });
      expect(await dataOf(call('/credits.starter', { person: 'p1', amountMicros: 9e9 }))).toEqual({
        granted: false,
        amountMicros: 0,
      });
      expect((await dataOf(call('/usage.status', { person: 'p1' }))).credits).toMatchObject({
        remainingMicros: 1_000_000,
        starterMicros: 1_000_000,
        grants: [{ source: 'starter', expiresAt: null }],
      });
      await call('/usage.record', { person: 'p1', sandboxSeconds: 36_000 });
      expect(await dataOf(call('/usage.status', { person: 'p1' }))).toMatchObject({
        plan: 'free',
        withinCaps: false,
        credits: { remainingMicros: 0, starterMicros: 0, out: true },
      });

      const second = await registerOAuthClient(env.db, {
        name: 'Other',
        operator: 'Other Co',
        redirectUris: ['https://other.example/callback'],
        scopes: ['profile'],
      });
      const asOther = 'Basic ' + btoa(second.client.id + ':' + second.clientSecret);
      expect((await dataOf(call('/usage.status', { person: 'p1' }, asOther))).credits).toBeNull();
    });
  });

  describe('stripe events', () => {
    beforeEach(async () => {
      await env.db
        .update(oauthClients)
        .set({ plans: { solo: { stripePriceId: 'price_app_solo', creditMicros: 0 } } })
        .where(eq(oauthClients.id, registration.client.id));
    });
    const planOf = async (person: string) =>
      (await env.db.select().from(appPeople).where(eq(appPeople.person_id, person)))[0];
    const checkout = (person: string, extra: object = {}) => ({
      type: 'checkout.session.completed',
      data: {
        object: {
          ...paidCheckout,
          metadata: { clientId: registration.client.id, personId: person, plan: 'solo' },
          ...extra,
        },
      },
    });

    it('handles the same event once', async () => {
      const event = { id: 'evt_once', ...checkout('p1') };
      expect(await (await webhook(event)).json()).toEqual({ ok: true });
      await env.db.update(appPeople).set({ plan: 'free' });
      expect(await (await webhook(event)).json()).toEqual({ ok: true, duplicate: true });
      expect((await planOf('p1'))!.plan).toBe('free');
    });

    it('sets a plan only when the Checkout is paid', async () => {
      const unpaid = checkout('p1', { payment_status: 'unpaid' });
      expect(await (await webhook(unpaid)).json()).toEqual({ ok: true, ignored: true });
      expect(await planOf('p1')).toBeUndefined();
      await webhook({ ...checkout('p1'), type: 'checkout.session.async_payment_succeeded' });
      expect((await planOf('p1'))!.plan).toBe('solo');
    });

    it('ignores an event from the other Stripe mode', async () => {
      expect(await (await webhook({ ...checkout('p1'), livemode: true })).json()).toEqual({
        ok: true,
        ignored: true,
      });
      expect(await planOf('p1')).toBeUndefined();
      env.STRIPE_SECRET_KEY = 'sk_live_x';
      try {
        await webhook(checkout('p2'));
        expect(await planOf('p2')).toBeUndefined();
        await webhook({ ...checkout('p3'), livemode: true });
        expect(await planOf('p3')).toMatchObject({ plan: 'solo', livemode: true });
      } finally {
        env.STRIPE_SECRET_KEY = 'sk_test_x';
      }
    });

    it('ends test-mode plans when the installation goes live', async () => {
      await webhook(checkout('p1'));
      expect((await dataOf(call('/usage.status', { person: 'p1' }))).plan).toBe('solo');
      env.STRIPE_SECRET_KEY = 'sk_live_x';
      try {
        expect((await dataOf(call('/usage.status', { person: 'p1' }))).plan).toBe('free');
        await syncHostedUse(env as never, env.db);
        expect(await planOf('p1')).toMatchObject({
          plan: 'free',
          stripe_subscription_id: null,
          livemode: false,
        });
      } finally {
        env.STRIPE_SECRET_KEY = 'sk_test_x';
      }
    });

    it('lets Stripe retry an event whose handler failed', async () => {
      await env.db
        .update(oauthClients)
        .set({ plans: { solo: { stripePriceId: 'price_app_solo', creditMicros: 1 } } })
        .where(eq(oauthClients.id, registration.client.id));
      const event = { id: 'evt_retry', ...checkout('p1') };
      const original = env.db.transaction.bind(env.db);
      const once = vi.spyOn(env.db, 'transaction').mockImplementationOnce((run) =>
        original(async (tx) => {
          await run(tx);
          throw new Error('boom');
        }),
      );
      expect((await webhook(event)).status).toBe(500);
      once.mockRestore();
      expect(await planOf('p1')).toBeUndefined();
      expect(await (await webhook(event)).json()).toEqual({ ok: true });
      expect((await planOf('p1'))!.plan).toBe('solo');
    });
  });

  describe('seats', () => {
    const seatMetadata = (payer: string) => ({
      clientId: registration.client.id,
      personId: payer,
      plan: 'team',
    });
    let stripe: ReturnType<typeof subscription>;
    let calls: Array<[string, RequestInit | undefined]>;
    let pending: object | null;
    const seatSubscription = (quantity: number) =>
      subscription({
        items: {
          data: [
            {
              id: 'si_1',
              quantity,
              current_period_end: 1_900_000_000,
              price: { id: 'price_app_team', unit_amount: 3000 },
            },
          ],
        },
      });
    const form = (index: number) => new URLSearchParams(String(calls[index]![1]!.body));
    const startSeats = async (payer: string, quantity: number) => {
      stripe = seatSubscription(quantity);
      await webhook({
        type: 'checkout.session.completed',
        data: { object: { ...paidCheckout, metadata: seatMetadata(payer) } },
      });
      await webhook({
        type: 'customer.subscription.created',
        data: { object: { id: 'sub_1', metadata: seatMetadata(payer) } },
      });
      calls = [];
    };

    beforeEach(async () => {
      await env.db
        .update(oauthClients)
        .set({
          plans: {
            solo: { stripePriceId: 'price_app_solo', creditMicros: 1_000_000 },
            team: { stripePriceId: 'price_app_team', creditMicros: 20_000_000, perSeat: true },
          },
        })
        .where(eq(oauthClients.id, registration.client.id));
      calls = [];
      pending = null;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        calls.push([String(input), init]);
        if (String(input).includes('/subscriptions/')) {
          if (init?.method === 'POST') {
            const quantity = Number(
              new URLSearchParams(String(init.body)).get('items[0][quantity]'),
            );
            if (!pending) {
              stripe = seatSubscription(quantity);
            }
            return Response.json({ ...stripe, pending_update: pending });
          }
          return Response.json(stripe);
        }
        return Response.json({ url: 'https://stripe.example/session' });
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('sells 5 seats in one Checkout and shows the count, the price and the next bill', async () => {
      const order = { person: 'p1', plan: 'team', quantity: 5, returnUrl: 'https://example.com/b' };
      expect((await call('/billing.checkout', order)).status).toBe(200);
      expect(form(0).get('line_items[0][quantity]')).toBe('5');
      expect(form(0).get('line_items[0][price]')).toBe('price_app_team');
      await startSeats('p1', 5);
      expect(await dataOf(call('/usage.status', { person: 'p1' }))).toMatchObject({
        plan: 'team',
        seats: {
          count: 5,
          priceCents: 3000,
          nextBillCents: 15_000,
          nextBillAt: new Date(1_900_000_000_000).toISOString(),
        },
      });
    });

    it('lets a person buy seats for a wallet, kept apart from the buyer', async () => {
      const order = {
        person: 'p1',
        payer: 'server-1',
        plan: 'team',
        quantity: 3,
        returnUrl: 'https://example.com/b',
      };
      expect(await (await call('/billing.checkout', order)).json()).toEqual({
        error: 'not_a_wallet',
      });
      await call('/wallets.open', { payer: 'server-1' });
      expect((await call('/billing.checkout', order)).status).toBe(200);
      expect(form(0).get('metadata[personId]')).toBe('server-1');
      expect(form(0).get('metadata[buyerId]')).toBe('p1');
      expect(
        await (await call('/billing.checkout', { ...order, plan: 'solo', quantity: 1 })).json(),
      ).toEqual({ error: 'payer_must_be_buyer' });
      expect(
        await (await call('/billing.checkout', { ...order, person: 'server-1' })).json(),
      ).toMatchObject({ error: 'payer_is_wallet' });
      await startSeats('server-1', 3);
      expect(await dataOf(call('/usage.status', { person: 'server-1' }))).toMatchObject({
        wallet: true,
        plan: 'team',
        caps: null,
        seats: { count: 3 },
      });
    });

    it('charges an added seat at once and lowers the next bill for a removed one', async () => {
      await startSeats('p1', 5);
      expect(await dataOf(call('/billing.seats', { payer: 'p1', quantity: 6 }))).toEqual({
        seats: 6,
        before: 5,
        changed: true,
        paymentNeeded: false,
      });
      const up = calls.find(([, init]) => init?.method === 'POST')!;
      expect(up[0]).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
      expect(Object.fromEntries(new URLSearchParams(String(up[1]!.body)))).toEqual({
        'items[0][id]': 'si_1',
        'items[0][quantity]': '6',
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
      });

      calls = [];
      expect(await dataOf(call('/billing.seats', { payer: 'p1', quantity: 4 }))).toMatchObject({
        seats: 4,
        changed: true,
      });
      const down = calls.find(([, init]) => init?.method === 'POST')!;
      expect(new URLSearchParams(String(down[1]!.body)).get('proration_behavior')).toBe('none');
      expect(new URLSearchParams(String(down[1]!.body)).has('payment_behavior')).toBe(false);
      expect((await dataOf(call('/usage.status', { person: 'p1' }))).seats).toMatchObject({
        count: 4,
        nextBillCents: 12_000,
      });

      calls = [];
      expect(await dataOf(call('/billing.seats', { payer: 'p1', quantity: 4 }))).toMatchObject({
        changed: false,
      });
      expect(calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
    });

    it('keeps the old count when the charge for a new seat fails', async () => {
      await startSeats('p1', 5);
      pending = { subscription_items: [{ id: 'si_1', quantity: 6 }] };
      expect(await dataOf(call('/billing.seats', { payer: 'p1', quantity: 6 }))).toMatchObject({
        seats: 5,
        changed: false,
        paymentNeeded: true,
      });
    });

    it('refuses a seat count on a plan that is not sold by the seat', async () => {
      const order = { person: 'p1', plan: 'solo', quantity: 2, returnUrl: 'https://example.com/b' };
      expect(await (await call('/billing.checkout', order)).json()).toEqual({
        error: 'not_per_seat',
      });
      expect((await call('/billing.checkout', { ...order, quantity: 0 })).status).toBe(400);
      expect((await call('/billing.checkout', { ...order, quantity: 1 })).status).toBe(200);
      expect(await (await call('/billing.seats', { payer: 'p1', quantity: 2 })).json()).toEqual({
        error: 'no_subscription',
      });
      stripe = subscription({
        items: { data: [{ id: 'si_1', quantity: 1, price: { id: 'price_app_solo' } }] },
      });
      await webhook({
        type: 'checkout.session.completed',
        data: {
          object: { ...paidCheckout, metadata: { ...seatMetadata('p1'), plan: 'solo' } },
        },
      });
      expect(await (await call('/billing.seats', { payer: 'p1', quantity: 2 })).json()).toEqual({
        error: 'not_per_seat',
      });
      expect((await dataOf(call('/usage.status', { person: 'p1' }))).seats).toBeNull();
    });

    describe('yearly seats', () => {
      const now = Math.floor(Date.now() / 1000);
      const monthsBack = (seconds: number, months: number) => {
        const date = new Date(seconds * 1000);
        date.setUTCMonth(date.getUTCMonth() - months);
        return Math.floor(date.getTime() / 1000);
      };
      const yearLine = (
        amount: number,
        quantity: number,
        start: number,
        end: number,
        proration = false,
      ) => ({
        amount,
        quantity,
        period: { start, end },
        pricing: { price_details: { price: 'price_app_team_year' }, unit_amount_decimal: '30000' },
        parent: { subscription_item_details: { proration } },
      });
      const yearInvoice = (
        id: string,
        lines: Array<ReturnType<typeof yearLine>>,
        reason = 'subscription_create',
      ) => ({
        type: 'invoice.paid',
        data: {
          object: {
            id,
            billing_reason: reason,
            payment_intent: `pi_${id}`,
            amount_paid: lines.reduce((sum, line) => sum + line.amount, 0),
            lines: { data: lines },
            parent: {
              subscription_details: { metadata: { ...seatMetadata('p1'), plan: 'team-year' } },
            },
          },
        },
      });
      const grants = () =>
        env.db
          .select()
          .from(appCreditGrants)
          .where(eq(appCreditGrants.payer_id, 'p1'))
          .orderBy(appCreditGrants.starts_at);
      const balance = async () =>
        (await dataOf(call('/usage.status', { person: 'p1' }))).credits as unknown as {
          balanceMicros: number;
          pendingMicros: number;
        };

      beforeEach(async () => {
        await env.db
          .update(oauthClients)
          .set({
            plans: {
              'team-year': {
                stripePriceId: 'price_app_team_year',
                creditMicros: 20_000_000,
                perSeat: true,
              },
            },
          })
          .where(eq(oauthClients.id, registration.client.id));
      });

      it('grants 3 seats $60 now and $60 on each of the next 11 monthly dates, once', async () => {
        const start = now - 60;
        const end = monthsBack(start, -12);
        const event = {
          id: 'evt_year',
          ...yearInvoice('in_year', [yearLine(90_000, 3, start, end)]),
        };
        await webhook(event);
        await webhook(event);
        await webhook({ ...yearInvoice('in_year', [yearLine(90_000, 3, start, end)]) });
        const rows = await grants();
        expect(rows).toHaveLength(12);
        expect(rows.every((row) => row.amount_micros === 60_000_000)).toBe(true);
        expect(rows.map((row) => row.month_index)).toEqual([...Array(12).keys()]);
        for (const [index, row] of rows.entries()) {
          expect(new Date(row.starts_at).getTime() / 1000).toBe(
            index === 0 ? start : monthsBack(start, -index),
          );
          expect(Date.parse(row.expires_at!)).toBe(
            Date.parse(rows[index + 1]?.starts_at ?? new Date(end * 1000).toISOString()),
          );
        }
        expect(await balance()).toMatchObject({ balanceMicros: 60_000_000 });
      });

      it('ends each month’s credits with the month, and a refund in month 4 stops months 5 to 12', async () => {
        const start = monthsBack(now, 3) - 3600;
        const end = monthsBack(start, -12);
        await webhook(yearInvoice('in_y4', [yearLine(90_000, 3, start, end)]));
        expect((await balance()).balanceMicros).toBe(60_000_000);
        await webhook({
          type: 'charge.refunded',
          data: { object: { payment_intent: 'pi_in_y4', amount: 90_000, amount_refunded: 90_000 } },
        });
        expect((await balance()).balanceMicros).toBe(0);
        const rows = await grants();
        expect(rows.slice(4).every((row) => row.remaining_micros === 0)).toBe(true);
      });

      it('gives a seat added mid-year its share of this month and a full month after', async () => {
        const start = monthsBack(now, 6) + 10 * 86_400;
        const end = monthsBack(start, -12);
        await webhook(yearInvoice('in_y', [yearLine(90_000, 3, start, end)]));
        const from = now - 60;
        await webhook(
          yearInvoice(
            'in_y_add',
            [yearLine(-40_000, 3, from, end, true), yearLine(53_333, 4, from, end, true)],
            'subscription_update',
          ),
        );
        const added = (await grants()).filter((row) => row.stripe_invoice_id === 'in_y_add');
        expect(added.length).toBeGreaterThanOrEqual(6);
        expect(added.slice(1).every((row) => row.amount_micros === 20_000_000)).toBe(true);
        expect(added[0]!.amount_micros).toBeGreaterThan(0);
        expect(added[0]!.amount_micros).toBeLessThan(20_000_000);
        expect(added[0]!.amount_micros % 10_000).toBe(0);
        expect(Date.parse(added.at(-1)!.expires_at!)).toBe(end * 1000);
        expect((await balance()).balanceMicros).toBe(60_000_000 + added[0]!.amount_micros);
      });
    });

    describe('seat credits', () => {
      const start = Math.floor(Date.now() / 1000) - DAY;
      const end = start + 30 * DAY;
      const seatLine = (amount: number, quantity: number, proration = false, from = start) => ({
        amount,
        quantity,
        period: { start: from, end },
        pricing: { price_details: { price: 'price_app_team' }, unit_amount_decimal: '3000' },
        parent: { subscription_item_details: { proration } },
      });
      const seatInvoice = (
        payer: string,
        id: string,
        lines: Array<ReturnType<typeof seatLine>>,
        reason = 'subscription_create',
        extra: Record<string, string> = {},
      ) => ({
        type: 'invoice.paid',
        data: {
          object: {
            id,
            billing_reason: reason,
            payment_intent: `pi_${id}`,
            amount_paid: lines.reduce((sum, line) => sum + line.amount, 0),
            lines: { data: lines },
            parent: { subscription_details: { metadata: { ...seatMetadata(payer), ...extra } } },
          },
        },
      });
      const balance = async (person = 'p1') =>
        (
          (await dataOf(call('/usage.status', { person }))).credits as unknown as {
            balanceMicros: number;
          }
        ).balanceMicros;
      const added = (id: string, net: number, from = Math.floor(Date.now() / 1000) - 60) =>
        seatInvoice(
          'p1',
          id,
          [seatLine(-net * 5, 5, true, from), seatLine(net * 6, 6, true, from)],
          'subscription_update',
        );

      beforeEach(async () => {
        await startSeats('p1', 5);
        await webhook(seatInvoice('p1', 'in_seats', [seatLine(15_000, 5)]));
      });

      it('gives 5 seats at $20 each $100 on the first paid invoice', async () => {
        expect(await balance()).toBe(100_000_000);
        expect((await dataOf(call('/usage.status', { person: 'p1' }))).credits).toMatchObject({
          includedMicros: 100_000_000,
        });
      });

      it('gives a seat added halfway through $10 for the $15 charged, once', async () => {
        const event = { id: 'evt_half', ...added('in_half', 1500) };
        await webhook(event);
        await webhook(event);
        await webhook({ ...added('in_half', 1500), id: 'evt_half_again' });
        expect(await balance()).toBe(110_000_000);
      });

      it('gives a seat added on the 29th of 30 days its share, rounded down to the cent', async () => {
        await webhook(added('in_late', 100));
        expect(await balance()).toBe(100_660_000);
      });

      it('gives nothing for a seat removed, and keeps this period’s credits', async () => {
        await webhook(
          seatInvoice(
            'p1',
            'in_down',
            [seatLine(-1500, 5, true), seatLine(1200, 4, true)],
            'subscription_update',
          ),
        );
        expect(await balance()).toBe(100_000_000);
      });

      it('takes back only the seat’s grant when its invoice is refunded', async () => {
        await webhook(added('in_refund', 1500));
        await webhook({
          type: 'charge.refunded',
          data: { object: { payment_intent: 'pi_in_refund', amount: 1500, amount_refunded: 1500 } },
        });
        expect(await balance()).toBe(100_000_000);
      });

      it('on a dispute of a wallet’s seats, blocks the buyer and cancels the wallet’s seats', async () => {
        await call('/wallets.open', { payer: 'server-1' });
        await startSeats('server-1', 2);
        await env.db
          .update(appPeople)
          .set({ stripe_subscription_id: 'sub_server' })
          .where(eq(appPeople.person_id, 'server-1'));
        await webhook(
          seatInvoice('server-1', 'in_server', [seatLine(6000, 2)], 'subscription_create', {
            buyerId: 'p2',
          }),
        );
        expect(await balance('server-1')).toBe(40_000_000);
        await webhook({
          type: 'charge.dispute.created',
          data: {
            object: { payment_intent: 'pi_in_server', amount: 6000, status: 'needs_response' },
          },
        });
        expect(await balance('server-1')).toBe(0);
        expect(
          calls.some(
            ([url, init]) =>
              init?.method === 'DELETE' && url.endsWith('/v1/subscriptions/sub_server'),
          ),
        ).toBe(true);
        const [buyer] = await env.db.select().from(appPayers).where(eq(appPayers.payer_id, 'p2'));
        expect(buyer!.blocked_at).not.toBeNull();
      });
    });
  });

  describe('domains and sign-in', () => {
    let projectId: string;
    const onPlan = (plan: string) =>
      env.db
        .insert(appPeople)
        .values({ client_id: registration.client.id, person_id: 'p1', plan })
        .onConflictDoUpdate({ target: [appPeople.client_id, appPeople.person_id], set: { plan } });

    beforeEach(async () => {
      await env.db
        .update(oauthClients)
        .set({
          plans: {
            solo: { stripePriceId: 'price_app_solo', creditMicros: 0 },
            team: {
              stripePriceId: 'price_app_team',
              creditMicros: 0,
              perSeat: true,
              customDomains: true,
              protection: true,
            },
          },
        })
        .where(eq(oauthClients.id, registration.client.id));
      const owner = await createTestUser(env.db, 'p1', 'app:' + registration.client.id, 'p1');
      projectId = (await createTestProject(env.db, owner.id, 'corner-cafe')).id;
    });
    afterEach(() => {
      vi.restoreAllMocks();
      delete (env as { PLATFORM_CAPABILITIES?: string }).PLATFORM_CAPABILITIES;
    });

    it('adds a custom domain for a payer whose plan has them, and answers the DNS record', async () => {
      const order = { project: 'corner-cafe', hostname: 'shop.example.com' };
      expect(await (await call('/domains.add', order)).json()).toMatchObject({
        error: 'plan_required',
        feature: 'customDomains',
      });
      await onPlan('solo');
      expect((await call('/domains.add', order)).status).toBe(403);
      await onPlan('team');
      mockCfApi({
        createCustomHostname: () =>
          cfSuccess({
            id: 'ch-shop',
            hostname: 'shop.example.com',
            status: 'pending',
            ssl: { status: 'pending_validation', validation_records: [] },
          }),
      });
      const added = (await (await call('/domains.add', order)).json()) as {
        data: { domainId: string; dns: { type: string; name: string; target: string } };
      };
      expect(added.data.dns).toMatchObject({ type: 'CNAME', name: 'shop.example.com' });
      expect(added.data.dns.target).toMatch(/^cname\./);
      expect(await (await call('/domains.list', { project: projectId })).json()).toMatchObject({
        data: { domains: [{ domainId: added.data.domainId, hostname: 'shop.example.com' }] },
      });
      expect(
        await (await call('/domains.add', { ...order, hostname: 'not a host' })).json(),
      ).toMatchObject({ error: 'HOSTNAME_INVALID' });
    });

    it('answers CAPABILITY_UNAVAILABLE when the installation has custom domains off', async () => {
      await onPlan('team');
      (env as { PLATFORM_CAPABILITIES?: string }).PLATFORM_CAPABILITIES = JSON.stringify({
        ai: true,
        customDomains: false,
        email: true,
        githubActions: true,
        githubOAuth: true,
        googleOAuth: true,
        managedBuilds: true,
        sandbox: true,
      });
      const refused = await call('/domains.add', { project: projectId, hostname: 'a.example.com' });
      expect(refused.status).toBe(501);
      expect(await refused.json()).toMatchObject({ error: 'CAPABILITY_UNAVAILABLE' });
    });

    it('checks the email domains and the plan before turning on sign-in', async () => {
      const protect = (emailDomains: unknown) =>
        call('/projects.protect', { project: projectId, emailDomains });
      expect((await protect([])).status).toBe(400);
      expect((await protect(['Example.com'])).status).toBe(400);
      expect(await (await protect(['example.com'])).json()).toMatchObject({
        error: 'plan_required',
        feature: 'protection',
      });
      await onPlan('team');
      expect(await (await protect(['example.com'])).json()).toMatchObject({
        error: 'ZERO_TRUST_UNAVAILABLE',
      });
    });
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
