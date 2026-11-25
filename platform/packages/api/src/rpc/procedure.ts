import { createProcedures } from '@builtbyfriends/realtime';
import type { AuthProvider } from '@builtbyfriends/realtime';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import type { User } from '../types.ts';

/**
 * What the bearer token allows beyond its user. A full `api` token has no scope; the others
 * name the one project they were minted for, and `canOnProject` refuses any other.
 */
type Credential = Readonly<{
  audience: NonNullable<ApiEnv['Variables']['tokenAudience']>;
  /** The only project this credential may touch. */
  project?: string;
  /** The remote build a deploy token is bound to. */
  build?: string;
  /** The CI credential a deploy token came from. */
  credentialId?: string;
  /** The publish approval an OAuth deploy token came from. */
  approval?: string;
  /** Token expiry, epoch seconds. */
  expiresAt?: number;
}>;

/** Who is calling, with the connection their request already opened. */
export type Caller = {
  user: User;
  db: Db;
  credential: Credential;
  /** The Access identity the platform's gate validated, when it has one. */
  companyIdentity?: { issuer: string; subject: string };
};

const callers = new WeakMap<Request, Caller>();

/** Called by the `/rpc` route once the platform's auth middleware has resolved the caller. */
export function rememberCaller(request: Request, caller: Caller): void {
  callers.set(request, caller);
}

const builders = createProcedures<ApiEnv['Bindings']>();
export const procedure: typeof builders.procedure = builders.procedure;
const profile: typeof builders.profile = builders.profile;

/** The user `authMiddleware` authenticated: session, API token, deploy token or Access. */
const signedIn: AuthProvider<Caller, ApiEnv['Bindings']> = {
  name: 'platform-auth',
  resolve: (request) => callers.get(request),
  actorId: (caller) => caller.user.id,
};

/**
 * Every platform procedure: signed in through `authMiddleware`. Analytics and agent tools
 * are not wired yet, so those two concerns are decided here once instead of per procedure.
 */
export const member = profile('member')
  .auth(signedIn)
  .noAnalytics({ reason: 'Request analytics already record every platform API call' })
  .noAiTool({ reason: 'Agents reach the platform through MCP, not the AI tool surface' });
