import { sql as drizzleSql } from 'drizzle-orm';
import { getDomain, getProject, updateDomainStatus, updateDomainVerificationData } from '../db.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { projectRouteKey } from '../routing.ts';
import type { DomainVerificationData } from '../schema.ts';
import type { Domain, Project } from '../types.ts';
import { ZeroTrustUnavailableError } from '../zero-trust/errors.ts';
import { reconcileProjectZeroTrustDomains } from '../zero-trust/project.ts';
import {
  resolveProjectZeroTrustRoutingForPublication,
  withProjectZeroTrustRouting,
} from '../zero-trust/routing.ts';
import { getCustomHostname, patchCustomHostname } from './cloudflare-api.ts';
import type { CustomHostnameInfo } from './cloudflare-api.ts';

export type ActivateDomainResult = Readonly<{
  cf: CustomHostnameInfo;
  gateOk: boolean;
  activated: boolean;
  awaitingDeployment: boolean;
}>;

// Decision: Polls CF, evaluates the activation gate and, when it passes and the project has live slug routing,
// copies the slug routing entry to `domain:<host>` in KV and sets the DB row active. Also refreshes
// verification_data and mutates the passed `domain` in place. The status route and the
// reconciliation cron share it so the security gate has one definition. When the domain is already
// active, `slugRouting` isn't fetched and `awaitingDeployment` is false, so pass pending rows.
// `options.retriggerDcv` gates the HTTP-DCV re-trigger PATCH and defaults to off. Only the hourly
// reconcile tier passes `true`, which bounds per-account CF custom-hostname API load; the 2-minute
// tier would fire about N PATCHes per run and risk 429s for other tenants.
export async function tryActivateDomain(
  env: ApiEnv['Bindings'],
  db: Db,
  domain: Domain,
  project: Project,
  options?: { retriggerDcv?: boolean },
): Promise<ActivateDomainResult> {
  // Decision: Capture the original pending status before any mutation so awaitingDeployment uses the
  // pre-mutation state.
  const wasPending = domain.status === 'pending';

  const cf = await getCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, domain.cf_hostname_id);

  // Decision: Custom-hostname validation has two separate axes:
  // - Hostname ownership, the input to the top-level `status`. CF accepts the `_cf-custom-hostname`
  //   TXT, the HTTP token, or a CNAME to the SaaS zone.
  // - Certificate DCV (`ssl.method`, `ssl.validation_records`), the input to `ssl.status`.
  // The CNAME alone proves ownership, so a leftover or wildcard CNAME (`*.victim -> cname.void.app`)
  // lets whoever adds the hostname first activate it. Other hosting platforms accept the same
  // trade-off; we keep it so setup needs only the traffic CNAME. Cert DCV is method-agnostic here,
  // which keeps pending domains still on `txt` DCV activatable.
  // The main signal is CF's `status === 'active'`. Requiring both ownership challenges (TXT and HTTP)
  // to be gone is defense in depth: we refuse to route if CF ever reports `active` with one
  // outstanding.
  const gateOk =
    cf.status === 'active' &&
    cf.ssl.status === 'active' &&
    !cf.ownership_verification &&
    !cf.ownership_verification_http;

  // Decision: Activate only after KV routing is in place. A never-deployed project has no `project.slug` in KV;
  // the row stays 'pending' so the next poll retries.
  // Write KV before setting the DB row `active`: a crash in between leaves the row `pending`, and the
  // next poll rewrites the same KV entry. The other order would strand an `active` row with no route
  // (404s until a manual fix). Read slug routing whenever the CF gate passes so `awaitingDeployment`
  // is reported even when activation didn't happen.
  let slugRouting: string | null = null;
  let activated = false;
  if (gateOk && wasPending) {
    // Decision: A protected project needs an exact-host Access application and its audience in dispatch routing
    // before this custom hostname can become reachable. Reconciliation is idempotent and fails closed: a
    // Cloudflare API failure leaves the domain pending with no routing entry.
    await reconcileProjectZeroTrustDomains(env, db, project.id, { verifiedDomainId: domain.id });
    await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`);
      const [lockedProject, lockedDomain] = await Promise.all([
        getProject(tx, project.id),
        getDomain(tx, domain.id),
      ]);
      if (
        !lockedProject ||
        lockedProject.status === 'deleting' ||
        lockedDomain?.status !== 'pending'
      ) {
        return;
      }
      slugRouting = await env.ROUTING.get(projectRouteKey(lockedProject));
      if (!slugRouting) {
        return;
      }
      // Decision: Activation is retried while the domain stays pending, so unknown protection, or a cached slug route
      // that still belongs to a deleted project, keeps it pending instead of publishing a route.
      let published;
      try {
        const protection = await resolveProjectZeroTrustRoutingForPublication(tx, project.id, {
          retryable: true,
        });
        published = withProjectZeroTrustRouting(slugRouting, protection, project.id);
      } catch (error) {
        if (error instanceof ZeroTrustUnavailableError) {
          return;
        }
        throw error;
      }
      await env.ROUTING.put(`domain:${lockedDomain.hostname}`, published);
      await updateDomainStatus(tx, lockedDomain.id, 'active');
      activated = true;
      domain.status = 'active';
    });
  }

  const awaitingDeployment = gateOk && wasPending && !slugRouting;

  if (cf.ownership_verification || cf.ssl.validation_records) {
    const verificationData: DomainVerificationData = {
      ownership_verification: cf.ownership_verification,
      ssl_validation_records: cf.ssl.validation_records,
    };
    await updateDomainVerificationData(db, domain.id, verificationData);
    domain.verification_data = verificationData;
  }

  // Decision: Best-effort re-trigger of HTTP DCV for an add-first domain that hasn't validated. Platform creates
  // the CF hostname with `ssl.method:'http'` before the user points the CNAME at `cname.void.app`; CF's
  // Create Custom Hostname docs say to PATCH once the domain points at the Managed CNAME for HTTP
  // validation to complete. A no-change PATCH re-sends the `ssl` block, re-triggering DCV and resetting
  // CF's decaying validation backoff (and avoiding CF's 7-day delete). Gated on:
  // - `options.retriggerDcv`: only the hourly tier opts in, to bound API load.
  // - `wasPending && !gateOk`: skip if already validated or active.
  // - `cf.ssl.method === 'http'`: a legacy pending hostname on `txt` must keep its method, or the
  //   user's in-progress `_acme-challenge` validation is lost.
  // A PATCH failure must not throw or change the result.
  if (options?.retriggerDcv && wasPending && !gateOk && cf.ssl.method === 'http') {
    await patchCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, domain.cf_hostname_id).catch(
      (error) =>
        console.error(
          `[activate-domain] failed to re-trigger HTTP DCV for ${domain.hostname}:`,
          error,
        ),
    );
  }

  return { cf, gateOk, activated, awaitingDeployment };
}
