import { createProcedures } from '@builtbyfriends/realtime';
import type { AuthProvider } from '@builtbyfriends/realtime';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import type { PreviewScope } from '../routes/previews.ts';

/** An OAuth-connected application acting for the user who granted it access. */
export type AppCaller = PreviewScope & { db: Db };

const callers = new WeakMap<Request, AppCaller>();

/** Called by the `/app-rpc` route once the grant's bearer token has been verified. */
export function rememberAppCaller(request: Request, caller: AppCaller): void {
  callers.set(request, caller);
}

const builders = createProcedures<ApiEnv['Bindings']>();
export const appProcedure: typeof builders.procedure = builders.procedure;
const appProfile: typeof builders.profile = builders.profile;

/** The user and grant behind a connected application's bearer token. */
const oauthApp: AuthProvider<AppCaller, ApiEnv['Bindings']> = {
  name: 'oauth-app',
  resolve: (request) => callers.get(request),
  actorId: (caller) => caller.user.id,
};

/**
 * Every connected-application procedure. Each one checks the permission it needs (the grant's
 * scopes and the client's) itself, because a grant may hold `profile` alone.
 */
export const connectedApp = appProfile('connected-app')
  .auth(oauthApp)
  .noAnalytics({ reason: 'Request analytics already record every platform API call' })
  .noAiTool({ reason: 'Connected applications call these directly, not as agent tools' });
