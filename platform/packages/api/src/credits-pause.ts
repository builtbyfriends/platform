import { and, eq, isNull } from 'drizzle-orm';
import { paidProjects } from './app-credits.ts';
import type { Db, DbOrTx } from './db.ts';
import { getPlatformSetting, setPlatformSetting } from './platform-settings.ts';
import { setProjectsRoutingSuspension } from './routing.ts';
import { projects } from './schema.ts';
import {
  CREDITS_REASONS,
  REASON_CREDITS_GRACE,
  REASON_CREDITS_PAUSED,
  REASON_REQUESTS_EXCEEDED,
  projectSuspensionKey,
} from './suspension.ts';

export const GRACE_DAYS_SETTING = 'credits:grace-days';
export const DEFAULT_GRACE_DAYS = 3;
const DAY_MS = 86_400_000;

export const isGraceDays = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 365;

/** How many days a payer's hosted apps keep answering, at the lower rate, after the balance reaches zero. */
export async function readGraceDays(db: DbOrTx): Promise<number> {
  const value = await getPlatformSetting(db, GRACE_DAYS_SETTING);
  return isGraceDays(value) ? value : DEFAULT_GRACE_DAYS;
}

export async function writeGraceDays(db: DbOrTx, days: number): Promise<void> {
  await setPlatformSetting(db, GRACE_DAYS_SETTING, days);
}

/** The credits reason for a payer at zero since `outSince`, or null when the payer isn't at zero. */
export function creditsReason(outSince: string | null, graceDays: number, now = new Date()) {
  if (outSince === null) {
    return null;
  }
  return now.getTime() - Date.parse(outSince) >= graceDays * DAY_MS
    ? REASON_CREDITS_PAUSED
    : REASON_CREDITS_GRACE;
}

export type CreditsPauseChange = Readonly<{
  projectId: string;
  from: string | null;
  to: string | null;
}>;

/**
 * Brings each hosted project a payer pays for to `reason`: null lifts a credits pause, the grace
 * reason slows requests down, and the paused reason stops requests, cron jobs and queues. A
 * project an operator suspended is left alone, so a credits restore can't lift a takedown.
 * Returns the projects that changed. This is where a pause starts and lifts, so an
 * out-of-credits event to the connected app belongs on the result.
 */
export async function setCreditsPause(
  env: { ROUTING: KVNamespace },
  db: Db,
  clientId: string,
  person: string,
  reason: string | null,
  now = new Date(),
): Promise<Array<CreditsPauseChange>> {
  const changes: Array<CreditsPauseChange> = [];
  for (const { project } of await paidProjects(db, clientId, person)) {
    const from = project.suspended_reason;
    if (from === reason || (from !== null && !CREDITS_REASONS.includes(from))) {
      continue;
    }
    const row = (values: Partial<typeof projects.$inferInsert>, expected: string | null) =>
      db
        .update(projects)
        .set(values)
        .where(
          and(
            eq(projects.id, project.id),
            expected === null
              ? isNull(projects.suspended_reason)
              : eq(projects.suspended_reason, expected),
          ),
        )
        .returning();
    const [changed] = await row(
      { suspended_reason: reason, suspended_at: reason ? now.toISOString() : null },
      from,
    );
    if (!changed) {
      continue;
    }
    try {
      if (reason) {
        await setProjectsRoutingSuspension(env.ROUTING, db, [changed], {
          op: 'suspend',
          reason,
          force: false,
          over: [...CREDITS_REASONS, REASON_REQUESTS_EXCEEDED],
        });
      } else {
        for (const matchReason of CREDITS_REASONS) {
          await setProjectsRoutingSuspension(env.ROUTING, db, [changed], {
            op: 'unsuspend',
            matchReason,
          });
        }
      }
      const markerKey = projectSuspensionKey(project.id);
      const marker = await env.ROUTING.get(markerKey);
      if (reason === REASON_CREDITS_PAUSED) {
        if (marker === null || CREDITS_REASONS.includes(marker)) {
          await env.ROUTING.put(markerKey, reason);
        }
      } else if (marker === REASON_CREDITS_PAUSED) {
        await env.ROUTING.delete(markerKey);
      }
    } catch (error) {
      // Decision: Put the row back so the next pass sees the difference and stamps the edge again.
      console.error('[credits] pause update failed', { projectId: project.id, reason, error });
      await row({ suspended_reason: from, suspended_at: project.suspended_at }, reason);
      continue;
    }
    changes.push({ projectId: project.id, from, to: reason });
  }
  return changes;
}
