import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  APP,
  addUse,
  applyCredits,
  clientPlans,
  currentPeriod,
  hostedAsOf,
  paidProjects,
  paidProjectUse,
  payerOf,
  payerDaily,
  readMeterPrices,
  costMicros,
  type Meter,
  type MeterPrices,
  type MeterUse,
} from '../app-credits.ts';
import { knownPayer } from '../app-payer.ts';
import { authenticateOAuthClient, OAuthError } from '../auth/oauth.ts';
import { queueBillingEvent } from '../billing-events.ts';
import {
  BillingUnavailableError,
  cancelSubscription,
  createCheckoutSession,
  createCreditCheckoutSession,
  createPortalSession,
  deleteCustomer,
  fetchSubscription,
  stripeLiveMode,
} from '../billing/stripe.ts';
import {
  balancesOf,
  creditBalance,
  forgetPayer,
  grantCredits,
  isWallet,
  moveCredits,
  openWallet,
  payerBlocked,
} from '../credit-ledger.ts';
import {
  autoTopUpStatus,
  buyerOf,
  creditPurchase,
  fitsPurchase,
  overDailyCap,
  setAutoTopUp,
} from '../credit-purchase.ts';
import { getOwnedProjectsByUserId } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { deleteOperatorUser, reconcileOperatorUserPlan } from '../operator/tenant-service.ts';
import { resolvePlanLimits } from '../plans.ts';
import {
  appBuyers,
  appPayers,
  appPeople,
  appUsage,
  appUsageDaily,
  appUsageEvents,
  appUsageSources,
  appWalletUse,
  oauthClients,
  projects,
  users,
} from '../schema.ts';

const isPersonId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;
const isMicros = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isReturnUrl = (value: unknown): value is string =>
  typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:';

type BillingContext = Context<ApiEnv>;

const MAX_WALLETS = 5;
const MAX_HOLD_HOURS = 168;

type Choice = { payer: string; person: string; monthlyLimitMicros?: number };

/** The ordered wallets a turn may charge, or null when the list is malformed. Repeats keep the first. */
function walletList(value: unknown): Array<Choice> | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WALLETS) {
    return null;
  }
  const list: Array<Choice> = [];
  for (const entry of value as Array<Record<string, unknown> | null>) {
    if (
      !isPersonId(entry?.payer) ||
      !isPersonId(entry.person) ||
      (entry.monthlyLimitMicros !== undefined && !isMicros(entry.monthlyLimitMicros))
    ) {
      return null;
    }
    if (!list.some((choice) => choice.payer === entry.payer)) {
      list.push({
        payer: entry.payer,
        person: entry.person,
        ...(entry.monthlyLimitMicros === undefined
          ? {}
          : { monthlyLimitMicros: entry.monthlyLimitMicros as number }),
      });
    }
  }
  return list;
}

const walletRefused = async (context: BillingContext, person: string) =>
  (await isWallet(context.get('db'), { clientId: context.get('billingClient'), payer: person }))
    ? context.json(
        { error: 'payer_is_wallet', message: 'A wallet has no plan, starter credit or portal.' },
        400,
      )
    : null;

type Share = { model: string; source: string; aiNeurons: number; sandboxSeconds: number };

const count = (value: unknown) =>
  value === undefined
    ? 0
    : Number.isSafeInteger(value) && (value as number) >= 0
      ? (value as number)
      : -1;
const label = (value: unknown) =>
  value === undefined ? '' : typeof value === 'string' && value.length <= 200 ? value : null;

/** The optional split of one report by model and source, or null when it's malformed. */
function shares(value: unknown): Array<Share> | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 50) {
    return null;
  }
  const parsed = value.map((entry: Record<string, unknown> | null) => ({
    model: label(entry?.model),
    source: label(entry?.source),
    aiNeurons: count(entry?.aiNeurons),
    sandboxSeconds: count(entry?.sandboxSeconds),
  }));
  return parsed.every(
    (entry): entry is Share =>
      entry.model !== null &&
      entry.source !== null &&
      entry.aiNeurons >= 0 &&
      entry.sandboxSeconds >= 0,
  )
    ? parsed
    : null;
}

const HOSTED_FIELDS = {
  requests: 'hostedRequests',
  bandwidthBytes: 'hostedBandwidthBytes',
  aiNeurons: 'hostedAiNeurons',
  sandboxSeconds: 'hostedSandboxSeconds',
  cpuMs: 'hostedCpuMs',
  d1RowsRead: 'hostedD1RowsRead',
  d1RowsWritten: 'hostedD1RowsWritten',
  r2ClassAOps: 'hostedR2ClassAOps',
  r2ClassBOps: 'hostedR2ClassBOps',
  kvReads: 'hostedKvReads',
  kvWrites: 'hostedKvWrites',
  queueOps: 'hostedQueueOps',
} as const satisfies Record<string, Meter>;
// Decision: Storage is shown as what's stored now. The month's byte-days only decide its cost.
const STORED_FIELDS = {
  d1Bytes: 'hostedD1ByteDays',
  r2Bytes: 'hostedR2ByteDays',
  kvBytes: 'hostedKvByteDays',
} as const satisfies Record<string, Meter>;

const fields = <Fields extends Record<string, Meter>>(names: Fields, use: Partial<MeterUse>) =>
  Object.fromEntries(
    Object.entries(names).map(([field, meter]) => [field, use[meter] ?? 0]),
  ) as Record<keyof Fields, number>;

function hostedLine(use: Partial<MeterUse>, latest: Partial<MeterUse>, prices: MeterPrices) {
  return {
    ...fields(HOSTED_FIELDS, use),
    ...fields(STORED_FIELDS, latest),
    costMicros: Object.entries(use).reduce(
      (sum, [meter, quantity]) => sum + costMicros(meter as Meter, quantity, prices),
      0,
    ),
  };
}

/** What the projects this person pays for used this month, as the hourly read stored it. */
async function hostedUse(context: BillingContext, person: string) {
  const db = context.get('db');
  const clientId = context.get('billingClient');
  const [rows, use, prices] = await Promise.all([
    paidProjects(db, clientId, person),
    paidProjectUse(db, clientId, person),
    readMeterPrices(db),
  ]);
  const total = { use: {} as Partial<MeterUse>, latest: {} as Partial<MeterUse> };
  const listed = rows.map(({ project, person: builtFor }) => {
    const read = use.get(project.id) ?? { use: {}, latest: {} };
    for (const part of ['use', 'latest'] as const) {
      for (const [meter, quantity] of Object.entries(read[part])) {
        total[part][meter as Meter] = (total[part][meter as Meter] ?? 0) + quantity;
      }
    }
    return {
      projectId: project.id,
      slug: project.slug,
      person: builtFor,
      ...hostedLine(read.use, read.latest, prices),
    };
  });
  return { ...hostedLine(total.use, total.latest, prices), projects: listed };
}

/** What each person other than the payer spent from this payer this month, most first. */
function useByPerson(context: BillingContext, payer: string) {
  return context
    .get('db')
    .select({ person: appWalletUse.person_id, usedMicros: appWalletUse.cost_micros })
    .from(appWalletUse)
    .where(
      and(
        eq(appWalletUse.client_id, context.get('billingClient')),
        eq(appWalletUse.payer_id, payer),
        eq(appWalletUse.period, currentPeriod()),
      ),
    )
    .orderBy(sql`${appWalletUse.cost_micros} desc`);
}

/** A person's plan, its caps, what they used this month, and whether they are still within the caps. */
async function standing(context: BillingContext, person: string) {
  const db = context.get('db');
  const clientId = context.get('billingClient');
  const { row, meters, credits, paid, defaultPlanId, wallet } = await applyCredits(
    context.env,
    db,
    clientId,
    person,
  );
  const plan = wallet ? null : (row?.plan ?? defaultPlanId);
  const limits = plan ? await resolvePlanLimits(db, plan) : null;
  const period = currentPeriod();
  const quantity = (meter: Meter) => meters.find((entry) => entry.meter === meter)!.quantity;
  const usedNow = { aiNeurons: quantity('aiNeurons'), sandboxSeconds: quantity('sandboxSeconds') };
  const breakdown = await db
    .select({
      model: appUsageSources.model,
      source: appUsageSources.source,
      aiNeurons: appUsageSources.ai_neurons,
      sandboxSeconds: appUsageSources.sandbox_seconds,
    })
    .from(appUsageSources)
    .where(
      and(
        eq(appUsageSources.client_id, clientId),
        eq(appUsageSources.person_id, person),
        eq(appUsageSources.period, period),
      ),
    );
  // Decision: 0 means unlimited in a plan's limits.
  const within = (limit: number, value: number) => limit === 0 || value < limit;
  // Decision: A plan with credits is held to its balance, and the two caps stop deciding.
  const aiWithinCap =
    credits || !limits ? !credits?.out : within(limits.aiNeuronsPerMonth, usedNow.aiNeurons);
  const sandboxWithinCap =
    credits || !limits
      ? !credits?.out
      : within(limits.sandboxRuntimeSecondsPerMonth, usedNow.sandboxSeconds);
  return {
    wallet,
    plan,
    paid,
    billingPeriodStart: `${period}T00:00:00.000Z`,
    caps: limits
      ? {
          aiNeuronsPerMonth: limits.aiNeuronsPerMonth,
          sandboxSecondsPerMonth: limits.sandboxRuntimeSecondsPerMonth,
        }
      : null,
    used: usedNow,
    breakdown,
    credits,
    meters,
    withinCaps: aiWithinCap && sandboxWithinCap,
    aiWithinCap,
    sandboxWithinCap,
    autoTopUp: await autoTopUpStatus(db, { clientId, payer: person }),
    subscribed: Boolean(row?.stripe_subscription_id),
    subscriptionStatus: row?.stripe_subscription_id ? row.subscription_status : null,
    cancelAtPeriodEnd: row?.stripe_subscription_id ? row.cancel_at_period_end : false,
    // Decision: A paid plan renews on its own Stripe date, not on the first of the month when the meters reset.
    // The date is the one Stripe last sent, so this answer doesn't wait on Stripe.
    renewsAt:
      row?.stripe_subscription_id && row.current_period_end
        ? new Date(row.current_period_end).toISOString()
        : null,
  };
}

const ENDED = new Set(['canceled', 'incomplete_expired']);

/** What deleting a person removes. The preview and the deletion both answer this, read before anything changes. */
async function removal(context: BillingContext, person: string) {
  const db = context.get('db');
  const clientId = context.get('billingClient');
  const ofThisApp = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.provider, APP + clientId));
  const [[row], [user], balance, payerCleared, buyers, [payer]] = await Promise.all([
    db
      .select()
      .from(appPeople)
      .where(and(eq(appPeople.client_id, clientId), eq(appPeople.person_id, person))),
    db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.provider, APP + clientId), eq(users.provider_id, person))),
    creditBalance(db, { clientId, payer: person }),
    db
      .select({ id: projects.id, slug: projects.slug, userId: projects.user_id })
      .from(projects)
      .innerJoin(users, eq(users.id, projects.user_id))
      .where(
        and(
          eq(projects.payer_person_id, person),
          inArray(projects.user_id, ofThisApp),
          ne(users.provider_id, person),
        ),
      ),
    db
      .select({ customer: appBuyers.stripe_customer_id, livemode: appBuyers.livemode })
      .from(appBuyers)
      .where(and(eq(appBuyers.client_id, clientId), eq(appBuyers.buyer_id, person))),
    db
      .select({ topUp: appPayers.top_up_enabled })
      .from(appPayers)
      .where(and(eq(appPayers.client_id, clientId), eq(appPayers.payer_id, person))),
  ]);
  const live = stripeLiveMode(context.env);
  const customers = [
    ...new Set([
      ...(row?.stripe_customer_id && row.livemode === live ? [row.stripe_customer_id] : []),
      ...buyers.filter((buyer) => buyer.livemode === live).map((buyer) => buyer.customer),
    ]),
  ];
  const owned = user ? await getOwnedProjectsByUserId(db, user.id) : [];
  const subscription =
    row?.stripe_subscription_id && !ENDED.has(row.subscription_status ?? '')
      ? row.stripe_subscription_id
      : null;
  return {
    userId: user?.id ?? null,
    removes: {
      subscription,
      stripeCustomer: customers.length > 0 || Boolean(row?.stripe_customer_id) || buyers.length > 0,
      autoTopUp: Boolean(payer?.topUp),
      plan: row?.plan ?? null,
      // Decision: Unspent credits, bought ones included, are given up and not refunded (draft refund policy), so the
      // application can show the amount before the person confirms.
      unspentMicros: Math.max(0, balance?.balanceMicros ?? 0),
      grants: (balance?.grants ?? []).map(({ id, source, remainingMicros }) => ({
        id,
        source,
        remainingMicros,
      })),
      projects: owned.map((project) => ({ id: project.id, slug: project.slug })),
      payerCleared: payerCleared.map(({ id, slug }) => ({ id, slug })),
    },
    row,
    customers,
    clearedOwners: [...new Set(payerCleared.map((project) => project.userId))],
  };
}

/**
 * Deletes a person in the order that stops charges first: the Stripe subscription and customer,
 * then the grants, the projects they pay for but don't own, their own projects, and last their
 * rows. Each step is safe to repeat, so a failed call is retried from the start. Answers the step
 * that failed, or null.
 */
async function forgetPerson(
  context: BillingContext,
  person: string,
  plan: Awaited<ReturnType<typeof removal>>,
) {
  const db = context.get('db');
  const clientId = context.get('billingClient');
  const thisPerson = and(eq(appPeople.client_id, clientId), eq(appPeople.person_id, person));
  const steps: Array<[string, () => Promise<unknown>]> = [
    [
      'subscription',
      async () => {
        const subscription = plan.removes.subscription;
        // Decision: Auto top-up ends with the subscription, so no charge of either kind can start after this step.
        await db
          .update(appPayers)
          .set({ top_up_enabled: false, top_up_off_reason: 'account_deleted' })
          .where(and(eq(appPayers.client_id, clientId), eq(appPayers.payer_id, person)));
        if (!subscription) {
          return;
        }
        await cancelSubscription(context.env, subscription).catch(async (error: unknown) => {
          if (!ENDED.has((await fetchSubscription(context.env, subscription)).status)) {
            throw error;
          }
        });
        await db
          .update(appPeople)
          .set({ subscription_status: 'canceled', cancel_at_period_end: false })
          .where(thisPerson);
      },
    ],
    [
      'stripe_customer',
      async () => {
        // Decision: A customer from the other Stripe mode can't be reached with this key. Its row goes, and Stripe
        // keeps it.
        for (const customer of plan.customers) {
          await deleteCustomer(context.env, customer);
        }
        await db.update(appPeople).set({ stripe_customer_id: null }).where(thisPerson);
        await db
          .delete(appBuyers)
          .where(and(eq(appBuyers.client_id, clientId), eq(appBuyers.buyer_id, person)));
      },
    ],
    ['credits', () => forgetPayer(db, { clientId, payer: person })],
    [
      'payer',
      async () => {
        const ids = plan.removes.payerCleared.map((project) => project.id);
        if (ids.length === 0) {
          return;
        }
        await db
          .update(projects)
          .set({ payer_person_id: null })
          .where(and(inArray(projects.id, ids), eq(projects.payer_person_id, person)));
        for (const owner of plan.clearedOwners) {
          // Decision: The owner pays from here. The scheduled reconciliation applies their plan if this fails.
          await reconcileOperatorUserPlan(context, owner).catch((error: unknown) => {
            console.error('[billing] payer plan reconcile failed', { userId: owner, error });
          });
        }
      },
    ],
    ['projects', async () => plan.userId && deleteOperatorUser(context, plan.userId)],
    [
      'rows',
      async () => {
        const gone = { person_id: generateId('deleted') };
        await db.transaction(async (tx) => {
          await tx.delete(appPeople).where(thisPerson);
          await tx
            .delete(appUsage)
            .where(and(eq(appUsage.client_id, clientId), eq(appUsage.person_id, person)));
          await tx
            .delete(appUsageSources)
            .where(
              and(eq(appUsageSources.client_id, clientId), eq(appUsageSources.person_id, person)),
            );
          await tx
            .update(appWalletUse)
            .set(gone)
            .where(and(eq(appWalletUse.client_id, clientId), eq(appWalletUse.person_id, person)));
          // Decision: Daily use and its cost stay for the books under an id that names no one.
          await tx
            .update(appUsageDaily)
            .set(gone)
            .where(and(eq(appUsageDaily.client_id, clientId), eq(appUsageDaily.person_id, person)));
        });
      },
    ],
  ];
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (error) {
      console.error('[billing] person delete step failed', { clientId, step, error });
      return step;
    }
  }
  return null;
}

/**
 * Billing for the people of a connected application. The application signs in with its client
 * credentials and names each person by its own id (`person`); the platform keeps that person's
 * plan and use. Whichever application calls, it only ever reaches its own people.
 */
export const appBillingRoutes = new Hono<ApiEnv>()
  .use('*', async (context, next) => {
    try {
      context.set(
        'billingClient',
        (await authenticateOAuthClient(context.get('db'), context.req.header('Authorization'))).id,
      );
    } catch (error) {
      if (error instanceof OAuthError) {
        return context.json({ error: error.code, message: error.message }, error.status);
      }
      throw error;
    }
    return next();
  })
  .post('/usage.status', async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isPersonId(body?.person)) {
      return context.json({ error: 'bad_person' }, 400);
    }
    const { renewsAt, ...now } = await standing(context, body.person);
    const db = context.get('db');
    const hosted = body.hosted === true ? { hosted: await hostedUse(context, body.person) } : {};
    const daily =
      body.daily === true
        ? {
            daily: await payerDaily(
              db,
              context.get('billingClient'),
              body.person,
              await readMeterPrices(db),
            ),
          }
        : {};
    const byPerson =
      body.byPerson === true ? { byPerson: await useByPerson(context, body.person) } : {};
    return context.json({
      data: {
        ...now,
        hostedAsOf: await hostedAsOf(db),
        ...hosted,
        ...daily,
        ...byPerson,
        ...(renewsAt ? { renewsAt } : {}),
      },
    });
  })
  .post('/usage.record', async (context) => {
    const body = await context.req.json().catch(() => null);
    const neurons = count(body?.aiNeurons);
    const seconds = count(body?.sandboxSeconds);
    if (!isPersonId(body?.person)) {
      return context.json({ error: 'bad_person' }, 400);
    }
    const id = body?.id;
    if (id !== undefined && (typeof id !== 'string' || !id || id.length > 200)) {
      return context.json({ error: 'bad_id' }, 400);
    }
    if (neurons < 0 || seconds < 0) {
      return context.json({ error: 'bad_usage' }, 400);
    }
    if (body.by !== undefined && !isPersonId(body.by)) {
      return context.json({ error: 'bad_by' }, 400);
    }
    const breakdown = shares(body?.breakdown);
    if (!breakdown) {
      return context.json({ error: 'bad_breakdown' }, 400);
    }
    const db = context.get('db');
    const clientId = context.get('billingClient');
    await db.transaction(async (tx) => {
      // Decision: With an id, a report sent again after a timeout counts once.
      if (id !== undefined) {
        const fresh = await tx
          .insert(appUsageEvents)
          .values({ client_id: clientId, event_id: id })
          .onConflictDoNothing()
          .returning({ id: appUsageEvents.event_id });
        if (fresh.length === 0) {
          return;
        }
      }
      await tx
        .insert(appUsage)
        .values({
          client_id: clientId,
          person_id: body.person,
          period: currentPeriod(),
          ai_neurons: neurons,
          sandbox_seconds: seconds,
        })
        .onConflictDoUpdate({
          target: [appUsage.client_id, appUsage.person_id, appUsage.period],
          set: {
            ai_neurons: sql`${appUsage.ai_neurons} + ${neurons}`,
            sandbox_seconds: sql`${appUsage.sandbox_seconds} + ${seconds}`,
          },
        });
      const payer = { clientId, person: body.person as string };
      await addUse(tx, { ...payer, meter: 'aiNeurons', quantity: neurons });
      await addUse(tx, { ...payer, meter: 'sandboxSeconds', quantity: seconds });
      // Decision: A person's use of their own wallet has no limit, so it isn't split out.
      if (body.by !== undefined && body.by !== body.person) {
        const prices = await readMeterPrices(tx);
        const cost =
          costMicros('aiNeurons', neurons, prices) + costMicros('sandboxSeconds', seconds, prices);
        await tx
          .insert(appWalletUse)
          .values({
            client_id: clientId,
            payer_id: body.person,
            person_id: body.by,
            period: currentPeriod(),
            cost_micros: cost,
          })
          .onConflictDoUpdate({
            target: [
              appWalletUse.client_id,
              appWalletUse.payer_id,
              appWalletUse.period,
              appWalletUse.person_id,
            ],
            set: { cost_micros: sql`${appWalletUse.cost_micros} + ${cost}` },
          });
      }
      for (const share of breakdown) {
        await tx
          .insert(appUsageSources)
          .values({
            client_id: clientId,
            person_id: body.person,
            period: currentPeriod(),
            model: share.model,
            source: share.source,
            ai_neurons: share.aiNeurons,
            sandbox_seconds: share.sandboxSeconds,
          })
          .onConflictDoUpdate({
            target: [
              appUsageSources.client_id,
              appUsageSources.person_id,
              appUsageSources.period,
              appUsageSources.model,
              appUsageSources.source,
            ],
            set: {
              ai_neurons: sql`${appUsageSources.ai_neurons} + ${share.aiNeurons}`,
              sandbox_seconds: sql`${appUsageSources.sandbox_seconds} + ${share.sandboxSeconds}`,
            },
          });
      }
    });
    const now = await standing(context, body.person);
    return context.json({
      data: {
        aiNeuronsUsed: now.used.aiNeurons,
        sandboxSecondsUsed: now.used.sandboxSeconds,
        withinCaps: now.withinCaps,
        paid: now.paid,
        outOfCredits: now.credits?.out ?? false,
        creditsRemainingMicros: now.credits?.remainingMicros ?? null,
      },
    });
  })
  .post('/payer.pick', async (context) => {
    const body = await context.req.json().catch(() => null);
    const list = walletList(body?.wallets);
    if (!list) {
      return context.json({ error: 'bad_wallets', max: MAX_WALLETS }, 400);
    }
    const db = context.get('db');
    const clientId = context.get('billingClient');
    const payers = list.map((choice) => choice.payer);
    // Decision: A read with no Stripe call and no events, so it can run before each turn.
    const [balances, use] = await Promise.all([
      balancesOf(db, clientId, payers),
      db
        .select()
        .from(appWalletUse)
        .where(
          and(
            eq(appWalletUse.client_id, clientId),
            eq(appWalletUse.period, currentPeriod()),
            inArray(appWalletUse.payer_id, payers),
            inArray(
              appWalletUse.person_id,
              list.map((choice) => choice.person),
            ),
          ),
        ),
    ]);
    let picked: string | null = null;
    const wallets = list.map(({ payer, person, monthlyLimitMicros }) => {
      const { balanceMicros, blocked } = balances.get(payer)!;
      const personUsedMicros =
        payer === person
          ? 0
          : (use.find((row) => row.payer_id === payer && row.person_id === person)?.cost_micros ??
            0);
      const skipped = blocked
        ? ('blocked' as const)
        : balanceMicros !== null && balanceMicros <= 0
          ? ('empty' as const)
          : monthlyLimitMicros !== undefined && personUsedMicros >= monthlyLimitMicros
            ? ('over_limit' as const)
            : null;
      if (!skipped && picked === null) {
        picked = payer;
      }
      return { payer, balanceMicros, personUsedMicros, ...(skipped ? { skipped } : {}) };
    });
    return context.json({ data: { payer: picked, wallets } });
  })
  .post('/credits.move', async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isPersonId(body?.from) || !isPersonId(body.to) || body.from === body.to) {
      return context.json({ error: 'bad_payers' }, 400);
    }
    if (!isPersonId(body.id)) {
      return context.json({ error: 'bad_id' }, 400);
    }
    if (!Number.isSafeInteger(body.amountMicros) || body.amountMicros <= 0) {
      return context.json({ error: 'bad_amount' }, 400);
    }
    const db = context.get('db');
    const clientId = context.get('billingClient');
    const rules = await creditPurchase(db, clientId);
    if (!rules?.buyForOthers) {
      return context.json({ error: 'buy_for_others_off' }, 403);
    }
    // Decision: Credits move one way, from a person into a wallet, so they never pass from one person to another.
    if (await isWallet(db, { clientId, payer: body.from })) {
      return context.json({ error: 'from_is_wallet' }, 400);
    }
    if (!(await isWallet(db, { clientId, payer: body.to }))) {
      return context.json({ error: 'not_a_wallet' }, 400);
    }
    const over = await overDailyCap(db, rules, {
      clientId,
      buyer: null,
      payer: body.to,
      amountMicros: body.amountMicros,
    });
    if (over) {
      return context.json({ error: 'daily_cap', ...over }, 403);
    }
    const moved = await moveCredits(db, {
      clientId,
      from: body.from,
      to: body.to,
      amountMicros: body.amountMicros,
      moveId: body.id,
    });
    if ('error' in moved) {
      return context.json({ error: moved.error }, 409);
    }
    if (!moved.replayed) {
      await queueBillingEvent(db, context.env, {
        clientId,
        type: 'credits.moved',
        person: body.to,
        data: { from: body.from, amountMicros: body.amountMicros, id: body.id },
      });
      await applyCredits(context.env, db, clientId, body.from);
      await applyCredits(context.env, db, clientId, body.to);
    }
    return context.json({ data: { moved: !moved.replayed, grants: moved.grants } });
  })
  .post('/projects.payer', async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isPersonId(body?.project)) {
      return context.json({ error: 'bad_project' }, 400);
    }
    if (!isPersonId(body.payer)) {
      return context.json({ error: 'bad_payer' }, 400);
    }
    const db = context.get('db');
    const clientId = context.get('billingClient');
    const [found] = await db
      .select({ id: projects.id, owner: users.id, from: payerOf })
      .from(projects)
      .innerJoin(users, eq(users.id, projects.user_id))
      .where(
        and(
          eq(users.provider, APP + clientId),
          ne(projects.status, 'deleting'),
          or(eq(projects.id, body.project), eq(projects.slug, body.project)),
        ),
      );
    if (!found) {
      return context.json({ error: 'unknown_project' }, 404);
    }
    if (!(await knownPayer(db, clientId, body.payer))) {
      return context.json({ error: 'unknown_payer' }, 400);
    }
    if (found.from === body.payer) {
      return context.json({ data: { projectId: found.id, payer: body.payer, changed: false } });
    }
    await db.update(projects).set({ payer_person_id: body.payer }).where(eq(projects.id, found.id));
    await queueBillingEvent(db, context.env, {
      clientId,
      type: 'app.payer_changed',
      person: body.payer,
      data: { projectId: found.id, from: found.from },
    });
    // Decision: The new payer's standing decides the project's pause now, not at the next hourly pass. This
    // month's use so far stays with the old payer.
    await applyCredits(context.env, db, clientId, body.payer);
    await reconcileOperatorUserPlan(context, found.owner).catch((error: unknown) => {
      console.error('[billing] payer plan reconcile failed', { userId: found.owner, error });
    });
    return context.json({ data: { projectId: found.id, payer: body.payer, changed: true } });
  })
  .post('/wallets.open', async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isPersonId(body?.payer)) {
      return context.json({ error: 'bad_payer' }, 400);
    }
    const db = context.get('db');
    const clientId = context.get('billingClient');
    const [person] = await db
      .select({ one: sql<number>`1` })
      .from(appPeople)
      .where(and(eq(appPeople.client_id, clientId), eq(appPeople.person_id, body.payer)));
    if (person) {
      return context.json({ error: 'payer_is_person' }, 409);
    }
    await openWallet(db, { clientId, payer: body.payer });
    return context.json({ data: { payer: body.payer, wallet: true } });
  })
  .post('/credits.starter', async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isPersonId(body?.person)) {
      return context.json({ error: 'bad_person' }, 400);
    }
    const refused = await walletRefused(context, body.person);
    if (refused) {
      return refused;
    }
    const db = context.get('db');
    const clientId = context.get('billingClient');
    // Decision: The amount is the operator's setting, never the request's, so a leaked client secret can't mint
    // credits of any size.
    const [client] = await db
      .select({ amount: oauthClients.starter_credit_micros })
      .from(oauthClients)
      .where(eq(oauthClients.id, clientId));
    if (!client?.amount) {
      return context.json({ error: 'no_starter_credit' }, 404);
    }
    const grant = await grantCredits(db, {
      clientId,
      payer: body.person,
      source: 'starter',
      amountMicros: client.amount,
      livemode: stripeLiveMode(context.env),
    });
    await applyCredits(context.env, db, clientId, body.person);
    return context.json({
      data: { granted: Boolean(grant), amountMicros: grant ? client.amount : 0 },
    });
  })
  .post('/people.delete', async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isPersonId(body?.person)) {
      return context.json({ error: 'bad_person' }, 400);
    }
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
      return context.json({ error: 'bad_dry_run' }, 400);
    }
    const plan = await removal(context, body.person);
    if (body.dryRun) {
      return context.json({ data: { dryRun: true, ...plan.removes } });
    }
    const failed = await forgetPerson(context, body.person, plan);
    if (failed) {
      return context.json(
        {
          error: 'partial_failure',
          step: failed,
          message: 'The person is partly deleted. Call again to finish.',
          left: (await removal(context, body.person)).removes,
        },
        503,
      );
    }
    return context.json({ data: { deleted: true, ...plan.removes } });
  })
  .post('/plans.list', async (context) => {
    const plans = await clientPlans(context.get('db'), context.get('billingClient'));
    return context.json({
      data: {
        creditPurchase: await creditPurchase(context.get('db'), context.get('billingClient')),
        // Decision: Stored JSON doesn't keep its order, so the list goes from the smallest plan up.
        plans: Object.entries(plans)
          .map(([id, plan]) => ({ id, creditMicros: plan.creditMicros }))
          .sort((a, b) => a.creditMicros - b.creditMicros),
      },
    });
  })
  .post('/billing.checkout', async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isPersonId(body?.person)) {
      return context.json({ error: 'bad_person' }, 400);
    }
    const refused = await walletRefused(context, body.person);
    if (refused) {
      return refused;
    }
    const plans = await clientPlans(context.get('db'), context.get('billingClient'));
    if (Object.keys(plans).length === 0) {
      return context.json({ error: 'no_plans' }, 400);
    }
    if (typeof body?.plan !== 'string' || !Object.hasOwn(plans, body.plan)) {
      return context.json({ error: 'bad_plan' }, 400);
    }
    if (!isReturnUrl(body?.returnUrl)) {
      return context.json({ error: 'bad_return_url' }, 400);
    }
    const [stored] = await context
      .get('db')
      .select()
      .from(appPeople)
      .where(
        and(
          eq(appPeople.client_id, context.get('billingClient')),
          eq(appPeople.person_id, body.person),
        ),
      );
    const row = stored?.livemode === stripeLiveMode(context.env) ? stored : undefined;
    if (
      await payerBlocked(context.get('db'), {
        clientId: context.get('billingClient'),
        payer: body.person,
      })
    ) {
      return context.json({ error: 'blocked' }, 403);
    }
    // Decision: A payer holds one subscription. A stored one that Stripe hasn't ended sends them to the portal
    // to change it, so a second Checkout can't start a second subscription.
    if (
      row?.stripe_subscription_id &&
      row.subscription_status !== 'canceled' &&
      row.subscription_status !== 'incomplete_expired'
    ) {
      return context.json({ error: 'already_subscribed' }, 409);
    }
    try {
      const url = await createCheckoutSession(context.env, {
        customerId:
          row?.stripe_customer_id ??
          (
            await buyerOf(
              context.get('db'),
              context.get('billingClient'),
              body.person,
              stripeLiveMode(context.env),
            )
          )?.stripe_customer_id ??
          null,
        reference: `${context.get('billingClient')}:${body.person}`,
        metadata: { clientId: context.get('billingClient'), personId: body.person },
        email: typeof body.email === 'string' ? body.email : null,
        plan: body.plan,
        priceId: plans[body.plan]!.stripePriceId,
        returnUrl: body.returnUrl,
      });
      return context.json({ data: { url } });
    } catch (error) {
      if (error instanceof BillingUnavailableError) {
        return context.json({ error: 'billing_unavailable' }, 503);
      }
      throw error;
    }
  })
  .post('/credits.checkout', async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isPersonId(body?.buyer)) {
      return context.json({ error: 'bad_buyer' }, 400);
    }
    const payer = body.payer ?? body.buyer;
    if (!isPersonId(payer)) {
      return context.json({ error: 'bad_payer' }, 400);
    }
    if (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 100)) {
      return context.json({ error: 'bad_label' }, 400);
    }
    if (
      body.holdHours !== undefined &&
      (!Number.isSafeInteger(body.holdHours) ||
        body.holdHours < 1 ||
        body.holdHours > MAX_HOLD_HOURS)
    ) {
      return context.json({ error: 'bad_hold_hours', max: MAX_HOLD_HOURS }, 400);
    }
    const db = context.get('db');
    const clientId = context.get('billingClient');
    const rules = await creditPurchase(db, clientId);
    if (!rules) {
      return context.json({ error: 'credits_not_sold' }, 400);
    }
    if (payer !== body.buyer && !rules.buyForOthers) {
      return context.json({ error: 'buy_for_others_off' }, 403);
    }
    if (!fitsPurchase(rules, body.amountMicros)) {
      return context.json(
        { error: 'bad_amount', minMicros: rules.minMicros, stepMicros: rules.stepMicros },
        400,
      );
    }
    if (!isReturnUrl(body.returnUrl)) {
      return context.json({ error: 'bad_return_url' }, 400);
    }
    // Decision: A dispute blocks the person who paid. A blocked wallet with a clean buyer may still be bought for,
    // since that settles what it owes.
    if (await payerBlocked(db, { clientId, payer: body.buyer })) {
      return context.json({ error: 'blocked' }, 403);
    }
    const over = await overDailyCap(db, rules, {
      clientId,
      buyer: body.buyer,
      payer,
      amountMicros: body.amountMicros,
    });
    if (over) {
      return context.json({ error: 'daily_cap', ...over }, 403);
    }
    const livemode = stripeLiveMode(context.env);
    const [person] = await db
      .select()
      .from(appPeople)
      .where(and(eq(appPeople.client_id, clientId), eq(appPeople.person_id, body.buyer)));
    const customerId =
      (await buyerOf(db, clientId, body.buyer, livemode))?.stripe_customer_id ??
      (person?.livemode === livemode ? person.stripe_customer_id : null);
    try {
      const url = await createCreditCheckoutSession(context.env, {
        amountMicros: body.amountMicros,
        metadata: {
          kind: 'credits',
          clientId,
          buyerId: body.buyer,
          payerId: payer,
          lifeDays: String(rules.lifeDays),
          saveCard: String(body.saveCard === true),
          ...(body.holdHours ? { holdHours: String(body.holdHours) } : {}),
        },
        customerId,
        email: typeof body.email === 'string' ? body.email : null,
        saveCard: body.saveCard === true,
        returnUrl: body.returnUrl,
        label: body.label ?? null,
      });
      return context.json({ data: { url } });
    } catch (error) {
      if (error instanceof BillingUnavailableError) {
        return context.json({ error: 'billing_unavailable' }, 503);
      }
      throw error;
    }
  })
  .post('/credits.autoTopUp', async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isPersonId(body?.payer)) {
      return context.json({ error: 'bad_payer' }, 400);
    }
    const db = context.get('db');
    const clientId = context.get('billingClient');
    const payer = { clientId, payer: body.payer as string };
    if (body.enabled === false) {
      await setAutoTopUp(db, payer, null);
      return context.json({ data: { autoTopUp: await autoTopUpStatus(db, payer) } });
    }
    const buyer = body.buyer ?? body.payer;
    if (!isPersonId(buyer)) {
      return context.json({ error: 'bad_buyer' }, 400);
    }
    const rules = await creditPurchase(db, clientId);
    if (!rules) {
      return context.json({ error: 'credits_not_sold' }, 400);
    }
    if (buyer !== body.payer && !rules.buyForOthers) {
      return context.json({ error: 'buy_for_others_off' }, 403);
    }
    if (!fitsPurchase(rules, body.amountMicros)) {
      return context.json(
        { error: 'bad_amount', minMicros: rules.minMicros, stepMicros: rules.stepMicros },
        400,
      );
    }
    if (!isMicros(body.thresholdMicros) || !isMicros(body.monthlyLimitMicros)) {
      return context.json({ error: 'bad_settings' }, 400);
    }
    if (body.monthlyLimitMicros < body.amountMicros) {
      return context.json({ error: 'limit_under_amount' }, 400);
    }
    if (await payerBlocked(db, { clientId, payer: buyer })) {
      return context.json({ error: 'blocked' }, 403);
    }
    // Decision: Auto top-up charges a card saved by a credits Checkout with saveCard, so the buyer agreed to
    // charges made with nobody present.
    const saved = await buyerOf(db, clientId, buyer, stripeLiveMode(context.env));
    if (!saved?.stripe_payment_method_id) {
      return context.json({ error: 'needs_saved_card' }, 409);
    }
    await setAutoTopUp(db, payer, {
      buyer,
      thresholdMicros: body.thresholdMicros,
      amountMicros: body.amountMicros,
      monthlyLimitMicros: body.monthlyLimitMicros,
    });
    await applyCredits(context.env, db, clientId, payer.payer);
    return context.json({ data: { autoTopUp: await autoTopUpStatus(db, payer) } });
  })
  .post('/billing.portal', async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isPersonId(body?.person)) {
      return context.json({ error: 'bad_person' }, 400);
    }
    const refused = await walletRefused(context, body.person);
    if (refused) {
      return refused;
    }
    if (!isReturnUrl(body?.returnUrl)) {
      return context.json({ error: 'bad_return_url' }, 400);
    }
    const [row] = await context
      .get('db')
      .select()
      .from(appPeople)
      .where(
        and(
          eq(appPeople.client_id, context.get('billingClient')),
          eq(appPeople.person_id, body.person),
        ),
      );
    const customerId =
      row?.stripe_customer_id ??
      (
        await buyerOf(
          context.get('db'),
          context.get('billingClient'),
          body.person,
          stripeLiveMode(context.env),
        )
      )?.stripe_customer_id;
    if (!customerId) {
      return context.json({ error: 'no_subscription' }, 404);
    }
    try {
      const url = await createPortalSession(context.env, {
        customerId,
        returnUrl: body.returnUrl,
      });
      return context.json({ data: { url } });
    } catch (error) {
      if (error instanceof BillingUnavailableError) {
        return context.json({ error: 'billing_unavailable' }, 503);
      }
      throw error;
    }
  });
