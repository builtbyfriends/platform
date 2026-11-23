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
import { grantCredits } from '../../src/credit-ledger.ts';
import rawApp from '../../src/index.ts';
import { oauthClients } from '../../src/schema.ts';
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
      calls.push({ url: String(input), init });
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
});
