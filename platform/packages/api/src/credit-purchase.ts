import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { queueBillingEvent } from './billing-events.ts';
import {
  chargeSavedCard,
  MICROS_PER_CENT,
  stripeLiveMode,
  type StripeEnv,
} from './billing/stripe.ts';
import { creditBalance, grantCredits, lockPayer, type Payer } from './credit-ledger.ts';
import type { Db, DbOrTx } from './db.ts';
import {
  appBuyers,
  appPayers,
  oauthClients,
  type AutoTopUp,
  type CreditPurchase,
} from './schema.ts';

const DAY_MS = 86_400_000;
const STALE_MS = 10 * 60_000;

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

/** Reads the operator's purchase rules. Null unless each one is a whole number above zero, in whole cents. */
export function parseCreditPurchase(value: unknown): CreditPurchase | null {
  const rules = value as Record<string, unknown> | null;
  if (
    !rules ||
    !isCount(rules.minMicros) ||
    !isCount(rules.stepMicros) ||
    !isCount(rules.lifeDays) ||
    rules.minMicros % MICROS_PER_CENT !== 0 ||
    rules.stepMicros % MICROS_PER_CENT !== 0
  ) {
    return null;
  }
  return { minMicros: rules.minMicros, stepMicros: rules.stepMicros, lifeDays: rules.lifeDays };
}

/** How the application sells credits, or null when it doesn't. */
export async function creditPurchase(db: DbOrTx, clientId: string) {
  const [client] = await db
    .select({ rules: oauthClients.credit_purchase })
    .from(oauthClients)
    .where(eq(oauthClients.id, clientId));
  return client?.rules ?? null;
}

/** True for an amount from the smallest one up, in whole steps. */
export const fitsPurchase = (rules: CreditPurchase, amount: unknown): amount is number =>
  Number.isSafeInteger(amount) &&
  (amount as number) >= rules.minMicros &&
  ((amount as number) - rules.minMicros) % rules.stepMicros === 0;

export const boughtUntil = (now: Date, lifeDays: number) =>
  new Date(now.getTime() + lifeDays * DAY_MS);

export async function buyerOf(db: DbOrTx, clientId: string, buyer: string, livemode: boolean) {
  const [row] = await db
    .select()
    .from(appBuyers)
    .where(
      and(
        eq(appBuyers.client_id, clientId),
        eq(appBuyers.buyer_id, buyer),
        eq(appBuyers.livemode, livemode),
      ),
    );
  return row;
}

/** Keeps the buyer's Stripe customer, and their card when one was saved. */
export async function saveBuyer(
  db: DbOrTx,
  buyer: {
    clientId: string;
    buyer: string;
    livemode: boolean;
    customerId: string;
    paymentMethodId: string | null;
  },
) {
  const set = {
    stripe_customer_id: buyer.customerId,
    ...(buyer.paymentMethodId ? { stripe_payment_method_id: buyer.paymentMethodId } : {}),
    updated_at: new Date().toISOString(),
  };
  await db
    .insert(appBuyers)
    .values({ client_id: buyer.clientId, buyer_id: buyer.buyer, livemode: buyer.livemode, ...set })
    .onConflictDoUpdate({
      target: [appBuyers.client_id, appBuyers.buyer_id, appBuyers.livemode],
      set,
    });
}

const payerRow = (payer: Payer) =>
  and(eq(appPayers.client_id, payer.clientId), eq(appPayers.payer_id, payer.payer));

/** The payer's auto top-up as the status call shows it. Null when it was never set up. */
export async function autoTopUpStatus(db: DbOrTx, payer: Payer, now = new Date()) {
  const [row] = await db.select().from(appPayers).where(payerRow(payer));
  if (!row?.top_up) {
    return null;
  }
  return {
    enabled: row.top_up_enabled,
    ...row.top_up,
    chargedThisMonthMicros:
      row.top_up_month === now.toISOString().slice(0, 7) ? row.top_up_month_micros : 0,
    offReason: row.top_up_off_reason,
  };
}

/** Saves the payer's auto top-up settings and turns it on, or turns it off. */
export async function setAutoTopUp(db: DbOrTx, payer: Payer, settings: AutoTopUp | null) {
  const set = settings
    ? { top_up: settings, top_up_enabled: true, top_up_off_reason: null }
    : { top_up_enabled: false, top_up_off_reason: null };
  await db
    .insert(appPayers)
    .values({ client_id: payer.clientId, payer_id: payer.payer, ...set })
    .onConflictDoUpdate({ target: [appPayers.client_id, appPayers.payer_id], set });
}

/** Adds an auto top-up's credits once, and ends the wait on its charge. Answers the grant, or null when it was already added. */
export async function grantTopUp(
  db: DbOrTx,
  grant: Payer & {
    buyer: string;
    amountMicros: number;
    paymentIntentId: string;
    lifeDays: number;
    livemode: boolean;
  },
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const added = await grantCredits(
      tx,
      {
        ...grant,
        source: 'bought',
        giverId: grant.buyer,
        stripePaymentIntentId: grant.paymentIntentId,
        expiresAt: boughtUntil(now, grant.lifeDays),
      },
      now,
    );
    await tx.update(appPayers).set({ top_up_started_at: null }).where(payerRow(grant));
    return added;
  });
}

/**
 * A declined auto top-up turns it off with the reason, and gives its amount back to the month. Only
 * the first answer about a charge gives it back, whether that's Stripe's reply or its event. True for that first answer.
 */
export async function topUpFailed(db: DbOrTx, payer: Payer, amountMicros: number, reason: string) {
  const first = await db
    .update(appPayers)
    .set({
      top_up_enabled: false,
      top_up_off_reason: reason,
      top_up_started_at: null,
      top_up_month_micros: sql`greatest(0, ${appPayers.top_up_month_micros} - ${amountMicros})`,
    })
    .where(and(payerRow(payer), isNotNull(appPayers.top_up_started_at)))
    .returning({ id: appPayers.payer_id });
  await db
    .update(appPayers)
    .set({ top_up_enabled: false, top_up_off_reason: reason })
    .where(payerRow(payer));
  return first.length > 0;
}

/** The billing event for credits a person bought, whether at Checkout or by auto top-up. */
export const boughtEvent = (
  grant: {
    client_id: string;
    payer_id: string;
    amount_micros: number;
    giver_id: string | null;
    expires_at: string | null;
  },
  autoTopUp: boolean,
) => ({
  clientId: grant.client_id,
  type: 'credits.bought' as const,
  person: grant.payer_id,
  data: {
    amountMicros: grant.amount_micros,
    buyer: grant.giver_id,
    expiresAt: grant.expires_at ? new Date(grant.expires_at).toISOString() : null,
    autoTopUp,
  },
});

/** The billing event for an auto top-up the card refused. */
export const topUpFailedEvent = (payer: Payer, amountMicros: number, reason: string) => ({
  clientId: payer.clientId,
  type: 'payment.failed' as const,
  person: payer.payer,
  data: { for: 'auto_top_up', amountMicros, reason },
});

/**
 * Charges the buyer's saved card when the payer's balance is under their threshold. The payer's row
 * is locked while the charge is claimed, so two debits at once make one charge.
 */
export async function topUpIfLow(
  env: StripeEnv & { ROUTING: KVNamespace },
  db: Db,
  payer: Payer,
  now = new Date(),
) {
  const [on] = await db
    .select({ enabled: appPayers.top_up_enabled })
    .from(appPayers)
    .where(payerRow(payer));
  if (!on?.enabled) {
    return;
  }
  const livemode = stripeLiveMode(env);
  const claim = await db.transaction(async (tx) => {
    const row = await lockPayer(tx, payer);
    const settings = row.top_up;
    const started = row.top_up_started_at ? Date.parse(row.top_up_started_at) : null;
    if (!row.top_up_enabled || !settings || (started && now.getTime() - started < STALE_MS)) {
      return null;
    }
    const off = async (reason: string) => {
      await tx
        .update(appPayers)
        .set({ top_up_enabled: false, top_up_off_reason: reason })
        .where(payerRow(payer));
      return null;
    };
    const [rules, buyer] = await Promise.all([
      creditPurchase(tx, payer.clientId),
      buyerOf(tx, payer.clientId, settings.buyer, livemode),
    ]);
    if (row.blocked_at) {
      return off('blocked');
    }
    if (!rules) {
      return off('not_sold');
    }
    if (!buyer?.stripe_payment_method_id) {
      return off('no_saved_card');
    }
    const charge = {
      settings,
      lifeDays: rules.lifeDays,
      customerId: buyer.stripe_customer_id,
      paymentMethodId: buyer.stripe_payment_method_id,
      count: row.top_up_count,
    };
    // Decision: A charge whose answer never came back is sent again with the same idempotency key, so Stripe
    // answers the first result instead of charging twice.
    if (started) {
      await tx
        .update(appPayers)
        .set({ top_up_started_at: now.toISOString() })
        .where(payerRow(payer));
      return charge;
    }
    const balance = await creditBalance(tx, payer, now);
    if (!balance || balance.balanceMicros >= settings.thresholdMicros) {
      return null;
    }
    const month = now.toISOString().slice(0, 7);
    const spent = row.top_up_month === month ? row.top_up_month_micros : 0;
    if (spent + settings.amountMicros > settings.monthlyLimitMicros) {
      return off('monthly_limit');
    }
    await tx
      .update(appPayers)
      .set({
        top_up_count: row.top_up_count + 1,
        top_up_started_at: now.toISOString(),
        top_up_month: month,
        top_up_month_micros: spent + settings.amountMicros,
      })
      .where(payerRow(payer));
    return { ...charge, count: row.top_up_count + 1 };
  });
  if (!claim) {
    return;
  }
  const { amountMicros, buyer } = claim.settings;
  const metadata = {
    kind: 'top_up',
    clientId: payer.clientId,
    buyerId: buyer,
    payerId: payer.payer,
    lifeDays: String(claim.lifeDays),
  };
  const result = await chargeSavedCard(env, {
    customerId: claim.customerId,
    paymentMethodId: claim.paymentMethodId,
    amountMicros,
    metadata,
    idempotencyKey: `top-up:${payer.clientId}:${payer.payer}:${claim.count}:${amountMicros}`,
  }).catch((error: unknown) => {
    // Decision: The charge stays claimed, and the next check after ten minutes sends it again with the same key.
    console.error('[credits] auto top-up charge did not answer', { ...payer, error });
    return null;
  });
  if (!result) {
    return;
  }
  if (result.status === 'failed') {
    if (await topUpFailed(db, payer, amountMicros, result.reason)) {
      await queueBillingEvent(db, env, topUpFailedEvent(payer, amountMicros, result.reason), now);
    }
  } else if (result.status === 'succeeded') {
    const added = await grantTopUp(
      db,
      {
        ...payer,
        buyer,
        amountMicros,
        paymentIntentId: result.paymentIntentId,
        lifeDays: claim.lifeDays,
        livemode,
      },
      now,
    );
    if (added) {
      await queueBillingEvent(db, env, boughtEvent(added, true), now);
    }
  }
}
