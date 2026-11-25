import { type } from 'arktype';
import type { ApiEnv } from '../env.ts';
import { cfFetch, CF_API_BASE } from '../provisioning/cloudflare-api.ts';
import type { Project, Resource } from '../types.ts';

export const connectionAction = {
  id: 'database.connection',
  label: 'View connection',
  effect: 'read' as const,
  fields: [],
  view: { scope: 'resource' as const, label: 'Overview' },
  result: 'records' as const,
};

const plainText = type('string > 0').narrow(
  (value) => value.trim().length > 0 && !/\p{Cc}/u.test(value),
);

const connectionConfig = type({
  id: 'string',
  origin: type({
    scheme: "'postgres' | 'postgresql' | 'mysql'",
    database: plainText.atMostLength(2048).narrow((value) => !value.includes('://')),
    'host?': plainText.atMostLength(253).narrow((value) => /^[\w.:[\]-]+$/.test(value)),
    'port?': '1 <= number.integer <= 65535',
    'service_id?': plainText.atMostLength(2048),
  }).narrow((origin) => origin.host !== undefined || origin.service_id !== undefined),
  caching: { disabled: 'boolean' },
});

const unavailable = (reason: string) => ({ kind: 'unavailable' as const, reason });

export async function databaseConnection(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
) {
  if (project.preview_client_id) {
    return unavailable('Connection details are available for published apps.');
  }

  if (!project.active_deployment_id) {
    return unavailable('Publish this app to inspect its database connection.');
  }

  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    return unavailable('Connection inspection is not enabled on this installation.');
  }

  if (
    resource.type !== 'hyperdrive' ||
    resource.project_id !== project.id ||
    !/^[a-f0-9]{32}$/i.test(resource.cf_id)
  ) {
    return unavailable('This database connection cannot be inspected.');
  }

  try {
    const value = await cfFetch<unknown>(
      `${CF_API_BASE}/${encodeURIComponent(env.CF_ACCOUNT_ID)}/hyperdrive/configs/${resource.cf_id}`,
      env.CF_API_TOKEN,
      { signal: AbortSignal.timeout(5000) },
    );

    const config = connectionConfig(value);

    if (config instanceof type.errors || config.id !== resource.cf_id) {
      throw Error('Invalid connection configuration.');
    }

    const origin = config.origin;

    return {
      kind: 'records' as const,
      checkedAt: Date.now(),
      columns: [
        { id: 'property', label: 'Property' },
        { id: 'value', label: 'Value' },
      ],
      rows: [
        { id: 'engine', cells: ['Engine', origin.scheme === 'mysql' ? 'MySQL' : 'PostgreSQL'] },
        { id: 'database', cells: ['Database', origin.database] },
        { id: 'host', cells: ['Host', origin.host ?? null] },
        {
          id: 'port',
          cells: ['Port', origin.port === undefined ? null : String(origin.port)],
        },
        { id: 'cache', cells: ['Query cache', config.caching.disabled ? 'Disabled' : 'Enabled'] },
        {
          id: 'scope',
          cells: ['Reading', 'Configuration only; connection health has not been checked.'],
        },
      ],
      truncated: false,
    };
  } catch {
    return unavailable('Could not read the database connection. Refresh and try again.');
  }
}
