import { and, eq, inArray, like, ne, sql } from 'drizzle-orm';
import { APP, applyCredits, dayOf, payerOf, SYNCED_AT_SETTING } from './app-credits.ts';
import type { Db } from './db.ts';
import type { ApiEnv } from './env.ts';
import { setPlatformSetting } from './platform-settings.ts';
import { getProjectsUsageBetween, UsageUnavailableError } from './routes/usage.ts';
import { appUsageDaily, projects, users } from './schema.ts';

type Bindings = ApiEnv['Bindings'];

const SYNCED = ['hostedRequests', 'hostedBandwidthBytes', 'hostedAiNeurons'] as const;

/**
 * Reads what hosted projects of connected applications used today and yesterday and stores it
 * under each project's payer, then settles each payer's credits.
 * Decision: One pass reads every such project. Split it by payer across runs when one pass no longer fits an
 * invocation.
 */
export async function syncHostedUse(env: Bindings, db: Db, now = new Date()): Promise<void> {
  const rows = await db
    .select({
      project: projects,
      clientId: sql<string>`substr(${users.provider}, 5)`,
      person: payerOf,
    })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.user_id))
    .where(and(like(users.provider, `${APP}%`), ne(projects.status, 'deleting')));
  if (rows.length === 0) {
    return;
  }
  const today = new Date(`${dayOf(now)}T00:00:00.000Z`);
  for (const start of [new Date(today.getTime() - 86_400_000), today]) {
    const end = new Date(Math.min(start.getTime() + 86_400_000, now.getTime()));
    let usage;
    try {
      usage = await getProjectsUsageBetween(
        env,
        rows.map((row) => row.project),
        start,
        end,
      );
    } catch (error) {
      if (error instanceof UsageUnavailableError) {
        console.error('[credits] hosted use could not be read', { day: dayOf(start) });
        return;
      }
      throw error;
    }
    const read = new Map(usage.projects.map((project) => [project.projectId, project]));
    const values = rows.flatMap((row) => {
      const project = read.get(row.project.id);
      const quantities = {
        hostedRequests: project?.requests ?? 0,
        hostedBandwidthBytes: project?.bandwidthBytes ?? 0,
        hostedAiNeurons: project?.aiNeurons ?? 0,
      };
      return SYNCED.filter((meter) => quantities[meter] > 0).map((meter) => ({
        client_id: row.clientId,
        person_id: row.person,
        project_id: row.project.id,
        day: dayOf(start),
        meter,
        quantity: quantities[meter],
      }));
    });
    // Decision: A day belongs to whoever pays for the project when the day is last read, so replace, don't add.
    await db.transaction(async (tx) => {
      await tx.delete(appUsageDaily).where(
        and(
          inArray(
            appUsageDaily.project_id,
            rows.map((row) => row.project.id),
          ),
          eq(appUsageDaily.day, dayOf(start)),
          inArray(appUsageDaily.meter, [...SYNCED]),
        ),
      );
      if (values.length > 0) {
        await tx.insert(appUsageDaily).values(values);
      }
    });
  }
  await setPlatformSetting(db, SYNCED_AT_SETTING, now.toISOString());
  const payers = new Map(rows.map((row) => [`${row.clientId}\n${row.person}`, row]));
  for (const payer of payers.values()) {
    await applyCredits(env, db, payer.clientId, payer.person);
  }
}
