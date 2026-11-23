export const REASON_REQUESTS_EXCEEDED = 'requests_exceeded';
export const REASON_SANDBOX_RUNTIME_EXCEEDED = 'sandbox_runtime_exceeded';

const USAGE_LIMIT_REASONS = new Set([REASON_REQUESTS_EXCEEDED, REASON_SANDBOX_RUNTIME_EXCEEDED]);

/**
 * Returns true when the user is suspended by an admin action (not by
 * automatic usage-limit enforcement). Usage-suspended users must retain
 * dashboard and API access so they can inspect usage and upgrade.
 */
export function isAdminSuspended(suspendedReason: string | null): boolean {
  return suspendedReason !== null && !USAGE_LIMIT_REASONS.has(suspendedReason);
}

export function routingSuspensionReason(suspendedReason: string | null): string | null {
  return suspendedReason === REASON_REQUESTS_EXCEEDED || isAdminSuspended(suspendedReason)
    ? suspendedReason
    : null;
}

/**
 * ROUTING key present while a project or its owner is suspended by an administrator.
 * Cron firing (CronScheduler) and queue relay (dispatch) pause while it exists.
 * Usage-limit suspensions never write it.
 */
export function projectSuspensionKey(projectId: string): string {
  return `project-suspended:${projectId}`;
}

export const REASON_OPERATOR_TAKEDOWN = 'operator_takedown';
/** The payer is at zero: requests run at a lower rate until the grace days end. */
export const REASON_CREDITS_GRACE = 'credits_grace';
/** The payer has been at zero past the grace days: requests, cron jobs and queues stop. */
export const REASON_CREDITS_PAUSED = 'credits_paused';
export const CREDITS_REASONS: ReadonlyArray<string> = [REASON_CREDITS_GRACE, REASON_CREDITS_PAUSED];

type ProjectSuspensionState = Readonly<{ suspended_reason: string | null }>;
type OwnerSuspensionState = Readonly<{ suspended_reason: string | null }>;

// Decision: The project's own reason outranks the owner's, so restoring the owner or a usage reset can't lift
// it. A later billing pause stored on the project follows the same rule.
export function projectRoutingSuspensionReason(
  project: ProjectSuspensionState,
  owner: OwnerSuspensionState,
): string | null {
  const billing =
    project.suspended_reason === null || CREDITS_REASONS.includes(project.suspended_reason);
  if (billing && isAdminSuspended(owner.suspended_reason)) {
    return owner.suspended_reason;
  }
  return project.suspended_reason ?? routingSuspensionReason(owner.suspended_reason);
}

export function projectBackgroundSuspensionReason(
  project: ProjectSuspensionState,
  owner: OwnerSuspensionState,
): string | null {
  // Decision: The grace days slow requests down but keep cron jobs and queues running.
  if (project.suspended_reason !== null && project.suspended_reason !== REASON_CREDITS_GRACE) {
    return project.suspended_reason;
  }
  return isAdminSuspended(owner.suspended_reason) ? owner.suspended_reason : null;
}
