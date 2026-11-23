import { and, eq, gt, isNull } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { verifyJwt } from '../auth/jwt.ts';
import { activeOAuthApproval, OAuthError } from '../auth/oauth.ts';
import { validateHumanSession } from '../auth/sessions.ts';
import { ACTIVE_BUILD_STATUSES, getBuild, getUser } from '../db.ts';
import { isDevBypass } from '../env.ts';
import type { ApiEnv } from '../env.ts';
import { projectDeployCredentials, projects, users } from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';

/**
 * Endpoints a scoped (`aud:'deploy'`) token may call. A remote-build deploy
 * token authenticates as the build's billing owner and is minted for one
 * purpose only — running the real `bwf deploy` CLI against the single project
 * named in `payload.project`. Without this allowlist the token could reach every
 * route mounted under `/projects/*` (delete, secrets PUT, github connect,
 * domains, rollback, cancel), so a leaked
 * 15-minute CI token could take over the project. Default-deny: anything not
 * listed here is rejected with 403.
 *
 * Procedures under `/rpc` have their own allowlist below. No REST call is open to a deploy
 * token any more.
 *
 * `:id` is matched against `payload.project` by the caller — the entries
 * below carry a `null` segment placeholder for the project id.
 */
type DeployAllowEntry = Readonly<{ method: string; segments: ReadonlyArray<string | null> }>;
const DEPLOY_TOKEN_ALLOWLIST: ReadonlyArray<DeployAllowEntry> = [];

/**
 * Procedures a scoped deploy token may call: the ones `bwf deploy` makes. Each checks the token's
 * project itself (`canOnProject`), because a procedure's project is in its body, not its path.
 */
const DEPLOY_TOKEN_PROCEDURES: ReadonlySet<string> = new Set([
  'projects.list',
  'projects.resolve',
  'projects.get',
  'projects.resources',
  'deployments.list',
  'deployments.events',
  'secrets.list',
  'database.provision',
  'deploy.preflight',
  'deploy.finalize',
  'deploy.uploadUrls',
  'deploy.workerUploadUrls',
]);

/** Procedures an OAuth publish approval may call: its one deployment and nothing else. */
const OAUTH_DEPLOY_PROCEDURES: ReadonlySet<string> = new Set([
  'projects.get',
  'deployments.events',
  'deploy.uploadUrls',
  'deploy.finalize',
]);

/** The procedure an `/rpc/<name>` request calls, or null for any other path. */
function rpcProcedure(method: string, path: string): string | null {
  const match = method === 'POST' ? /^\/rpc\/([A-Za-z0-9.]+)$/.exec(path) : null;
  return match?.[1] ?? null;
}

/**
 * Returns `true` when `method`+`path` is on the deploy-token allowlist for the
 * given project scope. `path` is matched as exact, slash-split segments so a
 * sibling like `/deploy/upload-urls` can never be confused with `/deploy`. The
 * `null` placeholder in an entry matches exactly the scoped project id, so a
 * P-scoped token can never reach another project's path.
 */
function isDeployTokenAllowed(method: string, path: string, projectScope: string): boolean {
  const procedure = rpcProcedure(method, path);
  if (procedure) {
    return DEPLOY_TOKEN_PROCEDURES.has(procedure);
  }
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return DEPLOY_TOKEN_ALLOWLIST.some((entry) => {
    if (entry.method !== method || entry.segments.length !== segments.length) {
      return false;
    }
    return entry.segments.every((expected, index) =>
      expected === ':deploymentId'
        ? /^[A-Za-z0-9_-]{1,128}$/.test(segments[index]!)
        : expected === null
          ? segments[index] === projectScope
          : segments[index] === expected,
    );
  });
}

export const authMiddleware: MiddlewareHandler<ApiEnv> = async (context, next) => {
  if (isDevBypass(context.env) && !context.req.header('Authorization')) {
    const first = await context
      .get('db')
      .select()
      .from(users)
      .limit(1)
      .then((rows) => rows[0]);
    if (first) {
      context.set('user', first);
      return next();
    }
  }

  const header = context.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return context.json(
      { error: 'unauthorized', message: 'Sign in to this platform before continuing.' },
      401,
    );
  }

  const token = header.slice(7);
  // Decision: Accept full `api` tokens and the short-lived scoped token audiences. Verify signature and expiry
  // without pinning the audience, then accept only the listed audiences.
  const payload = await verifyJwt(token, context.env.JWT_SECRET);
  if (!payload || !['api', 'deploy', 'oauth-deploy', 'oauth-preview'].includes(payload.aud)) {
    return context.json(
      {
        error: 'invalid or expired token',
        message:
          'Your sign-in or credential is invalid or has expired. Sign in again, or replace the credential used by your automation.',
      },
      401,
    );
  }

  if (
    payload.aud === 'api' &&
    !(await validateHumanSession(context.get('db'), payload, context.get('companyIdentity')))
  ) {
    return context.json(
      {
        error: 'session revoked; sign in again',
        message:
          'Your session is no longer active. Sign in to this platform again before continuing.',
      },
      401,
    );
  }

  const user = await getUser(context.get('db'), payload.sub);
  if (!user) {
    return context.json(
      {
        error: 'user not found',
        message:
          'This account is no longer available. Sign in with an active account on this platform.',
      },
      401,
    );
  }
  if (isAdminSuspended(user.suspended_reason)) {
    return context.json(
      {
        error: 'account suspended',
        message: 'Your account is suspended. Contact a platform administrator to restore access.',
      },
      403,
    );
  }

  context.set('user', user);
  context.set('tokenAudience', payload.aud as NonNullable<ApiEnv['Variables']['tokenAudience']>);
  const projectId = context.req.path.match(/^\/projects\/(proj_[a-z0-9]+)(?:\/|$)/)?.[1];
  if (projectId && payload.aud !== 'oauth-preview') {
    const [project] = await context
      .get('db')
      .select({ preview: projects.preview_client_id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (
      project?.preview &&
      !(
        payload.aud === 'api' &&
        context.req.method === 'DELETE' &&
        context.req.path === '/projects/' + projectId
      )
    ) {
      return context.json(
        { error: 'Private preview projects can only be updated with preview authorization.' },
        403,
      );
    }
  }
  if (payload.aud === 'oauth-deploy' || payload.aud === 'oauth-preview') {
    try {
      if (!payload.oauthApproval || !payload.project) {
        throw new OAuthError('invalid_token', 'A publish approval is required.', 401);
      }
      const { approval, user: actor } = await activeOAuthApproval(
        context.get('db'),
        payload.oauthApproval,
        context.get('companyIdentity'),
      );
      if (
        actor.id !== payload.sub ||
        approval.data.projectId !== payload.project ||
        (payload.aud === 'oauth-preview') !== (approval.data.kind === 'preview')
      ) {
        throw new OAuthError('invalid_token', 'Invalid publish approval.', 401);
      }
      const path = context.req.path;
      const procedure = rpcProcedure(context.req.method, path);
      const allowed = procedure !== null && OAUTH_DEPLOY_PROCEDURES.has(procedure);
      if (!allowed) {
        throw new OAuthError(
          'access_denied',
          'This credential permits only the approved deployment.',
          403,
        );
      }
      context.set('deployScope', payload.project);
      context.set('oauthApproval', approval.id);
      context.set('deployTokenExpiresAt', payload.exp);
    } catch (error) {
      return context.json(
        {
          error: 'invalid_token',
          message: error instanceof Error ? error.message : 'Invalid approval.',
        },
        error instanceof OAuthError ? error.status : 401,
      );
    }
    return next();
  }
  if (payload.aud === 'api' && payload.sid) {
    context.set('humanSession', { id: payload.sid, audience: 'api' });
  }

  if (payload.aud === 'deploy') {
    // Decision: Each deploy token names its project and is bound to either one build (remote builds) or one
    // revocable CI credential. A token with neither would skip both the build-state and revocation
    // checks below.
    if (!payload.project || (!payload.build && !payload.credential)) {
      return context.json(
        {
          error: 'invalid or expired token',
          message:
            'This deploy credential is invalid. Ask the project owner to issue a replacement.',
        },
        401,
      );
    }
    context.set('deployScope', payload.project);
    // Decision: Bind the token to its build. The deploy endpoint rejects a token whose build is no longer active
    // so a stale runner can't deploy. Undefined for CI credential tokens, which are checked for
    // revocation below.
    context.set('deployBuild', payload.build);
    context.set('deployTokenExpiresAt', payload.exp);
    if (payload.credential) {
      const credential = await context
        .get('db')
        .select({ id: projectDeployCredentials.id })
        .from(projectDeployCredentials)
        .innerJoin(projects, eq(projects.id, projectDeployCredentials.project_id))
        .where(
          and(
            eq(projectDeployCredentials.id, payload.credential),
            eq(projectDeployCredentials.project_id, payload.project),
            eq(projectDeployCredentials.issued_by, payload.sub),
            eq(projects.user_id, payload.sub),
            isNull(projectDeployCredentials.revoked_at),
            gt(projectDeployCredentials.expires_at, new Date().toISOString()),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      if (!credential) {
        return context.json(
          {
            error: 'deploy credential revoked or expired',
            message:
              'This deploy credential has expired or been revoked. Ask the project owner to issue a new credential and update your deployment configuration.',
          },
          401,
        );
      }
      context.set('deployCredential', payload.credential);
    }
    // Decision: Default deny: a deploy token may only reach the endpoints the real `bwf deploy` flow needs, and
    // only for its own project. The deploy.ts cross-project guard stays as defense in depth.
    if (!isDeployTokenAllowed(context.req.method, context.req.path, payload.project)) {
      return context.json(
        {
          error: 'forbidden',
          message:
            'This credential can only deploy to its assigned project. Use a credential issued for the selected project, or sign in with your account to manage project settings and members.',
        },
        403,
      );
    }
    // Decision: A deploy token bound to a build is valid only while that build is in flight. After that it must
    // not change project state (POST /projects/:id/database provisions Hyperdrive,
    // /deploy/{preflight,upload-urls} stage assets), so revoke it here before any allowlisted route
    // runs. The /deploy handler keeps its own guard and final-transaction re-check for a mid-flight
    // supersede. CI credential tokens have no `build` claim and were checked for revocation above.
    if (payload.build) {
      const boundBuild = await getBuild(context.get('db'), payload.build);
      if (
        !boundBuild ||
        !ACTIVE_BUILD_STATUSES.includes(boundBuild.status) ||
        boundBuild.project_id !== payload.project
      ) {
        return context.json(
          {
            error: 'deploy token build is no longer active',
            message:
              'This build is no longer active. Start a new build to obtain a valid deployment credential.',
          },
          403,
        );
      }
    }
  }

  await next();
};
