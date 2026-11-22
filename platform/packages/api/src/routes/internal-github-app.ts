import { Hono } from 'hono';
import type { ApiEnv } from '../env.ts';
import { githubAppOp } from '../github/app-ops.ts';
import { requireProxyInternalAuth } from '../internal-proxy-auth.ts';

const app = new Hono<ApiEnv>();

/**
 * The GitHub App connections of one project's own spaces, called by the proxy
 * over its service binding for the app's backend. See `githubAppOp` for the operations.
 *
 * POST /internal/github-app/:projectId   Body: { "op": ..., "scope": ... }
 */
app.post('/:projectId', async (context) => {
  const projectId = context.req.param('projectId');
  const denied = await requireProxyInternalAuth(context, 'github-app', projectId);
  if (denied) {
    return denied;
  }
  const body = await context.req.json<Record<string, unknown>>().catch(() => null);
  const result = await githubAppOp(context.env, context.get('db'), { projectId }, body);
  return context.json(result.body, result.status);
});

export default app;
