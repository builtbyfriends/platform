import { Hono } from 'hono';
import { upsertOwnedGitHubInstallation } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  getInstallationDetails,
  looksLikeAppInstallState,
  stateOwner,
  verifyAppInstallState,
} from '../github/app-installations.ts';
import { authorizeInstallViaUserToken } from '../github/user-installations.ts';

/**
 * Where GitHub sends a person after they install the App from an app's install
 * link (`/internal/github-app` `install-url`). It proves the person can reach
 * the installation, stores it for the app's scope, and sends them back to the
 * app with the same `state`.
 */
export const githubAppRoutes = new Hono<ApiEnv>().get('/callback', async (context) => {
  const query = new URL(context.req.url).searchParams;
  const raw = query.get('state') ?? '';
  // Decision: GitHub sends every install of the App to its first callback URL. A state that isn't from this
  // flow goes on to the managed-builds callback unchanged, so one App serves both.
  if (!looksLikeAppInstallState(raw)) {
    return context.redirect(`/github/callback?${query}`, 302);
  }
  const state = await verifyAppInstallState(raw, context.env.JWT_SECRET);
  if (!state) {
    return context.json({ error: 'This GitHub link has expired. Start again in the app.' }, 400);
  }
  const back = (extra: Record<string, string>) => {
    const url = new URL(state.returnUrl);
    url.searchParams.set('state', raw);
    for (const [key, value] of Object.entries(extra)) {
      url.searchParams.set(key, value);
    }
    return context.redirect(url.toString(), 302);
  };

  const installationId = query.get('installation_id') ?? '';
  const code = query.get('code') ?? '';
  if (!/^\d{1,20}$/.test(installationId)) {
    return back({ error: 'GitHub did not say which installation' });
  }
  if (!code) {
    return back({
      error: 'Turn on "Request user authorization (OAuth) during installation" for the GitHub App',
    });
  }
  // Decision: The person who installed has to be able to see the installation under their own GitHub
  // token, so nobody can claim an installation id they can't reach.
  const { authorized } = await authorizeInstallViaUserToken(context.env, code, installationId);
  if (!authorized) {
    return back({ error: 'You cannot access that GitHub installation' });
  }
  const details = await getInstallationDetails(context.env, installationId);
  if (!details) {
    return back({ error: 'GitHub did not describe that installation' });
  }
  await upsertOwnedGitHubInstallation(context.get('db'), stateOwner(state), state.scope, {
    installation_id: installationId,
    account_login: details.accountLogin,
    account_id: details.accountId,
    state_nonce: state.nonce,
  });
  return back({ bound: '1' });
});
