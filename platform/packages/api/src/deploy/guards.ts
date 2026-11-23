import { eq } from 'drizzle-orm';
import {
  getProject,
  getDeployment,
  ACTIVE_BUILD_STATUSES,
  CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES,
  TERMINAL_DEPLOYMENT_STATUSES,
} from '../db.ts';
import type { Db } from '../db.ts';
import { builds } from '../schema.ts';

export async function assertDeploymentNotCanceled(db: Db, deploymentId: string): Promise<void> {
  const latest = await getDeployment(db, deploymentId);
  if (
    !latest ||
    latest.status === 'compensating' ||
    CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES.includes(latest.status) ||
    TERMINAL_DEPLOYMENT_STATUSES.includes(latest.status)
  ) {
    throw new Error('deployment canceled');
  }
}

/**
 * Sentinel error thrown by the atomic precheck-and-claim transaction to
 * signal "another deploy is already in flight". The route handler catches
 * this and returns HTTP 409. Defined as a class (not a string sentinel) so
 * the catch-path can do an `instanceof` check without colliding with
 * arbitrary error messages from elsewhere in the transaction.
 */
export class ConcurrentDeployError extends Error {
  constructor(public readonly deploymentId: string) {
    super(`deploy in progress: ${deploymentId}`);
    this.name = 'ConcurrentDeployError';
  }
}

// Decision: Race guard against concurrent project teardown (design doc 0067 §7). Teardown takes a project-row
// lock and sets `projects.status='deleting'` before tearing down CF state. A deploy that already
// passed `assertDeploymentNotCanceled` could still race the route flip and recreate routing for a
// deleted project. Call this with each cancellation check, and re-check under FOR UPDATE at the final
// commit. The precheck-and-claim transaction holds the same lock teardown uses.
export const PROJECT_DELETING_ERROR_MESSAGE = 'project deletion in progress';

async function assertProjectNotDeleting(db: Db, projectId: string): Promise<void> {
  const project = await getProject(db, projectId);
  // Decision: Fail closed: treat a missing project row like `status='deleting'`. After teardown sets 'deleting'
  // and `deleteProjectCascade` removes the row, an in-flight deploy that sees no row would pass this
  // guard and recreate routing and worker state for a deleted project. Throwing sends both cases to
  // the same catch branch (PROJECT_DELETING_ERROR_MESSAGE), which rolls back KV writes and the worker.
  if (!project || project.status === 'deleting') {
    throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
  }
}

/** Abort a running deploy step once the deployment is canceled or its project is being deleted. */
export async function assertDeploymentCanProceed(
  db: Db,
  deploymentId: string,
  projectId: string,
): Promise<void> {
  await assertDeploymentNotCanceled(db, deploymentId);
  await assertProjectNotDeleting(db, projectId);
}

// Decision: Thrown by the final-publish transaction when the deploy token's bound build is no longer active.
// `handleManifestOnlyDeploy` checks the build once at entry, but the request then spends minutes
// parsing, prechecking, uploading and provisioning. In that window a newer GitHub Actions run's OIDC
// exchange can cancel the old build (`createGithubActionsBuildWithinLimit`), and without a re-check
// the superseded runner would still publish stale code. It goes through the same rollback branch
// as PROJECT_DELETING_ERROR_MESSAGE so the deployment doesn't go live.
export const SUPERSEDED_BUILD_ERROR_MESSAGE = 'bound build was superseded';

/**
 * Re-check the deploy token's bound build under a row lock, inside the final
 * publish transaction, immediately before the deployment flips to `live`. The
 * `FOR UPDATE` lock serializes against the supersede UPDATE in
 * `createGithubActionsBuildWithinLimit` (which row-locks the matching `builds`
 * rows as it cancels them), so a build that gets superseded mid-flight is
 * observed as terminal here and the publish is aborted.
 *
 * No-op when the token carries no `build` claim (full-API tokens, CI
 * credential tokens). Throws SUPERSEDED_BUILD_ERROR_MESSAGE on a non-active or
 * project-mismatched build, mirroring the up-front guard's reject semantics.
 */
export async function assertBoundBuildStillActive(
  txDb: Db,
  deployBuild: string | undefined,
  projectId: string,
): Promise<void> {
  if (!deployBuild) {
    return;
  }
  const [boundBuild] = await txDb
    .select()
    .from(builds)
    .where(eq(builds.id, deployBuild))
    .for('update')
    .limit(1);
  if (
    !boundBuild ||
    !ACTIVE_BUILD_STATUSES.includes(boundBuild.status) ||
    boundBuild.project_id !== projectId
  ) {
    throw new Error(SUPERSEDED_BUILD_ERROR_MESSAGE);
  }
}
