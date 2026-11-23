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
});
