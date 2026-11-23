import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { authenticateOAuthClient, OAuthError } from '../auth/oauth.ts';
import {
  BillingUnavailableError,
  PAID_PLANS,
  createCheckoutSession,
  createPortalSession,
  subscriptionRenewsAt,
} from '../billing/stripe.ts';
import type { PaidPlan } from '../billing/stripe.ts';
import type { ApiEnv } from '../env.ts';
import { getDefaultPlan, resolvePlanLimits } from '../plans.ts';
import { appPeople, appUsage, appUsageEvents } from '../schema.ts';

const isPaidPlan = (value: unknown): value is PaidPlan =>
  typeof value === 'string' && Object.hasOwn(PAID_PLANS, value);
const isPersonId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;
const isReturnUrl = (value: unknown): value is string =>
  typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:';

/** First day of this calendar month in UTC, as `YYYY-MM-01`. */
const currentPeriod = (now = new Date()) => `${now.toISOString().slice(0, 7)}-01`;

type BillingContext = Context<ApiEnv>;

/** A person's plan, its caps, what they used this month, and whether they are still within the caps. */
async function standing(context: BillingContext, person: string) {
  const db = context.get('db');
  const clientId = context.get('billingClient');
  const [row] = await db
    .select()
    .from(appPeople)
    .where(and(eq(appPeople.client_id, clientId), eq(appPeople.person_id, person)));
  const plan = row?.plan ?? (await getDefaultPlan(db)).id;
  const limits = await resolvePlanLimits(db, plan);
  const period = currentPeriod();
  const [used] = await db
    .select()
    .from(appUsage)
    .where(
      and(
        eq(appUsage.client_id, clientId),
        eq(appUsage.person_id, person),
        eq(appUsage.period, period),
      ),
    );
  const usedNow = { aiNeurons: used?.ai_neurons ?? 0, sandboxSeconds: used?.sandbox_seconds ?? 0 };
  // Decision: 0 means unlimited in a plan's limits.
  const within = (limit: number, value: number) => limit === 0 || value < limit;
  const aiWithinCap = within(limits.aiNeuronsPerMonth, usedNow.aiNeurons);
  const sandboxWithinCap = within(limits.sandboxRuntimeSecondsPerMonth, usedNow.sandboxSeconds);
  return {
    plan,
    billingPeriodStart: `${period}T00:00:00.000Z`,
    caps: {
      aiNeuronsPerMonth: limits.aiNeuronsPerMonth,
      sandboxSecondsPerMonth: limits.sandboxRuntimeSecondsPerMonth,
    },
    used: usedNow,
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
    return context.json({ data: { ...now, ...(renewsAt ? { renewsAt } : {}) } });
  })
  .post('/usage.record', async (context) => {
    const body = await context.req.json().catch(() => null);
    const count = (value: unknown) =>
      value === undefined
        ? 0
        : Number.isSafeInteger(value) && (value as number) >= 0
          ? (value as number)
          : -1;
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
    });
    const now = await standing(context, body.person);
    return context.json({
      data: {
        aiNeuronsUsed: now.used.aiNeurons,
        sandboxSecondsUsed: now.used.sandboxSeconds,
        withinCaps: now.withinCaps,
      },
    });
  })
  .post('/billing.checkout', async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isPersonId(body?.person)) {
      return context.json({ error: 'bad_person' }, 400);
    }
    if (!isPaidPlan(body?.plan)) {
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
