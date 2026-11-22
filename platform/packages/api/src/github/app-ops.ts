import {
  deleteOwnedGitHubInstallation,
  getOwnedGitHubInstallation,
  type Db,
  type GitHubInstallationOwner,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  APP_INSTALL_STATE_TTL_MS,
  getInstallationDetails,
  isReturnUrl,
  listInstallationRepositoryPage,
  sameOwner,
  SCOPE_PATTERN,
  signAppInstallState,
  stateOwner,
  verifyAppInstallState,
} from './app-installations.ts';
import { getInstallationToken } from './installation-token.ts';

type OpResult = Readonly<{ status: 200 | 400 | 404 | 410 | 503; body: Record<string, unknown> }>;
const fail = (status: OpResult['status'], error: string): OpResult => ({ status, body: { error } });

/**
 * One GitHub App operation for an owner's scope. The owner is a project Platform hosts (called
 * through the proxy) or a connected application (called with its client credentials).
 *
 * - `install-url` (`returnUrl`): a link that installs the App and comes back to `returnUrl`.
 * - `describe` (`state` optional): the connected installation, and whether it was made under `state`.
 * - `repositories` (`page`): one page of the repositories the installation reaches.
 * - `disconnect`: forgets the installation for this scope.
 */
export async function githubAppOp(
  env: ApiEnv['Bindings'],
  db: Db,
  owner: GitHubInstallationOwner,
  body: Record<string, unknown> | null,
): Promise<OpResult> {
  const op = body?.op;
  const scope = body?.scope;
  if (typeof scope !== 'string' || !SCOPE_PATTERN.test(scope)) {
    return fail(400, 'scope must be 1 to 128 letters, digits or _:.-');
  }
  if (op === 'disconnect') {
    await deleteOwnedGitHubInstallation(db, owner, scope);
    return { status: 200, body: { removed: true } };
  }
  const slug = env.GITHUB_APP_SLUG;
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !slug) {
    return fail(503, 'GitHub App is not configured on this platform');
  }

  if (op === 'install-url') {
    const returnUrl = body?.returnUrl;
    if (typeof returnUrl !== 'string' || !isReturnUrl(returnUrl)) {
      return fail(400, 'returnUrl must be an https URL');
    }
    const state = await signAppInstallState(
      {
        purpose: 'github-app',
        ...owner,
        scope,
        returnUrl,
        nonce: crypto.randomUUID(),
        exp: Date.now() + APP_INSTALL_STATE_TTL_MS,
      },
      env.JWT_SECRET,
    );
    return {
      status: 200,
      body: {
        url: `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`,
        state,
      },
    };
  }

  const row = await getOwnedGitHubInstallation(db, owner, scope);
  if (!row) {
    return fail(404, 'no GitHub installation connected');
  }

  if (op === 'describe') {
    const details = await getInstallationDetails(env, row.installation_id);
    if (!details) {
      return fail(410, 'GitHub no longer knows that installation');
    }
    let matched: boolean | undefined;
    if (typeof body?.state === 'string') {
      const state = await verifyAppInstallState(body.state, env.JWT_SECRET, 0);
      matched =
        state !== null &&
        sameOwner(stateOwner(state), owner) &&
        state.scope === scope &&
        state.nonce === row.state_nonce;
    }
    return { status: 200, body: { ...details, ...(matched !== undefined && { matched }) } };
  }

  if (op === 'repositories') {
    const page = typeof body?.page === 'number' && Number.isSafeInteger(body.page) ? body.page : 1;
    if (page < 1 || page > 1000) {
      return fail(400, 'page out of range');
    }
    const token = await getInstallationToken(env, row.installation_id);
    return {
      status: 200,
      body: { repositories: await listInstallationRepositoryPage(token, page) },
    };
  }

  return fail(400, 'unknown op');
}
