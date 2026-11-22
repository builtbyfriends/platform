import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { OAuthScope, OAuthSession } from '../auth/oauth-types.ts';
import { activeOAuthClient, authenticateOAuthClient, OAuthError } from '../auth/oauth.ts';
import { hashLoginProof, randomLoginProof } from '../auth/proofs.ts';
import { createUser, getProject, type Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { projectUrl } from '../project-url.ts';
import { oauthGrants, oauthRequests, users } from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';

/**
 * An extension grant (RFC 6749, section 4.5) for an application that is the front door to this
 * Platform: its people build and publish here without a Platform login of their own.
 *
 * The application authenticates as itself (client_secret_basic) and names one of its own people
 * with `person`. Platform finds or makes the user for that person and returns a short access
 * token. There's no refresh token, so the trust is checked again for each token. Only clients
 * listed in `PLATFORM_APP_PERSON_CLIENTS` can ask.
 *
 * With `publish_request`, the application also says that the person approved that publish in
 * the application. It then gets the one-build deploy credential that the browser approval gives.
 */
export const APP_PERSON_GRANT = 'urn:builtbyfriends:params:oauth:grant-type:app-person';
const APP_PERSON_SCOPES: ReadonlyArray<OAuthScope> = ['profile', 'preview:deploy'];
const TOKEN_SECONDS = 3600;
const PUBLISH_SECONDS = 900;
const until = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

type Client = Awaited<ReturnType<typeof authenticateOAuthClient>>;
type User = ApiEnv['Variables']['user'];

/** What the approval needs from routes/oauth.ts, passed in so the two files don't import each other. */
export type PublishApproval = {
  project: (context: Context<ApiEnv>, tx: Db, slug: string, user: User) => Promise<string>;
  token: (
    env: ApiEnv['Bindings'],
    request: typeof oauthRequests.$inferSelect,
    userId: string,
  ) => Promise<object>;
};

export function appPersonClients(env: ApiEnv['Bindings']): Set<string> {
  return new Set(
    (env.PLATFORM_APP_PERSON_CLIENTS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

async function appPersonUser(
  db: Db,
  clientId: string,
  person: string,
  profile: { login: string; email: string | null },
): Promise<User> {
  const provider = `app:${clientId}`;
  const find = async () =>
    (
      await db
        .select()
        .from(users)
        .where(and(eq(users.provider, provider), eq(users.provider_id, person)))
    )[0] as User | undefined;
  const found = await find();
  if (found) {
    return found;
  }
  try {
    return (await createUser(db, provider, person, profile.login, profile.email)) as User;
  } catch (error) {
    // Decision: Two first calls for one person race on the unique (provider, provider_id) index, so re-read
    // after a conflict.
    const raced = await find();
    if (raced) {
      return raced;
    }
    throw error;
  }
}

function requestedScopes(client: Client, scope: unknown): Array<OAuthScope> {
  const scopes =
    typeof scope === 'string' && scope
      ? (scope.split(' ').filter(Boolean) as Array<OAuthScope>)
      : APP_PERSON_SCOPES.filter((value) => client.scopes.includes(value));
  if (
    !scopes.includes('profile') ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((value) => !APP_PERSON_SCOPES.includes(value) || !client.scopes.includes(value))
  ) {
    throw new OAuthError('invalid_scope', 'The requested permission is not enabled.');
  }
  return scopes;
}

export async function appPersonToken(
  context: Context<ApiEnv>,
  client: Client,
  form: Record<string, unknown>,
  approval: PublishApproval,
) {
  if (!appPersonClients(context.env).has(client.id)) {
    throw new OAuthError(
      'unauthorized_client',
      'This application may not act for its people.',
      403,
    );
  }
  const person = form.person;
  if (typeof person !== 'string' || !person || person.length > 200) {
    throw new OAuthError('invalid_request', 'Name the person with `person`.');
  }
  const scopes = requestedScopes(client, form.scope);
  const publishRequest =
    typeof form.publish_request === 'string' && form.publish_request ? form.publish_request : null;
  if (publishRequest && !client.scopes.includes('deploy:approve')) {
    throw new OAuthError('invalid_scope', 'Publishing is not enabled for this application.', 403);
  }
  const db = context.get('db');
  const user = await appPersonUser(db, client.id, person, {
    login: typeof form.login === 'string' ? form.login.slice(0, 64) : '',
    email:
      typeof form.email === 'string' && form.email.length <= 320 && form.email.includes('@')
        ? form.email
        : null,
  });
  if (isAdminSuspended(user.suspended_reason)) {
    throw new OAuthError('access_denied', 'This account is suspended.', 403);
  }
  const accessToken = randomLoginProof();
  const expiresAt = until(TOKEN_SECONDS);
  const session: OAuthSession = {
    sub: user.id,
    aud: 'api',
    exp: Math.floor(Date.parse(expiresAt) / 1000),
    appPerson: true,
  };
  return db.transaction(async (tx) => {
    await activeOAuthClient(tx, client.id, true);
    // Decision: Each token is its own grant, so the app can hold several at once (two bots of one person).
    // Grants that can't be used any more are removed as new ones are made.
    await tx
      .delete(oauthGrants)
      .where(
        and(
          eq(oauthGrants.client_id, client.id),
          eq(oauthGrants.user_id, user.id),
          lt(oauthGrants.expires_at, new Date().toISOString()),
          sql`${oauthGrants.session}->>'appPerson' = 'true'`,
        ),
      );
    const grantId = crypto.randomUUID();
    await tx.insert(oauthGrants).values({
      id: grantId,
      client_id: client.id,
      user_id: user.id,
      session,
      scopes,
      token_hash: await hashLoginProof(accessToken),
      expires_at: expiresAt,
    });
    if (publishRequest) {
      const [request] = await tx
        .select()
        .from(oauthRequests)
        .where(
          and(
            eq(oauthRequests.id, publishRequest),
            eq(oauthRequests.client_id, client.id),
            isNull(oauthRequests.approved_at),
            isNull(oauthRequests.consumed_at),
            gt(oauthRequests.expires_at, new Date().toISOString()),
          ),
        )
        .for('update');
      const [asked] = request?.data.grantId
        ? await tx.select().from(oauthGrants).where(eq(oauthGrants.id, request.data.grantId))
        : [];
      if (
        !request ||
        request.data.kind !== 'deployment' ||
        asked?.client_id !== client.id ||
        asked.user_id !== user.id
      ) {
        throw new OAuthError('invalid_grant', 'This publish expired or belongs to someone else.');
      }
      const now = new Date().toISOString();
      const data = {
        ...request.data,
        // Decision: The deploy runs on this token's grant, which outlives the approval.
        grantId,
        projectId: await approval.project(context, tx as Db, request.data.slug!, user),
      };
      const [approved] = await tx
        .update(oauthRequests)
        .set({
          user_id: user.id,
          data,
          approved_at: now,
          consumed_at: now,
          expires_at: until(PUBLISH_SECONDS),
        })
        .where(eq(oauthRequests.id, request.id))
        .returning();
      const credential = await approval.token(context.env, approved!, user.id);
      const project = await getProject(tx as Db, data.projectId);
      return project && context.env.PLATFORM_APPLICATION
        ? { ...credential, url: projectUrl(project, context.env) }
        : credential;
    }
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_SECONDS,
      scope: scopes.join(' '),
    };
  });
}
