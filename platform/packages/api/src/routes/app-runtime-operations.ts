import { type } from 'arktype';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getProjectResources } from '../db/resources.ts';
import type { ApiEnv } from '../env.ts';
import { resourceOperationsFor } from '../infrastructure/resource-operations.ts';
import { resolveOwnedDurableObjectNamespace } from './app-runtime-bindings.ts';
import { fileOwnerActive } from './app-runtime-files.ts';
import type { ResolveProject } from './app-runtime.ts';

const identifier = type('string > 0').atMostLength(200);
const owner = type({ person: identifier.narrow((value) => !value.startsWith('group:')) })
  .or({ group: identifier })
  .onUndeclaredKey('reject');
const selection = type({ project: identifier, owner, resourceId: identifier }).onUndeclaredKey(
  'reject',
);
const invocation = selection
  .merge({
    operation: identifier,
    version: /^[a-f0-9]{64}$/,
    expectedEffect: "'read' | 'write'",
    'confirmation?': "'reviewed'",
    input: 'unknown',
  })
  .onUndeclaredKey('reject');

async function ownedResource(
  context: Context<ApiEnv>,
  body: typeof selection.infer,
  resolve: ResolveProject,
) {
  const project = await resolve(context, body.project, body.owner);
  if (!project) {
    return null;
  }
  const resource = (await getProjectResources(context.get('db'), project.id)).find(
    (entry) => entry.id === body.resourceId,
  );
  if (!resource) {
    return null;
  }
  const stillAuthorized = async () => {
    const current = await resolve(context, project.id, body.owner);
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
    return (
      !!fresh &&
      fresh.type === resource.type &&
      fresh.cf_id === resource.cf_id &&
      fresh.binding_name === resource.binding_name &&
      fresh.metadata.jurisdiction === resource.metadata.jurisdiction &&
      fresh.metadata.namespaceId === resource.metadata.namespaceId &&
      fresh.metadata.dispatchNamespace === resource.metadata.dispatchNamespace
    );
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
            () => resolve(context, project.id, body.owner),
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

export function appRuntimeOperationRoutes(resolve: ResolveProject) {
  const app = new Hono<ApiEnv>();
  app.post(
    '/projects.resourceOperations',
    bodyLimit({
      maxSize: 8192,
      onError: (context) => context.json({ error: 'request_too_large' }, 413),
    }),
    async (context) => {
      const body = selection(await context.req.json().catch(() => null));
      if (body instanceof type.errors) {
        return context.json({ error: 'invalid_operation_request' }, 400);
      }
      const caller = await ownedResource(context, body, resolve);
      if (!caller) {
        return context.json({ error: 'unknown_resource' }, 404);
      }
      const { reason, operations } = await resourceOperationsFor(
        caller.resource.type,
        context.env,
        caller,
      );
      if (
        !(await caller.stillAuthorized()) ||
        (operations.length > 0 &&
          caller.resolveProviderIdentity &&
          !(await caller.resolveProviderIdentity()))
      ) {
        return context.json({ error: 'resource_changed' }, 409);
      }
      return context.json({
        data: {
          appId: caller.project.id,
          resourceId: caller.resource.id,
          checkedAt: Date.now(),
          available: !reason,
          reason,
          coverage: 'registered-operations',
          operations,
        },
      });
    },
  );
  app.post(
    '/resources.invoke',
    bodyLimit({
      maxSize: 820_000,
      onError: (context) => context.json({ error: 'request_too_large' }, 413),
    }),
    async (context) => {
      const body = invocation(await context.req.json().catch(() => null));
      if (body instanceof type.errors) {
        return context.json({ error: 'invalid_operation_request' }, 400);
      }
      const caller = await ownedResource(context, body, resolve);
      if (!caller) {
        return context.json({ error: 'unknown_resource' }, 404);
      }
      const { operations, registry, registryNames } = await resourceOperationsFor(
        caller.resource.type,
        context.env,
        caller,
      );
      const operation = operations.find((entry) => entry.id === body.operation);
      const registryName = registryNames.get(body.operation);
      if (!operation || !registryName) {
        return context.json({ error: 'operation_unavailable' }, 404);
      }
      if (operation.version !== body.version) {
        return context.json({ error: 'operation_changed' }, 409);
      }
      if (operation.effect !== body.expectedEffect) {
        return context.json({ error: 'effect_mismatch' }, 400);
      }
      if (operation.effect === 'write' && body.confirmation !== 'reviewed') {
        return context.json({ error: 'review_required' }, 403);
      }
      if (operation.effect === 'read' && body.confirmation !== undefined) {
        return context.json({ error: 'unexpected_confirmation' }, 400);
      }
      const result = await registry.call(registryName, body.input, {
        request: context.req.raw,
        env: { bindings: context.env, caller },
        surface: 'direct',
      });
      if (!result.ok) {
        return Response.json(
          { error: result.code, message: result.message },
          { status: result.status },
        );
      }
      return context.json({ data: result.value });
    },
  );
  return app;
}
