import { and, eq, inArray, like, ne, sql } from 'drizzle-orm';
import { APP, applyCredits, dayOf, payerOf, SYNCED_AT_SETTING, type Meter } from './app-credits.ts';
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

type Group = {
  sum?: Record<string, number>;
  max?: Record<string, number>;
  dimensions?: Record<string, string>;
};
const byDate = (day: string) => `date_geq: "${day}", date_leq: "${day}"`;
const byTime = (day: string) =>
  `datetime_geq: "${day}T00:00:00Z", datetime_leq: "${day}T23:59:59Z"`;
const num = (value: unknown) => Number(value) || 0;
// Decision: R2 lists its Class B and free actions by name. Any other action is priced as Class A, so an action
// Cloudflare adds later is never under-charged.
const R2_CLASS_B = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);
const R2_FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);

/**
 * What each Cloudflare GraphQL dataset adds to a project for one day, by the resource id it names.
 * Storage takes the day's largest size, and operations add up the day's counts.
 */
const SOURCES = [
  {
    type: 'd1',
    meters: ['hostedD1ByteDays'],
    dataset: 'd1StorageAdaptiveGroups',
    id: 'databaseId',
    select: 'max { databaseSizeBytes }',
    dims: '',
    day: byDate,
    reading: (group: Group): Reading => ({ hostedD1ByteDays: num(group.max?.databaseSizeBytes) }),
  },
  {
    type: 'kv',
    meters: ['hostedKvByteDays'],
    dataset: 'kvStorageAdaptiveGroups',
    id: 'namespaceId',
    select: 'max { byteCount }',
    dims: '',
    day: byDate,
    reading: (group: Group): Reading => ({ hostedKvByteDays: num(group.max?.byteCount) }),
  },
  {
    type: 'r2',
    meters: ['hostedR2ByteDays'],
    dataset: 'r2StorageAdaptiveGroups',
    id: 'bucketName',
    select: 'max { payloadSize metadataSize }',
    dims: '',
    day: byTime,
    reading: (group: Group): Reading => ({
      hostedR2ByteDays: num(group.max?.payloadSize) + num(group.max?.metadataSize),
    }),
  },
  {
    type: 'd1',
    meters: ['hostedD1RowsRead', 'hostedD1RowsWritten'],
    dataset: 'd1AnalyticsAdaptiveGroups',
    id: 'databaseId',
    select: 'sum { rowsRead rowsWritten }',
    dims: '',
    day: byDate,
    reading: (group: Group): Reading => ({
      hostedD1RowsRead: num(group.sum?.rowsRead),
      hostedD1RowsWritten: num(group.sum?.rowsWritten),
    }),
  },
  {
    type: 'r2',
    meters: ['hostedR2ClassAOps', 'hostedR2ClassBOps'],
    dataset: 'r2OperationsAdaptiveGroups',
    id: 'bucketName',
    select: 'sum { requests }',
    dims: 'actionType',
    day: byTime,
    reading: (group: Group): Reading => {
      const action = group.dimensions?.actionType ?? '';
      const requests = num(group.sum?.requests);
      return R2_FREE.has(action)
        ? {}
        : R2_CLASS_B.has(action)
          ? { hostedR2ClassBOps: requests }
          : { hostedR2ClassAOps: requests };
    },
  },
  {
    type: 'kv',
    meters: ['hostedKvReads', 'hostedKvWrites'],
    dataset: 'kvOperationsAdaptiveGroups',
    id: 'namespaceId',
    select: 'sum { requests }',
    dims: 'actionType',
    day: byDate,
    reading: (group: Group): Reading =>
      group.dimensions?.actionType === 'read'
        ? { hostedKvReads: num(group.sum?.requests) }
        : { hostedKvWrites: num(group.sum?.requests) },
  },
  {
    type: 'queue',
    meters: ['hostedQueueOps'],
    dataset: 'queueMessageOperationsAdaptiveGroups',
    id: 'queueId',
    select: 'sum { billableOperations }',
    dims: '',
    day: byTime,
    reading: (group: Group): Reading => ({
      hostedQueueOps: num(group.sum?.billableOperations),
    }),
  },
] as const satisfies ReadonlyArray<{
  type: 'd1' | 'kv' | 'r2' | 'queue';
  meters: ReadonlyArray<Meter>;
  dataset: string;
  id: string;
  select: string;
  dims: string;
  day: (day: string) => string;
  reading: (group: Group) => Reading;
}>;
type Source = (typeof SOURCES)[number];

/** Adds up what one dataset says each project's databases, buckets, namespaces or queues did that day. */
async function readDataset(env: Bindings, source: Source, owned: Map<string, string>, day: string) {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query {
  viewer {
    accounts(filter: { accountTag: "${env.CF_ACCOUNT_ID}" }) {
      groups: ${source.dataset}(limit: 10000, filter: { ${source.day(day)} }) {
        ${source.select}
        dimensions { ${source.id} ${source.dims} }
      }
    }
  }
}`,
    }),
  });
  const body = (await response.json().catch(() => null)) as {
    errors?: Array<unknown> | null;
    data?: { viewer?: { accounts?: Array<{ groups?: Array<Group> }> } };
  } | null;
  const groups = body?.data?.viewer?.accounts?.[0]?.groups;
  if (!response.ok || body?.errors?.length || !Array.isArray(groups)) {
    throw new Error(`${source.dataset} query failed with HTTP ${response.status}`);
  }
  const read = new Map<string, Reading>();
  for (const group of groups) {
    const projectId = owned.get(group.dimensions?.[source.id] ?? '');
    if (projectId) {
      const sum: Reading = read.get(projectId) ?? {};
      for (const [meter, quantity] of Object.entries(source.reading(group)) as Array<
        [Meter, number]
      >) {
        sum[meter] = (sum[meter] ?? 0) + quantity;
      }
      read.set(projectId, sum);
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
          and(
            inArray(resources.project_id, ids),
            inArray(resources.type, ['d1', 'kv', 'r2', 'queue']),
          ),
        );
  const owned = (type: Source['type']) =>
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
            ...SOURCES.map(
              (source) =>
                [source.meters, () => readDataset(env, source, owned(source.type), day)] as [
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
