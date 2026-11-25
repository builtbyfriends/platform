import { type } from 'arktype';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getProjectResources } from '../db/resources.ts';
import type { ApiEnv } from '../env.ts';
import { catalogPage, cloudflareCatalog } from '../infrastructure/cloudflare-catalog.ts';
import type { Project, Resource } from '../types.ts';
import { resourceCapabilities } from './app-runtime-capabilities.ts';
import { fileOwnerActive } from './app-runtime-files.ts';
import type { ResolveProject } from './app-runtime.ts';

const products = {
  d1: 'd1',
  kv: 'kv',
  r2: 'r2',
  queue: 'queues',
  hyperdrive: 'hyperdrive',
  container: 'containers',
  'durable-object': 'durable-objects',
} satisfies { [Type in Resource['type']]: string };

const identifier = type('string > 0').atMostLength(200);

const owner = type({ person: identifier.narrow((value) => !value.startsWith('group:')) })
  .or({ group: identifier })
  .onUndeclaredKey('reject');

const requestSchema = type({
  project: identifier,
  owner,
  'resourceId?': identifier,
  'product?': type('string > 0')
    .atMostLength(100)
    .narrow((value) => /^[a-z][a-z0-9-]*$/.test(value)),
  'cursor?': type('string > 0').atMostLength(2048),
  'limit?': type('number.integer').atLeast(1).atMost(50),
}).onUndeclaredKey('reject');

function selectResources(
  resources: ReadonlyArray<Resource>,
  request: typeof requestSchema.infer,
):
  | { resources: ReadonlyArray<Resource>; product: string | null }
  | { error: 'unknown_resource' | 'resource_product_mismatch'; status: 400 | 404 } {
  const selected =
    request.resourceId === undefined
      ? resources
      : resources.filter((entry) => entry.id === request.resourceId);

  if (request.resourceId !== undefined && !selected.length) {
    return { error: 'unknown_resource', status: 404 };
  }

  const resourceProduct = request.resourceId === undefined ? null : products[selected[0].type];

  if (request.product !== undefined && resourceProduct && request.product !== resourceProduct) {
    return { error: 'resource_product_mismatch', status: 400 };
  }

  return { resources: selected, product: resourceProduct ?? request.product ?? null };
}

function sameProject(current: Project | null, previous: Project): current is Project {
  return (
    current !== null &&
    current.user_id === previous.user_id &&
    current.active_deployment_id === previous.active_deployment_id &&
    current.proxy_token_gen === previous.proxy_token_gen
  );
}

export function appRuntimeCatalogRoutes(resolve: ResolveProject) {
  return new Hono<ApiEnv>().post(
    '/projects.capabilities',
    bodyLimit({ maxSize: 8192 }),
    async (context) => {
      const body = requestSchema(await context.req.json().catch(() => null));

      if (body instanceof type.errors) {
        return context.json({ error: 'invalid_catalog_request' }, 400);
      }

      const owner = body.owner;

      const project = await resolve(context, body.project, owner);

      if (!project) {
        return context.json({ error: 'unknown_project' }, 404);
      }

      const resources = await getProjectResources(context.get('db'), project.id);

      const selection = selectResources(resources, body);

      if ('error' in selection) {
        return context.json({ error: selection.error }, selection.status);
      }

      const { resources: selected, product } = selection;
      const filesActive = await fileOwnerActive(context.get('db'), project);
      const catalog = await cloudflareCatalog();

      if (
        product &&
        !catalog.operations.some((entry) => entry.command.startsWith(`cf ${product} `))
      ) {
        return context.json({ error: 'unknown_product' }, 400);
      }

      const current = await resolve(context, project.id, owner);
      const fresh = await getProjectResources(context.get('db'), project.id);

      if (!sameProject(current, project)) {
        return context.json({ error: 'unknown_project' }, 404);
      }

      if (
        selected.some(
          (entry) =>
            !fresh.some(
              (value) =>
                value.id === entry.id &&
                value.cf_id === entry.cf_id &&
                value.type === entry.type &&
                value.binding_name === entry.binding_name,
            ),
        )
      ) {
        return context.json({ error: 'resource_changed' }, 409);
      }

      try {
        const page = catalogPage(
          catalog,
          {
            appId: project.id,
            resourceId: body.resourceId ?? null,
            product,
          },
          body.limit ?? 10,
          body.cursor,
        );

        const capable = selected.filter((entry) => !product || products[entry.type] === product);

        return context.json({
          data: {
            appId: project.id,
            checkedAt: Date.now(),
            available: true,
            reason: null,
            ...page,
            capabilitiesTruncated: capable.length > 50,
            capabilities: capable
              .slice(0, 50)
              .map((entry) => resourceCapabilities(context, current, entry, filesActive)),
          },
        });
      } catch {
        return context.json({ error: 'invalid_cursor' }, 400);
      }
    },
  );
}
