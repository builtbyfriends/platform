import {
  deleteOwnedGitHubInstallation,
  getOwnedGitHubInstallation,
  type Db,
  type GitHubInstallationOwner,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  APP_INSTALL_STATE_TTL_MS,
  appInstallationAuthorizeUrl,
  getInstallationDetails,
  isReturnUrl,
  listInstallationRepositoryPage,
  sameOwner,
  SCOPE_PATTERN,
  signAppInstallState,
  stateOwner,
  verifyAppInstallState,
} from './app-installations.ts';
import { getInstallationToken, GITHUB_API_BASE, GITHUB_API_VERSION } from './installation-token.ts';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
 * - `clone-token` (`repo` as owner/name): a token that can only read that one repository, for a `git clone` the
 *   owner runs in its own sandbox. GitHub expires it within the hour.
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
    if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) {
      return fail(503, 'GitHub App user authorization is not configured on this platform');
    }
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
        url: appInstallationAuthorizeUrl(env.GITHUB_APP_CLIENT_ID, state),
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

  if (op === 'clone-token') {
    const repo = body?.repo;
    if (typeof repo !== 'string' || !REPO_PATTERN.test(repo) || repo.includes('..')) {
      return fail(400, 'repo must be owner/name');
    }
    const wide = await getInstallationToken(env, row.installation_id);
    const res = await fetch(`${GITHUB_API_BASE}/repos/${repo}`, {
      headers: {
        Authorization: `Bearer ${wide}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'platform-api',
      },
      redirect: 'manual',
    });
    if (!res.ok) {
      return fail(404, 'the connected installation does not reach that repository');
    }
    const found = (await res.json()) as { id?: number; full_name?: string };
    if (typeof found.id !== 'number') {
      return fail(404, 'the connected installation does not reach that repository');
    }
    // Decision: The token leaves Platform, so it is narrowed to one repository and read-only contents. A
    // dependency script in the sandbox that reads it can't write anywhere or reach the installation's other repositories.
    const token = await getInstallationToken(env, row.installation_id, {
      repositoryIds: [String(found.id)],
      permissions: { contents: 'read' },
    });
    return { status: 200, body: { token, repo: found.full_name ?? repo } };
  }

  return fail(400, 'unknown op');
}
