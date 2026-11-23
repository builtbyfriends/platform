import { and, count, desc, eq, ilike, isNull, not, like, sql, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  APP,
  applyCredits,
  costMicros,
  payerDaily,
  payerUse,
  paidProjects,
  readMeterPrices,
  type Meter,
} from '../app-credits.ts';
import {
  BillingUnavailableError,
  createRefund,
  paymentRefundable,
  stripeLiveMode,
} from '../billing/stripe.ts';
import { creditBalance, grantCredits } from '../credit-ledger.ts';
import { autoTopUpStatus } from '../credit-purchase.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { installationDefaultPlan } from '../plans.ts';
import { appCreditGrants, appPayers, appPeople, appUsage, oauthClients, users } from '../schema.ts';
import { CREDITS_REASONS } from '../suspension.ts';
import { dryRun, OperatorError, pagination, preview, readBody } from './common.ts';

type Page = ReturnType<typeof pagination>;

const DELETED = 'deleted\\_%';

async function requireClient(db: Db, clientId: string) {
  const [client] = await db
    .select({ id: oauthClients.id, name: oauthClients.name })
    .from(oauthClients)
    .where(eq(oauthClients.id, clientId));
  if (!client) {
    throw new OperatorError(404, 'Connected app not found.');
  }
  return client;
}

/**
 * Every id an app has named: a payer who never bought a plan may exist only in its use or its
 * grants. Ids kept for the books after a deletion are left out.
 */
function personIds(db: Db, clientId: string, search?: string) {
  const match = (column: Parameters<typeof ilike>[0]): SQL | undefined =>
    search ? ilike(column, `%${search.replace(/[\\%_]/g, '\\$&')}%`) : undefined;
  return db
    .select({ person: appPeople.person_id })
    .from(appPeople)
    .where(and(eq(appPeople.client_id, clientId), match(appPeople.person_id)))
    .union(
      db
        .select({ person: appUsage.person_id })
        .from(appUsage)
        .where(and(eq(appUsage.client_id, clientId), match(appUsage.person_id))),
    )
    .union(
      db
        .select({ person: appCreditGrants.payer_id })
        .from(appCreditGrants)
        .where(
          and(
            eq(appCreditGrants.client_id, clientId),
            not(like(appCreditGrants.payer_id, DELETED)),
            match(appCreditGrants.payer_id),
          ),
        ),
    )
    .union(
      db
        .select({ person: appPayers.payer_id })
        .from(appPayers)
        .where(
          and(
            eq(appPayers.client_id, clientId),
            not(like(appPayers.payer_id, DELETED)),
            match(appPayers.payer_id),
          ),
        ),
    )
    .union(
      db
        .select({ person: users.provider_id })
        .from(users)
        .where(and(eq(users.provider, APP + clientId), match(users.provider_id))),
    );
}

/** One person's plan, subscription, balance and this month's use, as an operator sees them. */
async function personSummary(db: Db, env: ApiEnv['Bindings'], clientId: string, person: string) {
  const [[row], [payer], balance, use, prices, defaultPlan, topUp, paid] = await Promise.all([
    db
      .select()
      .from(appPeople)
      .where(and(eq(appPeople.client_id, clientId), eq(appPeople.person_id, person))),
    db
      .select()
      .from(appPayers)
      .where(and(eq(appPayers.client_id, clientId), eq(appPayers.payer_id, person))),
    creditBalance(db, { clientId, payer: person }),
    payerUse(db, clientId, person),
    readMeterPrices(db),
    installationDefaultPlan(db, env),
    autoTopUpStatus(db, { clientId, payer: person }),
    paidProjects(db, clientId, person),
  ]);
  const paused = paid.filter(({ project }) =>
    CREDITS_REASONS.includes(project.suspended_reason ?? ''),
  );
  return {
    person,
    plan: row?.plan ?? defaultPlan.id,
    subscriptionStatus: row?.stripe_subscription_id ? row.subscription_status : null,
    livemode: row?.livemode ?? null,
    balanceMicros: balance?.balanceMicros ?? null,
    owedMicros: balance?.owedMicros ?? 0,
    usedMicros: Object.entries(use).reduce(
      (sum, [meter, quantity]) => sum + costMicros(meter as Meter, quantity, prices),
      0,
    ),
    blocked: payer?.blocked_at ? { at: payer.blocked_at, reason: payer.blocked_reason } : null,
    autoTopUp: topUp,
    creditsPause: paused.length
      ? { reason: paused[0]!.project.suspended_reason, projects: paused.length, of: paid.length }
      : null,
  };
}

export async function listAppPeople(
  context: Context<ApiEnv>,
  clientId: string,
  page: Page,
  search?: string,
) {
  const db = context.get('db');
  const client = await requireClient(db, clientId);
  const ids = personIds(db, clientId, search);
  const [rows, [totals]] = await Promise.all([
    personIds(db, clientId, search)
      .orderBy(({ person }) => person)
      .limit(page.limit)
      .offset(page.offset),
    db.select({ total: count() }).from(ids.as('ids')),
  ]);
  const total = totals?.total ?? 0;
  return {
    client,
    people: await Promise.all(
      rows.map(({ person }) => personSummary(db, context.env, clientId, person)),
    ),
    page: page.page,
    limit: page.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / page.limit)),
  };
}

export async function getAppPerson(context: Context<ApiEnv>, clientId: string, person: string) {
  const db = context.get('db');
  const client = await requireClient(db, clientId);
  const ids = personIds(db, clientId).as('ids');
  const [[known], summary, grants, daily, projects] = await Promise.all([
    db.select({ person: ids.person }).from(ids).where(eq(ids.person, person)).limit(1),
    personSummary(db, context.env, clientId, person),
    db
      .select()
      .from(appCreditGrants)
      .where(and(eq(appCreditGrants.client_id, clientId), eq(appCreditGrants.payer_id, person)))
      .orderBy(desc(appCreditGrants.created_at)),
    readMeterPrices(db).then((prices) => payerDaily(db, clientId, person, prices)),
    paidProjects(db, clientId, person),
  ]);
  if (!known) {
    throw new OperatorError(404, 'This app has no person with that id.');
  }
  return {
    client,
    ...summary,
    grants: grants.map((grant) => ({
      id: grant.id,
      source: grant.source,
      amountMicros: grant.amount_micros,
      remainingMicros: grant.remaining_micros,
      refundedMicros: grant.taken_micros,
      giver: grant.giver_id,
      note: grant.note,
      paymentIntent: grant.stripe_payment_intent_id,
      livemode: grant.livemode,
      startsAt: grant.starts_at,
      expiresAt: grant.expires_at,
      voidedAt: grant.voided_at,
      voidReason: grant.void_reason,
      createdAt: grant.created_at,
    })),
    daily,
    projects: projects.map(({ project, person: builtFor }) => ({
      id: project.id,
      slug: project.slug,
      person: builtFor,
    })),
  };
}

const MAX_NOTE = 1000;

/** A dollar amount from a form, the CLI or JSON, in millionths. Null when it isn't above zero. */
function dollarsToMicros(value: unknown): number | null {
  const dollars = typeof value === 'number' ? value : Number(String(value ?? '').trim() || NaN);
  const micros = Math.round(dollars * 1e6);
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
}

export type GrantInput = { dollars?: unknown; expires?: unknown; note?: unknown };

/** Gives a person credits: a 'given' grant with the operator as its giver. */
export async function grantAppPerson(
  context: Context<ApiEnv>,
  clientId: string,
  person: string,
  input: GrantInput,
  isDryRun = false,
) {
  const db = context.get('db');
  await requireClient(db, clientId);
  const amountMicros = dollarsToMicros(input.dollars);
  if (!amountMicros) {
    throw new OperatorError(400, 'dollars must be an amount above 0.', 'invalid_argument');
  }
  const expiresText = String(input.expires ?? '').trim();
  const expiresAt = expiresText ? new Date(expiresText) : null;
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date())) {
    throw new OperatorError(400, 'expires must be a date in the future.', 'invalid_argument');
  }
  const note = String(input.note ?? '').trim();
  if (note.length > MAX_NOTE) {
    throw new OperatorError(
      400,
      `note must be at most ${MAX_NOTE} characters.`,
      'invalid_argument',
    );
  }
  const target = { clientId, person };
  const before = await creditBalance(db, { clientId, payer: person });
  const details = {
    amountMicros,
    expiresAt: expiresAt?.toISOString() ?? null,
    note: note || null,
    balanceMicros: before?.balanceMicros ?? 0,
    balanceAfterMicros: (before?.balanceMicros ?? 0) + amountMicros,
  };
  if (isDryRun) {
    return preview('app-person.grant', target, details);
  }
  const grant = await grantCredits(db, {
    clientId,
    payer: person,
    source: 'given',
    amountMicros,
    livemode: stripeLiveMode(context.env),
    giverId: `operator:${context.get('user').login}`,
    note: note || null,
    expiresAt,
  });
  await applyCredits(context.env, db, clientId, person);
  return { ...details, action: 'app-person.grant', target, dryRun: false, grantId: grant?.id };
}

export type RefundInput = { grant?: unknown; dollars?: unknown };

/**
 * Sends a refund through Stripe for the payment behind one of the person's grants. The amount
 * defaults to the unspent share. The ledger isn't changed here: Stripe's refund event takes the
 * credits back, so refunds have one path.
 */
export async function refundAppPerson(
  context: Context<ApiEnv>,
  clientId: string,
  person: string,
  input: RefundInput,
  isDryRun = false,
) {
  const db = context.get('db');
  await requireClient(db, clientId);
  const grantId = String(input.grant ?? '');
  const [grant] = await db
    .select()
    .from(appCreditGrants)
    .where(
      and(
        eq(appCreditGrants.id, grantId),
        eq(appCreditGrants.client_id, clientId),
        eq(appCreditGrants.payer_id, person),
      ),
    );
  if (!grant?.stripe_payment_intent_id) {
    throw new OperatorError(404, 'This person has no paid grant with that id.', 'not_found');
  }
  const paymentIntentId = grant.stripe_payment_intent_id;
  let paid: Awaited<ReturnType<typeof paymentRefundable>>;
  try {
    paid = await paymentRefundable(context.env, paymentIntentId);
  } catch (error) {
    if (error instanceof BillingUnavailableError) {
      throw new OperatorError(503, error.message, 'billing_unavailable');
    }
    throw error;
  }
  const refundableCents = paid.receivedCents - paid.refundedCents;
  // Decision: A yearly payment brings one grant a month, so what's unspent counts every month it paid for.
  const [payment] = await db
    .select({
      amount: sql<string>`sum(${appCreditGrants.amount_micros})`,
      remaining: sql<string>`sum(${appCreditGrants.remaining_micros})`,
    })
    .from(appCreditGrants)
    .where(
      and(
        eq(appCreditGrants.client_id, clientId),
        eq(appCreditGrants.stripe_payment_intent_id, paymentIntentId),
        isNull(appCreditGrants.moved_from),
        isNull(appCreditGrants.voided_at),
      ),
    );
  const unspentMicros = Number(payment?.remaining ?? grant.remaining_micros);
  const unspentCents = Math.floor(
    (paid.receivedCents * unspentMicros) /
      Math.max(1, Number(payment?.amount ?? grant.amount_micros)),
  );
  const asked =
    input.dollars === undefined || input.dollars === '' ? null : dollarsToMicros(input.dollars);
  if (input.dollars !== undefined && input.dollars !== '' && !asked) {
    throw new OperatorError(400, 'dollars must be an amount above 0.', 'invalid_argument');
  }
  const amountCents = asked ? Math.round(asked / 1e4) : Math.min(unspentCents, refundableCents);
  if (amountCents <= 0 || amountCents > refundableCents) {
    throw new OperatorError(
      409,
      `Nothing to refund: ${refundableCents} cents of this payment can still be refunded.`,
      'nothing_to_refund',
      { refundableCents, unspentCents },
    );
  }
  const target = { clientId, person, grantId };
  const details = {
    paymentIntent: paymentIntentId,
    currency: paid.currency,
    receivedCents: paid.receivedCents,
    refundedCents: paid.refundedCents,
    unspentMicros,
    unspentCents,
    amountCents,
    effect: "Credits come off the person's balance when Stripe's refund event arrives.",
  };
  if (isDryRun) {
    return preview('app-person.refund', target, details);
  }
  try {
    const refund = await createRefund(
      context.env,
      {
        paymentIntentId,
        amountCents,
        metadata: { clientId, personId: person, grantId },
      },
      // Decision: Keyed on what was already refunded, so a repeat before Stripe answers returns the same refund and
      // a later refund of the rest gets its own.
      `refund:${grantId}:${paid.refundedCents}:${amountCents}`,
    );
    return {
      ...details,
      action: 'app-person.refund',
      target,
      dryRun: false,
      refund: { ...refund, pending: true },
    };
  } catch (error) {
    if (error instanceof BillingUnavailableError) {
      throw new OperatorError(503, error.message, 'billing_unavailable');
    }
    throw error;
  }
}

/** Clears a card dispute's block, so the person can buy again. */
export async function unblockAppPerson(
  context: Context<ApiEnv>,
  clientId: string,
  person: string,
  isDryRun = false,
) {
  const db = context.get('db');
  await requireClient(db, clientId);
  const where = and(eq(appPayers.client_id, clientId), eq(appPayers.payer_id, person));
  const [row] = await db.select().from(appPayers).where(where);
  if (!row?.blocked_at) {
    throw new OperatorError(409, 'This person is not blocked.', 'not_blocked');
  }
  const target = { clientId, person };
  const details = { blockedAt: row.blocked_at, blockedReason: row.blocked_reason };
  if (isDryRun) {
    return preview('app-person.unblock', target, details);
  }
  await db.update(appPayers).set({ blocked_at: null, blocked_reason: null }).where(where);
  return { ...details, action: 'app-person.unblock', target, dryRun: false };
}

const PEOPLE = '/oauth/clients/:client/people';

export const appPeopleRoutes = new Hono<ApiEnv>()
  .get(PEOPLE, async (context) =>
    context.json(
      await listAppPeople(
        context,
        context.req.param('client'),
        pagination(context),
        context.req.query('search') || undefined,
      ),
    ),
  )
  .get(`${PEOPLE}/:person`, async (context) =>
    context.json(
      await getAppPerson(context, context.req.param('client'), context.req.param('person')),
    ),
  )
  .post(`${PEOPLE}/:person/grants`, async (context) => {
    const body = await readBody(context);
    return context.json(
      await grantAppPerson(
        context,
        context.req.param('client'),
        context.req.param('person'),
        body,
        dryRun(body),
      ),
    );
  })
  .post(`${PEOPLE}/:person/refunds`, async (context) => {
    const body = await readBody(context);
    return context.json(
      await refundAppPerson(
        context,
        context.req.param('client'),
        context.req.param('person'),
        body,
        dryRun(body),
      ),
    );
  })
  .post(`${PEOPLE}/:person/unblock`, async (context) => {
    const body = await readBody(context);
    return context.json(
      await unblockAppPerson(
        context,
        context.req.param('client'),
        context.req.param('person'),
        dryRun(body),
      ),
    );
  });
