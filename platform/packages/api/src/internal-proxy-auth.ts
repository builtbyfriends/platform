import type { Context } from 'hono';
import type { ApiEnv } from './env.ts';
import { isProjectId } from './id.ts';
import { PROXY_INTERNAL_AUTH_HEADER, verifyProxyInternalAuth } from './proxy-token.ts';
import type { ProxyInternalRoute } from './proxy-token.ts';

/**
 * Authenticates the proxy on an internal metadata route. The proxy signs
 * `x-platform-proxy-internal` with its own key, bound to the route and project.
 * Tenant project tokens are not accepted here.
 *
 * Returns null when the call may proceed, else the error response.
 */
export async function requireProxyInternalAuth(
  context: Context<ApiEnv>,
  route: ProxyInternalRoute,
  projectId: string,
): Promise<Response | null> {
  const proxyAuth = context.req.header(PROXY_INTERNAL_AUTH_HEADER);
  if (!proxyAuth) {
    return context.json({ error: 'missing internal auth' }, 401);
  }
  if (
    !isProjectId(projectId) ||
    !(await verifyProxyInternalAuth(context.env.JWT_SECRET, route, projectId, proxyAuth))
  ) {
    return context.json({ error: 'invalid internal auth' }, 403);
  }
  return null;
}
