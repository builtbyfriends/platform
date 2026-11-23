import { rpcHandler } from '@builtbyfriends/realtime-http';
import { mcpHandler } from '@builtbyfriends/realtime-mcp';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ApiEnv } from '../env.ts';
import { rememberCaller } from './procedure.ts';
import { registry } from './registry.ts';

const rpc = rpcHandler(registry, {
  basePath: '/rpc',
  openapi: { title: 'Platform', version: '1' },
});

const mcp = mcpHandler(registry, { name: 'Platform', version: '1' });

/** Hand the caller `authMiddleware` resolved to the procedures that run for this request. */
function rememberRequestCaller(context: Context<ApiEnv>): void {
  rememberCaller(context.req.raw, {
    user: context.get('user'),
    db: context.get('db'),
    companyIdentity: context.get('companyIdentity'),
    credential: {
      audience: context.get('tokenAudience') ?? 'api',
      project: context.get('deployScope'),
      build: context.get('deployBuild'),
      credentialId: context.get('deployCredential'),
      approval: context.get('oauthApproval'),
      expiresAt: context.get('deployTokenExpiresAt'),
    },
  });
}

/** Runs `handle`, finishing any background work first when there is no execution context. */
export async function withBackgroundWork(
  context: Context<ApiEnv>,
  handle: (waitUntil: (work: Promise<unknown>) => void) => Promise<Response>,
): Promise<Response> {
  // Decision: Without an execution context (tests, local scripts), background work finishes before the reply.
  const inline: Array<Promise<unknown>> = [];
  const response = await handle((work) => {
    try {
      context.executionCtx.waitUntil(work);
    } catch {
      inline.push(work);
    }
  });
  await Promise.allSettled(inline);
  return response;
}

/** Mount behind `authMiddleware`: the procedures read the caller it resolved. */
export const rpcRoutes = new Hono<ApiEnv>().all('/*', (context) => {
  rememberRequestCaller(context);
  return withBackgroundWork(context, (waitUntil) =>
    rpc(context.req.raw, context.env, { waitUntil }),
  );
});

/** Every procedure that chose `.mcp()`, as MCP tools. Mount behind `authMiddleware` like `/rpc`. */
export const mcpRoutes = new Hono<ApiEnv>().all('/*', (context) => {
  rememberRequestCaller(context);
  return withBackgroundWork(context, (waitUntil) =>
    mcp(context.req.raw, context.env, { waitUntil }),
  );
});
