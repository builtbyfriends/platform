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
import { deliverBillingEvents } from '../../src/billing-events.ts';
import { verifyStripeSignature } from '../../src/billing/stripe.ts';
import { grantCredits, spendCredits } from '../../src/credit-ledger.ts';
import rawApp from '../../src/index.ts';
import { appBillingEvents, appPayers, appPeople, oauthClients } from '../../src/schema.ts';
import {
  clearTables,
  createMockExecutionContext,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  withLegacyDeploy,
  type TestEnv,
} from './helpers.ts';

const app = withLegacyDeploy(rawApp);
const origin = 'https://platform.example.com';
const ctx = createMockExecutionContext();
const DOLLAR = 1_000_000;
const SECRET = 'whsec_events';
let env: TestEnv & { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string };
let registration: Awaited<ReturnType<typeof registerOAuthClient>>;

const basic = () => 'Basic ' + btoa(registration.client.id + ':' + registration.clientSecret);
const status = (person = 'p1') =>
  app.fetch(
    new Request(origin + '/app-billing/usage.status', {
      method: 'POST',
      headers: { Authorization: basic(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ person }),
    }),
    env,
    ctx,
  );

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

type Sent = { url: string; headers: Headers; body: string };
let sent: Array<Sent>;
let answer: () => Response;
const receiver: typeof fetch = async (input, init) => {
  sent.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
  return answer();
};
const deliver = (now = new Date()) => deliverBillingEvents(env.db, now, receiver);
const delivered = () => sent.map((event) => JSON.parse(event.body));
const payer = () => ({ clientId: registration.client.id, payer: 'p1' });
const give = (micros: number) =>
  grantCredits(env.db, { ...payer(), source: 'given', amountMicros: micros, livemode: false });

describe('billing events', () => {
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
      .set({ events_url: 'https://app.example.com/events', events_secret: SECRET })
      .where(eq(oauthClients.id, registration.client.id));
    sent = [];
    answer = () => new Response(null, { status: 204 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a signed event once when the balance gets low, once at zero, and when it comes back', async () => {
    await give(10 * DOLLAR);
    await status();
    await spendCredits(env.db, payer(), 9 * DOLLAR);
    await status();
    await status();
    await deliver();
    expect(delivered()).toEqual([
      expect.objectContaining({
        type: 'credits.low',
        person: 'p1',
        data: { balanceMicros: DOLLAR },
      }),
    ]);
    const [first] = sent;
    expect(first!.url).toBe('https://app.example.com/events');
    expect(first!.headers.get('billing-event-id')).toBe(delivered()[0].id);
    expect(
      await verifyStripeSignature(first!.body, first!.headers.get('billing-signature'), SECRET),
    ).toBe(true);
    expect(
      await verifyStripeSignature(first!.body, first!.headers.get('billing-signature'), 'whsec_no'),
    ).toBe(false);

    await spendCredits(env.db, payer(), 2 * DOLLAR);
    await status();
    await status();
    await give(5 * DOLLAR);
    await status();
    await deliver();
    expect(delivered().map((event) => event.type)).toEqual([
      'credits.low',
      'credits.out',
      'credits.restored',
    ]);
    expect(delivered()[1].data).toEqual({
      balanceMicros: -DOLLAR,
      pausesAt: expect.any(String),
    });
  });

  it('tells the application when the hosted apps a payer pays for pause and resume', async () => {
    const owner = await createTestUser(env.db, 'p1', 'app:' + registration.client.id, 'p1');
    const project = await createTestProject(env.db, owner.id);
    await give(DOLLAR);
    await spendCredits(env.db, payer(), 2 * DOLLAR);
    await status();
    await env.db
      .update(appPayers)
      .set({ out_since: new Date(Date.now() - 4 * 86_400_000).toISOString() })
      .where(eq(appPayers.payer_id, 'p1'));
    await status();
    await give(5 * DOLLAR);
    await status();
    await deliver();
    expect(delivered().map((event) => [event.type, event.data.projects])).toEqual([
      ['credits.out', undefined],
      ['apps.paused', [project.id]],
      ['credits.restored', undefined],
      ['apps.resumed', [project.id]],
    ]);
  });

  it('sends a failed subscription payment to the right person', async () => {
    await env.db
      .update(oauthClients)
      .set({ plans: { solo: { stripePriceId: 'price_solo', creditMicros: 0 } } })
      .where(eq(oauthClients.id, registration.client.id));
    await env.db.insert(appPeople).values({
      client_id: registration.client.id,
      person_id: 'p7',
      plan: 'solo',
      stripe_subscription_id: 'sub_1',
      subscription_status: 'active',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ id: 'sub_1', status: 'past_due', customer: 'cus_1', items: { data: [] } }),
    );
    await webhook({
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_1',
          parent: {
            subscription_details: {
              subscription: 'sub_1',
              metadata: { clientId: registration.client.id, personId: 'p7', plan: 'solo' },
            },
          },
        },
      },
    });
    await deliver();
    expect(delivered()).toEqual([
      expect.objectContaining({
        type: 'payment.failed',
        person: 'p7',
        data: { for: 'subscription' },
      }),
    ]);
  });

  it('tells the application about credits bought at Checkout', async () => {
    await webhook({
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          amount_subtotal: 2000,
          customer: 'cus_1',
          payment_intent: 'pi_1',
          metadata: {
            kind: 'credits',
            clientId: registration.client.id,
            buyerId: 'p1',
            payerId: 'p1',
            lifeDays: '365',
          },
        },
      },
    });
    await deliver();
    expect(delivered()).toEqual([
      expect.objectContaining({
        type: 'credits.bought',
        person: 'p1',
        data: expect.objectContaining({ amountMicros: 20 * DOLLAR, buyer: 'p1', autoTopUp: false }),
      }),
    ]);
  });

  it('tries a failed delivery again later with the same id', async () => {
    await give(DOLLAR);
    await status();
    answer = () => new Response('down', { status: 503 });
    const now = new Date();
    expect(await deliver(now)).toBe(true);
    await deliver(now);
    expect(sent).toHaveLength(1);
    answer = () => new Response(null, { status: 200 });
    await deliver(new Date(now.getTime() + 3 * 60_000));
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body).toBe(sent[1]!.body);
    expect(sent[0]!.headers.get('billing-event-id')).toBe(sent[1]!.headers.get('billing-event-id'));
    const [row] = await env.db.select().from(appBillingEvents);
    expect(row).toMatchObject({ attempts: 2 });
    expect(row?.sent_at).not.toBeNull();
    expect(await deliver(new Date(now.getTime() + 10 * 60_000))).toBe(false);
  });

  it('sends nothing to an application with no address, and nothing fails', async () => {
    await env.db
      .update(oauthClients)
      .set({ events_url: null })
      .where(eq(oauthClients.id, registration.client.id));
    await give(DOLLAR);
    expect((await status()).status).toBe(200);
    await spendCredits(env.db, payer(), 2 * DOLLAR);
    expect((await status()).status).toBe(200);
    expect(await deliver()).toBe(false);
    expect(sent).toEqual([]);
    expect(await env.db.select().from(appBillingEvents)).toEqual([]);
  });
});
