import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from './db.ts';
import { generateId } from './id.ts';
import { appCreditGrants, appPayers, type CreditSource } from './schema.ts';

type Payer = { clientId: string; payer: string };

/** Locks the payer's row, made if missing, so two charges or grants for one payer run one after the other. */
async function lockPayer(tx: Tx, { clientId, payer }: Payer) {
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

const openGrants = (payer: Payer, now: Date) =>
  and(
    payerGrants(payer),
    isNull(appCreditGrants.voided_at),
    gt(appCreditGrants.remaining_micros, 0),
    or(isNull(appCreditGrants.expires_at), gt(appCreditGrants.expires_at, now.toISOString())),
  );

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
  if (micros <= 0 || !(await hasGrants(db, payer))) {
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

/**
 * A payer's balance: what's left on grants that haven't ended, less what they owe. Null for a
 * payer who has never had a grant, whose plan's caps decide instead.
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
  if (!any && owedMicros === 0) {
    return null;
  }
  return {
    balanceMicros: grants.reduce((sum, grant) => sum + grant.remaining_micros, 0) - owedMicros,
    owedMicros,
    outSince: row?.out_since ?? null,
    grants: grants.map((grant) => ({
      id: grant.id,
      source: grant.source,
      amountMicros: grant.amount_micros,
      remainingMicros: grant.remaining_micros,
      startsAt: grant.starts_at,
      expiresAt: grant.expires_at,
    })),
  };
}

/** Records when a payer's balance reached zero, or clears it. True when that changed. */
export async function markOut(db: DbOrTx, payer: Payer, out: boolean, now = new Date()) {
  const changed = await db
    .insert(appPayers)
    .values({
      client_id: payer.clientId,
      payer_id: payer.payer,
      out_since: out ? now.toISOString() : null,
    })
    .onConflictDoUpdate({
      target: [appPayers.client_id, appPayers.payer_id],
      set: { out_since: out ? sql`coalesce(${appPayers.out_since}, ${now.toISOString()})` : null },
      setWhere: out ? isNull(appPayers.out_since) : sql`${appPayers.out_since} is not null`,
    })
    .returning({ id: appPayers.payer_id });
  return changed.length > 0;
}
