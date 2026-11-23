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
import { spendCredits } from '../../src/credit-ledger.ts';
import rawApp from '../../src/index.ts';
import { appBillingEvents, appCreditGrants, oauthClients } from '../../src/schema.ts';
import {
  clearTables,
  createMockExecutionContext,
  rpcData,
  setupEnv,
  teardownEnv,
  withLegacyDeploy,
  type TestEnv,
} from './helpers.ts';

const app = withLegacyDeploy(rawApp);
const origin = 'https://platform.example.com';
const ctx = createMockExecutionContext();
const DOLLAR = 1_000_000;
let env: TestEnv & { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string };
let registration: Awaited<ReturnType<typeof registerOAuthClient>>;

const basic = () => 'Basic ' + btoa(registration.client.id + ':' + registration.clientSecret);

async function call(path: string, body: unknown) {
  return app.fetch(
    new Request(origin + '/app-billing' + path, {
      method: 'POST',
      headers: { Authorization: basic(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

type Status = {
  credits: { balanceMicros: number; grants: Array<{ source: string; expiresAt: string }> } | null;
  autoTopUp: { enabled: boolean; offReason: string | null; chargedThisMonthMicros: number } | null;
};
const status = async (person = 'p1') =>
  rpcData<Status>(await (await call('/usage.status', { person })).json());

async function webhook(event: object) {
  const body = JSON.stringify({ id: 'evt_' + crypto.randomUUID(), livemode: false, ...event });
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('whsec_test'),
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

const paidSession = (cents: number, extra: Record<string, string> = {}) => ({
  type: 'checkout.session.completed',
  data: {
    object: {
      id: 'cs_' + crypto.randomUUID(),
      mode: 'payment',
      payment_status: 'paid',
      amount_subtotal: cents,
      amount_total: Math.round(cents * 1.08),
      customer: 'cus_buyer',
      payment_intent: 'pi_' + crypto.randomUUID(),
      metadata: {
        kind: 'credits',
        clientId: registration.client.id,
        buyerId: 'p1',
        payerId: 'p1',
        lifeDays: '365',
        saveCard: 'false',
        ...extra,
      },
    },
  },
});

const order = (amountMicros: number, extra: object = {}) => ({
  buyer: 'p1',
  amountMicros,
  returnUrl: 'https://example.com/credits',
  ...extra,
});

const spend = (micros: number) =>
  call('/usage.record', { person: 'p1', aiNeurons: Math.ceil(micros / 11) });

describe('buying credits', () => {
  let calls: Array<{ url: string; init: RequestInit | undefined }>;
  let charge: () => Response | Promise<Response>;

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
    await env.db
      .update(oauthClients)
      .set({ credit_purchase: { minMicros: 20 * DOLLAR, stepMicros: 20 * DOLLAR, lifeDays: 365 } })
      .where(eq(oauthClients.id, registration.client.id));
    calls = [];
    let charges = 0;
    charge = () => Response.json({ id: `pi_top_${++charges}`, status: 'succeeded' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/v1/payment_intents')) {
        return charge();
      }
      if (url.includes('/v1/payment_intents/')) {
        return Response.json({ id: 'pi_x', payment_method: 'pm_saved' });
      }
      return Response.json({ url: 'https://stripe.example/session' });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const charges = () => calls.filter((c) => c.url.endsWith('/v1/payment_intents'));
  const checkoutForm = () =>
    new URLSearchParams(String(calls.filter((c) => c.url.includes('checkout')).at(-1)!.init!.body));

  it('sells $20 of credits to a person with no plan, once, for 12 months', async () => {
    expect((await call('/credits.checkout', order(20 * DOLLAR))).status).toBe(200);
    const form = checkoutForm();
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('2000');
    expect(form.get('customer_creation')).toBe('always');
    expect(form.get('metadata[buyerId]')).toBe('p1');
    expect(form.get('metadata[payerId]')).toBe('p1');
    expect(form.get('payment_intent_data[metadata][kind]')).toBe('credits');
    expect(form.has('allow_promotion_codes')).toBe(false);

    const paid = paidSession(2000);
    await webhook(paid);
    await webhook(paid);
    const { credits } = await status();
    expect(credits?.balanceMicros).toBe(20 * DOLLAR);
    expect(credits?.grants).toHaveLength(1);
    expect(credits?.grants[0]?.source).toBe('bought');
    const days = (Date.parse(credits!.grants[0]!.expiresAt) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(365);
    const [grant] = await env.db.select().from(appCreditGrants);
    expect(grant?.giver_id).toBe('p1');
  });

  it('refuses an amount under the smallest one or off the step', async () => {
    for (const amount of [10 * DOLLAR, 30 * DOLLAR, 0, -20 * DOLLAR, 20.5 * DOLLAR]) {
      const answer = await call('/credits.checkout', order(amount));
      expect(answer.status).toBe(400);
      expect(await answer.json()).toMatchObject({ error: 'bad_amount' });
    }
    expect((await call('/credits.checkout', order(40 * DOLLAR))).status).toBe(200);
    expect(
      await (await call('/credits.checkout', order(20 * DOLLAR, { payer: 'p2' }))).json(),
    ).toEqual({ error: 'buy_for_others_off' });
  });

  it('sells nothing when the operator set no credit sales', async () => {
    await env.db
      .update(oauthClients)
      .set({ credit_purchase: null })
      .where(eq(oauthClients.id, registration.client.id));
    expect(await (await call('/credits.checkout', order(20 * DOLLAR))).json()).toEqual({
      error: 'credits_not_sold',
    });
  });

  it('reuses the buyer’s Stripe customer on a second purchase', async () => {
    await webhook(paidSession(2000));
    await call('/credits.checkout', order(20 * DOLLAR));
    const form = checkoutForm();
    expect(form.get('customer')).toBe('cus_buyer');
    expect(form.has('customer_creation')).toBe(false);
  });

  describe('auto top-up', () => {
    const settings = {
      payer: 'p1',
      thresholdMicros: 5 * DOLLAR,
      amountMicros: 20 * DOLLAR,
      monthlyLimitMicros: 40 * DOLLAR,
    };

    it('needs a card saved by a credits Checkout', async () => {
      await webhook(paidSession(2000));
      expect((await call('/credits.autoTopUp', settings)).status).toBe(409);
      await call('/credits.checkout', order(20 * DOLLAR, { saveCard: true }));
      expect(checkoutForm().get('payment_intent_data[setup_future_usage]')).toBe('off_session');
      await webhook(paidSession(2000, { saveCard: 'true' }));
      expect((await call('/credits.autoTopUp', settings)).status).toBe(200);
    });

    it('charges once under the threshold, even for two debits at once, and stops at the monthly limit', async () => {
      await webhook(paidSession(2000, { saveCard: 'true' }));
      await call('/credits.autoTopUp', settings);
      expect(charges()).toHaveLength(0);

      await spendCredits(env.db, { clientId: registration.client.id, payer: 'p1' }, 16 * DOLLAR);
      const reply = charge;
      charge = async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return reply();
      };
      await Promise.all([status(), status(), spend(DOLLAR)]);
      charge = reply;
      expect(charges()).toHaveLength(1);
      const sent = new URLSearchParams(String(charges()[0]!.init!.body));
      expect(sent.get('off_session')).toBe('true');
      expect(sent.get('payment_method')).toBe('pm_saved');
      expect(sent.get('customer')).toBe('cus_buyer');
      expect(sent.get('amount')).toBe('2000');
      expect(new Headers(charges()[0]!.init!.headers).get('idempotency-key')).toMatch(
        /^top-up:.+:p1:1:20000000$/,
      );
      let now = await status();
      expect(now.credits?.grants.filter((g) => g.source === 'bought')).toHaveLength(2);

      await spend(now.credits!.balanceMicros - DOLLAR);
      expect(charges()).toHaveLength(2);
      now = await status();
      expect(now.autoTopUp).toMatchObject({ enabled: true, chargedThisMonthMicros: 40 * DOLLAR });

      await spend(now.credits!.balanceMicros - DOLLAR);
      expect(charges()).toHaveLength(2);
      expect((await status()).autoTopUp).toMatchObject({
        enabled: false,
        offReason: 'monthly_limit',
      });
    });

    it('turns itself off on a declined card, adds no credits, and tells the application once', async () => {
      await env.db
        .update(oauthClients)
        .set({ events_url: 'https://app.example.com/events', events_secret: 'whsec_x' })
        .where(eq(oauthClients.id, registration.client.id));
      await webhook(paidSession(2000, { saveCard: 'true' }));
      await call('/credits.autoTopUp', settings);
      charge = () =>
        Response.json(
          {
            error: {
              type: 'card_error',
              code: 'card_declined',
              decline_code: 'insufficient_funds',
            },
          },
          { status: 402 },
        );
      await spend(18 * DOLLAR);
      expect(charges()).toHaveLength(1);
      const now = await status();
      expect(now.autoTopUp).toMatchObject({
        enabled: false,
        offReason: 'card_declined',
        chargedThisMonthMicros: 0,
      });
      expect(now.credits?.grants).toHaveLength(1);
      await spend(DOLLAR);
      expect(charges()).toHaveLength(1);
      await webhook({
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_declined',
            amount: 2000,
            last_payment_error: { code: 'card_declined' },
            metadata: {
              kind: 'top_up',
              clientId: registration.client.id,
              buyerId: 'p1',
              payerId: 'p1',
              lifeDays: '365',
            },
          },
        },
      });
      const failed = (await env.db.select().from(appBillingEvents))
        .filter((event) => event.type === 'payment.failed')
        .map((event) => JSON.parse(event.body));
      expect(failed).toEqual([
        expect.objectContaining({
          person: 'p1',
          data: { for: 'auto_top_up', amountMicros: 20 * DOLLAR, reason: 'card_declined' },
        }),
      ]);
      expect((await status()).autoTopUp).toMatchObject({ chargedThisMonthMicros: 0 });
    });

    it('grants a charge that Stripe confirms later, once', async () => {
      await webhook(paidSession(2000, { saveCard: 'true' }));
      await call('/credits.autoTopUp', settings);
      charge = () => Response.json({ id: 'pi_slow', status: 'processing' });
      await spend(18 * DOLLAR);
      const succeeded = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_slow',
            amount: 2000,
            metadata: {
              kind: 'top_up',
              clientId: registration.client.id,
              buyerId: 'p1',
              payerId: 'p1',
              lifeDays: '365',
            },
          },
        },
      };
      await webhook(succeeded);
      await webhook(succeeded);
      const now = await status();
      expect(now.credits?.grants.filter((g) => g.source === 'bought')).toHaveLength(2);
      expect(charges()).toHaveLength(1);
    });
  });
});
