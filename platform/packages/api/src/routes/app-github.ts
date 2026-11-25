import { Hono } from 'hono';
import { authenticateOAuthClient, OAuthError } from '../auth/oauth.ts';
import { getOwnedGitHubInstallation } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { SCOPE_PATTERN } from '../github/app-installations.ts';
import { githubAppOp } from '../github/app-ops.ts';
import { getInstallationToken, GITHUB_API_VERSION } from '../github/installation-token.ts';
import { githubRepoApiTarget } from '../github/repo-path.ts';
import { appPersonClients } from './oauth-app-person.ts';

const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * GitHub for a connected application that Platform does not host. It has no proxy binding, so
 * it calls these with its client credentials (client_secret_basic), the same way it asks for
 * an app-person token. Only clients listed in `PLATFORM_APP_PERSON_CLIENTS` may call.
 *
 * POST /app-github/app       Body: { "op": ..., "scope": ... }   See `githubAppOp`.
 * POST /app-github/request   Body: { "scope", "method", "path", "body"? }
 *   Calls the GitHub REST API with the token of the installation connected for `scope`. GitHub
 *   limits that token to the installation's repositories. The token stays in Platform.
 */
export const appGitHubRoutes = new Hono<ApiEnv & { Variables: { clientId: string } }>()
  .onError((error, context) => {
    if (error instanceof OAuthError) {
      return context.json({ error: error.message }, error.status);
    }
    throw error;
  })
  .use('*', async (context, next) => {
    const client = await authenticateOAuthClient(
      context.get('db'),
      context.req.header('authorization'),
    );
    if (!appPersonClients(context.env).has(client.id)) {
      return context.json({ error: 'This application may not use GitHub here.' }, 403);
    }
    context.set('clientId', client.id);
    await next();
  })
  .post('/app', async (context) => {
    const body = await context.req.json<Record<string, unknown>>().catch(() => null);
    const result = await githubAppOp(
      context.env,
      context.get('db'),
      { clientId: context.get('clientId') },
      body,
    );
    return context.json(result.body, result.status);
  })
  .post('/request', async (context) => {
    const body = await context.req.json<Record<string, unknown>>().catch(() => null);
    const method = (typeof body?.method === 'string' ? body.method : 'GET').toUpperCase();
    const path = body?.path;
    const scope = body?.scope;
    if (!METHODS.has(method)) {
      return context.json({ error: 'unsupported method' }, 400);
    }
    if (typeof scope !== 'string' || !SCOPE_PATTERN.test(scope)) {
      return context.json({ error: 'scope must be 1 to 128 letters, digits or _:.-' }, 400);
    }
    const target = githubRepoApiTarget(path);
    if (!target) {
      return context.json({ error: 'path must be a /repos/owner/name/... GitHub API path' }, 400);
    }
    const installation = await getOwnedGitHubInstallation(
      context.get('db'),
      { clientId: context.get('clientId') },
      scope,
    );
    if (!installation) {
      return context.json({ error: 'no GitHub installation connected for this scope' }, 404);
    }
    const token = await getInstallationToken(context.env, installation.installation_id);
    const payload =
      body?.body !== null && typeof body?.body === 'object' && method !== 'GET'
        ? JSON.stringify(body.body)
        : undefined;
    const upstream = await fetch(target.url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'platform-api',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload ? { body: payload } : {}),
      redirect: 'manual',
    });
    const text = (await upstream.text()).slice(0, MAX_RESPONSE_BYTES);
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  });
