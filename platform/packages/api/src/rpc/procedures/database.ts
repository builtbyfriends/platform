import { type } from 'arktype';
import { sql } from 'drizzle-orm';
import {
  createResource,
  getProjectDatabaseUrl,
  getProjectResources,
  upsertProjectDatabaseUrl,
} from '../../db.ts';
import type { Db } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  requireProjectCapability,
} from '../../project-access.ts';
import { decryptProjectSecret, encryptProjectSecret } from '../../project-secrets.ts';
import {
  CloudflareApiError,
  InvalidHyperdriveConnectionStringError,
  createHyperdrive,
  deleteHyperdrive,
  getHyperdriveByName,
  updateHyperdrive,
} from '../../provisioning/cloudflare-api.ts';
import { canOnProject, grantedAccess } from '../access.ts';
import { member, procedure } from '../procedure.ts';
import type { Caller } from '../procedure.ts';

class DatabaseUrlPersistenceError extends Error {
  constructor(cause: unknown) {
    super('failed to persist database configuration', { cause });
    this.name = 'DatabaseUrlPersistenceError';
  }
}

const ERRORS = {
  PROJECT_DELETING: { status: 409, message: 'Project is being deleted' },
  ACCESS_DENIED: { status: 403, message: 'project access denied' },
  ALREADY_PROVISIONED: {
    status: 409,
    message: 'Hyperdrive already provisioned. Use `bwf db set-url` to update.',
  },
  CONNECTION_STRING_INVALID: { status: 400, message: 'invalid database connection string' },
  PROVISIONING_FAILED: { status: 502, message: 'Failed to provision Hyperdrive' },
  PERSISTENCE_FAILED: {
    status: 500,
    message:
      'Failed to persist database URL after Cloudflare accepted it. Run `bwf db set-url` again to re-sync.',
  },
  NOT_STORED: {
    status: 404,
    message:
      "This project's database URL is not stored on the platform yet. Run `bwf db set-url` once to populate it.",
  },
} as const;

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('already exists');
}

/**
 * Create the project's Hyperdrive, or adopt one an earlier partial attempt left untracked under
 * the same name by updating it in place. Callers hold the project lock so no membership change
 * can interleave the live update and the durable resource row. `created` is true only for a
 * fresh object, the only kind that is safe to delete if persistence later fails.
 */
async function createOrAdoptHyperdrive(
  env: ApiEnv['Bindings'],
  resourceName: string,
  connectionString: string,
): Promise<{ id: string; created: boolean }> {
  try {
    const hd = await createHyperdrive(
      env.CF_ACCOUNT_ID,
      env.CF_API_TOKEN,
      resourceName,
      connectionString,
    );
    return { id: hd.id, created: true };
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  }
  const hd = await getHyperdriveByName(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, resourceName);
  await updateHyperdrive(
    env.CF_ACCOUNT_ID,
    env.CF_API_TOKEN,
    hd.id,
    connectionString,
    resourceName,
  );
  return { id: hd.id, created: false };
}

function hyperdriveResourceName(projectId: string): string {
  return `${projectId}-hyperdrive`.toLowerCase().replaceAll('_', '-');
}

type Failure = {
  code: 'CONNECTION_STRING_INVALID' | 'PROVISIONING_FAILED';
  message: string;
};

function provisioningFailure(error: unknown): Failure | null {
  if (error instanceof CloudflareApiError) {
    return {
      code: 'PROVISIONING_FAILED',
      message: `Failed to provision Hyperdrive: ${error.message.replace(/^Cloudflare API error:\s*/, '')}`,
    };
  }
  if (error instanceof InvalidHyperdriveConnectionStringError) {
    return { code: 'CONNECTION_STRING_INVALID', message: error.message };
  }
  return null;
}

const configure = { policy: 'project-configure', check: canOnProject('configure') } as const;
const written = type({ ok: 'true' });
const connection = type({ projectId: 'string', connectionString: 'string' });
const noMcpSecret = {
  reason: 'Database connection strings are credentials, kept out of agent tools',
};

type Outcome = { code: keyof typeof ERRORS; message?: string } | { ok: true };

/** Under the project lock: the caller is still allowed and the project is not being deleted. */
async function lockedProject(ctx: Caller, projectId: string, tx: Db): Promise<Outcome | null> {
  await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
  try {
    const access = await requireProjectCapability(tx, projectId, ctx.user.id, 'configure');
    return access.project.status === 'deleting' ? { code: 'PROJECT_DELETING' } : null;
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
      return { code: 'ACCESS_DENIED' };
    }
    throw error;
  }
}

export const provision = procedure('database.provision')
  .use(member)
  .input(connection)
  .authz(configure)
  .output(written)
  .errors(ERRORS)
  .noMcp(noMcpSecret)
  .cli({ command: 'db provision', description: 'Provision Hyperdrive for an external database' })
  .handler(async ({ env, ctx, input, fail }) => {
    const { projectId, connectionString } = input;
    // Decision: Fast rejection; the transaction below checks status and capability again under the lock.
    if (grantedAccess(ctx).project.status === 'deleting') {
      return fail('PROJECT_DELETING');
    }
    if ((await getProjectResources(ctx.db, projectId)).some((r) => r.type === 'hyperdrive')) {
      return fail('ALREADY_PROVISIONED');
    }
    const resourceName = hyperdriveResourceName(projectId);
    // Decision: Only an object we created is safe to roll back if the locked transaction later fails.
    let hyperdriveId: string | undefined;
    let createdByUs = false;
    const encrypted = await encryptProjectSecret(env, projectId, 'database-url', connectionString);
    let outcome: Outcome | Failure;
    try {
      outcome = await ctx.db.transaction(async (tx): Promise<Outcome | Failure> => {
        const refused = await lockedProject(ctx, projectId, tx);
        if (refused) {
          return refused;
        }
        // Decision: Re-read after the lock: membership changes, teardown and a competing provision all serialize on
        // this project row.
        if ((await getProjectResources(tx, projectId)).some((r) => r.type === 'hyperdrive')) {
          return { code: 'ALREADY_PROVISIONED' };
        }
        try {
          const hd = await createOrAdoptHyperdrive(env, resourceName, connectionString);
          hyperdriveId = hd.id;
          createdByUs = hd.created;
        } catch (error) {
          const failure = provisioningFailure(error);
          if (failure) {
            return failure;
          }
          throw error;
        }
        try {
          // Decision: Both handles persist in one transaction: if either write or COMMIT fails, the catch below
          // removes a Hyperdrive we created so no untracked object is left.
          await upsertProjectDatabaseUrl(
            tx,
            projectId,
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.keyVersion,
          );
          await createResource(tx, projectId, 'hyperdrive', hyperdriveId, 'HYPERDRIVE');
        } catch (error) {
          throw new DatabaseUrlPersistenceError(error);
        }
        return { ok: true };
      });
    } catch (error) {
      if (createdByUs && hyperdriveId) {
        await deleteHyperdrive(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, hyperdriveId).catch(() => {});
      }
      if (error instanceof DatabaseUrlPersistenceError) {
        return fail('PERSISTENCE_FAILED');
      }
      throw error;
    }
    return 'code' in outcome
      ? fail(outcome.code, 'message' in outcome ? outcome.message : undefined)
      : written.assert(outcome);
  });

export const setUrl = procedure('database.setUrl')
  .use(member)
  .input(connection)
  .authz(configure)
  .output(written)
  .errors(ERRORS)
  .noMcp(noMcpSecret)
  .cli({ command: 'db set-url', description: 'Update the external database connection string' })
  .handler(async ({ env, ctx, input, fail }) => {
    const { projectId, connectionString } = input;
    if (grantedAccess(ctx).project.status === 'deleting') {
      return fail('PROJECT_DELETING');
    }
    const encrypted = await encryptProjectSecret(env, projectId, 'database-url', connectionString);
    const resourceName = hyperdriveResourceName(projectId);
    let createdHyperdriveId: string | undefined;
    let outcome: Outcome | Failure;
    try {
      outcome = await ctx.db.transaction(async (tx): Promise<Outcome | Failure> => {
        const refused = await lockedProject(ctx, projectId, tx);
        if (refused) {
          return refused;
        }
        // Decision: Resolve the resource only after taking the lock, so a downgrade or removal is settled before any
        // live Hyperdrive update goes to Cloudflare.
        const existing = (await getProjectResources(tx, projectId)).find(
          (r) => r.type === 'hyperdrive',
        );
        if (existing) {
          try {
            await updateHyperdrive(
              env.CF_ACCOUNT_ID,
              env.CF_API_TOKEN,
              existing.cf_id,
              connectionString,
              resourceName,
            );
          } catch (error) {
            const failure = provisioningFailure(error);
            if (failure) {
              return failure;
            }
            throw error;
          }
        } else {
          let hyperdriveId: string;
          try {
            const hd = await createOrAdoptHyperdrive(env, resourceName, connectionString);
            hyperdriveId = hd.id;
            if (hd.created) {
              createdHyperdriveId = hd.id;
            }
          } catch (error) {
            const failure = provisioningFailure(error);
            if (failure) {
              return failure;
            }
            throw error;
          }
          try {
            await createResource(tx, projectId, 'hyperdrive', hyperdriveId, 'HYPERDRIVE');
          } catch (error) {
            throw new DatabaseUrlPersistenceError(error);
          }
        }
        try {
          await upsertProjectDatabaseUrl(
            tx,
            projectId,
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.keyVersion,
          );
        } catch (error) {
          throw new DatabaseUrlPersistenceError(error);
        }
        return { ok: true };
      });
    } catch (error) {
      // Decision: Only a freshly created object is safe to delete; adopted or existing Hyperdrives may still be
      // referenced by an earlier attempt.
      if (createdHyperdriveId) {
        await deleteHyperdrive(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, createdHyperdriveId).catch(
          () => {},
        );
      }
      if (error instanceof DatabaseUrlPersistenceError) {
        return fail('PERSISTENCE_FAILED');
      }
      throw error;
    }
    return 'code' in outcome
      ? fail(outcome.code, 'message' in outcome ? outcome.message : undefined)
      : written.assert(outcome);
  });

export const getUrl = procedure('database.getUrl')
  .use(member)
  .input(type({ projectId: 'string' }))
  // Decision: Only the owner may read the stored connection string: `delete` is the capability only they hold.
  .authz({ policy: 'project-owner', check: canOnProject('delete') })
  .output(type({ url: 'string' }))
  .errors({ NOT_STORED: ERRORS.NOT_STORED })
  .noMcp(noMcpSecret)
  .cli({ command: 'db url', description: 'Show the stored database connection string' })
  .handler(async ({ env, ctx, input, fail }) => {
    const row = await getProjectDatabaseUrl(ctx.db, input.projectId);
    if (!row) {
      return fail('NOT_STORED');
    }
    const url = await decryptProjectSecret(env, input.projectId, {
      name: 'database-url',
      ciphertext: row.ciphertext,
      iv: row.iv,
      key_version: row.key_version,
    });
    return { url };
  });
