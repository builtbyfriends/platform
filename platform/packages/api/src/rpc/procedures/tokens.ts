import { type } from 'arktype';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  PROJECT_CREDENTIAL_MAX_DAYS,
  signProjectCredentialToken,
} from '../../auth/deploy-token.ts';
import type { DbOrTx } from '../../db.ts';
import { PROJECT_PERMISSION_MESSAGES } from '../../project-access.ts';
import { projectDeployCredentials, projects } from '../../schema.ts';
import type { Project } from '../../types.ts';
import { canOnProject } from '../access.ts';
import { member, procedure } from '../procedure.ts';

const ERRORS = {
  INVALID_NAME: { status: 400, message: 'name must contain 1 to 80 printable characters' },
  INVALID_EXPIRY: {
    status: 400,
    message: `expiresInDays must be an integer from 1 to ${PROJECT_CREDENTIAL_MAX_DAYS}`,
  },
  PROJECT_NOT_FOUND: { status: 404, message: PROJECT_PERMISSION_MESSAGES['not-found'] },
  PROJECT_DELETING: {
    status: 409,
    message:
      'This project is being deleted. Wait for deletion to finish and select another project.',
  },
  CREDENTIAL_NOT_FOUND: {
    status: 404,
    message:
      'This active deploy token could not be found. Refresh the token list; it may have been revoked or renewed.',
  },
  OWNER_ONLY: { status: 403, message: PROJECT_PERMISSION_MESSAGES.tokens },
} as const;

const credential = type({
  id: 'string',
  name: 'string',
  createdAt: 'string',
  expiresAt: 'string',
  revokedAt: 'string | null',
});
const issued = type({ '...': credential, token: 'string' });

function publicCredential(row: typeof projectDeployCredentials.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
  };
}

function validExpiryDays(value: number | undefined): number | null {
  const days = value ?? 30;
  return Number.isInteger(days) && days >= 1 && days <= PROJECT_CREDENTIAL_MAX_DAYS ? days : null;
}

function validName(value: string | undefined): string | null {
  const name = value === undefined ? 'CI deploy' : value.trim();
  // eslint-disable-next-line no-control-regex -- Names are shown in terminals and must exclude control characters.
  return !name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) ? null : name;
}

async function lockOwnedProject(
  db: DbOrTx,
  projectId: string,
  userId: string,
): Promise<Project | 'forbidden' | null> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .for('update')
    .limit(1);
  if (!project) {
    return null;
  }
  return project.user_id === userId ? project : 'forbidden';
}

/** Only the owner manages deploy tokens. `delete` is the capability only the owner holds. */
const ownerOnly = { policy: 'project-owner', check: canOnProject('delete') } as const;
const projectInput = type({ projectId: 'string' });

export const list = procedure('tokens.list')
  .use(member)
  .input(projectInput)
  .authz(ownerOnly)
  .output(credential.array())
  .noErrors({ reason: 'A project with no tokens returns an empty list' })
  .noMcp({ reason: 'Agents must not read or mint the credentials that deploy their project' })
  .cli({ command: 'token list', description: 'List project deploy tokens' })
  .handler(async ({ ctx, input }) => {
    const rows = await ctx.db
      .select()
      .from(projectDeployCredentials)
      .where(eq(projectDeployCredentials.project_id, input.projectId))
      .orderBy(desc(projectDeployCredentials.created_at))
      .limit(100);
    return rows.map(publicCredential);
  });

export const create = procedure('tokens.create')
  .use(member)
  .input(type({ projectId: 'string', 'name?': 'string', 'expiresInDays?': 'number' }))
  .authz(ownerOnly)
  .output(issued)
  .errors(ERRORS)
  .noMcp({ reason: 'Agents must not read or mint the credentials that deploy their project' })
  .cli({ command: 'token create', description: 'Create a project deploy token' })
  .handler(async ({ env, ctx, input, fail }) => {
    const name = validName(input.name);
    if (name === null) {
      return fail('INVALID_NAME');
    }
    const days = validExpiryDays(input.expiresInDays);
    if (days === null) {
      return fail('INVALID_EXPIRY');
    }
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const token = await signProjectCredentialToken(
      {
        credentialId: id,
        projectId: input.projectId,
        userId: ctx.user.id,
        login: ctx.user.login,
        expiresAt,
      },
      env.JWT_SECRET,
    );
    const row = await ctx.db.transaction(async (tx) => {
      const project = await lockOwnedProject(tx, input.projectId, ctx.user.id);
      if (typeof project === 'string' || !project) {
        return project;
      }
      if (project.status === 'deleting') {
        return 'project-deleting' as const;
      }
      const [created] = await tx
        .insert(projectDeployCredentials)
        .values({
          id,
          project_id: project.id,
          issued_by: ctx.user.id,
          name,
          expires_at: expiresAt.toISOString(),
        })
        .returning();
      return created;
    });
    if (row === 'forbidden') {
      return fail('OWNER_ONLY');
    }
    if (row === 'project-deleting') {
      return fail('PROJECT_DELETING');
    }
    if (!row) {
      return fail('PROJECT_NOT_FOUND');
    }
    return { ...publicCredential(row), token };
  });

export const renew = procedure('tokens.renew')
  .use(member)
  .input(type({ projectId: 'string', credentialId: 'string', 'expiresInDays?': 'number' }))
  .authz(ownerOnly)
  .output(issued)
  .errors(ERRORS)
  .noMcp({ reason: 'Agents must not read or mint the credentials that deploy their project' })
  .cli({ command: 'token renew', description: 'Replace a deploy token with a fresh one' })
  .handler(async ({ env, ctx, input, fail }) => {
    const days = validExpiryDays(input.expiresInDays);
    if (days === null) {
      return fail('INVALID_EXPIRY');
    }
    const replacementId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const token = await signProjectCredentialToken(
      {
        credentialId: replacementId,
        projectId: input.projectId,
        userId: ctx.user.id,
        login: ctx.user.login,
        expiresAt,
      },
      env.JWT_SECRET,
    );
    const result = await ctx.db.transaction(async (tx) => {
      const project = await lockOwnedProject(tx, input.projectId, ctx.user.id);
      if (project === 'forbidden') {
        return project;
      }
      if (!project) {
        return 'project-not-found' as const;
      }
      if (project.status === 'deleting') {
        return 'project-deleting' as const;
      }
      const [current] = await tx
        .select()
        .from(projectDeployCredentials)
        .where(
          and(
            eq(projectDeployCredentials.id, input.credentialId),
            eq(projectDeployCredentials.project_id, project.id),
            isNull(projectDeployCredentials.revoked_at),
          ),
        )
        .for('update');
      if (!current) {
        return null;
      }
      await tx
        .update(projectDeployCredentials)
        .set({ revoked_at: new Date().toISOString() })
        .where(eq(projectDeployCredentials.id, current.id));
      const [replacement] = await tx
        .insert(projectDeployCredentials)
        .values({
          id: replacementId,
          project_id: project.id,
          issued_by: ctx.user.id,
          name: current.name,
          expires_at: expiresAt.toISOString(),
        })
        .returning();
      return replacement;
    });
    if (result === 'project-not-found') {
      return fail('PROJECT_NOT_FOUND');
    }
    if (result === 'forbidden') {
      return fail('OWNER_ONLY');
    }
    if (result === 'project-deleting') {
      return fail('PROJECT_DELETING');
    }
    if (!result) {
      return fail('CREDENTIAL_NOT_FOUND');
    }
    return { ...publicCredential(result), token };
  });

export const revoke = procedure('tokens.revoke')
  .use(member)
  .input(type({ projectId: 'string', credentialId: 'string' }))
  .authz(ownerOnly)
  .output(type({ ok: 'true', id: 'string' }))
  .errors(ERRORS)
  .noMcp({ reason: 'Agents must not read or mint the credentials that deploy their project' })
  .cli({ command: 'token revoke', description: 'Revoke a project deploy token' })
  .handler(async ({ ctx, input, fail }) => {
    const row = await ctx.db.transaction(async (tx) => {
      const project = await lockOwnedProject(tx, input.projectId, ctx.user.id);
      if (typeof project === 'string') {
        return project;
      }
      if (!project) {
        return 'project-not-found' as const;
      }
      const [revoked] = await tx
        .update(projectDeployCredentials)
        .set({ revoked_at: new Date().toISOString() })
        .where(
          and(
            eq(projectDeployCredentials.id, input.credentialId),
            eq(projectDeployCredentials.project_id, project.id),
            isNull(projectDeployCredentials.revoked_at),
          ),
        )
        .returning();
      return revoked ?? null;
    });
    if (row === 'project-not-found') {
      return fail('PROJECT_NOT_FOUND');
    }
    if (row === 'forbidden') {
      return fail('OWNER_ONLY');
    }
    if (!row) {
      return fail('CREDENTIAL_NOT_FOUND');
    }
    return { ok: true, id: row.id } as const;
  });
