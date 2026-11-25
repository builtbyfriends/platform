import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  requireProjectCapability,
} from '../project-access.ts';
import type { ProjectAccess } from '../project-access.ts';
import type { ProjectCapability } from '../types.ts';
import type { Caller } from './procedure.ts';

const granted = new WeakMap<Caller, ProjectAccess>();

/**
 * An `authz` check: the caller holds `capability` on the project the input names, and their
 * credential reaches it. Scoped tokens reach only their own project; a private preview project
 * takes only preview approvals. The access it found is kept for `grantedAccess`.
 */
export function canOnProject(capability: ProjectCapability) {
  return async (caller: Caller, input: { projectId: string }): Promise<boolean> => {
    const { credential } = caller;
    if (credential.project && credential.project !== input.projectId) {
      return false;
    }
    try {
      const access = await requireProjectCapability(
        caller.db,
        input.projectId,
        caller.user.id,
        capability,
      );
      if (access.project.preview_client_id && credential.audience !== 'oauth-preview') {
        return false;
      }
      granted.set(caller, access);
      return true;
    } catch (error) {
      if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
        return false;
      }
      throw error;
    }
  };
}

/** The project, role and owner `canOnProject` just resolved for this call. */
export function grantedAccess(caller: Caller): ProjectAccess {
  const access = granted.get(caller);
  if (!access) {
    throw new Error('grantedAccess needs the canOnProject authz on the procedure');
  }
  return access;
}
