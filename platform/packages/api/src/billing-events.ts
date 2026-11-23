import { and, eq, isNull, lt, lte, sql } from 'drizzle-orm';
import { hmacHex } from './billing/stripe.ts';
import type { Db, DbOrTx } from './db.ts';
import { armFastMaintenance } from './fast-maintenance.ts';
import { generateId } from './id.ts';
import { appBillingEvents, oauthClients } from './schema.ts';

export type BillingEventType =
  | 'credits.low'
  | 'credits.out'
  | 'credits.restored'
  | 'credits.bought'
  | 'payment.failed'
  | 'subscription.started'
  | 'subscription.ended';

const MINUTE_MS = 60_000;
const MAX_ATTEMPTS = 12;
const FAST_ATTEMPTS = 4;
const BATCH = 50;
const KEEP_SENT_MS = 30 * 24 * 60 * MINUTE_MS;

/** A new random secret for signing an application's billing events. */
export function newEventsSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return 'whsec_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Saves a billing event for the application to receive, when it has an address for them. \`person\` is the
 * application's own id for the payer. Nothing that names a person, such as an email address, goes in the body.
 */
export async function queueBillingEvent(
  db: DbOrTx,
  env: { ROUTING: KVNamespace },
  event: { clientId: string; type: BillingEventType; person: string; data: object },
  now = new Date(),
): Promise<void> {
  const [client] = await db
    .select({ url: oauthClients.events_url })
    .from(oauthClients)
    .where(eq(oauthClients.id, event.clientId));
  if (!client?.url) {
    return;
  }
  const id = generateId('evt');
  await db.insert(appBillingEvents).values({
    id,
    client_id: event.clientId,
    type: event.type,
    body: JSON.stringify({
      id,
      type: event.type,
      person: event.person,
      occurredAt: now.toISOString(),
      data: event.data,
    }),
    next_attempt_at: now.toISOString(),
  });
  await armFastMaintenance(env);
}

/**
 * Sends the billing events that are due, each signed with its application's secret. A failed delivery waits
 * longer after each try, up to six hours, and stops after twelve tries; the status call has the same facts.
 * Answers true while an event is waiting on one of its first few tries, so the two-minute tier keeps going.
 */
export async function deliverBillingEvents(
  db: Db,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const due = await db
    .select({
      id: appBillingEvents.id,
      body: appBillingEvents.body,
      attempts: appBillingEvents.attempts,
      url: oauthClients.events_url,
      secret: oauthClients.events_secret,
    })
    .from(appBillingEvents)
    .innerJoin(oauthClients, eq(oauthClients.id, appBillingEvents.client_id))
    .where(
      and(
        isNull(appBillingEvents.sent_at),
        isNull(appBillingEvents.gave_up_at),
        lte(appBillingEvents.next_attempt_at, now.toISOString()),
      ),
    )
    .orderBy(appBillingEvents.next_attempt_at)
    .limit(BATCH);
  for (const event of due) {
    const sent = event.url && event.secret ? await send(event, fetcher, now) : false;
    const attempts = event.attempts + 1;
    await db
      .update(appBillingEvents)
      .set(
        sent
          ? { sent_at: now.toISOString(), attempts }
          : attempts >= MAX_ATTEMPTS || !event.url
            ? { gave_up_at: now.toISOString(), attempts }
            : {
                attempts,
                next_attempt_at: new Date(
                  now.getTime() + Math.min(2 ** attempts, 360) * MINUTE_MS,
                ).toISOString(),
              },
      )
      .where(eq(appBillingEvents.id, event.id));
  }
  await db
    .delete(appBillingEvents)
    .where(lt(appBillingEvents.sent_at, new Date(now.getTime() - KEEP_SENT_MS).toISOString()));
  const [waiting] = await db
    .select({ count: sql<number>`count(*)` })
    .from(appBillingEvents)
    .where(
      and(
        isNull(appBillingEvents.sent_at),
        isNull(appBillingEvents.gave_up_at),
        lt(appBillingEvents.attempts, FAST_ATTEMPTS),
      ),
    );
  return Number(waiting?.count ?? 0) > 0;
}

async function send(
  event: { id: string; body: string; url: string | null; secret: string | null },
  fetcher: typeof fetch,
  now: Date,
): Promise<boolean> {
  const timestamp = Math.floor(now.getTime() / 1000);
  const signature = await hmacHex(event.secret!, `${timestamp}.${event.body}`);
  try {
    const response = await fetcher(event.url!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'billing-event-id': event.id,
        'billing-signature': `t=${timestamp},v1=${signature}`,
      },
      body: event.body,
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch (error) {
    console.warn('[billing-events] delivery failed', { id: event.id, error });
    return false;
  }
}
