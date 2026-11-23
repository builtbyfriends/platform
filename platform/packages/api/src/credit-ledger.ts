import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from './db.ts';
import { generateId } from './id.ts';
import { appCreditGrants, appPayers, type CreditSource, type PayerCap } from './schema.ts';

export type Payer = { clientId: string; payer: string };

/** Locks the payer's row, made if missing, so two charges or grants for one payer run one after the other. */
export async function lockPayer(tx: Tx, { clientId, payer }: Payer) {
  await tx.insert(appPayers).values({ client_id: clientId, payer_id: payer }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(appPayers)
    .where(and(eq(appPayers.client_id, clientId), eq(appPayers.payer_id, payer)))
    .for('update');
  return row!;
}

const payerGrants = ({ clientId, payer }: Payer) =>
  and(eq(appCreditGrants.client_id, clientId), eq(appCreditGrants.payer_id, payer));

const hasGrants = async (db: DbOrTx, payer: Payer) =>
  (
    await db
      .select({ one: sql<number>`1` })
      .from(appCreditGrants)
      .where(payerGrants(payer))
      .limit(1)
  ).length > 0;

/** True when the application marked the payer as a wallet, which has only its balance. */
export async function isWallet(db: DbOrTx, payer: Payer): Promise<boolean> {
  const [row] = await db
    .select({ wallet: appPayers.wallet })
    .from(appPayers)
    .where(and(eq(appPayers.client_id, payer.clientId), eq(appPayers.payer_id, payer.payer)));
  return Boolean(row?.wallet);
}

/** Marks a payer as a wallet. A new wallet starts at zero and out, so its first status sends no event. */
export async function openWallet(db: DbOrTx, payer: Payer, now = new Date()): Promise<void> {
  await db
    .insert(appPayers)
    .values({
      client_id: payer.clientId,
      payer_id: payer.payer,
      wallet: true,
      out_since: now.toISOString(),
    })
    .onConflictDoUpdate({
      target: [appPayers.client_id, appPayers.payer_id],
      set: { wallet: true },
    });
}

const openNow = (now: Date) =>
  and(
    isNull(appCreditGrants.voided_at),
    gt(appCreditGrants.remaining_micros, 0),
    or(isNull(appCreditGrants.expires_at), gt(appCreditGrants.expires_at, now.toISOString())),
  );

const openGrants = (payer: Payer, now: Date) => and(payerGrants(payer), openNow(now));

// Decision: The grant that ends soonest is spent first. A grant with no end date goes last.
const spendOrder = [
  sql`${appCreditGrants.expires_at} asc nulls last`,
  asc(appCreditGrants.created_at),
  asc(appCreditGrants.id),
];

/**
 * Charges use to a payer's grants. What the grants can't cover is kept as owed, and the next
 * grant settles it, so the balance can go below zero. A payer who never had a grant is held to
 * their plan's caps instead, and owes nothing.
 */
export async function spendCredits(
  db: DbOrTx,
  payer: Payer,
  micros: number,
  now = new Date(),
): Promise<void> {
  if (micros <= 0 || !((await hasGrants(db, payer)) || (await isWallet(db, payer)))) {
    return;
  }
  await db.transaction(async (tx) => {
    const row = await lockPayer(tx, payer);
    const grants = await tx
      .select()
      .from(appCreditGrants)
      .where(openGrants(payer, now))
      .orderBy(...spendOrder)
      .for('update');
    let left = micros;
    for (const grant of grants) {
      if (left === 0) {
        break;
      }
      const take = Math.min(left, grant.remaining_micros);
      left -= take;
      await tx
        .update(appCreditGrants)
        .set({ remaining_micros: grant.remaining_micros - take })
        .where(eq(appCreditGrants.id, grant.id));
    }
    if (left > 0) {
      await tx
        .update(appPayers)
        .set({ owed_micros: row.owed_micros + left })
        .where(and(eq(appPayers.client_id, payer.clientId), eq(appPayers.payer_id, payer.payer)));
    }
  });
}

export type NewGrant = Payer & {
  source: CreditSource;
  amountMicros: number;
  livemode: boolean;
  giverId?: string | null;
  billingCountry?: string | null;
  billingState?: string | null;
  note?: string | null;
  stripeInvoiceId?: string | null;
  stripePaymentIntentId?: string | null;
  startsAt?: Date;
  expiresAt?: Date | null;
};

/**
 * Adds a grant, which first settles what the payer owes. A grant for a Stripe invoice or payment
 * that already has one is skipped, and the answer is null.
 */
export async function grantCredits(db: DbOrTx, grant: NewGrant, now = new Date()) {
  return db.transaction(async (tx) => {
    const row = await lockPayer(tx, grant);
    const settled = Math.min(row.owed_micros, grant.amountMicros);
    const [added] = await tx
      .insert(appCreditGrants)
      .values({
        id: generateId('grant'),
        client_id: grant.clientId,
        payer_id: grant.payer,
        source: grant.source,
        amount_micros: grant.amountMicros,
        remaining_micros: grant.amountMicros - settled,
        giver_id: grant.giverId ?? null,
        billing_country: grant.billingCountry ?? null,
        billing_state: grant.billingState ?? null,
        note: grant.note ?? null,
        stripe_invoice_id: grant.stripeInvoiceId ?? null,
        stripe_payment_intent_id: grant.stripePaymentIntentId ?? null,
        livemode: grant.livemode,
        starts_at: (grant.startsAt ?? now).toISOString(),
        expires_at: grant.expiresAt?.toISOString() ?? null,
        created_at: now.toISOString(),
      })
      .onConflictDoNothing()
      .returning();
    if (added && settled > 0) {
      await tx
        .update(appPayers)
        .set({ owed_micros: row.owed_micros - settled })
        .where(and(eq(appPayers.client_id, grant.clientId), eq(appPayers.payer_id, grant.payer)));
    }
    return added ?? null;
  });
}

const iso = (value: string | null) => (value ? new Date(value).toISOString() : null);

/**
 * A payer's balance: what's left on grants that haven't ended, less what they owe. Null for a
 * payer who has never had a grant, whose plan's caps decide instead. A wallet always has a balance.
 */
export async function creditBalance(db: DbOrTx, payer: Payer, now = new Date()) {
  const [[row], grants, any] = await Promise.all([
    db
      .select()
      .from(appPayers)
      .where(and(eq(appPayers.client_id, payer.clientId), eq(appPayers.payer_id, payer.payer))),
    db
      .select()
      .from(appCreditGrants)
      .where(openGrants(payer, now))
      .orderBy(...spendOrder),
    hasGrants(db, payer),
  ]);
  const owedMicros = row?.owed_micros ?? 0;
  if (!any && owedMicros === 0 && !row?.wallet) {
    return null;
  }
  return {
    wallet: Boolean(row?.wallet),
    balanceMicros: grants.reduce((sum, grant) => sum + grant.remaining_micros, 0) - owedMicros,
    owedMicros,
    outSince: iso(row?.out_since ?? null),
    lowSince: iso(row?.low_since ?? null),
    grants: grants.map((grant) => ({
      id: grant.id,
      source: grant.source,
      amountMicros: grant.amount_micros,
      remainingMicros: grant.remaining_micros,
      startsAt: iso(grant.starts_at),
      expiresAt: iso(grant.expires_at),
    })),
  };
}

/**
 * Several payers' balances in two queries, for picking who pays. Null for a payer on their plan's
 * caps, as creditBalance answers.
 */
export async function balancesOf(
  db: DbOrTx,
  clientId: string,
  payers: ReadonlyArray<string>,
  now = new Date(),
) {
  const [rows, sums] = await Promise.all([
    db
      .select()
      .from(appPayers)
      .where(and(eq(appPayers.client_id, clientId), inArray(appPayers.payer_id, [...payers]))),
    db
      .select({
        payer: appCreditGrants.payer_id,
        open: sql<string>`coalesce(sum(${appCreditGrants.remaining_micros}) filter (where ${openNow(now)}), 0)`,
      })
      .from(appCreditGrants)
      .where(
        and(
          eq(appCreditGrants.client_id, clientId),
          inArray(appCreditGrants.payer_id, [...payers]),
        ),
      )
      .groupBy(appCreditGrants.payer_id),
  ]);
  return new Map(
    payers.map((payer) => {
      const row = rows.find((entry) => entry.payer_id === payer);
      const sum = sums.find((entry) => entry.payer === payer);
      const owed = row?.owed_micros ?? 0;
      return [
        payer,
        {
          balanceMicros: sum || owed > 0 || row?.wallet ? Number(sum?.open ?? 0) - owed : null,
          blocked: Boolean(row?.blocked_at),
        },
      ] as const;
    }),
  );
}

/** Records when a payer's balance reached zero, or clears it. True when that changed. */
export const markOut = (db: DbOrTx, payer: Payer, out: boolean, now = new Date()) =>
  markSince(db, payer, 'out_since', out, now);

/** Records when a payer's balance went under the application's low mark, or clears it. True when that changed. */
export const markLow = (db: DbOrTx, payer: Payer, low: boolean, now = new Date()) =>
  markSince(db, payer, 'low_since', low, now);

async function markSince(
  db: DbOrTx,
  payer: Payer,
  field: 'out_since' | 'low_since',
  on: boolean,
  now: Date,
) {
  const column = appPayers[field];
  const changed = await db
    .insert(appPayers)
    .values({
      client_id: payer.clientId,
      payer_id: payer.payer,
      [field]: on ? now.toISOString() : null,
    })
    .onConflictDoUpdate({
      target: [appPayers.client_id, appPayers.payer_id],
      set: { [field]: on ? sql`coalesce(${column}, ${now.toISOString()})` : null },
      setWhere: on ? isNull(column) : sql`${column} is not null`,
    })
    .returning({ id: appPayers.payer_id });
  return changed.length > 0;
}

/** Records which of their plan's monthly caps a payer's hosted apps passed. True when that changed. */
export async function markOverCaps(
  db: DbOrTx,
  payer: Payer,
  caps: ReadonlyArray<PayerCap>,
): Promise<boolean> {
  const where = and(eq(appPayers.client_id, payer.clientId), eq(appPayers.payer_id, payer.payer));
  const [row] = await db.select({ caps: appPayers.over_caps }).from(appPayers).where(where);
  if ((row?.caps ?? []).join() === caps.join()) {
    return false;
  }
  await db
    .insert(appPayers)
    .values({ client_id: payer.clientId, payer_id: payer.payer, over_caps: [...caps] })
    .onConflictDoUpdate({
      target: [appPayers.client_id, appPayers.payer_id],
      set: { over_caps: [...caps] },
    });
  return true;
}

async function grantByPayment(tx: Tx, paymentIntentId: string) {
  const [grant] = await tx
    .select()
    .from(appCreditGrants)
    .where(eq(appCreditGrants.stripe_payment_intent_id, paymentIntentId))
    .for('update');
  return grant;
}

/**
 * Takes back the refunded share of a grant from what's left of it. Stripe sends the running total
 * refunded, so a second partial refund or a resent event works from the total and takes no more.
 */
export async function refundGrant(
  tx: Tx,
  paymentIntentId: string,
  refunded: { amount: number; charged: number },
): Promise<Payer | null> {
  const grant = await grantByPayment(tx, paymentIntentId);
  if (!grant || grant.voided_at || refunded.charged <= 0) {
    return null;
  }
  const share = Math.floor((grant.amount_micros * refunded.amount) / refunded.charged);
  const taken = Math.min(share, grant.taken_micros + grant.remaining_micros);
  if (taken <= grant.taken_micros) {
    return null;
  }
  await tx
    .update(appCreditGrants)
    .set({
      remaining_micros: grant.remaining_micros - (taken - grant.taken_micros),
      taken_micros: taken,
    })
    .where(eq(appCreditGrants.id, grant.id));
  return { clientId: grant.client_id, payer: grant.payer_id };
}

/**
 * A card dispute takes back the whole grant. What was already spent becomes owed by the payer, so the
 * balance can go below zero. The buyer who paid is blocked from buying until an operator clears it,
 * and `buyer` in the answer names them.
 */
export async function disputeGrant(
  tx: Tx,
  paymentIntentId: string,
  now = new Date(),
): Promise<(Payer & { buyer: string }) | null> {
  const grant = await grantByPayment(tx, paymentIntentId);
  if (!grant || grant.voided_at) {
    return null;
  }
  const payer = { clientId: grant.client_id, payer: grant.payer_id };
  const row = await lockPayer(tx, payer);
  const spent = grant.amount_micros - grant.taken_micros - grant.remaining_micros;
  await tx
    .update(appCreditGrants)
    .set({
      remaining_micros: 0,
      voided_at: now.toISOString(),
      void_reason: 'dispute',
      voided_remaining_micros: grant.remaining_micros,
      voided_owed_micros: spent,
    })
    .where(eq(appCreditGrants.id, grant.id));
  await tx
    .update(appPayers)
    .set({ owed_micros: row.owed_micros + spent })
    .where(and(eq(appPayers.client_id, payer.clientId), eq(appPayers.payer_id, payer.payer)));
  const buyer = grant.giver_id ?? grant.payer_id;
  await blockPayer(tx, { clientId: grant.client_id, payer: buyer }, now);
  return { ...payer, buyer };
}

async function blockPayer(tx: Tx, payer: Payer, now: Date) {
  const row = await lockPayer(tx, payer);
  await tx
    .update(appPayers)
    .set({
      blocked_at: row.blocked_at ?? now.toISOString(),
      blocked_reason: row.blocked_reason ?? 'dispute',
    })
    .where(and(eq(appPayers.client_id, payer.clientId), eq(appPayers.payer_id, payer.payer)));
}

/**
 * A won dispute gives back exactly what the dispute took, with the grant's old end date. Owed
 * that a later grant already settled comes back on this grant instead. The block stays for an
 * operator to clear.
 */
export async function restoreDisputedGrant(tx: Tx, paymentIntentId: string): Promise<Payer | null> {
  const grant = await grantByPayment(tx, paymentIntentId);
  if (!grant || grant.void_reason !== 'dispute') {
    return null;
  }
  const payer = { clientId: grant.client_id, payer: grant.payer_id };
  const row = await lockPayer(tx, payer);
  const fromOwed = Math.min(row.owed_micros, grant.voided_owed_micros);
  await tx
    .update(appCreditGrants)
    .set({
      remaining_micros: grant.voided_remaining_micros + grant.voided_owed_micros - fromOwed,
      voided_at: null,
      void_reason: null,
      voided_remaining_micros: 0,
      voided_owed_micros: 0,
    })
    .where(eq(appCreditGrants.id, grant.id));
  await tx
    .update(appPayers)
    .set({ owed_micros: row.owed_micros - fromOwed })
    .where(and(eq(appPayers.client_id, payer.clientId), eq(appPayers.payer_id, payer.payer)));
  return payer;
}

/** True when a dispute has blocked the payer from buying. */
export async function payerBlocked(db: DbOrTx, payer: Payer): Promise<boolean> {
  const [row] = await db
    .select({ blocked: appPayers.blocked_at })
    .from(appPayers)
    .where(and(eq(appPayers.client_id, payer.clientId), eq(appPayers.payer_id, payer.payer)));
  return Boolean(row?.blocked);
}

/**
 * Ends a deleted person's grants and keeps them for the books under a new id that names no one, with
 * what they owed. A dispute block stays on the person's id, so a new account with that id still
 * can't buy. Safe to repeat.
 */
export async function forgetPayer(db: DbOrTx, payer: Payer, now = new Date()): Promise<void> {
  const gone = generateId('deleted');
  const same = and(eq(appPayers.client_id, payer.clientId), eq(appPayers.payer_id, payer.payer));
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(appPayers).where(same).for('update');
    await tx
      .update(appCreditGrants)
      .set({
        voided_at: now.toISOString(),
        void_reason: 'account_deleted',
        voided_remaining_micros: sql`${appCreditGrants.remaining_micros}`,
        remaining_micros: 0,
      })
      .where(and(payerGrants(payer), isNull(appCreditGrants.voided_at)));
    await tx.update(appCreditGrants).set({ payer_id: gone }).where(payerGrants(payer));
    if (!row) {
      return;
    }
    if (row.owed_micros > 0) {
      await tx
        .insert(appPayers)
        .values({ client_id: payer.clientId, payer_id: gone, owed_micros: row.owed_micros });
    }
    await (row.blocked_at
      ? tx
          .update(appPayers)
          .set({
            owed_micros: 0,
            out_since: null,
            low_since: null,
            top_up: null,
            top_up_enabled: false,
            over_caps: [],
          })
          .where(same)
      : tx.delete(appPayers).where(same));
  });
}
