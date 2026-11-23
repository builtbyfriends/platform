import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vite-plus/test';
import { registerOAuthClient } from '../../src/auth/oauth.ts';
import { grantCredits } from '../../src/credit-ledger.ts';
import { app } from '../../src/index.ts';
import {
  appCreditGrants,
  appPayers,
  appPeople,
  appUsage,
  operatorEvents,
} from '../../src/schema.ts';
import {
  clearTables,
  createOperatorToken,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv & { STRIPE_SECRET_KEY?: string };
let token: string;
let login: string;
let client: Awaited<ReturnType<typeof registerOAuthClient>>;
let other: Awaited<ReturnType<typeof registerOAuthClient>>;
const counter = {
  idFromName: (id: string) => id,
  get: () => ({ fetch: async () => Response.json({ ok: true }) }),
} as unknown as DurableObjectNamespace;

function operator(path: string, body?: Record<string, unknown>) {
  return app.fetch(
    new Request(`http://localhost/operator/v1/oauth/clients/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    { ...env, USAGE_COUNTER: counter },
  );
}

type Loose = Record<string, any>;

const json = async (response: Response | Promise<Response>) =>
  (await (await response).json()) as Loose;

async function status(person: string) {
  const response = await app.fetch(
    new Request('https://platform.example.com/app-billing/usage.status', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(client.client.id + ':' + client.clientSecret),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ person }),
    }),
    { ...env, USAGE_COUNTER: counter },
  );
  return ((await response.json()) as { data: Loose }).data;
}

const paidGrant = (payer: string) =>
  grantCredits(env.db, {
    clientId: client.client.id,
    payer,
    source: 'plan',
    amountMicros: 20_000_000,
    livemode: false,
    stripeInvoiceId: 'in_1',
    stripePaymentIntentId: 'pi_1',
  });

beforeAll(async () => {
  env = await setupEnv();
  env.STRIPE_SECRET_KEY = 'sk_test_x';
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  const admin = await createTestUser(
    env.db,
    'operator-admin',
    'github',
    undefined,
    'custom',
    'admin',
  );
  login = admin.login;
  token = await createOperatorToken(env.db, admin);
  const app = { redirectUris: ['https://example.com/callback'], scopes: ['profile' as const] };
  client = await registerOAuthClient(env.db, { name: 'One', operator: 'One Co', ...app });
  other = await registerOAuthClient(env.db, { name: 'Two', operator: 'Two Co', ...app });
  await env.db.insert(appPeople).values({
    client_id: client.client.id,
    person_id: 'p1',
    plan: 'free',
    stripe_subscription_id: 'sub_1',
    subscription_status: 'active',
  });
  await env.db.insert(appUsage).values({
    client_id: client.client.id,
    person_id: 'only-use',
    period: new Date().toISOString().slice(0, 8) + '01',
    sandbox_seconds: 3600,
  });
  await grantCredits(env.db, {
    clientId: other.client.id,
    payer: 'stranger',
    source: 'given',
    amountMicros: 1,
    livemode: false,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('operator view of an app’s people', () => {
  test('lists one app’s people, from plans, use and grants, and finds one by id', async () => {
    await paidGrant('from-grant');
    const listed = await json(operator(`${client.client.id}/people`));
    expect(listed.people.map((person: { person: string }) => person.person)).toEqual([
      'from-grant',
      'only-use',
      'p1',
    ]);
    expect(listed.total).toBe(3);
    expect(listed.people[1]).toMatchObject({ balanceMicros: null, usedMicros: 100_000 });
    expect(listed.people[2]).toMatchObject({
      plan: 'free',
      subscriptionStatus: 'active',
      autoTopUp: null,
      creditsPause: null,
    });

    const found = await json(operator(`${client.client.id}/people?search=GRANT`));
    expect(found.people).toEqual([
      expect.objectContaining({ person: 'from-grant', balanceMicros: 20_000_000 }),
    ]);
    expect((await operator(`${client.client.id}/people/stranger`)).status).toBe(404);
    expect((await operator('nope/people')).status).toBe(404);

    const person = await json(operator(`${client.client.id}/people/from-grant`));
    expect(person).toMatchObject({
      person: 'from-grant',
      grants: [{ source: 'plan', amountMicros: 20_000_000, paymentIntent: 'pi_1' }],
      projects: [],
    });
    expect(person.daily.length).toBe(new Date().getUTCDate());
  });

  test('previews a grant without changing anything, then gives it and records it', async () => {
    const path = `${client.client.id}/people/p1/grants`;
    const body = { dollars: '5', expires: '2099-01-01', note: 'Sorry for the outage' };
    const preview = await json(operator(path, { ...body, dryRun: true }));
    expect(preview).toMatchObject({
      dryRun: true,
      action: 'app-person.grant',
      amountMicros: 5_000_000,
      balanceAfterMicros: 5_000_000,
    });
    expect(
      await env.db.select().from(appCreditGrants).where(eq(appCreditGrants.payer_id, 'p1')),
    ).toEqual([]);
    expect(await env.db.select().from(operatorEvents)).toEqual([]);

    expect((await operator(path, body)).status).toBe(200);
    expect((await status('p1')).credits).toMatchObject({
      balanceMicros: 5_000_000,
      grants: [{ source: 'given', expiresAt: '2099-01-01T00:00:00.000Z' }],
    });
    const [grant] = await env.db
      .select()
      .from(appCreditGrants)
      .where(eq(appCreditGrants.payer_id, 'p1'));
    expect(grant).toMatchObject({ giver_id: `operator:${login}`, note: 'Sorry for the outage' });
    const [event] = await env.db.select().from(operatorEvents);
    expect(event).toMatchObject({ status: 'success', login });
    expect(JSON.parse(event!.target)).toMatchObject({
      clientId: client.client.id,
      person: 'p1',
      action: 'grants',
      dollars: '5',
      note: 'Sorry for the outage',
    });
    expect((await operator(path, { dollars: '-1' })).status).toBe(400);
    expect((await operator(path, { dollars: '1', expires: '2000-01-01' })).status).toBe(400);
  });

  test('sends a refund for the unspent share once, and leaves the ledger to Stripe’s event', async () => {
    await paidGrant('p1');
    await env.db
      .update(appCreditGrants)
      .set({ remaining_micros: 15_000_000 })
      .where(eq(appCreditGrants.payer_id, 'p1'));
    const stripe: Array<{ url: string; method: string; body: string; key: string | null }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      stripe.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: String(init?.body ?? ''),
        key: new Headers(init?.headers).get('idempotency-key'),
      });
      return String(input).includes('/payment_intents/')
        ? Response.json({
            amount_received: 2000,
            currency: 'usd',
            latest_charge: { amount_refunded: 0 },
          })
        : Response.json({ id: 're_1', status: 'succeeded' });
    });
    const [{ id: grant }] = (await env.db
      .select({ id: appCreditGrants.id })
      .from(appCreditGrants)
      .where(eq(appCreditGrants.payer_id, 'p1'))) as [{ id: string }];
    const path = `${client.client.id}/people/p1/refunds`;

    const preview = await json(operator(path, { grant, dryRun: true }));
    expect(preview).toMatchObject({ dryRun: true, unspentCents: 1500, amountCents: 1500 });
    expect(stripe.filter((call) => call.method === 'POST')).toEqual([]);

    const sent = await json(operator(path, { grant }));
    expect(sent).toMatchObject({ amountCents: 1500, refund: { id: 're_1', pending: true } });
    const posts = stripe.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('https://api.stripe.com/v1/refunds');
    expect(new URLSearchParams(posts[0]!.body).get('amount')).toBe('1500');
    expect(new URLSearchParams(posts[0]!.body).get('payment_intent')).toBe('pi_1');
    expect(posts[0]!.key).toBe(`refund:${grant}:0:1500`);
    expect((await status('p1')).credits).toMatchObject({ balanceMicros: 15_000_000 });

    expect((await operator(path, { grant, dollars: '21' })).status).toBe(409);
    expect((await operator(`${other.client.id}/people/p1/refunds`, { grant })).status).toBe(404);
  });

  test('clears a dispute block after a preview', async () => {
    await env.db.insert(appPayers).values({
      client_id: client.client.id,
      payer_id: 'p1',
      blocked_at: new Date().toISOString(),
      blocked_reason: 'dispute',
    });
    const path = `${client.client.id}/people/p1/unblock`;
    expect(await json(operator(path, { dryRun: true }))).toMatchObject({
      blockedReason: 'dispute',
    });
    expect((await json(operator(`${client.client.id}/people/p1`))).blocked).toMatchObject({
      reason: 'dispute',
    });
    expect((await operator(path, {})).status).toBe(200);
    expect((await json(operator(`${client.client.id}/people/p1`))).blocked).toBeNull();
    expect((await operator(path, {})).status).toBe(409);
  });
});

describe('admin pages for an app’s people', () => {
  let cookie: string;
  const origin = 'https://api.example.com';
  function page(path: string, form?: Record<string, string>) {
    return app.fetch(
      new Request(`${origin}/admin/connected-apps/${client.client.id}${path}`, {
        method: form ? 'POST' : 'GET',
        headers: {
          Cookie: cookie,
          'X-PlatformPages': 'true',
          ...(form ? { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(form ? { body: new URLSearchParams(form) } : {}),
      }),
      { ...env, USAGE_COUNTER: counter },
    );
  }
  const props = async (response: Response | Promise<Response>) => {
    const answer = await response;
    expect(answer.status).toBe(200);
    return ((await answer.json()) as { props: Loose }).props;
  };

  beforeEach(async () => {
    const admin = await createTestUser(
      env.db,
      'page-admin',
      'github',
      undefined,
      'custom',
      'admin',
    );
    cookie = `admin_token=${admin.adminJwt}`;
  });

  test('lists people, previews a grant, and gives it on confirm', async () => {
    expect((await props(page('/people?search=p1'))).result.people).toEqual([
      expect.objectContaining({ person: 'p1' }),
    ]);
    const form = { dollars: '2.5', note: 'Welcome' };
    const previewed = await props(page('/people/p1/grants/preview', form));
    expect(previewed.previewed).toMatchObject({ kind: 'grants', fields: form });
    expect(await env.db.select().from(operatorEvents)).toEqual([]);

    const done = await props(page('/people/p1/grants', previewed.previewed.fields));
    expect(done).toMatchObject({ notice: 'Credits given.', result: { balanceMicros: 2_500_000 } });
    const [event] = await env.db.select().from(operatorEvents);
    expect(event).toMatchObject({ status: 'success', login: 'page-admin' });
    expect(JSON.parse(event!.target)).toMatchObject({
      person: 'p1',
      action: 'grants',
      note: 'Welcome',
    });

    const refused = await page('/people/p1/grants/preview', { dollars: 'zero' });
    expect(refused.status).toBe(400);
  });
});
