import { and, asc, eq, sql } from 'drizzle-orm';
import { projectCredentials, projectGitHubInstallations } from '../schema.ts';
import type { ProjectCredential, ProjectGitHubInstallation } from '../types.ts';
import { type Db } from './client.ts';

export async function listProjectCredentials(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Pick<ProjectCredential, 'provider' | 'repositories' | 'updated_at'>>> {
  return db
    .select({
      provider: projectCredentials.provider,
      repositories: projectCredentials.repositories,
      updated_at: projectCredentials.updated_at,
    })
    .from(projectCredentials)
    .where(eq(projectCredentials.project_id, projectId))
    .orderBy(asc(projectCredentials.provider));
}

export async function getProjectCredential(
  db: Db,
  projectId: string,
  provider: string,
): Promise<ProjectCredential | null> {
  const [row] = await db
    .select()
    .from(projectCredentials)
    .where(
      and(eq(projectCredentials.project_id, projectId), eq(projectCredentials.provider, provider)),
    )
    .limit(1);
  return row ?? null;
}

export async function upsertProjectCredential(
  db: Db,
  input: Pick<
    ProjectCredential,
    'project_id' | 'provider' | 'ciphertext' | 'iv' | 'key_version' | 'repositories'
  >,
): Promise<void> {
  await db
    .insert(projectCredentials)
    .values(input)
    .onConflictDoUpdate({
      target: [projectCredentials.project_id, projectCredentials.provider],
      set: {
        ciphertext: input.ciphertext,
        iv: input.iv,
        key_version: input.key_version,
        repositories: input.repositories,
        updated_at: sql`now()`,
      },
    });
}

export async function deleteProjectCredential(
  db: Db,
  projectId: string,
  provider: string,
): Promise<void> {
  await db
    .delete(projectCredentials)
    .where(
      and(eq(projectCredentials.project_id, projectId), eq(projectCredentials.provider, provider)),
    );
}

export async function getProjectGitHubInstallation(
  db: Db,
  projectId: string,
  scope: string,
): Promise<ProjectGitHubInstallation | null> {
  const [row] = await db
    .select()
    .from(projectGitHubInstallations)
    .where(
      and(
        eq(projectGitHubInstallations.project_id, projectId),
        eq(projectGitHubInstallations.scope, scope),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function upsertProjectGitHubInstallation(
  db: Db,
  input: Pick<
    ProjectGitHubInstallation,
    'project_id' | 'scope' | 'installation_id' | 'account_login' | 'account_id' | 'state_nonce'
  >,
): Promise<void> {
  await db
    .insert(projectGitHubInstallations)
    .values(input)
    .onConflictDoUpdate({
      target: [projectGitHubInstallations.project_id, projectGitHubInstallations.scope],
      set: {
        installation_id: input.installation_id,
        account_login: input.account_login,
        account_id: input.account_id,
        state_nonce: input.state_nonce,
        updated_at: sql`now()`,
      },
    });
}

export async function deleteProjectGitHubInstallation(
  db: Db,
  projectId: string,
  scope: string,
): Promise<void> {
  await db
    .delete(projectGitHubInstallations)
    .where(
      and(
        eq(projectGitHubInstallations.project_id, projectId),
        eq(projectGitHubInstallations.scope, scope),
      ),
    );
}
