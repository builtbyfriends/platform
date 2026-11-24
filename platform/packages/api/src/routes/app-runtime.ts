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
import { deriveProxyToken } from '../proxy-token.ts';
import type { Project, Resource } from '../types.ts';

export type RuntimeOwner = { group: string } | { person: string };
type ResolveProject = (
  context: Context<ApiEnv>,
  id: unknown,
  owner: RuntimeOwner,
) => Promise<Project | null>;
const text = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const optionalText = (value: unknown, max: number) =>
  value === undefined || (typeof value === 'string' && value.length <= max);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const secretColumn =
  /password|secret|token|credential|private.?key|verification.?code|api[_-]?key|access[_-]?key/i;
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

async function proxyRead(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  path: '/r2/list' | '/d1/query',
  input: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    sql?: string;
    params?: Array<string | number>;
    method?: 'all';
  },
) {
  if (!env.PLATFORM_PROXY) {
    throw new Error('Storage inspection is not connected on this installation.');
  }
  const response = await env.PLATFORM_PROXY.fetch(`https://proxy${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      ...input,
      projectId: project.id,
      binding: resource.binding_name,
      aiToken: await deriveProxyToken(env.JWT_SECRET, project.id, project.proxy_token_gen),
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error('Could not read this resource. Try again.');
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        throw new Error('Invalid response stream.');
      }
      size += value.length;
      if (size > 512 * 1024) {
        throw new Error('This page is too large to inspect.');
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(value)) {
    throw new Error('Invalid storage response.');
  }
  return value;
}

async function inspect(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  body: { prefix?: string; cursor?: string; table?: string; offset?: number },
) {
  const identity = { appId: project.id, resourceId: resource.id };
  if (!env.PLATFORM_PROXY) {
    return {
      ...identity,
      kind: 'unavailable' as const,
      reason: 'Storage inspection is not connected on this installation.',
    };
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
  const query = (sql: string, params: Array<string | number> = []) =>
    proxyRead(env, project, resource, '/d1/query', { sql, params, method: 'all' });
  const listed = await query(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name LIMIT 200",
  );
  if (!Array.isArray(listed.results)) {
    throw new Error('Invalid database response.');
  }
  const tables = listed.results.map((row: unknown) => {
    if (!isRecord(row) || !text(row.name)) {
      throw new Error('Invalid table metadata.');
    }
    return row.name;
  });
  if (body.table === undefined) {
    return { ...identity, kind: 'tables' as const, tables };
  }
  if (!tables.includes(body.table)) {
    throw new OperatorError(400, 'Choose a table from this database.');
  }
  const described = await query(`PRAGMA table_info(${quote(body.table)})`);
  if (!Array.isArray(described.results) || described.results.length > 100) {
    throw new Error('This table has too many columns to inspect.');
  }
  const columns = described.results.map((row: unknown) => {
    if (!isRecord(row) || !text(row.name)) {
      throw new Error('Invalid column metadata.');
    }
    return row.name;
  });
  if (!columns.length) {
    throw new Error('No columns are available for this table.');
  }
  // Decision: Fixed read queries cap cell size and redact credential columns before rows leave the database.
  const selection = columns
    .map((column) =>
      secretColumn.test(column)
        ? `'[redacted]' AS ${quote(column)}`
        : `CASE WHEN typeof(${quote(column)}) = 'blob' THEN '[binary]' WHEN typeof(${quote(column)}) = 'text' THEN substr(${quote(column)}, 1, 1000) ELSE ${quote(column)} END AS ${quote(column)}`,
    )
    .join(', ');
  const result = await query(`SELECT ${selection} FROM ${quote(body.table)} LIMIT ? OFFSET ?`, [
    pageSize + 1,
    body.offset ?? 0,
  ]);
  if (!Array.isArray(result.results)) {
    throw new Error('Invalid database rows.');
  }
  const rows = result.results.slice(0, pageSize).map((row: unknown) => {
    if (!isRecord(row)) {
      throw new Error('Invalid database row.');
    }
    return columns.map((column) => {
      const cell = row[column];
      return typeof cell === 'string'
        ? cell.slice(0, 1000)
        : (typeof cell === 'number' && Number.isFinite(cell)) || typeof cell === 'boolean'
          ? cell
          : null;
    });
  });
  return {
    ...identity,
    kind: 'rows' as const,
    table: body.table,
    columns,
    rows,
    nextOffset:
      result.results.length > pageSize && (body.offset ?? 0) < 10_000
        ? (body.offset ?? 0) + pageSize
        : null,
  };
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
function requestAddress(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 1000);
  } catch {
    return value.split(/[?#]/)[0]?.slice(0, 1000) ?? '';
  }
}

export function appRuntimeRoutes(resolveProject: ResolveProject) {
  const app = new Hono<ApiEnv>();
  const boundedBody = bodyLimit({ maxSize: 8192 });
  app.post('/projects.resources', boundedBody, async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const owner = runtimeOwner(isRecord(body) ? body.owner : undefined);
    if (!isRecord(body) || !owner) {
      return context.json({ error: 'invalid_owner' }, 400);
    }
    const project = await resolveProject(context, body.project, owner);
    if (!project) {
      return context.json({ error: 'unknown_project' }, 404);
    }
    const resources = await getProjectResources(context.get('db'), project.id);
    const current = await resolveProject(context, project.id, owner);
    if (!current || current.user_id !== project.user_id) {
      return context.json({ error: 'unknown_project' }, 404);
    }
    return context.json({
      data: {
        checkedAt: Date.now(),
        appId: project.id,
        available: true,
        resources: resources.map((resource) => ({
          id: resource.id,
          name: resource.binding_name,
          kind:
            resource.type === 'r2'
              ? 'files'
              : resource.type === 'd1'
                ? 'database'
                : resource.type === 'kv'
                  ? 'key-value'
                  : resource.type === 'queue'
                    ? 'queue'
                    : 'other',
          browse: resource.type === 'r2' ? 'files' : resource.type === 'd1' ? 'tables' : null,
        })),
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
  app.post('/projects.activity', boundedBody, async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    if (!isRecord(body) || !optionalText(body.cursor, 4096)) {
      return context.json({ error: 'invalid_activity' }, 400);
    }
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
      scope: 'app' as const,
      partial: context.env.PLATFORM_RUNTIME_LOGS === 'minimal',
    };
    if (!project.active_deployment_id || isDevBypass(context.env)) {
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
          order: 'newest-first',
          cursor: typeof body.cursor === 'string' ? body.cursor : undefined,
        },
      );
      const current = await resolveProject(context, project.id, owner);
      if (
        !current ||
        current.user_id !== project.user_id ||
        current.active_deployment_id !== project.active_deployment_id
      ) {
        return context.json({ error: 'deployment_changed' }, 409);
      }
      const events = result.data.map((row, index) => {
        const messages = [...row.exceptions, ...row.logs].flatMap((value) => {
          const message = logMessage(value);
          return message ? [message] : [];
        });
        const error =
          row.outcome !== 'ok' ||
          row.exceptions.length > 0 ||
          Number(row.status) >= 500 ||
          row.logs.some((log) => isRecord(log) && log.level === 'error');
        const warn = row.logs.some((log) => isRecord(log) && log.level === 'warn');
        return {
          id: `${project.active_deployment_id}:${row.timestamp}:${index}`,
          timestamp: row.timestamp,
          level: error ? 'error' : warn ? 'warn' : 'info',
          message: (messages.join('\n') || `Request finished: ${row.outcome}`).slice(0, 8000),
          request: {
            method: row.method,
            url: requestAddress(row.url),
            status: Number(row.status) || 0,
          },
        };
      });
      return context.json({
        data: { ...base, available: true, events, cursor: result.nextCursor },
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
