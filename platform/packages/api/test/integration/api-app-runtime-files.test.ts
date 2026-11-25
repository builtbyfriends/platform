import { Buffer } from 'node:buffer';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { registerOAuthClient } from '../../src/auth/oauth.ts';
import { getProject } from '../../src/db/projects.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import { appRuntimeFileRoutes, fileUploadMaxBytes } from '../../src/routes/app-runtime-files.ts';
import { projects, resources, users } from '../../src/schema.ts';
import {
  clearTables,
  createMockExecutionContext,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv & { PLATFORM_PROXY?: Fetcher };
let registration: Awaited<ReturnType<typeof registerOAuthClient>>;
let project: { id: string; slug: string };
let other: { id: string; slug: string };
let ownerId: string;
const proxy = vi.fn<(request: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const basic = () => `Basic ${btoa(`${registration.client.id}:${registration.clientSecret}`)}`;
const identity = () => ({
  appId: project.id,
  resourceId: 'res_files',
  action: 'files.upload',
  key: 'folder/photo.bin',
});
function call(
  method: 'GET' | 'PUT',
  body?: BodyInit,
  query: { [name: string]: string } = {},
  headers: { [name: string]: string } = {},
) {
  const url = new URL('https://platform.test/app-billing/resources.files');
  url.search = new URLSearchParams({
    project: project.id,
    resourceId: 'res_files',
    key: 'folder/photo.bin',
    owner: JSON.stringify({ person: 'person' }),
    ...query,
  }).toString();
  return app.fetch(
    new Request(url, {
      method,
      body,
      headers: { authorization: basic(), ...headers },
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    }),
    env,
    createMockExecutionContext(),
  );
}
const saved = (size: number, extra = {}) =>
  Response.json({ key: 'folder/photo.bin', etag: 'new-etag', size, ...extra });
const object = (body: Uint8Array<ArrayBuffer> = Uint8Array.from([0, 255, 1, 128])) =>
  new Response(body, {
    headers: {
      'content-type': 'image/png',
      'content-length': String(body.length),
      etag: '"file-etag"',
      'x-platform-r2-object': 'private-provider-metadata',
    },
  });
const listed = () =>
  app.fetch(
    new Request('https://platform.test/app-billing/projects.resources', {
      method: 'POST',
      headers: { authorization: basic(), 'content-type': 'application/json' },
      body: JSON.stringify({ project: project.id, owner: { person: 'person' } }),
    }),
    env,
    createMockExecutionContext(),
  );
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  registration = await registerOAuthClient(env.db, {
    name: 'Files app',
    operator: 'Test',
    redirectUris: ['https://connected-app.test/callback'],
    scopes: ['profile'],
  });
  const owner = await createTestUser(
    env.db,
    'file-owner',
    'app:' + registration.client.id,
    'person',
  );
  ownerId = owner.id;
  const foreign = await createTestUser(env.db, 'foreign-owner');
  project = await createTestProject(env.db, owner.id);
  other = await createTestProject(env.db, foreign.id);
  await createTestDeployment(env.db, project.id);
  await env.db.insert(resources).values([
    {
      id: 'res_files',
      project_id: project.id,
      type: 'r2',
      cf_id: 'private-bucket',
      binding_name: 'FILES',
    },
    { id: 'res_db', project_id: project.id, type: 'd1', cf_id: 'private-db', binding_name: 'DATA' },
    {
      id: 'res_foreign',
      project_id: other.id,
      type: 'r2',
      cf_id: 'foreign-bucket',
      binding_name: 'FILES',
    },
  ]);
  proxy.mockReset();
  env.PLATFORM_PROXY = {
    fetch: proxy,
    connect: () => {
      throw Error('Unexpected socket');
    },
  };
  delete env.DEV_AUTH_BYPASS;
});

describe('owner-scoped binary file transfers', () => {
  it('does not write when cancelled during the final authorization read', async () => {
    const abort = new AbortController();
    let calls = 0;
    const isolated = new Hono<ApiEnv>()
      .use('*', async (context, next) => {
        context.set('db', env.db);
        await next();
      })
      .route(
        '/',
        appRuntimeFileRoutes(async () => {
          const value = await getProject(env.db, project.id);
          if (++calls === 2) {
            abort.abort();
          }
          return value;
        }),
      );
    const query = new URLSearchParams({
      project: project.id,
      resourceId: 'res_files',
      key: 'file.bin',
      owner: JSON.stringify({ person: 'person' }),
    });
    const response = await isolated.fetch(
      new Request(`https://test/resources.files?${query}`, {
        method: 'PUT',
        body: 'x',
        signal: abort.signal,
      }),
      env,
      createMockExecutionContext(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ data: { kind: 'unavailable' } });
    expect(proxy).not.toHaveBeenCalled();
  });
  it('stops a streamed download when ownership changes between chunks', async () => {
    const cancelled = vi.fn();
    let count = 0;
    proxy.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              controller.enqueue(Uint8Array.of(++count));
            },
            cancel: cancelled,
          },
          { highWaterMark: 0 },
        ),
        { headers: { etag: '"e"', 'content-length': '100' } },
      ),
    );
    const response = await call('GET');
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(Uint8Array.of(1));
    await env.db.update(users).set({ suspended_reason: 'admin' }).where(eq(users.id, ownerId));
    await expect(reader.read()).rejects.toThrow('revoked');
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it('advertises a bounded upload only for the active file resource', async () => {
    expect(await (await listed()).json()).toMatchObject({
      data: {
        resources: [
          {
            id: 'res_files',
            fileTransfers: { download: true, upload: { maxBytes: fileUploadMaxBytes } },
          },
          { id: 'res_db' },
        ],
      },
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: null })
      .where(eq(projects.id, project.id));
    const result = await (await listed()).json();
    expect(JSON.stringify(result)).not.toContain('maxBytes');
    expect((await call('PUT', 'x')).status).toBe(503);
    expect(proxy).not.toHaveBeenCalled();
  });
  it('preserves arbitrary original bytes and sets create-only conditions internally', async () => {
    const bytes = Uint8Array.from([0, 255, 128, 13, 10, 0, 42]);
    proxy.mockResolvedValueOnce(saved(bytes.length));
    const response = await call('PUT', bytes, {}, { 'content-type': 'application/octet-stream' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { ...identity(), kind: 'file-saved', etag: 'new-etag', size: bytes.length },
    });
    expect(proxy).toHaveBeenCalledTimes(1);
    const [url, request] = proxy.mock.calls[0]!;
    expect(url).toBe('https://proxy/r2/put-conditional');
    const sent = JSON.parse(String(request?.body));
    expect(sent).toMatchObject({
      projectId: project.id,
      binding: 'FILES',
      key: 'folder/photo.bin',
      onlyIf: { etagDoesNotMatch: '*' },
    });
    expect(Buffer.from(sent.base64, 'base64')).toEqual(Buffer.from(bytes));
    expect(sent).not.toHaveProperty('cf_id');
  });
  it.each(['GET', 'PUT'] as const)(
    'uses Workers-supported manual redirects for %s transfers',
    async (method) => {
      proxy.mockResolvedValueOnce(method === 'PUT' ? saved(1) : object());
      const response = await call(method, method === 'PUT' ? 'x' : undefined);
      expect(response.status).toBe(200);
      expect(proxy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ redirect: 'manual' }),
      );
    },
  );
  it.each(['GET', 'PUT'] as const)('does not follow redirected %s transfers', async (method) => {
    proxy.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { location: 'https://other.test/file' } }),
    );
    const response = await call(method, method === 'PUT' ? 'x' : undefined);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      data: { kind: method === 'PUT' ? 'unknown' : 'unavailable' },
    });
    expect(proxy).toHaveBeenCalledTimes(1);
  });
  it('accepts zero-byte files without substituting text', async () => {
    proxy.mockResolvedValueOnce(saved(0));
    expect((await call('PUT', new Uint8Array())).status).toBe(200);
    expect(JSON.parse(String(proxy.mock.calls[0]![1]?.body)).base64).toBe('');
  });
  it('accepts the measured 5 MiB boundary within the existing proxy body limit', async () => {
    proxy.mockResolvedValueOnce(saved(fileUploadMaxBytes));
    expect((await call('PUT', new Uint8Array(fileUploadMaxBytes))).status).toBe(200);
    expect(new TextEncoder().encode(String(proxy.mock.calls[0]![1]?.body)).length).toBeLessThan(
      8 * 1024 * 1024,
    );
  });
  it('rejects an oversized streamed body even without Content-Length', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(fileUploadMaxBytes));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    expect((await call('PUT', body)).status).toBe(413);
    expect(proxy).not.toHaveBeenCalled();
  });
  it.each(['-1', 'nope', '1.5'])('rejects invalid declared size %s', async (length) => {
    expect((await call('PUT', 'x', {}, { 'content-length': length })).status).toBe(400);
    expect(proxy).not.toHaveBeenCalled();
  });
  it('rejects a mismatched size and content encoding before storage', async () => {
    expect((await call('PUT', 'xx', {}, { 'content-length': '1' })).status).toBe(400);
    expect((await call('PUT', 'x', {}, { 'content-encoding': 'gzip' })).status).toBe(400);
    expect(proxy).not.toHaveBeenCalled();
  });
  it.each([null, 412])(
    'reports an existing key as conflict, never retrying (%s)',
    async (result) => {
      proxy.mockResolvedValueOnce(
        result === null ? Response.json(null) : new Response(null, { status: result }),
      );
      const response = await call('PUT', 'new');
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ data: { ...identity(), kind: 'conflict' } });
      expect(proxy).toHaveBeenCalledTimes(1);
    },
  );
  it.each([404, 501])(
    'reports unsupported conditional deployment as unavailable (%s)',
    async (status) => {
      proxy.mockResolvedValueOnce(new Response(null, { status }));
      const response = await call('PUT', 'new');
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ data: { ...identity(), kind: 'unavailable' } });
      expect(proxy).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    new Error('transport timeout'),
    new Response(null, { status: 502 }),
    saved(4),
    saved(3, { key: 'other' }),
  ])('reports an uncertain write without replay', async (result) => {
    if (result instanceof Error) {
      proxy.mockRejectedValueOnce(result);
    } else {
      proxy.mockResolvedValueOnce(result);
    }
    const response = await call('PUT', 'new');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ data: { ...identity(), kind: 'unknown' } });
    expect(proxy).toHaveBeenCalledTimes(1);
  });
  it('returns original download bytes with private safe headers and no provider metadata', async () => {
    proxy.mockResolvedValueOnce(object());
    const response = await call('GET');
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([0, 255, 1, 128]));
    expect(response.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''photo.bin",
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.has('x-platform-r2-object')).toBe(false);
  });
  it('streams a download rather than buffering it into a JSON result', async () => {
    let finish: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
        finish = () => {
          controller.enqueue(Uint8Array.of(2));
          controller.close();
        };
      },
    });
    proxy.mockResolvedValueOnce(
      new Response(body, { headers: { etag: '"e"', 'content-length': '2' } }),
    );
    const response = await call('GET');
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(Uint8Array.of(1));
    finish!();
    expect((await reader.read()).value).toEqual(Uint8Array.of(2));
  });
  it('does not turn missing-object JSON into a downloaded file', async () => {
    proxy.mockResolvedValueOnce(Response.json(null));
    const response = await call('GET');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ data: { kind: 'unavailable' } });
  });
  it.each([
    '../other',
    '/absolute',
    'nested/../other',
    'bad\\path',
    'nul\u0000key',
    'private-key.pem',
    'é'.repeat(513),
  ])('rejects unsafe or protected paths', async (key) => {
    expect((await call('GET', undefined, { key })).status).toBe(400);
    expect((await call('PUT', 'x', { key })).status).toBe(400);
    expect(proxy).not.toHaveBeenCalled();
  });
  it('preserves UTF-8 and quoted path names without URL reinterpretation', async () => {
    const key = "folder/你好 '#?.bin";
    proxy.mockResolvedValueOnce(saved(1, { key }));
    expect((await call('PUT', 'x', { key })).status).toBe(200);
    expect(JSON.parse(String(proxy.mock.calls[0]![1]?.body)).key).toBe(key);
  });
  it('rejects foreign owners, clients, resources and non-file resources before proxy access', async () => {
    expect((await call('GET', undefined, {}, { authorization: 'Basic bad' })).status).toBe(401);
    expect(
      (await call('GET', undefined, { owner: JSON.stringify({ person: 'other' }) })).status,
    ).toBe(404);
    expect((await call('GET', undefined, { project: other.id })).status).toBe(404);
    expect((await call('GET', undefined, { resourceId: 'res_foreign' })).status).toBe(404);
    expect((await call('GET', undefined, { resourceId: 'res_db' })).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });
  it('blocks suspended owners and omits transfer capabilities', async () => {
    await env.db.update(users).set({ suspended_reason: 'admin' }).where(eq(users.id, ownerId));
    expect((await call('GET')).status).toBe(404);
    expect((await call('PUT', 'x')).status).toBe(404);
    expect(JSON.stringify(await (await listed()).json())).not.toContain('fileTransfers');
    expect(proxy).not.toHaveBeenCalled();
  });
  it('permits only active unexpired previews owned by this app', async () => {
    await env.db
      .update(projects)
      .set({
        preview_client_id: registration.client.id,
        preview_workspace_id: 'test-workspace',
        slug: 'preview-file-test',
        preview_expires_at: new Date(Date.now() + 60_000).toISOString(),
        status: 'active',
      })
      .where(eq(projects.id, project.id));
    proxy.mockResolvedValueOnce(saved(1));
    expect((await call('PUT', 'x')).status).toBe(200);
    await env.db
      .update(projects)
      .set({ preview_expires_at: new Date(Date.now() - 1).toISOString() })
      .where(eq(projects.id, project.id));
    expect((await call('GET')).status).toBe(404);
    expect(proxy).toHaveBeenCalledTimes(1);
  });
  it('rechecks ownership after reading the upload before the provider write', async () => {
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          await env.db
            .update(resources)
            .set({ cf_id: 'changed-bucket' })
            .where(eq(resources.id, 'res_files'));
          controller.enqueue(Uint8Array.of(1));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = await call('PUT', body);
    expect(response.status).toBe(503);
    expect(proxy).not.toHaveBeenCalled();
  });
  it.each(['owner', 'deployment', 'resource', 'suspension'])(
    'rejects downloads when %s changes during proxy read',
    async (change) => {
      proxy.mockImplementationOnce(async () => {
        if (change === 'owner') {
          await env.db
            .update(projects)
            .set({ user_id: (await createTestUser(env.db, 'replacement')).id })
            .where(eq(projects.id, project.id));
        }
        if (change === 'deployment') {
          await createTestDeployment(env.db, project.id);
        }
        if (change === 'resource') {
          await env.db
            .update(resources)
            .set({ cf_id: 'changed-bucket' })
            .where(eq(resources.id, 'res_files'));
        }
        if (change === 'suspension') {
          await env.db
            .update(users)
            .set({ suspended_reason: 'admin' })
            .where(eq(users.id, ownerId));
        }
        return object();
      });
      expect((await call('GET')).status).toBe(409);
    },
  );
  it('returns unknown when resource identity changes after the write', async () => {
    proxy.mockImplementationOnce(async () => {
      await env.db
        .update(resources)
        .set({ cf_id: 'changed-bucket' })
        .where(eq(resources.id, 'res_files'));
      return saved(1);
    });
    const response = await call('PUT', 'x');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ data: { ...identity(), kind: 'unknown' } });
  });
});
