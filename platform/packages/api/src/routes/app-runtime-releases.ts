import { and, desc, eq, isNull, ne, or } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { deployments } from '../schema.ts';
import type { Project } from '../types.ts';

const fields = {
  id: deployments.id,
  status: deployments.status,
  createdAt: deployments.created_at,
  updatedAt: deployments.updated_at,
  publishedAt: deployments.deployed_at,
};
const statuses = new Set([
  'pending',
  'uploading',
  'migrating',
  'cutover',
  'compensating',
  'canceling',
  'live',
  'failed',
  'canceled',
]);

function timestamp(value: string): string {
  // Decision: These database columns are UTC timestamps without a timezone suffix.
  const utc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(utc)) {
    throw Error('Invalid release timestamp');
  }
  return new Date(utc).toISOString();
}

function release(row: {
  id: string;
  status: typeof deployments.$inferSelect.status;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}) {
  if (!row.id || row.id.length > 200 || !statuses.has(row.status)) {
    throw Error('Invalid release record');
  }
  return {
    id: row.id,
    status: row.status,
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    publishedAt: row.publishedAt === null ? null : timestamp(row.publishedAt),
  };
}

export async function runtimeReleases(db: Db, project: Project) {
  const owned = and(
    eq(deployments.project_id, project.id),
    or(isNull(deployments.source), ne(deployments.source, 'rollback-lease')),
  );
  const rows = await db
    .select(fields)
    .from(deployments)
    .where(owned)
    .orderBy(desc(deployments.created_at), desc(deployments.id))
    .limit(21);
  const selected = project.active_deployment_id
    ? (
        await db
          .select(fields)
          .from(deployments)
          .where(and(owned, eq(deployments.id, project.active_deployment_id)))
          .limit(1)
      )[0]
    : null;
  if (
    project.active_deployment_id &&
    (!selected || selected.status !== 'live' || !selected.publishedAt)
  ) {
    throw Error('Release selection is inconsistent');
  }
  const current = selected ? release(selected) : null;
  const history = rows.slice(0, 20).map(release);
  const historical = history.find((entry) => entry.id === current?.id);
  if (historical && JSON.stringify(historical) !== JSON.stringify(current)) {
    throw Error('Release changed while reading history');
  }
  return {
    current,
    history,
    truncated: rows.length > 20,
  };
}
