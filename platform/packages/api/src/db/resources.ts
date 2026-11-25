import { and, eq, sql } from 'drizzle-orm';
import { generateId } from '../id.ts';
import { getProjectQueueName } from '../naming.ts';
import {
  projects,
  deployments,
  projectSecrets,
  projectCleanupJobs,
  resources,
  domains,
  builds,
} from '../schema.ts';
import type { Resource } from '../types.ts';
import { terminateBuildsForProject } from './builds.ts';
import type { TerminatedBuild } from './builds.ts';
import type { Db, DbOrTx } from './client.ts';

export async function createResource(
  db: Db,
  projectId: string,
  type: Resource['type'],
  cfId: string,
  bindingName: string,
): Promise<Resource> {
  const id = generateId('res');
  const [row] = await db
    .insert(resources)
    .values({ id, project_id: projectId, type, cf_id: cfId, binding_name: bindingName })
    .returning();
  return row;
}

export async function getProjectResources(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Resource>> {
  return db.select().from(resources).where(eq(resources.project_id, projectId));
}

export async function getResourceByBinding(
  db: Db,
  projectId: string,
  type: 'd1' | 'kv' | 'r2' | 'queue',
  bindingName: string,
): Promise<{ cf_id: string } | undefined> {
  return db
    .select({ cf_id: resources.cf_id })
    .from(resources)
    .where(
      and(
        eq(resources.project_id, projectId),
        eq(resources.type, type),
        eq(resources.binding_name, bindingName),
      ),
    )
    .then((rows) => rows[0]);
}

export type ProjectCleanupJobInput = typeof projectCleanupJobs.$inferInsert;

export function cleanupJobsForResource(
  projectId: string,
  resource: Resource,
): Array<ProjectCleanupJobInput> {
  if (resource.type === 'container') {
    return [];
  }
  const payload: ProjectCleanupJobInput['payload'] = { type: resource.type, cfId: resource.cf_id };
  if (resource.type === 'vectorize') {
    payload.bindingName = resource.binding_name;
    payload.metadata = JSON.stringify(resource.metadata);
  }
  if (resource.type === 'durable-object') {
    payload.className = resource.binding_name;
    payload.metadata = JSON.stringify(resource.metadata);
  }
  const jobs: Array<ProjectCleanupJobInput> = [
    {
      target: `cf-resource:${projectId}:${resource.type}:${resource.cf_id}`,
      project_id: projectId,
      kind: 'cf-resource',
      payload,
    },
  ];
  if (resource.type === 'queue') {
    const key = `queue:${getProjectQueueName(projectId, resource.binding_name)}`;
    jobs.push({
      target: `routing-key:${projectId}:${key}`,
      project_id: projectId,
      kind: 'routing-key',
      payload: { key },
    });
  }
  return jobs;
}

export async function enqueueProjectCleanupJobs(
  db: DbOrTx,
  jobs: ReadonlyArray<ProjectCleanupJobInput>,
): Promise<void> {
  if (jobs.length === 0) {
    return;
  }
  await db
    .insert(projectCleanupJobs)
    .values([...jobs])
    .onConflictDoNothing();
}

/**
 * Cascade-delete a project and everything that references it. Returns:
 *  - `cancelledBuilds`: the in-flight builds terminalized here, so the caller can
 *    best-effort stop their still-running container BuildManager DOs (see
 *    {@link cancelContainerBuildDos}) AFTER this tx commits.
 *  - `deletedResources`: every `resources` row this tx removed. Because the
 *    project FOR UPDATE lock below conflicts with the `FOR KEY SHARE` a resources
 *    INSERT takes on the same project row (FK), this is the COMPLETE set of
 *    resources that ever committed — a row created concurrently either committed
 *    before this lock (so the DELETE sees it) or blocks then FK-fails. The caller
 *    deletes the CF object for any resource not already cleaned by the pre-cascade
 *    best-effort sweep, closing the orphan-on-concurrent-create window (a
 *    provisioning route or deploy that raced teardown and inserted a row after the
 *    sweep's one-time snapshot). See design-doc 0067 for the broader race.
 */
export async function deleteProjectCascade(
  db: Db,
  projectId: string,
  processedResourceCfIds: ReadonlySet<string> = new Set(),
): Promise<{
  cancelledBuilds: ReadonlyArray<TerminatedBuild>;
  deletedResources: ReadonlyArray<Resource>;
}> {
  return await db.transaction(async (tx) => {
    // Decision: Lock the project row FOR UPDATE, the lock the build-creation paths take first
    // (supersedeAndCreateContainerBuild, createGithubActionsBuildWithinLimit), so a concurrent push or
    // OIDC exchange can't insert a build between the terminate below and the builds delete. A build
    // that committed earlier is caught by terminateBuildsForProject; one that lost the race waits, then
    // finds the project and its cascaded github_connections row gone.
    await tx.execute(sql`SELECT id FROM ${projects} WHERE id = ${projectId} FOR UPDATE`);
    // Decision: End and capture in-flight builds before deleting their rows. The build row is the only durable
    // handle the reaper and cancel path use to stop a running container DO; without it the DO (or a
    // GitHub Actions runner) keeps building until its own timeout. The caller stops container DOs after
    // commit; github_actions builds have no DO, so ending and deleting the row to revoke the deploy
    // token is all we can do.
    const cancelled = await terminateBuildsForProject(tx, projectId, {
      reason: 'project deleted',
    });
    await tx.delete(domains).where(eq(domains.project_id, projectId));
    // Decision: RETURNING the deleted rows lets the caller clean up the CF object behind a resource that raced
    // teardown's one-time snapshot; once its row is gone there's no other durable handle.
    const deletedResources = await tx
      .delete(resources)
      .where(eq(resources.project_id, projectId))
      .returning();
    // Decision: Record resources that appeared after the pre-cascade cleanup snapshot in the same transaction that
    // removes their only durable handles, so the scheduled worker can retry a provider delete that
    // fails after COMMIT.
    await enqueueProjectCleanupJobs(
      tx,
      deletedResources
        .filter((resource) => !processedResourceCfIds.has(resource.cf_id))
        .flatMap((resource) => cleanupJobsForResource(projectId, resource)),
    );
    await tx.delete(projectSecrets).where(eq(projectSecrets.project_id, projectId));
    // Decision: builds reference projects and deployments with ON DELETE NO ACTION, so delete them before the
    // deployments, or the build-to-deployment FK aborts the teardown.
    await tx.delete(builds).where(eq(builds.project_id, projectId));
    await tx.delete(deployments).where(eq(deployments.project_id, projectId));
    await tx.delete(projects).where(eq(projects.id, projectId));
    return { cancelledBuilds: cancelled, deletedResources };
  });
}
