import { type } from 'arktype';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ApiEnv } from '../env.ts';
import { catalogPage, cloudflareCatalog } from '../infrastructure/cloudflare-catalog.ts';
import {
  cloudflareOpenApiIndex,
  cloudflareOperationSchema,
} from '../infrastructure/cloudflare-openapi.ts';
import {
  providerPolicySelections,
  resourceOperationsFor,
} from '../infrastructure/resource-operations.ts';
import type { Project } from '../types.ts';
import { referenceCapabilities } from './app-runtime-capabilities.ts';
import { fileOwnerActive } from './app-runtime-files.ts';
import { ownedResourceCaller } from './app-runtime-resource-owner.ts';
import {
  referenceProduct,
  runtimeResourceReferences,
  sameResourceReference,
  type RuntimeResourceReference,
} from './app-runtime-resource-reference.ts';
import type { ResolveProject } from './app-runtime.ts';

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
    .narrow((value) => /^[a-z][a-z0-9_-]*$/.test(value)),
  'query?': type('string').atMostLength(200),
  'method?': "'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'TRACE'",
  'schemaSha256?': type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value)),
  'cursor?': type('string > 0').atMostLength(8192),
  'limit?': type('number.integer').atLeast(1).atMost(50),
  'operationId?': identifier,
}).onUndeclaredKey('reject');

function selectResources(
  resources: ReadonlyArray<RuntimeResourceReference>,
  request: typeof requestSchema.infer,
):
  | { resources: ReadonlyArray<RuntimeResourceReference>; product: string | null }
  | { error: 'unknown_resource' | 'resource_product_mismatch'; status: 400 | 404 } {
  const selected =
    request.resourceId === undefined
      ? resources
      : resources.filter((entry) => entry.id === request.resourceId);

  if (request.resourceId !== undefined && !selected.length) {
    return { error: 'unknown_resource', status: 404 };
  }

  const resourceProduct = request.resourceId === undefined ? null : referenceProduct(selected[0]);

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
    bodyLimit({ maxSize: 16_384 }),
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

      const resources = await runtimeResourceReferences(context, project.id);

      const selection = selectResources(resources, body);

      if ('error' in selection) {
        return context.json({ error: selection.error }, selection.status);
      }

      const { resources: selected, product } = selection;
      const filesActive = await fileOwnerActive(context.get('db'), project);
      const catalog = await cloudflareCatalog();

      if (product && !catalog.operations.some((entry) => entry.product === product)) {
        return context.json({ error: 'unknown_product' }, 400);
      }

      let schema;
      if (body.operationId) {
        const operation = catalog.operations.find(
          (entry) =>
            (entry.id === body.operationId || entry.aliases.includes(body.operationId!)) &&
            (!product || entry.product === product),
        );
        if (!operation) {
          return context.json({ error: 'unknown_operation' }, 404);
        }
        const entry = (await cloudflareOpenApiIndex()).find(
          (value) => value.method === operation.httpMethod && value.path === operation.path,
        );
        if (!entry) {
          return context.json({ error: 'operation_schema_unavailable' }, 503);
        }
        if (body.schemaSha256 && body.schemaSha256 !== entry.sha256) {
          return context.json({ error: 'operation_schema_changed' }, 409);
        }
        try {
          schema = await cloudflareOperationSchema(context.env.STATIC_ASSETS_R2, entry);
        } catch {
          return context.json({ error: 'operation_schema_unavailable' }, 503);
        }
        if (!schema) {
          return context.json({ error: 'operation_schema_unavailable' }, 503);
        }
      }

      const caller =
        !schema && body.resourceId && filesActive && selected[0].source === 'resources'
          ? ownedResourceCaller(context, project, selected[0].resource, owner, resolve)
          : null;
      const registered = caller
        ? await resourceOperationsFor(caller.resource.type, context.env, caller)
        : null;
      const providerIndex = registered ? await cloudflareOpenApiIndex() : [];
      const current = await resolve(context, project.id, owner);
      const fresh = await runtimeResourceReferences(context, project.id);

      if (!sameProject(current, project)) {
        return context.json({ error: 'unknown_project' }, 404);
      }

      if (selected.some((entry) => !fresh.some((value) => sameResourceReference(value, entry)))) {
        return context.json({ error: 'resource_changed' }, 409);
      }

      if (schema) {
        return context.json({
          data: {
            appId: project.id,
            checkedAt: Date.now(),
            scope: { resourceId: body.resourceId ?? null, product },
            requestedOperationId: body.operationId,
            ...schema,
          },
        });
      }

      const currentFilesActive = filesActive && (await fileOwnerActive(context.get('db'), current));
      if (
        caller &&
        (!(await caller.stillAuthorized()) ||
          (registered &&
            registered.operations.length > 0 &&
            caller.resolveProviderIdentity &&
            !(await caller.resolveProviderIdentity())))
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
            query: body.query,
            method: body.method,
          },
          body.limit ?? 10,
          body.cursor,
        );

        const capable = selected.filter((entry) => !product || referenceProduct(entry) === product);

        return context.json({
          data: {
            appId: project.id,
            checkedAt: Date.now(),
            available: true,
            reason: null,
            ...page,
            operations: page.operations.map((operation) => {
              const provider = providerIndex.find(
                (entry) => entry.method === operation.httpMethod && entry.path === operation.path,
              );
              const descriptor =
                currentFilesActive && provider
                  ? registered?.operations.find((entry) => entry.id === provider.operationId)
                  : undefined;
              return descriptor
                ? {
                    ...operation,
                    execution: 'registered' as const,
                    registeredOperation: {
                      id: descriptor.id,
                      version: descriptor.version,
                      effect: descriptor.effect,
                      resourceId: body.resourceId,
                    },
                  }
                : {
                    ...operation,
                    unavailableReason: !body.resourceId
                      ? 'resource_not_selected'
                      : !currentFilesActive
                        ? 'resource_not_active'
                        : selected[0].source !== 'resources' ||
                            !providerPolicySelections(selected[0].resource.type).some(
                              (policy) =>
                                policy.method === operation.httpMethod &&
                                policy.path === operation.path,
                            )
                          ? 'policy_not_installed'
                          : (registered?.unavailable.find(
                              (value) =>
                                value.method === operation.httpMethod &&
                                value.path === operation.path,
                            )?.reason ?? 'schema_unavailable'),
                  };
            }),
            capabilitiesTruncated: capable.length > 50,
            capabilities: capable
              .slice(0, 50)
              .map((entry) => referenceCapabilities(context, current, entry, currentFilesActive)),
          },
        });
      } catch {
        return context.json({ error: 'invalid_cursor' }, 400);
      }
    },
  );
}
