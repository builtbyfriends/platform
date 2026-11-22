import { and, eq, inArray, like, ne, sql } from 'drizzle-orm';
import {
  APP,
  applyCredits,
  dayOf,
  dropTestPlans,
  payerOf,
  SYNCED_AT_SETTING,
  type Meter,
} from './app-credits.ts';
import { stripeLiveMode } from './billing/stripe.ts';
import type { Db } from './db.ts';
import { isDevBypass, type ApiEnv } from './env.ts';
import { setPlatformSetting } from './platform-settings.ts';
import { getProjectsUsageBetween, queryAnalyticsEngine } from './routes/usage.ts';
import { appUsageDaily, projects, resources, users } from './schema.ts';

type Bindings = ApiEnv['Bindings'];
type Reading = Partial<Record<Meter, number>>;
type Hosted = { id: string; slug: string };

const DAY_MS = 86_400_000;
const analyticsTime = (date: Date) => date.toISOString().replace('T', ' ').slice(0, 19);

/** Requests, bandwidth and AI for each project, from the records the usage page already reads. */
async function readTraffic(env: Bindings, hosted: Array<Hosted>, start: Date, end: Date) {
  const usage = await getProjectsUsageBetween(env, hosted as never, start, end);
  return new Map<string, Reading>(
    usage.projects.map((project) => [
      project.projectId,
      {
        hostedRequests: project.requests,
        hostedBandwidthBytes: project.bandwidthBytes,
        hostedAiNeurons: project.aiNeurons,
      },
    ]),
  );
}

/** CPU time for each project, added up from the number the tail Worker writes for each invocation. */
async function readCpu(env: Bindings, hosted: Array<Hosted>, start: Date, end: Date) {
  const bySlug = new Map(hosted.map((project) => [`user-${project.slug}`, project.id]));
  const read = new Map<string, Reading>();
  const keys = [...bySlug.keys()];
  for (let offset = 0; offset < keys.length; offset += 200) {
    const response = await queryAnalyticsEngine(
      env.CF_ACCOUNT_ID,
      env.CF_API_TOKEN,
      `SELECT index1, SUM(_sample_interval * double3) AS cpu_ms
      FROM ${env.LOGS_DATASET ?? 'platform_logs'}
      WHERE index1 IN (${keys
        .slice(offset, offset + 200)
        .map((key) => `'${key}'`)
        .join(', ')})
        AND timestamp >= toDateTime('${analyticsTime(start)}')
        AND timestamp < toDateTime('${analyticsTime(end)}')
      GROUP BY index1`,
    );
    if (!response.ok) {
      throw new Error(`CPU time query failed with HTTP ${response.status}`);
    }
    const { data } = (await response.json()) as {
      data?: Array<{ index1: string; cpu_ms: number }>;
    };
    for (const row of data ?? []) {
      const projectId = bySlug.get(row.index1);
      if (projectId) {
        read.set(projectId, { hostedCpuMs: Math.round(Number(row.cpu_ms) || 0) });
      }
    }
  }
  return read;
}

const STORAGE = {
  d1: {
    meter: 'hostedD1ByteDays',
    dataset: 'd1StorageAdaptiveGroups',
    id: 'databaseId',
    fields: ['databaseSizeBytes'],
    day: (day: string) => `date_geq: "${day}", date_leq: "${day}"`,
  },
  kv: {
    meter: 'hostedKvByteDays',
    dataset: 'kvStorageAdaptiveGroups',
    id: 'namespaceId',
    fields: ['byteCount'],
    day: (day: string) => `date_geq: "${day}", date_leq: "${day}"`,
  },
  r2: {
    meter: 'hostedR2ByteDays',
    dataset: 'r2StorageAdaptiveGroups',
    id: 'bucketName',
    fields: ['payloadSize', 'metadataSize'],
    day: (day: string) => `datetime_geq: "${day}T00:00:00Z", datetime_leq: "${day}T23:59:59Z"`,
  },
} as const;
type StorageType = keyof typeof STORAGE;

/** The largest size each of a project's databases, buckets and namespaces of one kind had that day. */
async function readStorage(
  env: Bindings,
  type: StorageType,
  owned: Map<string, string>,
  day: string,
) {
  const { meter, dataset, id, fields, day: filter } = STORAGE[type];
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query {
  viewer {
    accounts(filter: { accountTag: "${env.CF_ACCOUNT_ID}" }) {
      storage: ${dataset}(limit: 10000, filter: { ${filter(day)} }) {
        max { ${fields.join(' ')} }
        dimensions { ${id} }
      }
    }
  }
}`,
    }),
  });
  const body = (await response.json().catch(() => null)) as {
    errors?: Array<unknown> | null;
    data?: {
      viewer?: {
        accounts?: Array<{
          storage?: Array<{ max?: Record<string, number>; dimensions?: Record<string, string> }>;
        }>;
      };
    };
  } | null;
  const groups = body?.data?.viewer?.accounts?.[0]?.storage;
  if (!response.ok || body?.errors?.length || !Array.isArray(groups)) {
    throw new Error(`${dataset} query failed with HTTP ${response.status}`);
  }
  const read = new Map<string, Reading>();
  for (const group of groups) {
    const projectId = owned.get(group.dimensions?.[id] ?? '');
    if (projectId) {
      const bytes = fields.reduce((sum, field) => sum + (Number(group.max?.[field]) || 0), 0);
      read.set(projectId, { [meter]: (read.get(projectId)?.[meter] ?? 0) + bytes });
    }
  }
  return read;
}

/**
 * Reads what hosted projects of connected applications used today and yesterday and stores it
 * under each project's payer, then settles each payer's credits. Each kind of number is read on
 * its own, so one that can't be read keeps what was stored before.
 * Decision: One pass reads every such project. Split it by payer across runs when one pass no longer fits an
 * invocation.
 */
export async function syncHostedUse(env: Bindings, db: Db, now = new Date()): Promise<void> {
  if (stripeLiveMode(env)) {
    await dropTestPlans(db);
  }
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
  const hosted = rows.map((row) => row.project);
  const ids = hosted.map((project) => project.id);
  const stored = isDevBypass(env)
    ? []
    : await db
        .select()
        .from(resources)
        .where(
          and(inArray(resources.project_id, ids), inArray(resources.type, ['d1', 'kv', 'r2'])),
        );
  const owned = (type: StorageType) =>
    new Map(stored.filter((row) => row.type === type).map((row) => [row.cf_id, row.project_id]));
  const today = new Date(`${dayOf(now)}T00:00:00.000Z`);
  let trafficRead = false;
  for (const start of [new Date(today.getTime() - DAY_MS), today]) {
    const end = new Date(Math.min(start.getTime() + DAY_MS, now.getTime()));
    const day = dayOf(start);
    const readers: Array<[ReadonlyArray<Meter>, () => Promise<Map<string, Reading>>]> = [
      [
        ['hostedRequests', 'hostedBandwidthBytes', 'hostedAiNeurons'],
        () => readTraffic(env, hosted, start, end),
      ],
      ...(isDevBypass(env)
        ? []
        : ([
            [['hostedCpuMs'], () => readCpu(env, hosted, start, end)],
            ...(Object.keys(STORAGE) as Array<StorageType>).map(
              (type) =>
                [[STORAGE[type].meter], () => readStorage(env, type, owned(type), day)] as [
                  ReadonlyArray<Meter>,
                  () => Promise<Map<string, Reading>>,
                ],
            ),
          ] as Array<[ReadonlyArray<Meter>, () => Promise<Map<string, Reading>>]>)),
    ];
    for (const [meters, reader] of readers) {
      let read: Map<string, Reading>;
      try {
        read = await reader();
      } catch (error) {
        console.error('[credits] hosted use could not be read', { day, meters, error });
        continue;
      }
      trafficRead ||= meters[0] === 'hostedRequests';
      const values = rows.flatMap((row) =>
        meters
          .filter((meter) => (read.get(row.project.id)?.[meter] ?? 0) > 0)
          .map((meter) => ({
            client_id: row.clientId,
            person_id: row.person,
            project_id: row.project.id,
            day,
            meter,
            quantity: read.get(row.project.id)![meter]!,
          })),
      );
      // Decision: A day belongs to whoever pays for the project when the day is last read, so replace, don't add.
      await db.transaction(async (tx) => {
        await tx
          .delete(appUsageDaily)
          .where(
            and(
              inArray(appUsageDaily.project_id, ids),
              eq(appUsageDaily.day, day),
              inArray(appUsageDaily.meter, [...meters]),
            ),
          );
        if (values.length > 0) {
          await tx.insert(appUsageDaily).values(values);
        }
      });
    }
  }
  if (trafficRead) {
    await setPlatformSetting(db, SYNCED_AT_SETTING, now.toISOString());
  }
  const payers = new Map(rows.map((row) => [`${row.clientId}\n${row.person}`, row]));
  for (const payer of payers.values()) {
    await applyCredits(env, db, payer.clientId, payer.person);
  }
}
