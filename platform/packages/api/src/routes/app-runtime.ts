import { isRecord } from '@builtbyfriends/deploy-core';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getDeployment } from '../db/deployments.ts';
import { getProjectResources } from '../db/resources.ts';
import { isDevBypass } from '../env.ts';
import type { ApiEnv } from '../env.ts';
import { OperatorError } from '../operator/common.ts';
import { deploymentLogs } from '../operator/deployment-operations.ts';
import type { Project, Resource } from '../types.ts';
import { actionInput, executeResourceAction } from './app-runtime-actions.ts';
import { observeResourceBindings } from './app-runtime-bindings.ts';
import { resourceCapabilities } from './app-runtime-capabilities.ts';
import { appRuntimeCatalogRoutes } from './app-runtime-catalog.ts';
import { databaseInspect, validDatabaseFilter, validDatabaseSort } from './app-runtime-database.ts';
import type { DatabaseFilter, DatabaseSort } from './app-runtime-database.ts';
import { appRuntimeFileRoutes, fileOwnerActive } from './app-runtime-files.ts';
import { keyEditorAvailable } from './app-runtime-kv.ts';
import { appRuntimeOperationRoutes } from './app-runtime-operations.ts';
import { proxyRead } from './app-runtime-storage-read.ts';

export type RuntimeOwner = { group: string } | { person: string };
export type ResolveProject = (
  context: Context<ApiEnv>,
  id: unknown,
  owner: RuntimeOwner,
) => Promise<Project | null>;
const text = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const optionalText = (value: unknown, max: number) =>
  value === undefined || (typeof value === 'string' && value.length <= max);
const pageSize = 50;
function runtimeOwner(value: unknown): RuntimeOwner | null {
  if (!isRecord(value)) {
    return null;
  }
  if (text(value.group) && value.person === undefined) {
    return { group: value.group };
  }
  if (text(value.person) && !value.person.startsWith('group:') && value.group === undefined) {
    return { person: value.person };
  }
  return null;
}

async function inspect(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  body: {
    prefix?: string;
    cursor?: string;
    table?: string;
    offset?: number;
    filter?: DatabaseFilter;
    sort?: DatabaseSort;
  },
) {
  const identity = { appId: project.id, resourceId: resource.id };
  if (!env.PLATFORM_PROXY) {
    return {
      ...identity,
      kind: 'unavailable' as const,
      reason: 'Storage inspection is not connected on this installation.',
    };
  }
  if (resource.type !== 'd1' && (body.filter || body.sort)) {
    throw new OperatorError(400, 'Filtering and sorting require a database table.');
  }
  if (resource.type === 'r2') {
    const result = await proxyRead(env, project, resource, '/r2/list', {
      prefix: body.prefix,
      cursor: body.cursor,
      limit: pageSize,
    });
    if (!Array.isArray(result.objects)) {
      throw new Error('Invalid file list.');
    }
    const objects = result.objects.slice(0, pageSize).map((entry: unknown) => {
      if (
        !isRecord(entry) ||
        !text(entry.key, 1024) ||
        typeof entry.size !== 'number' ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0
      ) {
        throw new Error('Invalid file metadata.');
      }
      return {
        key: entry.key,
        size: entry.size,
        modifiedAt: text(entry.lastModified, 100) ? entry.lastModified : null,
      };
    });
    return {
      ...identity,
      kind: 'files' as const,
      objects,
      cursor: result.truncated === true && text(result.cursor, 4096) ? result.cursor : null,
    };
  }
  if (resource.type !== 'd1') {
    return {
      ...identity,
      kind: 'unavailable' as const,
      reason: 'This resource does not support data browsing yet.',
    };
  }
  return { ...identity, ...(await databaseInspect(env, project, resource, body)) };
}

function logMessage(value: unknown): string {
  if (typeof value === 'string') {
    return value.slice(0, 4000);
  }
  if (!isRecord(value)) {
    return '';
  }
  const message =
    typeof value.message === 'string'
      ? value.message
      : Array.isArray(value.message)
        ? value.message
            .map((entry: unknown) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
            .join(' ')
        : '';
  return [
    typeof value.name === 'string' ? value.name : '',
    message,
    typeof value.stack === 'string' ? value.stack : '',
  ]
    .filter(Boolean)
    .join(': ')
    .slice(0, 4000);
}
function platformRequest(value: string) {
  try {
    const url = new URL(value);
    if (url.hostname !== 'worker' && url.hostname !== 'internal') {
      return undefined;
    }
    // Decision: These relay routes run customer code; other platform requests are housekeeping.
    if (url.pathname === '/__platform/queue' || url.pathname === '/__queue') {
      return 'Background job';
    }
    if (url.pathname === '/__platform/scheduled' || url.pathname === '/__scheduled') {
      return 'Scheduled task';
    }
    return url.pathname === '/__platform' || url.pathname.startsWith('/__platform/')
      ? 'control'
      : undefined;
  } catch {
    return undefined;
  }
}

function requestAddress(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 1000);
  } catch {
    return value.split(/[?#]/)[0]?.slice(0, 1000) ?? '';
  }
}

export function appRuntimeRoutes(resolve: ResolveProject) {
  const resolveProject: ResolveProject = async (context, id, owner) => {
    const project = await resolve(context, id, owner);
    if (
      project?.preview_client_id &&
      (project.preview_client_id !== context.get('billingClient') ||
        project.status !== 'active' ||
        !(Date.parse(project.preview_expires_at ?? '') > Date.now()))
    ) {
      return null;
    }
    return project;
  };
  const app = new Hono<ApiEnv>()
    .route('/', appRuntimeFileRoutes(resolveProject))
    .route('/', appRuntimeCatalogRoutes(resolveProject))
    .route('/', appRuntimeOperationRoutes(resolveProject));
  const boundedBody = bodyLimit({ maxSize: 8192 });
  app.post('/projects.resources', boundedBody, async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const owner = runtimeOwner(isRecord(body) ? body.owner : undefined);
    if (
      !isRecord(body) ||
      !owner ||
      (body.includeBindings !== undefined && typeof body.includeBindings !== 'boolean')
    ) {
      return context.json({ error: 'invalid_owner' }, 400);
    }
    const project = await resolveProject(context, body.project, owner);
    if (!project) {
      return context.json({ error: 'unknown_project' }, 404);
    }
    const resources = await getProjectResources(context.get('db'), project.id);
    const filesActive = await fileOwnerActive(context.get('db'), project);
    const topology =
      body.includeBindings === true
        ? await observeResourceBindings(context.env, context.get('db'), project, resources, () =>
            resolveProject(context, project.id, owner),
          )
        : undefined;
    const current = await resolveProject(context, project.id, owner);
    if (!current || current.user_id !== project.user_id) {
      return context.json({ error: 'unknown_project' }, 404);
    }
    if (
      topology?.status === 'verified' &&
      (current.active_deployment_id !== project.active_deployment_id ||
        current.proxy_token_gen !== project.proxy_token_gen ||
        current.status !== project.status)
    ) {
      return context.json({ error: 'deployment_changed' }, 409);
    }
    return context.json({
      data: {
        checkedAt: Date.now(),
        appId: project.id,
        available: true,
        ...(topology && { topology }),
        resources: resources.map((resource) =>
          resourceCapabilities(context, project, resource, filesActive, current),
        ),
      },
    });
  });
  app.post('/resources.inspect', boundedBody, async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    if (
      !isRecord(body) ||
      !text(body.resourceId) ||
      !optionalText(body.prefix, 1024) ||
      !optionalText(body.cursor, 4096) ||
      !optionalText(body.table, 200) ||
      (body.filter !== undefined && !validDatabaseFilter(body.filter)) ||
      (body.sort !== undefined && !validDatabaseSort(body.sort)) ||
      (body.offset !== undefined &&
        (!Number.isSafeInteger(body.offset) ||
          Number(body.offset) < 0 ||
          Number(body.offset) > 10_000))
    ) {
      return context.json({ error: 'invalid_inspection' }, 400);
    }
    const owner = runtimeOwner(body.owner);
    if (!owner) {
      return context.json({ error: 'invalid_owner' }, 400);
    }
    const project = await resolveProject(context, body.project, owner);
    if (!project) {
      return context.json({ error: 'unknown_project' }, 404);
    }
    const resource = (await getProjectResources(context.get('db'), project.id)).find(
      (entry) => entry.id === body.resourceId,
    );
    if (!resource) {
      return context.json({ error: 'unknown_resource' }, 404);
    }
    try {
      const data = await inspect(context.env, project, resource, {
        prefix: typeof body.prefix === 'string' ? body.prefix : undefined,
        cursor: typeof body.cursor === 'string' ? body.cursor : undefined,
        table: typeof body.table === 'string' ? body.table : undefined,
        offset: typeof body.offset === 'number' ? body.offset : undefined,
        filter: validDatabaseFilter(body.filter) ? body.filter : undefined,
        sort: validDatabaseSort(body.sort) ? body.sort : undefined,
      });
      const current = await resolveProject(context, project.id, owner);
      const currentResource = (await getProjectResources(context.get('db'), project.id)).find(
        (entry) => entry.id === resource.id,
      );
      if (
        !current ||
        current.user_id !== project.user_id ||
        current.proxy_token_gen !== project.proxy_token_gen ||
        current.active_deployment_id !== project.active_deployment_id ||
        currentResource?.cf_id !== resource.cf_id ||
        currentResource?.binding_name !== resource.binding_name
      ) {
        return context.json({ error: 'resource_changed' }, 409);
      }
      return context.json({ data });
    } catch (error) {
      if (error instanceof OperatorError) {
        return context.json({ error: 'invalid_inspection', message: error.message }, 400);
      }
      return context.json({
        data: {
          kind: 'unavailable',
          appId: project.id,
          resourceId: resource.id,
          reason: 'Could not read this resource. Refresh and try again.',
        },
      });
    }
  });
  app.post('/resources.execute', bodyLimit({ maxSize: 820_000 }), async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    if (!isRecord(body) || !text(body.resourceId) || !text(body.action)) {
      return context.json({ error: 'invalid_action' }, 400);
    }
    const input = actionInput(body.action, body.input);
    if (!input) {
      return context.json({ error: 'invalid_action' }, 400);
    }
    const owner = runtimeOwner(body.owner);
    if (!owner) {
      return context.json({ error: 'invalid_owner' }, 400);
    }
    const project = await resolveProject(context, body.project, owner);
    if (!project) {
      return context.json({ error: 'unknown_project' }, 404);
    }
    const resource = (await getProjectResources(context.get('db'), project.id)).find(
      (entry) => entry.id === body.resourceId,
    );
    if (!resource) {
      return context.json({ error: 'unknown_resource' }, 404);
    }
    const keyAction = body.action === 'keys.inspect' || body.action === 'keys.save';
    const stillAuthorized = async () => {
      const current = await resolveProject(context, project.id, owner);
      const currentResource = (await getProjectResources(context.get('db'), project.id)).find(
        (entry) => entry.id === resource.id,
      );
      return Boolean(
        current &&
        (!keyAction ||
          (keyEditorAvailable(context.env, current, resource) &&
            (await fileOwnerActive(context.get('db'), current)))) &&
        current.user_id === project.user_id &&
        current.proxy_token_gen === project.proxy_token_gen &&
        current.active_deployment_id === project.active_deployment_id &&
        currentResource?.cf_id === resource.cf_id &&
        currentResource.type === resource.type &&
        currentResource?.binding_name === resource.binding_name,
      );
    };
    const keyWrite = body.action === 'keys.save';
    const cellWrite = body.action === 'database.cell.save';
    const queueWrite = body.action === 'queue.pause' || body.action === 'queue.resume';
    try {
      const data = await executeResourceAction(
        context.env,
        project,
        resource,
        body.action,
        input,
        stillAuthorized,
      );
      if (
        (queueWrite || keyAction || cellWrite) &&
        (data.kind === 'unavailable' || data.kind === 'conflict' || data.kind === 'unknown')
      ) {
        return context.json({ data });
      }
      if (!(await stillAuthorized())) {
        if (body.action === 'files.saveText' || queueWrite || keyWrite || cellWrite) {
          return context.json({
            data: {
              appId: project.id,
              resourceId: resource.id,
              action: body.action,
              kind: 'unknown',
              reason: cellWrite
                ? 'The save could not be confirmed. Read the latest value before making another change.'
                : keyWrite
                  ? 'The key update could not be confirmed. Wait, then open it before making another change.'
                  : queueWrite
                    ? 'The app connection changed while updating delivery. Refresh queue status before making another change.'
                    : 'This resource changed during the save. Open it again to check the result.',
            },
          });
        }
        return context.json({ error: 'resource_changed' }, 409);
      }
      return context.json({ data });
    } catch {
      return context.json({
        data: {
          appId: project.id,
          resourceId: resource.id,
          action: body.action,
          kind:
            body.action === 'files.saveText' || queueWrite || keyWrite || cellWrite
              ? 'unknown'
              : 'unavailable',
          reason: cellWrite
            ? 'The save could not be confirmed. Read the latest value before making another change.'
            : keyWrite
              ? 'The key update could not be confirmed. Wait, then open it before making another change.'
              : queueWrite
                ? 'The delivery change could not be confirmed. Refresh queue status before making another change.'
                : body.action === 'files.saveText'
                  ? 'The save could not be confirmed. Open the file again to check the result.'
                  : body.action === 'queue.status'
                    ? 'Could not verify queue status. Refresh and try again.'
                    : body.action === 'database.schema' || body.action === 'database.indexes'
                      ? 'Could not read this table structure. Refresh the table list and try again.'
                      : 'Could not open this value. It may be unavailable, binary, or larger than 64 KiB.',
        },
      });
    }
  });
  app.post('/projects.activity', boundedBody, async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    if (
      !isRecord(body) ||
      !optionalText(body.cursor, 4096) ||
      (body.range !== undefined &&
        body.range !== '1h' &&
        body.range !== '24h' &&
        body.range !== '7d')
    ) {
      return context.json({ error: 'invalid_activity' }, 400);
    }
    const range = body.range ?? '1h';
    const owner = runtimeOwner(body.owner);
    if (!owner) {
      return context.json({ error: 'invalid_owner' }, 400);
    }
    const project = await resolveProject(context, body.project, owner);
    if (!project) {
      return context.json({ error: 'unknown_project' }, 404);
    }
    const base = {
      checkedAt: Date.now(),
      appId: project.id,
      range,
      deploymentId: project.active_deployment_id ?? null,
      window: null,
      previousCursor: null,
      scope: 'app' as const,
      partial: context.env.PLATFORM_RUNTIME_LOGS === 'minimal',
    };
    if (
      !project.active_deployment_id ||
      isDevBypass(context.env) ||
      !(await fileOwnerActive(context.get('db'), project))
    ) {
      return context.json({
        data: {
          ...base,
          available: false,
          reason: 'No deployed runtime logs are available for this app.',
          events: [],
          cursor: null,
        },
      });
    }
    try {
      const deployment = await getDeployment(context.get('db'), project.active_deployment_id);
      if (deployment?.project_id !== project.id) {
        throw new Error('Deployment does not belong to this app.');
      }
      const result = await deploymentLogs(
        context.get('db'),
        context.env,
        project.active_deployment_id,
        {
          limit: pageSize,
          range,
          scope: 'customer-activity-v1',
          order: 'newest-first',
          cursor: typeof body.cursor === 'string' ? body.cursor : undefined,
        },
      );
      const current = await resolveProject(context, project.id, owner);
      if (
        !current ||
        !(await fileOwnerActive(context.get('db'), current)) ||
        current.user_id !== project.user_id ||
        current.active_deployment_id !== project.active_deployment_id
      ) {
        return context.json({ error: 'deployment_changed' }, 409);
      }
      const events = result.data.flatMap((row, index) => {
        const trigger = platformRequest(row.url);
        if (trigger === 'control') {
          return [];
        }
        const messages = [...row.exceptions, ...row.logs].flatMap((value) => {
          const message = logMessage(value);
          return message ? [message] : [];
        });
        const error =
          row.outcome !== 'ok' ||
          row.exceptions.length > 0 ||
          Number(row.status) >= 500 ||
          row.logs.some((log) => isRecord(log) && log.level === 'error');
        const warn =
          Number(row.status) >= 400 ||
          row.logs.some((log) => isRecord(log) && log.level === 'warn');
        const summary =
          messages.join('\n') ||
          (Number(row.status) >= 400
            ? `Request returned HTTP ${row.status}`
            : `Request finished: ${row.outcome}`);
        return [
          {
            id: `${project.active_deployment_id}:${row.timestamp}:${index}`,
            timestamp: row.timestamp,
            level: error ? 'error' : warn ? 'warn' : 'info',
            message: (trigger ? `${trigger}: ${summary}` : summary).slice(0, 8000),
            request: trigger
              ? undefined
              : {
                  method: row.method,
                  url: requestAddress(row.url),
                  status: Number(row.status) || 0,
                },
          },
        ];
      });
      return context.json({
        data: {
          ...base,
          checkedAt: Date.now(),
          window: result.window ?? null,
          previousCursor: result.previousCursor,
          available: true,
          events,
          cursor: result.nextCursor,
        },
      });
    } catch (error) {
      if (error instanceof OperatorError && error.status === 400) {
        return context.json({ error: 'invalid_activity', message: error.message }, 400);
      }
      return context.json({
        data: {
          ...base,
          available: false,
          reason: 'Could not read runtime activity. Refresh and try again.',
          events: [],
          cursor: null,
        },
      });
    }
  });
  return app;
}
