import { eq, sql } from 'drizzle-orm';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import { cancelDeployment } from '../../src/db.ts';
import rawApp from '../../src/index.ts';
import * as projectIngress from '../../src/project-ingress.ts';
import { deployments, projects } from '../../src/schema.ts';
import { STATIC_RETENTION_LIMIT } from '../../src/tiers.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  cfSuccess,
  readAllEvents,
  rpcData,
  withLegacyDeploy,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

const app = withLegacyDeploy(rawApp);

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
});

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

function mockSetTimeout() {
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: TimerHandler,
    ...args: Array<unknown>
  ) => nativeSetTimeout(fn, 0, ...args)) as typeof setTimeout);
}

const HASH = (n: number): string => n.toString(16).padStart(32, '0');
const MD5 = HASH;

// Decision: Synthetic 32-hex blake3 and md5 strings. The deploy pipeline only checks the shape (32 hex)
// and looks up bytes at `assets/${projectId}/${blake3}`, so tests put the bytes into the R2 mock
// at that key and don't need real hashes.
async function stageAssetInR2(
  bucket: R2Bucket,
  projectId: string,
  blake3: string,
  bytes: Uint8Array,
): Promise<void> {
  await bucket.put(
    `assets/${projectId}/${blake3}`,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

type DeployEventBase = {
  event: string;
};
function isEvent(v: unknown, name: string): v is DeployEventBase {
  return typeof v === 'object' && v !== null && (v as DeployEventBase).event === name;
}

describe('POST /projects/:id/deploy/upload-urls', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/rpc/deploy.uploadUrls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj_x', assets: [] }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for nonexistent project', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      new Request('http://localhost/rpc/deploy.uploadUrls', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ projectId: 'proj_missing', assets: [] }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 for foreign project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-app-uu');
    const res = await app.fetch(
      new Request(`http://localhost/rpc/deploy.uploadUrls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bob.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ projectId: project.id, assets: [] }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('issues presigned URLs for valid asset entries', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uu-happy');
    const res = await app.fetch(
      new Request(`http://localhost/rpc/deploy.uploadUrls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
          'X-Platform-CLI-Version': '0.8.3',
        },
        body: JSON.stringify({
          projectId: project.id,
          assets: [
            { blake3: HASH(1), md5: MD5(2), size: 10, contentType: 'text/html' },
            { blake3: HASH(3), md5: MD5(4), size: 20, contentType: 'application/javascript' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = rpcData(await res.json()) as {
      urls: Record<string, { url: string; headers: Record<string, string> }>;
    };
    expect(Object.keys(body.urls)).toEqual(expect.arrayContaining([HASH(1), HASH(3)]));
    const first = body.urls[HASH(1)];
    expect(first).toBeDefined();
    expect(first.url).toContain(`/${env.R2_STATIC_ASSETS_BUCKET}/assets/${project.id}/${HASH(1)}`);
    expect(first.headers['Content-Md5']).toBeDefined();
    expect(first.headers['Content-Type']).toBe('text/html');
    const url1 = new URL(first.url);
    expect(url1.searchParams.get('X-Amz-Expires')).toBe('1800');
    const url2 = new URL(body.urls[HASH(3)].url);
    expect(url2.searchParams.get('X-Amz-Expires')).toBe('1800');
  });

  it('rejects malformed blake3', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uu-bad-b3');
    const res = await app.fetch(
      new Request(`http://localhost/rpc/deploy.uploadUrls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectId: project.id,
          assets: [{ blake3: 'not-hex', md5: MD5(1), size: 1, contentType: 'text/plain' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  it('rejects malformed md5', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uu-bad-md5');
    const res = await app.fetch(
      new Request(`http://localhost/rpc/deploy.uploadUrls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectId: project.id,
          assets: [{ blake3: HASH(1), md5: 'short', size: 1, contentType: 'text/plain' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  it('rejects negative size', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uu-bad-size');
    const res = await app.fetch(
      new Request(`http://localhost/rpc/deploy.uploadUrls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectId: project.id,
          assets: [{ blake3: HASH(1), md5: MD5(2), size: -1, contentType: 'text/plain' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 410 when status flips to deleting between unlocked check and FOR SHARE re-read', async () => {
    const { setGetProjectOverride } = await import('./setup.ts');
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uu-race');

    let calls = 0;
    setGetProjectOverride(({ original, argsList }) => {
      calls++;
      return original(...argsList).then((p) => (p ? { ...p, status: 'deleting' as const } : p));
    });

    try {
      const res = await app.fetch(
        new Request(`http://localhost/rpc/deploy.uploadUrls`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            assets: [{ blake3: HASH(1), md5: MD5(2), size: 10, contentType: 'text/html' }],
          }),
        }),
        env,
      );
      expect(res.status).toBe(410);
      const body = (await res.json()) as { error: { message: string }; urls?: unknown };
      expect(body.error.message).toMatch(/being deleted/);
      expect(body.urls).toBeUndefined();
      expect(calls).toBe(1);
    } finally {
      setGetProjectOverride(null);
    }
  });

  // Decision: A teardown that commits after the unlocked early-out check but before the FOR SHARE lock
  // must still give 410 from the re-read inside the transaction. Without it, the handler issues
  // presigned PUT URLs for a project being deleted, and the CLI writes orphan bytes. The unlocked
  // read comes from the central project-access query, so intercepting the direct `getProject` call
  // inside the transaction lets only the locked read see `status='deleting'`.
  it('returns 410 for projects with status=deleting and never presigns bytes', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uu-deleting');
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const res = await app.fetch(
      new Request(`http://localhost/rpc/deploy.uploadUrls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectId: project.id,
          assets: [{ blake3: HASH(1), md5: MD5(2), size: 10, contentType: 'text/html' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { message: string }; urls?: unknown };
    expect(body.error.message).toMatch(/being deleted/);
    expect(body.urls).toBeUndefined();
  });
});

describe('POST /projects/:id/deploy (JSON mode — direct-to-R2)', () => {
  function v2Manifest(extra: Record<string, unknown> = {}) {
    return {
      version: 3,
      assetManifestVersion: 2,
      bindings: {},
      ...extra,
    };
  }

  it('reuses scoped R2 bytes for Workers, including renamed files and resumed uploads', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'worker-reuse');
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, HASH(1), new Uint8Array(12));
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, HASH(2), new Uint8Array(7));
    await stageAssetInR2(env.STATIC_ASSETS_R2, 'other-project', HASH(3), new Uint8Array(12));
    await env.STATIC_ASSETS.put(`assets/${project.id}/${HASH(4)}`, new Uint8Array(12).buffer);
    const res = await app.fetch(
      new Request(`http://localhost/rpc/deploy.preflight`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          hasWorker: true,
          assetManifest: {
            '/renamed.js': { hash: HASH(1), size: 12 },
            '/duplicate.js': { hash: HASH(1), size: 12 },
            '/wrong-size.js': { hash: HASH(2), size: 12 },
            '/foreign.js': { hash: HASH(3), size: 12 },
            '/legacy-kv.js': { hash: HASH(4), size: 12 },
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(rpcData(await res.json())).toEqual({
      needed: ['/wrong-size.js', '/foreign.js', '/legacy-kv.js'],
      total: 5,
      skipped: 2,
    });
  });

  it.each([false, true])(
    'skips scoped R2 inventory for unchanged assets with hasWorker=%s',
    async (hasWorker) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-active-reuse');
      const reusedHash = HASH(0x41);
      const missingHash = HASH(0x42);
      await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, reusedHash, new Uint8Array(12));
      const liveId = 'dpl_worker_active_reuse';
      await env.db.insert(deployments).values({
        id: liveId,
        project_id: project.id,
        status: 'live',
        manifest: JSON.stringify(v2Manifest({ type: 'platform' })),
        asset_hashes: JSON.stringify({
          '/app.js': { hash: reusedHash, size: 12, store: 'r2', scope: 'project' },
        }),
        created_at: sql`now()`,
        deployed_at: sql`now()`,
      });
      await env.db
        .update(projects)
        .set({ active_deployment_id: liveId })
        .where(eq(projects.id, project.id));
      const head = vi.spyOn(env.STATIC_ASSETS_R2, 'head');
      const list = vi.spyOn(env.STATIC_ASSETS_R2, 'list');

      const res = await app.fetch(
        new Request(`http://localhost/rpc/deploy.preflight`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: project.id,
            hasWorker,
            assetManifest: {
              '/app.js': { hash: reusedHash, size: 12 },
              '/renamed.js': { hash: reusedHash, size: 12 },
              '/wrong-size.js': { hash: reusedHash, size: 13 },
              '/missing.js': { hash: missingHash, size: 5 },
            },
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      expect(rpcData(await res.json())).toEqual({
        needed: ['/wrong-size.js', '/missing.js'],
        total: 4,
        skipped: 2,
      });
      expect(head.mock.calls).toEqual([
        [`assets/${project.id}/${reusedHash}`],
        [`assets/${project.id}/${missingHash}`],
      ]);
      expect(list).not.toHaveBeenCalled();
    },
  );

  it('finalizes an unchanged Worker asset without scanning the R2 prefix', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'worker-finalize-reuse');
    const hash = HASH(0x43);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, hash, new Uint8Array(12));
    const liveId = 'dpl_worker_finalize_reuse';
    await env.db.insert(deployments).values({
      id: liveId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(v2Manifest({ type: 'platform' })),
      asset_hashes: JSON.stringify({
        '/app.js': { hash, size: 12, store: 'r2', scope: 'project' },
      }),
      created_at: sql`now()`,
      deployed_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveId })
      .where(eq(projects.id, project.id));
    mockCfApi();
    const head = vi.spyOn(env.STATIC_ASSETS_R2, 'head');
    const originalList = env.STATIC_ASSETS_R2.list.bind(env.STATIC_ASSETS_R2);
    let releaseList: (() => void) | undefined;
    const assetPrefix = `assets/${project.id}/`;
    const list = vi.spyOn(env.STATIC_ASSETS_R2, 'list').mockImplementation(async (options) => {
      if (options?.prefix === assetPrefix) {
        await new Promise<void>((resolve) => {
          releaseList = resolve;
        });
      }
      return originalList(options);
    });
    const pending: Array<Promise<unknown>> = [];
    const executionCtx = {
      waitUntil: (work: Promise<unknown>) => pending.push(work),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({ fetch: async () => Response.json({ ready: true }) }),
    } as unknown as DispatchNamespace;
    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'platform' }),
            assetManifest: { '/app.js': { blake3: hash, md5: MD5(0x43), size: 12 } },
            workerFiles: {
              'index.js': btoa('export default { fetch() { return new Response("ok"); } };'),
            },
            preflight: 'true',
          }),
        }),
        env,
        executionCtx,
      );
      const events = await readAllEvents(res);
      expect(events.find((event) => isEvent(event, 'error'))).toBeUndefined();
      expect(events.find((event) => isEvent(event, 'done'))).toBeDefined();
      expect(head).not.toHaveBeenCalled();
      expect(pending).toHaveLength(1);
      await vi.waitFor(() =>
        expect(list.mock.calls.filter(([options]) => options?.prefix === assetPrefix)).toHaveLength(
          1,
        ),
      );
    } finally {
      releaseList?.();
      await Promise.allSettled(pending);
      env.DISPATCH = originalDispatch;
    }
  });

  it('protects reused Worker assets from GC before verifying their presence', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'worker-reuse-protected');
    const hash = HASH(8);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, hash, new Uint8Array(12));
    mockCfApi();
    const head = env.STATIC_ASSETS_R2.head.bind(env.STATIC_ASSETS_R2);
    let sawProtected = false;
    vi.spyOn(env.STATIC_ASSETS_R2, 'head').mockImplementation(async (key) => {
      if (key === `assets/${project.id}/${hash}` && !sawProtected) {
        const rows = await env.db
          .select()
          .from(deployments)
          .where(eq(deployments.project_id, project.id));
        const admitted = rows.find((row) => row.status === 'pending' && row.manifest === null);
        expect(admitted).toBeDefined();
        expect(JSON.parse(admitted!.asset_hashes!)).toEqual({ '/app.js': { hash, size: 12 } });
        sawProtected = true;
      }
      return head(key);
    });
    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({ fetch: async () => Response.json({ ready: true }) }),
    } as unknown as DispatchNamespace;
    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'platform' }),
            assetManifest: { '/app.js': { blake3: hash, md5: MD5(8), size: 12 } },
            workerFiles: {
              'index.js': btoa('export default { fetch() { return new Response("ok"); } };'),
            },
            preflight: 'true',
          }),
        }),
        env,
      );
      const events = await readAllEvents(res);
      expect(events.find((event) => isEvent(event, 'error'))).toBeUndefined();
      expect(events.find((event) => isEvent(event, 'done'))).toBeDefined();
      expect(sawProtected).toBe(true);
    } finally {
      env.DISPATCH = originalDispatch;
    }
  });

  it('rejects a stale reuse decision before uploading a Worker and releases the claim', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'worker-reuse-missing');
    const hash = HASH(9);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, hash, new Uint8Array(12));
    const preflight = await app.fetch(
      new Request(`http://localhost/rpc/deploy.preflight`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          hasWorker: true,
          assetManifest: { '/app.js': { hash, size: 12 } },
        }),
      }),
      env,
    );
    expect(rpcData(await preflight.json())).toMatchObject({ needed: [], skipped: 1 });
    await env.STATIC_ASSETS_R2.delete(`assets/${project.id}/${hash}`);
    const cf = mockCfApi();
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'platform' }),
          assetManifest: { '/app.js': { blake3: hash, md5: MD5(9), size: 12 } },
          workerFiles: { 'index.js': btoa('export default {};') },
          preflight: 'true',
        }),
      }),
      env,
    );
    const events = await readAllEvents(res);
    expect(events.find((event) => isEvent(event, 'done'))).toBeUndefined();
    expect(events.find((event) => isEvent(event, 'error'))).toMatchObject({ step: 'asset_verify' });
    expect(
      cf.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT'),
    ).toBe(false);
    expect(
      await env.db.select().from(deployments).where(eq(deployments.project_id, project.id)),
    ).toHaveLength(0);
  });

  it('static deploy with all assets pre-uploaded reaches live', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-static-ok');
    mockCfApi();

    const indexBytes = new TextEncoder().encode('<h1>hi</h1>');
    const cssBytes = new TextEncoder().encode('body { color: red }');
    const indexHash = HASH(0x10_10);
    const cssHash = HASH(0x20_20);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, indexBytes);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, cssHash, cssBytes);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
          'X-Platform-CLI-Version': '0.8.3',
        },
        body: JSON.stringify({
          manifest: v2Manifest({
            type: 'spa',
            assetConfig: { not_found_handling: 'single-page-application' },
          }),
          assetManifest: {
            '/index.html': { blake3: indexHash, md5: MD5(0x10_11), size: indexBytes.byteLength },
            '/assets/style.css': {
              blake3: cssHash,
              md5: MD5(0x20_21),
              size: cssBytes.byteLength,
            },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const start = events.find((e) => isEvent(e, 'start'));
    const done = events.find((e) => isEvent(e, 'done'));
    expect(start).toBeDefined();
    expect(done).toBeDefined();
    // Decision: Only the asset GC list is held back. ISR cleanup uses the same bucket with another prefix.
    const doneEvt = done as unknown as { url: string; assets: number };
    expect(doneEvt.assets).toBe(2);
    expect(doneEvt.url).toBe('https://jm-static-ok.buildwf.dev');

    const [dpl] = await env.db
      .select({ cli_version: deployments.cli_version, status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpl?.status).toBe('live');
    expect(dpl?.cli_version).toBe('0.8.3');

    const serving = (await env.ROUTING.get(
      `manifest:${(doneEvt as unknown as { deployment: string }).deployment}`,
      'json',
    )) as Record<string, string> | null;
    expect(serving).toEqual({
      '/index.html': `!${indexHash}`,
      '/assets/style.css': `!${cssHash}`,
    });
  });

  it('static deploy sweeps R2 assets/{projectId}/* orphans that were uploaded but never referenced', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-orphan-sweep');
    mockCfApi();

    const indexBytes = new TextEncoder().encode('<h1>kept</h1>');
    const indexHash = HASH(0x4a_4a);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, indexBytes);

    const orphanHash = HASH(0xde_ad);
    const orphanKey = `assets/${project.id}/${orphanHash}`;
    await stageAssetInR2(
      env.STATIC_ASSETS_R2,
      project.id,
      orphanHash,
      new TextEncoder().encode('orphaned bytes'),
    );
    // Decision: Two hours leaves headroom over the 3600s protection window and survives small clock jitter.
    (
      env.STATIC_ASSETS_R2 as unknown as { setUploadedAt: (k: string, d: Date) => void }
    ).setUploadedAt(orphanKey, new Date(Date.now() - 2 * 3600 * 1000));

    const otherKey = 'assets/proj_other/cccccccccccccccccccccccccccccccc';
    await env.STATIC_ASSETS_R2.put(otherKey, new Uint8Array([9, 9, 9]).buffer as ArrayBuffer);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({
            type: 'spa',
            assetConfig: { not_found_handling: 'single-page-application' },
          }),
          assetManifest: {
            '/index.html': { blake3: indexHash, md5: MD5(0x4a_4b), size: indexBytes.byteLength },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    expect(events.find((e) => isEvent(e, 'done'))).toBeDefined();

    expect(await env.STATIC_ASSETS_R2.head(`assets/${project.id}/${indexHash}`)).not.toBeNull();
    expect(await env.STATIC_ASSETS_R2.head(orphanKey)).toBeNull();
    expect(await env.STATIC_ASSETS_R2.head(otherKey)).not.toBeNull();
  });

  it.each([
    { mode: 'spa', retained: false, failBundleDelete: false },
    { mode: 'spa', retained: true, failBundleDelete: false },
    { mode: 'platform', retained: true, failBundleDelete: false },
    { mode: 'platform', retained: true, failBundleDelete: true },
  ] as const)(
    'protects stored-history assets until bundle eviction: $mode, retained=$retained, delete failure=$failBundleDelete',
    async ({ mode, retained, failBundleDelete }) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'stored-asset-gc');
      mockCfApi();
      const storedId = 'dpl_stored_asset_history';
      const oldHash = HASH(0x4a_50);
      const oldKey = `assets/${project.id}/${oldHash}`;
      const bundleKey = `worker-bundles/${project.id}/${storedId}/index.js`;
      await stageAssetInR2(
        env.STATIC_ASSETS_R2,
        project.id,
        oldHash,
        new TextEncoder().encode('migrated history'),
      );
      await env.STATIC_ASSETS_R2.put(bundleKey, 'export default {};');
      (
        env.STATIC_ASSETS_R2 as unknown as { setUploadedAt: (key: string, value: Date) => void }
      ).setUploadedAt(oldKey, new Date(Date.now() - 2 * 3600 * 1000));
      await env.db.insert(deployments).values({
        id: storedId,
        project_id: project.id,
        status: retained ? 'live' : 'failed',
        retained,
        bundle_stored: true,
        manifest: JSON.stringify(v2Manifest({ type: 'platform' })),
        asset_hashes: JSON.stringify({
          '/history.js': { hash: oldHash, size: 16, store: 'r2', scope: 'project' },
        }),
        created_at: sql`now() - interval '2 hours'`,
        deployed_at: retained ? sql`now() - interval '2 hours'` : null,
      });
      if (retained) {
        if (mode === 'spa') {
          await env.db.insert(deployments).values(
            Array.from({ length: STATIC_RETENTION_LIMIT - 1 }, (_, index) => ({
              id: `dpl_newer_stored_history_${index}`,
              project_id: project.id,
              status: 'live' as const,
              retained: true,
              created_at: sql`now() - interval '1 hour'`,
              deployed_at: sql`now() - interval '1 hour'`,
            })),
          );
        }
        await env.db
          .update(projects)
          .set({ active_deployment_id: storedId })
          .where(eq(projects.id, project.id));
        await env.ROUTING.put(
          project.slug,
          JSON.stringify({
            projectId: project.id,
            userId: user.id,
            deploymentId: storedId,
            workerName: `user-${project.slug}-${storedId}`,
            type: 'platform',
          }),
        );
      }
      if (failBundleDelete) {
        const remove = env.STATIC_ASSETS_R2.delete.bind(env.STATIC_ASSETS_R2);
        vi.spyOn(env.STATIC_ASSETS_R2, 'delete').mockImplementation(async (keys) => {
          if ((typeof keys === 'string' ? [keys] : keys).includes(bundleKey)) {
            throw new Error('bundle deletion unavailable');
          }
          await remove(keys);
        });
      }
      const newHash = HASH(0x4a_51);
      const bytes = new TextEncoder().encode('current asset');
      await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, newHash, bytes);
      const originalDispatch = env.DISPATCH;
      env.DISPATCH = {
        get: () => ({ fetch: async () => Response.json({ ready: true }) }),
      } as unknown as DispatchNamespace;
      try {
        const response = await app.fetch(
          new Request(`http://localhost/projects/${project.id}/deploy`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              manifest: v2Manifest({ type: mode }),
              assetManifest: {
                '/index.html': { blake3: newHash, md5: MD5(0x4a_51), size: bytes.length },
              },
              ...(mode === 'platform'
                ? { workerFiles: { 'index.js': btoa('export default {};') } }
                : {}),
            }),
          }),
          env,
        );
        const events = await readAllEvents(response);
        expect(events.find((event) => isEvent(event, 'error'))).toBeUndefined();
        expect(events.find((event) => isEvent(event, 'done'))).toBeDefined();
        const preserve = !retained || failBundleDelete;
        const history = (
          await env.db.select().from(deployments).where(eq(deployments.id, storedId))
        )[0];
        expect(history?.bundle_stored).toBe(preserve);
        expect(history?.retained).toBe(false);
        expect(Boolean(await env.STATIC_ASSETS_R2.head(bundleKey))).toBe(preserve);
        expect(Boolean(await env.STATIC_ASSETS_R2.head(oldKey))).toBe(preserve);
      } finally {
        env.DISPATCH = originalDispatch;
      }
    },
  );

  it('static deploy preserves recently-uploaded R2 orphans within the pending-upload protection window', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-orphan-recent');
    mockCfApi();

    const indexBytes = new TextEncoder().encode('<h1>kept</h1>');
    const indexHash = HASH(0x4b_4b);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, indexBytes);

    // Decision: MemoryR2Bucket stamps `uploaded = new Date()` on put, so this orphan counts as just uploaded
    // without an override.
    const recentOrphanHash = HASH(0xbe_ef);
    const recentOrphanKey = `assets/${project.id}/${recentOrphanHash}`;
    await stageAssetInR2(
      env.STATIC_ASSETS_R2,
      project.id,
      recentOrphanHash,
      new TextEncoder().encode('in-flight bytes'),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({
            type: 'spa',
            assetConfig: { not_found_handling: 'single-page-application' },
          }),
          assetManifest: {
            '/index.html': { blake3: indexHash, md5: MD5(0x4b_4c), size: indexBytes.byteLength },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    expect(events.find((e) => isEvent(e, 'done'))).toBeDefined();

    expect(await env.STATIC_ASSETS_R2.head(`assets/${project.id}/${indexHash}`)).not.toBeNull();
    expect(await env.STATIC_ASSETS_R2.head(recentOrphanKey)).not.toBeNull();
  });

  it('static deploy fails 4xx-style with missing-hash error when an asset is not in R2', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-static-miss');
    mockCfApi();

    const presentHash = HASH(0xa0_a0);
    await stageAssetInR2(
      env.STATIC_ASSETS_R2,
      project.id,
      presentHash,
      new TextEncoder().encode('present'),
    );
    const missingHash = HASH(0xde_ad);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'spa' }),
          assetManifest: {
            '/index.html': { blake3: presentHash, md5: MD5(0xa0_a1), size: 7 },
            '/missing.css': { blake3: missingHash, md5: MD5(0xde_ae), size: 12 },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errEvt = events.find((e) => isEvent(e, 'error')) as
      | { event: 'error'; message: string }
      | undefined;
    expect(errEvt).toBeDefined();
    expect(errEvt!.message).toContain(missingHash);
    const rows = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    for (const r of rows) {
      expect(r.status).not.toBe('live');
    }
  });

  it('WfP deploy with workerFiles reaches live', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-wfp-ok');
    mockCfApi();

    const assetBytes = new TextEncoder().encode('export const helper = 1;');
    const assetHash = HASH(0xb1_b1);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, assetHash, assetBytes);
    await env.STATIC_ASSETS_R2.put(`assets/${assetHash}`, new TextEncoder().encode('legacy bytes'));
    const r2Get = vi.spyOn(env.STATIC_ASSETS_R2, 'get');
    const kvGet = vi.spyOn(env.STATIC_ASSETS, 'get');

    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({
        fetch: async () => Response.json({ ready: true }),
      }),
    } as unknown as DispatchNamespace;

    try {
      const indexJs = new TextEncoder().encode(
        "export default { fetch() { return new Response('ok'); } }",
      );
      let bin = '';
      for (let i = 0; i < indexJs.length; i++) {
        bin += String.fromCharCode(indexJs[i]);
      }
      const indexJsB64 = btoa(bin);

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'platform' }),
            assetManifest: {
              '/static/helper.js': {
                blake3: assetHash,
                md5: MD5(0xb1_b2),
                size: assetBytes.byteLength,
              },
            },
            source: null,
            commit: null,
            preflight: null,
            workerFiles: {
              'index.js': indexJsB64,
            },
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      const events = await readAllEvents(res);
      const done = events.find((e) => isEvent(e, 'done')) as unknown as
        | { deployment: string; workers: number }
        | undefined;
      expect(done).toBeDefined();
      expect(done!.workers).toBe(1);
      expect(r2Get.mock.calls.filter(([key]) => key.startsWith('assets/'))).toEqual([
        [`assets/${project.id}/${assetHash}`],
      ]);
      expect(kvGet).not.toHaveBeenCalled();
      const [dpl] = await env.db
        .select({ status: deployments.status })
        .from(deployments)
        .where(eq(deployments.project_id, project.id));
      expect(dpl?.status).toBe('live');
    } finally {
      env.DISPATCH = originalDispatch;
    }
  });

  it.each([false, true])(
    'requires reupload of historical unscoped R2 assets with hasWorker=%s',
    async (hasWorker) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'unscoped-r2-reupload');
      const hash = HASH(0xb1_b2);
      const bytes = new TextEncoder().encode('old unscoped asset');
      await env.STATIC_ASSETS_R2.put(`assets/${hash}`, bytes);
      const liveId = 'dpl_live_unscoped_r2';
      await env.db.insert(deployments).values({
        id: liveId,
        project_id: project.id,
        status: 'live',
        retained: true,
        manifest: JSON.stringify(v2Manifest({ type: hasWorker ? 'platform' : 'spa' })),
        asset_hashes: JSON.stringify({ '/app.js': { hash, size: bytes.length, store: 'r2' } }),
        created_at: sql`now()`,
        deployed_at: sql`now()`,
      });
      await env.db
        .update(projects)
        .set({ active_deployment_id: liveId })
        .where(eq(projects.id, project.id));
      const preflight = await app.fetch(
        new Request(`http://localhost/rpc/deploy.preflight`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: project.id,
            hasWorker,
            assetManifest: { '/app.js': { hash, size: bytes.length } },
          }),
        }),
        env,
      );
      expect(rpcData(await preflight.json())).toEqual({
        needed: ['/app.js'],
        total: 1,
        skipped: 0,
      });
      const ingress = vi.spyOn(projectIngress, 'ensureProjectIngress');
      const cf = mockCfApi();
      const response = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manifest: v2Manifest({ type: hasWorker ? 'platform' : 'spa' }),
            assetManifest: { '/app.js': { blake3: hash, md5: MD5(0xb1_b2), size: bytes.length } },
            ...(hasWorker ? { workerFiles: { 'index.js': btoa('export default {};') } } : {}),
          }),
        }),
        env,
      );
      const events = await readAllEvents(response);
      expect(events.find((event) => isEvent(event, 'error'))).toMatchObject({
        step: 'asset_verify',
      });
      expect(ingress).not.toHaveBeenCalled();
      expect(cf).not.toHaveBeenCalled();
      expect(
        (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0]
          ?.active_deployment_id,
      ).toBe(liveId);
    },
  );

  it('dedupe short-circuit fires when manifest matches the live deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-dedupe');
    mockCfApi();

    const indexBytes = new TextEncoder().encode('<h1>same</h1>');
    const indexHash = HASH(0xc1_c1);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, indexBytes);

    // Decision: The dedupe compares against the full enriched manifest stored on the live deployment row.
    // Enrichment is a no-op here (no websocket, no sandbox), so the plain manifest matches it.
    const liveId = 'dpl_live_jm_dedupe';
    const liveManifest = {
      version: 3,
      assetManifestVersion: 2,
      type: 'spa',
      bindings: {},
      assetConfig: { not_found_handling: 'single-page-application' },
    };
    const liveAssetManifest = {
      '/index.html': {
        hash: indexHash,
        size: indexBytes.byteLength,
        store: 'r2',
        scope: 'project',
      },
    };
    await env.db.insert(deployments).values({
      id: liveId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(liveManifest),
      asset_hashes: JSON.stringify(liveAssetManifest),
      created_at: sql`now()`,
      deployed_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveId })
      .where(eq(projects.id, project.id));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: liveManifest,
          assetManifest: {
            '/index.html': {
              blake3: indexHash,
              md5: MD5(0xc1_c2),
              size: indexBytes.byteLength,
            },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    expect(events.some((e) => isEvent(e, 'start'))).toBe(true);
    const done = events.find((e) => isEvent(e, 'done')) as unknown as
      | { deployment: string }
      | undefined;
    expect(done).toBeDefined();
    expect(done!.deployment).toBe(liveId);
  });

  it('cancellation between asset-verify and routing-switch lands in canceled', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-cancel');
    mockCfApi();

    const bytes = new TextEncoder().encode('<h1>cancel me</h1>');
    const indexHash = HASH(0xca_01);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    // Decision: Patch ROUTING.put to cancel on the slug write, so the cancel lands between the pre-routing
    // checks and the slug-route flip (the multipart cancel tests use the same trick).
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let cancelTriggered = false;
    let inFlightDeploymentId: string | undefined;
    let cancelPromise: Promise<unknown> | undefined;
    (env.ROUTING.put as unknown) = async (
      key: string,
      value: string,
      options?: { metadata?: unknown; expirationTtl?: number },
    ) => {
      if (key.startsWith('manifest:')) {
        inFlightDeploymentId = key.slice('manifest:'.length);
      }
      if (!cancelTriggered && key === project.slug) {
        cancelTriggered = true;
        // Decision: Queue the cancel behind the cutover's project-row lock. Awaiting it from this transaction-backed
        // KV mock would deadlock PGlite's single connection. The queued update runs when the thrown error
        // releases the cutover transaction.
        if (inFlightDeploymentId) {
          cancelPromise = cancelDeployment(env.db, inFlightDeploymentId, 'test cancel');
        }
        throw new Error('canceled before slug write');
      }
      return originalPut(key, value, options);
    };

    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'spa' }),
            assetManifest: {
              '/index.html': {
                blake3: indexHash,
                md5: MD5(0xca_02),
                size: bytes.byteLength,
              },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      await readAllEvents(res);
      await cancelPromise;
    } finally {
      (env.ROUTING.put as unknown) = originalPut;
    }

    // Decision: The exact terminal status depends on whether the cancel is seen before or after the slug-write
    // throw, so accept canceled or failed.
    const rows = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(['canceled', 'failed']).toContain(r.status);
    }
  });

  it('rejects assetManifestVersion !== 2', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-bad-v');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: { version: 3, bindings: {} },
          assetManifest: {},
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { event?: string; message?: string };
    expect(body.message).toContain('assetManifestVersion: 2');
  });

  it('rejects malformed blake3 in assetManifest', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-bad-am-b3');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'spa' }),
          assetManifest: {
            '/x': { blake3: 'too-short', md5: MD5(1), size: 1 },
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/blake3 must be 32 lowercase hex/);
  });

  it('rejects malformed md5 in assetManifest', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-bad-am-md5');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'spa' }),
          assetManifest: {
            '/x': { blake3: HASH(1), md5: 'short', size: 1 },
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/md5 must be 32 lowercase hex/);
  });

  it('rejects missing manifest', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-bad-no-mf');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ assetManifest: {} }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('decodes multi-entry workerFiles correctly (no per-entry corruption from delete-as-we-go)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-wfp-multi');
    const cf = mockCfApi();

    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({
        fetch: async () => Response.json({ ready: true }),
      }),
    } as unknown as DispatchNamespace;

    try {
      const modules: Record<string, Uint8Array> = {
        'index.js': new TextEncoder().encode(
          "export default { fetch() { return new Response('a'); } }",
        ),
        'worker-1.js': new TextEncoder().encode(
          "export default { fetch() { return new Response('bb'); } }",
        ),
        'worker-2.js': new TextEncoder().encode(
          "export default { fetch() { return new Response('ccc'); } }",
        ),
      };
      const b64 = (bytes: Uint8Array): string => {
        let bin = '';
        for (let i = 0; i < bytes.length; i++) {
          bin += String.fromCharCode(bytes[i]);
        }
        return btoa(bin);
      };
      const workerFiles: Record<string, string> = {};
      for (const [name, bytes] of Object.entries(modules)) {
        workerFiles[name] = b64(bytes);
      }

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'platform' }),
            assetManifest: {},
            source: null,
            commit: null,
            preflight: null,
            workerFiles,
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      const events = await readAllEvents(res);
      const done = events.find((e) => isEvent(e, 'done')) as unknown as
        | { deployment: string; workers: number }
        | undefined;
      expect(done).toBeDefined();
      expect(done!.workers).toBe(3);

      const upload = cf.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith('/scripts/user-' + project.slug + '-' + done!.deployment) &&
          (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(upload).toBeDefined();
      const form = (upload![1] as RequestInit).body as FormData;
      expect(form).toBeInstanceOf(FormData);
      for (const [name, expected] of Object.entries(modules)) {
        const file = form.get(name);
        expect(file).toBeInstanceOf(Blob);
        const uploaded = new Uint8Array(await (file as Blob).arrayBuffer());
        expect(uploaded).toEqual(expected);
      }
    } finally {
      env.DISPATCH = originalDispatch;
    }
  });

  it('accepts JSON-mode bodies larger than the legacy 32 MiB cap', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-big-body');
    mockCfApi();

    const rawSize = 27 * 1024 * 1024;
    const raw = new Uint8Array(rawSize);
    for (let i = 0; i < raw.length; i++) {
      raw[i] = i & 0xff;
    }
    let bin = '';
    const chunk = 8192;
    for (let i = 0; i < raw.length; i += chunk) {
      bin += String.fromCharCode(...raw.subarray(i, Math.min(i + chunk, raw.length)));
    }
    const b64 = btoa(bin);
    expect(b64.length).toBeGreaterThan(32 * 1024 * 1024);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'platform' }),
          assetManifest: {},
          workerFiles: { 'index.js': b64 },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );

    expect(res.status).not.toBe(413);
    // Decision: Finish the deployment's database work before the next fixture resets its tables.
    await res.text();
  });

  it('reuploads legacy KV assets on an unchanged static redeploy and preserves the old deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-static-kv-cf');
    mockCfApi();

    // Decision: The prior deploy stored this small asset in KV (no `!` prefix in the serving manifest), as the
    // multipart path does below KV_THRESHOLD. The R2 bucket is empty for this hash on purpose.
    const kvHash = HASH(0x41_01);
    const kvBytes = new TextEncoder().encode('<h1>kv-prior</h1>');
    const newR2Hash = HASH(0x41_02);
    const newR2Bytes = new TextEncoder().encode('body { color: blue }');
    await env.STATIC_ASSETS.put(
      `assets/${project.id}/${kvHash}`,
      kvBytes.buffer.slice(0, kvBytes.byteLength) as ArrayBuffer,
    );

    const liveId = 'dpl_live_jm_static_kv_cf';
    const liveManifest = {
      version: 3,
      assetManifestVersion: 2,
      type: 'spa',
      bindings: {},
      assetConfig: { not_found_handling: 'single-page-application' },
    };
    const liveAssetManifest = {
      '/index.html': { hash: kvHash, size: kvBytes.byteLength, store: 'kv' },
      '/style.css': { hash: newR2Hash, size: newR2Bytes.byteLength, store: 'r2' },
    };
    await env.db.insert(deployments).values({
      id: liveId,
      project_id: project.id,
      status: 'live',
      retained: true,
      manifest: JSON.stringify(liveManifest),
      asset_hashes: JSON.stringify(liveAssetManifest),
      created_at: sql`now()`,
      deployed_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveId })
      .where(eq(projects.id, project.id));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        staticDeploymentId: liveId,
        projectId: project.id,
        userId: user.id,
        type: 'spa',
      }),
    );
    const oldServingManifest = { '/index.html': kvHash, '/style.css': `!${newR2Hash}` };
    await env.ROUTING.put(`manifest:${liveId}`, JSON.stringify(oldServingManifest));

    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, newR2Hash, newR2Bytes);

    const headBefore = await env.STATIC_ASSETS_R2.head(`assets/${project.id}/${kvHash}`);
    expect(headBefore).toBeNull();

    const preflight = await app.fetch(
      new Request(`http://localhost/rpc/deploy.preflight`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, assetManifest: liveAssetManifest }),
      }),
      env,
    );
    expect(rpcData(await preflight.json())).toEqual({
      needed: ['/index.html'],
      total: 2,
      skipped: 1,
    });

    const request = () =>
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: liveManifest,
          assetManifest: {
            '/index.html': { blake3: kvHash, md5: MD5(0x41_03), size: kvBytes.byteLength },
            '/style.css': { blake3: newR2Hash, md5: MD5(0x41_04), size: newR2Bytes.byteLength },
          },
          preflight: 'true',
        }),
      });
    const ingress = vi.spyOn(projectIngress, 'ensureProjectIngress');
    const cf = mockCfApi();
    const missing = await app.fetch(request(), env);
    const missingEvents = await readAllEvents(missing);
    expect(missingEvents.find((event) => isEvent(event, 'error'))).toMatchObject({
      step: 'asset_verify',
    });
    expect(missingEvents.find((event) => isEvent(event, 'done'))).toBeUndefined();
    expect(ingress).not.toHaveBeenCalled();
    expect(
      cf.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT'),
    ).toBe(false);
    expect(await env.ROUTING.get(`manifest:${liveId}`, 'json')).toEqual(oldServingManifest);
    expect(
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0]
        ?.active_deployment_id,
    ).toBe(liveId);

    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, kvHash, kvBytes);
    const res = await app.fetch(request(), env);
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = events.find((e) => isEvent(e, 'done')) as unknown as
      | { deployment: string; assets: number }
      | undefined;
    const errEvt = events.find((e) => isEvent(e, 'error'));
    expect(errEvt).toBeUndefined();
    expect(done).toBeDefined();
    expect(done!.assets).toBe(2);

    expect(done!.deployment).not.toBe(liveId);
    const serving = (await env.ROUTING.get(`manifest:${done!.deployment}`, 'json')) as Record<
      string,
      string
    > | null;
    expect(serving).toEqual({
      '/index.html': `!${kvHash}`,
      '/style.css': `!${newR2Hash}`,
    });
    const fresh = (
      await env.db.select().from(deployments).where(eq(deployments.id, done!.deployment))
    )[0];
    expect(JSON.parse(fresh!.asset_hashes!)).toEqual({
      '/index.html': { hash: kvHash, size: kvBytes.byteLength, store: 'r2', scope: 'project' },
      '/style.css': { hash: newR2Hash, size: newR2Bytes.byteLength, store: 'r2', scope: 'project' },
    });
    expect(await env.ROUTING.get(`manifest:${liveId}`, 'json')).toEqual(oldServingManifest);
    expect(await env.STATIC_ASSETS.get(`assets/${project.id}/${kvHash}`, 'arrayBuffer')).toEqual(
      kvBytes.buffer,
    );
  });

  it('rejects workerFiles when manifest.type is spa', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-spa-no-worker');
    const indexJs = new TextEncoder().encode('export default { fetch() {} }');
    let bin = '';
    for (let i = 0; i < indexJs.length; i++) {
      bin += String.fromCharCode(indexJs[i]);
    }
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'spa' }),
          assetManifest: {},
          workerFiles: { 'index.js': btoa(bin) },
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/worker.*not allowed.*spa or static/);

    const rows = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(rows).toHaveLength(0);
  });

  it('rejects workerFiles when manifest.type is static', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-static-no-worker');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'static' }),
          assetManifest: {},
          workerFiles: { 'index.js': btoa('x') },
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/worker.*not allowed.*spa or static/);
  });

  it('placeholder reaper cleans up canceling rows when cancel races early-error path', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-cancel-early');
    mockCfApi();

    // Decision: R2.head() runs right after the placeholder insert, so flipping the placeholder to `canceling`
    // here simulates a cancelDeployment call that races the missing-hash early-error path.
    const originalHead = env.STATIC_ASSETS_R2.head.bind(env.STATIC_ASSETS_R2);
    let canceledOnce = false;
    env.STATIC_ASSETS_R2.head = (async (key: string) => {
      if (!canceledOnce) {
        canceledOnce = true;
        const rows = await env.db
          .select({ id: deployments.id, status: deployments.status })
          .from(deployments)
          .where(eq(deployments.project_id, project.id));
        if (rows.length > 0) {
          await cancelDeployment(env.db, rows[0].id, 'test cancel during asset_verify');
        }
      }
      return null;
    }) as typeof env.STATIC_ASSETS_R2.head;

    try {
      const missingHash = HASH(0x90_01);
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'spa' }),
            assetManifest: {
              '/index.html': { blake3: missingHash, md5: MD5(0x90_02), size: 5 },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      await readAllEvents(res);
    } finally {
      env.STATIC_ASSETS_R2.head = originalHead;
    }

    const finalRows = await env.db
      .select({ id: deployments.id, status: deployments.status, manifest: deployments.manifest })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    for (const r of finalRows) {
      expect(['canceling', 'pending']).not.toContain(r.status);
    }
  });
});

// Decision: Cloudflare's assets-upload-session body takes `{ <path>: { hash, size } }`. The CLI emits v2
// entries (`blake3`, `md5`, `size`, `hash`), so the normalizer at the CF API boundary strips
// the extra fields.
describe('CF asset-upload-session body never carries v2 manifest extras', () => {
  function findAssetSessionBody(fetchMock: ReturnType<typeof mockCfApi>): {
    manifest: Record<string, Record<string, unknown>>;
  } {
    const calls = fetchMock.mock.calls as Array<[unknown, RequestInit | undefined]>;
    const sessionCall = calls.find(([input]) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      return url.includes('/assets-upload-session');
    });
    if (!sessionCall) {
      throw new Error('expected at least one assets-upload-session call');
    }
    const [, init] = sessionCall;
    const raw = typeof init?.body === 'string' ? init.body : '';
    return JSON.parse(raw) as { manifest: Record<string, Record<string, unknown>> };
  }

  it('JSON-mode WfP deploy ships only {hash, size} per entry to CF', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-strip-json');
    const fetchMock = mockCfApi();

    const assetBytes = new TextEncoder().encode('export const x = 1;');
    const assetHash = HASH(0xfe_ed);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, assetHash, assetBytes);

    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({
        fetch: async () => Response.json({ ready: true }),
      }),
    } as unknown as DispatchNamespace;

    try {
      const indexJs = new TextEncoder().encode(
        "export default { fetch() { return new Response('ok'); } }",
      );
      let bin = '';
      for (let i = 0; i < indexJs.length; i++) {
        bin += String.fromCharCode(indexJs[i]);
      }
      const indexJsB64 = btoa(bin);

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: { version: 3, assetManifestVersion: 2, bindings: {}, type: 'platform' },
            assetManifest: {
              '/static/x.js': {
                blake3: assetHash,
                md5: MD5(0xfe_ee),
                size: assetBytes.byteLength,
              },
            },
            source: null,
            commit: null,
            preflight: null,
            workerFiles: { 'index.js': indexJsB64 },
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      const events = await readAllEvents(res);
      expect(events.find((e) => isEvent(e, 'done'))).toBeDefined();

      const body = findAssetSessionBody(fetchMock);
      for (const [path, entry] of Object.entries(body.manifest)) {
        expect(typeof entry.hash).toBe('string');
        expect(typeof entry.size).toBe('number');
        expect(Object.keys(entry).sort()).toEqual(['hash', 'size']);
        expect(entry).not.toHaveProperty('blake3');
        expect(entry).not.toHaveProperty('md5');
        if (path === '/static/x.js') {
          expect(entry.hash).toBe(assetHash);
          expect(entry.size).toBe(assetBytes.byteLength);
        }
      }
    } finally {
      env.DISPATCH = originalDispatch;
    }
  });
});

describe('direct Worker module upload', () => {
  const MiB = 1024 * 1024;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let originalDispatch: DispatchNamespace;

  beforeEach(async () => {
    user = await createTestUser(env.db);
    originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({ fetch: async () => Response.json({ ready: true }) }),
    } as unknown as DispatchNamespace;
  });
  afterEach(() => {
    env.DISPATCH = originalDispatch;
  });

  async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  }

  function requestUrls(projectId: string, body: unknown) {
    return app.fetch(
      new Request(`http://localhost/rpc/deploy.workerUploadUrls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, ...(body as object) }),
      }),
      env,
    );
  }

  async function upload(projectId: string, files: Record<string, Uint8Array<ArrayBuffer>>) {
    const modules = await Promise.all(
      Object.entries(files).map(async ([name, bytes]) => ({
        name,
        size: bytes.byteLength,
        sha256: await sha256(bytes),
      })),
    );
    const res = await requestUrls(projectId, { modules });
    expect(res.status).toBe(200);
    const { id, urls } = rpcData(await res.json()) as {
      id: string;
      urls: Array<{ url: string; headers: Record<string, string> }>;
    };
    for (const [index, module] of modules.entries()) {
      const key = decodeURI(new URL(urls[index]!.url).pathname).slice(
        `/${env.R2_STATIC_ASSETS_BUCKET}/`.length,
      );
      await env.STATIC_ASSETS_R2.put(key, files[module.name]!);
    }
    return { id, modules };
  }

  function finalize(projectId: string, extra: Record<string, unknown>) {
    return app.fetch(
      new Request(`http://localhost/projects/${projectId}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: { version: 3, assetManifestVersion: 2, bindings: {}, type: 'platform' },
          assetManifest: {},
          source: null,
          commit: null,
          preflight: null,
          ...extra,
        }),
      }),
      env,
    );
  }

  function workerUploadCalls(cf: ReturnType<typeof mockCfApi>, slug: string) {
    return cf.mock.calls.filter(
      ([url, init]) =>
        String(url).includes(`/scripts/user-${slug}-`) &&
        (init as RequestInit | undefined)?.method === 'PUT',
    );
  }

  it('signs one size-bound PUT per module under the deployment input prefix', async () => {
    const project = await createTestProject(env.db, user.id, 'wu-sign');
    const modules = [
      { name: 'index.js', size: 10, sha256: 'a'.repeat(64) },
      { name: 'index.js.map', size: 20, sha256: 'b'.repeat(64) },
      { name: 'lib/add.wasm', size: 0, sha256: 'c'.repeat(64) },
    ];
    const res = await requestUrls(project.id, { modules });
    expect(res.status).toBe(200);
    const { id, urls } = rpcData(await res.json()) as {
      id: string;
      urls: Array<{ url: string; headers: Record<string, string> }>;
    };
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(urls).toHaveLength(3);
    const types = ['application/javascript+module', 'application/source-map', 'application/wasm'];
    for (const [index, { url, headers }] of urls.entries()) {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe(
        `/${env.R2_STATIC_ASSETS_BUCKET}/deployment-inputs/${project.id}/${id}/${index}`,
      );
      expect(headers).toEqual({
        'Content-Type': types[index],
        'Content-Length': String(modules[index]!.size),
      });
      expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
      expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
      expect(parsed.searchParams.get('X-Amz-Expires')).toBe('1800');
    }
  });

  it.each([
    ['no modules field', {}],
    ['an empty list', { modules: [] }],
    [
      'a path outside the bundle',
      { modules: [{ name: '../a.js', size: 1, sha256: 'a'.repeat(64) }] },
    ],
    ['an unsupported extension', { modules: [{ name: 'a.css', size: 1, sha256: 'a'.repeat(64) }] }],
    [
      'a repeated name',
      {
        modules: [
          { name: 'a.js', size: 1, sha256: 'a'.repeat(64) },
          { name: 'a.js', size: 2, sha256: 'b'.repeat(64) },
        ],
      },
    ],
    ['a negative size', { modules: [{ name: 'a.js', size: -1, sha256: 'a'.repeat(64) }] }],
    ['a fractional size', { modules: [{ name: 'a.js', size: 1.5, sha256: 'a'.repeat(64) }] }],
    ['an uppercase digest', { modules: [{ name: 'a.js', size: 1, sha256: 'A'.repeat(64) }] }],
    [
      'more than 5000 modules',
      {
        modules: Array.from({ length: 5001 }, (_, index) => ({
          name: `m${index}.js`,
          size: 1,
          sha256: 'a'.repeat(64),
        })),
      },
    ],
  ])('rejects a module list with %s', async (_case, body) => {
    const project = await createTestProject(env.db, user.id, 'wu-invalid');
    const res = await requestUrls(project.id, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: expect.any(String) } });
  });

  it('applies the 64 MiB Worker limit to code but not to source maps', async () => {
    const project = await createTestProject(env.db, user.id, 'wu-limit');
    const tooLarge = await requestUrls(project.id, {
      modules: [
        { name: 'index.js', size: 40 * MiB, sha256: 'a'.repeat(64) },
        { name: 'chunk.wasm', size: 24 * MiB + 1, sha256: 'b'.repeat(64) },
        { name: 'index.js.map', size: 1, sha256: 'c'.repeat(64) },
      ],
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({
      error: {
        code: 'WORKER_TOO_LARGE',
        message: 'The Worker is 64.1 MiB without source maps, and Cloudflare allows 64 MiB.',
      },
    });
    const withMaps = await requestUrls(project.id, {
      modules: [
        { name: 'index.js', size: 64 * MiB, sha256: 'a'.repeat(64) },
        { name: 'index.js.map', size: 500 * MiB, sha256: 'b'.repeat(64) },
      ],
    });
    expect(withMaps.status).toBe(200);
  });

  it('streams uploaded modules byte-for-byte to Cloudflare and deletes the upload afterwards', async () => {
    const project = await createTestProject(env.db, user.id, 'wu-deploy');
    const files = {
      'index.js': new TextEncoder().encode(
        "import './lib/util.js'; export default { fetch() { return new Response('ok'); } }",
      ),
      'lib/util.js': new TextEncoder().encode('export const util = 1;'),
      'index.js.map': new TextEncoder().encode('{"version":3,"sources":[],"mappings":""}'),
      'add.wasm': Uint8Array.from({ length: 256 }, (_, index) => index),
    };
    const { id, modules } = await upload(project.id, files);
    const cf = mockCfApi();
    const res = await finalize(project.id, { workerInput: { id, modules } });
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    expect(events.find((e) => isEvent(e, 'done'))).toMatchObject({ workers: 4 });

    const calls = workerUploadCalls(cf, project.slug);
    expect(calls).toHaveLength(1);
    const form = (calls[0]![1] as RequestInit).body as FormData;
    const metadata = JSON.parse(await (form.get('metadata') as Blob).text()) as {
      main_module: string;
    };
    expect(metadata.main_module).toBe('index.js');
    const types: Record<string, string> = {
      'index.js': 'application/javascript+module',
      'lib/util.js': 'application/javascript+module',
      'index.js.map': 'application/source-map',
      'add.wasm': 'application/wasm',
    };
    for (const [name, bytes] of Object.entries(files)) {
      const file = form.get(name) as File;
      expect(file.type).toBe(types[name]);
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    }
    const [deployment] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment?.status).toBe('live');
    const left = await env.STATIC_ASSETS_R2.list({
      prefix: `deployment-inputs/${project.id}/${id}/`,
    });
    expect(left.objects).toEqual([]);
  });

  it('rejects an upload that is missing, resized, stale, oversized, from another project, or sent twice', async () => {
    const project = await createTestProject(env.db, user.id, 'wu-reject');
    const other = await createTestProject(env.db, user.id, 'wu-other');
    const code = new TextEncoder().encode('export default {};');
    const { id, modules } = await upload(project.id, { 'index.js': code });
    const foreign = await upload(other.id, { 'index.js': code });
    const cf = mockCfApi();
    const reject = async (extra: Record<string, unknown>, status: number, message: string) => {
      const res = await finalize(project.id, extra);
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ message: expect.stringContaining(message) });
    };

    await reject(
      {
        workerInput: {
          id,
          modules: [...modules, { name: 'more.js', size: 3, sha256: 'a'.repeat(64) }],
        },
      },
      400,
      '"more.js" was not uploaded',
    );
    await reject(
      { workerInput: { id, modules: [{ ...modules[0]!, size: code.byteLength + 1 }] } },
      400,
      `has ${code.byteLength} bytes in storage instead of ${code.byteLength + 1}`,
    );
    await reject({ workerInput: foreign }, 400, '"index.js" was not uploaded');
    expect(
      await env.STATIC_ASSETS_R2.head(`deployment-inputs/${other.id}/${foreign.id}/0`),
    ).not.toBeNull();
    await reject(
      { workerInput: { id, modules }, workerFiles: { 'index.js': btoa('export default {};') } },
      400,
      'not both',
    );
    await reject(
      { workerInput: { id: 'not-an-id', modules } },
      400,
      'workerInput.id must be the id returned',
    );
    await reject(
      {
        workerInput: {
          id,
          modules: [{ ...modules[0]!, size: 64 * MiB + 1 }],
        },
      },
      413,
      'Cloudflare allows 64 MiB',
    );
    (
      env.STATIC_ASSETS_R2 as unknown as { setUploadedAt(key: string, uploaded: Date): void }
    ).setUploadedAt(
      `deployment-inputs/${project.id}/${id}/0`,
      new Date(Date.now() - 13 * 60 * 60 * 1000),
    );
    await reject({ workerInput: { id, modules } }, 400, 'more than 12 hours ago');
    expect(workerUploadCalls(cf, project.slug)).toEqual([]);
    expect(await env.db.select().from(deployments)).toEqual([]);
  });

  it('fails the deploy without a complete Cloudflare upload when a stored module changes', async () => {
    const project = await createTestProject(env.db, user.id, 'wu-corrupt');
    const code = new TextEncoder().encode('export default {};');
    const { id, modules } = await upload(project.id, { 'index.js': code });
    const uploaded = vi.fn(async () => cfSuccess({}));
    const cf = mockCfApi({ uploadWorker: uploaded });
    // Decision: Same size, so the finalize listing accepts it. Only the digest differs.
    await env.STATIC_ASSETS_R2.put(
      `deployment-inputs/${project.id}/${id}/0`,
      new TextEncoder().encode('export default [];'),
    );
    const res = await finalize(project.id, { workerInput: { id, modules } });
    const events = await readAllEvents(res);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'error',
        message: 'Durable deployment input digest mismatch',
        step: 'worker_upload',
      }),
    );
    expect(uploaded).not.toHaveBeenCalled();
    expect(workerUploadCalls(cf, project.slug)).toHaveLength(1);
    const [deployment] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment?.status).toBe('failed');
    const left = await env.STATIC_ASSETS_R2.list({
      prefix: `deployment-inputs/${project.id}/${id}/`,
    });
    expect(left.objects).toEqual([]);
  });

  it('retries the upload when reading a stored module fails once', async () => {
    const project = await createTestProject(env.db, user.id, 'wu-read-retry');
    const code = new TextEncoder().encode('export default {};');
    const { id, modules } = await upload(project.id, { 'index.js': code });
    const cf = mockCfApi();
    const key = `deployment-inputs/${project.id}/${id}/0`;
    const originalGet = env.STATIC_ASSETS_R2.get.bind(env.STATIC_ASSETS_R2);
    let failed = false;
    vi.spyOn(env.STATIC_ASSETS_R2, 'get').mockImplementation(async (getKey, options) => {
      if (getKey === key && !failed) {
        failed = true;
        throw new Error('R2 unavailable');
      }
      return originalGet(getKey, options);
    });
    mockSetTimeout();

    const events = await readAllEvents(
      await finalize(project.id, { workerInput: { id, modules } }),
    );

    expect(events.find((e) => isEvent(e, 'done'))).toBeDefined();
    expect(workerUploadCalls(cf, project.slug)).toHaveLength(2);
  });

  it('reopens every module when Cloudflare asks for the upload again', async () => {
    mockSetTimeout();
    const project = await createTestProject(env.db, user.id, 'wu-retry');
    const files = {
      'index.js': new TextEncoder().encode('export default {};'),
      'index.js.map': new TextEncoder().encode('{"version":3}'),
    };
    const { id, modules } = await upload(project.id, files);
    const received: Array<Record<string, string>> = [];
    mockCfApi({
      uploadWorker: async (_url, init) => {
        const form = init!.body as FormData;
        received.push({
          'index.js': await (form.get('index.js') as Blob).text(),
          'index.js.map': await (form.get('index.js.map') as Blob).text(),
        });
        return received.length === 1
          ? new Response('Assets have already been uploaded', { status: 200 })
          : cfSuccess({});
      },
    });
    const events = await readAllEvents(
      await finalize(project.id, { workerInput: { id, modules } }),
    );
    expect(events.find((e) => isEvent(e, 'done'))).toBeDefined();
    const expected = {
      'index.js': 'export default {};',
      'index.js.map': '{"version":3}',
    };
    expect(received).toEqual([expected, expected]);
  });

  it('points an oversized inline Worker body at a CLI upgrade', async () => {
    const project = await createTestProject(env.db, user.id, 'wu-inline-cap');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerFiles: { 'index.js': 'a'.repeat(65 * MiB) } }),
      }),
      env,
    );
    expect(res.status).toBe(413);
    const { message } = (await res.json()) as { message: string };
    expect(message).toContain('source maps');
    expect(message).toContain('Upgrade the void CLI');
    expect(message).not.toContain('asset bytes');
  });
});
