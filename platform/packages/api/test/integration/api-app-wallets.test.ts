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
import { creditBalance, grantCredits, spendCredits } from '../../src/credit-ledger.ts';
import rawApp from '../../src/index.ts';
import { appBuyers, appCreditGrants, appPayers, oauthClients } from '../../src/schema.ts';
import {
  captureQueries,
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
let calls: Array<{ url: string; init: RequestInit | undefined }>;

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
  wallet: boolean;
  plan: string | null;
  caps: object | null;
  credits: { balanceMicros: number; out: boolean } | null;
};
const status = async (person: string) =>
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

const paid = (buyer: string, payer: string, cents: number, extra: Record<string, string> = {}) => {
  const paymentIntent = 'pi_' + crypto.randomUUID();
  return {
    paymentIntent,
    event: {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_' + crypto.randomUUID(),
          mode: 'payment',
          payment_status: 'paid',
          amount_subtotal: cents,
          amount_total: cents,
          customer: 'cus_' + buyer,
          customer_details: { address: { country: 'US', state: 'CA' } },
          payment_intent: paymentIntent,
          metadata: {
            kind: 'credits',
            clientId: registration.client.id,
            buyerId: buyer,
            payerId: payer,
            lifeDays: '365',
            saveCard: 'false',
            ...extra,
          },
        },
      },
    },
  };
};

const dispute = (paymentIntent: string) =>
  webhook({
    type: 'charge.dispute.created',
    data: { object: { payment_intent: paymentIntent, amount: 2000, status: 'needs_response' } },
  });

const buyForOthers = (on: boolean, caps: object = {}) =>
  env.db
    .update(oauthClients)
    .set({
      credit_purchase: {
        minMicros: 20 * DOLLAR,
        stepMicros: 20 * DOLLAR,
        lifeDays: 365,
        buyForOthers: on,
        ...caps,
      },
    })
    .where(eq(oauthClients.id, registration.client.id));

const give = (payer: string, amountMicros: number) =>
  grantCredits(env.db, {
    clientId: registration.client.id,
    payer,
    source: 'given',
    amountMicros,
    livemode: false,
  });

describe('wallets', () => {
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
      .set({
        credit_purchase: { minMicros: 20 * DOLLAR, stepMicros: 20 * DOLLAR, lifeDays: 365 },
        starter_credit_micros: 2 * DOLLAR,
        plans: { pro: { stripePriceId: 'price_pro', creditMicros: 10 * DOLLAR } },
      })
      .where(eq(oauthClients.id, registration.client.id));
    calls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/v1/payment_intents')) {
        return Response.json({ id: 'pi_top_' + calls.length, status: 'succeeded' });
      }
      if (url.includes('/v1/payment_intents/')) {
        return Response.json({ id: 'pi_x', payment_method: 'pm_' + url.split('/').at(-1) });
      }
      return Response.json({ url: 'https://stripe.example/session' });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('a wallet with no plan', () => {
    it('reads as a balance of zero and out, with no plan or caps', async () => {
      expect((await call('/wallets.open', { payer: 'server:1' })).status).toBe(200);
      expect(await status('server:1')).toMatchObject({
        wallet: true,
        plan: null,
        caps: null,
        credits: { balanceMicros: 0, out: true },
      });
    });

    it('reads $20 and not out after a $20 grant', async () => {
      await call('/wallets.open', { payer: 'server:1' });
      await give('server:1', 20 * DOLLAR);
      expect((await status('server:1')).credits).toMatchObject({
        balanceMicros: 20 * DOLLAR,
        out: false,
      });
    });

    it('refuses the starter credit, a plan Checkout and the portal', async () => {
      await call('/wallets.open', { payer: 'server:1' });
      for (const [path, body] of [
        ['/credits.starter', { person: 'server:1' }],
        ['/billing.checkout', { person: 'server:1', plan: 'pro', returnUrl: 'https://x.test' }],
        ['/billing.portal', { person: 'server:1', returnUrl: 'https://x.test' }],
      ] as const) {
        const answer = await call(path, body);
        expect(answer.status).toBe(400);
        expect(await answer.json()).toMatchObject({ error: 'payer_is_wallet' });
      }
      expect(calls).toHaveLength(0);
    });

    it('leaves a person as before', async () => {
      expect(await status('p1')).toMatchObject({
        wallet: false,
        plan: 'free',
        caps: expect.any(Object),
        credits: null,
      });
      expect(await (await call('/credits.starter', { person: 'p1' })).json()).toMatchObject({
        data: { granted: true },
      });
    });
  });

  describe('use by person', () => {
    const turn = (by: string | undefined, id: string) =>
      call('/usage.record', { person: 'server:1', aiNeurons: 100_000, by, id });

    it('keeps a total for each person, counts a resent report once, and charges the wallet', async () => {
      await call('/wallets.open', { payer: 'server:1' });
      await give('server:1', 20 * DOLLAR);
      await turn('ana', 'r1');
      await turn('ana', 'r1');
      await turn('ana', 'r2');
      await turn('ben', 'r3');
      await turn(undefined, 'r4');
      const answer = rpcData<{
        byPerson: Array<{ person: string; usedMicros: number }>;
        credits: { balanceMicros: number };
      }>(await (await call('/usage.status', { person: 'server:1', byPerson: true })).json());
      expect(answer.byPerson).toEqual([
        { person: 'ana', usedMicros: 2_200_000 },
        { person: 'ben', usedMicros: 1_100_000 },
      ]);
      expect(answer.credits.balanceMicros).toBe(20 * DOLLAR - 4 * 1_100_000);
    });
  });

  describe('picking who pays', () => {
    const list = (limit?: number) => ({
      wallets: [
        { payer: 'bot:1', person: 'ana' },
        { payer: 'server:1', person: 'ana', monthlyLimitMicros: limit },
        { payer: 'ana', person: 'ana' },
        { payer: 'bot:1', person: 'ana' },
      ],
    });
    const pick = async (body: object) =>
      rpcData<{
        payer: string | null;
        wallets: Array<{ payer: string; skipped?: string; balanceMicros: number | null }>;
      }>(await (await call('/payer.pick', body)).json());

    beforeEach(async () => {
      for (const payer of ['bot:1', 'server:1']) {
        await call('/wallets.open', { payer });
      }
      await give('ana', 5 * DOLLAR);
    });

    it('answers the first wallet with credits, in one read and no Stripe call', async () => {
      await give('bot:1', 2 * DOLLAR);
      const { result, queries } = await captureQueries(env.db, () => pick(list()));
      expect(result.payer).toBe('bot:1');
      expect(result.wallets.map((wallet) => wallet.payer)).toEqual(['bot:1', 'server:1', 'ana']);
      expect(queries.filter((query) => query.includes('from "app_'))).toHaveLength(3);
      expect(calls).toHaveLength(0);
    });

    it('falls back past an empty wallet and a person over their limit', async () => {
      await give('server:1', 10 * DOLLAR);
      expect((await pick(list(DOLLAR))).payer).toBe('server:1');
      await call('/usage.record', { person: 'server:1', aiNeurons: 100_000, by: 'ana' });
      const answer = await pick(list(DOLLAR));
      expect(answer.payer).toBe('ana');
      expect(answer.wallets.map((wallet) => wallet.skipped)).toEqual([
        'empty',
        'over_limit',
        undefined,
      ]);
    });

    it('answers no payer, with each reason, when nothing is left', async () => {
      await call('/usage.record', { person: 'ana', aiNeurons: 1_000_000 });
      const answer = await pick(list());
      expect(answer.payer).toBeNull();
      expect(answer.wallets.map((wallet) => wallet.skipped)).toEqual(['empty', 'empty', 'empty']);
    });

    it('answers a person on their plan with no balance', async () => {
      const answer = await pick({ wallets: [{ payer: 'ben', person: 'ben' }] });
      expect(answer).toEqual({
        payer: 'ben',
        wallets: [{ payer: 'ben', balanceMicros: null, personUsedMicros: 0 }],
      });
    });
  });

  describe('buying for a wallet', () => {
    const order = (buyer: string, payer: string, extra: object = {}) => ({
      buyer,
      payer,
      amountMicros: 20 * DOLLAR,
      returnUrl: 'https://example.com/credits',
      ...extra,
    });
    const lastCheckout = () =>
      new URLSearchParams(
        String(calls.filter((c) => c.url.includes('checkout')).at(-1)!.init!.body),
      );

    beforeEach(async () => {
      await call('/wallets.open', { payer: 'server:1' });
    });

    it('is off until the operator turns it on', async () => {
      const answer = await call('/credits.checkout', order('ana', 'server:1'));
      expect(answer.status).toBe(403);
      expect(await answer.json()).toEqual({ error: 'buy_for_others_off' });
    });

    it('grants a purchase to the wallet with the buyer as giver, and keeps each buyer’s customer', async () => {
      await buyForOthers(true);
      const label = 'Credits for the Design server';
      expect((await call('/credits.checkout', order('ana', 'server:1', { label }))).status).toBe(
        200,
      );
      expect(lastCheckout().get('metadata[payerId]')).toBe('server:1');
      expect(lastCheckout().get('metadata[buyerId]')).toBe('ana');
      expect(lastCheckout().get('line_items[0][price_data][product_data][name]')).toBe(label);
      await webhook(paid('ana', 'server:1', 2000).event);
      await webhook(paid('ben', 'server:1', 2000).event);
      const grants = await env.db.select().from(appCreditGrants);
      expect(
        grants.map((grant) => [grant.payer_id, grant.giver_id, grant.billing_country]),
      ).toEqual(
        expect.arrayContaining([
          ['server:1', 'ana', 'US'],
          ['server:1', 'ben', 'US'],
        ]),
      );
      expect((await status('server:1')).credits?.balanceMicros).toBe(40 * DOLLAR);
      const buyers = await env.db.select().from(appBuyers);
      expect(buyers.map((buyer) => [buyer.buyer_id, buyer.stripe_customer_id]).sort()).toEqual([
        ['ana', 'cus_ana'],
        ['ben', 'cus_ben'],
      ]);
    });

    it('blocks the buyer on a dispute, and the wallet works again once its owed is settled', async () => {
      await buyForOthers(true);
      const gift = paid('ana', 'server:1', 2000);
      await webhook(gift.event);
      await call('/usage.record', { person: 'server:1', aiNeurons: 500_000 });
      await dispute(gift.paymentIntent);
      const rows = await env.db.select().from(appPayers);
      expect(rows.find((row) => row.payer_id === 'ana')?.blocked_reason).toBe('dispute');
      expect(rows.find((row) => row.payer_id === 'server:1')?.blocked_at).toBeNull();
      expect((await status('server:1')).credits).toMatchObject({ balanceMicros: -5_500_000 });
      expect(await (await call('/credits.checkout', order('ana', 'server:1'))).json()).toEqual({
        error: 'blocked',
      });
      expect((await call('/credits.checkout', order('ben', 'server:1'))).status).toBe(200);
      await webhook(paid('ben', 'server:1', 2000).event);
      expect((await status('server:1')).credits).toMatchObject({
        balanceMicros: 14_500_000,
        out: false,
      });
    });

    it('charges the card of the person who set up auto top-up on a wallet', async () => {
      await buyForOthers(true);
      await webhook(paid('ana', 'server:1', 2000, { saveCard: 'true' }).event);
      const settings = {
        payer: 'server:1',
        buyer: 'ana',
        thresholdMicros: 5 * DOLLAR,
        amountMicros: 20 * DOLLAR,
        monthlyLimitMicros: 40 * DOLLAR,
      };
      expect((await call('/credits.autoTopUp', settings)).status).toBe(200);
      await call('/usage.record', { person: 'server:1', aiNeurons: 1_500_000 });
      const charge = calls.find((c) => c.url.endsWith('/v1/payment_intents'));
      const form = new URLSearchParams(String(charge!.init!.body));
      expect(form.get('customer')).toBe('cus_ana');
      expect(form.get('metadata[payerId]')).toBe('server:1');
      expect(form.get('metadata[buyerId]')).toBe('ana');
      expect((await status('server:1')).credits?.balanceMicros).toBe(23_500_000);
    });
  });

  describe('moving bought credits', () => {
    const move = (amountMicros: number, id: string, from = 'ana', to = 'bot:1') =>
      call('/credits.move', { from, to, amountMicros, id });
    let purchase: ReturnType<typeof paid>;

    beforeEach(async () => {
      await buyForOthers(true);
      await call('/wallets.open', { payer: 'bot:1' });
      purchase = paid('ana', 'ana', 2000);
      await webhook(purchase.event);
    });

    it('moves $10 into a bot’s wallet with the same end date, once for one id', async () => {
      const movedOf = async (answer: Promise<Response>) =>
        rpcData<{ moved: boolean }>(await (await answer).json()).moved;
      expect(await movedOf(move(10 * DOLLAR, 'm1'))).toBe(true);
      expect(await movedOf(move(10 * DOLLAR, 'm1'))).toBe(false);
      expect((await status('ana')).credits?.balanceMicros).toBe(10 * DOLLAR);
      expect((await status('bot:1')).credits?.balanceMicros).toBe(10 * DOLLAR);
      const grants = await env.db.select().from(appCreditGrants);
      const original = grants.find((grant) => grant.payer_id === 'ana')!;
      const moved = grants.find((grant) => grant.payer_id === 'bot:1')!;
      expect(moved).toMatchObject({
        source: 'moved',
        giver_id: 'ana',
        moved_from: original.id,
        expires_at: original.expires_at,
        stripe_payment_intent_id: purchase.paymentIntent,
      });
    });

    it('refuses to move moved credits, or to move to a person', async () => {
      await call('/wallets.open', { payer: 'bot:2' });
      await move(10 * DOLLAR, 'm1');
      expect(await (await move(5 * DOLLAR, 'm2', 'bot:1', 'bot:2')).json()).toEqual({
        error: 'from_is_wallet',
      });
      expect(await (await move(5 * DOLLAR, 'm3', 'ana', 'ben')).json()).toEqual({
        error: 'not_a_wallet',
      });
    });

    it('refuses to move starter or plan credits', async () => {
      await call('/credits.starter', { person: 'ben' });
      await grantCredits(env.db, {
        clientId: registration.client.id,
        payer: 'ben',
        source: 'plan',
        amountMicros: 10 * DOLLAR,
        livemode: false,
      });
      expect(await (await move(DOLLAR, 'm1', 'ben')).json()).toEqual({ error: 'not_enough' });
    });

    it('takes back the unspent part from each wallet on a dispute, and leaves owed where it was spent', async () => {
      await move(10 * DOLLAR, 'm1');
      await call('/usage.record', { person: 'bot:1', aiNeurons: 300_000 });
      await dispute(purchase.paymentIntent);
      expect((await status('ana')).credits?.balanceMicros).toBe(0);
      expect((await status('bot:1')).credits?.balanceMicros).toBe(-3_300_000);
      const rows = await env.db.select().from(appPayers);
      expect(rows.find((row) => row.payer_id === 'ana')?.blocked_reason).toBe('dispute');
    });

    it('takes a refund from the buyer’s own credits first, then from the wallet', async () => {
      await move(15 * DOLLAR, 'm1');
      const refund = (amount: number) =>
        webhook({
          type: 'charge.refunded',
          data: {
            object: {
              payment_intent: purchase.paymentIntent,
              amount: 2000,
              amount_refunded: amount,
            },
          },
        });
      await refund(1000);
      expect((await status('ana')).credits?.balanceMicros).toBe(0);
      expect((await status('bot:1')).credits?.balanceMicros).toBe(10 * DOLLAR);
      await refund(1000);
      expect((await status('bot:1')).credits?.balanceMicros).toBe(10 * DOLLAR);
    });
  });

  describe('daily caps and holds', () => {
    const caps = { buyerDailyMicros: 500 * DOLLAR, walletDailyMicros: 1000 * DOLLAR };
    const order = (buyer: string, payer: string, extra: object = {}) =>
      call('/credits.checkout', {
        buyer,
        payer,
        amountMicros: 100 * DOLLAR,
        returnUrl: 'https://example.com/credits',
        ...extra,
      });

    beforeEach(async () => {
      await buyForOthers(true, caps);
      await call('/wallets.open', { payer: 'server:1' });
    });

    it('refuses a buyer’s sixth $100 purchase in a day', async () => {
      for (let index = 0; index < 5; index++) {
        expect((await order('ana', 'ana')).status).toBe(200);
        await webhook(paid('ana', 'ana', 10_000).event);
      }
      const answer = await order('ana', 'ana');
      expect(answer.status).toBe(403);
      expect(await answer.json()).toEqual({ error: 'daily_cap', cap: 'buyer', leftMicros: 0 });
    });

    it('refuses a purchase or a move into a wallet that took in $1,000 today', async () => {
      for (const buyer of ['ana', 'ben']) {
        for (let index = 0; index < 5; index++) {
          await webhook(paid(buyer, 'server:1', 10_000).event);
        }
      }
      expect(await (await order('cara', 'server:1')).json()).toMatchObject({
        error: 'daily_cap',
        cap: 'wallet',
      });
      await webhook(paid('cara', 'cara', 2000).event);
      const move = await call('/credits.move', {
        from: 'cara',
        to: 'server:1',
        amountMicros: 20 * DOLLAR,
        id: 'm1',
      });
      expect(await move.json()).toMatchObject({ error: 'daily_cap', cap: 'wallet' });
    });

    it('holds a purchase as pending until its start', async () => {
      await order('ana', 'server:1', { holdHours: 24 });
      expect(
        new URLSearchParams(
          String(calls.filter((c) => c.url.includes('checkout')).at(-1)!.init!.body),
        ).get('metadata[holdHours]'),
      ).toBe('24');
      await webhook(paid('ana', 'server:1', 2000, { holdHours: '24' }).event);
      const wallet = { clientId: registration.client.id, payer: 'server:1' };
      expect(await creditBalance(env.db, wallet)).toMatchObject({
        balanceMicros: 0,
        pendingMicros: 20 * DOLLAR,
      });
      await spendCredits(env.db, wallet, DOLLAR);
      expect(await creditBalance(env.db, wallet)).toMatchObject({
        balanceMicros: -DOLLAR,
        pendingMicros: 20 * DOLLAR,
      });
      const later = new Date(Date.now() + 25 * 3_600_000);
      await spendCredits(env.db, wallet, DOLLAR, later);
      expect(await creditBalance(env.db, wallet, later)).toMatchObject({
        balanceMicros: 18 * DOLLAR,
        pendingMicros: 0,
      });
    });

    it('turns auto top-up off when a charge would pass a cap', async () => {
      await buyForOthers(true, { buyerDailyMicros: 40 * DOLLAR });
      await webhook(paid('ana', 'server:1', 2000, { saveCard: 'true' }).event);
      await webhook(paid('ana', 'ana', 2000).event);
      await call('/credits.autoTopUp', {
        payer: 'server:1',
        buyer: 'ana',
        thresholdMicros: 5 * DOLLAR,
        amountMicros: 20 * DOLLAR,
        monthlyLimitMicros: 100 * DOLLAR,
      });
      await call('/usage.record', { person: 'server:1', aiNeurons: 1_500_000 });
      expect(calls.filter((c) => c.url.endsWith('/v1/payment_intents'))).toHaveLength(0);
      expect(
        rpcData<{ autoTopUp: { enabled: boolean; offReason: string } }>(
          await (await call('/usage.status', { person: 'server:1' })).json(),
        ).autoTopUp,
      ).toMatchObject({ enabled: false, offReason: 'daily_cap' });
    });
  });

  describe('closing a wallet', () => {
    const close = async () =>
      rpcData<{
        closed: boolean;
        returned: Array<{ to: string; amountMicros: number; expiresAt: string }>;
        lapsedMicros: number;
      }>(await (await call('/credits.close', { payer: 'server:1' })).json());

    beforeEach(async () => {
      await buyForOthers(true);
      await call('/wallets.open', { payer: 'server:1' });
    });

    it('gives unspent bought credits back to who added them, lets the rest lapse, and closes once', async () => {
      const fromAna = paid('ana', 'server:1', 2000);
      await webhook(fromAna.event);
      await webhook(paid('ben', 'ben', 2000).event);
      await call('/credits.move', {
        from: 'ben',
        to: 'server:1',
        amountMicros: 5 * DOLLAR,
        id: 'm1',
      });
      await give('server:1', 3 * DOLLAR);
      await call('/usage.record', { person: 'server:1', aiNeurons: 500_000 });

      const result = await close();
      expect(result.closed).toBe(true);
      expect(result.returned.map(({ to, amountMicros }) => [to, amountMicros]).sort()).toEqual([
        ['ana', 14_500_000],
        ['ben', 5 * DOLLAR],
      ]);
      expect(result.lapsedMicros).toBe(3 * DOLLAR);
      expect((await status('ana')).credits?.balanceMicros).toBe(14_500_000);
      expect((await status('ben')).credits?.balanceMicros).toBe(20 * DOLLAR);
      expect((await status('server:1')).credits?.balanceMicros).toBe(0);
      expect((await close()).closed).toBe(false);

      const grants = await env.db.select().from(appCreditGrants);
      const back = grants.find((grant) => grant.payer_id === 'ana')!;
      expect(back.stripe_payment_intent_id).toBe(fromAna.paymentIntent);
      await dispute(fromAna.paymentIntent);
      expect((await status('ana')).credits?.balanceMicros).toBe(0);
    });

    it('lets given credits lapse, and refuses new purchases and moves', async () => {
      await give('server:1', 3 * DOLLAR);
      expect((await close()).lapsedMicros).toBe(3 * DOLLAR);
      const checkout = await call('/credits.checkout', {
        buyer: 'ana',
        payer: 'server:1',
        amountMicros: 20 * DOLLAR,
        returnUrl: 'https://example.com/credits',
      });
      expect(await checkout.json()).toEqual({ error: 'closed' });
      await webhook(paid('ana', 'ana', 2000).event);
      const move = await call('/credits.move', {
        from: 'ana',
        to: 'server:1',
        amountMicros: 5 * DOLLAR,
        id: 'm1',
      });
      expect(await move.json()).toEqual({ error: 'closed' });
      await webhook(paid('ana', 'server:1', 2000).event);
      expect((await status('ana')).credits?.balanceMicros).toBe(40 * DOLLAR);
    });
  });
});
