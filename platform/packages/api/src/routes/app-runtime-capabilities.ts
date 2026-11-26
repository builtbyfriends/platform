import type { Context } from 'hono';
import type { ApiEnv } from '../env.ts';
import type { Project, Resource } from '../types.ts';
import { resourceActions } from './app-runtime-actions.ts';
import { databaseBrowseCapabilities } from './app-runtime-database.ts';
import { fileTransfers } from './app-runtime-files.ts';
import { keyEditorAvailable } from './app-runtime-kv.ts';
import type { RuntimeResourceReference } from './app-runtime-resource-reference.ts';

const kinds = {
  r2: 'files',
  d1: 'database',
  kv: 'key-value',
  queue: 'queue',
  hyperdrive: 'other',
  container: 'other',
  'durable-object': 'other',
} as const satisfies { [Type in Resource['type']]: string };

export function referenceCapabilities(
  context: Context<ApiEnv>,
  project: Project,
  reference: RuntimeResourceReference,
  filesActive: boolean,
  current: Project = project,
) {
  return reference.source === 'resources'
    ? resourceCapabilities(context, project, reference.resource, filesActive, current)
    : { id: reference.id, name: reference.name, kind: 'other', browse: null, actions: [] };
}

export function resourceCapabilities(
  context: Context<ApiEnv>,
  project: Project,
  resource: Resource,
  filesActive: boolean,
  current: Project = project,
) {
  return {
    id: resource.id,
    name: resource.binding_name,
    kind: kinds[resource.type],
    browse: resource.type === 'r2' ? 'files' : resource.type === 'd1' ? 'tables' : null,
    fileTransfers: fileTransfers(context.env, project, resource, filesActive),
    actions: (
      resource.type === 'queue'
        ? !!context.env.CF_ACCOUNT_ID &&
          !!context.env.CF_API_TOKEN &&
          !project.preview_client_id &&
          !!project.active_deployment_id
        : !!context.env.PLATFORM_PROXY ||
          (filesActive && keyEditorAvailable(context.env, current, resource))
    )
      ? resourceActions(
          resource,
          filesActive && keyEditorAvailable(context.env, current, resource),
        ).filter(
          (action) =>
            resource.type !== 'kv' ||
            !!context.env.PLATFORM_PROXY ||
            action.id === 'keys.inspect' ||
            action.id === 'keys.save',
        )
      : [],
    browseCapabilities:
      resource.type === 'd1' && context.env.PLATFORM_PROXY ? databaseBrowseCapabilities : undefined,
  };
}
