import { and, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  applyCredits,
  clientPlans,
  dropTestPlans,
  paidOwnerIds,
  type ClientPlan,
} from '../app-credits.ts';
import { queueBillingEvent, type BillingEventType } from '../billing-events.ts';
import {
  cancelSubscription,
  fetchSubscription,
  invoicePaymentIntent,
  MICROS_PER_CENT,
  paymentMethodOf,
  PAID_PLANS,
  stripeLiveMode,
  type StripeSubscription,
  verifyStripeSignature,
  type PaidPlan,
} from '../billing/stripe.ts';
import {
  disputeGrant,
  grantCredits,
  payerBlocked,
  refundGrant,
  restoreDisputedGrant,
} from '../credit-ledger.ts';
import {
  boughtEvent,
  boughtUntil,
  creditPurchase,
  grantTopUp,
  overDailyCap,
  saveBuyer,
  topUpFailed,
  topUpFailedEvent,
} from '../credit-purchase.ts';
import type { Tx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { changeOperatorUserPlan, reconcileOperatorUserPlan } from '../operator/tenant-service.ts';
import { installationDefaultPlan } from '../plans.ts';
import { appCreditGrants, appPeople, stripeEvents } from '../schema.ts';

type Metadata = Record<string, string>;

type InvoiceLine = {
  amount?: number;
  quantity?: number | null;
  proration?: boolean;
  period?: { start?: number; end?: number };
  price?: { id?: string; unit_amount?: number | null };
  pricing?: { price_details?: { price?: string }; unit_amount_decimal?: string | null };
  parent?: { subscription_item_details?: { proration?: boolean } | null };
};

type StripeObject = {
  metadata?: Metadata;
  customer?: string;
  subscription?: string;
  id?: string;
  payment_status?: string;
  mode?: string;
  amount_subtotal?: number;
  customer_details?: { address?: { country?: string | null; state?: string | null } | null } | null;
  last_payment_error?: { code?: string } | null;
  status?: string;
  amount?: number;
  amount_refunded?: number;
  billing_reason?: string;
  amount_paid?: number;
  payment_intent?: string | { id?: string } | null;
  lines?: { data?: Array<InvoiceLine> };
  parent?: { subscription_details?: { metadata?: Metadata; subscription?: string } };
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

const PLAN_GRANT_REASONS = new Set([
  'subscription_create',
  'subscription_cycle',
  'subscription_update',
]);

/** Statuses in which a person keeps the plan. past_due keeps it while Stripe retries the card. */
const HOLDS_PLAN = new Set(['active', 'trialing', 'past_due']);

/** Events whose subscription is read again from Stripe, since events can arrive out of order. */
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'invoice.payment_failed',
]);

const subscriptionOf = (event: StripeEvent) =>
  event.type.startsWith('customer.subscription.')
    ? event.data.object.id
    : (event.data.object.subscription ??
      event.data.object.parent?.subscription_details?.subscription);

const planForPrice = (plans: Record<string, { stripePriceId: string }>, price?: string | null) =>
  price ? Object.keys(plans).find((id) => plans[id]!.stripePriceId === price) : undefined;

const priceOf = (line: InvoiceLine) => line.pricing?.price_details?.price ?? line.price?.id;
const isProration = (line: InvoiceLine) =>
  line.parent?.subscription_item_details?.proration ?? line.proration ?? false;
const unitCents = (line: InvoiceLine) => {
  const unit = line.pricing?.unit_amount_decimal ?? line.price?.unit_amount;
  return unit === null || unit === undefined ? null : Number(unit);
};

/**
 * What a seat plan's invoice brings. A new period brings each seat's credits. A seat change brings each
 * seat's credits times the share of a seat's price Stripe charged, net of the credit for unused time, rounded
 * down to the cent. A move to fewer seats nets nothing and brings nothing.
 */
function seatCredits(
  lines: ReadonlyArray<InvoiceLine>,
  plan: ClientPlan,
  change: boolean,
  storedUnitCents: number | null,
): number {
  const seat = lines.filter((line) => priceOf(line) === plan.stripePriceId);
  if (!change) {
    return (
      plan.creditMicros *
      seat.filter((line) => !isProration(line)).reduce((sum, line) => sum + (line.quantity ?? 1), 0)
    );
  }
  const charged = seat.filter(isProration).reduce((sum, line) => sum + (line.amount ?? 0), 0);
  const unit = seat.map(unitCents).find(Boolean) ?? storedUnitCents;
  if (charged <= 0 || !unit) {
    return 0;
  }
  return Math.floor((plan.creditMicros * charged) / unit / MICROS_PER_CENT) * MICROS_PER_CENT;
}

const DAY_SECONDS = 86_400;

/** A time in seconds moved by whole calendar months, kept on the same day or the month's last day. */
function addMonths(seconds: number, months: number): number {
  const date = new Date(seconds * 1000);
  const moved = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
    ),
  );
  const last = new Date(Date.UTC(moved.getUTCFullYear(), moved.getUTCMonth() + 1, 0)).getUTCDate();
  moved.setUTCDate(Math.min(date.getUTCDate(), last));
  return moved.getTime() / 1000;
}

/**
 * The months a paid period covers, counted back from its end, as [from, to] pairs. The first can be
 * part of a month, such as the rest of the month a seat was added in. A period of a month or less is one.
 */
function monthsOf(start: number, end: number): Array<[number, number]> {
  if (end - start <= 35 * DAY_SECONDS) {
    return [[start, end]];
  }
  const ends = [end];
  for (let back = 1; addMonths(end, -back) > start + DAY_SECONDS; back++) {
    ends.unshift(addMonths(end, -back));
  }
  return ends.map((to, index) => [index === 0 ? start : ends[index - 1]!, to]);
}

/** How many seats a seat change added: the new count's proration line less the old count's. */
function addedSeats(lines: ReadonlyArray<InvoiceLine>, plan: ClientPlan): number {
  const seat = lines.filter((line) => priceOf(line) === plan.stripePriceId && isProration(line));
  const added = seat.reduce(
    (sum, line) => sum + Math.sign(line.amount ?? 0) * (line.quantity ?? 1),
    0,
  );
  return Math.max(0, added);
}

/**
 * A paid subscription invoice grants the plan's monthly credits, which end with the paid period. The plan comes
 * from the invoice's price, since a plan changed in Stripe's portal keeps the old plan in the metadata.
 */
async function grantPlanCredits(
  context: Context<ApiEnv>,
  tx: Tx,
  event: StripeEvent,
  key: { client_id: string; person_id: string },
  paymentIntentId: string | null,
): Promise<boolean> {
  const invoice = event.data.object;
  if (!PLAN_GRANT_REASONS.has(invoice.billing_reason ?? '') || !invoice.id) {
    return false;
  }
  if (await payerBlocked(tx, { clientId: key.client_id, payer: key.person_id })) {
    console.warn('[billing] no credits for a payer blocked by a dispute', { id: event.id });
    return false;
  }
  const plans = await clientPlans(tx, key.client_id);
  // Decision: A plan change's invoice also lists a credit line for the old plan's unused time, so the line that
  // costs the most is the new plan.
  const line = invoice.lines?.data?.reduce((most, next) =>
    (next.amount ?? 0) > (most.amount ?? 0) ? next : most,
  );
  const plan = planForPrice(plans, line ? priceOf(line) : undefined) ?? eventMetadata(invoice).plan;
  let credits = plan ? (plans[plan]?.creditMicros ?? 0) : 0;
  const { start, end } = line?.period ?? {};
  const change = invoice.billing_reason === 'subscription_update';
  const bought = plan ? plans[plan] : undefined;
  if (bought?.perSeat) {
    const [row] = await tx
      .select({ unit: appPeople.seat_price_cents })
      .from(appPeople)
      .where(and(eq(appPeople.client_id, key.client_id), eq(appPeople.person_id, key.person_id)));
    credits = seatCredits(invoice.lines?.data ?? [], bought, change, row?.unit ?? null);
  } else if (change) {
    // Decision: A move to a bigger plan grants the difference from the largest plan grant still open, and only
    // when Stripe charged for it. A move down grants nothing and takes nothing back.
    const [open] = await tx
      .select({ most: sql<number>`coalesce(max(${appCreditGrants.amount_micros}), 0)` })
      .from(appCreditGrants)
      .where(
        and(
          eq(appCreditGrants.client_id, key.client_id),
          eq(appCreditGrants.payer_id, key.person_id),
          eq(appCreditGrants.source, 'plan'),
          sql`${appCreditGrants.voided_at} is null`,
          sql`${appCreditGrants.expires_at} > now()`,
        ),
      );
    credits = (invoice.amount_paid ?? 0) > 0 ? credits - Number(open?.most ?? 0) : 0;
  }
  if (credits <= 0 || !start || !end) {
    return false;
  }
  const months = monthsOf(start, end);
  // Decision: A period longer than a month, such as a year, brings the monthly credits once a month. Each month
  // is written now with its own start, so nothing has to run on a schedule, and a refund or dispute of the
  // payment finds the months still to come.
  const monthly =
    months.length === 1
      ? credits
      : change && bought?.perSeat
        ? bought.creditMicros * addedSeats(invoice.lines?.data ?? [], bought)
        : credits;
  for (const [index, [from, to]] of months.entries()) {
    const share =
      months.length > 1 && index === 0 && change ? (to - from) / (to - addMonths(to, -1)) : 1;
    const amountMicros =
      share === 1 ? monthly : Math.floor((monthly * share) / MICROS_PER_CENT) * MICROS_PER_CENT;
    if (amountMicros <= 0) {
      continue;
    }
    await grantCredits(tx, {
      clientId: key.client_id,
      payer: key.person_id,
      source: 'plan',
      amountMicros,
      livemode: event.livemode,
      giverId: eventMetadata(invoice).buyerId ?? null,
      stripeInvoiceId: invoice.id,
      stripePaymentIntentId: paymentIntentId,
      monthIndex: index,
      startsAt: new Date(from * 1000),
      expiresAt: new Date(to * 1000),
    });
  }
  return true;
}

const TAKE_BACK_EVENTS = new Set([
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
]);

const idOf = (value: string | { id?: string } | null | undefined) =>
  (typeof value === 'string' ? value : value?.id) ?? null;

/** The payment intent that paid an invoice, read from Stripe when the invoice doesn't carry it. A $0 invoice has none. */
async function paidBy(context: Context<ApiEnv>, invoice: StripeObject): Promise<string | null> {
  const carried = idOf(invoice.payment_intent);
  if (carried || !invoice.id || !invoice.amount_paid) {
    return carried;
  }
  return invoicePaymentIntent(context.env, invoice.id);
}

/**
 * Refunds and disputes find the grants by the payment they came from. Answers the payers whose
 * balance changed and, for a new dispute, the buyer it blocked. Null when nothing changed.
 */
async function takeBack(
  tx: Tx,
  event: StripeEvent,
): Promise<{
  payers: Array<{ clientId: string; payer: string }>;
  buyer?: string;
  subscriber?: string;
} | null> {
  const object = event.data.object;
  const paymentIntentId = idOf(object.payment_intent);
  if (!paymentIntentId) {
    return null;
  }
  if (event.type === 'charge.dispute.created') {
    return disputeGrant(tx, paymentIntentId);
  }
  const payers =
    event.type === 'charge.refunded'
      ? await refundGrant(tx, paymentIntentId, {
          amount: object.amount_refunded ?? 0,
          charged: object.amount ?? 0,
        })
      : object.status === 'won'
        ? await restoreDisputedGrant(tx, paymentIntentId)
        : [];
  return payers.length > 0 ? { payers } : null;
}

/** A dispute ends the buyer's subscription, so no more invoices are charged to the disputed card. */
async function cancelDisputed(
  context: Context<ApiEnv>,
  payer: { clientId: string; payer: string },
) {
  const [row] = await context
    .get('db')
    .select({ subscription: appPeople.stripe_subscription_id })
    .from(appPeople)
    .where(and(eq(appPeople.client_id, payer.clientId), eq(appPeople.person_id, payer.payer)));
  if (!row?.subscription) {
    return;
  }
  // Decision: The block already stops new grants and Checkouts, so a failed cancel is logged for an operator
  // instead of failing the event.
  await cancelSubscription(context.env, row.subscription).catch((error: unknown) => {
    console.error('[billing] could not cancel a disputed subscription', { ...payer, error });
  });
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

/**
 * Saves a subscription as Stripe has it now: its plan, status, renewal date and whether it's set to cancel. A
 * subscription other than the one stored for the person is left alone.
 */
async function saveSubscription(
  context: Context<ApiEnv>,
  tx: Tx,
  event: StripeEvent,
  key: { client_id: string; person_id: string },
  subscription: StripeSubscription,
): Promise<boolean> {
  const [row] = await tx
    .select()
    .from(appPeople)
    .where(and(eq(appPeople.client_id, key.client_id), eq(appPeople.person_id, key.person_id)));
  if (row?.stripe_subscription_id && row.stripe_subscription_id !== subscription.id) {
    console.warn('[billing] event for a subscription that is not the stored one', {
      id: event.id,
      subscription: subscription.id,
    });
    return false;
  }
  const plans = await clientPlans(tx, key.client_id);
  const byPrice = planForPrice(plans, subscription.priceId);
  if (!byPrice) {
    console.warn('[billing] subscription price matches no plan', {
      id: event.id,
      price: subscription.priceId,
    });
  }
  const named = eventMetadata(event.data.object).plan;
  const plan = byPrice ?? row?.plan ?? (named && Object.hasOwn(plans, named) ? named : undefined);
  const holds = HOLDS_PLAN.has(subscription.status) && plan;
  if (!row && !holds) {
    return false;
  }
  const perSeat = Boolean(plan && plans[plan]?.perSeat);
  const set = {
    ...(holds ? { plan } : {}),
    seats: perSeat ? subscription.quantity : null,
    seat_price_cents: perSeat ? subscription.unitAmountCents : null,
    stripe_subscription_id: subscription.id,
    stripe_customer_id: subscription.customerId ?? row?.stripe_customer_id ?? null,
    subscription_status: subscription.status,
    current_period_end: subscription.currentPeriodEnd,
    cancel_at_period_end: subscription.cancelAtPeriodEnd,
    livemode: event.livemode,
    updated_at: new Date().toISOString(),
  };
  await tx
    .insert(appPeople)
    .values({ ...key, plan: plan!, ...set })
    .onConflictDoUpdate({ target: [appPeople.client_id, appPeople.person_id], set });
  return true;
}

/** A connected application's person: their plan lives in app_people, not on an account. Runs inside the event's transaction. */
async function applyAppPersonEvent(
  context: Context<ApiEnv>,
  tx: Tx,
  event: StripeEvent,
  key: { client_id: string; person_id: string },
  subscription: StripeSubscription | null,
  paymentIntentId: string | null,
): Promise<boolean> {
  const object = event.data.object;
  if (event.type === 'invoice.paid') {
    return grantPlanCredits(context, tx, event, key, paymentIntentId);
  }
  if (subscription) {
    return saveSubscription(context, tx, event, key, subscription);
  }
  const plan = object.metadata?.plan;
  if (checkoutPaid(event) && plan && Object.hasOwn(await clientPlans(tx, key.client_id), plan)) {
    const subscriptionId = object.subscription ?? null;
    const row = {
      plan,
      stripe_customer_id: object.customer ?? null,
      stripe_subscription_id: subscriptionId,
      livemode: event.livemode,
      updated_at: new Date().toISOString(),
    };
    // Decision: A paid Checkout starts the subscription as active, unless a subscription event for the same
    // subscription already stored a newer status.
    await tx
      .insert(appPeople)
      .values({ ...key, ...row, subscription_status: 'active' })
      .onConflictDoUpdate({
        target: [appPeople.client_id, appPeople.person_id],
        set: {
          ...row,
          subscription_status: sql`case when ${appPeople.stripe_subscription_id} is not distinct from ${subscriptionId} then coalesce(${appPeople.subscription_status}, 'active') else 'active' end`,
        },
      });
    return true;
  }
  if (event.type === 'customer.subscription.deleted' && object.id) {
    const ended = await tx
      .update(appPeople)
      .set({
        plan: (await installationDefaultPlan(tx, context.env)).id,
        stripe_subscription_id: null,
        subscription_status: 'canceled',
        current_period_end: null,
        cancel_at_period_end: false,
        updated_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(appPeople.client_id, key.client_id),
          eq(appPeople.person_id, key.person_id),
          eq(appPeople.stripe_subscription_id, object.id),
        ),
      )
      .returning();
    return ended.length > 0;
  }
  return false;
}

/** What an applied subscription event tells the application, if anything. */
function subscriptionNews(event: StripeEvent): { type: BillingEventType; data: object } | null {
  if (event.type === 'invoice.payment_failed') {
    return { type: 'payment.failed', data: { for: 'subscription' } };
  }
  if (event.type === 'customer.subscription.deleted') {
    return { type: 'subscription.ended', data: {} };
  }
  if (checkoutPaid(event)) {
    return { type: 'subscription.started', data: { plan: event.data.object.metadata?.plan } };
  }
  return null;
}

/** Metadata on a credits Checkout and an auto top-up charge: who pays, who the credits are for, and how long they last. */
type CreditMetadata = Metadata & {
  kind: 'credits' | 'top_up';
  clientId: string;
  buyerId: string;
  payerId: string;
  lifeDays: string;
};

const isCreditMetadata = (metadata: Metadata): metadata is CreditMetadata =>
  (metadata.kind === 'credits' || metadata.kind === 'top_up') &&
  Boolean(metadata.clientId && metadata.buyerId && metadata.payerId) &&
  Number.isSafeInteger(Number(metadata.lifeDays));

/**
 * Bought credits. A paid credits Checkout grants what was paid before tax, so tax doesn't change the credits, and
 * keeps the buyer's Stripe customer and saved card. An auto top-up's charge is granted from its payment intent,
 * which its own Stripe reply may already have done. Answers the payer, or null when nothing applies.
 */
async function applyCreditEvent(
  context: Context<ApiEnv>,
  tx: Tx,
  event: StripeEvent,
  metadata: CreditMetadata,
  paymentMethodId: string | null,
) {
  const object = event.data.object;
  const payer = { clientId: metadata.clientId, payer: metadata.payerId };
  const paymentIntentId = idOf(object.payment_intent) ?? object.id ?? null;
  if (metadata.kind === 'credits' && checkoutPaid(event) && object.mode === 'payment') {
    if (object.customer) {
      await saveBuyer(tx, {
        clientId: metadata.clientId,
        buyer: metadata.buyerId,
        livemode: event.livemode,
        customerId: object.customer,
        paymentMethodId,
      });
    }
    const amountMicros = (object.amount_subtotal ?? 0) * MICROS_PER_CENT;
    if (amountMicros <= 0 || !paymentIntentId) {
      return null;
    }
    const now = new Date();
    const rules = await creditPurchase(tx, metadata.clientId);
    // Decision: Stripe already took the money, so a paid Checkout past a daily cap is granted and logged for an
    // operator, not dropped.
    const over =
      rules &&
      (await overDailyCap(tx, rules, {
        clientId: metadata.clientId,
        buyer: metadata.buyerId,
        payer: metadata.payerId,
        amountMicros,
      }));
    if (over) {
      console.error('[credits] a paid Checkout passed a daily cap', { ...payer, ...over });
    }
    const holdHours = Number(metadata.holdHours ?? 0);
    const added = await grantCredits(tx, {
      ...payer,
      source: 'bought',
      amountMicros,
      livemode: event.livemode,
      giverId: metadata.buyerId,
      billingCountry: object.customer_details?.address?.country ?? null,
      billingState: object.customer_details?.address?.state ?? null,
      stripePaymentIntentId: paymentIntentId,
      ...(holdHours > 0 ? { startsAt: new Date(now.getTime() + holdHours * 3_600_000) } : {}),
      expiresAt: boughtUntil(now, Number(metadata.lifeDays)),
    });
    if (added) {
      await queueBillingEvent(tx, context.env, boughtEvent(added, false));
    }
    return payer;
  }
  if (metadata.kind === 'top_up' && object.id && event.type === 'payment_intent.succeeded') {
    const added = await grantTopUp(tx, {
      ...payer,
      buyer: metadata.buyerId,
      amountMicros: (object.amount ?? 0) * MICROS_PER_CENT,
      paymentIntentId: object.id,
      lifeDays: Number(metadata.lifeDays),
      livemode: event.livemode,
    });
    if (added) {
      await queueBillingEvent(tx, context.env, boughtEvent(added, true));
    }
    return payer;
  }
  if (metadata.kind === 'top_up' && event.type === 'payment_intent.payment_failed') {
    const amountMicros = (object.amount ?? 0) * MICROS_PER_CENT;
    const reason =
      object.last_payment_error?.code === 'authentication_required'
        ? 'authentication_required'
        : 'card_declined';
    if (await topUpFailed(tx, payer, amountMicros, reason)) {
      await queueBillingEvent(tx, context.env, topUpFailedEvent(payer, amountMicros, reason));
    }
    return payer;
  }
  return null;
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
    await dropTestPlans(db, context.env);
  }
  const seen = { event_id: event.id, type: event.type, livemode: event.livemode };
  const metadata = eventMetadata(event.data.object);

  if (TAKE_BACK_EVENTS.has(event.type)) {
    const outcome = await db.transaction(async (tx) => {
      const fresh = await tx.insert(stripeEvents).values(seen).onConflictDoNothing().returning();
      return fresh.length === 0 ? ('duplicate' as const) : takeBack(tx, event);
    });
    if (typeof outcome === 'string') {
      return context.json({ ok: true, duplicate: true });
    }
    if (!outcome) {
      return context.json({ ok: true, ignored: true });
    }
    const clientId = outcome.payers[0]!.clientId;
    for (const payer of new Set([outcome.buyer, outcome.subscriber])) {
      if (payer) {
        await cancelDisputed(context, { clientId, payer });
      }
    }
    for (const { payer } of outcome.payers) {
      await applyCredits(context.env, db, clientId, payer);
    }
    return context.json({ ok: true });
  }

  if (isCreditMetadata(metadata)) {
    const paid = idOf(event.data.object.payment_intent);
    const paymentMethodId =
      paid && metadata.kind === 'credits' && metadata.saveCard === 'true' && checkoutPaid(event)
        ? await paymentMethodOf(context.env, paid)
        : null;
    const outcome = await db.transaction(async (tx) => {
      const fresh = await tx.insert(stripeEvents).values(seen).onConflictDoNothing().returning();
      return fresh.length === 0
        ? ('duplicate' as const)
        : applyCreditEvent(context, tx, event, metadata, paymentMethodId);
    });
    if (typeof outcome === 'string') {
      return context.json({ ok: true, duplicate: true });
    }
    if (!outcome) {
      return context.json({ ok: true, ignored: true });
    }
    await applyCredits(context.env, db, outcome.clientId, outcome.payer);
    return context.json({ ok: true });
  }

  if (metadata.clientId && metadata.personId) {
    const key = { client_id: metadata.clientId, person_id: metadata.personId };
    const subscriptionId = SUBSCRIPTION_EVENTS.has(event.type) ? subscriptionOf(event) : undefined;
    const subscription = subscriptionId
      ? await fetchSubscription(context.env, subscriptionId)
      : null;
    const paymentIntentId =
      event.type === 'invoice.paid' ? await paidBy(context, event.data.object) : null;
    // Decision: The event id is saved in the transaction that applies it, so a handler that throws lets Stripe retry.
    const outcome = await db.transaction(async (tx) => {
      const fresh = await tx.insert(stripeEvents).values(seen).onConflictDoNothing().returning();
      if (fresh.length === 0) {
        return 'duplicate';
      }
      if (!(await applyAppPersonEvent(context, tx, event, key, subscription, paymentIntentId))) {
        return 'ignored';
      }
      const news = subscriptionNews(event);
      if (news) {
        await queueBillingEvent(tx, context.env, {
          ...news,
          clientId: key.client_id,
          person: key.person_id,
        });
      }
      return 'applied';
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
    await changeOperatorUserPlan(
      context,
      userId,
      (await installationDefaultPlan(db, context.env)).id,
    );
    applied = true;
  }
  await db.insert(stripeEvents).values(seen).onConflictDoNothing();
  return context.json(applied ? { ok: true } : { ok: true, ignored: true });
});
