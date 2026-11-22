import { and, eq, like, ne, or, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from './db.ts';
import type { ApiEnv } from './env.ts';
import { getPlatformSetting, setPlatformSetting } from './platform-settings.ts';
import { appPeople, appUsage, appUsageDaily, oauthClients, projects, users } from './schema.ts';

type Bindings = ApiEnv['Bindings'];

/**
 * What a connected application's person can be charged for. `unit` is how many of the meter one
 * price buys, and `price` is the default in dollars, which an operator can change.
 */
export const METERS = {
  aiNeurons: { unit: 1, price: 0.000011 },
  sandboxSeconds: { unit: 3600, price: 0.1 },
  hostedRequests: { unit: 1e6, price: 0.3 },
  hostedBandwidthBytes: { unit: 1e9, price: 0 },
  hostedAiNeurons: { unit: 1, price: 0.000011 },
  hostedSandboxSeconds: { unit: 3600, price: 0.1 },
  hostedCpuMs: { unit: 1e6, price: 0.02 },
  hostedD1ByteDays: { unit: 30e9, price: 0.75 },
  hostedR2ByteDays: { unit: 30e9, price: 0.015 },
  hostedKvByteDays: { unit: 30e9, price: 0.5 },
} as const;
export type Meter = keyof typeof METERS;
export type MeterPrices = Record<Meter, number>;
export type MeterUse = Record<Meter, number>;
const METER_NAMES = Object.keys(METERS) as Array<Meter>;

export const METER_PRICES_SETTING = 'app-usage:prices';
export const SYNCED_AT_SETTING = 'app-usage:synced-at';

const isPrice = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Reads prices an operator typed in. Null when a meter is unknown or a price isn't a number from 0 up. */
export function parseMeterPrices(value: unknown): Partial<MeterPrices> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value);
  return entries.every(([meter, price]) => Object.hasOwn(METERS, meter) && isPrice(price))
    ? (Object.fromEntries(entries) as Partial<MeterPrices>)
    : null;
}

export async function readMeterPrices(db: DbOrTx): Promise<MeterPrices> {
  const saved = parseMeterPrices(await getPlatformSetting(db, METER_PRICES_SETTING)) ?? {};
  return Object.fromEntries(
    METER_NAMES.map((meter) => [meter, saved[meter] ?? METERS[meter].price]),
  ) as MeterPrices;
}

export async function writeMeterPrices(db: DbOrTx, prices: Partial<MeterPrices>): Promise<void> {
  await setPlatformSetting(db, METER_PRICES_SETTING, prices);
}

/** A meter's cost in millionths of a dollar. */
export function costMicros(meter: Meter, quantity: number, prices: MeterPrices): number {
  return Math.round((quantity / METERS[meter].unit) * prices[meter] * 1e6);
}

export type ClientPlans = Record<string, { stripePriceId: string; creditMicros: number }>;

/** Reads the plans an operator typed in for an application. Null when the shape is wrong. */
export function parseClientPlans(value: unknown): ClientPlans | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const plans: ClientPlans = {};
  for (const [id, plan] of Object.entries(value as Record<string, Record<string, unknown>>)) {
    if (
      !/^[a-z0-9-]{1,64}$/.test(id) ||
      typeof plan?.stripePriceId !== 'string' ||
      !Number.isSafeInteger(plan.creditMicros) ||
      (plan.creditMicros as number) < 0
    ) {
      return null;
    }
    plans[id] = { stripePriceId: plan.stripePriceId, creditMicros: plan.creditMicros as number };
  }
  return plans;
}

/**
 * The plans an application's people can buy. An application without its own list sells the two
 * plans priced in the environment, with no credits, as each application did before.
 */
export async function clientPlans(
  env: Pick<Bindings, 'STRIPE_PRICE_SOLO' | 'STRIPE_PRICE_PRO'>,
  db: DbOrTx,
  clientId: string,
): Promise<ClientPlans> {
  const [client] = await db
    .select({ plans: oauthClients.plans })
    .from(oauthClients)
    .where(eq(oauthClients.id, clientId));
  return (
    client?.plans ?? {
      solo: { stripePriceId: env.STRIPE_PRICE_SOLO ?? '', creditMicros: 0 },
      pro: { stripePriceId: env.STRIPE_PRICE_PRO ?? '', creditMicros: 0 },
    }
  );
}

/** First day of this calendar month in UTC, as `YYYY-MM-01`. */
export const currentPeriod = (now = new Date()) => `${now.toISOString().slice(0, 7)}-01`;
export const dayOf = (date: Date) => date.toISOString().slice(0, 10);

const payerRows = (clientId: string, person: string) =>
  and(eq(appUsageDaily.client_id, clientId), eq(appUsageDaily.person_id, person));
const inPeriod = (period: string) => like(appUsageDaily.day, `${period.slice(0, 7)}-%`);

/**
 * What one payer used this month, by meter: what the application reported for them and what the
 * hosted projects they pay for used.
 */
export async function payerUse(
  db: DbOrTx,
  clientId: string,
  person: string,
  period = currentPeriod(),
): Promise<MeterUse> {
  const [[reported], hosted] = await Promise.all([
    db
      .select()
      .from(appUsage)
      .where(
        and(
          eq(appUsage.client_id, clientId),
          eq(appUsage.person_id, person),
          eq(appUsage.period, period),
        ),
      ),
    db
      .select({ meter: appUsageDaily.meter, quantity: sql<number>`sum(${appUsageDaily.quantity})` })
      .from(appUsageDaily)
      .where(and(payerRows(clientId, person), inPeriod(period), ne(appUsageDaily.project_id, '')))
      .groupBy(appUsageDaily.meter),
  ]);
  const use = Object.fromEntries(METER_NAMES.map((meter) => [meter, 0])) as MeterUse;
  for (const row of hosted) {
    if (Object.hasOwn(use, row.meter)) {
      use[row.meter as Meter] = Number(row.quantity);
    }
  }
  // Decision: app_usage holds the totals for what the application reports, as it did before the daily rows.
  use.aiNeurons = reported?.ai_neurons ?? 0;
  use.sandboxSeconds = reported?.sandbox_seconds ?? 0;
  return use;
}

/** Each meter's quantity and cost, and the credit balance when the plan has one. */
export function creditStanding(use: MeterUse, prices: MeterPrices, includedMicros: number) {
  const meters = METER_NAMES.map((meter) => ({
    meter,
    quantity: use[meter],
    costMicros: costMicros(meter, use[meter], prices),
  }));
  const usedMicros = meters.reduce((sum, meter) => sum + meter.costMicros, 0);
  return {
    meters,
    // Decision: The one place that says how much a payer may spend. Credits bought on top of a plan add here.
    credits:
      includedMicros > 0
        ? {
            includedMicros,
            usedMicros,
            remainingMicros: Math.max(0, includedMicros - usedMicros),
            out: usedMicros >= includedMicros,
          }
        : null,
  };
}

export async function addUse(
  db: DbOrTx,
  row: { clientId: string; person: string; projectId?: string; meter: Meter; quantity: number },
  now = new Date(),
): Promise<void> {
  if (row.quantity <= 0) {
    return;
  }
  await db
    .insert(appUsageDaily)
    .values({
      client_id: row.clientId,
      person_id: row.person,
      project_id: row.projectId ?? '',
      day: dayOf(now),
      meter: row.meter,
      quantity: row.quantity,
    })
    .onConflictDoUpdate({
      target: [
        appUsageDaily.client_id,
        appUsageDaily.person_id,
        appUsageDaily.project_id,
        appUsageDaily.day,
        appUsageDaily.meter,
      ],
      set: { quantity: sql`${appUsageDaily.quantity} + ${row.quantity}` },
    });
}

/** Adds use that Platform counted for a hosted project, under whoever pays for it now. */
export async function addProjectUse(
  db: DbOrTx,
  projectId: string,
  meter: Meter,
  quantity: number,
): Promise<void> {
  if (quantity <= 0) {
    return;
  }
  const [payer] = await db
    .select({ clientId: sql<string>`substr(${users.provider}, 5)`, person: payerOf })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.user_id))
    .where(and(eq(projects.id, projectId), like(users.provider, `${APP}%`)));
  if (payer) {
    await addUse(db, { ...payer, projectId, meter, quantity });
  }
}

/** A payer's use for each day of the month so far, days with none included. */
export async function payerDaily(
  db: DbOrTx,
  clientId: string,
  person: string,
  prices: MeterPrices,
  now = new Date(),
) {
  const rows = await db
    .select({
      day: appUsageDaily.day,
      meter: appUsageDaily.meter,
      quantity: sql<number>`sum(${appUsageDaily.quantity})`,
    })
    .from(appUsageDaily)
    .where(and(payerRows(clientId, person), inPeriod(currentPeriod(now))))
    .groupBy(appUsageDaily.day, appUsageDaily.meter);
  const month = dayOf(now).slice(0, 8);
  return Array.from({ length: now.getUTCDate() }, (_, index) => {
    const day = month + String(index + 1).padStart(2, '0');
    const meters: Partial<MeterUse> = {};
    for (const row of rows) {
      if (row.day === day && Object.hasOwn(METERS, row.meter)) {
        meters[row.meter as Meter] = Number(row.quantity);
      }
    }
    return {
      day,
      costMicros: Object.entries(meters).reduce(
        (sum, [meter, quantity]) => sum + costMicros(meter as Meter, quantity, prices),
        0,
      ),
      meters,
    };
  });
}

/** When the hosted numbers were last read from analytics, or null before the first read. */
export async function hostedAsOf(db: DbOrTx): Promise<string | null> {
  const value = await getPlatformSetting(db, SYNCED_AT_SETTING);
  return typeof value === 'string' ? value : null;
}

export const APP = 'app:';
export const payerOf = sql<string>`coalesce(${projects.payer_person_id}, ${users.provider_id})`;

/** The hosted projects a person pays for, each with the person it was built for. */
export function paidProjects(db: DbOrTx, clientId: string, person: string) {
  return db
    .select({ project: projects, person: users.provider_id })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.user_id))
    .where(
      and(
        eq(users.provider, APP + clientId),
        ne(projects.status, 'deleting'),
        sql`${payerOf} = ${person}`,
      ),
    );
}

/** This month's hosted use of one payer, by project and meter: the month's sum and the latest day's number. */
export async function paidProjectUse(db: DbOrTx, clientId: string, person: string) {
  const rows = await db
    .select({
      projectId: appUsageDaily.project_id,
      meter: appUsageDaily.meter,
      quantity: sql<number>`sum(${appUsageDaily.quantity})`,
      latest: sql<number>`(array_agg(${appUsageDaily.quantity} order by ${appUsageDaily.day} desc))[1]`,
    })
    .from(appUsageDaily)
    .where(
      and(payerRows(clientId, person), inPeriod(currentPeriod()), ne(appUsageDaily.project_id, '')),
    )
    .groupBy(appUsageDaily.project_id, appUsageDaily.meter);
  const byProject = new Map<string, { use: Partial<MeterUse>; latest: Partial<MeterUse> }>();
  for (const row of rows) {
    const project = byProject.get(row.projectId) ?? { use: {}, latest: {} };
    project.use[row.meter as Meter] = Number(row.quantity);
    project.latest[row.meter as Meter] = Number(row.latest);
    byProject.set(row.projectId, project);
  }
  return byProject;
}

/** True while the person who pays for a project is out of credits this month. */
export async function payerOutOfCredits(db: DbOrTx, projectId: string): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.user_id))
    .innerJoin(
      appPeople,
      and(
        sql`${users.provider} = ${APP} || ${appPeople.client_id}`,
        sql`${appPeople.person_id} = ${payerOf}`,
      ),
    )
    .where(and(eq(projects.id, projectId), eq(appPeople.out_of_credits_period, currentPeriod())))
    .limit(1);
  return rows.length > 0;
}

/** The accounts whose projects a person pays for, their own account included. */
export async function paidOwnerIds(db: DbOrTx, clientId: string, person: string) {
  const owners = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .leftJoin(projects, eq(projects.user_id, users.id))
    .where(
      and(
        eq(users.provider, APP + clientId),
        or(eq(users.provider_id, person), eq(projects.payer_person_id, person)),
      ),
    );
  return owners.map((owner) => owner.id);
}

/**
 * Works out whether a payer is out of credits and, when that changed, has the usage counters of
 * the accounts they pay for stamp or lift the AI pause on their hosted projects.
 */
export async function applyCredits(
  env: Pick<Bindings, 'USAGE_COUNTER' | 'STRIPE_PRICE_SOLO' | 'STRIPE_PRICE_PRO'>,
  db: Db,
  clientId: string,
  person: string,
) {
  const period = currentPeriod();
  const [[row], plans, prices, use] = await Promise.all([
    db
      .select()
      .from(appPeople)
      .where(and(eq(appPeople.client_id, clientId), eq(appPeople.person_id, person))),
    clientPlans(env, db, clientId),
    readMeterPrices(db),
    payerUse(db, clientId, person, period),
  ]);
  const standing = creditStanding(use, prices, row ? (plans[row.plan]?.creditMicros ?? 0) : 0);
  const out = standing.credits?.out ? period : null;
  // Decision: Credits belong to a plan a person holds, so a person with no plan row has no balance to run out.
  if (row && row.out_of_credits_period !== out) {
    await db
      .update(appPeople)
      .set({ out_of_credits_period: out })
      .where(and(eq(appPeople.client_id, clientId), eq(appPeople.person_id, person)));
    for (const id of await paidOwnerIds(db, clientId, person)) {
      await env.USAGE_COUNTER.get(env.USAGE_COUNTER.idFromName(id))
        .fetch(
          new Request('https://do/reevaluate-limits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: id }),
          }),
        )
        // Decision: The hourly pass restamps each project's AI pause, so a missed call heals by itself.
        .catch((error: unknown) => {
          console.error('[credits] AI pause update failed', { userId: id, error });
        });
    }
  }
  return { ...standing, row };
}
