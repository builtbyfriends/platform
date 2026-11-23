import { Hono } from 'hono';
import { deployTokenTtlSecondsForBuildMinutes, signDeployToken } from '../auth/deploy-token.ts';
import {
  createGithubActionsBuildWithinLimit,
  getGitHubActionsConnectionsByRepo,
  getUser,
  markBuildTerminalIfActive,
  setBuildCheckRunId,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { PLATFORM_BUILD_CHECK_RUN_NAME, createCheckRun } from '../github/check-run.ts';
import {
  getBranchHeadComparisonStatus,
  getRepoInstallation,
} from '../github/installation-token.ts';
import { verifyGithubOidcToken } from '../github/oidc-verify.ts';
import { resolvePlanLimits } from '../plans.ts';
import { PROJECT_PERMISSION_MESSAGES } from '../project-access.ts';
import { isAdminSuspended } from '../suspension.ts';

const app = new Hono<ApiEnv>();

// Decision: Only trusted, write-access-gated trigger events may mint a deploy token. `push` is the scaffolded
// trigger; `workflow_dispatch` is a collaborator-only manual run. PR-family events are rejected:
// `pull_request_target` runs in the base context (so its sha equals the branch head and passes the
// freshness gate) yet can check out untrusted PR-head code. `event_name` is on each Actions OIDC
// token, so requiring it doesn't reject a real push.
const ALLOWED_OIDC_EVENTS = new Set(['push', 'workflow_dispatch']);

// Decision: GitHub's `workflow_ref` and `job_workflow_ref` claims look like
// `OWNER/REPO/PATH/TO/workflow.yml@REF`. Returns the workflow file path between `OWNER/REPO/` and
// `@REF` when the claim names the given repository, else null, so we can confirm the running workflow
// is the connected repo's `bwf-deploy.yml`.
function workflowPathForRepo(workflowRef: string, repository: string): string | null {
  const prefix = `${repository}/`;
  if (!workflowRef.startsWith(prefix)) {
    return null;
  }
  const afterRepo = workflowRef.slice(prefix.length);
  const at = afterRepo.lastIndexOf('@');
  return at === -1 ? afterRepo : afterRepo.slice(0, at);
}

// Decision: POST /auth/github-oidc: GitHub Actions OIDC token exchange. Public: the OIDC token, verified
// against GitHub's JWKS, is the authentication.
// Body: { oidcToken: string, project: string } (project is the slug)
// 200: { token, projectId }. `token` is a project-scoped deploy token (aud:'deploy') whose TTL is the
// owner's plan build timeout plus a margin, so a long build can't expire it mid-deploy.
// Errors: 503 when the GitHub App isn't configured (so it's safe to mount before the App exists),
// 400 for a bad body, 401 for an invalid token or no usable connection.
app.post('/github-oidc', async (context) => {
  if (
    typeof context.env.GITHUB_APP_ID !== 'string' ||
    context.env.GITHUB_APP_ID === '' ||
    typeof context.env.GITHUB_APP_PRIVATE_KEY !== 'string' ||
    context.env.GITHUB_APP_PRIVATE_KEY === ''
  ) {
    return context.json({ error: 'github app not configured' }, 503);
  }

  let body: { oidcToken?: unknown; project?: unknown };
  try {
    body = await context.req.json<{ oidcToken?: unknown; project?: unknown }>();
  } catch {
    return context.json({ error: 'invalid body' }, 400);
  }

  if (typeof body.oidcToken !== 'string' || body.oidcToken === '') {
    return context.json({ error: 'oidcToken is required' }, 400);
  }
  const projectSlug = typeof body.project === 'string' ? body.project : undefined;

  // Decision: The scaffolded workflow requests audience `platform`. Enforce it so a token minted for another
  // audience can't be replayed here.
  const claims = await verifyGithubOidcToken(body.oidcToken, {
    // Decision: bwf 1.9.1 on npm asks GitHub for a token with the old audience.
    audience: ['platform', 'nosam'],
  });
  if (!claims) {
    return context.json({ error: 'invalid or expired oidc token' }, 401);
  }

  // Decision: The claims used for routing and identity must be non-empty strings. GitHub mints them on each
  // Actions OIDC token; a token without them is malformed and must not authorize a deploy.
  if (typeof claims.repository_id !== 'string' || claims.repository_id === '') {
    return context.json({ error: 'oidc token missing repository_id' }, 401);
  }
  if (typeof claims.repository_owner_id !== 'string' || claims.repository_owner_id === '') {
    return context.json({ error: 'oidc token missing repository_owner_id' }, 401);
  }
  if (typeof claims.run_attempt !== 'string' || claims.run_attempt === '') {
    return context.json({ error: 'oidc token missing run_attempt' }, 401);
  }
  const workflowRef =
    typeof claims.job_workflow_ref === 'string' && claims.job_workflow_ref !== ''
      ? claims.job_workflow_ref
      : claims.workflow_ref;
  if (typeof workflowRef !== 'string' || workflowRef === '') {
    return context.json({ error: 'oidc token missing workflow_ref' }, 401);
  }

  // Decision: Only an allowlisted trigger event may mint a deploy token (see ALLOWED_OIDC_EVENTS). This rejects
  // PR-family events, whose base-context claims would pass the branch and freshness gates, before any
  // DB or GitHub work.
  if (typeof claims.event_name !== 'string' || !ALLOWED_OIDC_EVENTS.has(claims.event_name)) {
    return context.json({ error: 'oidc token event is not an allowed deploy trigger' }, 401);
  }

  const db = context.get('db');
  const connections = await getGitHubActionsConnectionsByRepo(
    db,
    claims.repository_id,
    claims.repository_owner_id,
  );
  if (connections.length === 0) {
    return context.json(
      { error: 'no authorized github actions connection for repository; reconnect the repository' },
      401,
    );
  }

  // Decision: A repo may back several github_actions projects. When the workflow names a target slug, select
  // that project's connection, so a repo's OIDC token can't mint a token for another project and an
  // older project can still deploy. With no slug, the repo must map to exactly one project.
  let connection;
  if (projectSlug !== undefined) {
    connection = connections.find((c) => c.project_slug === projectSlug);
    if (!connection) {
      return context.json({ error: 'project does not match connection' }, 401);
    }
  } else if (connections.length === 1) {
    connection = connections[0];
  } else {
    return context.json(
      { error: 'multiple projects connected to repository; specify --project' },
      401,
    );
  }

  // Decision: Defense in depth: the helper already filters on build_executor, but check it here so a later query
  // change can't authorize a container connection through the OIDC path.
  if (connection.build_executor !== 'github_actions') {
    return context.json({ error: 'connection is not configured for github actions' }, 401);
  }

  // Decision: Bind the deploy token to the connection's authorized workflow file (`workflow_path`, default
  // `.github/workflows/bwf-deploy.yml`). The running workflow file must equal that path under the
  // token's own repository, so another workflow that can request `id-token: write` can't act as a
  // deploy oracle. `workflowPathForRepo` matches against `claims.repository` and returns null on a
  // prefix mismatch, so the path can't be spoofed through another repo prefix. Checked after
  // connection selection so each connection pins its own workflow.
  const tokenWorkflowPath = workflowPathForRepo(workflowRef, claims.repository);
  if (tokenWorkflowPath !== connection.workflow_path) {
    return context.json({ error: 'oidc token is not from the bwf deploy workflow' }, 401);
  }

  const user = await getUser(db, connection.user_id);
  if (!user) {
    return context.json({ error: 'connection owner not found' }, 401);
  }
  if (isAdminSuspended(user.suspended_reason)) {
    return context.json(
      { error: 'project owner suspended', message: PROJECT_PERMISSION_MESSAGES['owner-suspended'] },
      403,
    );
  }

  // Decision: Only pushes to the connected branch may mint a deploy token, like the webhook push guard; tag and
  // PR refs are rejected. verifyGithubOidcToken checks the signature but not claim types, so a
  // signed-but-malformed token may carry a missing or non-string `ref`. Guard it before
  // `.startsWith`/`.slice` so it returns the usual 401 instead of a 500.
  if (typeof claims.ref !== 'string' || claims.ref === '') {
    return context.json({ error: 'oidc token missing ref' }, 401);
  }
  if (!claims.ref.startsWith('refs/heads/')) {
    return context.json({ error: 'oidc ref is not a branch' }, 401);
  }
  const branch = claims.ref.slice('refs/heads/'.length);
  if (branch !== connection.branch) {
    return context.json({ error: 'oidc ref does not match connected branch' }, 401);
  }

  // Decision: Fail-closed stale-SHA guard for the auto-deploy path. Proceed only when the branch head is
  // claims.sha ('identical'); reject before createGithubActionsBuildWithinLimit supersedes the newer
  // build and mints a token. 'ahead' means sha is stale, 'behind' means the branch moved back off sha
  // (an abandoned commit), 'diverged' means sha was force-pushed away, and null means the compare API
  // was unreachable. Failing open would let an old run roll the project back during a GitHub outage;
  // the workflow runs on GitHub anyway, so blocking then is acceptable. null is checked first so it
  // stays retryable (503) instead of a hard 409.
  const headComparison = await getBranchHeadComparisonStatus(
    context.env,
    connection.installation_id,
    claims.repository,
    claims.sha,
    branch,
  );
  if (headComparison === null) {
    return context.json({ error: 'unable to verify branch head; retry' }, 503);
  }
  if (headComparison !== 'identical') {
    return context.json({ error: 'oidc sha is not the current branch head' }, 409);
  }

  // Decision: Fail-closed live revocation check. The GitHub Actions path mints no installation token, so a
  // missed or delayed installation, suspend or installation_repositories webhook can leave cached
  // `github_installations` state granting access after the App was removed. One App-JWT call confirms
  // the App still covers the repo before a build row is created (about 200ms on a deploy of minutes).
  // It adds to the cached `account_id === repository_owner_id` check in
  // `getGitHubActionsConnectionsByRepo`.
  const liveInstall = await getRepoInstallation(context.env, claims.repository);
  if (!liveInstall) {
    return context.json({ error: 'github app is not installed on this repository' }, 401);
  }
  if (liveInstall.installationId !== connection.installation_id) {
    return context.json({ error: 'repository is not covered by this installation' }, 401);
  }
  if (liveInstall.accountId !== claims.repository_owner_id) {
    return context.json({ error: 'repository owner does not match installation' }, 401);
  }

  // Decision: Take the build slot and create the `building` row atomically. A workflow may re-request the OIDC
  // token (step retry, rerun of the same run); the helper reuses the in-flight build for this exact run
  // instead of inserting a duplicate that would sit `building` and hold a concurrency slot.
  // The owner's `concurrentBuilds` cap (0 = unlimited) is enforced in the same transaction under a
  // per-user FOR UPDATE lock, so parallel exchanges for different runs can't all read capacity below
  // the cap. Build identity is scoped to the project because a GitHub `run_id` is unique only within a
  // repository; the composite partial-unique index (migration 0021) backstops the same-run race and
  // still allows a rerun once the prior attempt is terminal.
  const githubRunId = String(claims.run_id);
  // Decision: A rerun reuses run_id with a higher run_attempt; persist it so the workflow_run completion handler
  // finishes the right attempt's build.
  const githubRunAttempt = claims.run_attempt;
  const result = await createGithubActionsBuildWithinLimit(db, {
    projectId: connection.project_id,
    commitSha: claims.sha,
    branch,
    githubRunId,
    githubRunAttempt,
    logsUrl: `https://github.com/${claims.repository}/actions/runs/${claims.run_id}`,
    connectionId: connection.id,
    installationId: connection.installation_id,
    repositoryId: connection.repository_id,
    // Decision: tokenWorkflowPath is non-null here: it passed the `!== connection.workflow_path` gate against a NOT
    // NULL column. It's re-checked under the row lock so a concurrent workflow_path PATCH fails this
    // exchange closed.
    expectedWorkflowPath: tokenWorkflowPath,
  });
  if (result.outcome === 'limit-exceeded') {
    return context.json({ error: 'concurrent build limit reached' }, 429);
  }
  if (result.outcome === 'install-revoked') {
    // Decision: A revocation (App suspend or uninstall, repo removal) committed between the resolver checks and
    // this tx; don't mint a token for a repo the App no longer covers. 401 matches the route's other
    // live-install rejects.
    return context.json({ error: 'github app is no longer installed on this repository' }, 401);
  }
  if (result.outcome === 'connection-removed') {
    return context.json({ error: 'github connection was removed' }, 409);
  }
  if (result.outcome === 'connection-replaced') {
    // Decision: The connection was disconnected and reconnected to a different repo between resolution and this tx
    // (same branch and executor, new id); don't mint a token for a project now bound to another repo.
    return context.json({ error: 'github connection was replaced' }, 409);
  }
  if (result.outcome === 'branch-mismatch') {
    return context.json({ error: 'connected branch changed concurrently' }, 409);
  }
  if (result.outcome === 'workflow-mismatch') {
    // Decision: workflow_path was re-pinned between the pre-tx gate and the locked re-read, so the token's workflow
    // is no longer the authorized one.
    return context.json({ error: 'authorized workflow changed concurrently' }, 409);
  }
  if (result.outcome === 'project-deleting') {
    return context.json({ error: 'project is being deleted' }, 409);
  }
  if (result.outcome === 'owner-suspended') {
    return context.json(
      { error: 'project owner suspended', message: PROJECT_PERMISSION_MESSAGES['owner-suspended'] },
      403,
    );
  }
  const build = result.build;
  // Decision: The build helper re-reads and locks the project, so `build.user_id` is the billing owner at
  // admission even if ownership changed after the earlier connection lookup. Use that owner for token
  // identity and timeout sizing.
  const billingOwner = await getUser(db, build.user_id);
  if (!billingOwner) {
    await markBuildTerminalIfActive(db, build.id, 'cancelled', {
      error: 'project owner no longer exists',
      completedAt: new Date().toISOString(),
    });
    return context.json({ error: 'connection owner not found' }, 401);
  }

  // Decision: Post-create freshness re-check for the compare-to-insert race: a newer push between the pre-check
  // and the INSERT is invisible to the push webhook's `terminateBuildsForProject` (the row didn't exist
  // yet), so the stale run would keep an active build and a live deploy token. Now that the row is
  // committed, re-prove the sha is still the branch head; on any other verdict, null included, end the
  // row with a CAS. Ending it on null matters: an orphaned active row holds a slot until the reaper,
  // and a retry re-inserts cleanly. A push after this re-check whose webhook is missed stays bounded by
  // the token TTL.
  const headRecheck = await getBranchHeadComparisonStatus(
    context.env,
    connection.installation_id,
    claims.repository,
    claims.sha,
    branch,
  );
  if (headRecheck !== 'identical') {
    await markBuildTerminalIfActive(db, build.id, 'cancelled', {
      error: 'superseded by newer push during token exchange',
      completedAt: new Date().toISOString(),
    });
    if (headRecheck === null) {
      // Decision: Same stance on null as the pre-check: unverifiable is retryable, not a hard reject (the cancelled
      // row doesn't block the retry).
      return context.json({ error: 'unable to verify branch head; retry' }, 503);
    }
    return context.json({ error: 'oidc sha is not the current branch head' }, 409);
  }

  // Decision: Create the "Platform Build" check run so the github_actions path reports status on the commit like
  // the container path does. It's after the post-create re-check, so the cancel branch above can't
  // strand a run `in_progress`. The Actions executor has no DO, so this is the only place to create it;
  // `workflow_run:completed` finishes it.
  // It's awaited before the token is minted on purpose. Deferring it with `waitUntil` would let a fast
  // repeated exchange read a null `check_run_id` and POST a duplicate, and would let
  // `workflow_run:completed` arrive before the id is persisted, leaving the run stuck. A check-run
  // failure must not fail the exchange, so the block is wrapped and logs errors.
  // `!build.check_run_id` guards a reused in-flight build that already has an id; creating again would
  // orphan the first run. Two truly concurrent exchanges for the same run attempt can still both POST;
  // that needs parallel `bwf deploy` in one attempt, and `setBuildCheckRunId`'s CAS keeps one
  // stable id.
  if (!build.check_run_id) {
    try {
      const checkRunId = await createCheckRun(
        context.env,
        connection.installation_id,
        claims.repository,
        {
          name: PLATFORM_BUILD_CHECK_RUN_NAME,
          headSha: claims.sha,
          externalId: build.id,
          // Decision: The GitHub Actions run page is this build's real details view (the Actions executor has no DO log
          // store), so point `details_url` there, not at the project's public URL. `build.logs_url` is the run
          // URL the webhook completion reads, so create and complete stay consistent.
          detailsUrl: build.logs_url ?? undefined,
          title: 'Platform deploy in progress',
          summary: `Deploying \`${branch}\` @ ${claims.sha.slice(0, 7)} via GitHub Actions`,
        },
      );
      if (checkRunId) {
        await setBuildCheckRunId(db, build.id, checkRunId);
      }
    } catch (error) {
      console.warn('[auth-oidc] best-effort check-run create failed', error);
    }
  }

  // Decision: Size the token to cover the whole workflow (it's exchanged before install, build, upload and
  // finalize), since some tiers allow builds longer than the 15-minute default. Uses the same helper
  // as the container path.
  const token = await signDeployToken(
    {
      projectId: connection.project_id,
      userId: build.user_id,
      login: billingOwner.login,
      buildId: build.id,
    },
    context.env.JWT_SECRET,
    {
      ttlSeconds: deployTokenTtlSecondsForBuildMinutes(
        result.outcome === 'created'
          ? result.timeoutMinutes
          : (await resolvePlanLimits(db, billingOwner.plan)).buildTimeoutMinutes,
      ),
    },
  );

  return context.json({ token, projectId: connection.project_id, buildId: build.id });
});

export const oidcRoutes = app;
