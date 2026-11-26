import { describe, expect, it } from 'vite-plus/test';
import {
  managedDurableObjectCandidate,
  managedDurableObjectHostMatches,
  type ObservedBinding,
} from '../../src/infrastructure/durable-object-ownership.ts';
import { durableObjectWorkerName } from '../../src/provisioning/durable-objects.ts';
import type { Resource } from '../../src/types.ts';

const env = { DISPATCH_NAMESPACE: 'platform-users' };
const namespaceId = 'a'.repeat(32);
const manifest = {
  durableObjects: {
    bindings: [{ bindingName: 'ROOMS', className: 'Room', storage: 'sqlite' }],
    runtime: { protocol: 1, namespaces: { Room: namespaceId } },
  },
};
async function setup() {
  const resource: Resource = {
    id: 'owned-resource',
    project_id: 'project',
    type: 'durable-object',
    cf_id: await durableObjectWorkerName('project', 'Room'),
    binding_name: 'Room',
    metadata: { namespaceId, dispatchNamespace: env.DISPATCH_NAMESPACE },
    created_at: '2026-11-25T00:00:00Z',
  };
  const inventory = [resource];
  const app: Array<ObservedBinding> = [
    { name: 'ROOMS', type: 'durable_object_namespace', namespace_id: namespaceId },
  ];
  const host: Array<ObservedBinding> = [
    {
      name: '__PLATFORM_DURABLE_OWNER',
      type: 'plain_text',
      text: JSON.stringify({
        protocol: 1,
        projectId: 'project',
        dispatchNamespace: env.DISPATCH_NAMESPACE,
        className: 'Room',
      }),
    },
    { name: '__PLATFORM_DURABLE_DEPLOYMENT', type: 'plain_text', text: 'deployment' },
    {
      name: 'SELF',
      type: 'durable_object_namespace',
      class_name: 'Room',
      namespace_id: namespaceId,
    },
  ];
  return {
    resource,
    inventory,
    app,
    host,
    candidate: (document = JSON.stringify(manifest)) =>
      managedDurableObjectCandidate(env, 'project', resource, inventory, document, app),
    matches: () => managedDurableObjectHostMatches(env, 'project', 'deployment', resource, host),
  };
}

describe('managed Durable Object namespace evidence', () => {
  it('resolves a namespace only when manifest, inventory, app and managed host agree', async () => {
    const { candidate, matches, resource } = await setup();
    expect(await candidate()).toEqual({ namespaceId, workerName: resource.cf_id });
    expect(matches()).toBe(true);
    expect(resource.cf_id).not.toBe(namespaceId);
  });

  it.each([
    'owner',
    'worker',
    'namespace',
    'dispatch',
    'alias',
    'app-id',
    'app-alias',
    'app-script',
    'app-dispatch',
    'app-environment',
  ])('does not resolve foreign or ambiguous %s evidence', async (change) => {
    const { candidate, resource, inventory, app } = await setup();
    if (change === 'owner') {
      resource.project_id = 'foreign';
    }
    if (change === 'worker') {
      resource.cf_id = 'foreign-worker';
    }
    if (change === 'namespace') {
      resource.metadata.namespaceId = resource.cf_id;
    }
    if (change === 'dispatch') {
      resource.metadata.dispatchNamespace = 'foreign';
    }
    if (change === 'alias') {
      inventory.push({ ...resource, id: 'alias' });
    }
    if (change === 'app-id') {
      app[0].namespace_id = 'b'.repeat(32);
    }
    if (change === 'app-alias') {
      app.push({ ...app[0], name: 'ALIAS' });
    }
    if (change === 'app-script') {
      app[0].script_name = 'foreign-worker';
    }
    if (change === 'app-dispatch') {
      app[0].dispatch_namespace = 'foreign';
    }
    if (change === 'app-environment') {
      app[0].environment = 'other';
    }
    expect(await candidate()).toBeNull();
  });

  it.each([
    'invalid-json',
    'missing-runtime',
    'foreign-namespace',
    'duplicate-class',
    'duplicate-name',
    'namespace-alias',
  ])('does not resolve %s deployment metadata', async (change) => {
    const { candidate } = await setup();
    if (change === 'invalid-json') {
      expect(await candidate('{')).toBeNull();
      return;
    }
    const document = structuredClone(manifest);
    if (change === 'missing-runtime') {
      document.durableObjects.runtime.protocol = 0;
    }
    if (change === 'foreign-namespace') {
      document.durableObjects.runtime.namespaces.Room = 'b'.repeat(32);
    }
    if (change === 'duplicate-class') {
      document.durableObjects.bindings.push({
        bindingName: 'ALIAS',
        className: 'Room',
        storage: 'sqlite',
      });
    }
    if (change === 'duplicate-name') {
      document.durableObjects.bindings.push({
        bindingName: 'ROOMS',
        className: 'Other',
        storage: 'sqlite',
      });
    }
    if (change === 'namespace-alias') {
      Object.assign(document.durableObjects.runtime.namespaces, { Other: namespaceId });
    }
    expect(await candidate(JSON.stringify(document))).toBeNull();
  });

  it.each([
    'owner',
    'owner-alias',
    'release',
    'release-alias',
    'namespace',
    'class',
    'alias',
    'script',
    'dispatch',
    'environment',
  ])('rejects %s managed host evidence', async (change) => {
    const { host, matches } = await setup();
    if (change === 'owner') {
      host[0].text = 'foreign-owner';
    }
    if (change === 'owner-alias') {
      host.push({ ...host[0] });
    }
    if (change === 'release') {
      host[1].text = 'other-deployment';
    }
    if (change === 'release-alias') {
      host.push({ ...host[1] });
    }
    if (change === 'namespace') {
      host[2].namespace_id = 'b'.repeat(32);
    }
    if (change === 'class') {
      host[2].class_name = 'Other';
    }
    if (change === 'alias') {
      host.push({ ...host[2], name: 'ALIAS' });
    }
    if (change === 'script') {
      host[2].script_name = 'foreign-worker';
    }
    if (change === 'dispatch') {
      host[2].dispatch_namespace = 'foreign';
    }
    if (change === 'environment') {
      host[2].environment = 'other';
    }
    expect(matches()).toBe(false);
  });
});
