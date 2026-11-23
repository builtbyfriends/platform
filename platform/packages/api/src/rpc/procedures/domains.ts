import { type } from 'arktype';
import { sql } from 'drizzle-orm';
import { getPlatformCapabilities } from '../../capabilities.ts';
import { SITE_DOMAIN } from '../../constants.ts';
import {
  createDomain,
  deleteDomain,
  getDomain,
  getDomainByHostname,
  getDomainByHostnameOrCfHostnameId,
  getDomainsByProjectId,
  type Db,
} from '../../db.ts';
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  requireProjectCapability,
} from '../../project-access.ts';
import { tryActivateDomain } from '../../provisioning/activate-domain.ts';
import {
  CloudflareApiError,
  createCustomHostname,
  deleteCustomHostname,
  getCustomHostnameByHostname,
  type CustomHostnameInfo,
} from '../../provisioning/cloudflare-api.ts';
import type { DomainVerificationData } from '../../schema.ts';
import { ZeroTrustUnavailableError } from '../../zero-trust/errors.ts';
import { lockZeroTrustConfiguration } from '../../zero-trust/lock.ts';
import { reconcileProjectZeroTrustDomains } from '../../zero-trust/project.ts';
import {
  getProjectZeroTrustState,
  markProjectCustomDomainsChanged,
  MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT,
} from '../../zero-trust/state.ts';
import { canOnProject, grantedAccess } from '../access.ts';
import { member, procedure, type Caller } from '../procedure.ts';

const ORPHAN_ADOPTION_MIN_AGE_MS = 60_000;
const DOMAIN_LIMIT_MESSAGE = `Protected projects support at most ${MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT} custom domains`;

const ERRORS = {
  CAPABILITY_UNAVAILABLE: { status: 501, message: 'this platform does not enable custom domains' },
  HOSTNAME_INVALID: { status: 400, message: 'invalid hostname format' },
  HOSTNAME_RESERVED: { status: 400, message: 'cannot use platform subdomains' },
  HOSTNAME_IN_USE: { status: 409, message: 'hostname already in use' },
  DOMAIN_LIMIT: { status: 409, message: DOMAIN_LIMIT_MESSAGE },
  PROJECT_DELETING: { status: 409, message: 'project is being deleted' },
  DOMAIN_NOT_FOUND: { status: 404, message: 'domain not found' },
  ACCESS_DENIED: { status: 403, message: 'project access denied' },
  ZERO_TRUST_UNAVAILABLE: { status: 409, message: 'zero trust is not ready' },
  CLOUDFLARE_BAD_REQUEST: { status: 400, message: 'Cloudflare rejected the hostname' },
  CLOUDFLARE_CONFLICT: { status: 409, message: 'Cloudflare reports a conflict' },
  CLOUDFLARE_INVALID: { status: 422, message: 'Cloudflare rejected the hostname' },
  CLOUDFLARE_RATE_LIMITED: { status: 429, message: 'Cloudflare is rate limiting; retry later' },
} as const;

type Refusal = { code: keyof typeof ERRORS; message?: string };

/** The refusal for a Cloudflare 4xx a caller can act on, or null for any other failure. */
function cloudflareRefusal(error: unknown): Refusal | null {
  if (!(error instanceof CloudflareApiError)) {
    return null;
  }
  const code = (
    {
      400: 'CLOUDFLARE_BAD_REQUEST',
      409: 'CLOUDFLARE_CONFLICT',
      422: 'CLOUDFLARE_INVALID',
      429: 'CLOUDFLARE_RATE_LIMITED',
    } as const
  )[error.status as 400 | 409 | 422 | 429];
  // Decision: 401, 403, 404 and 5xx are the platform's own token or Cloudflare faults. The caller can't fix
  // them and their messages would leak internal state, so they stay generic server errors.
  return code ? { code, message: error.message } : null;
}

function isAdoptablePostCreateOrphan(cfHostname: CustomHostnameInfo): boolean {
  if (cfHostname.status !== 'pending') {
    return false;
  }
  if (!cfHostname.ownership_verification && !cfHostname.ownership_verification_http) {
    return false;
  }
  if (!cfHostname.created_at) {
    return false;
  }
  const createdAtMs = Date.parse(cfHostname.created_at);
  return Number.isFinite(createdAtMs) && Date.now() - createdAtMs >= ORPHAN_ADOPTION_MIN_AGE_MS;
}

async function protectedProjectReachedDomainLimit(db: Db, projectId: string): Promise<boolean> {
  const zeroTrust = await getProjectZeroTrustState(db, projectId);
  if (!zeroTrust?.desired_protected) {
    return false;
  }
  return (
    (await getDomainsByProjectId(db, projectId)).length >= MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT
  );
}

const domain = type({
  id: 'string',
  project_id: 'string',
  hostname: 'string',
  cf_hostname_id: 'string',
  status: 'string',
  created_at: 'string',
  'cname_target?': 'string',
  'ownership_verification?': 'object | undefined',
  'ssl_validation_records?': 'object[]',
});

const domainStatus = type({
  '...': domain,
  cname_target: 'string',
  ssl_status: 'string',
  'cf_status?': 'string',
  awaiting_deployment: 'boolean',
  'verification_errors?': 'unknown',
});

function capabilityRefusal(env: Parameters<typeof getPlatformCapabilities>[0]): Refusal | null {
  return getPlatformCapabilities(env).customDomains ? null : { code: 'CAPABILITY_UNAVAILABLE' };
}

export const add = procedure('domains.add')
  .use(member)
  .input(type({ projectId: 'string', hostname: 'string' }))
  .authz({ policy: 'project-settings', check: canOnProject('settings') })
  .output(domain)
  .errors(ERRORS)
  .mcp({ description: 'Add a custom domain to a project', effect: 'write' })
  .cli({ command: 'domains add', description: 'Add a custom domain' })
  .handler(async ({ env, ctx, input, fail }) => {
    const unavailable = capabilityRefusal(env);
    if (unavailable) {
      return fail(unavailable.code);
    }
    const { projectId, hostname } = input;
    if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
      return fail('HOSTNAME_INVALID');
    }
    const siteDomain = env.SITE_DOMAIN ?? SITE_DOMAIN;
    if (hostname === siteDomain || hostname.endsWith(`.${siteDomain}`)) {
      return fail('HOSTNAME_RESERVED', `cannot use ${siteDomain} subdomains`);
    }
    if (await getDomainByHostname(ctx.db, hostname)) {
      return fail('HOSTNAME_IN_USE');
    }
    if (await protectedProjectReachedDomainLimit(ctx.db, projectId)) {
      return fail('DOMAIN_LIMIT');
    }

    // Decision: A duplicate hostname can be a Cloudflare object left by an earlier post-create DB failure. Adopt
    // only still-pending objects with an open ownership challenge; a verified or active hostname mustn't
    // become claimable by another project. Creation is a reversible first phase: the second phase takes
    // the project lock and rechecks access, and if it loses, the created object is handed back.
    let cfHostname: CustomHostnameInfo;
    let createdCfHostname: CustomHostnameInfo | undefined;
    try {
      cfHostname = await createCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, hostname);
      createdCfHostname = cfHostname;
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 409) {
        if (await getDomainByHostname(ctx.db, hostname)) {
          return fail('HOSTNAME_IN_USE');
        }
        let orphaned: CustomHostnameInfo | null;
        try {
          orphaned = await getCustomHostnameByHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, hostname);
        } catch (lookupError) {
          if (lookupError instanceof CloudflareApiError && lookupError.status === 429) {
            return fail('CLOUDFLARE_RATE_LIMITED', lookupError.message);
          }
          return fail('CLOUDFLARE_CONFLICT', error.message);
        }
        if (orphaned && isAdoptablePostCreateOrphan(orphaned)) {
          cfHostname = orphaned;
        } else {
          return fail('CLOUDFLARE_CONFLICT', error.message);
        }
      } else {
        const refusal = cloudflareRefusal(error);
        if (refusal) {
          return fail(refusal.code, refusal.message);
        }
        throw error;
      }
    }

    const rollbackCreatedHostname = async (): Promise<void> => {
      if (!createdCfHostname) {
        return;
      }
      const persisted = await getDomainByHostnameOrCfHostnameId(
        ctx.db,
        hostname,
        createdCfHostname.id,
      );
      if (!persisted) {
        await deleteCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, createdCfHostname.id).catch(
          (error) => {
            console.error(
              `Failed to delete orphaned custom hostname ${createdCfHostname?.id} after DB transaction failure:`,
              error,
            );
          },
        );
      }
    };

    let result;
    try {
      result = await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const refused = await lockedAccess(tx, ctx, projectId, 'settings');
        if (refused) {
          return refused;
        }
        // Decision: Recheck after waiting for the lock: an earlier request may have committed meanwhile.
        if (await getDomainByHostname(tx, hostname)) {
          return { code: 'HOSTNAME_IN_USE' } as const;
        }
        if (await protectedProjectReachedDomainLimit(tx, projectId)) {
          return { code: 'DOMAIN_LIMIT' } as const;
        }
        // Decision: Under HTTP-DCV the certificate is validated at the edge once the hostname proxies, so Cloudflare
        // doesn't send `ssl.validation_records`; keep the ownership challenge instead.
        const verification: DomainVerificationData = {
          ownership_verification: cfHostname.ownership_verification,
          ssl_validation_records: cfHostname.ssl.validation_records,
        };
        const created = await createDomain(tx, projectId, hostname, cfHostname.id, verification);
        return {
          ...created,
          cname_target: `cname.${env.SITE_DOMAIN ?? SITE_DOMAIN}`,
          ownership_verification: cfHostname.ownership_verification,
          ssl_validation_records: cfHostname.ssl.validation_records ?? [],
        };
      });
    } catch (error) {
      // Decision: The create can succeed even when the transaction later fails. Hand back only the object this
      // request created; an adopted one belongs to the recovery path.
      await rollbackCreatedHostname();
      throw error;
    }
    if (result.code) {
      await rollbackCreatedHostname();
      return fail(result.code, 'message' in result ? result.message : undefined);
    }
    return { ...result, ssl_validation_records: [...(result.ssl_validation_records ?? [])] };
  });

/** Under the project lock: the caller still holds `capability`, and the project is not going away. */
async function lockedAccess(
  tx: Db,
  caller: Caller,
  projectId: string,
  capability: 'settings',
): Promise<Refusal | null> {
  try {
    const access = await requireProjectCapability(tx, projectId, caller.user.id, capability);
    return access.project.status === 'deleting' ? { code: 'PROJECT_DELETING' } : null;
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
      return { code: 'ACCESS_DENIED' };
    }
    throw error;
  }
}

export const list = procedure('domains.list')
  .use(member)
  .input(type({ projectId: 'string' }))
  .authz({ policy: 'project-read', check: canOnProject('read') })
  .output(domain.array())
  .errors({ CAPABILITY_UNAVAILABLE: ERRORS.CAPABILITY_UNAVAILABLE })
  .mcp({ description: 'List a project’s custom domains', effect: 'read', idempotent: true })
  .cli({ command: 'domains list', description: 'List custom domains' })
  .handler(async ({ env, ctx, input, fail }) => {
    if (capabilityRefusal(env)) {
      return fail('CAPABILITY_UNAVAILABLE');
    }
    return [...(await getDomainsByProjectId(ctx.db, input.projectId))];
  });

export const status = procedure('domains.status')
  .use(member)
  .input(type({ projectId: 'string', domainId: 'string' }))
  .authz({ policy: 'project-read', check: canOnProject('read') })
  .output(domainStatus)
  .errors({
    CAPABILITY_UNAVAILABLE: ERRORS.CAPABILITY_UNAVAILABLE,
    DOMAIN_NOT_FOUND: ERRORS.DOMAIN_NOT_FOUND,
  })
  .mcp({
    description: 'Check a custom domain against Cloudflare and activate it when ready',
    effect: 'read',
    idempotent: true,
  })
  .cli({ command: 'domains status', description: 'Show a custom domain’s live status' })
  .handler(async ({ env, ctx, input, fail }) => {
    if (capabilityRefusal(env)) {
      return fail('CAPABILITY_UNAVAILABLE');
    }
    const { project } = grantedAccess(ctx);
    const found = await getDomain(ctx.db, input.domainId);
    if (!found || found.project_id !== input.projectId) {
      return fail('DOMAIN_NOT_FOUND');
    }
    const { cf, activated, awaitingDeployment } = await tryActivateDomain(
      env,
      ctx.db,
      found,
      project,
    );
    return {
      ...found,
      status: activated || found.status === 'active' ? 'active' : found.status,
      cname_target: `cname.${env.SITE_DOMAIN ?? SITE_DOMAIN}`,
      ssl_status: cf.ssl.status,
      cf_status: cf.status,
      awaiting_deployment: awaitingDeployment,
      verification_errors: cf.verification_errors,
      ownership_verification: cf.ownership_verification,
      ssl_validation_records: [...(cf.ssl.validation_records ?? [])],
    };
  });

export const remove = procedure('domains.remove')
  .use(member)
  .input(type({ projectId: 'string', domainId: 'string' }))
  .authz({ policy: 'project-settings', check: canOnProject('settings') })
  .output(type({ ok: 'true', 'warnings?': 'string[]' }))
  .errors(ERRORS)
  .mcp({ description: 'Remove a custom domain from a project', effect: 'destructive' })
  .cli({ command: 'domains remove', description: 'Remove a custom domain' })
  .handler(async ({ env, ctx, input, fail }) => {
    if (capabilityRefusal(env)) {
      return fail('CAPABILITY_UNAVAILABLE');
    }
    const { projectId } = input;
    const found = await getDomain(ctx.db, input.domainId);
    if (!found || found.project_id !== projectId) {
      return fail('DOMAIN_NOT_FOUND');
    }
    const warnings: Array<string> = [];
    const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

    // Decision: Cloudflare cleanup is best effort. KV and DB deletion serialize with deploy, rollback, activation
    // and failed-cutover compensation through the project row, so none can bring back this hostname from
    // a stale snapshot. The shared Zero Trust lock comes first: when it refuses during uninstall, nothing
    // outside the database has been removed yet.
    const refused = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
      try {
        await lockZeroTrustConfiguration(tx, 'shared');
      } catch (error) {
        if (error instanceof ZeroTrustUnavailableError) {
          return { code: 'ZERO_TRUST_UNAVAILABLE', message: error.message } as const;
        }
        throw error;
      }
      try {
        await requireProjectCapability(tx, projectId, ctx.user.id, 'settings');
      } catch (error) {
        if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
          return { code: 'ACCESS_DENIED' } as const;
        }
        throw error;
      }
      await deleteCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, found.cf_hostname_id).catch(
        (error) => warnings.push(`Failed to delete custom hostname: ${describe(error)}`),
      );
      await env.ROUTING.delete(`domain:${found.hostname}`).catch((error) =>
        warnings.push(`Failed to delete routing entry: ${describe(error)}`),
      );
      // Decision: The project's custom-domain application still lists this hostname. Record that with the deletion,
      // so the hostname isn't freed while no retry would remove it from there.
      await markProjectCustomDomainsChanged(tx, projectId);
      await deleteDomain(tx, found.id);
      return null;
    });
    if (refused) {
      return fail(refused.code, 'message' in refused ? refused.message : undefined);
    }
    await reconcileProjectZeroTrustDomains(env, ctx.db, projectId).catch((error) =>
      warnings.push(`Failed to reconcile Zero Trust custom-domain protection: ${describe(error)}`),
    );
    return { ok: true, ...(warnings.length > 0 && { warnings }) } as const;
  });
