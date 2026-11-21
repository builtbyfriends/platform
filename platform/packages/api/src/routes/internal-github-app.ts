import { Hono } from 'hono';
import { deleteProjectGitHubInstallation, getProjectGitHubInstallation } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  APP_INSTALL_STATE_TTL_MS,
  getInstallationDetails,
  isReturnUrl,
  listInstallationRepositoryPage,
  SCOPE_PATTERN,
  signAppInstallState,
  verifyAppInstallState,
} from '../github/app-installations.ts';
import { getInstallationToken } from '../github/installation-token.ts';
import { requireProxyInternalAuth } from '../internal-proxy-auth.ts';

const app = new Hono<ApiEnv>();

/**
 * The GitHub App connections of one project's own spaces, called by the proxy
 * over its service binding for the app's backend.
 *
 * POST /internal/github-app/:projectId   Body: { "op": ..., "scope": ... }
 *
 * - `install-url` (`returnUrl`): a link that installs the App and comes back to `returnUrl`.
 * - `describe` (`state` optional): the connected installation, and whether it was made under `state`.
 * - `repositories` (`page`): one page of the repositories the installation reaches.
 * - `disconnect`: forgets the installation for this scope.
 */
app.post('/:projectId', async (context) => {
  const projectId = context.req.param('projectId');
  const denied = await requireProxyInternalAuth(context, 'github-app', projectId);
  if (denied) {
    return denied;
  }
  const body = await context.req.json<Record<string, unknown>>().catch(() => null);
  const op = body?.op;
  const scope = body?.scope;
  if (typeof scope !== 'string' || !SCOPE_PATTERN.test(scope)) {
    return context.json({ error: 'scope must be 1 to 128 letters, digits or _:.-' }, 400);
  }
  const db = context.get('db');
  if (op === 'disconnect') {
    await deleteProjectGitHubInstallation(db, projectId, scope);
    return context.json({ removed: true });
  }
  const slug = context.env.GITHUB_APP_SLUG;
  if (!context.env.GITHUB_APP_ID || !context.env.GITHUB_APP_PRIVATE_KEY || !slug) {
    return context.json({ error: 'GitHub App is not configured on this platform' }, 503);
  }

  if (op === 'install-url') {
    const returnUrl = body?.returnUrl;
    if (typeof returnUrl !== 'string' || !isReturnUrl(returnUrl)) {
      return context.json({ error: 'returnUrl must be an https URL' }, 400);
    }
    const state = await signAppInstallState(
      {
        purpose: 'github-app',
        projectId,
        scope,
        returnUrl,
        nonce: crypto.randomUUID(),
        exp: Date.now() + APP_INSTALL_STATE_TTL_MS,
      },
      context.env.JWT_SECRET,
    );
    return context.json({
      url: `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`,
      state,
    });
  }

  const row = await getProjectGitHubInstallation(db, projectId, scope);
  if (!row) {
    return context.json({ error: 'no GitHub installation connected' }, 404);
  }

  if (op === 'describe') {
    const details = await getInstallationDetails(context.env, row.installation_id);
    if (!details) {
      return context.json({ error: 'GitHub no longer knows that installation' }, 410);
    }
    let matched: boolean | undefined;
    if (typeof body?.state === 'string') {
      const state = await verifyAppInstallState(body.state, context.env.JWT_SECRET, 0);
      matched =
        state !== null &&
        state.projectId === projectId &&
        state.scope === scope &&
        state.nonce === row.state_nonce;
    }
    return context.json({ ...details, ...(matched !== undefined && { matched }) });
  }

  if (op === 'repositories') {
    const page = typeof body?.page === 'number' && Number.isSafeInteger(body.page) ? body.page : 1;
    if (page < 1 || page > 1000) {
      return context.json({ error: 'page out of range' }, 400);
    }
    const token = await getInstallationToken(context.env, row.installation_id);
    return context.json({ repositories: await listInstallationRepositoryPage(token, page) });
  }

  return context.json({ error: 'unknown op' }, 400);
});

export default app;
