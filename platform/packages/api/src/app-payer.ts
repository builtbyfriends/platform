import type { PlanLimits } from '@builtbyfriends/platform/plans';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { OAuthSession } from './auth/oauth-types.ts';
import { OAuthError } from './auth/oauth.ts';
import type { DbOrTx } from './db.ts';
import { resolvePlanLimits } from './plans.ts';
import { appPayers, appPeople, appUsage, projects, users } from './schema.ts';

type Owner = { id: string; plan: string; provider: string; provider_id: string };
type Paid = { payer_person_id: string | null };

const APP = 'app:';

/**
 * The connected application's person who pays for a project. The application names them when it
 * makes the project; without a name it's the person the project was built for. An account with
 * its own Platform login has no payer: it pays on its own plan.
 */
export function projectPayer(
  owner: Pick<Owner, 'provider' | 'provider_id'>,
  project?: Paid | null,
): { clientId: string; personId: string } | null {
  return owner.provider.startsWith(APP)
    ? {
        clientId: owner.provider.slice(APP.length),
        personId: project?.payer_person_id ?? owner.provider_id,
      }
    : null;
}

async function payerPlanId(db: DbOrTx, owner: Owner, personId: string | null): Promise<string> {
  const payer = projectPayer(owner, { payer_person_id: personId });
  if (!payer) {
    return owner.plan;
  }
  const [row] = await db
    .select({ plan: appPeople.plan })
    .from(appPeople)
    .where(and(eq(appPeople.client_id, payer.clientId), eq(appPeople.person_id, payer.personId)));
  // Decision: A person who never bought a plan keeps the plan on the account, so an operator's override holds.
  return row?.plan ?? owner.plan;
}

/** The plan that sets one project's limits: its payer's, or the owner's when nobody else pays. */
export function billedPlanId(db: DbOrTx, owner: Owner, project: Paid): Promise<string> {
  return payerPlanId(db, owner, project.payer_person_id);
}

export async function billedPlanLimits(db: DbOrTx, owner: Owner, project: Paid) {
  return resolvePlanLimits(db, await billedPlanId(db, owner, project));
}

/**
 * The plan shown for an owner's account: the payer all of the owner's projects share, or the
 * owner's own person when they differ. It doesn't set monthly limits for a connected
 * application's account (see accountPlanLimits).
 */
export async function billedAccountPlanId(db: DbOrTx, owner: Owner): Promise<string> {
  if (!owner.provider.startsWith(APP)) {
    return owner.plan;
  }
  const payers = await db
    .selectDistinct({
      person: sql<string>`coalesce(${projects.payer_person_id}, ${owner.provider_id})`,
    })
    .from(projects)
    .where(and(eq(projects.user_id, owner.id), ne(projects.status, 'deleting')));
  return payerPlanId(db, owner, payers.length === 1 ? payers[0]!.person : null);
}

/**
 * The limits for an owner's shared monthly meters. A connected application's account has
 * no monthly caps on requests, AI or sandbox time here: each payer is held to their own balance or
 * plan, across the accounts they pay for (applyCredits in app-credits.ts).
 */
export async function accountPlanLimits(
  db: DbOrTx,
  owner: Pick<Owner, 'provider'> | null | undefined,
  planId: string,
): Promise<PlanLimits> {
  const limits = await resolvePlanLimits(db, planId);
  return owner?.provider.startsWith(APP)
    ? { ...limits, requestsPerMonth: 0, aiNeuronsPerMonth: 0, sandboxRuntimeSecondsPerMonth: 0 }
    : limits;
}

export async function billedAccountPlanLimits(db: DbOrTx, owner: Owner): Promise<PlanLimits> {
  return accountPlanLimits(db, owner, await billedAccountPlanId(db, owner));
}

/**
 * Checks the payer an application named for a project. Only an application acting for its own
 * people can name one, and it has to be a payer the application has already told Platform
 * about: someone it asked a token for, sold a plan to, or reported use for, or a wallet it opened.
 */
export async function namedPayer(
  db: DbOrTx,
  grant: { client_id: string; session: OAuthSession },
  payer: unknown,
): Promise<string | undefined> {
  if (payer === undefined) {
    return undefined;
  }
  if (!grant.session.appPerson || typeof payer !== 'string' || !payer || payer.length > 200) {
    throw new OAuthError('invalid_request', 'Name the payer with one of your own person IDs.');
  }
  const one = { one: sql<number>`1` };
  const known = await Promise.all([
    db
      .select(one)
      .from(users)
      .where(and(eq(users.provider, APP + grant.client_id), eq(users.provider_id, payer)))
      .limit(1),
    db
      .select(one)
      .from(appPeople)
      .where(and(eq(appPeople.client_id, grant.client_id), eq(appPeople.person_id, payer)))
      .limit(1),
    db
      .select(one)
      .from(appUsage)
      .where(and(eq(appUsage.client_id, grant.client_id), eq(appUsage.person_id, payer)))
      .limit(1),
    db
      .select(one)
      .from(appPayers)
      .where(and(eq(appPayers.client_id, grant.client_id), eq(appPayers.payer_id, payer)))
      .limit(1),
  ]);
  if (!known.some((rows) => rows.length > 0)) {
    throw new OAuthError('invalid_request', 'The payer is not one of your people.');
  }
  return payer;
}
