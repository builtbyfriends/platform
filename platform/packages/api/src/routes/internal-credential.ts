import { Hono } from 'hono';
import { getProjectCredential, getProjectGitHubInstallation } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { SCOPE_PATTERN } from '../github/app-installations.ts';
import { getInstallationToken } from '../github/installation-token.ts';
import { requireProxyInternalAuth } from '../internal-proxy-auth.ts';
import { decryptProjectSecret } from '../project-secrets.ts';

const app = new Hono<ApiEnv>();

/**
 * Internal credential read, called by the proxy over its service binding. The decrypted token
 * goes only to the proxy, which attaches it to an outbound request and never returns it.
 *
 * POST /internal/credential/:projectId   Body: { "provider": "github", "scope"?: "..." }
 * Returns: { "token": "...", "repositories": ["owner/name"] } or 404. With a `scope` the app
 * connected a GitHub App installation for, returns that installation's short-lived token and
 * `{ "installation": true }`: GitHub limits it to the installation's repositories.
 */
app.post('/:projectId', async (context) => {
  const projectId = context.req.param('projectId');
  const denied = await requireProxyInternalAuth(context, 'credential', projectId);
  if (denied) {
    return denied;
  }
  const { provider, scope } = await context.req.json<{ provider?: string; scope?: unknown }>();
  if (!provider) {
    return context.json({ error: 'provider required' }, 400);
  }
  if (scope !== undefined) {
    if (provider !== 'github' || typeof scope !== 'string' || !SCOPE_PATTERN.test(scope)) {
      return context.json(
        { error: 'scope is only for github, as 1 to 128 letters, digits or _:.-' },
        400,
      );
    }
    const installation = await getProjectGitHubInstallation(context.get('db'), projectId, scope);
    if (!installation) {
      return context.json({ error: 'no GitHub installation connected' }, 404);
    }
    const token = await getInstallationToken(context.env, installation.installation_id);
    return context.json({ token, installation: true });
  }
  const row = await getProjectCredential(context.get('db'), projectId, provider);
  if (!row) {
    return context.json({ error: `no ${provider} credential` }, 404);
  }
  const token = await decryptProjectSecret(context.env, projectId, {
    name: credentialSecretName(provider),
    ciphertext: row.ciphertext,
    iv: row.iv,
    key_version: row.key_version,
  });
  return context.json({ token, repositories: row.repositories });
});

/** The AAD name a credential is encrypted under, so it cannot be swapped with a project secret. */
export function credentialSecretName(provider: string): string {
  return `credential:${provider}`;
}

export default app;
