import { and, eq, or } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { PAID_PLANS, verifyStripeSignature, type PaidPlan } from '../billing/stripe.ts';
import type { ApiEnv } from '../env.ts';
import { changeOperatorUserPlan, reconcileOperatorUserPlan } from '../operator/tenant-service.ts';
import { getDefaultPlan } from '../plans.ts';
import { appPeople, projects, users } from '../schema.ts';

type StripeEvent = {
  type: string;
  data: {
    object: {
      metadata?: Record<string, string>;
      customer?: string;
      subscription?: string;
      id?: string;
    };
  };
};

const isPaidPlan = (value: unknown): value is PaidPlan =>
  typeof value === 'string' && Object.hasOwn(PAID_PLANS, value);

/** Applies a person's new plan to the limits of the projects they pay for. */
async function reconcilePaidProjects(context: Context<ApiEnv>, clientId: string, person: string) {
  const owners = await context
    .get('db')
    .selectDistinct({ id: users.id })
    .from(users)
    .leftJoin(projects, eq(projects.user_id, users.id))
    .where(
      and(
        eq(users.provider, `app:${clientId}`),
        or(eq(users.provider_id, person), eq(projects.payer_person_id, person)),
      ),
    );
  for (const owner of owners) {
    // Decision: The plan is already saved, and the scheduled reconciliation applies it later if this fails.
    await reconcileOperatorUserPlan(context, owner.id).catch((error: unknown) => {
      console.error('[billing] payer plan reconcile failed', { userId: owner.id, error });
    });
  }
}

/**
 * Stripe tells the platform when a subscription starts or ends, and the account's plan follows.
 * Plan limits, usage counters and suspension are the platform's own, so nothing else changes here.
 */
export const stripeWebhookRoutes = new Hono<ApiEnv>().post('/', async (context) => {
  const secret = context.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return context.json({ error: 'billing not configured' }, 503);
  }
  const body = await context.req.text();
  if (
    !(await verifyStripeSignature(body, context.req.header('stripe-signature') ?? null, secret))
  ) {
    return context.json({ error: 'bad signature' }, 400);
  }
  const event = JSON.parse(body) as StripeEvent;
  const object = event.data?.object ?? {};
  const metadata = object.metadata ?? {};
  const db = context.get('db');

  // Decision: A person of a connected application: their plan lives in app_people, not on an account.
  if (metadata.clientId && metadata.personId) {
    const key = { client_id: metadata.clientId, person_id: metadata.personId };
    if (event.type === 'checkout.session.completed' && isPaidPlan(metadata.plan)) {
      const row = {
        plan: metadata.plan,
        stripe_customer_id: object.customer ?? null,
        stripe_subscription_id: object.subscription ?? null,
        updated_at: new Date().toISOString(),
      };
      await db
        .insert(appPeople)
        .values({ ...key, ...row })
        .onConflictDoUpdate({ target: [appPeople.client_id, appPeople.person_id], set: row });
    } else if (event.type === 'customer.subscription.deleted') {
      await db
        .update(appPeople)
        .set({
          plan: (await getDefaultPlan(db)).id,
          stripe_subscription_id: null,
          updated_at: new Date().toISOString(),
        })
        .where(and(eq(appPeople.client_id, key.client_id), eq(appPeople.person_id, key.person_id)));
    } else {
      return context.json({ ok: true, ignored: true });
    }
    await reconcilePaidProjects(context, key.client_id, key.person_id);
    return context.json({ ok: true });
  }

  const userId = metadata.userId;
  if (!userId) {
    return context.json({ ok: true, ignored: true });
  }

  if (event.type === 'checkout.session.completed' && isPaidPlan(metadata.plan)) {
    await changeOperatorUserPlan(context, userId, metadata.plan);
  } else if (event.type === 'customer.subscription.deleted') {
    await changeOperatorUserPlan(context, userId, (await getDefaultPlan(db)).id);
  } else {
    return context.json({ ok: true, ignored: true });
  }
  return context.json({ ok: true });
});
