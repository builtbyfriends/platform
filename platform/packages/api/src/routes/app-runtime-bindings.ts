import { isRecord } from '@builtbyfriends/deploy-core';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import type { Db } from '../db/client.ts';
import { getDeployment } from '../db/deployments.ts';
import { getProjectResources } from '../db/resources.ts';
import type { ApiEnv } from '../env.ts';
import {
  managedDurableObjectCandidate,
  managedDurableObjectHostMatches,
  type ObservedBinding,
} from '../infrastructure/durable-object-ownership.ts';
import { getProjectDeploymentWorkerName } from '../naming.ts';
import { CF_API_BASE } from '../provisioning/cloudflare-api.ts';
import { projectRouteKey } from '../routing.ts';
import type { Project, Resource } from '../types.ts';

export type ResourceTopology = {
  status: 'verified' | 'unavailable';
  deploymentId: string | null;
  checkedAt: number;
  connections: Array<{ resourceId: string; relation: 'access' }>;
  unboundResourceIds: Array<string>;
};

type Binding = ObservedBinding;
type BindingObservationEnv = Pick<
  ApiEnv['Bindings'],
  'CF_ACCOUNT_ID' | 'CF_API_TOKEN' | 'DISPATCH_NAMESPACE' | 'ROUTING'
>;
const bindingTypes = { d1: 'd1', r2: 'r2_bucket', kv: 'kv_namespace' };
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 300;

function bindings(value: unknown, projectId?: string): Array<Binding> {
  if (
    !isRecord(value) ||
    value.success !== true ||
    !Array.isArray(value.result) ||
    value.result.length > 1000
  ) {
    throw new Error('Bindings unavailable');
  }
  // Decision: Empty dispatch binding responses can mean a missing script; the injected marker also verifies ownership.
  if (
    projectId !== undefined &&
    !value.result.some(
      (item: unknown) =>
        isRecord(item) &&
        item.type === 'plain_text' &&
        item.name === '__PROJECT_ID' &&
        item.text === projectId,
    )
  ) {
    throw new Error('Binding owner unavailable');
  }
  const names = new Set<string>();
  return value.result.map((item: unknown): Binding => {
    if (
      !isRecord(item) ||
      !identifier(item.name) ||
      !identifier(item.type) ||
      names.has(item.name)
    ) {
      throw new Error('Invalid binding');
    }
    names.add(item.name);
    const providerId =
      item.type === 'd1'
        ? (item.database_id ?? item.id)
        : item.type === 'r2_bucket'
          ? item.bucket_name
          : item.type === 'kv_namespace'
            ? item.namespace_id
            : undefined;
    if (Object.values(bindingTypes).includes(item.type) && !identifier(providerId)) {
      throw new Error('Invalid binding identity');
    }
    if (
      item.type === 'd1' &&
      item.database_id !== undefined &&
      item.id !== undefined &&
      item.database_id !== item.id
    ) {
      throw new Error('Conflicting binding identity');
    }
    return {
      name: item.name,
      type: item.type,
      ...(identifier(providerId) && { providerId }),
      ...(item.type === 'plain_text' &&
        (item.name === '__PLATFORM_DURABLE_OWNER' ||
          item.name === '__PLATFORM_DURABLE_DEPLOYMENT') && { text: item.text }),
      ...(item.type === 'durable_object_namespace' && {
        class_name: item.class_name,
        script_name: item.script_name,
        namespace_id: item.namespace_id,
        dispatch_namespace: item.dispatch_namespace,
        environment: item.environment,
      }),
    };
  });
}

function resourceIdentity(items: ReadonlyArray<Resource>): string {
  return JSON.stringify(
    [...items]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, project_id, type, cf_id, binding_name, metadata }) => [
        id,
        project_id,
        type,
        cf_id,
        binding_name,
        metadata.namespaceId,
        metadata.dispatchNamespace,
      ]),
  );
}

export async function observeResourceBindings(
  env: BindingObservationEnv,
  db: Db,
  project: Project,
  resources: ReadonlyArray<Resource>,
  resolve: () => Promise<Project | null>,
  durableResourceId?: string,
): Promise<ResourceTopology> {
  const result: ResourceTopology = {
    status: 'unavailable',
    deploymentId: project.active_deployment_id ?? null,
    checkedAt: Date.now(),
    connections: [],
    unboundResourceIds: [],
  };
  if (!project.active_deployment_id || resources.length > 200) {
    return result;
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Binding observation timed out'));
    }, 6000);
  });
  const within = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, deadline]);
  const readBindings = async (workerName: string, ownerProjectId?: string) => {
    const namespace = env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
    const url = `${CF_API_BASE}/${encodeURIComponent(env.CF_ACCOUNT_ID)}/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts/${encodeURIComponent(workerName)}/bindings`;
    const response = await within(
      fetch(url, {
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
        signal: controller.signal,
        redirect: 'error',
      }),
    );
    if (!response.ok || !response.body) {
      if (response.body) {
        await within(response.body.cancel());
      }
      throw new Error('Bindings unavailable');
    }
    let size = 0;
    let text = '';
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await within(reader.read());
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > 1_000_000) {
          throw new Error('Binding response too large');
        }
        text += decoder.decode(value, { stream: true });
      }
      return bindings(JSON.parse(text + decoder.decode()), ownerProjectId);
    } finally {
      await within(reader.cancel()).catch(() => undefined);
      reader.releaseLock();
    }
  };
  try {
    const deployment = await within(getDeployment(db, project.active_deployment_id));
    if (deployment?.project_id !== project.id) {
      return result;
    }
    const routeKey = projectRouteKey(project);
    const routeText = await within(env.ROUTING.get(routeKey));
    if (!routeText || routeText.length > 65_536) {
      return result;
    }
    const route: unknown = JSON.parse(routeText);
    if (
      !isRecord(route) ||
      route.projectId !== project.id ||
      route.userId !== project.user_id ||
      route.version !== deployment.id ||
      Boolean(route.privatePreview) !== Boolean(project.preview_client_id)
    ) {
      return result;
    }
    const workerName = getProjectDeploymentWorkerName(project.slug, deployment.id);
    const isStatic = route.staticDeploymentId === deployment.id && route.workerName === undefined;
    let observed: Array<Binding> = [];
    if (!isStatic) {
      if (
        route.workerName !== workerName ||
        route.staticDeploymentId !== undefined ||
        !env.CF_ACCOUNT_ID ||
        !env.CF_API_TOKEN
      ) {
        return result;
      }
      observed = await readBindings(workerName, project.id);
    }
    const durableConnections: ResourceTopology['connections'] = [];
    for (const resource of resources) {
      if (
        isStatic ||
        resource.type !== 'durable-object' ||
        (durableResourceId !== undefined && resource.id !== durableResourceId)
      ) {
        continue;
      }
      const candidate = await within(
        managedDurableObjectCandidate(
          env,
          project.id,
          resource,
          resources,
          deployment.manifest,
          observed,
        ),
      );
      if (!candidate) {
        continue;
      }
      const host = await readBindings(candidate.workerName);
      if (managedDurableObjectHostMatches(env, project.id, deployment.id, resource, host)) {
        durableConnections.push({ resourceId: resource.id, relation: 'access' });
      }
    }
    const [current, freshResources, freshRoute, freshDeployment] = await within(
      Promise.all([
        resolve(),
        getProjectResources(db, project.id),
        env.ROUTING.get(routeKey),
        getDeployment(db, deployment.id),
      ]),
    );
    if (
      !current ||
      current.user_id !== project.user_id ||
      current.slug !== project.slug ||
      current.active_deployment_id !== deployment.id ||
      current.proxy_token_gen !== project.proxy_token_gen ||
      current.preview_client_id !== project.preview_client_id ||
      current.preview_expires_at !== project.preview_expires_at ||
      current.status !== project.status ||
      freshRoute !== routeText ||
      freshDeployment?.project_id !== project.id ||
      freshDeployment.manifest !== deployment.manifest ||
      resourceIdentity(freshResources) !== resourceIdentity(resources)
    ) {
      return result;
    }
    result.connections.push(...durableConnections);
    for (const resource of resources) {
      if (resource.project_id !== project.id || !(resource.type in bindingTypes)) {
        continue;
      }
      const type =
        resource.type === 'd1' ? 'd1' : resource.type === 'r2' ? 'r2_bucket' : 'kv_namespace';
      const candidates = observed.filter(
        (item) =>
          item.type === type &&
          (item.name === resource.binding_name || item.providerId === resource.cf_id),
      );
      if (candidates.length === 0) {
        result.unboundResourceIds.push(resource.id);
      } else if (
        candidates.length === 1 &&
        candidates[0].name === resource.binding_name &&
        candidates[0].providerId === resource.cf_id &&
        resources.filter((item) => item.type === resource.type && item.cf_id === resource.cf_id)
          .length === 1
      ) {
        result.connections.push({ resourceId: resource.id, relation: 'access' });
      }
    }
    result.connections.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
    result.unboundResourceIds.sort();
    return { ...result, status: 'verified', checkedAt: Date.now() };
  } catch {
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function resolveOwnedDurableObjectNamespace(
  env: BindingObservationEnv,
  db: Db,
  project: Project,
  resource: Resource,
  resolve: () => Promise<Project | null>,
): Promise<string | null> {
  if (resource.type !== 'durable-object' || resource.project_id !== project.id) {
    return null;
  }
  const resources = await getProjectResources(db, project.id);
  const current = resources.find((item) => item.id === resource.id);
  if (!current || resourceIdentity([current]) !== resourceIdentity([resource])) {
    return null;
  }
  const observed = await observeResourceBindings(env, db, project, resources, resolve, resource.id);
  return observed.status === 'verified' &&
    observed.connections.some((connection) => connection.resourceId === resource.id) &&
    typeof resource.metadata.namespaceId === 'string'
    ? resource.metadata.namespaceId
    : null;
}
