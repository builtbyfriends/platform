import type { Context } from 'hono';
import { getProjectResources } from '../db/resources.ts';
import type { ApiEnv } from '../env.ts';
import type { Project, Resource } from '../types.ts';
import { resolveOwnedDurableObjectNamespace } from './app-runtime-bindings.ts';
import { fileOwnerActive } from './app-runtime-files.ts';
import type { ResolveProject, RuntimeOwner } from './app-runtime.ts';

export function sameResourceIdentity(current: Resource, previous: Resource): boolean {
  return (
    current.id === previous.id &&
    current.project_id === previous.project_id &&
    current.type === previous.type &&
    current.cf_id === previous.cf_id &&
    current.binding_name === previous.binding_name &&
    current.metadata.jurisdiction === previous.metadata.jurisdiction &&
    current.metadata.namespaceId === previous.metadata.namespaceId &&
    current.metadata.dispatchNamespace === previous.metadata.dispatchNamespace
  );
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
