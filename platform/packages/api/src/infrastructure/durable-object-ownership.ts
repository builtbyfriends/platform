import { isRecord } from '@builtbyfriends/deploy-core';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import type { ApiEnv } from '../env.ts';
import {
  durableObjectWorkerName,
  verifyManagedDurableObjectOwnership,
} from '../provisioning/durable-objects.ts';
import type { Resource } from '../types.ts';

export type ObservedBinding = {
  name: string;
  type: string;
  providerId?: string;
  text?: unknown;
  class_name?: unknown;
  script_name?: unknown;
  namespace_id?: unknown;
  dispatch_namespace?: unknown;
  environment?: unknown;
};

export async function managedDurableObjectCandidate(
  env: Pick<ApiEnv['Bindings'], 'DISPATCH_NAMESPACE'>,
  projectId: string,
  resource: Resource,
  resources: ReadonlyArray<Resource>,
  manifestText: string | null,
  appBindings: ReadonlyArray<ObservedBinding>,
) {
  const namespace = env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const namespaceId = resource.metadata.namespaceId;
  if (
    resource.type !== 'durable-object' ||
    resource.project_id !== projectId ||
    resource.metadata.dispatchNamespace !== namespace ||
    typeof namespaceId !== 'string' ||
    !/^[a-f0-9]{32}$/i.test(namespaceId) ||
    resource.cf_id !== (await durableObjectWorkerName(projectId, resource.binding_name)) ||
    resources.filter(
      (item) =>
        item.type === 'durable-object' &&
        (item.cf_id === resource.cf_id || item.metadata.namespaceId === namespaceId),
    ).length !== 1 ||
    !manifestText ||
    manifestText.length > 1_000_000
  ) {
    return null;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return null;
  }
  if (!isRecord(manifest) || !isRecord(manifest.durableObjects)) {
    return null;
  }
  const durable = manifest.durableObjects;
  if (
    !isRecord(durable.runtime) ||
    durable.runtime.protocol !== 1 ||
    !isRecord(durable.runtime.namespaces) ||
    durable.runtime.namespaces[resource.binding_name] !== namespaceId ||
    Object.values(durable.runtime.namespaces).filter((value) => value === namespaceId).length !==
      1 ||
    !Array.isArray(durable.bindings)
  ) {
    return null;
  }
  const expected = durable.bindings.filter(
    (binding: unknown) => isRecord(binding) && binding.className === resource.binding_name,
  );
  if (
    expected.length !== 1 ||
    !isRecord(expected[0]) ||
    typeof expected[0].bindingName !== 'string'
  ) {
    return null;
  }
  const name = expected[0].bindingName;
  if (
    durable.bindings.filter((binding: unknown) => isRecord(binding) && binding.bindingName === name)
      .length !== 1
  ) {
    return null;
  }
  const candidates = appBindings.filter(
    (binding) => binding.name === name || binding.namespace_id === namespaceId,
  );
  if (
    candidates.length !== 1 ||
    candidates[0].name !== name ||
    candidates[0].type !== 'durable_object_namespace' ||
    candidates[0].namespace_id !== namespaceId ||
    !localBinding(candidates[0], resource, namespace)
  ) {
    return null;
  }
  return { namespaceId, workerName: resource.cf_id };
}

function localBinding(binding: ObservedBinding, resource: Resource, namespace: string) {
  return (
    (binding.class_name === undefined || binding.class_name === resource.binding_name) &&
    (binding.script_name === undefined || binding.script_name === resource.cf_id) &&
    (binding.dispatch_namespace === undefined || binding.dispatch_namespace === namespace) &&
    binding.environment === undefined
  );
}

export function managedDurableObjectHostMatches(
  env: Pick<ApiEnv['Bindings'], 'DISPATCH_NAMESPACE'>,
  projectId: string,
  deploymentId: string,
  resource: Resource,
  bindings: ReadonlyArray<ObservedBinding>,
): boolean {
  const namespace = env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const owner = bindings.filter((binding) => binding.name === '__PLATFORM_DURABLE_OWNER');
  const release = bindings.filter((binding) => binding.name === '__PLATFORM_DURABLE_DEPLOYMENT');
  const candidates = bindings.filter(
    (binding) =>
      binding.type === 'durable_object_namespace' &&
      (binding.class_name === resource.binding_name ||
        binding.namespace_id === resource.metadata.namespaceId),
  );
  if (
    owner.length !== 1 ||
    release.length !== 1 ||
    release[0].type !== 'plain_text' ||
    release[0].text !== deploymentId ||
    candidates.length !== 1 ||
    !localBinding(candidates[0], resource, namespace)
  ) {
    return false;
  }
  try {
    return (
      verifyManagedDurableObjectOwnership(env, projectId, resource, bindings) ===
      resource.metadata.namespaceId
    );
  } catch {
    return false;
  }
}
