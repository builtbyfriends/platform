import { DatabaseSync } from 'node:sqlite';
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
    const database = await call('projects.resourceOperations', {
      ...scope(),
      resourceId: 'res_database',
    });
    expect(await database.json()).toMatchObject({
      data: {
        available: true,
        operations: [{ id: 'database.query', effect: 'read' }],
        coverage: 'registered-operations',
      },
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

async function queryInvocation(sql = 'SELECT * FROM notes') {
  const resourceId = 'res_database';
  const response = await call('projects.resourceOperations', { ...scope(), resourceId });
  const descriptor = catalogSchema.assert(await response.json()).data.operations[0];
  if (!descriptor) {
    throw Error('Missing query operation');
  }
  return {
    ...scope(),
    resourceId,
    operation: descriptor.id,
    version: descriptor.version,
    expectedEffect: 'read',
    input: { sql },
  };
}
function queryDatabaseFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(
    "CREATE TABLE notes(title TEXT, category TEXT, score INTEGER, password TEXT, visible_copy TEXT GENERATED ALWAYS AS (password)); INSERT INTO notes(title, category, score, password) VALUES ('first', 'bug', 1, 'private-value'), ('second', 'bug', 3, 'private-value'), ('third', 'idea', 4, 'private-value'); CREATE VIEW visible_notes AS SELECT * FROM notes; CREATE TABLE _void_migrations(secret TEXT)",
  );
  const input = type({ sql: 'string', 'params?': '(string | number)[]' });
  proxy.mockImplementation(async (_url, init) => {
    const body = input.assert(JSON.parse(String(init?.body)));
    return Response.json({ results: database.prepare(body.sql).all(...(body.params ?? [])) });
  });
  return database;
}

describe('registered database SELECT queries', () => {
  it('executes its schema checks and compiled query on real Workerd D1', async () => {
    const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        compatibilityDate: '2026-10-01',
        d1Databases: ['DB'],
      }),
    );
    try {
      const database = await runtime.getD1Database('DB');
      await database.prepare('CREATE TABLE notes(title TEXT, password TEXT)').run();
      await database.prepare("INSERT INTO notes VALUES ('Hello', 'private')").run();
      const queryErrors: Array<unknown> = [];
      const input = type({ sql: 'string', 'params?': '(string | number)[]' });
      proxy.mockImplementation(async (_url, init) => {
        const body = input.assert(JSON.parse(String(init?.body)));
        try {
          return Response.json(
            await database
              .prepare(body.sql)
              .bind(...(body.params ?? []))
              .all(),
          );
        } catch (error) {
          queryErrors.push({ sql: body.sql, error });
          throw error;
        }
      });
      const response = await call('resources.invoke', await queryInvocation());
      expect(queryErrors).toEqual([]);
      expect(await response.json()).toMatchObject({
        data: { kind: 'query-rows', columns: ['title'], rows: [['Hello']] },
      });
    } finally {
      await runtime.dispose();
    }
  });
  it('runs real SQLite public reads, groups, bounded pages and empty-result schemas through the advertised operation', async () => {
    const database = queryDatabaseFixture();
    try {
      const request = await queryInvocation();
      expect(await (await call('resources.invoke', request)).json()).toMatchObject({
        data: {
          kind: 'query-rows',
          columns: ['title', 'category', 'score'],
          rows: [
            ['first', 'bug', 1],
            ['second', 'bug', 3],
            ['third', 'idea', 4],
          ],
          truncated: false,
        },
      });
      const grouped = await queryInvocation(
        'SELECT category, COUNT(*) AS total FROM notes WHERE score > 0 GROUP BY category ORDER BY total DESC LIMIT 1',
      );
      expect(await (await call('resources.invoke', grouped)).json()).toMatchObject({
        data: {
          columns: ['category', 'total'],
          rows: [['bug', 2]],
          truncated: true,
          limit: 1,
        },
      });
      expect(
        await (
          await call(
            'resources.invoke',
            await queryInvocation("SELECT title FROM notes WHERE title = 'missing'"),
          )
        ).json(),
      ).toMatchObject({ data: { columns: ['title'], rows: [], truncated: false } });
      const signals = proxy.mock.calls.slice(0, 6).map(([, init]) => init?.signal);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(new Set(signals).size).toBe(1);
    } finally {
      database.close();
    }
  });

  it('rejects mutations and unsupported statements without making provider requests', async () => {
    for (const sql of [
      'DELETE FROM notes',
      'SELECT * FROM notes; DROP TABLE notes',
      'WITH n AS (SELECT * FROM notes) SELECT * FROM n',
    ]) {
      const response = await call('resources.invoke', await queryInvocation(sql));
      expect(await response.json()).toMatchObject({
        data: { kind: 'unavailable', reason: expect.stringContaining('one SELECT') },
      });
    }
    expect(proxy).not.toHaveBeenCalled();
  });

  it('refuses protected references, generated columns, internal tables and views before any customer query', async () => {
    const database = queryDatabaseFixture();
    try {
      for (const sql of [
        'SELECT password AS title FROM notes',
        "SELECT title FROM notes WHERE password = 'guess'",
        'SELECT visible_copy FROM notes',
        'SELECT * FROM _void_migrations',
        'SELECT * FROM visible_notes',
      ]) {
        proxy.mockClear();
        expect(
          await (await call('resources.invoke', await queryInvocation(sql))).json(),
        ).toMatchObject({ data: { kind: 'unavailable' } });
        expect(proxy.mock.calls.some(([, init]) => String(init?.body).includes(' AS '))).toBe(
          false,
        );
      }
      expect(database.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 3 });
    } finally {
      database.close();
    }
  });

  it('pins effect, operation version, selected resource and owner before queries', async () => {
    const request = await queryInvocation();
    for (const [change, status] of [
      [{ version: '0'.repeat(64) }, 409],
      [{ expectedEffect: 'write' }, 400],
      [{ confirmation: 'reviewed' }, 400],
      [{ resourceId: 'res_files' }, 404],
      [{ project: other.id }, 404],
      [{ owner: { person: 'someone-else' } }, 404],
      [{ input: { sql: 'SELECT * FROM notes', binding: 'OTHER' } }, 400],
      [{ input: { sql: '€'.repeat(3000) } }, 400],
    ] as const) {
      expect((await call('resources.invoke', { ...request, ...change })).status).toBe(status);
    }
    expect(proxy).not.toHaveBeenCalled();
  });

  it('discards query results when schema changes during the read', async () => {
    const database = queryDatabaseFixture();
    const bridge = proxy.getMockImplementation();
    if (!bridge) {
      throw Error('Missing fixture');
    }
    proxy.mockImplementation(async (url, init) => {
      const response = await bridge(url, init);
      if (String(init?.body).includes(' AS ')) {
        database.exec('ALTER TABLE notes ADD COLUMN later TEXT');
      }
      return response;
    });
    try {
      expect(await (await call('resources.invoke', await queryInvocation())).json()).toMatchObject({
        data: { kind: 'unavailable', reason: expect.stringContaining('schema changed') },
      });
    } finally {
      database.close();
    }
  });

  it('discards results after resource rebinding or revoked ownership', async () => {
    const replacement = await createTestUser(env.db, 'replacement-owner');
    for (const changed of ['resource', 'owner']) {
      const database = queryDatabaseFixture();
      const request = await queryInvocation();
      const bridge = proxy.getMockImplementation();
      if (!bridge) {
        throw Error('Missing fixture');
      }
      proxy.mockImplementation(async (url, init) => {
        const response = await bridge(url, init);
        if (String(init?.body).includes(' AS ')) {
          if (changed === 'resource') {
            await env.db
              .update(resources)
              .set({ cf_id: 'changed-database' })
              .where(eq(resources.id, 'res_database'));
          } else {
            await env.db
              .update(projects)
              .set({ user_id: replacement.id })
              .where(eq(projects.id, project.id));
          }
        }
        return response;
      });
      try {
        expect((await call('resources.invoke', request)).status).toBe(409);
      } finally {
        database.close();
      }
    }
  });

  it('bounds large result pages and reports long-cell truncation without leaking provider errors', async () => {
    const database = queryDatabaseFixture();
    try {
      database.prepare('UPDATE notes SET title = ? WHERE score = 1').run('x'.repeat(5000));
      const response = await call(
        'resources.invoke',
        await queryInvocation('SELECT title FROM notes LIMIT 1'),
      );
      const output = type({ data: { rows: 'string[][]', cellsTruncated: 'boolean' } }).assert(
        await response.json(),
      );
      expect(output.data.rows[0][0]).toHaveLength(4096);
      expect(output.data.cellsTruncated).toBe(true);
      proxy.mockResolvedValue(new Response('private-db token=hidden', { status: 500 }));
      const failed = await (await call('resources.invoke', await queryInvocation())).text();
      expect(failed).toContain('unavailable');
      expect(failed).not.toMatch(/private-db|token=hidden/);
    } finally {
      database.close();
    }
  });
});
