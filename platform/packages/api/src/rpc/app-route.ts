import { defineRegistry } from '@builtbyfriends/realtime';
import { rpcHandler } from '@builtbyfriends/realtime-http';
import { Hono } from 'hono';
import { oauthBearer, OAuthError } from '../auth/oauth.ts';
import type { ApiEnv } from '../env.ts';
import { rememberAppCaller } from './app-procedure.ts';
import * as previews from './procedures/previews.ts';
import * as publish from './procedures/publish.ts';
import { withBackgroundWork } from './route.ts';

/** Procedures for OAuth-connected applications such as a bot platform's workspaces. */
const appRegistry = defineRegistry([
  previews.create,
  previews.deploy,
  previews.launch,
  publish.request,
]);

const rpc = rpcHandler(appRegistry, {
  basePath: '/app-rpc',
  openapi: { title: 'Platform connected applications', version: '1' },
});

/** Mounted without `authMiddleware`: the caller is whoever holds the grant's bearer token. */
export const appRpcRoutes = new Hono<ApiEnv>().all('/*', async (context) => {
  const request = context.req.raw;
  try {
    const { grant, user } = await oauthBearer(
      context.get('db'),
      context.req.header('Authorization'),
      context.get('companyIdentity'),
    );
    rememberAppCaller(request, { db: context.get('db'), env: context.env, grant, user });
  } catch (error) {
    if (error instanceof OAuthError) {
      return context.json({ error: error.code, message: error.message }, error.status);
    }
    throw error;
  }
  return withBackgroundWork(context, (waitUntil) =>
    rpc(request, context.env, {
      waitUntil: (work) =>
        waitUntil(
          work.catch((error: unknown) => {
            console.error('[app-rpc] background task failed:', error);
          }),
        ),
    }),
  );
});
