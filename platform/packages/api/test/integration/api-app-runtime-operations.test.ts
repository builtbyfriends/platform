import { type } from 'arktype';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { registerOAuthClient } from '../../src/auth/oauth.ts';
import app from '../../src/index.ts';
import { projects, resources, users } from '../../src/schema.ts';
import {
  clearTables,
  createMockExecutionContext,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv & { PLATFORM_PROXY?: Fetcher };
let registration: Awaited<ReturnType<typeof registerOAuthClient>>;
let project: { id: string };
let other: { id: string };
let ownerId: string;
const proxy = vi.fn<(request: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const auth = () => 'Basic ' + btoa(registration.client.id + ':' + registration.clientSecret);
const scope = () => ({ project: project.id, owner: { person: 'person' }, resourceId: 'res_files' });
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- These requests test malformed JSON boundaries.
const call = (path: string, body: unknown, authorization = auth()) =>
  app.fetch(
    new Request(`https://platform.test/app-billing/${path}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    createMockExecutionContext(),
  );
const descriptorSchema = type({
  id: 'string',
  version: 'string',
  effect: "'read' | 'write'",
  inputSchema: 'unknown',
  outputSchema: 'unknown',
});
const catalogSchema = type({ data: { operations: descriptorSchema.array() } });
async function catalog() {
  const response = await call('projects.resourceOperations', scope());
  expect(response.status).toBe(200);
  return catalogSchema.assert(await response.json()).data.operations;
}
async function invocation(operation = 'files.readText') {
  const descriptor = (await catalog()).find((entry) => entry.id === operation);
  if (!descriptor) {
    throw Error('Missing registered operation');
  }
  return {
    ...scope(),
    operation,
    version: descriptor.version,
    expectedEffect: descriptor.effect,
    ...(descriptor.effect === 'write' ? { confirmation: 'reviewed' } : {}),
    input:
      descriptor.effect === 'write'
        ? { key: 'note.txt', text: 'Changed', expectedEtag: 'opened' }
        : { key: 'note.txt' },
  };
}
function file(content = 'Hello', etag = 'opened') {
  return new Response(content, {
    headers: {
      'content-type': 'text/plain',
      etag: `"${etag}"`,
      'x-platform-r2-object': encodeURIComponent(
        JSON.stringify({
          key: 'note.txt',
          etag,
          size: new TextEncoder().encode(content).length,
          httpMetadata: { contentType: 'text/plain' },
          customMetadata: { author: 'owner' },
        }),
      ),
    },
  });
}

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  registration = await registerOAuthClient(env.db, {
    name: 'Operations test',
    operator: 'Test',
    redirectUris: ['https://app.test/callback'],
    scopes: ['profile'],
  });
  const owner = await createTestUser(env.db, 'owner', 'app:' + registration.client.id, 'person');
  ownerId = owner.id;
  project = await createTestProject(env.db, owner.id);
  const stranger = await createTestUser(env.db, 'other');
  other = await createTestProject(env.db, stranger.id);
  await env.db.insert(resources).values([
    {
      id: 'res_files',
      project_id: project.id,
      type: 'r2',
      cf_id: 'private-bucket',
      binding_name: 'FILES',
    },
    {
      id: 'res_database',
      project_id: project.id,
      type: 'd1',
      cf_id: 'private-db',
      binding_name: 'DB',
    },
    {
      id: 'res_foreign',
      project_id: other.id,
      type: 'r2',
      cf_id: 'private-other',
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

describe('registered resource operations', () => {
  it('discovers complete bounded schemas and stable versions without reading files or leaking provider identity', async () => {
    const operations = await catalog();
    expect(operations).toHaveLength(2);
    expect(operations).toEqual(await catalog());
    const save = operations.find((entry) => entry.id === 'files.saveText');
    expect(save?.version).toMatch(/^[a-f0-9]{64}$/);
    expect(save?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining(['key', 'text', 'expectedEtag']),
      properties: {
        expectedEtag: { type: 'string', minLength: 1, maxLength: 200 },
        text: { type: 'string', maxLength: 65_536, 'x-maxUtf8Bytes': 65_536 },
      },
    });
    expect(save?.outputSchema).toHaveProperty('anyOf');
    expect(JSON.stringify(operations)).not.toContain('private-');
    expect(proxy).not.toHaveBeenCalled();
  });

  it('does not present discovery-only or unsupported operations as executable', async () => {
    const unsupported = await call('projects.resourceOperations', {
      ...scope(),
      resourceId: 'res_database',
    });
    expect(await unsupported.json()).toMatchObject({
      data: { available: false, operations: [], coverage: 'registered-operations' },
    });
    const body = await invocation();
    expect((await call('resources.invoke', { ...body, resourceId: 'res_database' })).status).toBe(
      404,
    );
    expect(
      (await call('resources.invoke', { ...body, operation: 'cloudflare-delete-bucket' })).status,
    ).toBe(404);
    delete env.PLATFORM_PROXY;
    expect(await (await call('projects.resourceOperations', scope())).json()).toMatchObject({
      data: { available: false, operations: [] },
    });
    expect((await call('resources.invoke', body)).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('authenticates the client and rejects other owners, projects and resources for both routes', async () => {
    const body = await invocation();
    for (const [path, input] of [
      ['projects.resourceOperations', scope()],
      ['resources.invoke', body],
    ] as const) {
      expect((await call(path, input, 'Basic invalid')).status).toBe(401);
      expect(
        (await call(path, { ...input, project: other.id, resourceId: 'res_foreign' })).status,
      ).toBe(404);
      expect((await call(path, { ...input, resourceId: 'res_foreign' })).status).toBe(404);
      expect((await call(path, { ...input, owner: { person: 'someone-else' } })).status).toBe(404);
    }
    expect(proxy).not.toHaveBeenCalled();
  });

  it('rejects stale descriptors, forged read effects and unreviewed writes before provider requests', async () => {
    const body = await invocation('files.saveText');
    expect((await call('resources.invoke', { ...body, version: '0'.repeat(64) })).status).toBe(409);
    expect((await call('resources.invoke', { ...body, expectedEffect: 'read' })).status).toBe(400);
    expect((await call('resources.invoke', { ...body, confirmation: undefined })).status).toBe(403);
    expect(
      (await call('resources.invoke', { ...(await invocation()), confirmation: 'reviewed' }))
        .status,
    ).toBe(400);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('rejects malformed, extra, provider-selected and oversized input before effects', async () => {
    const body = await invocation('files.saveText');
    for (const input of [
      null,
      [],
      { ...body.input, key: '' },
      { ...body.input, expectedEtag: undefined },
      { ...body.input, cf_id: 'other-bucket' },
      { ...body.input, text: 'a'.repeat(65_537) },
      { ...body.input, text: '€'.repeat(30_000) },
    ]) {
      expect((await call('resources.invoke', { ...body, input })).status).toBe(400);
    }
    expect((await call('resources.invoke', { ...body, url: 'https://foreign.test' })).status).toBe(
      400,
    );
    expect(proxy).not.toHaveBeenCalled();
  });

  it('reads, conditionally saves, and reads back through the discovered registry operations', async () => {
    const read = await invocation();
    proxy.mockResolvedValueOnce(file());
    expect(await (await call('resources.invoke', read)).json()).toMatchObject({
      data: { kind: 'file-text', text: 'Hello', etag: 'opened', editable: true },
    });
    proxy
      .mockResolvedValueOnce(file())
      .mockResolvedValueOnce(Response.json({ key: 'note.txt', etag: 'saved' }));
    expect(
      await (await call('resources.invoke', await invocation('files.saveText'))).json(),
    ).toMatchObject({ data: { kind: 'file-saved', etag: 'saved' } });
    const [url, init] = proxy.mock.calls[2];
    expect(String(url)).toBe('https://proxy/r2/put-conditional');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      key: 'note.txt',
      value: 'Changed',
      onlyIf: { etagMatches: 'opened' },
      customMetadata: { author: 'owner' },
    });
    proxy.mockResolvedValueOnce(file('Changed', 'saved'));
    expect(await (await call('resources.invoke', read)).json()).toMatchObject({
      data: { kind: 'file-text', text: 'Changed', etag: 'saved' },
    });
  });

  it('keeps concurrent edits and uncertain writes distinct', async () => {
    const body = await invocation('files.saveText');
    proxy.mockResolvedValueOnce(file('Other change', 'newer'));
    expect(await (await call('resources.invoke', body)).json()).toMatchObject({
      data: { kind: 'conflict' },
    });
    expect(proxy).toHaveBeenCalledTimes(1);
    proxy.mockResolvedValueOnce(file()).mockResolvedValueOnce(new Response(null, { status: 412 }));
    expect(await (await call('resources.invoke', body)).json()).toMatchObject({
      data: { kind: 'conflict' },
    });
    proxy.mockResolvedValueOnce(file()).mockRejectedValueOnce(Error('Connection lost'));
    expect(await (await call('resources.invoke', body)).json()).toMatchObject({
      data: { kind: 'unknown' },
    });
  });

  it('does not expose content to another connected client or accept oversized envelopes', async () => {
    const body = await invocation();
    const foreign = await registerOAuthClient(env.db, {
      name: 'Other client',
      operator: 'Test',
      redirectUris: ['https://other.test/callback'],
      scopes: ['profile'],
    });
    const authorization = 'Basic ' + btoa(foreign.client.id + ':' + foreign.clientSecret);
    expect((await call('resources.invoke', body, authorization)).status).toBe(404);
    expect((await call('projects.resourceOperations', scope(), authorization)).status).toBe(404);
    expect(
      (await call('resources.invoke', { ...body, input: { key: 'a'.repeat(820_001) } })).status,
    ).toBe(413);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('reports uncertainty when the connection changes during the actual write', async () => {
    const body = await invocation('files.saveText');
    proxy.mockResolvedValueOnce(file()).mockImplementationOnce(async () => {
      await env.db.update(projects).set({ proxy_token_gen: 1 }).where(eq(projects.id, project.id));
      return Response.json({ key: 'note.txt', etag: 'saved' });
    });
    expect(await (await call('resources.invoke', body)).json()).toMatchObject({
      data: { kind: 'unknown' },
    });
  });

  it('rechecks ownership after reads and before conditional writes', async () => {
    const read = await invocation();
    proxy.mockImplementationOnce(async () => {
      await env.db.update(resources).set({ cf_id: 'moved' }).where(eq(resources.id, 'res_files'));
      return file();
    });
    expect((await call('resources.invoke', read)).status).toBe(409);
    const save = await invocation('files.saveText');
    proxy.mockImplementationOnce(async () => {
      await env.db
        .update(resources)
        .set({ cf_id: 'moved-again' })
        .where(eq(resources.id, 'res_files'));
      return file();
    });
    expect(await (await call('resources.invoke', save)).json()).toMatchObject({
      data: { kind: 'unknown' },
    });
    expect(proxy).toHaveBeenCalledTimes(2);
  });

  it('refuses suspended owners and expired previews', async () => {
    const body = await invocation();
    await env.db.update(users).set({ suspended_reason: 'admin:test' }).where(eq(users.id, ownerId));
    expect((await call('resources.invoke', body)).status).toBe(403);
    expect((await call('projects.resourceOperations', scope())).status).toBe(409);
    await env.db.update(users).set({ suspended_reason: null }).where(eq(users.id, ownerId));
    await env.db
      .update(projects)
      .set({
        preview_client_id: registration.client.id,
        preview_workspace_id: 'operation-test-workspace',
        slug: 'preview-operation-test',
        preview_expires_at: new Date(0).toISOString(),
      })
      .where(eq(projects.id, project.id));
    expect((await call('resources.invoke', body)).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });
});
