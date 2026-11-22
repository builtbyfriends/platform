import {
  deriveProxyInternalAuth,
  PROXY_INTERNAL_AUTH_HEADER,
} from '@platform-service/api/proxy-token';
import { Hono } from 'hono';
import { asRecord, asString } from './body.ts';
import type { ProxyEnv } from './types.ts';

const GITHUB_API = 'https://api.github.com';
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * Calls the GitHub REST API with the project's stored token. The token stays in the proxy:
 * the caller (a sandbox or generated code) sends only a method, a path and a body, and the
 * path must name a repository the credential was stored for. With a `scope` the app connected
 * a GitHub App installation for, it uses that installation's token instead, which GitHub
 * limits to the installation's repositories.
 */
const github = new Hono<ProxyEnv>();

/** `/repos/owner/name/...` → `owner/name`, or null for any other path. */
function repositoryOf(path: string): string | null {
  const match = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/|$)/.exec(path);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

github.post('/request', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const method = (asString(body.method) ?? 'GET').toUpperCase();
  const path = asString(body.path);
  if (!METHODS.has(method)) {
    return context.json({ error: 'unsupported method' }, 400);
  }
  if (
    !path ||
    !path.startsWith('/repos/') ||
    path.includes('..') ||
    path.includes('\\') ||
    path.includes('//') ||
    /[\s#]/.test(path)
  ) {
    return context.json({ error: 'path must be a /repos/owner/name/... GitHub API path' }, 400);
  }
  const repository = repositoryOf(path.split('?', 1)[0]!);
  if (!repository) {
    return context.json({ error: 'path must name a repository' }, 400);
  }
  const scope = body.scope === undefined ? undefined : asString(body.scope);
  if (body.scope !== undefined && !scope) {
    return context.json({ error: 'scope must be a string' }, 400);
  }

  const res = await context.env.API.fetch(`https://api/internal/credential/${projectId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PROXY_INTERNAL_AUTH_HEADER]: await deriveProxyInternalAuth(
        context.env.JWT_SECRET,
        'credential',
        projectId,
      ),
    },
    body: JSON.stringify({ provider: 'github', ...(scope && { scope }) }),
  });
  if (res.status === 404) {
    return context.json(
      {
        error: scope
          ? 'no GitHub installation connected for this scope'
          : 'no GitHub credential stored for this project',
      },
      404,
    );
  }
  if (res.status === 400) {
    return context.json(await res.json(), 400);
  }
  if (!res.ok) {
    return context.json({ error: 'credential unavailable' }, 502);
  }
  const credential = await res.json<
    { token: string; installation: true } | { token: string; repositories: Array<string> }
  >();
  if (
    !('installation' in credential) &&
    !credential.repositories.some((name) => name.toLowerCase() === repository)
  ) {
    return context.json({ error: `credential does not cover ${repository}` }, 403);
  }

  const payload = body.body === undefined ? undefined : JSON.stringify(asRecord(body.body));
  const upstream = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${credential.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'platform-proxy',
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload && method !== 'GET' ? { body: payload } : {}),
    redirect: 'manual',
  });
  const text = (await upstream.text()).slice(0, MAX_RESPONSE_BYTES);
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
});

const APP_OPS = new Set(['install-url', 'describe', 'repositories', 'disconnect', 'clone-token']);

/**
 * Manages the GitHub App installations the app connects for its own spaces. The app sends
 * `op` and `scope` (its id for the space, such as a server) and the API does the rest. The
 * App key stays in Platform, and the only token that leaves it is `clone-token`'s, which reads one repository.
 */
github.post('/app', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const op = asString(body.op);
  if (!op || !APP_OPS.has(op)) {
    return context.json(
      { error: 'op must be install-url, describe, repositories, disconnect or clone-token' },
      400,
    );
  }
  const res = await context.env.API.fetch(`https://api/internal/github-app/${projectId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PROXY_INTERNAL_AUTH_HEADER]: await deriveProxyInternalAuth(
        context.env.JWT_SECRET,
        'github-app',
        projectId,
      ),
    },
    body: JSON.stringify({
      op,
      scope: body.scope,
      ...(body.returnUrl !== undefined && { returnUrl: body.returnUrl }),
      ...(body.state !== undefined && { state: body.state }),
      ...(body.page !== undefined && { page: body.page }),
    }),
  });
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
});

export { github };
