import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { applyCredits, clientPlans, dropTestPlans, paidOwnerIds } from '../app-credits.ts';
import {
  PAID_PLANS,
  stripeLiveMode,
  verifyStripeSignature,
  type PaidPlan,
} from '../billing/stripe.ts';
import { grantCredits } from '../credit-ledger.ts';
import type { Tx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { changeOperatorUserPlan, reconcileOperatorUserPlan } from '../operator/tenant-service.ts';
import { getDefaultPlan } from '../plans.ts';
import { appPeople, stripeEvents } from '../schema.ts';

type Metadata = Record<string, string>;

type InvoiceLine = {
  period?: { start?: number; end?: number };
  price?: { id?: string };
  pricing?: { price_details?: { price?: string } };
};

type StripeObject = {
  metadata?: Metadata;
  customer?: string;
  subscription?: string;
  id?: string;
  payment_status?: string;
  billing_reason?: string;
  payment_intent?: string | null;
  lines?: { data?: Array<InvoiceLine> };
  parent?: { subscription_details?: { metadata?: Metadata } };
  subscription_details?: { metadata?: Metadata };
};

type StripeEvent = {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: StripeObject };
};

const isPaidPlan = (value: unknown): value is PaidPlan =>
  typeof value === 'string' && Object.hasOwn(PAID_PLANS, value);

const CHECKOUT_PAID = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

/** A Checkout that has the money. A slow payment method completes unpaid and pays in a later event. */
const checkoutPaid = (event: StripeEvent) =>
  CHECKOUT_PAID.has(event.type) &&
  (event.data.object.payment_status === 'paid' ||
    event.data.object.payment_status === 'no_payment_required');

/**
 * Whose event it is. An invoice keeps the subscription's metadata under parent.subscription_details on newer
 * Stripe API versions and under subscription_details on older ones.
 */
const eventMetadata = (object: StripeObject): Metadata =>
  (object.metadata?.clientId || object.metadata?.userId ? object.metadata : undefined) ??
  object.parent?.subscription_details?.metadata ??
  object.subscription_details?.metadata ??
  object.metadata ??
  {};

const PLAN_GRANT_REASONS = new Set(['subscription_create', 'subscription_cycle']);

/**
 * A paid subscription invoice grants the plan's monthly credits, which end with the paid period. The plan comes
 * from the invoice's price, since a plan changed in Stripe's portal keeps the old plan in the metadata.
 */
async function grantPlanCredits(
  context: Context<ApiEnv>,
  tx: Tx,
  event: StripeEvent,
  key: { client_id: string; person_id: string },
): Promise<boolean> {
  const invoice = event.data.object;
  if (!PLAN_GRANT_REASONS.has(invoice.billing_reason ?? '') || !invoice.id) {
    return false;
  }
  const plans = await clientPlans(context.env, tx, key.client_id);
  const line = invoice.lines?.data?.[0];
  const price = line?.pricing?.price_details?.price ?? line?.price?.id;
  const plan =
    Object.keys(plans).find((id) => price && plans[id]!.stripePriceId === price) ??
    eventMetadata(invoice).plan;
  const credits = plan ? (plans[plan]?.creditMicros ?? 0) : 0;
  const { start, end } = line?.period ?? {};
  if (credits <= 0 || !start || !end) {
    return false;
  }
  await grantCredits(tx, {
    clientId: key.client_id,
    payer: key.person_id,
    source: 'plan',
    amountMicros: credits,
    livemode: event.livemode,
    stripeInvoiceId: invoice.id,
    stripePaymentIntentId:
      typeof invoice.payment_intent === 'string' ? invoice.payment_intent : null,
    startsAt: new Date(start * 1000),
    expiresAt: new Date(end * 1000),
  });
  return true;
}

/** Applies a person's new plan to the limits of the projects they pay for. */
async function reconcilePaidProjects(context: Context<ApiEnv>, clientId: string, person: string) {
  const db = context.get('db');
  // Decision: The new plan's credits decide the AI pause before the limits are stamped again.
  await applyCredits(context.env, db, clientId, person);
  for (const id of await paidOwnerIds(db, clientId, person)) {
    // Decision: The plan is already saved, and the scheduled reconciliation applies it later if this fails.
    await reconcileOperatorUserPlan(context, id).catch((error: unknown) => {
      console.error('[billing] payer plan reconcile failed', { userId: id, error });
    });
  }
}

/** A connected application's person: their plan lives in app_people, not on an account. Runs inside the event's transaction. */
async function applyAppPersonEvent(
  context: Context<ApiEnv>,
  tx: Tx,
  event: StripeEvent,
  key: { client_id: string; person_id: string },
): Promise<boolean> {
  const object = event.data.object;
  if (event.type === 'invoice.paid') {
    return grantPlanCredits(context, tx, event, key);
  }
  const plan = object.metadata?.plan;
  if (
    checkoutPaid(event) &&
    plan &&
    Object.hasOwn(await clientPlans(context.env, tx, key.client_id), plan)
  ) {
    const row = {
      plan,
      stripe_customer_id: object.customer ?? null,
      stripe_subscription_id: object.subscription ?? null,
      livemode: event.livemode,
      updated_at: new Date().toISOString(),
    };
    await tx
      .insert(appPeople)
      .values({ ...key, ...row })
      .onConflictDoUpdate({ target: [appPeople.client_id, appPeople.person_id], set: row });
    return true;
  }
  if (event.type === 'customer.subscription.deleted') {
    await tx
      .update(appPeople)
      .set({
        plan: (await getDefaultPlan(tx)).id,
        stripe_subscription_id: null,
        updated_at: new Date().toISOString(),
      })
      .where(and(eq(appPeople.client_id, key.client_id), eq(appPeople.person_id, key.person_id)));
    return true;
  }
  return false;
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
  if (typeof event.id !== 'string' || typeof event.livemode !== 'boolean' || !event.data?.object) {
    return context.json({ error: 'bad event' }, 400);
  }
  // Decision: An event from the other Stripe mode answers 200, so Stripe stops sending it, and changes nothing.
  const live = stripeLiveMode(context.env);
  if (event.livemode !== live) {
    console.warn('[billing] stripe event from the other mode ignored', {
      id: event.id,
      type: event.type,
      livemode: event.livemode,
    });
    return context.json({ ok: true, ignored: true });
  }
  const db = context.get('db');
  if (live) {
    await dropTestPlans(db);
  }
  const seen = { event_id: event.id, type: event.type, livemode: event.livemode };
  const metadata = eventMetadata(event.data.object);

  if (metadata.clientId && metadata.personId) {
    const key = { client_id: metadata.clientId, person_id: metadata.personId };
    // Decision: The event id is saved in the transaction that applies it, so a handler that throws lets Stripe retry.
    const outcome = await db.transaction(async (tx) => {
      const fresh = await tx.insert(stripeEvents).values(seen).onConflictDoNothing().returning();
      if (fresh.length === 0) {
        return 'duplicate';
      }
      return (await applyAppPersonEvent(context, tx, event, key)) ? 'applied' : 'ignored';
    });
    if (outcome === 'applied') {
      await reconcilePaidProjects(context, key.client_id, key.person_id);
    }
    return context.json(outcome === 'applied' ? { ok: true } : { ok: true, [outcome]: true });
  }

  const userId = metadata.userId;
  const [already] = await db
    .select({ id: stripeEvents.event_id })
    .from(stripeEvents)
    .where(eq(stripeEvents.event_id, event.id));
  if (already) {
    return context.json({ ok: true, duplicate: true });
  }
  // Decision: A Platform account's plan change runs its own transactions and is safe to repeat, so the event id is
  // saved after it succeeds.
  let applied = false;
  if (userId && checkoutPaid(event) && isPaidPlan(metadata.plan)) {
    await changeOperatorUserPlan(context, userId, metadata.plan);
    applied = true;
  } else if (userId && event.type === 'customer.subscription.deleted') {
    await changeOperatorUserPlan(context, userId, (await getDefaultPlan(db)).id);
    applied = true;
  }
  await db.insert(stripeEvents).values(seen).onConflictDoNothing();
  return context.json(applied ? { ok: true } : { ok: true, ignored: true });
});
