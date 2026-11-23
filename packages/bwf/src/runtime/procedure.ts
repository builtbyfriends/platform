import { anyOf, bearerAuth, createProcedures } from '@builtbyfriends/realtime';
import type { AuthProvider } from '@builtbyfriends/realtime';
import { getUser } from './auth.ts';
import type { AuthUser } from './auth.ts';
import type { CloudBindings } from './handler.ts';

/**
 * Builders for files in `procedures/`. `env` in handlers and providers is typed from
 * bwf's generated bindings. Leave the name out: bwf names each procedure from its
 * file and export (`procedures/contacts.ts` exporting `get` is `contacts.get`).
 */
const builders: ReturnType<typeof createProcedures<CloudBindings>> =
  createProcedures<CloudBindings>();
// Decision: bwf names each procedure from its file and export, so the name is optional here (core wants one).
export const procedure: (name?: string) => ReturnType<typeof builders.procedure<string>> = (name) =>
  builders.procedure(name as string);
export const profile: typeof builders.profile = builders.profile;

/**
 * The signed-in Better Auth user. bwf's auth middleware runs before procedures, so this
 * reads the session it already resolved. Null (a 401) when nobody is signed in.
 */
export const session: AuthProvider<AuthUser, CloudBindings> = {
  name: 'session',
  resolve: () => getUser(),
  actorId: (user) => user.id,
};

/** Someone signed in. Today that is a session; API keys join it once bwf has them. */
export const signedIn: AuthProvider<AuthUser, CloudBindings> = session;

const sha256 = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/**
 * API tokens for the CLI, agents and scripts: `Authorization: Bearer <token>`. `lookup`
 * gets the token's SHA-256 hex digest, never the token, and returns the caller or null.
 * Combine with `session` using `anyOf('signed-in', session, apiTokens(...))`.
 */
export function apiTokens<User extends { id: string }>(
  lookup: (
    hash: string,
    env: CloudBindings,
  ) => Promise<User | null | undefined> | User | null | undefined,
): AuthProvider<User, CloudBindings> {
  return bearerAuth<User, CloudBindings>({
    name: 'api-token',
    verify: async (token, env) => lookup(await sha256(token), env),
    actorId: (user) => user.id,
  });
}

export { anyOf, bearerAuth };
export type { AuthProvider };
