import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vite-plus/test';
import { registerOAuthClient } from '../../src/auth/oauth.ts';
import rawApp from '../../src/index.ts';
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
type Answer = {
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

  it('refuses an unsigned webhook', async () => {
    const response = await app.fetch(
      new Request(origin + '/billing/stripe', { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
  });
});
