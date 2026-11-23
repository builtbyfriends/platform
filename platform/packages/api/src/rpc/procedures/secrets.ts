import { type } from 'arktype';
import { sql } from 'drizzle-orm';
import {
  DEFAULT_DISPATCH_NAMESPACE,
  MAX_SECRET_NAME_LENGTH,
  MAX_SECRET_VALUE_BYTES,
} from '../../constants.ts';
import {
  deleteProjectSecret,
  getActiveDeployment,
  listProjectSecretNames,
  upsertProjectSecret,
} from '../../db.ts';
import { getProjectDeploymentWorkerName } from '../../naming.ts';
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  requireProjectCapability,
} from '../../project-access.ts';
import type { ProjectAccess } from '../../project-access.ts';
import {
  deleteWorkerSecret,
  encryptProjectSecret,
  putWorkerSecret,
} from '../../project-secrets.ts';
import { isReservedBindingName } from '../../reserved-bindings.ts';
import { canOnProject } from '../access.ts';
import { member, procedure } from '../procedure.ts';
import type { Caller } from '../procedure.ts';

export const list = procedure('secrets.list')
  .use(member)
  .input(type({ projectId: 'string' }))
  .authz({ policy: 'project-configure', check: canOnProject('configure') })
  .output(type({ name: 'string' }).array())
  .noErrors({ reason: 'A project with no secrets returns an empty list' })
  .mcp({
    description: 'List the names of a project’s secrets, never their values',
    effect: 'read',
    idempotent: true,
  })
  .cli({ command: 'secrets list', description: 'List secret names' })
  .handler(async ({ ctx, input }) => [...(await listProjectSecretNames(ctx.db, input.projectId))]);

const WRITE_ERRORS = {
  INVALID_NAME: { status: 400, message: 'invalid secret name' },
  NAME_TOO_LONG: { status: 400, message: 'secret name too long' },
  RESERVED_NAME: { status: 400, message: 'reserved binding name' },
  VALUE_REQUIRED: { status: 400, message: 'value is required' },
  VALUE_TOO_LARGE: { status: 400, message: 'secret value too large' },
  PROJECT_DELETING: { status: 410, message: 'project is being deleted' },
  ACCESS_DENIED: { status: 403, message: 'project access denied' },
  DEPLOYMENT_IN_PROGRESS: {
    status: 409,
    message: 'deployment or rollback in progress; retry secret changes when it completes',
  },
  PROPAGATION_FAILED: {
    status: 502,
    message: 'secret changed in storage but live propagation failed',
  },
} as const;

type WriteRefusal = { code: keyof typeof WRITE_ERRORS; message?: string };

const secretName = /^[A-Z][A-Z0-9_]*$/;

/**
 * Runs `update` under the project's row lock. It is the fence deploys and rollbacks claim their
 * leases with: hold it through live propagation, and refuse while a deployment is in flight,
 * because a candidate may already have captured the secrets.
 */
async function withProjectSecretUpdate<T>(
  caller: Caller,
  projectId: string,
  update: (db: Caller['db'], access: ProjectAccess) => Promise<T | WriteRefusal>,
): Promise<T | WriteRefusal> {
  return caller.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    let access: ProjectAccess;
    try {
      access = await requireProjectCapability(tx, projectId, caller.user.id, 'configure');
    } catch (error) {
      if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
        return { code: 'ACCESS_DENIED' } as const;
      }
      throw error;
    }
    if (access.project.status === 'deleting') {
      return { code: 'PROJECT_DELETING' } as const;
    }
    const pending = await getActiveDeployment(tx, projectId);
    if (pending) {
      return {
        code: 'DEPLOYMENT_IN_PROGRESS',
        message: `${WRITE_ERRORS.DEPLOYMENT_IN_PROGRESS.message} (${pending.id})`,
      } as const;
    }
    return update(tx, access);
  });
}

const written = type({ ok: 'true', name: 'string' });

function isRefusal<T>(result: T | WriteRefusal): result is WriteRefusal {
  return typeof result === 'object' && result !== null && 'code' in result;
}

export const set = procedure('secrets.set')
  .use(member)
  .input(type({ projectId: 'string', name: 'string', value: 'string' }))
  .authz({ policy: 'project-configure', check: canOnProject('configure') })
  .output(written)
  .errors(WRITE_ERRORS)
  .mcp({
    description: 'Set a project secret. The value is encrypted and pushed to the live Worker',
    effect: 'write',
    idempotent: true,
  })
  .cli({ command: 'secrets set', description: 'Set a secret' })
  .handler(async ({ env, ctx, input, fail }) => {
    const { projectId, name, value } = input;
    if (!secretName.test(name)) {
      return fail('INVALID_NAME');
    }
    if (name.length > MAX_SECRET_NAME_LENGTH) {
      return fail('NAME_TOO_LONG');
    }
    // Decision: Reject before encrypting and storing: the deploy pipeline rejects the same names, but only at the
    // next deploy. Delete stays unguarded so a row stored before this guard can be cleaned up.
    if (isReservedBindingName(name)) {
      return fail('RESERVED_NAME');
    }
    if (value.length === 0) {
      return fail('VALUE_REQUIRED');
    }
    if (new TextEncoder().encode(value).byteLength > MAX_SECRET_VALUE_BYTES) {
      return fail('VALUE_TOO_LARGE');
    }
    const encrypted = await encryptProjectSecret(env, projectId, name, value);
    const result = await withProjectSecretUpdate(ctx, projectId, async (db, { project }) => {
      await upsertProjectSecret(
        db,
        projectId,
        name,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.keyVersion,
      );
      if (project.active_deployment_id) {
        const namespace = env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
        const worker = getProjectDeploymentWorkerName(project.slug, project.active_deployment_id);
        try {
          await putWorkerSecret(env, namespace, worker, name, value);
        } catch (error) {
          return {
            code: 'PROPAGATION_FAILED',
            message: `secret stored but live propagation failed: ${error instanceof Error ? error.message : String(error)}`,
          } as const;
        }
      }
      return { ok: true, name } as const;
    });
    return isRefusal(result) ? fail(result.code, result.message) : result;
  });

export const remove = procedure('secrets.delete')
  .use(member)
  .input(type({ projectId: 'string', name: 'string' }))
  .authz({ policy: 'project-configure', check: canOnProject('configure') })
  .output(written)
  .errors(WRITE_ERRORS)
  .mcp({
    description: 'Delete a project secret from storage and from the live Worker',
    effect: 'destructive',
    idempotent: true,
  })
  .cli({ command: 'secrets delete', description: 'Delete a secret' })
  .handler(async ({ env, ctx, input, fail }) => {
    const { projectId, name } = input;
    if (!secretName.test(name)) {
      return fail('INVALID_NAME');
    }
    const result = await withProjectSecretUpdate(ctx, projectId, async (db, { project }) => {
      await deleteProjectSecret(db, projectId, name);
      if (project.active_deployment_id) {
        const namespace = env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
        const worker = getProjectDeploymentWorkerName(project.slug, project.active_deployment_id);
        try {
          await deleteWorkerSecret(env, namespace, worker, name);
        } catch (error) {
          return {
            code: 'PROPAGATION_FAILED',
            message: `secret deleted from storage but live propagation failed: ${error instanceof Error ? error.message : String(error)}`,
          } as const;
        }
      }
      return { ok: true, name } as const;
    });
    return isRefusal(result) ? fail(result.code, result.message) : result;
  });
