import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ACTIVE_BUILD_STATUSES,
  deleteGitHubConnection,
  deleteGitHubInstallationMembers,
  deleteGitHubInstallationMembersByGithubAccount,
  getBuild,
  getBuildByProjectRunIdAndAttempt,
  getDeploymentByProjectAndCommit,
  getGitHubConnectionsByRepo,
  getGitHubInstallation,
  getGitHubInstallationsByAccount,
  getUserByOAuthAccount,
  markBuildTerminalIfActive,
  markGitHubInstallationStatus,
  recordInstallationRevocations,
  setGitHubInstallationRepositories,
  supersedeAndCreateContainerBuild,
  suspendGitHubInstallation,
  terminateBuildsForProject,
  unsuspendGitHubInstallation,
  updateGitHubConnectionRepoNamesByRepoId,
  upsertGitHubInstallation,
} from '../db.ts';
import type { Db } from '../db.ts';
import type { TerminatedBuild } from '../db/builds.ts';
import type { ApiEnv } from '../env.ts';
import { cancelContainerBuildDos } from '../github/cancel-builds.ts';
import {
  PLATFORM_BUILD_CHECK_RUN_NAME,
  completeCheckRun,
  preservedCheckRunConclusion,
} from '../github/check-run.ts';
import type { CheckRunConclusion } from '../github/check-run.ts';
import { listInstallationRepositories } from '../github/installation-repos.ts';
import {
  getBranchExistence,
  getBranchHeadComparisonStatus,
  getInstallationToken,
} from '../github/installation-token.ts';
import {
  GitHubWebhookRequestError,
  readBoundedGitHubWebhookBody,
  readGitHubWebhookHeaders,
} from '../github/webhook-ingress-auth.ts';
import { verifyGithubWebhookSignature } from '../github/webhook-verify.ts';
import { githubConnections, githubInstallations } from '../schema.ts';
import type { GitHubInstallationRepository } from '../schema.ts';
import type { Build } from '../types.ts';

const app = new Hono<ApiEnv>();

// Decision: A push that deletes a branch carries an all-zero `after` SHA, and there's nothing to build.
const ZERO_SHA = '0000000000000000000000000000000000000000';

type PushPayload = {
  ref?: string;
  after?: string;
  installation?: { id?: number | string };
  repository?: { full_name?: string; id?: number | string };
};

type InstallationPayload = {
  action?: string;
  installation?: {
    id?: number | string;
    account?: {
      login?: string;
      id?: number | string;
      type?: string;
    };
    repository_selection?: string;
  };
  repositories?: ReadonlyArray<{ full_name?: string; id?: number }>;
};

type OrganizationPayload = {
  action?: string;
  organization?: { id?: number | string };
  membership?: { user?: { id?: number | string } };
};

type InstallationRepositoriesPayload = {
  action?: string;
  installation?: { id?: number | string };
  repositories_added?: ReadonlyArray<{ full_name?: string; id?: number }>;
  repositories_removed?: ReadonlyArray<{ full_name?: string; id?: number }>;
  // Decision: GitHub doesn't send the accessible set after the change, so we keep it by reading the install's
  // current selection and applying the delta.
  repository_selection?: string;
};

// Decision: `check_run:rerequested` is GitHub's per-check "Re-run" button. `external_id` is the build id we
// set at create time (createCheckRun requires it), and it makes a per-check rerun hit one project. A
// repo can back several projects on the same branch, each with its own "Platform Build" run on the
// same commit. Resolving by repo and branch alone would rebuild all of them from one click, and
// could enqueue a container build from another project's `github_actions` check. The id narrows the
// fan-out; it doesn't widen it or authorize anything, and the branch-head gate still decides.
type CheckRunPayload = {
  action?: string;
  installation?: { id?: number | string };
  repository?: { full_name?: string; id?: number | string };
  check_run?: {
    id?: number | string;
    name?: string;
    head_sha?: string;
    external_id?: string | null;
    // Decision: The run's existing conclusion. A refused rerun echoes it back instead of writing its own.
    conclusion?: string | null;
    check_suite?: { head_branch?: string | null };
  };
};

type CheckSuitePayload = {
  action?: string;
  installation?: { id?: number | string };
  repository?: { full_name?: string; id?: number | string };
  check_suite?: { head_sha?: string; head_branch?: string | null };
};

type WorkflowRunPayload = {
  action?: string;
  installation?: { id?: number | string };
  repository?: { full_name?: string; id?: number | string };
  workflow_run?: {
    id?: number | string;
    run_attempt: number | string;
    conclusion?: string | null;
    head_sha?: string;
  };
};

// Decision: The "Platform Build" check reports GitHub's run outcome (not our internal build status), so it's
// driven from this field. Map the non-success outcomes we care about and collapse the rest
// (action_required, neutral, skipped, stale, startup_failure, null) to 'failure'.
function mapWorkflowRunConclusion(conclusion: string | null | undefined): CheckRunConclusion {
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'cancelled':
      return 'cancelled';
    case 'timed_out':
      return 'timed_out';
    default:
      return 'failure';
  }
}

function normalizeRepositories(
  repos: ReadonlyArray<{ full_name?: string; id?: number }> | undefined,
): ReadonlyArray<GitHubInstallationRepository> {
  if (!repos) {
    return [];
  }
  return repos
    .filter((r): r is { full_name: string; id: number } => {
      return typeof r.full_name === 'string' && typeof r.id === 'number';
    })
    .map((r) => ({ full_name: r.full_name, id: r.id }));
}

// Decision: Only the literal `'all'` grants every repo. Anything else, including a missing field, maps to
// `'selected'`, so an unknown value can't loosen access.
function normalizeRepositorySelection(value: string | undefined): 'all' | 'selected' {
  return value === 'all' ? 'all' : 'selected';
}

/**
 * Poke the scheduler DO so it wakes immediately rather than waiting for its
 * next alarm. Best-effort: a failed poke is recovered on the next scheduled
 * wake. DO→DO fetch is permitted here (the no-`.fetch` rule only forbids
 * dispatching to user workers).
 */
async function pokeBuildScheduler(env: ApiEnv['Bindings']): Promise<void> {
  try {
    const scheduler = env.BUILD_SCHEDULER.get(env.BUILD_SCHEDULER.idFromName('global'));
    await scheduler.fetch('https://scheduler/poke', { method: 'POST' });
  } catch (error) {
    console.error('[webhooks] failed to poke build scheduler:', error);
  }
}

/**
 * Re-run a build for an already-pushed commit, driven by GitHub's "Re-run" /
 * "Re-run all checks" buttons (`check_run:rerequested` / `check_suite:rerequested`).
 *
 * Deliberately reuses the PUSH pipeline rather than inventing a second way to
 * enqueue: same connection resolution, same renamed-repo self-heal, same
 * fail-closed branch-head freshness gate, same `supersedeAndCreateContainerBuild`.
 * A re-run must not become a back door that deploys a commit a push could not.
 *
 * AUTHORIZATION is the same shape as `push`: the payload is HMAC-verified and
 * bound to an installation we know, and GitHub only offers the button to users
 * with write access on the repo. We add nothing on top, and `sender` is ignored.
 *
 * That is NOT strictly weaker than push, and the difference is deliberate rather
 * than overlooked. Branch protection can restrict pushes to `main` to named
 * users, teams, or apps while everyone else keeps repo write — so the set of
 * people who can click Re-run is a SUPERSET of the set who can push the branch.
 * The freshness gate bounds what that buys them: the only commit they can build
 * is the branch head, which our push pipeline already built and deployed. The one
 * real capability is re-deploying the current head, which matters when a rollback
 * is active — a rerun can roll forward onto the branch head again. We accept it,
 * because the alternative is mapping GitHub actors to per-project deploy rights,
 * and a connection carries exactly one Platform user; gating on `sender` would break
 * ordinary team use to close a hole bounded by "redeploy what is already HEAD".
 *
 * FRESHNESS is what makes it safe. The head SHA must still be the connected
 * branch's head (`identical`), so re-running an old check cannot roll production
 * back to an abandoned commit. Re-running a check on a superseded commit is
 * therefore an intentional no-op.
 *
 * A `check_suite` refusal reports NOTHING, deliberately. The Checks API cannot
 * conclude a suite at all — GitHub derives that from the runs — and the suite
 * payload carries no run ids.
 *
 * Run ids must not be derived from our own build rows: the row is not
 * authoritative for the `github_actions` executor, whose check is completed
 * straight from `workflow_run.conclusion` independent of the status CAS, so a
 * `cancelled` row can carry a published `success` and rewriting it from the row
 * would turn a passing required check into a blocking one.
 *
 * A bounded read DOES exist (`GET /repos/{o}/{r}/check-suites/{id}/check-runs`
 * with `check_name` + `per_page`), so cost is not the objection. The objection is
 * that the premise is unverified: it is not established that GitHub leaves our
 * runs needing resolution at all — a suite rerequest resets the SUITE's own state,
 * and a run that kept its conclusion is not pending. Re-PATCHing a run with the
 * conclusion it already has, hoping the suite recomputes, is a guess about GitHub
 * internals. Verify it against a real suite rerequest on staging before building
 * on it.
 *
 * DEDUP falls out of the shared helper: a `failed` build for the commit is never
 * reused, so the failing case this exists for always enqueues fresh work. A
 * commit whose build already succeeded AND is live reuses that build and enqueues
 * nothing — the check is green and there is nothing to redo.
 *
 * `github_actions` connections cannot be re-run from here: their build is driven
 * by the workflow, and nothing in the Checks API can start one. They report an
 * explicit ignore rather than silently doing nothing.
 */
async function rerunBuildForCommit(
  context: Context<ApiEnv>,
  db: Db,
  args: {
    installationId: number | string | undefined;
    repoFullName: string | undefined;
    repoId: number | string | undefined;
    headSha: string | undefined;
    event: string;
    // Decision: Present only for `check_run`: the run the user clicked. `buildId` narrows the rebuild to that
    // run's project; `checkRunId` lets an accepted request that enqueues nothing say so on the check
    // instead of leaving the button looking broken.
    checkRun?: { id: string | null; buildId: string | null; conclusion: unknown };
  },
) {
  const { installationId, repoFullName, repoId, headSha, event, checkRun } = args;

  // Decision: GitHub flips the suite back to `queued` as soon as the button is clicked. If we enqueue nothing
  // and say nothing, the user sees a Re-run that does nothing, so each no-op path reports through
  // `completeRerun`.
  // A refusal writes the conclusion the run already had, not a passing one we didn't earn: GitHub
  // counts `neutral`/`skipped` as passing for a required check, so writing one for a build that never
  // ran would let anyone with rerun rights clear branch protection.
  const refusedConclusion = preservedCheckRunConclusion(checkRun?.conclusion);
  const completeRerun = async (conclusion: CheckRunConclusion, title: string, summary: string) => {
    // Decision: Called with `refusedConclusion` for a refusal, or 'success' only for a build that really
    // completed and is live.
    if (!checkRun?.id || installationId === undefined || installationId === null || !repoFullName) {
      return;
    }
    // Decision: Run this off the response path. `completeCheckRun` mints a token and retries with no deadline,
    // while GitHub drops a delivery we haven't answered in 10 seconds and doesn't redeliver it
    // automatically. `waitUntil` matches the `workflow_run` completion: the call starts synchronously, so
    // it can't be skipped, and the Worker stays alive for it after the 2xx.
    const runId = checkRun.id;
    const reported = completeCheckRun(context.env, String(installationId), repoFullName, runId, {
      conclusion,
      title,
      summary,
    })
      .then((patched) => {
        if (!patched) {
          // Decision: `completeCheckRun` resolves false on a non-2xx; it doesn't throw.
          console.warn(`[webhooks] rerun report for check run ${runId} was rejected by GitHub`);
        }
      })
      .catch((error: unknown) => {
        console.error('[webhooks] failed to report rerun no-op:', error);
      });
    try {
      context.executionCtx.waitUntil(reported);
    } catch {
      // Decision: No execution context (a bare `app.request` in a test, say). The call is already in flight; a
      // missing lifetime extension mustn't 500 a webhook.
      void reported;
    }
  };

  if (
    installationId === undefined ||
    installationId === null ||
    !repoFullName ||
    repoId === undefined ||
    repoId === null ||
    typeof headSha !== 'string' ||
    headSha === ''
  ) {
    return context.json({ ok: true, ignored: `missing ${event} routing fields` });
  }

  const repoIdStr = String(repoId);
  const connections = await getGitHubConnectionsByRepo(db, String(installationId), repoIdStr);

  // Decision: Same self-heal as the push path: a connection matched by immutable id can carry a stale name,
  // and the container build uses that name as its tarball source.
  if (connections.some((c) => c.repo_full_name !== repoFullName)) {
    await updateGitHubConnectionRepoNamesByRepoId(
      db,
      String(installationId),
      repoIdStr,
      repoFullName,
    );
  }

  // Decision: `head_branch` isn't a filter. GitHub keeps one suite per app per commit even when the commit is
  // the head of several branches, so filtering on it would drop a project tracking the other branch at
  // the same SHA. The per-branch freshness gate below decides, and it's exact.
  // A per-check rerun targets the one project whose build published that check, named by
  // `external_id`. Several projects can share a repo and a branch, so the branch can't stand in for it.
  let candidates = connections;
  if (checkRun) {
    // Decision: Fail closed. Falling back to the branch set would reopen the fan-out this narrowing closes, and
    // it's reachable: deleting a project cascades away its builds while GitHub keeps check runs for
    // months, so an old check could enqueue builds for sibling projects owned by other users.
    const originating = checkRun.buildId ? await getBuild(db, checkRun.buildId) : null;
    if (!originating) {
      await completeRerun(
        refusedConclusion,
        'Nothing to rebuild',
        'The build behind this check no longer exists. Push a new commit to build again.',
      );
      return context.json({ ok: true, ignored: 'originating build not found' });
    }
    candidates = connections.filter((c) => c.project_id === originating.project_id);
  }
  if (candidates.length === 0) {
    await completeRerun(
      refusedConclusion,
      'Nothing to rebuild',
      'This repository is no longer connected to a Platform project on this branch.',
    );
    return context.json({ ok: true, ignored: 'no matching connection' });
  }

  // Decision: One compare per distinct branch: candidates share repo and installation.
  // Run them concurrently. Only a `check_suite` fan-out has more than one, and running them in series
  // multiplies latency against GitHub's 10s delivery deadline (a missed deadline drops the delivery
  // with no redelivery). The compares are independent and `getBranchHeadComparisonStatus` resolves on
  // failure, so `Promise.all` can't turn one bad branch into a 500.
  // Warm the installation token first: `getInstallationToken` memoizes per installation, but
  // concurrent compares on a cold cache would each mint one. Its failure is ignored on purpose; each
  // compare mints and retries on its own.
  const distinctBranches = [...new Set(candidates.map((c) => c.branch))];
  if (distinctBranches.length > 1) {
    try {
      await getInstallationToken(context.env, String(installationId));
    } catch {
      // Decision: Ignored on purpose: the per-branch compares own the retry and backoff.
    }
  }
  const freshness = new Map<string, boolean>();
  await Promise.all(
    distinctBranches.map(async (branch) => {
      const status = await getBranchHeadComparisonStatus(
        context.env,
        String(installationId),
        repoFullName,
        headSha,
        branch,
      );
      if (status !== 'identical') {
        console.warn(
          `[webhooks] skipping ${event} rerun for ${repoFullName}@${branch} ${headSha}: branch-head comparison ${status ?? 'unavailable'}`,
        );
      }
      freshness.set(branch, status === 'identical');
    }),
  );

  const buildIds: Array<string> = [];
  const cancelledContainerBuilds: Array<TerminatedBuild> = [];
  // Decision: A reused build that's already terminal: `supersedeAndCreateContainerBuild` returns the existing
  // `complete` row, so it looks like an enqueue, but nothing will run or update the check again.
  const alreadyLive: Array<string> = [];
  let sawActions = false;
  for (const connection of candidates) {
    if (!freshness.get(connection.branch)) {
      continue;
    }
    if (connection.build_executor !== 'container') {
      sawActions = true;
      continue;
    }
    const { build, reused, cancelled } = await supersedeAndCreateContainerBuild(db, {
      projectId: connection.project_id,
      branch: connection.branch,
      commitSha: headSha,
      connectionId: connection.id,
      installationId: connection.installation_id,
      repositoryId: connection.repository_id,
    });
    cancelledContainerBuilds.push(...cancelled);
    if (!build) {
      continue;
    }
    // Decision: Only `complete` counts as already live. The reuse branch also returns `queued` rows, and
    // `ACTIVE_BUILD_STATUSES` leaves out `queued` (it counts slot holders), so testing against it would
    // report an unrun build as deployed and skip the poke it's waiting for.
    if (reused && build.status === 'complete') {
      alreadyLive.push(build.id);
    } else {
      buildIds.push(build.id);
    }
  }

  // Decision: The supersede transaction already committed (revoking tokens), so the DO teardown runs outside
  // any row lock, the same order as the push path.
  await cancelContainerBuildDos(context.env, cancelledContainerBuilds, 'superseded by rerun');

  if (buildIds.length === 0) {
    if (sawActions) {
      // Decision: Nothing in the Checks API can start a workflow run, so this button can't rebuild an
      // Actions-backed project. Say so instead of doing nothing.
      await completeRerun(
        refusedConclusion,
        'Re-run this from GitHub Actions',
        'This project builds on GitHub Actions. Re-run the workflow from the Actions tab.',
      );
      return context.json({ ok: true, ignored: 'github_actions rerun must be run from Actions' });
    }
    if (alreadyLive.length > 0) {
      // Decision: Deliberately not `neutral`: this commit did build and is live, so the replaced run was green.
      // Downgrading an accurate success is worse than restating it.
      await completeRerun(
        'success',
        'Already built and live',
        'This commit is already built and deployed. There is nothing to rebuild.',
      );
      return context.json({ ok: true, enqueued: 0, reused: alreadyLive });
    }
    if (candidates.some((c) => !freshness.get(c.branch))) {
      await completeRerun(
        refusedConclusion,
        'Commit is no longer the branch head',
        'A rerun deploys only the current head of the connected branch. Push or re-run on the newest commit.',
      );
    } else {
      // Decision: Everything left is a `skipped` reason from the supersede transaction: project deleting, owner
      // suspended, connection reconfigured or replaced, or installation revoked.
      await completeRerun(
        refusedConclusion,
        'Nothing to rebuild',
        'This project is not currently accepting builds for this branch.',
      );
    }
    return context.json({ ok: true, enqueued: 0 });
  }

  await pokeBuildScheduler(context.env);

  return context.json({ ok: true, buildIds });
}

/** Process a webhook whose caller has already verified its raw GitHub HMAC. */
export async function handleVerifiedGitHubWebhook(
  context: Context<ApiEnv>,
  raw: Uint8Array,
  event: string,
): Promise<Response> {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return context.json({ error: 'invalid payload' }, 400);
  }

  const db = context.get('db');

  switch (event) {
    case 'push': {
      const push = payload as PushPayload;
      const installationId = push.installation?.id;
      const repoFullName = push.repository?.full_name;
      // Decision: The immutable repo id keys connection resolution, so a rename or name reuse can't deploy to the
      // wrong project.
      const repoId = push.repository?.id;
      const ref = push.ref;
      const after = push.after;

      if (
        installationId === undefined ||
        installationId === null ||
        !repoFullName ||
        repoId === undefined ||
        repoId === null ||
        typeof ref !== 'string' ||
        !ref.startsWith('refs/heads/') ||
        typeof after !== 'string'
      ) {
        return context.json({ ok: true, ignored: 'unhandled push' });
      }
      const repoIdStr = String(repoId);

      // Decision: A branch delete has no source to build, but an in-flight build for that branch still holds a
      // live deploy token: the middleware revokes a token only once its build is no longer active, so it
      // could keep publishing the deleted branch's SHA until its 65-minute TTL or the hourly reaper.
      // Terminalize those builds under a FOR UPDATE lock on the connection rows, so an in-flight OIDC
      // exchange (which locks the same rows before inserting) is serialized. The DO cancel runs after
      // commit.
      if (after === ZERO_SHA) {
        const deletedBranch = ref.slice('refs/heads/'.length);
        // Decision: Take the fence before the absence check: only builds that existed when we started confirming the
        // branch is gone can be cancelled, so a build from a recreate-and-push in that gap is spared.
        // Read it from the database clock, not the Worker clock: `builds.created_at` is set by Postgres
        // `now()`, and two clocks could skew. `now()::text` keeps the session TZ offset and round-trips
        // through the `::timestamptz` comparison in terminateBuildsForProject.
        const fenceResult = (await db.execute(sql`select now()::text as now`)) as {
          rows: ReadonlyArray<{ now: string }>;
        };
        const deleteFenceTs = fenceResult.rows[0]?.now;
        if (deleteFenceTs === undefined) {
          // Decision: now() returns a row; treat an empty result as a transient DB fault and skip cancellation
          // instead of cancelling unfenced. The build's exposure stays bounded by the token TTL and the hourly
          // reaper.
          return context.json({ ok: true, ignored: 'branch delete' });
        }

        // Decision: GitHub doesn't guarantee webhook order, so a delete can arrive after the branch was recreated and
        // a new build enqueued. Re-check git state and cancel only when the branch is confirmed absent.
        // 'present' and 'unknown' both no-op; the old build's exposure is bounded by the 65-minute token TTL
        // and the hourly reaper. This is a network call, so it runs before the transaction: don't hold a
        // FOR UPDATE lock across it.
        // Known limit: this check keys on `repoFullName` while cancellation keys on `repository_id`. A
        // delayed delete across a rename plus name reuse can resolve to the wrong repo and cancel a
        // recreated branch's own build (same installation only, fixed by the next push). We accept it
        // rather than spend another GitHub call to resolve the name for `repository_id`.
        const existence = await getBranchExistence(
          context.env,
          String(installationId),
          repoFullName,
          deletedBranch,
        );
        if (existence !== 'absent') {
          return context.json({ ok: true, ignored: 'branch delete' });
        }

        const cancelled = await db.transaction(async (tx) => {
          const conns = await tx
            .select({
              project_id: githubConnections.project_id,
              repository_id: githubConnections.repository_id,
              branch: githubConnections.branch,
            })
            .from(githubConnections)
            .where(eq(githubConnections.installation_id, String(installationId)))
            .for('update');
          const acc: Array<TerminatedBuild> = [];
          for (const conn of conns) {
            if (conn.repository_id !== repoIdStr || conn.branch !== deletedBranch) {
              continue;
            }
            acc.push(
              ...(await terminateBuildsForProject(tx, conn.project_id, {
                branch: deletedBranch,
                reason: 'branch deleted',
                createdBefore: deleteFenceTs,
              })),
            );
          }
          return acc;
        });
        await cancelContainerBuildDos(context.env, cancelled, 'branch deleted');
        return context.json({ ok: true, ignored: 'branch delete' });
      }

      const branch = ref.slice('refs/heads/'.length);
      const connections = await getGitHubConnectionsByRepo(db, String(installationId), repoIdStr);

      // Decision: Self-heal a renamed repo: connections matched by immutable id can carry a stale repo_full_name,
      // which the container build uses as its tarball source.
      if (connections.some((c) => c.repo_full_name !== repoFullName)) {
        await updateGitHubConnectionRepoNamesByRepoId(
          db,
          String(installationId),
          repoIdStr,
          repoFullName,
        );
      }

      // Decision: A repo can back several projects (say staging and prod on different branches), so build each
      // connection whose branch matches.
      const matching = connections.filter((c) => c.branch === branch);
      if (matching.length === 0) {
        return context.json({ ok: true, ignored: 'no matching connection' });
      }

      // Decision: Fail-closed freshness gate: build only a push confirmed to be the branch head ('identical').
      // 'ahead' is an older push delivered late, 'behind' means the branch moved back off `after',
      // 'diverged' is force-pushed away, null means the compare API was unreachable. In those cases don't
      // supersede the queued build; the newer push's own webhook builds the real head. One check covers
      // all matching connections (same repo, branch and installation).
      const headComparison = await getBranchHeadComparisonStatus(
        context.env,
        String(installationId),
        repoFullName,
        after,
        branch,
      );
      if (headComparison !== 'identical') {
        console.warn(
          `[webhooks] skipping push for ${repoFullName}@${branch} ${after}: branch-head comparison ${headComparison ?? 'unavailable'}`,
        );
        return context.json({ ok: true, ignored: 'push is not the current branch head' });
      }

      const buildIds: Array<string> = [];
      const cancelledContainerBuilds: Array<TerminatedBuild> = [];
      for (const connection of matching) {
        if (connection.build_executor !== 'container') {
          // Decision: github_actions builds run their workflow on push, and the OIDC endpoint creates the row. If a
          // newer push's workflow never reaches OIDC, an older in-flight build would keep a live token. We're
          // past the 'identical' gate, so `after` is the head: terminalize active actions builds on this
          // branch whose commit isn't `after`. Actions builds have no DO; terminalizing the row revokes the
          // token. A push landing between an exchange's compare and its insert is closed by the OIDC path's
          // post-create freshness re-check.
          await terminateBuildsForProject(db, connection.project_id, {
            branch,
            executor: 'github_actions',
            exceptCommitSha: after,
            reason: 'superseded by newer push',
          });
          continue;
        }
        // Decision: Supersede older queued and active builds for this branch and enqueue the new commit atomically
        // under a per-project lock, so concurrent deliveries can't interleave (an older push cancelling a
        // newer build, then enqueuing the older commit). Redelivery is deduped: an in-flight build for this
        // commit is reused; a `complete` build is reused only when its commit is live. Otherwise (say a
        // force-push back to an older commit) a fresh build is enqueued. Superseded active builds lose their
        // token and slot; their DOs are torn down after commit.
        const { build, cancelled } = await supersedeAndCreateContainerBuild(db, {
          projectId: connection.project_id,
          branch,
          commitSha: after,
          connectionId: connection.id,
          installationId: connection.installation_id,
          repositoryId: connection.repository_id,
        });
        cancelledContainerBuilds.push(...cancelled);
        // Decision: `build` is null on a skip: a concurrent PATCH changed the connection, the project is being torn
        // down, the owner is suspended, or installation authority was revoked. The code below handles the
        // empty case.
        if (build) {
          buildIds.push(build.id);
        }
      }

      // Decision: The supersede transaction already committed in the helper (revoking tokens), so the DO teardown
      // runs outside any row lock.
      await cancelContainerBuildDos(
        context.env,
        cancelledContainerBuilds,
        'superseded by newer push',
      );

      if (buildIds.length === 0) {
        // Decision: No container build was enqueued. If only github_actions connections matched, they run on push,
        // so 'github_actions' is right. If container connections matched and were all skipped, don't
        // mislabel that as a github_actions run.
        return matching.some((c) => c.build_executor === 'container')
          ? context.json({ ok: true, enqueued: 0 })
          : context.json({ ok: true, executor: 'github_actions' });
      }

      await pokeBuildScheduler(context.env);

      return context.json({ ok: true, buildIds });
    }

    case 'installation': {
      const data = payload as InstallationPayload;
      const installationId = data.installation?.id;
      if (installationId === undefined || installationId === null) {
        return context.json({ ok: true, ignored: 'missing installation id' });
      }
      const action = data.action;

      if (action === 'created') {
        const account = data.installation?.account;
        const accountType = account?.type === 'Organization' ? 'Organization' : 'User';
        await upsertGitHubInstallation(db, {
          installationId: String(installationId),
          // Decision: Organization installs don't have an owner. A personal install's owner is linked by the install
          // callback or a later sign-in.
          userId: null,
          accountLogin: account?.login ?? '',
          accountId: account?.id === undefined ? '' : String(account.id),
          accountType,
          repositories: normalizeRepositories(data.repositories),
          repositorySelection: normalizeRepositorySelection(
            data.installation?.repository_selection,
          ),
        });
        return context.json({ ok: true });
      }

      // Decision: Removing or suspending the App orphans each connection under it, and in-flight builds keep live
      // deploy tokens. Terminalize all the installation's in-flight builds with the status flip, under a
      // FOR UPDATE lock on the install row and then the connection rows, so an in-flight OIDC exchange is
      // serialized. The DO cancel runs after commit.
      if (action === 'deleted' || action === 'suspend') {
        const reason = action === 'deleted' ? 'github app uninstalled' : 'github app suspended';
        const cancelled = await db.transaction(async (tx) => {
          // Decision: Lock the install row first, then connection rows: the global install-first order
          // (member_removed and the connect gate do the same), so they can't deadlock with this.
          await tx
            .select({ id: githubInstallations.id })
            .from(githubInstallations)
            .where(eq(githubInstallations.installation_id, String(installationId)))
            .for('update');
          const connections = await tx
            .select({ project_id: githubConnections.project_id })
            .from(githubConnections)
            .where(eq(githubConnections.installation_id, String(installationId)))
            .for('update');
          // Decision: `deleted` is the terminal write and applies unconditionally; `suspend` is guarded so a stale
          // suspend can't move a `deleted` row back to `suspended`, which would re-arm the unsuspend guard.
          if (action === 'deleted') {
            await markGitHubInstallationStatus(tx, String(installationId), 'deleted');
          } else {
            await suspendGitHubInstallation(tx, String(installationId));
          }
          const acc: Array<TerminatedBuild> = [];
          for (const conn of connections) {
            acc.push(...(await terminateBuildsForProject(tx, conn.project_id, { reason })));
          }
          return acc;
        });
        await cancelContainerBuildDos(context.env, cancelled, reason);
        return context.json({ ok: true });
      }
      if (action === 'unsuspend') {
        // Decision: Guarded suspended to active only: a stale unsuspend arriving after installation.deleted mustn't
        // revive the terminal row.
        await unsuspendGitHubInstallation(db, String(installationId));
        return context.json({ ok: true });
      }

      return context.json({ ok: true, ignored: `installation:${action ?? 'unknown'}` });
    }

    case 'installation_repositories': {
      const data = payload as InstallationRepositoriesPayload;
      const installationId = data.installation?.id;
      if (installationId === undefined || installationId === null) {
        return context.json({ ok: true, ignored: 'missing installation id' });
      }

      const added = normalizeRepositories(data.repositories_added);
      const removed = normalizeRepositories(data.repositories_removed);
      const existing = await getGitHubInstallation(db, String(installationId));
      const eventSelection = normalizeRepositorySelection(data.repository_selection);

      // Decision: Usually apply the event's added/removed delta to the cached set. An `all` to `selected` narrowing
      // can't be rebuilt that way: the cache is empty for `all` installs, and GitHub's delta on that change
      // isn't documented, so diffing would drop the repos the user kept and break their builds. Fetch the
      // real set instead, before the FOR UPDATE transaction (don't hold a row lock across a GitHub call).
      // Trust the refetched selection too, so a stale event self-corrects.
      // Compute the set from the locked cached set inside the transaction, not the `existing` snapshot:
      // concurrent deliveries have to serialize their read-modify-write, or two near-simultaneous adds
      // lose one repo.
      let refetched: Awaited<ReturnType<typeof listInstallationRepositories>> | null = null;
      if (existing?.repository_selection === 'all' && eventSelection === 'selected') {
        const token = await getInstallationToken(context.env, String(installationId));
        refetched = await listInstallationRepositories(token);
      }
      const selection: 'all' | 'selected' = refetched
        ? refetched.repositorySelection
        : eventSelection;
      // Decision: Pick the selection to store from the row read under the lock, not the `existing` snapshot. A stale
      // `selected` event can arrive after the user widened to `all`; its snapshot said `selected`, so the
      // refetch never ran. Storing `selected` would drop coverage for repos outside the event and revoke
      // builds `all` still covers. When the lock shows `all` and no narrow was confirmed, keep `all`.
      const isStaleSelectedDowngrade = (lockedSelection: string | null | undefined): boolean =>
        refetched === null && lockedSelection === 'all' && selection === 'selected';
      const removedIds = new Set(removed.map((r) => r.id));
      const computeNext = (
        current: ReadonlyArray<GitHubInstallationRepository>,
      ): ReadonlyArray<GitHubInstallationRepository> => {
        if (refetched) {
          return refetched.repositories;
        }
        const byId = new Map<number, GitHubInstallationRepository>();
        for (const repo of current) {
          if (!removedIds.has(repo.id)) {
            byId.set(repo.id, repo);
          }
        }
        for (const repo of added) {
          byId.set(repo.id, repo);
        }
        return [...byId.values()];
      };

      // Decision: Nothing to revoke when no repos were removed, or when the authoritative selection is now `all`.
      // `all` covers every repo, so even a stale redelivery whose `repositories_removed` lists repos hasn't
      // dropped coverage. Running revocation on that delta would cancel builds and revoke valid tokens for
      // repos still covered. Just sync the cached set and selection.
      if (removed.length === 0 || selection === 'all') {
        // Decision: Sync under a FOR UPDATE lock on the install row so the write builds on the latest committed
        // repositories (no lost update).
        await db.transaction(async (tx) => {
          const [locked] = await tx
            .select({
              repositories: githubInstallations.repositories,
              repository_selection: githubInstallations.repository_selection,
            })
            .from(githubInstallations)
            .where(eq(githubInstallations.installation_id, String(installationId)))
            .for('update')
            .limit(1);
          await setGitHubInstallationRepositories(
            tx,
            String(installationId),
            computeNext(locked?.repositories ?? []),
            isStaleSelectedDowngrade(locked?.repository_selection) ? 'all' : selection,
          );
        });
        return context.json({ ok: true });
      }

      // Decision: Repos removed from the App orphan connections that still point at them, and in-flight builds keep
      // live deploy tokens. Terminalize those builds with the repo-set write, under a FOR UPDATE lock on
      // the connection rows so an in-flight OIDC exchange is serialized. The DO cancel runs after commit.
      const reason = 'repository removed from github app';
      // Decision: `repo_full_name` can change, so a rename-then-remove leaves the connection with the old name
      // while the payload carries the new name and the immutable id. Match on repository_id (like
      // getGitHubConnectionsByRepo). These are strings because the `repository_id` column is text.
      const removedRepositoryIds = new Set(removed.map((r) => String(r.id)));
      const cancelled = await db.transaction(async (tx) => {
        // Decision: Lock and re-read the install row first, then the connection rows, like member_removed, the
        // connect gate and the deleted/suspend branch, so they can't deadlock. The install-row lock also
        // serializes the repositories write against concurrent installation_repositories deliveries; the
        // connection-row lock serializes an in-flight OIDC exchange.
        const [locked] = await tx
          .select({
            repositories: githubInstallations.repositories,
            repository_selection: githubInstallations.repository_selection,
          })
          .from(githubInstallations)
          .where(eq(githubInstallations.installation_id, String(installationId)))
          .for('update')
          .limit(1);
        const connections = await tx
          .select({
            project_id: githubConnections.project_id,
            repository_id: githubConnections.repository_id,
          })
          .from(githubConnections)
          .where(eq(githubConnections.installation_id, String(installationId)))
          .for('update');
        // Decision: Use the locked selection: a stale `selected` delivery that missed a concurrent widen to `all`
        // mustn't downgrade the row or revoke builds, since `all` still covers each "removed" repo.
        const staleDowngrade = isStaleSelectedDowngrade(locked?.repository_selection);
        await setGitHubInstallationRepositories(
          tx,
          String(installationId),
          computeNext(locked?.repositories ?? []),
          staleDowngrade ? 'all' : selection,
        );
        if (staleDowngrade) {
          return [];
        }
        const acc: Array<TerminatedBuild> = [];
        for (const conn of connections) {
          if (!removedRepositoryIds.has(conn.repository_id)) {
            continue;
          }
          acc.push(...(await terminateBuildsForProject(tx, conn.project_id, { reason })));
        }
        return acc;
      });
      await cancelContainerBuildDos(context.env, cancelled, reason);
      return context.json({ ok: true });
    }

    case 'check_run': {
      const data = payload as CheckRunPayload;
      if (data.action !== 'rerequested') {
        return context.json({ ok: true, ignored: `check_run:${data.action ?? 'unknown'}` });
      }
      // Decision: GitHub sends `rerequested` only for runs our App created, but the App may publish more check
      // names later; match ours explicitly so a future run can't trigger a deploy.
      if (data.check_run?.name !== PLATFORM_BUILD_CHECK_RUN_NAME) {
        return context.json({ ok: true, ignored: 'check_run is not the Platform build' });
      }
      const runId = data.check_run?.id;
      return await rerunBuildForCommit(context, db, {
        installationId: data.installation?.id,
        repoFullName: data.repository?.full_name,
        repoId: data.repository?.id,
        headSha: data.check_run?.head_sha,
        event: 'check_run',
        checkRun: {
          id: runId === undefined || runId === null ? null : String(runId),
          buildId: data.check_run?.external_id ?? null,
          conclusion: data.check_run?.conclusion ?? null,
        },
      });
    }

    case 'check_suite': {
      const data = payload as CheckSuitePayload;
      // Decision: Act only on "Re-run all checks". A suite is `requested` on each push, which the `push` handler
      // already builds, so acting on it would double-enqueue each commit.
      if (data.action !== 'rerequested') {
        return context.json({ ok: true, ignored: `check_suite:${data.action ?? 'unknown'}` });
      }
      return await rerunBuildForCommit(context, db, {
        installationId: data.installation?.id,
        repoFullName: data.repository?.full_name,
        repoId: data.repository?.id,
        headSha: data.check_suite?.head_sha,
        event: 'check_suite',
      });
    }

    case 'workflow_run': {
      const data = payload as WorkflowRunPayload;
      if (data.action !== 'completed') {
        return context.json({ ok: true, ignored: `workflow_run:${data.action ?? 'unknown'}` });
      }
      const runId = data.workflow_run?.id;
      if (runId === undefined || runId === null) {
        return context.json({ ok: true, ignored: 'missing workflow_run id' });
      }
      const runAttempt: unknown = data.workflow_run?.run_attempt;
      if (typeof runAttempt !== 'number' && typeof runAttempt !== 'string') {
        return context.json({ ok: true, ignored: 'missing workflow_run run_attempt' });
      }

      // Decision: A GitHub `run_id` is unique only within a repository, so resolve the payload's repository to a
      // connected project first. Matching by `run_id` alone could finalize another project's build with the
      // same number.
      const installationId = data.installation?.id;
      const repoFullName = data.repository?.full_name;
      const repoId = data.repository?.id;
      if (
        installationId === undefined ||
        installationId === null ||
        !repoFullName ||
        repoId === undefined ||
        repoId === null
      ) {
        return context.json({ ok: true, ignored: 'missing workflow_run routing fields' });
      }
      const connections = await getGitHubConnectionsByRepo(
        db,
        String(installationId),
        String(repoId),
      );
      if (connections.length === 0) {
        return context.json({ ok: true, ignored: 'no matching connection' });
      }
      // Decision: A rerun reuses the run_id with a higher run_attempt, so resolve by attempt too: a late completion
      // for attempt 1 mustn't resolve to attempt 2's active build.
      const runAttemptStr = String(runAttempt);
      // Decision: One repo can back several github_actions projects sharing one run_id and attempt. GitHub fires
      // workflow_run:completed once, so collect each matching build, not only the first; otherwise the
      // others stay active until the 60-minute reaper (holding slots, extending tokens, mislabeling a
      // success).
      const candidates: Array<Build> = [];
      for (const connection of connections) {
        const candidate = await getBuildByProjectRunIdAndAttempt(
          db,
          connection.project_id,
          String(runId),
          runAttemptStr,
        );
        if (candidate) {
          candidates.push(candidate);
        }
      }
      if (candidates.length === 0) {
        return context.json({ ok: true, ignored: 'no matching build' });
      }

      const succeeded = data.workflow_run?.conclusion === 'success';
      // Decision: The "Platform Build" check reports GitHub's run outcome, so its conclusion comes from the payload,
      // not from our build status.
      const checkConclusion = mapWorkflowRunConclusion(data.workflow_run?.conclusion);
      const headSha = data.workflow_run?.head_sha;

      const buildIds: Array<string> = [];
      for (const candidate of candidates) {
        const candidateHeadSha = headSha ?? candidate.commit_sha;

        // Decision: Complete the "Platform Build" check from GitHub's conclusion, separately from the build-status CAS
        // below. github_actions builds have no BuildManager DO, so completion happens here. The check has to
        // be finalized even when our row was already made terminal out of band (push supersede, OIDC
        // latest-wins, disconnect, config change, uninstall, repo removal, teardown, reaper): none of those
        // touch the check, and GitHub still fires workflow_run:completed. So this runs before the
        // active-status skip. It's idempotent, guarded on `check_run_id`, and deferred with `waitUntil` so a
        // slow or failing Checks call can't affect the webhook 2xx.
        if (candidate.check_run_id) {
          const short = (candidateHeadSha ?? '').slice(0, 7);
          const branchLabel = candidate.branch ?? '';
          const checkRunId = candidate.check_run_id;
          const detailsUrl = candidate.logs_url ?? undefined;
          const title =
            checkConclusion === 'success'
              ? 'Platform deploy succeeded'
              : checkConclusion === 'cancelled'
                ? 'Platform deploy cancelled'
                : 'Platform deploy failed';
          const summary =
            checkConclusion === 'success'
              ? `Deployed \`${branchLabel}\` @ ${short} via GitHub Actions`
              : checkConclusion === 'cancelled'
                ? `GitHub Actions run for \`${branchLabel}\` @ ${short} was cancelled`
                : `GitHub Actions deploy failed for \`${branchLabel}\` @ ${short}`;
          context.executionCtx.waitUntil(
            (async () => {
              try {
                await completeCheckRun(
                  context.env,
                  String(installationId),
                  repoFullName,
                  checkRunId,
                  {
                    conclusion: checkConclusion,
                    title,
                    summary,
                    detailsUrl,
                  },
                );
              } catch (error) {
                console.warn('[webhooks] workflow_run: best-effort completeCheckRun failed', error);
              }
            })(),
          );
        }

        // Decision: CAS-guarded: only finalize a build that's still active. A redelivered completion or an
        // out-of-band terminalizer that won leaves the row untouched, so a stale delivery can't overwrite the
        // recorded outcome. The check was already completed above; it tracks GitHub's run, not our row.
        if (!ACTIVE_BUILD_STATUSES.includes(candidate.status)) {
          continue;
        }

        // Decision: Resolve each candidate's deployment separately (different project, different deployment for the
        // same SHA). A transient failure on this read mustn't skip the terminal write below, or the build
        // stays active, keeps its token and holds a slot until the reaper. On failure, finalize without the
        // deployment link (like BuildManager.onStop on the container path).
        let deploymentId: string | null = null;
        if (succeeded && candidateHeadSha) {
          try {
            const deployment = await getDeploymentByProjectAndCommit(
              db,
              candidate.project_id,
              candidateHeadSha,
            );
            deploymentId = deployment?.id ?? null;
          } catch (error) {
            console.error(
              '[webhooks] workflow_run: deployment lookup failed; finalizing without link',
              error,
            );
          }
        }

        // Decision: The active check above and this write aren't atomic, so a concurrent terminalizer can set the row
        // to `cancelled` in between. `markBuildTerminalIfActive` writes only while the row is active, so it
        // doesn't overwrite that and doesn't link a deployment to a cancelled build. Collect only the ids it
        // changed.
        const changed = await markBuildTerminalIfActive(
          db,
          candidate.id,
          succeeded ? 'complete' : 'failed',
          { completedAt: new Date().toISOString(), deploymentId },
        );
        if (changed) {
          buildIds.push(candidate.id);
        }
      }

      if (buildIds.length === 0) {
        return context.json({ ok: true, ignored: 'build already terminal' });
      }
      return context.json({ ok: true, buildIds });
    }

    case 'organization': {
      const data = payload as OrganizationPayload;
      // Decision: Only membership removal severs access. Other actions are accepted and ignored; a re-added member
      // re-joins through the authorize round trip.
      if (data.action !== 'member_removed') {
        return context.json({ ok: true, ignored: `organization:${data.action ?? 'unknown'}` });
      }
      const orgId = data.organization?.id;
      const removedGithubUserId = data.membership?.user?.id;
      if (orgId == null || removedGithubUserId == null) {
        return context.json({ ok: true, ignored: 'organization: missing ids' });
      }

      // Decision: All installations under this org, by account_id and 'Organization'. Resolved first because the
      // membership query below is scoped to them.
      // This returns early with no tombstone when the org has no install row yet (a removal racing ahead
      // of installation.created). That gap is bounded by the live-proof residual: a fresh org owner-adopt
      // needs a live `authorizeInstallViaUserToken` proof that fails once GitHub propagates the removal,
      // and the personal fallback can't fire (account.id is the org's id). So no account-level tombstone
      // is added.
      const orgInstalls = await getGitHubInstallationsByAccount(db, String(orgId), 'Organization');
      if (orgInstalls.length === 0) {
        return context.json({ ok: true, ignored: 'organization: no org installs' });
      }
      const orgInstallIds = orgInstalls.map((i) => i.installation_id);

      // Decision: Sever and tombstone atomically. FOR UPDATE on the affected users' connection rows serializes an
      // in-flight OIDC exchange. Terminating revokes in-flight build tokens; deleting removes the future
      // auto-deploy trigger. The membership cache is cleared whatever the connection count. The tombstone
      // is stamped once, keyed by the removed GitHub account id from the payload. The DO cancel is awaited
      // after commit.
      // A plain redelivery is harmless. A stale redelivery after a remove, re-add and re-join cuts the
      // fresh connection and over-advances the tombstone. That's fail-safe (over-revoke, not under-revoke)
      // and the user can re-join. Don't gate the sever on a live GET /orgs/:org/memberships/:user check:
      // when GitHub's API lags a real removal that would under-revoke, and since we return 2xx nothing
      // would redeliver.
      // Connections are OAuth-backed, so the user to sever is `getUserByOAuthAccount('github', X)`. That
      // lookup runs inside the transaction after the lock and tombstone, so a redemption that committed
      // while we waited is seen and severed.
      const reason = 'org membership removed';
      const cancelled = await db.transaction(async (tx) => {
        // Decision: Lock each org install row first, sorted, to avoid deadlock. It's the same row the connect gate
        // locks, so a concurrent member connect and this revocation are serialized. The lock comes before the
        // connection scan so a connect that commits first is seen and severed.
        for (const installId of [...orgInstallIds].sort()) {
          await tx
            .select({ id: githubInstallations.id })
            .from(githubInstallations)
            .where(eq(githubInstallations.installation_id, installId))
            .for('update');
        }
        // Decision: Stamp the tombstone first and unconditionally, keyed by the removed GitHub account id X: the
        // identity the stateless join_code and connect_grant carry, known from the payload even with no
        // Platform user to sever. The membership delete below is a TTL cache and can't make revocation
        // monotonic alone. `revoked_at = clock_timestamp()` per install rejects a later replay of a
        // pre-removal artifact (iat <= revoked_at); a re-join after re-add mints iat > revoked_at and is
        // honored. Write it under the install-row lock even when no user is affected.
        await recordInstallationRevocations(tx, orgInstallIds, String(removedGithubUserId));
        // Decision: Resolve the affected user under the lock, after the tombstone, so a redemption that committed
        // while we waited is seen and severed. Either member_removed locks first (the tombstone blocks the
        // redemption) or the redemption commits first (this read sees its connection).
        // Connections record the owner or admin whose OAuth proof authorized them, so the removed user's
        // connections are the ones they authorized.
        const removedUser = await getUserByOAuthAccount(tx, 'github', String(removedGithubUserId));
        const acc: Array<TerminatedBuild> = [];
        if (removedUser) {
          const conns = await tx
            .select({ project_id: githubConnections.project_id })
            .from(githubConnections)
            .where(
              and(
                inArray(githubConnections.installation_id, orgInstallIds),
                eq(githubConnections.authorized_by_user_id, removedUser.id),
              ),
            )
            .for('update');
          for (const conn of conns) {
            acc.push(...(await terminateBuildsForProject(tx, conn.project_id, { reason })));
            await deleteGitHubConnection(tx, conn.project_id);
          }
          // Decision: Guarded on the user id, so a different bearer's membership isn't touched.
          await deleteGitHubInstallationMembers(tx, orgInstallIds, removedUser.id);
        }
        // Decision: Delete the browser-proof memberships keyed by GitHub id X across the org installs, whatever
        // bearer holds them. A membership's `github_account_id` is the browser proof from JOIN, separate
        // from the bearer's OAuth identity, so it doesn't back a connection: this touches no connection and
        // no membership keyed by another id.
        await deleteGitHubInstallationMembersByGithubAccount(
          tx,
          orgInstallIds,
          String(removedGithubUserId),
        );
        return acc;
      });
      await cancelContainerBuildDos(context.env, cancelled, reason);
      return context.json({ ok: true });
    }

    default:
      return context.json({ ok: true, ignored: event });
  }
}

// Decision: Direct GitHub App webhook receiver for installations whose API origin isn't behind Access; the
// raw GitHub HMAC is the authentication. Access-protected installations use the standalone ingress,
// which calls a separate internal operation after adding its own proof.
app.post('/github', async (context) => {
  const secret = context.env.GITHUB_WEBHOOK_SECRET;
  if (typeof secret !== 'string' || secret === '') {
    return context.json({ error: 'github app not configured' }, 503);
  }

  let raw: Uint8Array;
  let event: string;
  let signature: string;
  try {
    ({ event, signature } = readGitHubWebhookHeaders(context.req.raw.headers, {
      requireDelivery: false,
    }));
    raw = await readBoundedGitHubWebhookBody(context.req.raw);
  } catch (error) {
    if (error instanceof GitHubWebhookRequestError) {
      if (error.code === 'invalid_signature_header') {
        return context.json({ error: 'invalid signature' }, 401);
      }
      return context.json({ error: error.code }, error.status);
    }
    throw error;
  }

  if (!(await verifyGithubWebhookSignature(raw, signature, secret))) {
    return context.json({ error: 'invalid signature' }, 401);
  }
  return handleVerifiedGitHubWebhook(context, raw, event);
});

export const webhookRoutes = app;
