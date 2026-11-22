import { and, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  addUse,
  applyCredits,
  clientPlans,
  currentPeriod,
  hostedAsOf,
  paidProjects,
  paidProjectUse,
  payerDaily,
  readMeterPrices,
  costMicros,
  type Meter,
  type MeterPrices,
  type MeterUse,
} from '../app-credits.ts';
import { authenticateOAuthClient, OAuthError } from '../auth/oauth.ts';
import {
  BillingUnavailableError,
  createCheckoutSession,
  createPortalSession,
  subscriptionRenewsAt,
} from '../billing/stripe.ts';
import type { ApiEnv } from '../env.ts';
import { getDefaultPlan, resolvePlanLimits } from '../plans.ts';
import { appPeople, appUsage, appUsageEvents, appUsageSources } from '../schema.ts';

const isPersonId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;
const isReturnUrl = (value: unknown): value is string =>
  typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:';

type BillingContext = Context<ApiEnv>;

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
} as const satisfies Record<string, Meter>;

function hostedLine(use: Partial<MeterUse>, prices: MeterPrices) {
  return {
    ...(Object.fromEntries(
      Object.entries(HOSTED_FIELDS).map(([field, meter]) => [field, use[meter] ?? 0]),
    ) as Record<keyof typeof HOSTED_FIELDS, number>),
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
  const total: Partial<MeterUse> = {};
  const listed = rows.map(({ project, person: builtFor }) => {
    const projectUse = use.get(project.id) ?? {};
    for (const [meter, quantity] of Object.entries(projectUse)) {
      total[meter as Meter] = (total[meter as Meter] ?? 0) + quantity;
    }
    return {
      projectId: project.id,
      slug: project.slug,
      person: builtFor,
      ...hostedLine(projectUse, prices),
    };
  });
  return { ...hostedLine(total, prices), projects: listed };
}

/** A person's plan, its caps, what they used this month, and whether they are still within the caps. */
async function standing(context: BillingContext, person: string) {
  const db = context.get('db');
  const clientId = context.get('billingClient');
  const { row, meters, credits } = await applyCredits(context.env, db, clientId, person);
  const plan = row?.plan ?? (await getDefaultPlan(db)).id;
  const limits = await resolvePlanLimits(db, plan);
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
  const aiWithinCap = credits ? !credits.out : within(limits.aiNeuronsPerMonth, usedNow.aiNeurons);
  const sandboxWithinCap = credits
    ? !credits.out
    : within(limits.sandboxRuntimeSecondsPerMonth, usedNow.sandboxSeconds);
  return {
    plan,
    billingPeriodStart: `${period}T00:00:00.000Z`,
    caps: {
      aiNeuronsPerMonth: limits.aiNeuronsPerMonth,
      sandboxSecondsPerMonth: limits.sandboxRuntimeSecondsPerMonth,
    },
    used: usedNow,
    breakdown,
    credits,
    meters,
    withinCaps: aiWithinCap && sandboxWithinCap,
    aiWithinCap,
    sandboxWithinCap,
    subscribed: Boolean(row?.stripe_subscription_id),
    subscriptionId: row?.stripe_subscription_id ?? null,
  };
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
    const { subscriptionId, ...now } = await standing(context, body.person);
    // Decision: A paid plan renews on its own Stripe date, not on the first of the month when the meters reset. If
    // Stripe can't be reached, the answer leaves renewsAt out instead of failing.
    const renewsAt = subscriptionId
      ? await subscriptionRenewsAt(context.env, subscriptionId).catch(() => null)
      : null;
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
    return context.json({
      data: {
        ...now,
        hostedAsOf: await hostedAsOf(db),
        ...hosted,
        ...daily,
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
        outOfCredits: now.credits?.out ?? false,
        creditsRemainingMicros: now.credits?.remainingMicros ?? null,
      },
    });
  })
  .post('/plans.list', async (context) => {
    const plans = await clientPlans(context.env, context.get('db'), context.get('billingClient'));
    return context.json({
      data: {
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
    const plans = await clientPlans(context.env, context.get('db'), context.get('billingClient'));
    if (typeof body?.plan !== 'string' || !Object.hasOwn(plans, body.plan)) {
      return context.json({ error: 'bad_plan' }, 400);
    }
    if (!isReturnUrl(body?.returnUrl)) {
      return context.json({ error: 'bad_return_url' }, 400);
    }
    try {
      const url = await createCheckoutSession(context.env, {
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
  .post('/billing.portal', async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isPersonId(body?.person)) {
      return context.json({ error: 'bad_person' }, 400);
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
    if (!row?.stripe_customer_id) {
      return context.json({ error: 'no_subscription' }, 404);
    }
    try {
      const url = await createPortalSession(context.env, {
        customerId: row.stripe_customer_id,
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
