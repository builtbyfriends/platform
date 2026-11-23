import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { calculatePKCECodeChallenge } from 'oauth4webapi';
import { hmacSignState, hmacVerifyState } from '../auth/hmac.ts';
import { CLI_CODE_CHALLENGE_METHOD, isValidCodeVerifier } from '../auth/pkce.ts';
import { isLocalhostRedirect } from '../auth/redirects.ts';
import { capabilityMiddleware } from '../capabilities.ts';
import { DEFAULT_DASHBOARD_URL, MEMBERSHIP_TTL_SECONDS } from '../constants.ts';
import type { Db } from '../db.ts';
import {
  createGitHubConnection,
  deleteGitHubConnection,
  getGitHubAccountIdForUser,
  getGitHubConnection,
  getDbNowMs,
  getGitHubInstallation,
  getGitHubInstallationsByUser,
  getInstallationRevocationAt,
  getInstallationRevocationsForAccount,
  GitHubIdentityAlreadyLinkedError,
  GitHubIdentityConflictError,
  hasActiveInstallationMembership,
  linkGitHubIdentity,
  linkGitHubInstallationToUser,
  terminateBuildsForProject,
  updateGitHubConnection,
  upsertGitHubInstallation,
  upsertGitHubInstallationMember,
} from '../db.ts';
import type { TerminatedBuild } from '../db/builds.ts';
import type { ApiEnv } from '../env.ts';
import { cancelContainerBuildDos } from '../github/cancel-builds.ts';
import { listInstallationRepositories } from '../github/installation-repos.ts';
import { getInstallationAccount, getInstallationToken } from '../github/installation-token.ts';
import {
  authorizeInstallViaUserToken,
  exchangeCodeForUserAccountId,
  isAppUserOAuthConfigured,
  listAuthorizedInstallationIds,
  verifyUserRepoAccess,
} from '../github/user-installations.ts';
import { localhostRedirectResponse } from '../html-redirect.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { githubConnections, githubInstallations, oauthAccounts, projects } from '../schema.ts';
import type { Build, GitHubConnection, GitHubInstallation } from '../types.ts';
import { requireProjectRouteCapability } from './project-access.ts';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';

function publicGitHubConnection(connection: GitHubConnection) {
  const { authorized_by_user_id: authorizationProvenance, ...result } = connection;
  void authorizationProvenance;
  return result;
}

// Decision: The link state lives 10 minutes because a person takes the browser detour. The link_code
// lives 5 minutes (a machine-to-machine turnaround), like the CLI auth-code TTL in routes/auth.ts.
const LINK_STATE_TTL_MS = 10 * 60 * 1000;
const LINK_CODE_TTL_MS = 5 * 60 * 1000;

/**
 * The signed `state` minted by `GET /github/link-url` and verified by the public
 * `GET /github/link-callback`. Deliberately carries NO Platform user id: the bind is
 * deferred to the authenticated `POST /github/link/complete`, keyed on the
 * bearer-token holder (RFC 0074 §"Threat L1"). `purpose` discriminates this
 * state from the install-flow state so the two can never be cross-replayed.
 */
type LinkState = {
  redirect: string;
  purpose: 'link';
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  exp: number;
};

/**
 * The stateless, HMAC-signed `link_code` minted by the public callback and
 * redirected to the initiator's localhost. It binds the GitHub identity proven
 * in the callback (`providerId`) to the PKCE challenge the initiator chose, so
 * only the holder of the matching `code_verifier` can complete the link. Still
 * NO Platform user id — the completing bearer token is the only thing that decides
 * which account the identity binds to.
 */
type LinkCode = {
  providerId: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  exp: number;
};

/**
 * The signed `state` for the JOIN flow (org-shared installs), minted by
 * `GET /github/join-url` and verified by the public `GET /github/join-callback`.
 * Structurally mirrors `LinkState` but with `purpose: 'join'` so the two states
 * can never be cross-replayed. Carries NO Platform user id — the membership bind is
 * deferred to the authenticated `POST /github/join/complete`, keyed on the
 * bearer-token holder (RFC 0074 §"Threat L1").
 */
type JoinState = {
  redirect: string;
  purpose: 'join';
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  exp: number;
};

/**
 * The stateless, HMAC-signed `join_code` minted by the public join callback and
 * redirected to the initiator's localhost. It carries the NUMERIC installation
 * ids the caller was proven (via `GET /user/installations`) to access AND that
 * Platform already tracks, plus the caller's GitHub account id and the PKCE
 * challenge. Still NO Platform user id — the completing bearer token is the only
 * thing that decides which account the memberships bind to. Inert without the
 * matching `code_verifier` (PKCE), which never appears in any URL.
 */
type JoinCode = {
  purpose: 'join';
  installationIds: Array<string>;
  githubAccountId: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  // Decision: When GitHub access was proven (the public callback ran). /join/complete compares it with the
  // per-install revocation tombstone: a join_code minted at or before a revocation is a stale replay
  // from a removed member and is skipped. A code without it is invalid.
  iat: number;
  exp: number;
};

/**
 * The signed `state` for the CONNECT-AUTHORIZE flow (org-shared installs), minted
 * by `GET /github/connect-authorize-url` and verified by the public
 * `GET /github/connect-authorize-callback`. Structurally mirrors `JoinState` but
 * with `purpose: 'connect'` (so it can never be cross-replayed against link/join)
 * and additionally names the specific `installationId` + `repoFullName` the CLI
 * already knows — the callback re-proves the caller can PERSONALLY reach that repo
 * under their own token. Carries NO Platform user id — the connection bind is deferred
 * to the authenticated connect redemption, keyed on the bearer-token
 * holder (RFC 0074 §"Threat L1").
 */
type ConnectState = {
  redirect: string;
  purpose: 'connect';
  installationId: string;
  repoFullName: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  exp: number;
};

/**
 * The stateless, HMAC-signed `connect_grant` minted by the public
 * connect-authorize callback and redirected to the initiator's localhost. It
 * carries the resolved numeric `repositoryId` (proven LIVE via
 * `verifyUserRepoAccess` under the CONNECTING user's own token) and that user's
 * numeric GitHub account id — both NON-null (the callback refuses to mint a grant
 * when either is null, so a grant always binds to a real identity). Still NO Platform
 * user id — the redeeming bearer token is the only thing that decides which
 * project the connection binds to. Inert without the matching `code_verifier`
 * (PKCE), which never appears in any URL.
 */
type ConnectGrant = {
  purpose: 'connect';
  installationId: string;
  repoFullName: string;
  repositoryId: number;
  githubAccountId: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  // Decision: When per-repo GitHub access was proven (the connect-authorize callback ran). The connect gate
  // compares it with the install's revocation tombstone in its go-live transaction: a grant minted
  // at or before a revocation is a stale replay and is rejected. A grant without it is invalid.
  iat: number;
  exp: number;
};

/**
 * Mirror the EXACT `${btoa(JSON.stringify(payload))}.${signature}` scheme the
 * install-url + `/callback` already use (signed with `JWT_SECRET`).
 */
async function signLinkPayload(
  payload: LinkState | LinkCode | JoinState | JoinCode | ConnectState | ConnectGrant,
  secret: string,
): Promise<string> {
  const encoded = btoa(JSON.stringify(payload));
  const signature = await hmacSignState(encoded, secret);
  return `${encoded}.${signature}`;
}

/**
 * Verify a signed link payload (state or code): split on the LAST `.`, check the
 * HMAC, then `JSON.parse(atob(...))`. Returns `null` on any failure (malformed,
 * bad signature, unparseable) so callers fail closed with a single 400.
 */
async function verifyLinkPayload<T>(token: string, secret: string): Promise<T | null> {
  const dotIndex = token.lastIndexOf('.');
  if (dotIndex === -1) {
    return null;
  }
  const encoded = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  const valid = await hmacVerifyState(encoded, signature, secret);
  if (!valid) {
    return null;
  }
  try {
    return JSON.parse(atob(encoded)) as T;
  } catch {
    return null;
  }
}

type AppUserOAuthFlow = 'link' | 'join' | 'connect-authorize';

const APP_USER_OAUTH_NOT_CONFIGURED = {
  error: 'github_oauth_not_configured',
  message: 'GitHub App user OAuth is not configured',
} as const;

// Decision: Derived from the request origin, so no env var is needed. The token exchange has to send the
// same redirect_uri byte for byte as the authorize step: GitHub OAuth rejects a mismatch.
function appUserOAuthCallbackUrl(context: Context<ApiEnv>, flow: AppUserOAuthFlow): string {
  return new URL(`/github/${flow}-callback`, new URL(context.req.url).origin).toString();
}

// Decision: GitHub Apps don't take an OAuth `scope` param: the App's permissions apply, and `GET /user`
// works with any user token.
function appUserAuthorizeUrl(
  context: Context<ApiEnv>,
  flow: AppUserOAuthFlow,
  signedState: string,
): string {
  return (
    `https://github.com/login/oauth/authorize?client_id=${context.env.GITHUB_APP_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(appUserOAuthCallbackUrl(context, flow))}` +
    `&state=${encodeURIComponent(signedState)}`
  );
}

/** Read a begin route's `redirect` query, which must be a localhost URL. */
function readLocalhostRedirectQuery(context: Context<ApiEnv>): string | Response {
  const redirect = context.req.query('redirect');
  if (!redirect) {
    return context.json({ error: 'redirect parameter is required' }, 400);
  }
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirect);
  } catch {
    return context.json({ error: 'redirect must be a localhost URL' }, 400);
  }
  if (!isLocalhostRedirect(redirectUrl)) {
    return context.json({ error: 'redirect must be a localhost URL' }, 400);
  }
  return redirect;
}

function readCodeChallengeQuery(context: Context<ApiEnv>): string | Response {
  const codeChallenge = context.req.query('code_challenge');
  const codeChallengeMethod = context.req.query('code_challenge_method');
  if (!codeChallenge) {
    return context.json({ error: 'code_challenge is required' }, 400);
  }
  if (codeChallengeMethod !== undefined && codeChallengeMethod !== CLI_CODE_CHALLENGE_METHOD) {
    return context.json({ error: 'code_challenge_method must be S256' }, 400);
  }
  return codeChallenge;
}

/**
 * Verify a public callback's signed `state` for `purpose`. Trust is established
 * only by that state; there is no session. The redirect is re-validated at use
 * time — it is the only place the minted code is sent, so it must still be a
 * localhost URL even though the begin route already checked it (defense in depth
 * against a forged-but-valid state).
 *
 * A GitHub denial / missing `code` is bounced to the CLI's localhost listener
 * instead of JSON on the API host, which never reaches the listener and would
 * leave the CLI hanging until timeout.
 */
async function verifyCallbackState<T extends LinkState | JoinState | ConnectState>(
  context: Context<ApiEnv>,
  purpose: T['purpose'],
  hasValidFields: (state: T) => boolean = () => true,
): Promise<{ state: T; redirectUrl: URL; code: string } | Response> {
  const code = context.req.query('code');
  const stateParam = context.req.query('state');
  if (!stateParam) {
    return context.json({ error: 'missing state' }, 400);
  }
  const state = await verifyLinkPayload<T>(stateParam, context.env.JWT_SECRET);
  if (
    !state ||
    state.purpose !== purpose ||
    typeof state.exp !== 'number' ||
    Date.now() >= state.exp ||
    typeof state.redirect !== 'string' ||
    typeof state.codeChallenge !== 'string' ||
    !hasValidFields(state)
  ) {
    return context.json({ error: 'invalid state' }, 400);
  }
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(state.redirect);
  } catch {
    return context.json({ error: 'invalid state' }, 400);
  }
  if (!isLocalhostRedirect(redirectUrl)) {
    return context.json({ error: 'invalid state' }, 400);
  }
  if (!code) {
    redirectUrl.searchParams.set('error', context.req.query('error') || 'github_oauth_failed');
    return localhostRedirectResponse(redirectUrl.toString());
  }
  return { state, redirectUrl, code };
}

/**
 * True only when all GitHub App credentials are configured. Env vars are
 * strings (Cloudflare passes everything as strings), so we exact-string check
 * presence. The install/callback routes return 503 when this is false so the
 * feature is inert in environments without the App wired up.
 */
function isGitHubAppConfigured(env: ApiEnv['Bindings']): boolean {
  return (
    typeof env.GITHUB_APP_ID === 'string' &&
    env.GITHUB_APP_ID !== '' &&
    typeof env.GITHUB_APP_PRIVATE_KEY === 'string' &&
    env.GITHUB_APP_PRIVATE_KEY !== ''
  );
}

/**
 * Resolve a repo's immutable numeric id LIVE via `GET /repos/:full_name`,
 * authenticated with the installation token. Used by the connect route for
 * `all`-repos installs, where the cached `repositories` array is irrelevant (it
 * doesn't enumerate every covered repo). Returns `null` on any non-ok response
 * (e.g. 404 for a repo the installation can't see) so the caller fails closed.
 */
async function resolveRepositoryId(
  env: ApiEnv['Bindings'],
  installationId: string,
  repoFullName: string,
): Promise<number | null> {
  const token = await getInstallationToken(env, installationId);
  const res = await fetch(`${GITHUB_API_BASE}/repos/${repoFullName}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'platform-api',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
  });
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as { id?: number };
  return typeof data.id === 'number' ? data.id : null;
}

/**
 * The caller's numeric GitHub account id (their `github` OAuth `provider_id`),
 * or `null` when the user has no linked GitHub identity (e.g. signed in via
 * Google only). This is the same value matched against
 * `github_installations.account_id` by `linkGitHubInstallationToUser`, so it is
 * the GitHub-side proof that the caller controls an installation's account.
 */
async function getCallerGitHubAccountId(db: Db, userId: string): Promise<string | null> {
  // Decision: Order by the earliest-linked GitHub identity. Without an explicit order, `limit(1)` picks an
  // arbitrary row, so a stray second github row would sign a nondeterministic account id into the
  // install `state`.
  const [row] = await db
    .select({ providerId: oauthAccounts.provider_id })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.user_id, userId), eq(oauthAccounts.provider, 'github')))
    .orderBy(asc(oauthAccounts.created_at))
    .limit(1);
  return row?.providerId ?? null;
}

/**
 * Derive the installation's account (login/id/type) from a repo owner — every
 * repo in an installation shares the owning account. Returns null when no repo
 * owner is available (e.g. an install with no repositories selected yet); the
 * caller then resolves the account authoritatively via the App JWT
 * (`getInstallationAccount`) rather than fabricating a placeholder id.
 */
function deriveAccountFromRepositories(
  owner: { login?: string; id?: number; type?: string } | undefined,
): { login: string; id: string; type: GitHubInstallation['account_type'] } | null {
  if (owner && typeof owner.login === 'string' && typeof owner.id === 'number') {
    return {
      login: owner.login,
      id: String(owner.id),
      type: owner.type === 'Organization' ? 'Organization' : 'User',
    };
  }
  return null;
}

// Decision: /github is mounted outside the global /projects auth, so each route adds (or leaves out)
// `authMiddleware` itself. The public callbacks are authenticated by the signed HMAC state.
export const githubRoutes = new Hono<ApiEnv>()
  .use('*', capabilityMiddleware('managedBuilds'))

  // Decision: The state binds the caller's user id, their GitHub account id and a nonce, so the public
  // callback can find the user and check with GitHub that they own the installation, without a
  // session.
  .get('/install-url', authMiddleware, async (context) => {
    const slug = context.env.GITHUB_APP_SLUG;
    if (typeof slug !== 'string' || slug === '') {
      return context.json({ error: 'GitHub App is not configured' }, 503);
    }

    const user = context.get('user');

    // Decision: The callback uses this account id to prove with GitHub that the caller owns the installation.
    // A user without a linked GitHub identity can't give that proof, so they can't connect.
    const githubAccountId = await getCallerGitHubAccountId(context.get('db'), user.id);
    if (githubAccountId === null) {
      return context.json({ error: 'github_identity_required' }, 403);
    }

    const stateData = JSON.stringify({
      userId: user.id,
      githubAccountId,
      nonce: crypto.randomUUID(),
    });
    const stateEncoded = btoa(stateData);
    const signature = await hmacSignState(stateEncoded, context.env.JWT_SECRET);
    const state = `${stateEncoded}.${signature}`;

    const url = `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
    return context.json({ url });
  })

  .get('/installations', authMiddleware, async (context) => {
    const user = context.get('user');
    const installations = await getGitHubInstallationsByUser(context.get('db'), user.id);
    // Decision: Seeing an organization installation proves only that the caller can see it, not every repo it
    // covers. Don't expose its cached repo list: each repo is shown only after the caller proves access
    // with their own token in the connect-authorize flow. Personal-account owners control the account,
    // so they get the full list.
    return context.json(
      installations.map((inst) =>
        inst.account_type === 'User' && inst.user_id === user.id
          ? inst
          : { ...inst, repositories: [] },
      ),
    );
  })

  // Decision: RFC 0074 link flow with a deferred bind. The GitHub user must end up linked to the Platform
  // account that ran the CLI (the bearer-token holder), not to a user id carried in the OAuth state.
  // Binding in the public callback would allow account-linking CSRF: an attacker mints a link URL,
  // phishes a victim into authorizing, and the victim's GitHub binds to the attacker. So the public
  // callback only mints a PKCE-bound link_code for the initiator's localhost, and the bind happens
  // in the authenticated POST /link/complete, keyed on the token holder.

  .get('/link-url', authMiddleware, async (context) => {
    if (!isAppUserOAuthConfigured(context.env)) {
      return context.json(APP_USER_OAUTH_NOT_CONFIGURED, 503);
    }

    const redirect = readLocalhostRedirectQuery(context);
    if (redirect instanceof Response) {
      return redirect;
    }
    const codeChallenge = readCodeChallengeQuery(context);
    if (codeChallenge instanceof Response) {
      return codeChallenge;
    }

    const state: LinkState = {
      redirect,
      purpose: 'link',
      codeChallenge,
      codeChallengeMethod: CLI_CODE_CHALLENGE_METHOD,
      exp: Date.now() + LINK_STATE_TTL_MS,
    };
    const signedState = await signLinkPayload(state, context.env.JWT_SECRET);

    return context.json({ url: appUserAuthorizeUrl(context, 'link', signedState) });
  })

  // Decision: Trust comes from the signed state minted at /link-url; there's no session. This route doesn't
  // bind an identity: it proves which GitHub account authorized and hands a PKCE-bound link_code
  // to the initiator's localhost.
  .get('/link-callback', async (context) => {
    const verified = await verifyCallbackState<LinkState>(context, 'link');
    if (verified instanceof Response) {
      return verified;
    }
    const { state, redirectUrl, code } = verified;

    const providerId = await exchangeCodeForUserAccountId(
      context.env,
      code,
      appUserOAuthCallbackUrl(context, 'link'),
    );
    if (providerId === null) {
      redirectUrl.searchParams.set('error', 'github_oauth_failed');
      return localhostRedirectResponse(redirectUrl.toString());
    }

    const linkCode: LinkCode = {
      providerId,
      codeChallenge: state.codeChallenge,
      codeChallengeMethod: CLI_CODE_CHALLENGE_METHOD,
      exp: Date.now() + LINK_CODE_TTL_MS,
    };
    const signedLinkCode = await signLinkPayload(linkCode, context.env.JWT_SECRET);

    redirectUrl.searchParams.set('link_code', signedLinkCode);
    // Decision: Return 200 with a JS redirect, not a 302. The target is localhost (checked by
    // isLocalhostRedirect), and `wrangler dev` mangles `Location: http://localhost:*` headers (see
    // html-redirect.ts and meta/lessons.md), which would drop the link_code and stall
    // `bwf github link`.
    return localhostRedirectResponse(redirectUrl.toString());
  })

  // Decision: This is the only place an identity is bound. The bind is keyed on the bearer-token holder,
  // not on anything carried in the link flow. The PKCE verifier has to match the link_code's
  // challenge, so only the initiator can redeem the code.
  .post('/link/complete', authMiddleware, async (context) => {
    const body = await context.req
      .json<{ link_code?: unknown; code_verifier?: unknown }>()
      .catch(() => null);
    if (!body || typeof body.link_code !== 'string' || typeof body.code_verifier !== 'string') {
      return context.json({ error: 'link_code and code_verifier are required' }, 400);
    }

    const linkCode = await verifyLinkPayload<LinkCode>(body.link_code, context.env.JWT_SECRET);
    if (!linkCode || typeof linkCode.providerId !== 'string') {
      return context.json({ error: 'invalid link_code' }, 400);
    }
    if (typeof linkCode.exp !== 'number' || Date.now() >= linkCode.exp) {
      return context.json({ error: 'invalid link_code' }, 400);
    }

    if (
      linkCode.codeChallengeMethod !== CLI_CODE_CHALLENGE_METHOD ||
      !isValidCodeVerifier(body.code_verifier) ||
      (await calculatePKCECodeChallenge(body.code_verifier)) !== linkCode.codeChallenge
    ) {
      return context.json({ error: 'invalid_verifier' }, 400);
    }

    const user = context.get('user');
    try {
      const result = await linkGitHubIdentity(context.get('db'), user.id, linkCode.providerId);

      // Decision: Claim GitHub App installations created before this user linked their GitHub identity, like
      // the login callback in auth.ts. It's best effort on purpose: a backfill failure mustn't fail
      // the link.
      try {
        await linkGitHubInstallationToUser(context.get('db'), linkCode.providerId, user.id);
      } catch (error) {
        console.error(`[github-link] Failed to backfill installations for ${user.id}:`, error);
      }

      return context.json({ status: result });
    } catch (error) {
      if (error instanceof GitHubIdentityAlreadyLinkedError) {
        return context.json({ error: 'github_already_linked' }, 409);
      }
      if (error instanceof GitHubIdentityConflictError) {
        return context.json({ error: 'github_identity_conflict' }, 409);
      }
      throw error;
    }
  })

  // Decision: JOIN flow for org-shared installs, a deferred bind like the link flow. A Platform user who is
  // an org co-member gets access to installations they can already manage on GitHub, without owning
  // them and without a stored GitHub token. The callback lists the installations their user token
  // reaches and keeps the ones Platform tracks; /join/complete records a TTL-cached membership per
  // install, keyed on the bearer-token holder (Threat L1). Access is checked again per repo at
  // connect time: this only caches the org co-membership.

  .get('/join-url', authMiddleware, async (context) => {
    if (!isAppUserOAuthConfigured(context.env)) {
      return context.json(APP_USER_OAUTH_NOT_CONFIGURED, 503);
    }

    const redirect = readLocalhostRedirectQuery(context);
    if (redirect instanceof Response) {
      return redirect;
    }
    const codeChallenge = readCodeChallengeQuery(context);
    if (codeChallenge instanceof Response) {
      return codeChallenge;
    }

    const state: JoinState = {
      redirect,
      purpose: 'join',
      codeChallenge,
      codeChallengeMethod: CLI_CODE_CHALLENGE_METHOD,
      exp: Date.now() + LINK_STATE_TTL_MS,
    };
    const signedState = await signLinkPayload(state, context.env.JWT_SECRET);

    return context.json({ url: appUserAuthorizeUrl(context, 'join', signedState) });
  })

  // Decision: Trust comes from the signed state minted at /join-url; there's no session. This route doesn't
  // bind a membership: it intersects the installations the caller can reach with the ones Platform
  // tracks and hands a PKCE-bound join_code to the initiator's localhost.
  .get('/join-callback', async (context) => {
    const verified = await verifyCallbackState<JoinState>(context, 'join');
    if (verified instanceof Response) {
      return verified;
    }
    const { state, redirectUrl, code } = verified;

    const db = context.get('db');
    // Decision: Take the proof time before the GitHub proof, so `iat` is a conservative lower bound: an org
    // removal recorded at or after this proof has revoked_at >= iat, so the code is rejected even if
    // GitHub's propagation lag let the proof succeed. Use the DB clock to match the tombstone.
    const proofIatMs = await getDbNowMs(db);

    // Decision: The caller's user token is used only for this read and isn't stored. An empty set means the
    // exchange failed or the caller manages no installations, so bounce to the CLI's localhost.
    const { installationIds, callerAccountId } = await listAuthorizedInstallationIds(
      context.env,
      code,
      appUserOAuthCallbackUrl(context, 'join'),
    );
    if (installationIds.size === 0) {
      redirectUrl.searchParams.set('error', 'github_oauth_failed');
      return localhostRedirectResponse(redirectUrl.toString());
    }
    if (callerAccountId === null) {
      // Decision: GET /user/installations worked but GET /user didn't, so the membership can't be tied to a
      // durable GitHub account id. Fail closed: member_removed severs by proof id and could never match a
      // null-account membership. This matches the connect-authorize refusal on a null callerAccountId.
      redirectUrl.searchParams.set('error', 'github_oauth_failed');
      return localhostRedirectResponse(redirectUrl.toString());
    }

    // Decision: Keep only installs Platform tracks and that are Organization accounts. A membership row keys on
    // a numeric installation id with no FK, so join codes must only name installs we know.
    const eligible: Array<string> = [];
    for (const installationId of installationIds) {
      const install = await getGitHubInstallation(db, installationId);
      // Decision: Org sharing is Organization-only: personal installs have no member_removed revocation path, so
      // they can't be join targets. A user owns their personal install and connects it directly.
      if (install !== null && install.account_type === 'Organization') {
        eligible.push(installationId);
      }
    }

    const joinCode: JoinCode = {
      purpose: 'join',
      installationIds: eligible,
      githubAccountId: callerAccountId,
      codeChallenge: state.codeChallenge,
      codeChallengeMethod: CLI_CODE_CHALLENGE_METHOD,
      // Decision: `iat` was sampled before the proof as a conservative lower bound, on the DB clock, to compare
      // with the DB-clock `revoked_at` tombstone. `exp` is on the Worker clock, compared with the
      // Worker's `Date.now()` at redemption.
      iat: proofIatMs,
      exp: Date.now() + LINK_CODE_TTL_MS,
    };
    const signedJoinCode = await signLinkPayload(joinCode, context.env.JWT_SECRET);

    redirectUrl.searchParams.set('join_code', signedJoinCode);
    // Decision: Return 200 with a JS redirect, not a 302: `wrangler dev` mangles
    // `Location: http://localhost:*` headers.
    return localhostRedirectResponse(redirectUrl.toString());
  })

  // Decision: This is the only place a membership is bound. The bind is keyed on the bearer-token holder, not
  // on anything in the join flow (Threat L1). The PKCE verifier has to match the join_code's
  // challenge, so only the initiator can redeem the code.
  .post('/join/complete', authMiddleware, async (context) => {
    // Decision: Reject redemption of an already-minted join_code too when App user OAuth isn't configured, so
    // the config works as a kill switch. /join-url already returns 503.
    if (!isAppUserOAuthConfigured(context.env)) {
      return context.json(APP_USER_OAUTH_NOT_CONFIGURED, 503);
    }
    const body = await context.req
      .json<{ join_code?: unknown; code_verifier?: unknown }>()
      .catch(() => null);
    if (!body || typeof body.join_code !== 'string' || typeof body.code_verifier !== 'string') {
      return context.json({ error: 'join_code and code_verifier are required' }, 400);
    }

    const joinCode = await verifyLinkPayload<JoinCode>(body.join_code, context.env.JWT_SECRET);
    if (
      !joinCode ||
      joinCode.purpose !== 'join' ||
      !Array.isArray(joinCode.installationIds) ||
      typeof joinCode.githubAccountId !== 'string' ||
      joinCode.githubAccountId === ''
    ) {
      return context.json({ error: 'invalid join_code' }, 400);
    }
    if (
      typeof joinCode.exp !== 'number' ||
      Date.now() >= joinCode.exp ||
      typeof joinCode.iat !== 'number'
    ) {
      return context.json({ error: 'invalid join_code' }, 400);
    }

    if (
      joinCode.codeChallengeMethod !== CLI_CODE_CHALLENGE_METHOD ||
      !isValidCodeVerifier(body.code_verifier) ||
      (await calculatePKCECodeChallenge(body.code_verifier)) !== joinCode.codeChallenge
    ) {
      return context.json({ error: 'invalid_verifier' }, 400);
    }

    const db = context.get('db');
    const user = context.get('user');
    const count = await db.transaction(async (tx) => {
      // Decision: Lock the target install rows first, sorted. This is the global order that member_removed and
      // the connect gate share, so a concurrent member_removed is serialized: its delete and tombstone
      // are committed before we read tombstones and upsert, and we don't bring back a membership it just
      // revoked. Locking only installs (no connections) can't deadlock with member_removed, teardown or
      // the connect gate.
      for (const installationId of [...joinCode.installationIds].sort()) {
        await tx
          .select({ id: githubInstallations.id })
          .from(githubInstallations)
          .where(eq(githubInstallations.installation_id, installationId))
          .for('update');
      }
      // Decision: Load the revocation tombstones for the join_code's GitHub account id, which member_removed
      // tombstones from the webhook payload even when no Platform user existed yet. A join_code minted at
      // or before a revocation (iat <= revoked_at) is a stale replay, so its installs are skipped. Under
      // the install-row lock this is race-safe; the connect route's in-transaction check stays the
      // deploy gate.
      const revocations = await getInstallationRevocationsForAccount(
        tx,
        joinCode.installationIds,
        joinCode.githubAccountId,
      );
      let c = 0;
      for (const installationId of joinCode.installationIds) {
        const install = await getGitHubInstallation(tx, installationId);
        if (install === null) {
          continue;
        }
        // Decision: The join_code lists only Organization installs, and GitHub doesn't turn an organization back
        // into a personal account, so every install here has no owner. The installer joins like any other
        // member.
        // Skip installs whose join_code predates a revocation (a stale replay). A re-join after a re-add
        // mints a fresh join_code with iat > revoked_at, which isn't skipped: the tombstone is a
        // high-water mark, not a ban.
        const revokedAtMs = revocations.get(installationId);
        if (revokedAtMs !== undefined && revokedAtMs >= joinCode.iat) {
          continue;
        }
        // Decision: Threat L1: key on the authenticated bearer-token holder, not on the GitHub account id in the
        // join_code. That id is stored only as the membership's verified-against metadata.
        await upsertGitHubInstallationMember(tx, {
          installationId,
          userId: user.id,
          githubAccountId: joinCode.githubAccountId,
          ttlSeconds: MEMBERSHIP_TTL_SECONDS,
        });
        c += 1;
      }
      return c;
    });

    return context.json({ status: 'joined', count });
  })

  // Decision: CONNECT-AUTHORIZE flow for org-shared installs, a deferred bind like JOIN. Before a non-owner
  // org member connects a project to a repo in a shared install, they prove under their own GitHub
  // token that they can reach that repo through that install. Holding a shared installation id isn't
  // enough (per-repo confused deputy, RFC 0074 Threat L1). This mints a PKCE-bound connect_grant that
  // the authenticated connect route redeems.

  .get('/connect-authorize-url', authMiddleware, async (context) => {
    if (!isAppUserOAuthConfigured(context.env)) {
      return context.json(APP_USER_OAUTH_NOT_CONFIGURED, 503);
    }

    const redirect = readLocalhostRedirectQuery(context);
    if (redirect instanceof Response) {
      return redirect;
    }
    const installationId = context.req.query('installationId');
    const repoFullName = context.req.query('repoFullName');
    if (!installationId || !/^\d{1,20}$/.test(installationId)) {
      return context.json({ error: 'installationId is required' }, 400);
    }
    if (!repoFullName) {
      return context.json({ error: 'repoFullName is required' }, 400);
    }
    const codeChallenge = readCodeChallengeQuery(context);
    if (codeChallenge instanceof Response) {
      return codeChallenge;
    }

    // Decision: No ownership or membership check here on purpose: this route only starts the per-repo
    // authorize round trip. The gates are the per-repo check in the callback and the membership and
    // ownership checks at redemption.
    const state: ConnectState = {
      redirect,
      purpose: 'connect',
      installationId,
      repoFullName,
      codeChallenge,
      codeChallengeMethod: CLI_CODE_CHALLENGE_METHOD,
      exp: Date.now() + LINK_STATE_TTL_MS,
    };
    const signedState = await signLinkPayload(state, context.env.JWT_SECRET);

    return context.json({ url: appUserAuthorizeUrl(context, 'connect-authorize', signedState) });
  })

  // Decision: Trust comes from the signed state minted at /connect-authorize-url; there's no session. This
  // route binds nothing (it has no bearer identity). It proves per-repo access under the caller's own
  // token and hands a PKCE-bound connect_grant to the initiator's localhost.
  .get('/connect-authorize-callback', async (context) => {
    const verified = await verifyCallbackState<ConnectState>(
      context,
      'connect',
      (state) => typeof state.installationId === 'string' && typeof state.repoFullName === 'string',
    );
    if (verified instanceof Response) {
      return verified;
    }
    const { state, redirectUrl, code } = verified;

    // Decision: Take the proof time before the GitHub proof, so `iat` is a conservative lower bound: an org
    // removal recorded at or after this proof has revoked_at >= iat, so the grant is rejected even if
    // GitHub's propagation lag let the proof succeed. Use the DB clock to match the tombstone.
    const proofIatMs = await getDbNowMs(context.get('db'));

    // Decision: Per-repo trust boundary, checked under the connecting user's own token. The redirect_uri has
    // to match the one /connect-authorize-url sent byte for byte: GitHub rejects a mismatch.
    const { repositoryId, callerAccountId } = await verifyUserRepoAccess(
      context.env,
      code,
      state.installationId,
      state.repoFullName,
      appUserOAuthCallbackUrl(context, 'connect-authorize'),
    );

    // Decision: Confused-deputy close: a null repositoryId means the caller can't reach this repo through the
    // install, and a null callerAccountId means the exchange gave no identity. Either way, mint no grant.
    if (repositoryId === null || callerAccountId === null) {
      redirectUrl.searchParams.set('error', 'repo_not_accessible');
      return localhostRedirectResponse(redirectUrl.toString());
    }

    // Decision: This public callback has no bearer identity, so it writes no membership row. The bind happens
    // in the authenticated redemption, keyed on the bearer-token holder.
    const grant: ConnectGrant = {
      purpose: 'connect',
      installationId: state.installationId,
      repoFullName: state.repoFullName,
      repositoryId,
      githubAccountId: callerAccountId,
      codeChallenge: state.codeChallenge,
      codeChallengeMethod: CLI_CODE_CHALLENGE_METHOD,
      // Decision: `iat` was sampled before the proof as a conservative lower bound, on the DB clock, to compare
      // with the DB-clock `revoked_at` tombstone. `exp` is on the Worker clock, compared with the
      // Worker's `Date.now()` at redemption.
      iat: proofIatMs,
      exp: Date.now() + LINK_CODE_TTL_MS,
    };
    const signedGrant = await signLinkPayload(grant, context.env.JWT_SECRET);

    redirectUrl.searchParams.set('connect_grant', signedGrant);
    // Decision: Return 200 with a JS redirect, not a 302: `wrangler dev` mangles
    // `Location: http://localhost:*` headers.
    return localhostRedirectResponse(redirectUrl.toString());
  })

  .get('/callback', async (context) => {
    if (!isGitHubAppConfigured(context.env)) {
      return context.json({ error: 'GitHub App is not configured' }, 503);
    }

    const installationId = context.req.query('installation_id');
    const state = context.req.query('state');
    // Decision: GitHub sends `code` only when the App has "Request user authorization (OAuth) during
    // installation" turned on. It's used to authorize org installs.
    const code = context.req.query('code');

    if (!state) {
      return context.json({ error: 'missing state' }, 400);
    }

    const dotIndex = state.lastIndexOf('.');
    if (dotIndex === -1) {
      return context.json({ error: 'invalid state' }, 400);
    }
    const stateEncoded = state.slice(0, dotIndex);
    const signature = state.slice(dotIndex + 1);
    const valid = await hmacVerifyState(stateEncoded, signature, context.env.JWT_SECRET);
    if (!valid) {
      return context.json({ error: 'invalid state signature' }, 400);
    }

    let userId: string;
    let stateGitHubAccountId: string;
    try {
      const parsed = JSON.parse(atob(stateEncoded)) as {
        userId?: unknown;
        githubAccountId?: unknown;
      };
      if (typeof parsed.userId !== 'string' || parsed.userId === '') {
        return context.json({ error: 'invalid state' }, 400);
      }
      if (typeof parsed.githubAccountId !== 'string' || parsed.githubAccountId === '') {
        return context.json({ error: 'invalid state' }, 400);
      }
      userId = parsed.userId;
      stateGitHubAccountId = parsed.githubAccountId;
    } catch {
      return context.json({ error: 'invalid state' }, 400);
    }

    // Decision: GitHub sends setup_action 'install' for a fresh install and 'update' when the user edits the
    // repo selection. Both carry installation_id; without it, the user cancelled.
    if (!installationId) {
      return context.json({ error: 'missing installation_id' }, 400);
    }

    // Decision: The installation token doesn't authorize `GET /app/installations/:id` (that needs the App JWT),
    // so account metadata comes from a repo owner: every repo in an installation shares the owner.
    const token = await getInstallationToken(context.env, installationId);
    const { repositories, owner, repositorySelection } = await listInstallationRepositories(token);
    // Decision: With no repos yet there's no owner to derive from, so resolve the account with the App JWT
    // instead of making up an id. A failed lookup fails closed (502): a made-up id would reject a valid
    // empty install and store a bad account_id that later breaks the sign-in backfill and the OIDC
    // owner guard.
    let account = deriveAccountFromRepositories(owner);
    if (account === null) {
      const resolved = await getInstallationAccount(context.env, installationId);
      if (resolved === null) {
        return context.json({ error: 'unable to resolve installation account' }, 502);
      }
      account = { login: resolved.login, id: resolved.accountId, type: resolved.type };
    }

    // Decision: Installation visibility check, two paths in order:
    // 1. User authorization on install (preferred, personal and org). With the App option on, GitHub
    // adds a `code`; we exchange it for a transient user token and confirm installation_id is in
    // `GET /user/installations`. For an org this proves only that the caller may join; repo authority
    // is proven later with their token.
    // 2. Personal account-id match (fallback, personal only). The install's account has to equal the
    // GitHub id signed into the state. Org installs without a code get 403. To support them, turn on
    // user authorization on install and set GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET.
    // A valid state alone doesn't grant repo authority.
    // The proof time is taken before authorizeInstallViaUserToken (the user-access proof; the calls
    // above only prove the install exists), on the DB clock, as a lower bound for the tombstone gates.
    // Accepted residual: a removed member who re-authorizes within GitHub's propagation lag gets
    // iat > revoked_at, which a tombstone can't tell from a real re-add. It corrects itself once GitHub
    // propagates. The lock and tombstone gates close only the concurrent case. Don't add a tombstone
    // check to the owner CONNECT path (it breaks re-added owners), and don't try to close the lag case
    // with iat.
    const proofIatMs = await getDbNowMs(context.get('db'));
    const authResult =
      typeof code === 'string' && code !== ''
        ? await authorizeInstallViaUserToken(context.env, code, installationId)
        : { authorized: false, callerAccountId: null };

    if (authResult.authorized) {
      // Decision: The person who completed the OAuth code has to be the user who started the install. This still
      // allows org installs: the state holds the initiator's account id, not the org's, and the user
      // token already proved they can reach the org install.
      if (
        authResult.callerAccountId === null ||
        authResult.callerAccountId !== stateGitHubAccountId
      ) {
        return context.json({ error: 'installation does not belong to the caller' }, 403);
      }
    } else if (account.id !== stateGitHubAccountId) {
      return context.json({ error: 'installation does not belong to the caller' }, 403);
    }

    // Decision: Run the visibility and tombstone gates under an install-row lock. member_removed and the
    // connect gate lock the same row install-first, so a concurrent revocation and this callback are
    // serialized and the second to commit sees the other's effect. Locking only installs can't deadlock
    // with member_removed, teardown or the connect gate. The lag case stays a residual (see above).
    const result = await context.get('db').transaction(async (tx) => {
      // Decision: A fresh installation id locks nothing and goes on to the owner or member insert.
      await tx
        .select({ id: githubInstallations.id })
        .from(githubInstallations)
        .where(eq(githubInstallations.installation_id, installationId))
        .for('update');

      const existing = await getGitHubInstallation(tx, installationId);
      // Decision: Organization installs have no owner, and seeing an install doesn't give repo authority. Record
      // each org participant, including the installer, as a TTL membership, so the connect gate asks for
      // a fresh per-repo OAuth grant on each organization path.
      if (account.type === 'Organization') {
        if (!authResult.authorized || authResult.callerAccountId === null) {
          return { kind: 'conflict' as const };
        }
        const revokedAtMs = await getInstallationRevocationAt(
          tx,
          installationId,
          authResult.callerAccountId,
        );
        if (revokedAtMs !== null && revokedAtMs >= proofIatMs) {
          return { kind: 'revoked' as const };
        }
        await upsertGitHubInstallation(tx, {
          installationId,
          userId: null,
          accountLogin: account.login,
          accountId: account.id,
          accountType: account.type,
          repositories,
          repositorySelection,
          refreshMembership: true,
        });
        await upsertGitHubInstallationMember(tx, {
          installationId,
          userId,
          githubAccountId: authResult.callerAccountId,
          ttlSeconds: MEMBERSHIP_TTL_SECONDS,
        });
        return { kind: 'member' as const };
      }

      // Decision: Personal installs aren't shareable. A different linked user is an account collision; the
      // matching personal GitHub identity may adopt a fresh or null row or refresh its own row.
      if (existing && existing.user_id !== null && existing.user_id !== userId) {
        return { kind: 'conflict' as const };
      }

      // Decision: Personal owner (re-)adopt: key the concurrency tombstone check on the owner's proven GitHub id.
      // Organization installs returned above, so this branch can't turn org visibility into ownership.
      const ownerRevokedAtMs = await getInstallationRevocationAt(
        tx,
        installationId,
        stateGitHubAccountId,
      );
      if (ownerRevokedAtMs !== null && ownerRevokedAtMs >= proofIatMs) {
        return { kind: 'revoked' as const };
      }
      await upsertGitHubInstallation(tx, {
        installationId,
        userId,
        accountLogin: account.login,
        accountId: account.id,
        accountType: account.type,
        repositories,
        // Decision: Store GitHub's `repository_selection` so an `all`-repos install is recognized without waiting
        // for a webhook. The `installation` webhook handler keeps it in sync after that.
        repositorySelection,
        // Decision: We just refetched the live repo list, so on reconnect or `setup_action=update` it has to roll
        // the cache forward. Without this, newly added repos or a widen-to-`all` stay rejected by the
        // connect, push and OIDC resolvers until the next webhook.
        refreshMembership: true,
      });
      return { kind: 'owner' as const };
    });

    if (result.kind === 'conflict') {
      return context.json({ error: 'installation already linked to another user' }, 403);
    }
    if (result.kind === 'revoked') {
      return context.json({ error: 'installation access revoked' }, 403);
    }
    // Decision: Personal owners and org members share this target. Prod DASHBOARD_URL is https, so the wrangler
    // localhost-redirect mangling (see lessons.md) doesn't apply and a 302 is fine.
    const dashboardUrl = context.env.DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL;
    return context.redirect(`${dashboardUrl}/settings/connections`);
  });

// Decision: The OIDC exchange (routes/auth-oidc.ts) binds a deploy token to the workflow at
// `workflow_path`. GitHub only runs workflows under `.github/workflows/`, so a path outside it (or
// with `..`) can't match a real `workflow_ref`. Reject it here with a clear error instead of a
// deploy that's never authorized.
function isValidWorkflowPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.startsWith('.github/workflows/') &&
    (path.endsWith('.yml') || path.endsWith('.yaml')) &&
    !path.includes('..')
  );
}

// Decision: /projects connection routes are mounted under the global `app.use('/projects/*',
// authMiddleware)`, so auth is already applied; each route checks its project capability.
export const githubProjectRoutes = new Hono<ApiEnv>()
  // Decision: Other routers share /projects, so this gate covers only the GitHub connection routes.
  .use('/:id/github', capabilityMiddleware('managedBuilds'))

  .post('/:id/github', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }

    const body = await context.req.json<{
      installationId?: unknown;
      repoFullName?: unknown;
      branch?: unknown;
      buildExecutor?: unknown;
      workflowPath?: unknown;
      connectGrant?: unknown;
      codeVerifier?: unknown;
    }>();

    if (typeof body.installationId !== 'string' || body.installationId === '') {
      return context.json({ error: 'installationId is required' }, 400);
    }
    if (typeof body.repoFullName !== 'string' || body.repoFullName === '') {
      return context.json({ error: 'repoFullName is required' }, 400);
    }
    if (
      body.buildExecutor !== undefined &&
      body.buildExecutor !== 'container' &&
      body.buildExecutor !== 'github_actions'
    ) {
      return context.json({ error: 'invalid buildExecutor' }, 400);
    }
    if (body.branch !== undefined && (typeof body.branch !== 'string' || body.branch === '')) {
      return context.json({ error: 'invalid branch' }, 400);
    }
    if (
      body.workflowPath !== undefined &&
      (typeof body.workflowPath !== 'string' || !isValidWorkflowPath(body.workflowPath))
    ) {
      return context.json({ error: 'invalid workflowPath' }, 400);
    }

    const installation = await getGitHubInstallation(context.get('db'), body.installationId);
    if (!installation) {
      return context.json({ error: 'installation not found' }, 404);
    }
    const caller = context.get('user').id;
    const isOwner = installation.account_type === 'User' && installation.user_id === caller;

    // Decision: A personal-account owner passes straight through. An organization participant has to be an
    // active member of the shared install; if not, return the same opaque 404 as an owner miss, so a
    // non-member can't learn the install exists. Membership honors its TTL.
    if (!isOwner) {
      // Decision: These 404 gates run before the OAuth kill-switch 503 below, so a non-member can't tell an
      // existing install from a missing one even when App user OAuth isn't configured.
      const isMember = await hasActiveInstallationMembership(
        context.get('db'),
        body.installationId,
        caller,
      );
      if (!isMember) {
        return context.json({ error: 'installation not found' }, 404);
      }
      // Decision: Org-share connect is Organization-only. Memberships are only written for org installs; this
      // keeps a personal install unreachable through membership, with the same opaque 404. GitHub doesn't
      // turn an organization back into a personal account, so the pre-lock row is enough.
      if (installation.account_type !== 'Organization') {
        return context.json({ error: 'installation not found' }, 404);
      }
      // Decision: The org connect path depends on App user OAuth (the membership and connect_grant came from it),
      // so reject a grant redemption when the config was removed. This runs last: only a proven active
      // member of an org install gets here, so the 503 doesn't reveal whether an install exists.
      // Personal owners skip it.
      if (!isAppUserOAuthConfigured(context.env)) {
        return context.json(
          {
            error: 'github_oauth_not_configured',
            message: 'GitHub App user OAuth is not configured',
          },
          503,
        );
      }
    }

    // Decision: A suspended or deleted install can still carry cached repos, but each build resolver needs
    // status='active', so connecting it would make a connection that never builds.
    if (installation.status !== 'active') {
      return context.json({ error: 'installation is not active' }, 409);
    }

    // Decision: Resolve the repo's immutable numeric id: `repo_full_name` can change (rename, delete, name
    // reuse), so webhook and OIDC routing key on the id. It differs by path:
    // - Personal owner: use the installation token. For `all` installs the cached `repositories` list
    // doesn't name every repo, so resolve live with `GET /repos/:full_name` (non-ok fails closed with
    // 400). For `selected`, the cached set is authoritative.
    // - Organization participant: install visibility isn't repo authority, and trusting the install
    // token would be a confused deputy. Require a connect_grant from
    // /github/connect-authorize-callback, whose repositoryId the member proved with their own token,
    // and skip the install-token lookup.
    // memberGrantIat is the grant's proof time, compared with the revocation tombstone under the row
    // lock below. It's undefined on the owner path.
    let memberGrantIat: number | undefined;
    // Decision: The grant's GitHub account id is the tombstone key. Keying on this durable identity instead of
    // the Platform user id catches a pre-removal grant replay even after the member re-links. It's
    // undefined on the owner path, which skips the tombstone check.
    let memberGrantAccountId: string | undefined;
    let repositoryId: number;
    if (isOwner) {
      if (installation.repository_selection === 'all') {
        const resolvedId = await resolveRepositoryId(
          context.env,
          body.installationId,
          body.repoFullName,
        );
        if (resolvedId === null) {
          return context.json({ error: 'repository not accessible by installation' }, 400);
        }
        repositoryId = resolvedId;
      } else {
        const matchedRepo = installation.repositories.find(
          (repo) => repo.full_name === body.repoFullName,
        );
        if (!matchedRepo) {
          return context.json({ error: 'repository not accessible by installation' }, 400);
        }
        repositoryId = matchedRepo.id;
      }
    } else {
      // Decision: A member with no grant gets the stable `connect_authorization_required` code that the CLI
      // catches to run the authorize round trip. Don't change it. Other failures are a hard
      // 'invalid connect grant' that the CLI doesn't retry.
      if (typeof body.connectGrant !== 'string' || typeof body.codeVerifier !== 'string') {
        return context.json({ error: 'connect_authorization_required' }, 403);
      }
      const grant = await verifyLinkPayload<ConnectGrant>(
        body.connectGrant,
        context.env.JWT_SECRET,
      );
      if (
        !grant ||
        grant.purpose !== 'connect' ||
        typeof grant.exp !== 'number' ||
        Date.now() >= grant.exp ||
        typeof grant.iat !== 'number' ||
        grant.installationId !== body.installationId ||
        grant.repoFullName !== body.repoFullName
      ) {
        return context.json({ error: 'invalid connect grant' }, 403);
      }
      if (
        grant.codeChallengeMethod !== CLI_CODE_CHALLENGE_METHOD ||
        !isValidCodeVerifier(body.codeVerifier) ||
        (await calculatePKCECodeChallenge(body.codeVerifier)) !== grant.codeChallenge
      ) {
        return context.json({ error: 'invalid connect grant' }, 403);
      }
      // Decision: Threat L1: the GitHub identity that proved per-repo access has to equal the redeeming bearer's
      // own linked GitHub id. This closes "A starts, B authorizes in the browser, A redeems B's proof".
      const callerGithubId = await getGitHubAccountIdForUser(context.get('db'), caller);
      if (callerGithubId === null || callerGithubId !== grant.githubAccountId) {
        return context.json({ error: 'invalid connect grant' }, 403);
      }
      // Decision: Trust the id the member proved with their own token and skip the install-token lookup. That's
      // the confused-deputy close, so don't add an install-token check here.
      repositoryId = grant.repositoryId;
      memberGrantIat = grant.iat;
      memberGrantAccountId = grant.githubAccountId;
    }

    // Decision: Copy the validated fields into consts: TS narrowing on `body.<field>` isn't kept inside the
    // transaction closure, so `body.*` there widens back to `unknown`.
    const installationId = body.installationId;
    const repoFullName = body.repoFullName;
    const branch = body.branch;
    const buildExecutor = body.buildExecutor;
    const workflowPath = body.workflowPath;

    // Decision: Go live under the install-row lock. member_removed and the teardown handlers
    // (installation.deleted/suspend, installation_repositories removed) lock the same row install-first,
    // so this connect and a concurrent revocation or teardown are serialized and the second to commit
    // sees the other's effect. The locked SELECT re-reads status, repository_selection and repositories,
    // and the checks below re-apply the status gate and the owner coverage gate on the locked row. This
    // relies on READ COMMITTED (the pg and Hyperdrive default): after the lock wait, a new statement
    // snapshot sees the other transaction's change.
    const result = await context.get('db').transaction(async (tx) => {
      const [lockedInstall] = await tx
        .select({
          user_id: githubInstallations.user_id,
          account_type: githubInstallations.account_type,
          status: githubInstallations.status,
          repository_selection: githubInstallations.repository_selection,
          repositories: githubInstallations.repositories,
        })
        .from(githubInstallations)
        .where(eq(githubInstallations.installation_id, installationId))
        .for('update')
        .limit(1);
      if (!lockedInstall) {
        return { ok: false as const, status: 404 as const, error: 'installation not found' };
      }
      // Decision: Serialize project-role changes with connection creation. Lock order: install row first (the
      // GitHub lifecycle order), then project, then connection rows. A demoted or removed admin can't pass
      // the preflight settings check and then create a connection after losing access.
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for('update')
        .limit(1);
      const lockedAccess = await requireProjectRouteCapability(context, projectId, 'settings', tx);
      if (lockedAccess instanceof Response) {
        return lockedAccess;
      }
      if (lockedAccess.project.status === 'deleting') {
        return context.json({ error: 'project is being deleted' }, 409);
      }
      // Decision: Re-derive ownership from the locked row. If the owner changed while we waited, the owner path
      // is stale: repositoryId came from the install token and there's no grant, so falling through to the
      // member insert would be a confused deputy. Reject; a new request asks for a connect_grant.
      const lockedIsOwner =
        lockedInstall.account_type === 'User' && lockedInstall.user_id === caller;
      if (isOwner && !lockedIsOwner) {
        return { ok: false as const, status: 404 as const, error: 'installation not found' };
      }
      // Decision: Re-check the non-owner gates after taking the lock, so a revocation committed since the
      // pre-check wins. Owners skip this (they aren't revoked through membership) but still take the lock.
      if (!lockedIsOwner) {
        if (!(await hasActiveInstallationMembership(tx, installationId, caller))) {
          return { ok: false as const, status: 404 as const, error: 'installation not found' };
        }
        if (memberGrantAccountId === undefined || memberGrantIat === undefined) {
          return { ok: false as const, status: 403 as const, error: 'invalid connect grant' };
        }
        const revokedAtMs = await getInstallationRevocationAt(
          tx,
          installationId,
          memberGrantAccountId,
        );
        if (revokedAtMs !== null && revokedAtMs >= memberGrantIat) {
          return { ok: false as const, status: 403 as const, error: 'invalid connect grant' };
        }
      }
      // Decision: A concurrent installation.deleted/suspend that got the lock first marks the row inactive. Reject
      // instead of creating an orphan connection the teardown already passed. This applies to both paths:
      // status has no cache lag.
      if (lockedInstall.status !== 'active') {
        return { ok: false as const, status: 409 as const, error: 'installation is not active' };
      }
      // Decision: Owner path only: the owner resolved repositoryId from the cached `repositories`, so re-check the
      // cache under the lock to catch a concurrent installation_repositories removal. `all` installs store
      // an empty cache and aren't checked. The member path isn't cache-checked on purpose: it trusts the
      // live-proven grant.repositoryId, and the cache can lag a new repo, which would reject a valid grant.
      if (
        lockedIsOwner &&
        lockedInstall.repository_selection === 'selected' &&
        !lockedInstall.repositories.some((repo) => repo.full_name === repoFullName)
      ) {
        return {
          ok: false as const,
          status: 400 as const,
          error: 'repository not accessible by installation',
        };
      }
      const existing = await getGitHubConnection(tx, projectId);
      if (existing) {
        return { ok: false as const, status: 409 as const, error: 'project already connected' };
      }
      const connection = await createGitHubConnection(tx, {
        projectId,
        installationId,
        repoFullName,
        repositoryId: String(repositoryId),
        authorizedByUserId: caller,
        branch,
        buildExecutor,
        workflowPath,
      });
      return { ok: true as const, connection };
    });
    if (result instanceof Response) {
      return result;
    }
    if (!result.ok) {
      return context.json({ error: result.error }, result.status);
    }
    return context.json(publicGitHubConnection(result.connection));
  })

  .get('/:id/github', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }

    const connection = await getGitHubConnection(context.get('db'), projectId);
    if (!connection) {
      return context.json({ error: 'connection not found' }, 404);
    }

    return context.json(publicGitHubConnection(connection));
  })

  .patch('/:id/github', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }

    const connection = await getGitHubConnection(context.get('db'), projectId);
    if (!connection) {
      return context.json({ error: 'connection not found' }, 404);
    }

    const body = await context.req.json<{
      branch?: unknown;
      buildExecutor?: unknown;
      workflowPath?: unknown;
    }>();
    if (body.branch !== undefined && (typeof body.branch !== 'string' || body.branch === '')) {
      return context.json({ error: 'invalid branch' }, 400);
    }
    if (
      body.buildExecutor !== undefined &&
      body.buildExecutor !== 'container' &&
      body.buildExecutor !== 'github_actions'
    ) {
      return context.json({ error: 'invalid buildExecutor' }, 400);
    }
    if (
      body.workflowPath !== undefined &&
      (typeof body.workflowPath !== 'string' || !isValidWorkflowPath(body.workflowPath))
    ) {
      return context.json({ error: 'invalid workflowPath' }, 400);
    }
    const newBranch: string | undefined = body.branch;
    const newExecutor = body.buildExecutor;
    const newWorkflowPath: string | undefined = body.workflowPath;

    // Decision: A branch or executor change orphans in-flight builds for the old config, so revoke their deploy
    // tokens: a build started for the old branch or executor mustn't keep publishing. Terminalize them
    // under the same connection-row lock as the update, so an in-flight OIDC exchange (which locks the
    // row) is serialized. Only a real change does this; a no-op PATCH terminalizes nothing.
    const result = await context.get('db').transaction(async (tx) => {
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for('update')
        .limit(1);
      const lockedAccess = await requireProjectRouteCapability(context, projectId, 'settings', tx);
      if (lockedAccess instanceof Response) {
        return lockedAccess;
      }
      if (lockedAccess.project.status === 'deleting') {
        return context.json({ error: 'project is being deleted' }, 409);
      }
      await tx
        .select({ id: githubConnections.id })
        .from(githubConnections)
        .where(eq(githubConnections.project_id, projectId))
        .for('update');

      // Decision: Re-read the connection under the lock: the pre-transaction snapshot can be stale after a
      // concurrent PATCH or reconnect. Change detection and the terminated branch/executor both come from
      // the locked row.
      const current = await getGitHubConnection(tx, projectId);
      if (!current) {
        return { cancelled: [], updated: null, gone: true };
      }

      const terminated: Array<TerminatedBuild> = [];
      if (newBranch !== undefined && newBranch !== current.branch) {
        terminated.push(
          ...(await terminateBuildsForProject(tx, projectId, {
            branch: current.branch,
            reason: 'branch changed',
          })),
        );
      }
      if (newExecutor !== undefined && newExecutor !== current.build_executor) {
        terminated.push(
          ...(await terminateBuildsForProject(tx, projectId, {
            executor: current.build_executor,
            reason: 'executor changed',
          })),
        );
      }
      // Decision: A workflow_path change moves the trust boundary: the OIDC gate only mints tokens for the pinned
      // workflow, so revoke in-flight github_actions builds authorized under the old pin (their tokens stay
      // valid while active). Builds don't record their workflow, so terminalize all in-flight
      // github_actions builds. Container builds don't use the workflow gate. The locked re-read in
      // createGithubActionsBuildWithinLimit closes the concurrent race.
      if (newWorkflowPath !== undefined && newWorkflowPath !== current.workflow_path) {
        terminated.push(
          ...(await terminateBuildsForProject(tx, projectId, {
            executor: 'github_actions',
            reason: 'workflow path changed',
          })),
        );
      }

      await updateGitHubConnection(tx, projectId, {
        branch: newBranch,
        buildExecutor: newExecutor,
        workflowPath: newWorkflowPath,
      });
      const next = await getGitHubConnection(tx, projectId);
      return { cancelled: terminated, updated: next, gone: false };
    });

    if (result instanceof Response) {
      return result;
    }
    const { cancelled, updated, gone } = result;

    if (gone || !updated) {
      return context.json({ error: 'connection not found' }, 404);
    }

    // Decision: Stop the container DOs after the transaction commits, not while holding the connection lock.
    await cancelContainerBuildDos(context.env, cancelled, 'project disconnected');

    return context.json(publicGitHubConnection(updated));
  })

  .delete('/:id/github', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }

    // Decision: Terminalize all in-flight builds (queued and active, both executors) before dropping the
    // connection, in one transaction under a connection-row lock. That revokes each build's deploy token,
    // so a container build with a BWF_TOKEN can't keep publishing from a disconnected repo. It also frees
    // GitHub Actions concurrency slots: their workflow_run completion webhook resolves the current
    // connection, so once it's gone the completion is ignored and the build would stay active.
    const result = await context.get('db').transaction(async (tx) => {
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for('update')
        .limit(1);
      const lockedAccess = await requireProjectRouteCapability(context, projectId, 'settings', tx);
      if (lockedAccess instanceof Response) {
        return lockedAccess;
      }
      if (lockedAccess.project.status === 'deleting') {
        return context.json({ error: 'project is being deleted' }, 409);
      }
      // Decision: Lock the connection rows so an in-flight OIDC exchange (which locks the same row FOR UPDATE
      // before inserting its build) is serialized. A build created just before this commit is caught by
      // the terminate step below.
      await tx
        .select({ id: githubConnections.id })
        .from(githubConnections)
        .where(eq(githubConnections.project_id, projectId))
        .for('update');
      const terminated = await terminateBuildsForProject(tx, projectId, {
        reason: 'project disconnected',
      });
      await deleteGitHubConnection(tx, projectId);
      return terminated;
    });

    if (result instanceof Response) {
      return result;
    }
    const cancelled = result;

    // Decision: Stop the container DOs after the transaction commits, not while holding the connection lock.
    await cancelContainerBuildDos(context.env, cancelled, 'project disconnected');

    return context.json({ ok: true });
  });
