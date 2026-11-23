import { tokenizeSql } from '@builtbyfriends/deploy-core';
import type { ProjectZeroTrustRouting } from '@builtbyfriends/edge';
import { sql as drizzleSql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  AiLoggingPublishError,
  lockNewProjectAiLoggingInputs,
  publishProjectAiLogging,
} from '../ai-logging.ts';
import { billedPlanLimits } from '../app-payer.ts';
import { hmacSignState } from '../auth/hmac.ts';
import { buildManagerNamespace } from '../build-namespace.ts';
import { isTerminalBuildStatus } from '../build-status.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import {
  clearCronScheduler,
  restoreCronScheduler,
  snapshotCronScheduler,
  syncCronScheduler,
} from '../cron-scheduler-client.ts';
import type { Db } from '../db.ts';
import {
  createProject,
  getBuild,
  getProjectBuilds,
  getProjectBySlug,
  getProjectByEmailAlias,
  getProjectResources,
  getActivatedDeployments,
  getTerminalFailedDeployments,
  getDomainsByProjectId,
  getDeployment,
  getActiveDeployment,
  createDeployment,
  deleteRollbackLease,
  updateRollbackLeaseState,
  cancelDeployment,
  getPendingDeploymentOperation,
  setActiveDeployment,
  updateProjectType,
  appendAppliedMigrations,
  appendProjectMigrations,
  activeDeploymentContainsMigration,
  getProjectMigrationRows,
  getProjectMigrationNames,
  renameAppliedMigrationsForProject,
  renameProjectMigrations,
  recordMigrationRenames,
  migrationRenameExists,
  invalidateMigrationRenamesForOldName,
  tryCreateEmailDestination,
} from '../db.ts';
import { databaseTimestampMs } from '../deploy/recovery.ts';
import { type ApiEnv } from '../env.ts';
import { validateSubmittedExecutionPlans } from '../migrations/execution-plan.ts';
import { ensureTrackingTable, queryD1, runRemoteMigrations } from '../migrations/remote-runner.ts';
import { getProjectDeploymentWorkerName, getProjectQueueName } from '../naming.ts';
import { LOG_ROW_GROUP_BY, runtimeLogsField } from '../observability/log-rows.ts';
import { hasSqlState } from '../pg-errors.ts';
import { initialPlanDefaultFor, resolvePlan } from '../plans.ts';
import { PROJECT_PERMISSION_MESSAGES } from '../project-access.ts';
import { projectNameError } from '../project-names.ts';
import {} from '../project-secrets.ts';
import { ProjectRequiresNormalizationError, requireNormalizedProject } from '../project-state.ts';
import { projectWithUrl } from '../project-url.ts';
import {
  addQueueConsumer,
  getDispatchWorkerProxyToken,
  removeQueueConsumer,
  restoreQueueConsumer,
  snapshotQueueConsumer,
} from '../provisioning/cloudflare-api.ts';
import { reconcileManagedDurableObjects } from '../provisioning/durable-objects.ts';
import {
  addDestination,
  listDestinations,
  // Decision: This file has its own `isAlreadyExistsError` for CF resource provisioning. Alias the Email
  // Routing one instead of shadowing it: they match different CF error wordings.
  isAlreadyExistsError as isDestinationAlreadyExistsError,
} from '../provisioning/email-routing.ts';
import { isManagedSandbox, verifySandboxController } from '../provisioning/sandbox-controller.ts';
import { requestRotationIfReplacingUntrustedCode } from '../proxy-token-rotation.ts';
import { projectRouteKey } from '../routing.ts';
import {
  buildRoutingJson,
  buildStaticRoutingJson,
  computeDispatchLimits,
  resolveRoutingUndo,
} from '../routing.ts';
import type { Build, DeployManifest, User } from '../types.ts';
import { ZeroTrustUnavailableError, zeroTrustNotReadyMessage } from '../zero-trust/errors.ts';
import { lockZeroTrustConfiguration } from '../zero-trust/lock.ts';
import { initializeNewProjectZeroTrust } from '../zero-trust/project.ts';
import {
  resolveProjectZeroTrustRouting,
  resolveProjectZeroTrustRoutingForPublication,
  withProjectZeroTrustRouting,
} from '../zero-trust/routing.ts';
import { publicProjectZeroTrustState } from '../zero-trust/state.ts';
import { rollbackCfDestination } from './email.ts';
import { requireProjectRouteCapability } from './project-access.ts';
import { getRequestsDataset, queryAnalyticsEngine } from './usage.ts';

const DESTRUCTIVE_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+VIEW\b/i,
  /\bDROP\s+INDEX\b/i,
  /\bDROP\s+TRIGGER\b/i,
  /\bDROP\s+COLUMN\b/i,
  // Decision: Match all three destructive RENAME forms SQLite accepts: `RENAME TO`, `RENAME COLUMN`, and the
  // legacy `RENAME <old_col> TO <new_col>`. The legacy form is rare but the engine accepts it, so
  // skipping it leaves a bypass. Quoted identifiers are already replaced by placeholders, so they
  // match too. `[^;]` keeps the match inside one statement. Requiring a following `TO` avoids false
  // positives like `ADD COLUMN rename TEXT`.
  /\bALTER\s+TABLE\b[^;]*?\bRENAME\s+(?:TO\b|COLUMN\b|[^;\s]+\s+TO\b)/i,
  /\bTRUNCATE\b/i,
  // Decision: Destructive DML needs the same pragma as DDL: `INSERT OR REPLACE` silently deletes rows whose
  // primary key collides. Unbounded DELETE and UPDATE are checked per statement below, so a later
  // statement or a subquery WHERE can't hide an unbounded write.
  /\bINSERT\s+OR\s+REPLACE\b/i,
];

const DESTRUCTIVE_PRAGMA = '-- platform:allow-destructive';

/**
 * Sentinel error used by the /rollback handler to signal an HTTP
 * response status from inside the row-locked transaction callback.
 * `db.transaction` rolls back on any throw, so we use this wrapper to
 * distinguish "user-facing 404/400" from unexpected exceptions that
 * should surface as 500. Handling is local to the /rollback handler.
 */
class RollbackError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 501,
    message: string,
    /**
     * For destructive-rollback rejections, we surface the server-computed
     * diff as a structured field alongside the error string so
     * programmatic callers (CLI retry, dashboard, MCP agent) can echo it
     * back verbatim without re-parsing the human message. Migration names
     * can contain arbitrary characters (see /rename which accepts any
     * non-empty string), so human-readable hints built via string
     * concatenation are not safe to copy-paste.
     */
    public readonly destructiveMigrations?: ReadonlyArray<string>,
    public readonly userMessage?: string,
  ) {
    super(message);
    this.name = 'RollbackError';
  }
}

async function getProjectAccessErrorBody(
  response: Response,
): Promise<{ error: string; message: string }> {
  const fallback =
    response.status === 404
      ? { error: 'project not found', message: PROJECT_PERMISSION_MESSAGES['not-found'] }
      : {
          error: 'forbidden',
          message:
            'You do not have permission for this action. Ask a project admin or owner to check your access.',
        };
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'string'
    ) {
      return {
        error: body.error,
        message:
          'message' in body && typeof body.message === 'string' && body.message.trim()
            ? body.message
            : fallback.message,
      };
    }
  } catch {}
  return fallback;
}

/**
 * Resolve the proxy token to use when re-targeting routing/cron at a
 * historical deployment.
 *
 * Preferred path: fetch the EXACT `__PLATFORM_PROXY_TOKEN` plain_text
 * binding baked into the target worker. Rotating `JWT_SECRET` after
 * that worker was deployed would make a fresh `hmacSignState` value
 * mismatch the worker and 401 every /__platform/queue and /__platform/scheduled
 * relay.
 *
 * Legacy workers (deployed before the binding was introduced) report
 * `{kind: "missing"}`. Falling back to the current-secret derivation is
 * safe only if `JWT_SECRET` has not rotated since the worker was
 * deployed; the warning surfaces the risk to operators so they can
 * redeploy instead of relying on the fallback.
 *
 * Transient CF API failures MUST propagate. A silent null that becomes
 * a fallback can write a mismatched token into KV that will 401 the
 * worker indefinitely.
 */
async function resolveRollbackProxyToken(
  env: ApiEnv['Bindings'],
  workerName: string,
  projectId: string,
): Promise<string> {
  const dispatchNamespace = env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const lookup = await getDispatchWorkerProxyToken(
    env.CF_ACCOUNT_ID,
    env.CF_API_TOKEN,
    dispatchNamespace,
    workerName,
  );
  if (lookup.kind === 'found') {
    return lookup.token;
  }
  if (lookup.kind === 'error') {
    throw new Error(
      `rollback: could not read __PLATFORM_PROXY_TOKEN from worker "${workerName}": ${lookup.error.message}`,
    );
  }
  console.warn(
    `[rollback] worker "${workerName}" has no __PLATFORM_PROXY_TOKEN binding; falling back to current-secret derivation. If JWT_SECRET has rotated since this deployment was live, you must redeploy the project instead.`,
  );
  return hmacSignState(projectId, env.JWT_SECRET);
}

/**
 * D1 returns "no such table" when a table is missing. GET /:id/migrations
 * probes both `_void_migrations` and `_migrations` and must tolerate either
 * being absent, but must NOT silently swallow unrelated errors (auth failure,
 * timeout, quota, "database is locked", etc.) — those should surface to the
 * caller instead of returning an empty applied set.
 */
function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(msg);
}

type LineComment = Readonly<{
  text: string;
  standalone: boolean;
}>;

/**
 * Tokenize SQL into executable code and the set of line-comment lines.
 * String literals, identifier quotes, and block comments are stripped from
 * `code`; only `-- ...` line comments are accumulated into `lineComments`,
 * each tagged with whether it stood alone on its raw source line.
 *
 * This is load-bearing for four reasons:
 *
 *   1. A raw `sql.includes('-- platform:allow-destructive')` check authorizes
 *      destructive SQL when the pragma appears anywhere in the file,
 *      including inside a string literal. A migration like
 *      `INSERT INTO t VALUES('-- platform:allow-destructive'); DROP TABLE users;`
 *      would slip through — the pragma must only be honored when it is
 *      actually a SQL comment.
 *   2. Running destructive-pattern regexes on the raw SQL false-positives
 *      on data like `VALUES('DROP TABLE users')` and on `-- DROP TABLE`
 *      in a line comment, which could block legitimate migrations.
 *   3. Block comments are intentionally NOT counted toward the pragma. A
 *      docstring like `/* use -- platform:allow-destructive to permit drops *\/`
 *      is documentation, not authorization. They are also replaced with a
 *      single space rather than deleted outright so that token boundaries
 *      are preserved — `DROP/**\/TABLE` must not collapse to `DROPTABLE`,
 *      which would slip the destructive keyword regex entirely.
 *   4. The standalone bit on each line comment lets the caller require
 *      that the destructive pragma occupies its own raw line. Trailing
 *      pragmas like `CREATE TABLE t(id); -- platform:allow-destructive`
 *      must not retroactively authorize a later DROP TABLE.
 *
 * Only the SQLite lexical forms are handled: `'...'` strings with `''`
 * escape, `"..."` / `` `...` `` / `[...]` identifier quotes with doubled
 * closing-quote escape, `-- line` comments, and `/* block *\/` comments.
 */
function stripSqlStringsAndComments(sql: string): {
  code: string;
  lineComments: ReadonlyArray<LineComment>;
} {
  let code = '';
  const lineComments: Array<LineComment> = [];

  for (const seg of tokenizeSql(sql)) {
    switch (seg.kind) {
      case 'sql':
        code += sql.slice(seg.start, seg.end);
        break;
      case 'line-comment': {
        // Decision: The comment is standalone only if everything before `--` on its raw line is whitespace. Anything
        // else (a SQL token, a closing `*/`, a string) shares the line, and the pragma mustn't authorize.
        let standalone = true;
        for (let k = seg.start - 1; k >= 0; k--) {
          const ch = sql[k];
          if (ch === '\n') {
            break;
          }
          if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
            standalone = false;
            break;
          }
        }
        lineComments.push({ text: sql.slice(seg.start, seg.end), standalone });
        break;
      }
      case 'block-comment':
        // Decision: Replace a block comment with one space so `DROP/**/TABLE` doesn't collapse to `DROPTABLE` and
        // slip past the destructive regex. One space is enough because each pattern needs `\b` or `\s+`
        // between keywords.
        code += ' ';
        break;
      case 'string':
        code += "''";
        break;
      case 'ident-quote': {
        // Decision: Replace the quoted identifier body with `_` instead of copying it. A `;` inside an identifier
        // (`ALTER TABLE "user;data" RENAME TO x`) would cut the `[^;]*?` match and let the RENAME through,
        // and a keyword inside one (`CREATE TABLE "DROP TABLE users"`) would block a benign migration. The
        // quote characters stay so token boundaries hold.
        const close = seg.open === '[' ? ']' : seg.open;
        code += seg.open + '_' + close;
        break;
      }
    }
  }

  return { code, lineComments };
}

function splitExecutableStatements(sql: string): Array<string> {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function hasTopLevelKeyword(statement: string, keyword: string): boolean {
  let depth = 0;
  for (let index = 0; index < statement.length; index++) {
    const character = statement[index];
    if (character === '(') {
      depth++;
      continue;
    }
    if (character === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (
      statement.slice(index, index + keyword.length).toUpperCase() === keyword &&
      !/[A-Z0-9_]/i.test(statement[index - 1] ?? '') &&
      !/[A-Z0-9_]/i.test(statement[index + keyword.length] ?? '')
    ) {
      return true;
    }
  }
  return false;
}

function hasUnboundedWrite(statement: string): boolean {
  if (/\bDELETE\s+FROM\b/i.test(statement)) {
    return !hasTopLevelKeyword(statement, 'WHERE');
  }
  if (/\bUPDATE\b[\s\S]*\bSET\b/i.test(statement)) {
    return !hasTopLevelKeyword(statement, 'WHERE');
  }
  return false;
}

function hasUnauthorizedDestructive(
  migrations: ReadonlyArray<{ name: string; sql: string }>,
): ReadonlyArray<string> {
  const violations: Array<string> = [];
  for (const m of migrations) {
    const { code, lineComments } = stripSqlStringsAndComments(m.sql);
    const isDestructive = splitExecutableStatements(code).some((statement) => {
      return (
        DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(statement)) ||
        hasUnboundedWrite(statement)
      );
    });
    if (!isDestructive) {
      continue;
    }
    // Decision: Honor the pragma only as a standalone line comment: nothing but whitespace before `--`, and a
    // body of exactly `platform:allow-destructive`. A trailing pragma after a statement doesn't
    // authorize, and neither does a comment like `-- see platform:allow-destructive for details`.
    const authorized = lineComments.some(
      (line) => line.standalone && line.text.trim() === DESTRUCTIVE_PRAGMA,
    );
    if (!authorized) {
      violations.push(m.name);
    }
  }
  return violations;
}

function toBuildSummary(build: Build) {
  return {
    id: build.id,
    status: build.status,
    executor: build.executor,
    commit_sha: build.commit_sha,
    branch: build.branch,
    exit_code: build.exit_code,
    error: build.error,
    logs_url: build.logs_url,
    created_at: build.created_at,
    started_at: build.started_at,
    completed_at: build.completed_at,
  };
}

const app = new Hono<ApiEnv>()

  .post('/:id/deployments/:deploymentId/cancel', async (context) => {
    const projectId = context.req.param('id');
    const deploymentId = context.req.param('deploymentId');
    const access = await requireProjectRouteCapability(context, projectId, 'deploy');
    if (access instanceof Response) {
      return access;
    }

    return context.get('db').transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
      const lockedAccess = await requireProjectRouteCapability(context, projectId, 'deploy', tx);
      if (lockedAccess instanceof Response) {
        return lockedAccess;
      }

      const deployment = await getDeployment(tx, deploymentId);
      if (!deployment || deployment.project_id !== projectId) {
        return context.json({ error: 'deployment not found' }, 404);
      }

      const canceling = await cancelDeployment(tx, deploymentId, 'canceled by user');
      if (!canceling) {
        return context.json(
          { error: 'deployment already completed', status: deployment.status },
          409,
        );
      }

      return context.json({ ok: true, deploymentId, status: 'canceling' });
    });
  })

  .post('/:id/rollback', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'deploy');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;

    const { deploymentId, allowDestructive } = await context.req.json<{
      deploymentId: string;
      allowDestructive?: ReadonlyArray<string>;
    }>();
    if (!deploymentId) {
      return context.json({ error: 'deploymentId is required' }, 400);
    }
    if (allowDestructive !== undefined) {
      if (!Array.isArray(allowDestructive) || allowDestructive.some((m) => typeof m !== 'string')) {
        return context.json(
          { error: 'allowDestructive must be an array of migration name strings' },
          400,
        );
      }
    }

    // Decision: Reject fast when the deployment plainly isn't in this project. The real check runs under the
    // lock below against a freshly read row.
    const preCheck = await getDeployment(context.get('db'), deploymentId);
    if (!preCheck || preCheck.project_id !== projectId) {
      return context.json({ error: 'deployment not found' }, 404);
    }
    if (!preCheck.retained) {
      return context.json({ error: 'deployment not retained (worker script evicted)' }, 400);
    }
    if (preCheck.manifest) {
      const manifest = JSON.parse(preCheck.manifest) as DeployManifest;
      if (manifest.sandbox && !getPlatformCapabilities(context.env).sandbox) {
        return context.json(
          { error: 'This Platform does not enable rollback to Sandbox deployments.' },
          501,
        );
      }
      if (manifest.sandbox && (!isManagedSandbox(manifest) || preCheck.admission_protocol < 3)) {
        return context.json(
          {
            error:
              'This deployment predates managed Sandbox controllers. Redeploy the app before rolling back to it.',
          },
          409,
        );
      }
    }

    // Decision: A committed rollback lease blocks deploys and other rollbacks while the cutover commits or
    // external compensation runs. The fence has to live outside the cutover transaction: if PostgreSQL
    // rejects COMMIT after the callback returns, the lease still holds while we restore KV, cron and
    // queue state from the callback's undo log.
    let rollbackLeaseId: string | undefined;
    const rollbackOwnerId = crypto.randomUUID();
    const externalUndo: Array<(zeroTrust: ProjectZeroTrustRouting | null) => Promise<void>> = [];
    const routingValuesWritten = new Map<string, string | null>();
    let externalCompensated = false;
    let rollbackCommitted = false;
    let adoptedRollbackLease = false;
    let releaseRollbackLease = true;
    let rollbackResultCandidate: { migrationDiff: ReadonlyArray<string> } | undefined;
    let rollbackErrorResponse: Response | undefined;
    let rollbackErrorToThrow: unknown;
    let leaseReleaseError: AggregateError | undefined;

    // Decision: The rollback cutover runs in one row-locked transaction, so concurrent rollbacks, applies and
    // renames serialize and no external state is written before the pg flip. The pg flip runs first in
    // the lock and external writes after it; if the flip throws, nothing external has changed yet.
    // Re-read target.applied_migrations (and retained, manifest) inside the lock: a concurrent /rename
    // can rewrite them through renameAppliedMigrationsForProject.
    let rollbackResult: { migrationDiff: ReadonlyArray<string> } | undefined;
    try {
      const rollbackLease = await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const lockedAccess = await requireProjectRouteCapability(context, projectId, 'deploy', tx);
        if (lockedAccess instanceof Response) {
          const denied = await getProjectAccessErrorBody(lockedAccess);
          throw new RollbackError(
            lockedAccess.status as 403 | 404,
            denied.error,
            undefined,
            denied.message,
          );
        }
        const lockedProject = lockedAccess.project;
        if (lockedProject.status === 'deleting') {
          throw new RollbackError(409, 'project is being deleted');
        }
        try {
          await requireNormalizedProject(tx, lockedProject);
        } catch (error) {
          if (error instanceof ProjectRequiresNormalizationError) {
            throw new RollbackError(409, error.code, undefined, error.message);
          }
          throw error;
        }
        const pendingOperation = await getPendingDeploymentOperation(tx, projectId);
        if (pendingOperation) {
          throw new RollbackError(409, `deploy in progress: ${pendingOperation.id}`);
        }
        const activeDeploy = await getActiveDeployment(tx, projectId);
        if (activeDeploy) {
          if (activeDeploy.source === 'rollback-lease' && activeDeploy.manifest) {
            try {
              const lease = JSON.parse(activeDeploy.manifest) as {
                targetDeploymentId?: unknown;
                state?: unknown;
                ownerId?: unknown;
                migrationDiff?: unknown;
              };
              const updatedAt = activeDeploy.updated_at.includes('T')
                ? activeDeploy.updated_at
                : `${activeDeploy.updated_at.replace(' ', 'T')}Z`;
              const staleRunningLease =
                lease.state === 'running' &&
                Date.now() - new Date(updatedAt).getTime() >= 30 * 60 * 1000;
              if (
                lease.targetDeploymentId === deploymentId &&
                lease.state === 'applied' &&
                typeof lease.ownerId === 'string' &&
                lockedProject.active_deployment_id === deploymentId
              ) {
                if (
                  !Array.isArray(lease.migrationDiff) ||
                  !lease.migrationDiff.every((value) => typeof value === 'string')
                ) {
                  throw new RollbackError(409, `deploy in progress: ${activeDeploy.id}`);
                }
                const migrationDiff = lease.migrationDiff as Array<string>;
                const released = await deleteRollbackLease(tx, activeDeploy.id, lease.ownerId);
                if (!released) {
                  throw new RollbackError(409, `deploy in progress: ${activeDeploy.id}`);
                }
                return { id: activeDeploy.id, adopted: false, appliedResult: { migrationDiff } };
              }
              if (
                lease.targetDeploymentId === deploymentId &&
                typeof lease.ownerId === 'string' &&
                (lease.state === 'retryable' || staleRunningLease)
              ) {
                const adopted = await updateRollbackLeaseState(
                  tx,
                  activeDeploy.id,
                  deploymentId,
                  'running',
                  rollbackOwnerId,
                  lease.ownerId,
                );
                if (!adopted) {
                  throw new RollbackError(409, `deploy in progress: ${activeDeploy.id}`);
                }
                return { id: activeDeploy.id, adopted: true, appliedResult: undefined };
              }
            } catch {
              // Decision: A legacy or corrupt lease keeps the normal in-progress behavior.
            }
          }
          throw new RollbackError(409, `deploy in progress: ${activeDeploy.id}`);
        }
        const lease = await createDeployment(
          tx,
          projectId,
          JSON.stringify({
            version: 1,
            targetDeploymentId: deploymentId,
            state: 'running',
            ownerId: rollbackOwnerId,
          }),
          'rollback-lease',
        );
        return { id: lease.id, adopted: false, appliedResult: undefined };
      });
      if (rollbackLease.appliedResult) {
        rollbackCommitted = true;
        rollbackResult = rollbackLease.appliedResult;
      } else {
        rollbackLeaseId = rollbackLease.id;
        adoptedRollbackLease = rollbackLease.adopted;
      }

      if (!rollbackCommitted) {
        rollbackResult = await context.get('db').transaction(async (tx) => {
          // Decision: Lock the project row with SELECT ... FOR UPDATE as the first statement in the locked section,
          // so serialization holds before any later read or write.
          await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
          const lockedAccess = await requireProjectRouteCapability(
            context,
            projectId,
            'deploy',
            tx,
          );
          if (lockedAccess instanceof Response) {
            const denied = await getProjectAccessErrorBody(lockedAccess);
            throw new RollbackError(
              lockedAccess.status as 403 | 404,
              denied.error,
              undefined,
              denied.message,
            );
          }

          // Decision: Re-read the target inside the lock: a concurrent /rename can rewrite applied_migrations, and
          // re-reading removes time-of-check/time-of-use hazards on this row.
          const target = await getDeployment(tx, deploymentId);
          if (!target || target.project_id !== projectId) {
            throw new RollbackError(404, 'deployment not found');
          }
          if (!target.retained) {
            throw new RollbackError(400, 'deployment not retained (worker script evicted)');
          }
          if (target.manifest) {
            const manifest = JSON.parse(target.manifest) as DeployManifest;
            if (manifest.sandbox && !getPlatformCapabilities(context.env).sandbox) {
              throw new RollbackError(
                501,
                'This Platform does not enable rollback to Sandbox deployments.',
              );
            }
            if (manifest.sandbox) {
              if (!isManagedSandbox(manifest) || target.admission_protocol < 3) {
                throw new RollbackError(
                  409,
                  'This deployment predates managed Sandbox controllers. Redeploy the app before rolling back to it.',
                );
              }
              try {
                await verifySandboxController(
                  context.env.CF_ACCOUNT_ID,
                  context.env.CF_API_TOKEN,
                  projectId,
                  deploymentId,
                  manifest.sandbox,
                );
              } catch (error) {
                throw new RollbackError(
                  409,
                  error instanceof Error ? error.message : 'Sandbox controller is unavailable.',
                );
              }
            }
          }

          // Decision: Use the project row read under the lock, so `active_deployment_id` and `type` reflect any
          // rollback or deploy that committed before the lock, and the routing JSON matches the row the flip
          // references.
          const lockedProject = lockedAccess.project;
          if (lockedProject.status === 'deleting') {
            throw new RollbackError(409, 'project is being deleted');
          }
          const pendingOperation = await getPendingDeploymentOperation(tx, projectId);
          if (pendingOperation) {
            throw new RollbackError(409, `deploy in progress: ${pendingOperation.id}`);
          }
          const activeDeploy = await getActiveDeployment(tx, projectId);
          let ownsRollbackLease = false;
          if (activeDeploy && activeDeploy.id === rollbackLeaseId && activeDeploy.manifest) {
            try {
              const lease = JSON.parse(activeDeploy.manifest) as { ownerId?: unknown };
              ownsRollbackLease = lease.ownerId === rollbackOwnerId;
            } catch {
              // Decision: A corrupt or legacy lease isn't treated as owned.
            }
          }
          if (!ownsRollbackLease) {
            throw new RollbackError(
              409,
              `deploy in progress: ${activeDeploy?.id ?? rollbackLeaseId}`,
            );
          }

          const targetMigrations: Array<string> = target.applied_migrations
            ? JSON.parse(target.applied_migrations)
            : [];

          const projectMigrationNames = await getProjectMigrationNames(tx, projectId);
          const currentActive = lockedProject.active_deployment_id
            ? await getDeployment(tx, lockedProject.active_deployment_id)
            : null;
          const currentMigrations: Array<string> =
            projectMigrationNames.length > 0
              ? [...projectMigrationNames]
              : currentActive?.applied_migrations
                ? JSON.parse(currentActive.applied_migrations)
                : [];
          const diff = currentMigrations.filter((m) => !targetMigrations.includes(m));

          // Decision: Reject destructive rollbacks unless the caller opts in. `diff` holds migrations the current
          // active deployment ran that the target doesn't know (often forward-only DDL). Moving traffic to the
          // target then runs code that expects the old schema against the newer one and corrupts queries.
          // The opt-in is bound to a snapshot, not a boolean: the caller echoes the exact migration names
          // they were shown, and the server diff has to match that set exactly. This closes a TOCTOU where a
          // concurrent deploy changes the active deployment between the caller's preflight and this locked
          // re-read. The check runs before the pg flip and any external write, so a rejection changes nothing.
          if (diff.length > 0) {
            const confirmed = allowDestructive ?? [];
            const confirmedSet = new Set(confirmed);
            const snapshotMatches =
              confirmed.length === diff.length && diff.every((m) => confirmedSet.has(m));
            if (!snapshotMatches) {
              // Decision: Migration names are arbitrary non-empty strings (see /rename), so hand-quoted prose can make
              // invalid JSON hints. JSON.stringify the diff for the example, and expose it as
              // `destructiveMigrations` so callers echo the real array instead of parsing the message.
              throw new RollbackError(
                400,
                `Rollback is destructive: current deployment has migration(s) the target does not include: ${JSON.stringify(diff)}. Retry with \`allowDestructive: ${JSON.stringify(diff)}\` to confirm this exact set.`,
                diff,
              );
            }
          }

          const manifest: DeployManifest | null = target.manifest
            ? JSON.parse(target.manifest)
            : null;
          const dispatchLimits = computeDispatchLimits(
            await billedPlanLimits(tx, lockedAccess.owner, lockedProject),
            manifest?.limits,
          );
          // Decision: The external writes depend only on authoritative sources (the pg deployments table for queue
          // history; the target manifest plus unconditional DO reconciliation for crons), not on the possibly
          // stale currentActive manifest or the eagerly written resources table.
          const workerName = getProjectDeploymentWorkerName(lockedProject.slug, target.id);
          const existingRouting = await context.env.ROUTING.get(projectRouteKey(lockedProject));
          const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;
          const zeroTrust = await resolveProjectZeroTrustRouting(tx, projectId).catch(
            (error: unknown) => {
              const message = zeroTrustNotReadyMessage(error);
              throw message
                ? new RollbackError(409, 'zero trust not ready', undefined, message)
                : error;
            },
          );
          const targetType =
            manifest?.type ??
            (target.bundle_stored || manifest?.workerMain
              ? 'platform'
              : manifest?.static === 'spa'
                ? 'spa'
                : manifest?.static === 'ssg'
                  ? 'static'
                  : manifest?.assetConfig?.not_found_handling === 'single-page-application'
                    ? 'spa'
                    : manifest?.assetConfig?.not_found_handling === '404-page'
                      ? 'static'
                      : 'platform');
          const isStaticDeployment = targetType === 'static' || targetType === 'spa';
          let targetHasAssets = false;
          if (target.asset_hashes) {
            try {
              const assetHashes = JSON.parse(target.asset_hashes) as unknown;
              targetHasAssets =
                typeof assetHashes === 'object' &&
                assetHashes !== null &&
                Object.keys(assetHashes).length > 0;
            } catch {
              throw new RollbackError(400, 'target deployment has invalid asset metadata');
            }
          }

          let routingJson: string;
          if (isStaticDeployment) {
            const assetConfig = manifest?.assetConfig ?? {
              not_found_handling: targetType === 'spa' ? 'single-page-application' : '404-page',
            };
            routingJson = buildStaticRoutingJson({
              privatePreview: Boolean(project.preview_client_id),
              projectId,
              userId: lockedProject.user_id,
              deploymentId: target.id,
              assetConfig,
              manifest,
              suspended: existingEntry?.suspended,
              zeroTrust,
            });
          } else {
            routingJson = buildRoutingJson({
              privatePreview: Boolean(project.preview_client_id),
              workerName,
              projectId,
              userId: lockedProject.user_id,
              manifest,
              deploymentId: target.id,
              dispatchLimits,
              suspended: existingEntry?.suspended,
              hasCrons: !!manifest?.schedules?.length,
              assetManifestId: targetHasAssets ? target.id : undefined,
              assetConfig: targetHasAssets ? manifest?.assetConfig : undefined,
              zeroTrust,
            });
          }

          // Decision: pg flip first. If it throws, no external state has changed, the transaction rolls back and the
          // caller can retry.
          await updateProjectType(tx, projectId, targetType);
          await requestRotationIfReplacingUntrustedCode(tx, projectId, target.id);
          await setActiveDeployment(tx, projectId, target.id);

          const snapshottedRoutingKeys = new Set<string>();
          const snapshotRoutingKey = async (key: string): Promise<void> => {
            if (snapshottedRoutingKeys.has(key)) {
              return;
            }
            const previous = await context.env.ROUTING.get(key);
            snapshottedRoutingKeys.add(key);
            externalUndo.push(async (currentZeroTrust) => {
              if (!routingValuesWritten.has(key)) {
                return;
              }
              const undo = resolveRoutingUndo(
                await context.env.ROUTING.get(key),
                routingValuesWritten.get(key)!,
                previous,
              );
              if (!undo.restore) {
                return;
              }
              if (undo.value === null) {
                await context.env.ROUTING.delete(key);
              } else {
                await context.env.ROUTING.put(
                  key,
                  key === projectRouteKey(lockedProject) || key.startsWith('domain:')
                    ? withProjectZeroTrustRouting(undo.value, currentZeroTrust, lockedProject.id)
                    : undo.value,
                );
              }
            });
          };
          const putRouting = async (key: string, value: string): Promise<void> => {
            await snapshotRoutingKey(key);
            // Decision: Record before awaiting KV, so a write that committed but lost its acknowledgement is still in
            // the undo pass.
            routingValuesWritten.set(key, value);
            await context.env.ROUTING.put(key, value);
          };
          const deleteRouting = async (key: string): Promise<void> => {
            await snapshotRoutingKey(key);
            routingValuesWritten.set(key, null);
            await context.env.ROUTING.delete(key);
          };

          // Decision: External writes come second, inside the same lock. Each write is preceded by an exact snapshot
          // and compensated in reverse order before the transaction releases the project lock.
          try {
            await reconcileManagedDurableObjects(
              context.env,
              tx,
              projectId,
              target.id,
              manifest ?? null,
              (undo) => externalUndo.push(async () => undo()),
            );
            await putRouting(projectRouteKey(lockedProject), routingJson);

            // Decision: Resolve the target worker's __PLATFORM_PROXY_TOKEN once for both cron and queues. A second
            // lookup doubles CF API calls and widens the failure window: a transient 429 on it would abort the
            // transaction after cron state was already written to the DO. /__platform/scheduled and
            // /__platform/queue both check the same binding. The target may hold an older generation than the
            // issued one; its copies get the token it holds.
            const needsProxyToken = !!manifest?.schedules?.length || !!manifest?.queues?.length;
            const targetProxyToken = needsProxyToken
              ? await resolveRollbackProxyToken(context.env, workerName, projectId)
              : null;

            // Decision: When the target has no schedules, call `/clear` anyway (it's idempotent, see cron-scheduler.ts
            // `handleClear`). A failed earlier cutover can leave schedules in the DO that no manifest mentions,
            // and a guarded clear would let them persist across later rollbacks.
            const previousCronState = await snapshotCronScheduler(context.env, projectId);
            externalUndo.push(() =>
              restoreCronScheduler(context.env, projectId, previousCronState),
            );
            if (manifest?.schedules?.length) {
              await syncCronScheduler(context.env, projectId, {
                workerName,
                schedules: manifest.schedules,
                proxyToken: targetProxyToken!,
              });
            } else {
              await clearCronScheduler(context.env, projectId);
            }

            const projectDomains = await getDomainsByProjectId(tx, projectId);
            for (const domain of projectDomains) {
              if (domain.status === 'active') {
                await putRouting(`domain:${domain.hostname}`, routingJson);
              }
            }

            // Decision: Rewrite each queue route the target binds and delete queue routes from older deployments that
            // the target doesn't bind. Otherwise messages on a queue the old deployment bound would still hit
            // `queue:<q>` in KV and go to an evicted worker.
            // The sweep covers deployments that were ever live (`deployed_at IS NOT NULL`) and terminal
            // failed/canceled ones, which can have written `queue:<name>` routes at step 2b before failing.
            // In-flight deploys are left out, so rollback doesn't clobber routes they're provisioning.
            const [activatedDeployments, terminalFailedDeployments] = await Promise.all([
              getActivatedDeployments(tx, projectId),
              getTerminalFailedDeployments(tx, projectId),
            ]);
            const sweepQueueNames = new Set<string>();
            const unionSource = [...activatedDeployments, ...terminalFailedDeployments];
            for (const d of unionSource) {
              if (!d.manifest) {
                continue;
              }
              let depManifest: DeployManifest | null = null;
              try {
                depManifest = JSON.parse(d.manifest);
              } catch {
                // Decision: Skip deployments with unparseable manifests instead of failing the whole rollback.
                continue;
              }
              for (const q of depManifest?.queues ?? []) {
                sweepQueueNames.add(q.name);
              }
            }
            // Decision: Add the target's own queue names to the union so the delete pass (union minus target) can't
            // delete a route we're about to rewrite.
            const targetQueueNames = new Set((manifest?.queues ?? []).map((q) => q.name));
            for (const name of targetQueueNames) {
              sweepQueueNames.add(name);
            }
            const queueResources = await getProjectResources(tx, projectId);
            const dispatchWorkerName = context.env.DISPATCH_WORKER_NAME ?? 'platform-dispatch';
            const queueResourceByName = new Map(
              queueResources
                .filter((resource) => resource.type === 'queue')
                .map((resource) => [resource.binding_name, resource] as const),
            );
            for (const name of sweepQueueNames) {
              const resource = queueResourceByName.get(name);
              if (!resource) {
                if (targetQueueNames.has(name)) {
                  throw new RollbackError(400, `target queue resource is missing: ${name}`);
                }
                continue;
              }
              const previousConsumer = await snapshotQueueConsumer(
                context.env.CF_ACCOUNT_ID,
                context.env.CF_API_TOKEN,
                resource.cf_id,
                dispatchWorkerName,
              );
              externalUndo.push(() =>
                restoreQueueConsumer(
                  context.env.CF_ACCOUNT_ID,
                  context.env.CF_API_TOKEN,
                  resource.cf_id,
                  dispatchWorkerName,
                  previousConsumer,
                ),
              );
              const targetQueue = manifest?.queues?.find((queue) => queue.name === name);
              if (targetQueue) {
                const consumer = await addQueueConsumer(
                  context.env.CF_ACCOUNT_ID,
                  context.env.CF_API_TOKEN,
                  resource.cf_id,
                  dispatchWorkerName,
                  {
                    ...(targetQueue.maxBatchSize != null && {
                      batch_size: targetQueue.maxBatchSize,
                    }),
                    ...(targetQueue.maxBatchTimeout != null && {
                      max_wait_time_ms: targetQueue.maxBatchTimeout * 1000,
                    }),
                    ...(targetQueue.maxRetries != null && {
                      max_retries: targetQueue.maxRetries,
                    }),
                    ...(targetQueue.maxConcurrency != null && {
                      max_concurrency: targetQueue.maxConcurrency,
                    }),
                    ...(targetQueue.retryDelay != null && {
                      retry_delay: targetQueue.retryDelay,
                    }),
                  },
                );
                if (consumer.status === 'conflict') {
                  throw new Error(
                    `queue consumer conflict: ${name} owned by ${consumer.ownerScript}`,
                  );
                }
              } else {
                await removeQueueConsumer(
                  context.env.CF_ACCOUNT_ID,
                  context.env.CF_API_TOKEN,
                  resource.cf_id,
                  dispatchWorkerName,
                );
              }
            }
            if (manifest?.queues?.length) {
              for (const q of manifest.queues) {
                await putRouting(
                  `queue:${getProjectQueueName(projectId, q.name)}`,
                  JSON.stringify({
                    workerName,
                    projectId,
                    queueName: q.name,
                    proxyToken: targetProxyToken!,
                  }),
                );
              }
            }
            for (const name of sweepQueueNames) {
              if (targetQueueNames.has(name)) {
                continue;
              }
              await deleteRouting(`queue:${getProjectQueueName(projectId, name)}`);
            }
          } catch (externalError) {
            const compensationErrors: Array<unknown> = [];
            for (const undo of externalUndo.reverse()) {
              try {
                await undo(zeroTrust);
              } catch (compensationError) {
                compensationErrors.push(compensationError);
              }
            }
            if (compensationErrors.length > 0) {
              throw new AggregateError(
                [externalError, ...compensationErrors],
                'rollback failed and external state compensation was incomplete',
              );
            }
            externalCompensated = true;
            throw externalError;
          }

          // Decision: This owned lease transition commits atomically with the project flip and is the durable
          // witness when the COMMIT acknowledgement is ambiguous. `active_deployment_id` alone isn't enough
          // when the target was already active before this transaction.
          const witnessed = await updateRollbackLeaseState(
            tx,
            rollbackLeaseId!,
            deploymentId,
            'applied',
            rollbackOwnerId,
            rollbackOwnerId,
            diff,
          );
          if (!witnessed) {
            throw new Error('rollback lease ownership was lost before commit');
          }
          rollbackResultCandidate = { migrationDiff: diff };
          return rollbackResultCandidate;
        });
        rollbackCommitted = true;
      }
    } catch (err) {
      // Decision: The COMMIT acknowledgement can be lost after PostgreSQL applied the flip. The owned lease's
      // `applied` transition commits in the same transaction and is the witness, including when the
      // target was already active. A lease still `running` proves the transaction didn't commit.
      let ambiguousCommitOutcome: 'committed' | 'not_committed' | 'unknown' | undefined;
      if (!rollbackCommitted && !externalCompensated && externalUndo.length > 0) {
        let durableReadSucceeded = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const latestLease = rollbackLeaseId
              ? await getDeployment(context.get('db'), rollbackLeaseId)
              : null;
            durableReadSucceeded = true;
            if (latestLease?.source === 'rollback-lease' && latestLease.manifest) {
              const lease = JSON.parse(latestLease.manifest) as {
                targetDeploymentId?: unknown;
                state?: unknown;
                ownerId?: unknown;
              };
              if (lease.targetDeploymentId === deploymentId && lease.ownerId === rollbackOwnerId) {
                ambiguousCommitOutcome = lease.state === 'applied' ? 'committed' : 'not_committed';
                break;
              }
            }
          } catch {
            // Decision: Keep state on an unreadable outcome; the original error is still the one returned below.
          }
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
          }
        }
        ambiguousCommitOutcome ??= durableReadSucceeded ? 'not_committed' : 'unknown';
      }

      if (ambiguousCommitOutcome === 'committed' && rollbackResultCandidate) {
        rollbackCommitted = true;
        rollbackResult = rollbackResultCandidate;
      }

      if (!rollbackCommitted && !externalCompensated && externalUndo.length > 0) {
        if (ambiguousCommitOutcome === 'not_committed') {
          const compensationErrors: Array<unknown> = [];
          try {
            await context.get('db').transaction(async (tx) => {
              await tx.execute(
                drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`,
              );
              const activeLease = await getActiveDeployment(tx, projectId);
              let stillOwnsLease = false;
              if (activeLease && activeLease.id === rollbackLeaseId && activeLease.manifest) {
                try {
                  const lease = JSON.parse(activeLease.manifest) as { ownerId?: unknown };
                  stillOwnsLease = lease.ownerId === rollbackOwnerId;
                } catch {
                  // Decision: Corrupt or replaced ownership suppresses the stale undo.
                }
              }
              if (!stillOwnsLease) {
                return;
              }
              const zeroTrust = await resolveProjectZeroTrustRoutingForPublication(tx, projectId);
              for (const undo of [...externalUndo].reverse()) {
                try {
                  await undo(zeroTrust);
                } catch (compensationError) {
                  compensationErrors.push(compensationError);
                }
              }

              // Decision: A domain activation can commit after the failed rollback released the project lock but before
              // this compensation took it. That hostname wasn't in the snapshot, and activation may have copied
              // the target's temporary slug route into its domain key. Reconcile all current domains to the
              // restored slug route before releasing the lease. Delete pending rows too: KV may have been written
              // just before activation's final status update was interrupted.
              let restoredProjectRouting: string | null = null;
              try {
                const rawRouting = await context.env.ROUTING.get(projectRouteKey(project));
                restoredProjectRouting =
                  rawRouting === null
                    ? null
                    : withProjectZeroTrustRouting(rawRouting, zeroTrust, projectId);
              } catch (compensationError) {
                compensationErrors.push(compensationError);
              }
              for (const domain of await getDomainsByProjectId(tx, projectId)) {
                try {
                  if (domain.status === 'active' && restoredProjectRouting !== null) {
                    await context.env.ROUTING.put(
                      `domain:${domain.hostname}`,
                      restoredProjectRouting,
                    );
                  } else {
                    await context.env.ROUTING.delete(`domain:${domain.hostname}`);
                  }
                } catch (compensationError) {
                  compensationErrors.push(compensationError);
                }
              }
            });
          } catch (compensationTransactionError) {
            // Decision: This includes failing to take or commit the lock and DB reads inside it. None of these prove
            // compensation finished, so the rollback lease stays as a fail-closed fence.
            compensationErrors.push(compensationTransactionError);
          }
          if (compensationErrors.length > 0) {
            releaseRollbackLease = false;
            if (rollbackLeaseId) {
              await updateRollbackLeaseState(
                context.get('db'),
                rollbackLeaseId,
                deploymentId,
                'retryable',
                rollbackOwnerId,
                rollbackOwnerId,
              ).catch(() => {
                // Decision: The owned running lease is still a fail-closed fence when the retryable state write fails.
              });
            }
            throw new AggregateError(
              [err, ...compensationErrors],
              'rollback transaction failed and external state compensation was incomplete',
            );
          }
        } else if (ambiguousCommitOutcome === 'unknown') {
          releaseRollbackLease = false;
          // Decision: Don't overwrite the witness while PostgreSQL is unreadable. An `applied` lease lets a retry
          // finish as success; a `running` lease stays a fail-closed fence until it's reconciled.
        }
      }
      if (!rollbackCommitted) {
        // Decision: An adopted lease stands for an earlier rollback whose PostgreSQL outcome was unreadable while
        // external state may already point at the target. A failed retry snapshots that possibly divergent
        // state, so even a good compensation can't prove it matches PostgreSQL. Keep the fence until a retry
        // confirms the target as active.
        if (rollbackLeaseId && adoptedRollbackLease && ambiguousCommitOutcome !== 'unknown') {
          releaseRollbackLease = false;
          await updateRollbackLeaseState(
            context.get('db'),
            rollbackLeaseId,
            deploymentId,
            'retryable',
            rollbackOwnerId,
            rollbackOwnerId,
          ).catch(() => {
            // Decision: A failed state write leaves the lease `running`, a stronger non-adoptable fence until its stale
            // timeout passes.
          });
        }
      }
      if (!rollbackCommitted && err instanceof RollbackError) {
        if (err.destructiveMigrations) {
          rollbackErrorResponse = context.json(
            { error: err.message, destructiveMigrations: err.destructiveMigrations },
            err.status,
          );
        } else {
          rollbackErrorResponse = context.json(
            { error: err.message, ...(err.userMessage ? { message: err.userMessage } : {}) },
            err.status,
          );
        }
      } else if (!rollbackCommitted) {
        rollbackErrorToThrow = err;
      }
    } finally {
      if (rollbackLeaseId && releaseRollbackLease) {
        let releaseError: unknown;
        let releaseAttemptCompleted = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await deleteRollbackLease(context.get('db'), rollbackLeaseId, rollbackOwnerId);
            releaseAttemptCompleted = true;
            break;
          } catch (error) {
            releaseError = error;
            if (attempt < 2) {
              await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
            }
          }
        }
        if (!releaseAttemptCompleted) {
          await updateRollbackLeaseState(
            context.get('db'),
            rollbackLeaseId,
            deploymentId,
            'retryable',
            rollbackOwnerId,
            rollbackOwnerId,
          ).catch(() => {
            // Decision: Keep the running fence if PostgreSQL stays unavailable.
          });
          leaseReleaseError = new AggregateError(
            [releaseError],
            'rollback finished but its project lease could not be released; retry the rollback',
          );
        }
      }
    }

    if (leaseReleaseError) {
      throw leaseReleaseError;
    }
    if (rollbackErrorResponse) {
      return rollbackErrorResponse;
    }
    if (rollbackErrorToThrow !== undefined) {
      throw rollbackErrorToThrow;
    }
    if (!rollbackResult) {
      throw new Error('rollback completed without a result');
    }
    return context.json({
      ok: true,
      deploymentId,
      migrationDiff: rollbackResult.migrationDiff,
    });
  })

  .get('/:id/migrations', async (context) => {
    const access = await requireProjectRouteCapability(context, context.req.param('id'), 'read');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;

    const resources = await getProjectResources(context.get('db'), project.id);
    const requestedDialect = context.req.query('dialect');
    if (
      requestedDialect !== undefined &&
      requestedDialect !== 'sqlite' &&
      requestedDialect !== 'postgresql' &&
      requestedDialect !== 'mysql'
    ) {
      return context.json({ error: 'invalid dialect, must be sqlite, postgresql, or mysql' }, 400);
    }

    if (
      requestedDialect === 'postgresql' ||
      requestedDialect === 'mysql' ||
      (requestedDialect === undefined &&
        resources.some((r) => r.type === 'hyperdrive') &&
        !resources.some((r) => r.type === 'd1'))
    ) {
      const applied = await getProjectMigrationRows(context.get('db'), project.id);
      return context.json({ applied });
    }

    const d1Resource = resources.find((r) => r.type === 'd1');
    if (!d1Resource) {
      return context.json({ applied: [] });
    }

    // Decision: Read _migrations before _void_migrations, to be safe during an in-flight legacy upgrade. The
    // upgrade is three non-atomic D1 calls: CREATE TABLE _void_migrations, INSERT OR IGNORE ... FROM
    // _migrations, DROP TABLE _migrations. Reading the new table first can see it empty, then race past
    // the DROP and find _migrations gone too, returning `{ applied: [] }`. _migrations only disappears
    // after its rows were copied, so if the legacy read fails, _void_migrations is authoritative.
    // Dedup is last-write-wins by name, and _void_migrations is read second so its timestamps win.
    const byName = new Map<string, string>();

    try {
      const legacy = await queryD1(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        d1Resource.cf_id,
        {
          sql: 'SELECT name, applied_at FROM _migrations ORDER BY name',
        },
      );
      for (const r of legacy.results) {
        byName.set(r.name as string, r.applied_at as string);
      }
    } catch (err) {
      if (!isMissingTableError(err)) {
        return context.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    try {
      const result = await queryD1(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        d1Resource.cf_id,
        {
          sql: 'SELECT name, applied_at FROM _void_migrations ORDER BY name',
        },
      );
      for (const r of result.results) {
        byName.set(r.name as string, r.applied_at as string);
      }
    } catch (err) {
      if (!isMissingTableError(err)) {
        return context.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    const applied = Array.from(byName, ([name, applied_at]) => ({ name, applied_at })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    return context.json({ applied });
  })

  .post('/:id/migrations/apply', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'configure');
    if (access instanceof Response) {
      return access;
    }

    const body = await context.req.json<{
      migrations: ReadonlyArray<{ name: string; sql: string }>;
      migrationProtocolVersion?: number;
      executionPlans?: ReadonlyArray<Record<string, unknown>>;
    }>();
    if (!body.migrations || !Array.isArray(body.migrations)) {
      return context.json({ error: 'migrations array required' }, 400);
    }
    const invalidEntry = body.migrations.find(
      (m) => typeof m.name !== 'string' || !m.name || typeof m.sql !== 'string',
    );
    if (invalidEntry) {
      return context.json(
        { error: 'each migration must have a non-empty string "name" and string "sql"' },
        400,
      );
    }
    const nameSet = new Set<string>();
    for (const m of body.migrations) {
      if (nameSet.has(m.name)) {
        return context.json({ error: `duplicate migration name: ${m.name}` }, 400);
      }
      nameSet.add(m.name);
    }
    const planValidationError = await validateSubmittedExecutionPlans(
      body.migrations,
      body.executionPlans,
    );
    if (planValidationError) {
      return context.json({ error: planValidationError }, 400);
    }

    // Decision: Serialize /apply and /rename per project with a transaction-scoped row lock on `projects`. This
    // holds a pg connection across remote D1 HTTP calls, which costs pool capacity, but these are
    // low-QPS operator flows and correctness comes first. Without it, an /apply that landed in D1 but
    // hasn't yet written pg metadata can be overtaken by a /rename whose snapshot misses that row, and
    // D1 and pg stay diverged.
    try {
      const outcome = await context.get('db').transaction(async (tx) => {
        // Decision: The row lock has to be the first statement so later reads and writes serialize against a
        // concurrent /apply, /rename or /rollback.
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const lockedAccess = await requireProjectRouteCapability(
          context,
          projectId,
          'configure',
          tx,
        );
        if (lockedAccess instanceof Response) {
          return {
            status: lockedAccess.status as 403 | 404,
            body: await getProjectAccessErrorBody(lockedAccess),
          };
        }

        const resources = await getProjectResources(tx, projectId);
        const d1Resource = resources.find((r) => r.type === 'd1');
        if (!d1Resource) {
          return { status: 400 as const, body: { error: 'no D1 database found for this project' } };
        }

        const applied = await ensureTrackingTable(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          d1Resource.cf_id,
        );
        const pending = body.migrations.filter((m) => !applied.has(m.name));

        const violations = hasUnauthorizedDestructive(pending);
        if (violations.length > 0) {
          return {
            status: 400 as const,
            body: {
              ok: false,
              error: `Destructive migrations without pragma: ${violations.join(', ')}. Add "${DESTRUCTIVE_PRAGMA}" to allow.`,
            },
          };
        }

        const result = await runRemoteMigrations(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          d1Resource.cf_id,
          body.migrations,
          applied,
        );

        // Decision: Use the project read under the lock, so active_deployment_id reflects a rollback or setActive
        // that committed while we waited.
        const locked = lockedAccess.project;
        // Decision: Append applied and skipped names, not only applied. If an earlier /apply landed in D1 but the
        // pg write failed, a retry sees the name as `skipped`; gating on `applied` would leave pg missing it
        // and corrupt later rollback diffs and renames. appendAppliedMigrations de-dupes, so known names are
        // a no-op, and this lets a retry heal pg from D1's `_void_migrations`.
        // When a mid-batch migration fails, the runner returns the committed prefix; persist it in this
        // locked transaction so a retry heals. Return a non-200 outcome instead of throwing: `return`
        // commits the heal, `throw` rolls it back.
        const effectiveNames = [...result.applied, ...result.skipped];
        if (effectiveNames.length > 0) {
          await appendProjectMigrations(
            tx,
            projectId,
            effectiveNames,
            locked.active_deployment_id ?? undefined,
          );
        }
        if (effectiveNames.length > 0 && locked.active_deployment_id) {
          await appendAppliedMigrations(tx, locked.active_deployment_id, effectiveNames);
        }

        if (result.failed) {
          const responseBody: Record<string, unknown> = {
            ok: false,
            error: `migration ${result.failed.name} failed: ${result.failed.error}`,
            applied: result.applied,
            skipped: result.skipped,
            failed: result.failed,
          };
          if (body.migrationProtocolVersion === 2) {
            responseBody.migration_protocol = 'legacy';
            responseBody.migration_stability = 'legacy';
          }
          return {
            status: 500 as const,
            body: responseBody,
          };
        }

        const responseBody: Record<string, unknown> = {
          ok: true,
          applied: result.applied,
          skipped: result.skipped,
        };
        if (body.migrationProtocolVersion === 2) {
          responseBody.migration_protocol = 'legacy';
          responseBody.migration_stability = 'legacy';
          responseBody.warnings = [
            'Remote D1 REST migrations use the legacy compensating runner; deploy-time worker protocol v2 provides the stable migration contract.',
          ];
        }
        return {
          status: 200 as const,
          body: responseBody,
        };
      });
      return context.json(outcome.body, outcome.status);
    } catch (err) {
      return context.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  })

  .post('/:id/migrations/rename', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'configure');
    if (access instanceof Response) {
      return access;
    }

    const body = await context.req.json<{ renames: ReadonlyArray<{ from: string; to: string }> }>();
    if (!body.renames || !Array.isArray(body.renames) || body.renames.length === 0) {
      return context.json({ error: 'renames array required' }, 400);
    }
    const invalidRename = body.renames.find(
      (r) => typeof r.from !== 'string' || !r.from || typeof r.to !== 'string' || !r.to,
    );
    if (invalidRename) {
      return context.json({ error: 'each rename must have non-empty string "from" and "to"' }, 400);
    }

    // Decision: The remote UPDATEs aren't atomic, so a PK collision mid-batch leaves `_void_migrations`
    // half-renamed with no rollback. Rejecting ambiguous or self-conflicting batches up front means a
    // clean DB can't hit a collision mid-batch.
    const fromSet = new Set<string>();
    const toSet = new Set<string>();
    for (const { from } of body.renames) {
      if (fromSet.has(from)) {
        return context.json({ error: 'duplicate "from" in rename batch' }, 400);
      }
      fromSet.add(from);
    }
    for (const { to } of body.renames) {
      if (toSet.has(to)) {
        return context.json({ error: 'duplicate "to" in rename batch' }, 400);
      }
      toSet.add(to);
    }
    // Decision: Chains and cycles (`a→b, b→c` or `a→b, b→a`) would need two-phase renames across non-atomic D1
    // calls. Rejecting them makes the caller split the work and keeps this path linear.
    for (const { to } of body.renames) {
      if (fromSet.has(to)) {
        return context.json(
          {
            error:
              'rename "to" conflicts with another rename "from" in batch — chains not supported',
          },
          400,
        );
      }
    }

    // Decision: Hold the per-project row lock across the D1 calls. That prevents the interleave where /apply
    // writes a D1 row, /rename snapshots D1 and rewrites pg without it, and /apply then appends the
    // pre-rename name to pg.
    try {
      const outcome = await context.get('db').transaction(async (tx) => {
        // Decision: The row lock has to be the first statement so later reads and writes serialize against a
        // concurrent /apply, /rename or /rollback.
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const lockedAccess = await requireProjectRouteCapability(
          context,
          projectId,
          'configure',
          tx,
        );
        if (lockedAccess instanceof Response) {
          return {
            status: lockedAccess.status as 403 | 404,
            body: {
              ok: false,
              ...(await getProjectAccessErrorBody(lockedAccess)),
            },
          };
        }

        const resources = await getProjectResources(tx, projectId);
        const d1Resource = resources.find((r) => r.type === 'd1');
        if (!d1Resource) {
          return { status: 400 as const, body: { error: 'no D1 database found for this project' } };
        }

        const existing = await ensureTrackingTable(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          d1Resource.cf_id,
        );

        // Decision: These rules make retries after a partial failure safe, not only fresh batches:
        // - unknown from, unknown to: 400 (operator error)
        // - unknown from, known to: an already-landed rename only when pg still references `from` (a retry
        // after D1 succeeded and pg failed); otherwise 400
        // - known from, known to: 400 (would collide; chains are already rejected)
        // - known from, unknown to: proceed
        const missingFrom: Array<string> = [];
        const collidingTo: Array<string> = [];
        const effective: Array<{ from: string; to: string }> = [];
        const alreadyLanded: Array<{ from: string; to: string }> = [];
        for (const { from, to } of body.renames) {
          const fromExists = existing.has(from);
          const toExists = existing.has(to);
          if (!fromExists && !toExists) {
            missingFrom.push(from);
            continue;
          }
          if (!fromExists && toExists) {
            // Decision: Don't treat `!fromExists && toExists` as a retry by default: a request naming an unrelated
            // existing migration would rewrite pg to the wrong target. A real retry after D1 succeeded and pg
            // failed looks like: D1 has `to`, D1 lacks `from`, and pg still has `from` on the active deployment
            // (older retained rows aren't trusted).
            // The `migration_renames` audit log is a second source: a partial-failure heal already rewrote the
            // active deployment, so a same-payload retry needs it to pass the committed prefix, or the operator
            // is stuck. The log is written in the same locked transaction as the heal, so a matching row proves
            // this exact (project_id, from, to) rename committed here.
            const stalePg = await activeDeploymentContainsMigration(tx, projectId, from);
            const auditLogged = stalePg
              ? false
              : await migrationRenameExists(tx, projectId, from, to);
            if (!stalePg && !auditLogged) {
              return {
                status: 400 as const,
                body: {
                  ok: false,
                  error:
                    `rename "${from}" → "${to}" is ambiguous: D1 already has "${to}" and no deployment ` +
                    `metadata references "${from}". Refusing to rewrite metadata without corroboration.`,
                },
              };
            }
            // Decision: An already-landed rename is a no-op in D1, but record the pair so stale pg metadata gets
            // rewritten.
            alreadyLanded.push({ from, to });
            continue;
          }
          if (fromExists && toExists) {
            collidingTo.push(to);
            continue;
          }
          effective.push({ from, to });
        }
        if (missingFrom.length > 0) {
          return {
            status: 400 as const,
            body: { error: `unknown "from" migration(s): ${missingFrom.join(', ')}` },
          };
        }
        if (collidingTo.length > 0) {
          return {
            status: 400 as const,
            body: { error: `"to" migration(s) already exist: ${collidingTo.join(', ')}` },
          };
        }

        // Decision: After validation, a clean-DB batch can't hit a PK collision. A network failure mid-batch can
        // leave partial state, but a same-payload retry is safe because validation skips landed renames.
        // Check meta.changes on each UPDATE: when two concurrent renames pass validation for the same
        // `from`, the loser sees 0 changes. Re-query to classify it: if `to` is present and `from` is gone,
        // the winner reached the same state (treat as landed); otherwise return 409 and don't forward the
        // pair.
        // Persist committed pairs to pg even when a later pair fails: their D1 UPDATEs are durable, and a
        // throw would roll back the pg rewrite. So stop the loop on a failure (going on risks misclassifying
        // against the winner's rows), persist the prefix in this locked transaction, and `return` a 409/500.
        // `return` commits the heal; `throw` rolls it back.
        const committed: Array<{ from: string; to: string }> = [...alreadyLanded];
        type PairFailure =
          | { kind: 'conflict'; from: string; to: string }
          | { kind: 'error'; from: string; to: string; error: string };
        let pairFailure: PairFailure | undefined;
        for (const { from, to } of effective) {
          let update: Awaited<ReturnType<typeof queryD1>>;
          try {
            update = await queryD1(
              context.env.CF_ACCOUNT_ID,
              context.env.CF_API_TOKEN,
              d1Resource.cf_id,
              {
                sql: 'UPDATE _void_migrations SET name = ? WHERE name = ?',
                params: [to, from],
              },
            );
          } catch (err) {
            pairFailure = {
              kind: 'error',
              from,
              to,
              error: err instanceof Error ? err.message : String(err),
            };
            break;
          }
          if ((update.meta?.changes ?? 1) > 0) {
            committed.push({ from, to });
            continue;
          }
          let recheck: Awaited<ReturnType<typeof queryD1>>;
          try {
            recheck = await queryD1(
              context.env.CF_ACCOUNT_ID,
              context.env.CF_API_TOKEN,
              d1Resource.cf_id,
              {
                sql: 'SELECT name FROM _void_migrations WHERE name = ? OR name = ?',
                params: [from, to],
              },
            );
          } catch (err) {
            pairFailure = {
              kind: 'error',
              from,
              to,
              error: err instanceof Error ? err.message : String(err),
            };
            break;
          }
          const names = new Set(recheck.results.map((r) => r.name as string));
          if (!names.has(from) && names.has(to)) {
            committed.push({ from, to });
            continue;
          }
          pairFailure = { kind: 'conflict', from, to };
          break;
        }

        // Decision: Rewrite applied_migrations for each deployment of the project, not only the active one:
        // retained and inactive deployments would keep old names and break rollback diffs. Only committed
        // or already-landed pairs get here. It runs before any pair failure is returned, so the prefix
        // commits with the `return`.
        // The `migration_renames` audit row lets a same-payload retry treat committed pairs as idempotent,
        // since this rewrite removes `from` from the active deployment.
        // Before recording a pair, invalidate older audit rows whose `to_name` is this pair's `from`: `from`
        // is being renamed away, and a retry quoting a recycled lineage mustn't be backed by the stale row.
        // All three run in the same locked transaction, so a rollback undoes them together.
        if (committed.length > 0) {
          await renameProjectMigrations(tx, projectId, committed);
          await renameAppliedMigrationsForProject(tx, projectId, committed);
          for (const { from } of committed) {
            await invalidateMigrationRenamesForOldName(tx, projectId, from);
          }
          await recordMigrationRenames(tx, projectId, committed);
        }

        if (pairFailure) {
          if (pairFailure.kind === 'conflict') {
            return {
              status: 409 as const,
              body: {
                ok: false,
                error: `rename conflict: "${pairFailure.from}" was concurrently renamed to a different target`,
                committed,
              },
            };
          }
          return {
            status: 500 as const,
            body: {
              ok: false,
              error: `rename "${pairFailure.from}" → "${pairFailure.to}" failed: ${pairFailure.error}`,
              committed,
            },
          };
        }

        return { status: 200 as const, body: { ok: true } };
      });
      return context.json(outcome.body, outcome.status);
    } catch (err) {
      return context.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  })

  .get('/:id/logs', async (context) => {
    const access = await requireProjectRouteCapability(context, context.req.param('id'), 'read');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;

    const since = context.req.query('since') ?? '1h';
    const sinceMs = parseDuration(since);
    if (sinceMs === null) {
      return context.json({ error: 'invalid since parameter, use format like 15m, 2h, 3d' }, 400);
    }

    const limit = parseAnalyticsLimit(context.req.query('limit'));
    if (limit === null) {
      return context.json({ error: 'invalid limit parameter, use a positive integer' }, 400);
    }
    const deploymentId = context.req.query('deploymentId');
    if (deploymentId && !/^dpl_[0-9a-z]+$/.test(deploymentId)) {
      return context.json({ error: 'invalid deploymentId format' }, 400);
    }

    // Decision: Filter by level in the AE SQL, so sparse error rows aren't hidden behind successful calls by the
    // LIMIT. 'all' means no filter. Other values have to be in the fixed allowlist (an allowlist, not a
    // regex, so later code can't widen it and let a tainted value reach the SQL string).
    const levelParam = context.req.query('level');
    const ALLOWED_LEVELS = ['error', 'warn', 'info', 'log', 'debug'] as const;
    type LogLevel = (typeof ALLOWED_LEVELS)[number];
    let level: LogLevel | null = null;
    if (levelParam !== undefined && levelParam !== 'all') {
      if (!(ALLOWED_LEVELS as ReadonlyArray<string>).includes(levelParam)) {
        return context.json(
          {
            error: `invalid level parameter, must be one of: error, warn, info, log, debug, all`,
          },
          400,
        );
      }
      level = levelParam as LogLevel;
    }

    const workerName = `user-${project.slug}`;
    // Decision: A slug can be reused after deletion, so rows from before this project existed belong to an
    // earlier owner.
    const createdAtMs = databaseTimestampMs(project.created_at) ?? 0;
    const startMs = Math.max(Date.now() - sinceMs, createdAtMs);
    const sinceStr = new Date(startMs).toISOString().replace('T', ' ').slice(0, 19);
    const dataset = context.env.LOGS_DATASET ?? 'platform_logs';

    const deployFilter = deploymentId ? `\n        AND blob7 = '${deploymentId}'` : '';
    let levelFilter = '';
    if (level === 'error') {
      // Decision: Catch non-ok outcomes (blob1), captured exceptions (blob3 not '[]'), console.error logs (blob2
      // level "error") and 5xx responses (blob6) even when the worker neither threw nor logged.
      levelFilter = `\n        AND (blob1 != 'ok' OR blob3 != '[]' OR blob2 LIKE '%"level":"error"%' OR blob6 LIKE '5%')`;
    } else if (level !== null) {
      levelFilter = `\n        AND blob2 LIKE '%"level":"${level}"%'`;
    }

    // Decision: `timestamp` is when the row was written, in whole seconds, and keeps the scan short. An earlier
    // owner's invocation can start before this project was created and be written after, so also bound
    // its start time (`double1`, in ms).
    const query = `
      SELECT
        blob1 as outcome,
        blob2 as logData,
        blob3 as exceptionData,
        blob4 as url,
        blob5 as method,
        blob6 as statusCode,
        blob7 as deployId,
        double1 as ts,
        min(timestamp) as ingestedAt
      FROM ${dataset}
      WHERE index1 = '${workerName}'
        AND timestamp >= toDateTime('${sinceStr}')
        AND double1 >= ${createdAtMs}${deployFilter}${levelFilter}
      ${LOG_ROW_GROUP_BY}
      ORDER BY ingestedAt DESC
      LIMIT ${limit}
    `;

    const response = await queryAnalyticsEngine(
      context.env.CF_ACCOUNT_ID,
      context.env.CF_API_TOKEN,
      query,
    );

    const responseText = await response.text();
    if (!response.ok) {
      console.error(
        `[logs] query failed for project ${project.id} (${response.status}): ${responseText.slice(0, 500)}`,
      );
      return context.json(
        { error: 'log query failed', status: response.status, detail: responseText.slice(0, 500) },
        502,
      );
    }

    // Decision: CF's Analytics Engine API can return an HTML error page with a 2xx during edge incidents. Parse
    // defensively so the handler returns 502 instead of an uncaught SyntaxError that Hono maps to 500.
    let result: {
      data: ReadonlyArray<{
        outcome: string;
        logData: string;
        exceptionData: string;
        url: string;
        method: string;
        statusCode: string;
        ts: number;
      }>;
    };
    try {
      result = JSON.parse(responseText) as typeof result;
    } catch {
      console.error(
        `[logs] non-JSON response for project ${project.id} (${response.status} ${response.headers.get('content-type') ?? 'unknown'}): ${responseText.slice(0, 500)}`,
      );
      return context.json(
        {
          error: 'log query returned non-JSON response',
          status: response.status,
          detail: responseText.slice(0, 500),
        },
        502,
      );
    }

    // Decision: Query newest-first to match the admin log path, then return entries oldest-first for the CLI.
    const data = [...(result.data ?? [])].reverse().map((row) => ({
      timestamp: row.ts,
      outcome: row.outcome,
      logs: tryParse(row.logData),
      exceptions: tryParse(row.exceptionData),
      url: row.url,
      method: row.method,
      status: row.statusCode,
    }));

    return context.json({ data, ...runtimeLogsField(context.env) });
  })
  // Decision: Unlike /logs (user-worker tail rows only), this reads the dispatch request-metering dataset, so
  // it also shows 5xx that dispatch made itself (missing manifest, static or SSR timeouts) and requests
  // to static or SPA projects that don't run a worker.
  .get('/:id/requests', async (context) => {
    const access = await requireProjectRouteCapability(context, context.req.param('id'), 'read');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;

    const since = context.req.query('since') ?? '1h';
    const sinceMs = parseDuration(since);
    if (sinceMs === null) {
      return context.json({ error: 'invalid since parameter, use format like 15m, 2h, 3d' }, 400);
    }

    const limit = parseAnalyticsLimit(context.req.query('limit'));
    if (limit === null) {
      return context.json({ error: 'invalid limit parameter, use a positive integer' }, 400);
    }

    // Decision: The status filter takes a class like `5xx` (LIKE '5%') or an exact 3-digit code. It's validated
    // so no tainted value reaches the SQL string.
    const statusParam = context.req.query('status');
    let statusFilter = '';
    if (statusParam !== undefined && statusParam !== 'all') {
      if (/^[1-5]xx$/.test(statusParam)) {
        statusFilter = `\n        AND blob4 LIKE '${statusParam[0]}%'`;
      } else if (/^[1-5]\d{2}$/.test(statusParam)) {
        // Decision: Bound the range so a typo like `600` is an error instead of matching nothing.
        statusFilter = `\n        AND blob4 = '${statusParam}'`;
      } else {
        return context.json(
          { error: 'invalid status parameter, use a class like 5xx or an exact code like 500' },
          400,
        );
      }
    }

    const sinceStr = new Date(Date.now() - sinceMs).toISOString().replace('T', ' ').slice(0, 19);
    const dataset = getRequestsDataset(context.env);

    // Decision: platform_requests columns (see dispatch recordRequest): blob2 type, blob3 method, blob4 status,
    // blob5 slug; double2 responseBytes, double3 durationMs.
    const query = `
      SELECT
        blob2 as type,
        blob3 as method,
        blob4 as status,
        double2 as bytes,
        double3 as durationMs,
        timestamp
      FROM ${dataset}
      WHERE blob1 = '${project.id}'
        AND timestamp >= toDateTime('${sinceStr}')${statusFilter}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;

    const response = await queryAnalyticsEngine(
      context.env.CF_ACCOUNT_ID,
      context.env.CF_API_TOKEN,
      query,
    );

    const responseText = await response.text();
    if (!response.ok) {
      console.error(
        `[requests] query failed for project ${project.id} (${response.status}): ${responseText.slice(0, 500)}`,
      );
      return context.json(
        {
          error: 'request query failed',
          status: response.status,
          detail: responseText.slice(0, 500),
        },
        502,
      );
    }

    let result: {
      data: ReadonlyArray<{
        type: string;
        method: string;
        status: string;
        bytes: number;
        durationMs: number;
        timestamp: string;
      }>;
    };
    try {
      result = JSON.parse(responseText) as typeof result;
    } catch {
      console.error(
        `[requests] non-JSON response for project ${project.id} (${response.status} ${response.headers.get('content-type') ?? 'unknown'}): ${responseText.slice(0, 500)}`,
      );
      return context.json(
        {
          error: 'request query returned non-JSON response',
          status: response.status,
          detail: responseText.slice(0, 500),
        },
        502,
      );
    }

    const data = [...(result.data ?? [])].reverse().map((row) => ({
      timestamp: row.timestamp,
      type: row.type,
      method: row.method,
      status: row.status,
      bytes: row.bytes,
      durationMs: row.durationMs,
    }));

    return context.json({ data });
  })

  .get('/:id/builds', async (context) => {
    const access = await requireProjectRouteCapability(context, context.req.param('id'), 'read');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;
    const rawLimit = Number(context.req.query('limit'));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
    const rows = await getProjectBuilds(context.get('db'), project.id, limit);
    return context.json({ builds: rows.map(toBuildSummary) });
  })
  // Decision: Container builds read logs from the BuildManager DO. github_actions builds have no DO log store,
  // so they return their GitHub Actions URL.
  .get('/:id/builds/:buildId/logs', async (context) => {
    const access = await requireProjectRouteCapability(context, context.req.param('id'), 'read');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;
    const build = await getBuild(context.get('db'), context.req.param('buildId'));
    if (!build || build.project_id !== project.id) {
      return context.json({ error: 'build not found' }, 404);
    }

    const raw = Number(context.req.query('since'));
    const since = Number.isFinite(raw) ? raw : 0;
    const terminal = isTerminalBuildStatus(build.status);

    if (build.executor !== 'container') {
      return context.json({
        lines: [],
        lastSeq: 0,
        status: build.status,
        terminal,
        logsComplete: terminal,
        external: build.logs_url ?? null,
      });
    }

    const ns = buildManagerNamespace(context.env, build.instance_type);
    const stub = ns.get(ns.idFromName(build.id));
    const res = await stub.fetch(`http://manager/logs?since=${since}`);
    const body = (await res.json()) as {
      lines: ReadonlyArray<{ seq: number; line: string; stream: string; ts: number }>;
      lastSeq: number;
      status?: string;
      terminal?: boolean;
      logsComplete?: boolean | null;
    };
    // Decision: Claiming a container build durably sets started_at, so only a terminal row that was never
    // claimed can prove completion without a producer marker.
    const logsComplete = body.logsComplete ?? (terminal && build.started_at === null ? true : null);
    // Decision: The DO holds the live status. Completion sets the DO terminal first, then does the Postgres CAS
    // write, so if that write throws, PG can show active until the stale reaper. OR the two terminal
    // signals (terminal isn't undone) so a follower can finish once the DO confirms its last log drain.
    const doTerminal = body.terminal === true;
    if (doTerminal && !terminal) {
      // Decision: The snapshot wasn't terminal but the DO is. Either a concurrent terminalizer committed after our
      // snapshot (Postgres is authoritative, so use the fresh status), or the PG terminal write threw (PG
      // is still non-terminal, so trust the DO's status).
      const fresh = await getBuild(context.get('db'), build.id);
      return context.json({
        lines: body.lines,
        lastSeq: body.lastSeq,
        status:
          fresh && isTerminalBuildStatus(fresh.status)
            ? fresh.status
            : (body.status ?? build.status),
        terminal: true,
        logsComplete,
        external: null,
      });
    }
    return context.json({
      lines: body.lines,
      lastSeq: body.lastSeq,
      status: build.status,
      terminal,
      logsComplete,
      external: null,
    });
  });

function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    return null;
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = value * multipliers[unit];
  if (ms > 7 * 86_400_000) {
    return null;
  }
  return ms;
}

/**
 * Parse an optional positive `limit` query (default 200, capped at 500).
 * Validated before use: an unchecked negative reaches the SQL `LIMIT` and
 * surfaces an Analytics Engine rejection as a misleading 502 rather than a
 * client error.
 */
function parseAnalyticsLimit(value: string | undefined): number | null {
  if (value === undefined) {
    return 200;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(parsed, 500);
}

function tryParse(json: string): ReadonlyArray<unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

/**
 * Run `work` after the response is sent. Falls back to inline `await` when
 * there is no ExecutionContext — a test harness calling `app.fetch(req, env)`
 * with two arguments — so the side effect still happens and stays observable.
 *
 * Only the missing-context error is recovered; anything else propagates so a
 * real bug inside `waitUntil` is not swallowed. `work` must handle its own
 * failures: on the fallback path a rejection would surface as a 5xx.
 */
const committedWork = new WeakMap<Context<ApiEnv>, Array<(db: Db) => Promise<unknown>>>();

/**
 * Holds `work` for a request that creates a project inside a larger transaction. The work must not
 * start before that transaction commits, and must not use its handle afterwards.
 */
export function scheduleAfterCommit(
  context: Context<ApiEnv>,
  work: (db: Db) => Promise<unknown>,
): void {
  committedWork.set(context, [...(committedWork.get(context) ?? []), work]);
}

/** Starts the work held by `scheduleAfterCommit`, once the request's transaction has committed. */
export async function runScheduledAfterCommit(context: Context<ApiEnv>): Promise<void> {
  const held = committedWork.get(context) ?? [];
  committedWork.delete(context);
  for (const work of held) {
    await scheduleAfterResponse(context, work(context.get('db')));
  }
}

async function scheduleAfterResponse(
  context: Context<ApiEnv>,
  work: Promise<unknown>,
): Promise<void> {
  try {
    context.executionCtx.waitUntil(work);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (/has no ExecutionContext|ExecutionContext is not available/i.test(message)) {
      await work;
      return;
    }
    throw err;
  }
}

/**
 * Register the project owner's own email as a destination for a new project.
 *
 * Entirely best-effort — the outer catch is the point, not an oversight. A
 * degraded CF Email Routing must not fail project creation, and the owner can
 * re-add the address from the dashboard.
 *
 * On a second-or-later project the address is already on the CF account, so
 * `addDestination` reports "already exists"; we recover by listing and reusing
 * the existing tag along with any `verified` status the owner earned earlier.
 * Without that recovery every additional project would start with an empty
 * allowlist.
 *
 * Trusting CF's `verified` flag is sound here only because the address IS the
 * project owner's own — the same human already consented on a prior project
 * (owner-relaxed reuse, Option C in design doc 0078). `verification_source`
 * stays `'cf'` and the audit columns record whose consent was inherited, so a
 * later email change can revoke exactly these rows. A `pending` row inherits
 * nothing and therefore carries no audit.
 */
async function autoAddOwnerDestination(
  accountId: string,
  apiToken: string,
  db: Db,
  projectId: string,
  address: string,
  ownerUserId: string,
): Promise<void> {
  // Decision: Set as soon as Cloudflare holds an account-level address for us, on both the create path and the
  // already-exists path. Anything after that can fail with the address allocated and no row pointing
  // at it.
  let allocatedTag: string | null = null;
  try {
    let cfRow;
    try {
      cfRow = await addDestination(accountId, apiToken, address);
    } catch (err) {
      if (!isDestinationAlreadyExistsError(err)) {
        throw err;
      }
      const all = await listDestinations(accountId, apiToken);
      const found = all.find((row) => row.email.toLowerCase() === address);
      if (!found) {
        throw err;
      }
      cfRow = found;
    }
    allocatedTag = cfRow.tag;
    const status = cfRow.verified ? 'verified' : 'pending';
    // Decision: `address` was the owner's email when the request arrived, before the Cloudflare calls. Inheriting
    // CF's `verified` flag is sound only while that's still true, and the helper checks it under a lock
    // that serializes with the login-side email change; a plain re-read wouldn't see that change until it
    // commits. A `pending` row inherits nothing, so it needs no check.
    const { row, ownerEmailChanged } = await tryCreateEmailDestination(
      db,
      projectId,
      address,
      cfRow.tag,
      status,
      cfRow.verified ?? null,
      'cf',
      {
        ownerAudit:
          status === 'verified' ? { userId: ownerUserId, emailSnapshot: address } : undefined,
      },
    );
    if (ownerEmailChanged) {
      // Decision: The owner's address changed while CF was answering. The consent this row would inherit belongs
      // to a mailbox they no longer hold, and no later login revisits it. This path is best effort, so they
      // can add a recipient by hand; the rollback below releases the tag if nothing else uses it.
      throw new Error('owner email changed while the address was being registered');
    }
    if (!row) {
      // Decision: The helper's hard-error case: a manual add for the same address won the ON CONFLICT race and its
      // row was deleted before the read-back. That deleter released the tag only if it was the last
      // reference, so the tag can be live with no row, which the rollback below handles. Don't retry like
      // the POST route does: the owner just removed this address, and re-inserting it would bring back a
      // row they revoked.
      throw new Error('owner destination row vanished between insert and read-back');
    }
  } catch (err) {
    console.error('[projects] auto-add owner email destination failed:', err);
    if (allocatedTag) {
      // Decision: Roll back on any error, not only the FK violation from project teardown's cascade. This runs after
      // the 201, so nothing retries or reports it: once CF allocated the address, a failure means no row
      // references it, which teardown can't see and which still counts toward the shared 200-per-account
      // cap. The `refs === 0` guard in `rollbackCfDestination` keeps it from revoking a recipient a
      // sibling project still uses, including on the already-exists path.
      await rollbackCfDestination(db, accountId, apiToken, allocatedTag);
    }
  }
}

/**
 * OAuth-provider synthetic addresses that are not real mailboxes — registering
 * one would only generate an undeliverable CF verification email. Today just
 * GitHub's; add patterns as providers ship.
 */
function isSyntheticProviderEmail(email: string): boolean {
  return /@users\.noreply\.github\.com$/i.test(email);
}

export default app;

/** A project could not be created. `code` names the cause; `status` is the HTTP status it maps to. */
export class ProjectCreateError extends Error {
  constructor(
    readonly code:
      | 'SLUG_INVALID'
      | 'SLUG_SHORT_NOT_ALLOWED'
      | 'SLUG_TAKEN'
      | 'AI_LOGGING_UNAVAILABLE'
      | 'PLATFORM_UNINSTALLING',
    message: string,
  ) {
    super(message);
  }
}

type CreateProjectContext = {
  env: ApiEnv['Bindings'];
  db: Db;
  user: User;
  /**
   * Runs `work` after the response; awaits it inline where there is no execution context. `work`
   * gets the database to use, which isn't `db` when `db` is a transaction that has ended by then.
   */
  schedule(work: (db: Db) => Promise<unknown>): Promise<void>;
};

/** Creates a project for `user`; throws `ProjectCreateError` for every refusal. */
export async function createProjectForUser(context: CreateProjectContext, slug: string) {
  // Decision: Lowercase alphanumeric with dashes, short enough to fit before `+noreply@` in a 64-octet SMTP
  // local-part, and not reserved. The CLI treats this 400 as re-promptable.
  const nameError = projectNameError(slug, 'slug');
  if (nameError) {
    throw new ProjectCreateError('SLUG_INVALID', nameError);
  }

  // Decision: Check the plan's allowShortSlugs flag, not its name, so short-slug eligibility survives when an
  // administrator copies or renames a plan.
  if (slug.length <= 5) {
    if (!(await resolvePlan(context.db, context.user.plan)).allowShortSlugs) {
      throw new ProjectCreateError(
        'SLUG_SHORT_NOT_ALLOWED',
        'the selected plan does not permit short slugs (5 characters or fewer)',
      );
    }
  }

  // Decision: A slug is also a mailbox on the shared mail domain, so it can't equal another project's email
  // alias either.
  const existing =
    (await getProjectBySlug(context.db, slug)) ?? (await getProjectByEmailAlias(context.db, slug));
  if (existing) {
    throw new ProjectCreateError('SLUG_TAKEN', 'slug already taken');
  }

  const userId = context.user.id;
  try {
    // Decision: `bwf platform uninstall --purge-resources` holds this lock across its last check for projects
    // and records the uninstall before releasing it, so a project either commits before that check or is
    // refused here.
    const project = await context.db.transaction(async (tx) => {
      await lockZeroTrustConfiguration(tx, 'shared');
      await lockNewProjectAiLoggingInputs(tx);
      const created = await createProject(tx, userId, slug);
      // Decision: A plan's AI logging default applies from the first request. A KV failure rolls the create back,
      // so a retry starts clean.
      await publishProjectAiLogging(tx, context.env.ROUTING, created.id, {
        trigger: 'project_create',
        initialPlanDefault: initialPlanDefaultFor(context.env),
        creating: true,
      });
      return created;
    });
    let zeroTrust: Awaited<ReturnType<typeof initializeNewProjectZeroTrust>> = null;
    let zeroTrustWarning: string | undefined;
    try {
      zeroTrust = await initializeNewProjectZeroTrust(context.env, context.db, project.id);
    } catch (error) {
      zeroTrustWarning =
        'Project created, but its Zero Trust protection is not set up yet, so deploys will wait. Platform retries within an hour. To retry now, a project owner or admin can run `bwf project zero-trust reconcile`; if that reports the platform is not ready, ask a platform administrator.';
      console.error('[zero-trust] new project initialization failed', {
        projectId: project.id,
        error,
      });
    }
    // Decision: Pre-seed the owner's own address as a destination so mail to themselves works from the first
    // deploy; it stays `pending` until they click CF's verification link. Gate it on the `email`
    // capability and EMAIL_SENDER_DOMAIN: without them the row could authorize nothing, and registering
    // it would still cost the owner a CF verification email.
    const ownerEmail = context.user.email;
    if (
      getPlatformCapabilities(context.env).email &&
      context.env.EMAIL_SENDER_DOMAIN &&
      ownerEmail &&
      !isSyntheticProviderEmail(ownerEmail)
    ) {
      const address = ownerEmail.toLowerCase();
      // Decision: Run this off the response path: CF Email Routing has no timeout in `cfFetch`, and project
      // creation mustn't wait on it. Nothing depends on the row yet; a pending row adds no allowlist entry.
      await context.schedule((db) =>
        autoAddOwnerDestination(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          db,
          project.id,
          address,
          userId,
        ),
      );
      // Decision: Return only which address is being registered. Whether CF mails a verification link or adopts an
      // address the owner already verified is decided by the add above, which hasn't run yet. The CLI
      // prints this to explain the email that may follow.
      return {
        ...project,
        owner_email_destination: { address },
        ...(zeroTrust ? { zero_trust: publicProjectZeroTrustState(zeroTrust) } : {}),
        ...(zeroTrustWarning ? { warnings: [zeroTrustWarning] } : {}),
      };
    }
    return {
      ...projectWithUrl(project, context.env),
      ...(zeroTrust ? { zero_trust: publicProjectZeroTrustState(zeroTrust) } : {}),
      ...(zeroTrustWarning ? { warnings: [zeroTrustWarning] } : {}),
    };
  } catch (err) {
    // Decision: Only the configuration lock above throws this here: the uninstall record exists.
    if (err instanceof AiLoggingPublishError) {
      throw new ProjectCreateError(
        'AI_LOGGING_UNAVAILABLE',
        'The AI logging setting for the new project could not be applied. Retry.',
      );
    }
    if (err instanceof ZeroTrustUnavailableError) {
      throw new ProjectCreateError(
        'PLATFORM_UNINSTALLING',
        'The platform is being uninstalled, so new projects cannot be created.',
      );
    }
    // Decision: Unique violation: the slug, or an alias with that name, was taken between the check and the
    // insert.
    if (hasSqlState(err, '23505')) {
      throw new ProjectCreateError('SLUG_TAKEN', 'slug already taken');
    }
    throw err;
  }
}
