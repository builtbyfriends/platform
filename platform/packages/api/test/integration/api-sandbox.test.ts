import { eq, and } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import rawApp from '../../src/index.ts';
import {
  retrySandboxControllerCleanup,
  sandboxControllerWorkerName,
} from '../../src/provisioning/sandbox-controller.ts';
import { deployments, projects, resources } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  skipOrphanSweepDelay,
  readAllEvents,
  withLegacyDeploy,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

const app = withLegacyDeploy(rawApp);

// Decision: Managed Sandbox deploys isolate the trusted controller in an account Worker. Tenant Workers get
// only its service binding. Containers stay per deployment so image upgrades, rollback, retention
// and deletion have independent lifetimes.

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SANDBOX_IMAGE_V1 =
  'registry.cloudflare.com/account/code-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function buildSandboxManifest(overrides?: {
  image?: string;
  containerName?: string;
  instanceType?: string;
}): Record<string, unknown> {
  return {
    version: 3,
    bindings: {},
    sandbox: {
      controllerProtocol: 2,
      bindingName: 'SANDBOX',
      className: 'Sandbox',
      containerName: overrides?.containerName ?? 'platform-sandbox',
      image: overrides?.image ?? SANDBOX_IMAGE_V1,
      instanceType: overrides?.instanceType ?? 'lite',
      maxInstances: 20,
      migrations: [{ tag: 'sandbox-v1', newSqliteClasses: ['Sandbox'] }],
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function deploy(
  projectId: string,
  jwt: string,
  manifest?: Record<string, unknown>,
  workers?: Record<string, string>,
): Promise<Response> {
  const baseManifest = manifest ?? buildSandboxManifest();
  const workerSources = workers ?? {
    'index.js': "export default { fetch() { return new Response('ok'); } }",
  };
  const workerFiles: Record<string, string> = {};
  for (const [name, content] of Object.entries(workerSources)) {
    workerFiles[name] = bytesToBase64(new TextEncoder().encode(content));
  }

  return app.fetch(
    new Request(`http://localhost/projects/${projectId}/deploy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        manifest: { assetManifestVersion: 2, ...baseManifest },
        assetManifest: {},
        source: null,
        commit: null,
        repositoryUrl: null,
        commitUrl: null,
        gitRef: null,
        preflight: null,
        workerFiles,
      }),
    }),
    env,
  );
}

function getDoneEvent(events: Array<unknown>): { event: string; deployment: string } | undefined {
  return events.find(
    (e): e is { event: string; deployment: string } =>
      typeof e === 'object' && e !== null && (e as { event?: unknown }).event === 'done',
  );
}

async function listR2Keys(prefix: string): Promise<Array<string>> {
  const list = await env.STATIC_ASSETS_R2.list({ prefix });
  return list.objects.map((o) => o.key);
}

describe('per-deploy sandbox integration', () => {
  it('fails before controller upload when custom image preparation fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sb-image-error');
    const cf = mockCfApi({
      prepareContainerImage: () =>
        Response.json({
          success: true,
          result: { image: SANDBOX_IMAGE_V1, status: 'error' },
        }),
    });
    const events = await readAllEvents(await deploy(project.id, user.jwt));
    expect(getDoneEvent(events)).toBeUndefined();
    expect(cf.state.hostScripts.size).toBe(0);
    expect(cf.state.containerApps.size).toBe(0);
    expect(await env.ROUTING.get(project.slug)).toBeNull();
  });

  it('provisions a trusted controller and gives the tenant only its restricted service', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sb-first');
    const cf = mockCfApi();

    const res = await deploy(project.id, user.jwt);
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = getDoneEvent(events);
    expect(done).toBeDefined();
    const deployId = done!.deployment;

    expect(cf.state.hostScripts.has(`do-host-${project.slug}`)).toBe(false);

    const userWorkerName = `user-${project.slug}-${deployId}`;
    const userWorker = cf.state.hostScripts.get(userWorkerName);
    expect(userWorker).toBeDefined();

    const controllerName = sandboxControllerWorkerName(project.id, deployId);
    const controller = cf.state.hostScripts.get(controllerName)!;
    const namespaceId = controller.classes.get('SandboxController');
    expect(namespaceId).toBeTruthy();
    expect(userWorker!.classes.size).toBe(0);
    expect(userWorker!.metadata.containers).toBeUndefined();
    expect(userWorker!.bindings).toContainEqual({
      type: 'service',
      name: '__PLATFORM_SANDBOX',
      service: controllerName,
    });
    expect(
      userWorker!.bindings.some((binding) => binding.type === 'durable_object_namespace'),
    ).toBe(false);
    expect(
      userWorker!.bindings.some((binding) => binding.name === '__PLATFORM_SANDBOX_CONTROL'),
    ).toBe(false);
    expect(controller.bindings).toContainEqual({
      type: 'service',
      name: '__PLATFORM_SANDBOX_CONTROL',
      service: 'platform-api',
      entrypoint: 'SandboxControl',
      props: { projectId: project.id, deploymentId: deployId, userId: user.id, slug: project.slug },
    });
    const [stored] = await env.db.select().from(deployments).where(eq(deployments.id, deployId));
    expect(JSON.parse(stored.manifest!).sandbox.runtime).toEqual({ protocol: 2 });
    cf.expectCallOrder(
      { method: 'POST', url: '/containers/image-preparations' },
      { method: 'PUT', url: '/workers/scripts/' + controllerName },
      { method: 'POST', url: '/containers/applications' },
      { method: 'PUT', url: '/scripts/' + userWorkerName },
    );

    const containerAppName = `${project.id}-${deployId}-platform-sandbox`
      .toLowerCase()
      .replaceAll('_', '-');
    const containerApp = Array.from(cf.state.containerApps.values()).find(
      (a) => a.name === containerAppName,
    );
    expect(containerApp).toBeDefined();
    expect(containerApp!.durable_objects.namespace_id).toBe(namespaceId);
    expect(containerApp!.scheduling_policy).toBe('durable_object');
    expect(controller.metadata.containers).toEqual([
      expect.objectContaining({ images: { default: SANDBOX_IMAGE_V1 } }),
    ]);

    // Decision: Per-deploy containers don't write a `resources` row; teardown finds them via orphan-recovery
    // enumeration.
    const resRows = await env.db
      .select()
      .from(resources)
      .where(and(eq(resources.project_id, project.id), eq(resources.type, 'container')));
    expect(resRows).toHaveLength(0);
  });

  it('sandbox redeploy: brand-new user worker name, brand-new namespace_id, brand-new container app (no namespace preservation across deploys)', async () => {
    const user = await createTestUser(env.db, 'sb-rd-user', 'github', undefined, 'solo');
    const project = await createTestProject(env.db, user.id, 'sb-redeploy');
    const cf = mockCfApi();

    const res1 = await deploy(project.id, user.jwt);
    expect(res1.status).toBe(200);
    const done1 = getDoneEvent(await readAllEvents(res1));
    expect(done1).toBeDefined();
    const v1Id = done1!.deployment;

    const v1WorkerName = `user-${project.slug}-${v1Id}`;
    const v1Namespace = cf.state.hostScripts
      .get(sandboxControllerWorkerName(project.id, v1Id))!
      .classes.get('SandboxController')!;
    const v1ContainerName = `${project.id}-${v1Id}-platform-sandbox`
      .toLowerCase()
      .replaceAll('_', '-');

    const res2 = await deploy(project.id, user.jwt);
    expect(res2.status).toBe(200);
    const done2 = getDoneEvent(await readAllEvents(res2));
    expect(done2).toBeDefined();
    const v2Id = done2!.deployment;

    expect(v2Id).not.toBe(v1Id);

    const v2WorkerName = `user-${project.slug}-${v2Id}`;
    expect(v2WorkerName).not.toBe(v1WorkerName);
    const v2Worker = cf.state.hostScripts.get(v2WorkerName);
    expect(v2Worker).toBeDefined();

    const v2Namespace = cf.state.hostScripts
      .get(sandboxControllerWorkerName(project.id, v2Id))!
      .classes.get('SandboxController')!;
    expect(v2Namespace).toBeTruthy();
    expect(v2Namespace).not.toBe(v1Namespace);

    const v2ContainerName = `${project.id}-${v2Id}-platform-sandbox`
      .toLowerCase()
      .replaceAll('_', '-');
    expect(v2ContainerName).not.toBe(v1ContainerName);
    const v2App = Array.from(cf.state.containerApps.values()).find(
      (a) => a.name === v2ContainerName,
    );
    expect(v2App).toBeDefined();
    expect(v2App!.durable_objects.namespace_id).toBe(v2Namespace);
  });

  it('static-only deploy does NOT write a worker bundle (bundle_stored stays false, no R2 objects)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sb-static');
    mockCfApi();

    // Decision: Direct-to-R2 deploys verify R2 has the declared bytes before flipping routing.
    const indexBytes = new TextEncoder().encode('<html>hello</html>');
    const indexHash = (await import('../../src/assets.ts')).computeAssetHash(
      indexBytes.buffer.slice(indexBytes.byteOffset, indexBytes.byteOffset + indexBytes.byteLength),
      '/index.html',
    );
    await env.STATIC_ASSETS_R2.put(`assets/${project.id}/${indexHash}`, indexBytes);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: {
            version: 3,
            assetManifestVersion: 2,
            bindings: {},
            type: 'static',
            assetConfig: { not_found_handling: 'none' },
          },
          assetManifest: {
            '/index.html': { blake3: indexHash, md5: indexHash, size: indexBytes.byteLength },
          },
          source: null,
          commit: null,
          repositoryUrl: null,
          commitUrl: null,
          gitRef: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const done = getDoneEvent(await readAllEvents(res));
    expect(done).toBeDefined();
    const deployId = done!.deployment;

    const bundleKeys = await listR2Keys(`worker-bundles/${project.id}/${deployId}/`);
    expect(bundleKeys).toHaveLength(0);

    const [row] = await env.db.select().from(deployments).where(eq(deployments.id, deployId));
    expect(row.bundle_stored).toBe(false);
  });

  it('retention eviction: oldest sandbox deploy has its user worker, container app, AND R2 bundle deleted when retention limit is exceeded', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sb-evict');
    const cf = mockCfApi();

    const res1 = await deploy(project.id, user.jwt);
    expect(res1.status).toBe(200);
    const done1 = getDoneEvent(await readAllEvents(res1));
    expect(done1).toBeDefined();
    const v1Id = done1!.deployment;
    const v1WorkerName = `user-${project.slug}-${v1Id}`;
    const v1ContainerName = `${project.id}-${v1Id}-platform-sandbox`
      .toLowerCase()
      .replaceAll('_', '-');

    // Decision: Models a retained deployment created before Worker bundle storage stopped.
    await env.STATIC_ASSETS_R2.put(
      `worker-bundles/${project.id}/${v1Id}/index.js`,
      'legacy Worker bundle',
    );
    await env.db.update(deployments).set({ bundle_stored: true }).where(eq(deployments.id, v1Id));

    expect(cf.state.hostScripts.has(v1WorkerName)).toBe(true);
    expect(
      Array.from(cf.state.containerApps.values()).some((a) => a.name === v1ContainerName),
    ).toBe(true);
    expect((await listR2Keys(`worker-bundles/${project.id}/${v1Id}/`)).length).toBeGreaterThan(0);

    const res2 = await deploy(project.id, user.jwt);
    expect(res2.status).toBe(200);
    const done2 = getDoneEvent(await readAllEvents(res2));
    expect(done2).toBeDefined();

    expect(cf.state.hostScripts.has(v1WorkerName)).toBe(false);
    expect(cf.state.hostScripts.has(sandboxControllerWorkerName(project.id, v1Id))).toBe(false);

    expect(
      Array.from(cf.state.containerApps.values()).some((a) => a.name === v1ContainerName),
    ).toBe(false);

    expect(await listR2Keys(`worker-bundles/${project.id}/${v1Id}/`)).toHaveLength(0);

    const [v1Row] = await env.db.select().from(deployments).where(eq(deployments.id, v1Id));
    expect(v1Row.retained).toBe(false);
  });

  it('retries controller and container cleanup after an interrupted deployment cleanup', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sb-cleanup-retry');
    const cf = mockCfApi();
    const response = await deploy(project.id, user.jwt);
    const deploymentId = getDoneEvent(await readAllEvents(response))!.deployment;
    const controllerName = sandboxControllerWorkerName(project.id, deploymentId);
    expect(cf.state.hostScripts.has(controllerName)).toBe(true);

    await env.db
      .update(projects)
      .set({ active_deployment_id: null })
      .where(eq(projects.id, project.id));
    await env.db
      .update(deployments)
      .set({ retained: false, status: 'failed' })
      .where(eq(deployments.id, deploymentId));

    await retrySandboxControllerCleanup(env.db, env);
    expect(cf.state.hostScripts.has(controllerName)).toBe(false);
    expect(
      Array.from(cf.state.containerApps.values()).some((application) =>
        application.name.includes(deploymentId),
      ),
    ).toBe(false);
    const [cleaned] = await env.db
      .select({ manifest: deployments.manifest })
      .from(deployments)
      .where(eq(deployments.id, deploymentId));
    expect(JSON.parse(cleaned.manifest!).sandbox.runtime.cleanupComplete).toBe(true);
  });

  it('pre-routing failure: outer catch deletes the user worker AND the per-deploy container app (no orphans)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sb-prefail');

    // Decision: Fail between the user worker PUT (and container POST) and the routing flip to force the
    // `routingSwitched=false` cleanup branch: reject the slug ROUTING.put, which is the routing flip
    // (`routingSwitched` is set true right after it).
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    const putSpy = vi.spyOn(env.ROUTING, 'put').mockImplementation((async (
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      options?: KVNamespacePutOptions,
    ) => {
      if (key === project.slug) {
        throw new Error('forced ROUTING.put failure for test');
      }
      return originalPut(key, value as never, options);
    }) as typeof env.ROUTING.put);

    const cf = mockCfApi();

    const res = await deploy(project.id, user.jwt);
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = getDoneEvent(events);
    expect(done).toBeUndefined();

    const errorEvent = events.find(
      (e): e is { event: string; message: string } =>
        typeof e === 'object' && e !== null && (e as { event?: unknown }).event === 'error',
    );
    expect(errorEvent).toBeDefined();

    putSpy.mockRestore();

    const userWorkerKey = Array.from(cf.state.hostScripts.keys()).find((k) =>
      k.startsWith(`user-${project.slug}-`),
    );
    expect(userWorkerKey).toBeUndefined();

    const sandboxApps = Array.from(cf.state.containerApps.values()).filter((a) =>
      a.name.endsWith('-platform-sandbox'),
    );
    expect(sandboxApps).toHaveLength(0);

    const workerDeletes = cf.state.recordedCalls.filter(
      (c) =>
        c.method === 'DELETE' &&
        c.url.includes('/workers/dispatch/') &&
        c.url.includes(`/scripts/user-${project.slug}-`),
    );
    expect(workerDeletes.length).toBeGreaterThanOrEqual(1);
    const containerDeletes = cf.state.recordedCalls.filter(
      (c) => c.method === 'DELETE' && c.url.includes('/containers/applications/'),
    );
    expect(containerDeletes.length).toBeGreaterThanOrEqual(1);
  });

  it('post-routing teardown race: when status flips to deleting after the slug routing PUT, the rollback branch deletes the user worker AND the per-deploy container app', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sb-teardown-race');
    const cf = mockCfApi();

    const previousRouting = JSON.stringify({ type: 'static', deploymentId: 'previous' });
    await env.ROUTING.put(project.slug, previousRouting);

    // Decision: After the slug ROUTING.put commits (routingSwitched=true), model teardown taking authority: flip
    // projects.status='deleting' and do teardown's routing deletion before the deploy reaches its final
    // FOR UPDATE check. The deploy compensation mustn't restore the previous value after teardown's one
    // deletion pass.
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    const originalDelete = env.ROUTING.delete.bind(env.ROUTING);
    let teardownTriggered = false;
    const putSpy = vi.spyOn(env.ROUTING, 'put').mockImplementation((async (
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      options?: KVNamespacePutOptions,
    ) => {
      const result = await originalPut(key, value as never, options);
      // Decision: The `cutover-ready:` key is written after the routing-switch transaction commits and before the
      // deploy's finalize transaction opens, so the teardown writes can be awaited here: no transaction is
      // open, nothing deadlocks, and the flip lands before the finalize read. Queuing them instead only
      // orders them in PGlite's favor; on a pooled Postgres the flip opens a new session and loses the
      // race against the deploy's warm connection, which commits live.
      if (key.startsWith('cutover-ready:') && !teardownTriggered) {
        teardownTriggered = true;
        await env.db
          .update(projects)
          .set({ status: 'deleting' })
          .where(eq(projects.id, project.id));
        await originalDelete(project.slug);
      }
      return result;
    }) as typeof env.ROUTING.put);

    const res = await deploy(project.id, user.jwt);
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);

    const done = getDoneEvent(events);
    expect(done).toBeUndefined();
    const errorEvent = events.find(
      (e): e is { event: string; message: string } =>
        typeof e === 'object' && e !== null && (e as { event?: unknown }).event === 'error',
    );
    expect(errorEvent).toBeDefined();

    // Decision: Teardown's deletion stays authoritative: the compensation mustn't put `previousRouting` back, or a
    // deleted project (or a later tenant reusing the slug) could be served by dispatch without
    // consulting PostgreSQL.
    expect(await env.ROUTING.get(project.slug)).toBeNull();

    putSpy.mockRestore();

    const userWorkerKey = Array.from(cf.state.hostScripts.keys()).find((k) =>
      k.startsWith(`user-${project.slug}-`),
    );
    expect(userWorkerKey).toBeUndefined();

    const sandboxApps = Array.from(cf.state.containerApps.values()).filter((a) =>
      a.name.endsWith('-platform-sandbox'),
    );
    expect(sandboxApps).toHaveLength(0);

    const workerDeletes = cf.state.recordedCalls.filter(
      (c) =>
        c.method === 'DELETE' &&
        c.url.includes('/workers/dispatch/') &&
        c.url.includes(`/scripts/user-${project.slug}-`),
    );
    expect(workerDeletes.length).toBeGreaterThanOrEqual(1);
    const containerDeletes = cf.state.recordedCalls.filter(
      (c) => c.method === 'DELETE' && c.url.includes('/containers/applications/'),
    );
    expect(containerDeletes.length).toBeGreaterThanOrEqual(1);
  });

  it('mock regression: cross-script DO binding referencing a non-existent dispatch-namespace script returns CF error (validates the architectural constraint)', async () => {
    mockCfApi();

    // Decision: The mock's uploadWorker validator rejects a cross-script DO binding to a dispatch script that
    // doesn't exist, as the real CF API does. That's the architectural reason per-deploy avoids
    // cross-script bindings.
    const metadata = {
      main_module: 'index.js',
      compatibility_date: '2024-01-01',
      bindings: [
        {
          type: 'durable_object_namespace',
          name: 'SANDBOX',
          class_name: 'Sandbox',
          script_name: 'no-such-host',
        },
      ],
    };

    const formData = new FormData();
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    formData.append(
      'index.js',
      new Blob(['export default {}'], { type: 'application/javascript+module' }),
    );

    const res = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/test-account-id/workers/dispatch/namespaces/platform-users/scripts/user-some-test-dpl_test',
      { method: 'PUT', headers: { Authorization: 'Bearer test' }, body: formData },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      success: boolean;
      errors: Array<{ code: number; message: string }>;
    };
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe(10_061);
    expect(body.errors[0].message).toMatch(/Cannot create binding for class in script/);
  });

  // Decision: CF rejects all cross-script DO bindings between dispatch namespace scripts, even when the target
  // exists and is container-enabled.
  it('mock regression: cross-script DO binding to an EXISTING dispatch-namespace script is also rejected with 10061', async () => {
    const cf = mockCfApi();

    cf.seedHostScript({
      scriptName: 'do-host-existing',
      classes: { Sandbox: 'ns_seeded' },
      migrationTag: 'sandbox-v1',
      metadata: {
        containers: [{ class_name: 'Sandbox' }],
      },
    });

    const metadata = {
      main_module: 'index.js',
      compatibility_date: '2024-01-01',
      bindings: [
        {
          type: 'durable_object_namespace',
          name: 'SANDBOX',
          class_name: 'Sandbox',
          script_name: 'do-host-existing',
        },
      ],
    };

    const formData = new FormData();
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    formData.append(
      'index.js',
      new Blob(['export default {}'], { type: 'application/javascript+module' }),
    );

    const res = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/test-account-id/workers/dispatch/namespaces/platform-users/scripts/user-x-dpl_test',
      { method: 'PUT', headers: { Authorization: 'Bearer test' }, body: formData },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      success: boolean;
      errors: Array<{ code: number; message: string }>;
    };
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe(10_061);
    expect(body.errors[0].message).toMatch(/do-host-existing/);
  });

  it('mock regression: 2nd container POST for the same namespace_id returns CF code 1608 DURABLE_OBJECT_ALREADY_HAS_APPLICATION', async () => {
    const cf = mockCfApi();

    cf.seedContainerApp({
      name: 'first-app',
      namespaceId: 'ns_shared',
      image: SANDBOX_IMAGE_V1,
      maxInstances: 20,
    });

    const res = await fetch(
      'https://api.cloudflare.com/client/v4/test-account-id/containers/applications',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'second-app',
          scheduling_policy: 'default',
          configuration: { image: SANDBOX_IMAGE_V1, instance_type: 'lite' },
          max_instances: 20,
          durable_objects: { namespace_id: 'ns_shared' },
        }),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; errors: Array<{ code: number }> };
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe(1608);
  });

  it('project teardown deletes per-deploy container apps for ALL retained deployments via deterministic-name orphan recovery', async () => {
    skipOrphanSweepDelay();
    const user = await createTestUser(env.db, 'sb-td-user', 'github', undefined, 'solo');
    const project = await createTestProject(env.db, user.id, 'sb-teardown');
    const cf = mockCfApi();
    await env.ROUTING.put(
      `project:${project.id}`,
      JSON.stringify({ userId: user.id, plan: 'solo' }),
    );

    const res1 = await deploy(project.id, user.jwt);
    expect(res1.status).toBe(200);
    const done1 = getDoneEvent(await readAllEvents(res1));
    expect(done1).toBeDefined();
    const v1Id = done1!.deployment;
    const v1ContainerName = `${project.id}-${v1Id}-platform-sandbox`
      .toLowerCase()
      .replaceAll('_', '-');

    const res2 = await deploy(project.id, user.jwt);
    expect(res2.status).toBe(200);
    const done2 = getDoneEvent(await readAllEvents(res2));
    expect(done2).toBeDefined();
    const v2Id = done2!.deployment;
    const v2ContainerName = `${project.id}-${v2Id}-platform-sandbox`
      .toLowerCase()
      .replaceAll('_', '-');

    expect(
      Array.from(cf.state.containerApps.values()).some((a) => a.name === v1ContainerName),
    ).toBe(true);
    expect(
      Array.from(cf.state.containerApps.values()).some((a) => a.name === v2ContainerName),
    ).toBe(true);

    const delRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(delRes.status).toBe(200);
    expect(await env.ROUTING.get(`project:${project.id}`)).toBeNull();

    expect(
      Array.from(cf.state.containerApps.values()).some((a) => a.name === v1ContainerName),
    ).toBe(false);
    expect(
      Array.from(cf.state.containerApps.values()).some((a) => a.name === v2ContainerName),
    ).toBe(false);

    const remainingResources = await env.db
      .select()
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(remainingResources).toHaveLength(0);
    const [proj] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(proj).toBeUndefined();
  });

  it('sandbox deploy keeps the usage queue and account identity out of the tenant while injecting one __PLATFORM_PROXY', async () => {
    const user = await createTestUser(env.db, 'sb-p6-user', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id, 'sb-p6');
    const cf = mockCfApi();

    const res = await deploy(project.id, user.jwt);
    expect(res.status).toBe(200);
    const done = getDoneEvent(await readAllEvents(res));
    expect(done).toBeDefined();
    const deployId = done!.deployment;

    const userWorker = cf.state.hostScripts.get(`user-${project.slug}-${deployId}`);
    expect(userWorker).toBeDefined();
    const bindings = userWorker!.bindings;

    // Decision: Metering comes from the trusted API lease counter. Tenant Workers don't get producer authority,
    // sandbox-enabled apps included.
    const queueBindings = bindings.filter(
      (b) => b.type === 'queue' && b.name === 'USAGE_EVENTS_QUEUE',
    );
    expect(queueBindings).toHaveLength(0);

    const proxyBindings = bindings.filter(
      (b) => b.type === 'service' && b.name === '__PLATFORM_PROXY',
    );
    expect(proxyBindings).toHaveLength(1);

    const userIdBinding = bindings.find((b) => b.name === '__PLATFORM_USER_ID');
    expect(userIdBinding).toBeUndefined();

    const projectIdBinding = bindings.find((b) => b.name === '__PROJECT_ID');
    expect(projectIdBinding).toBeDefined();
    expect(projectIdBinding!.type).toBe('plain_text');
    expect((projectIdBinding as { text?: string }).text).toBe(project.id);

    const slugBindings = bindings.filter((b) => b.name === '__PLATFORM_PROJECT_SLUG');
    expect(slugBindings).toEqual([
      { type: 'plain_text', name: '__PLATFORM_PROJECT_SLUG', text: project.slug },
    ]);
  });

  it('managed Sandbox deploy does not publish the retired proxy account mirror', async () => {
    const user = await createTestUser(env.db, 'sb-p6-kv-user', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id, 'sb-p6-kv');
    mockCfApi();

    const res = await deploy(project.id, user.jwt);
    expect(res.status).toBe(200);
    const done = getDoneEvent(await readAllEvents(res));
    expect(done).toBeDefined();

    const raw = await env.ROUTING.get(`project:${project.id}`);
    expect(raw).toBeNull();
  });

  it('ordinary Worker deploy does not publish the retired proxy account mirror', async () => {
    const user = await createTestUser(env.db, 'sb-p6-nosb-user', 'github', undefined, 'solo');
    const project = await createTestProject(env.db, user.id, 'sb-p6-nosb');
    const cf = mockCfApi();

    const workerSource = "export default { fetch() { return new Response('ok'); } }";
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: { version: 3, assetManifestVersion: 2, bindings: {} },
          assetManifest: {},
          source: null,
          commit: null,
          repositoryUrl: null,
          commitUrl: null,
          gitRef: null,
          preflight: null,
          workerFiles: {
            'index.js': bytesToBase64(new TextEncoder().encode(workerSource)),
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // Decision: Drain the NDJSON stream so the deploy pipeline runs to completion (routing switch and DB
    // finalize). Without this the assertion races the pipeline and reads KV before `ROUTING.put` fires.
    const done = getDoneEvent(await readAllEvents(res));
    expect(done).toBeDefined();
    expect(cf.mock.calls.some(([url]) => String(url).includes('/containers/'))).toBe(false);

    const raw = await env.ROUTING.get(`project:${project.id}`);
    expect(raw).toBeNull();
  });

  it('accepts basic sandbox instanceType at deploy validation', async () => {
    const user = await createTestUser(env.db, 'sb-basic-user', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id, 'sb-basic-size');
    mockCfApi();

    const res = await deploy(project.id, user.jwt, buildSandboxManifest({ instanceType: 'basic' }));
    expect(res.status).toBe(200);
    expect(getDoneEvent(await readAllEvents(res))).toBeDefined();
  });

  it('rejects manifest.sandbox for static/spa deployments at validation time', async () => {
    const user = await createTestUser(env.db, 'sb-p6-static-user', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id, 'sb-p6-static');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: {
            version: 3,
            assetManifestVersion: 2,
            bindings: {},
            type: 'static',
            sandbox: {
              bindingName: 'SANDBOX',
              className: 'Sandbox',
              containerName: 'platform-sandbox',
              image: SANDBOX_IMAGE_V1,
            },
          },
          assetManifest: {},
          source: null,
          commit: null,
          repositoryUrl: null,
          commitUrl: null,
          gitRef: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { event: string; message: string };
    expect(body.event).toBe('error');
    expect(body.message).toContain('sandbox is not supported for static/spa deployments');
  });
});
