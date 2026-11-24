import { browserPageLead, escapeBrowserHtml } from '@builtbyfriends/platform/browser-page';
import { Hono } from 'hono';
import { platformBrowserError, platformBrowserPage } from '../browser-page.ts';
import { upsertOwnedGitHubInstallation } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  appInstallationAuthorizeUrl,
  getInstallationDetails,
  isAppInstallSelection,
  looksLikeAppInstallState,
  signAppInstallSelection,
  stateOwner,
  verifyAppInstallSelection,
  verifyAppInstallState,
} from '../github/app-installations.ts';
import {
  authorizeInstallViaUserToken,
  listAuthorizedInstallationIds,
} from '../github/user-installations.ts';

export const githubAppRoutes = new Hono<ApiEnv>().get('/callback', async (context) => {
  context.header('Cache-Control', 'no-store');
  context.header('Referrer-Policy', 'no-referrer');
  const query = new URL(context.req.url).searchParams;
  const raw = query.get('state') ?? '';
  const selecting = isAppInstallSelection(raw);
  const selection = selecting ? await verifyAppInstallSelection(raw, context.env.JWT_SECRET) : null;
  if (selecting && !selection) {
    return platformBrowserError(
      context,
      'Start again in the app',
      'This GitHub selection has expired or is invalid. Return to the app and connect GitHub again.',
      400,
    );
  }
  const attempt = selection?.state ?? raw;
  // Decision: The App's first callback serves both application scopes and managed builds; keep their signed states separate.
  if (!looksLikeAppInstallState(attempt)) {
    return selecting
      ? platformBrowserError(
          context,
          'Start again in the app',
          'This GitHub connection attempt is invalid. Return to the app and connect GitHub again.',
          400,
        )
      : context.redirect(`/github/callback?${query}`, 302);
  }
  const state = await verifyAppInstallState(attempt, context.env.JWT_SECRET);
  if (!state) {
    return platformBrowserError(
      context,
      'Start again in the app',
      'This GitHub link has expired or is invalid. Return to the app and connect GitHub again.',
      400,
    );
  }
  const back = (extra: Record<string, string>) => {
    const url = new URL(state.returnUrl);
    url.searchParams.set('state', attempt);
    for (const [key, value] of Object.entries(extra)) {
      url.searchParams.set(key, value);
    }
    return context.redirect(url.toString(), 302);
  };
  if (query.has('error')) {
    return back({ error: 'GitHub authorization was canceled. Try connecting again.' });
  }
  const code = query.get('code') ?? '';
  if (!code) {
    return back({ error: 'GitHub did not return an authorization code. Start again in the app.' });
  }
  const installationId = selection?.installationId ?? query.get('installation_id');
  try {
    if (installationId !== null) {
      if (!/^\d{1,20}$/.test(installationId)) {
        return back({ error: 'GitHub did not say which installation' });
      }
      // Decision: Reauthorize the selected installation with a fresh user token; the signed choice alone grants no access.
      const { authorized, callerAccountId } = await authorizeInstallViaUserToken(
        context.env,
        code,
        installationId,
      );
      if (
        !authorized ||
        !callerAccountId ||
        (selection && selection.callerAccountId !== callerAccountId)
      ) {
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
    }
    const { installationIds, callerAccountId } = await listAuthorizedInstallationIds(
      context.env,
      code,
    );
    if (!callerAccountId || (selection && selection.callerAccountId !== callerAccountId)) {
      return back({ error: 'GitHub authorization could not be verified. Start again in the app.' });
    }
    if (!context.env.GITHUB_APP_CLIENT_ID || !context.env.GITHUB_APP_SLUG) {
      return back({ error: 'GitHub connection is not configured on this platform.' });
    }
    const choices: Array<string> = [];
    for (const id of installationIds) {
      const details = await getInstallationDetails(context.env, id);
      if (!details) {
        return back({ error: 'GitHub could not load your installations. Try connecting again.' });
      }
      const selected = await signAppInstallSelection(
        attempt,
        id,
        callerAccountId,
        state.exp,
        context.env.JWT_SECRET,
      );
      const href = appInstallationAuthorizeUrl(context.env.GITHUB_APP_CLIENT_ID, selected);
      choices.push(
        `<a class="platform-auth-button platform-auth-button-primary" href="${escapeBrowserHtml(href)}">Connect ${escapeBrowserHtml(details.accountLogin)}</a>`,
      );
    }
    const installState = await signAppInstallSelection(
      attempt,
      null,
      callerAccountId,
      state.exp,
      context.env.JWT_SECRET,
    );
    const install = `https://github.com/apps/${encodeURIComponent(context.env.GITHUB_APP_SLUG)}/installations/new?${new URLSearchParams({ state: installState })}`;
    return platformBrowserPage(
      context,
      'Connect GitHub',
      browserPageLead(
        'Choose a GitHub account',
        choices.length
          ? 'Choose the account to connect to your app. These installations are available to your GitHub account.'
          : 'Install the GitHub App on the account you want to connect.',
      ) +
        `<div class="platform-auth-form">${choices.join('')}<a class="platform-auth-button" href="${escapeBrowserHtml(install)}">${choices.length ? 'Install on another account' : 'Install on GitHub'}</a></div>`,
    );
  } catch {
    return back({ error: 'GitHub could not complete the connection. Try again in the app.' });
  }
});
