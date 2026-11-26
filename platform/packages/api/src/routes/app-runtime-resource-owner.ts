import type { Context } from 'hono';
import { getProjectResources } from '../db/resources.ts';
import type { ApiEnv } from '../env.ts';
import type { Project, Resource } from '../types.ts';
import { resolveOwnedDurableObjectNamespace } from './app-runtime-bindings.ts';
import { fileOwnerActive } from './app-runtime-files.ts';
import {
  runtimeResourceReferences,
  sameResourceIdentity,
  sameResourceReference,
  type RuntimeResourceReference,
} from './app-runtime-resource-reference.ts';
import type { ResolveProject, RuntimeOwner } from './app-runtime.ts';

export { sameResourceIdentity } from './app-runtime-resource-reference.ts';

export function ownedReferenceCaller(
  context: Context<ApiEnv>,
  project: Project,
  reference: RuntimeResourceReference,
  owner: RuntimeOwner,
  resolve: ResolveProject,
) {
  if (reference.source === 'resources') {
    return ownedResourceCaller(context, project, reference.resource, owner, resolve);
  }
  return {
    project,
    reference,
    stillAuthorized: async () => {
      const current = await resolve(context, project.id, owner);
      if (
        !current ||
        current.user_id !== project.user_id ||
        current.proxy_token_gen !== project.proxy_token_gen ||
        current.active_deployment_id !== project.active_deployment_id ||
        !(await fileOwnerActive(context.get('db'), current))
      ) {
        return false;
      }
      return (await runtimeResourceReferences(context, current.id)).some((entry) =>
        sameResourceReference(entry, reference),
      );
    },
  };
}

export function ownedResourceCaller(
  context: Context<ApiEnv>,
  project: Project,
  resource: Resource,
  owner: RuntimeOwner,
  resolve: ResolveProject,
) {
  const stillAuthorized = async () => {
    const current = await resolve(context, project.id, owner);
    if (
      !current ||
      current.user_id !== project.user_id ||
      current.proxy_token_gen !== project.proxy_token_gen ||
      current.active_deployment_id !== project.active_deployment_id ||
      !(await fileOwnerActive(context.get('db'), current))
    ) {
      return false;
    }
    const fresh = (await getProjectResources(context.get('db'), current.id)).find(
      (entry) => entry.id === resource.id,
    );
    return !!fresh && sameResourceIdentity(fresh, resource);
  };
  let namespace: string | undefined;
  const resolveProviderIdentity =
    resource.type === 'durable-object'
      ? async () => {
          if (!(await stillAuthorized())) {
            return null;
          }
          const current = await resolveOwnedDurableObjectNamespace(
            context.env,
            context.get('db'),
            project,
            resource,
            () => resolve(context, project.id, owner),
          );
          if (!current || (namespace !== undefined && namespace !== current)) {
            return null;
          }
          namespace = current;
          return current;
        }
      : undefined;
  return { project, resource, stillAuthorized, resolveProviderIdentity };
}
