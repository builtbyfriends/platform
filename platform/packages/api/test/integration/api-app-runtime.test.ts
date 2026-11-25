import { DatabaseSync } from 'node:sqlite';
import { isRecord } from '@builtbyfriends/deploy-core';
import { eq } from 'drizzle-orm';
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
import { registerOAuthClient } from '../../src/auth/oauth.ts';
import app from '../../src/index.ts';
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
const proxy = vi.fn<(request: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const basic = () => `Basic ${btoa(`${registration.client.id}:${registration.clientSecret}`)}`;
const call = (path: string, body: unknown, authorization = basic()) =>
  app.fetch(
    new Request(`https://platform.test/app-billing/${path}`, {
      method: 'POST',
      headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(isRecord(body) ? { owner: { person: 'person' }, ...body } : body),
    }),
    env,
    createMockExecutionContext(),
  );
const payload = async (response: Promise<Response> | Response) => {
  const answer = await response;
  expect(answer.status).toBe(200);
  return answer.json();
};

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  registration = await registerOAuthClient(env.db, {
    name: 'Runtime app',
    operator: 'Test',
    redirectUris: ['https://connected-app.test/callback'],
    scopes: ['profile'],
  });
  const owner = await createTestUser(
    env.db,
    'app-owner',
    'app:' + registration.client.id,
    'person',
  );
  const foreign = await createTestUser(env.db, 'foreign-owner');
  project = await createTestProject(env.db, owner.id);
  other = await createTestProject(env.db, foreign.id);
  await env.db.insert(resources).values([
    {
      id: 'res_files',
      project_id: project.id,
      type: 'r2',
      cf_id: 'private-bucket-id',
      binding_name: 'UPLOADS',
      metadata: { secret: 'never-return' },
    },
    {
      id: 'res_database',
      project_id: project.id,
      type: 'd1',
      cf_id: 'private-db-id',
      binding_name: 'DATA',
    },
    {
      id: 'res_queue',
      project_id: project.id,
      type: 'queue',
      cf_id: 'private-queue-id',
      binding_name: 'JOBS',
    },
    {
      id: 'res_foreign',
      project_id: other.id,
      type: 'r2',
      cf_id: 'other-bucket',
      binding_name: 'UPLOADS',
    },
  ]);
  proxy.mockReset();
  env.PLATFORM_PROXY = {
    fetch: proxy,
    connect: () => {
      throw new Error('Unexpected socket connection');
    },
  };
  delete env.DEV_AUTH_BYPASS;
  delete env.PLATFORM_RUNTIME_LOGS;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connected app runtime reads', () => {
  it('authenticates the connected app and excludes other clients, owners and provider details', async () => {
    expect((await call('projects.resources', { project: project.id }, 'Basic bad')).status).toBe(
      401,
    );
    expect((await call('projects.resources', { project: other.id })).status).toBe(404);
    expect(
      (await call('projects.resources', { project: project.id, owner: { person: 'other-person' } }))
        .status,
    ).toBe(404);
    expect((await call('projects.resources', { project: project.id, owner: null })).status).toBe(
      400,
    );
    const result = await payload(call('projects.resources', { project: project.id }));
    expect(result).toMatchObject({
      data: {
        appId: project.id,
        available: true,
        resources: [
          { id: 'res_files', name: 'UPLOADS', kind: 'files', browse: 'files' },
          { id: 'res_database', name: 'DATA', kind: 'database', browse: 'tables' },
          { id: 'res_queue', name: 'JOBS', kind: 'queue', browse: null },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-|never-return|cf_id|proxy_token/);
  });

  it('inspects active owned previews but refuses expired, inactive and foreign-client previews', async () => {
    await env.db
      .update(projects)
      .set({
        preview_client_id: registration.client.id,
        preview_workspace_id: 'runtime-test',
        slug: 'preview-runtime-test',
        preview_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .where(eq(projects.id, project.id));
    proxy.mockResolvedValue(Response.json({ objects: [], truncated: false }));
    expect((await call('projects.resources', { project: project.id })).status).toBe(200);
    expect(
      (await call('resources.inspect', { project: project.id, resourceId: 'res_files' })).status,
    ).toBe(200);
    expect((await call('projects.activity', { project: project.id })).status).toBe(200);
    const foreignClient = await registerOAuthClient(env.db, {
      name: 'Other app',
      operator: 'Test',
      redirectUris: ['https://other.test/callback'],
      scopes: ['profile'],
    });
    for (const change of [
      { preview_expires_at: new Date(Date.now() - 1).toISOString() },
      {
        preview_expires_at: new Date(Date.now() + 60_000).toISOString(),
        status: 'deleting' as const,
      },
      { status: 'active' as const, preview_client_id: foreignClient.client.id },
    ]) {
      await env.db.update(projects).set(change).where(eq(projects.id, project.id));
      for (const [route, extra] of [
        ['projects.resources', {}],
        ['resources.inspect', { resourceId: 'res_files' }],
        ['projects.activity', {}],
      ] as const) {
        expect((await call(route, { project: project.id, ...extra })).status).toBe(404);
      }
    }
  });

  it('discards a preview read that expires while storage is being read', async () => {
    await env.db
      .update(projects)
      .set({
        preview_client_id: registration.client.id,
        preview_workspace_id: 'runtime-test',
        slug: 'preview-runtime-test',
        preview_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .where(eq(projects.id, project.id));
    proxy.mockImplementation(async () => {
      await env.db
        .update(projects)
        .set({ preview_expires_at: new Date(Date.now() - 1).toISOString() })
        .where(eq(projects.id, project.id));
      return Response.json({ objects: [], truncated: false });
    });
    expect(
      (await call('resources.inspect', { project: project.id, resourceId: 'res_files' })).status,
    ).toBe(409);
  });

  it('lists only the selected resource and forwards bounded paging without exposing its credential', async () => {
    proxy.mockResolvedValue(
      Response.json({
        objects: [{ key: 'photos/image.png', size: 1234, lastModified: '2026-11-24T00:00:00Z' }],
        truncated: true,
        cursor: 'next-page',
      }),
    );
    expect(
      (await call('resources.inspect', { project: project.id, resourceId: 'res_foreign' })).status,
    ).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
    const result = await payload(
      call('resources.inspect', {
        project: project.id,
        resourceId: 'res_files',
        prefix: 'photos/',
        cursor: 'previous',
      }),
    );
    expect(result).toMatchObject({
      data: {
        kind: 'files',
        appId: project.id,
        resourceId: 'res_files',
        objects: [{ key: 'photos/image.png', size: 1234 }],
        cursor: 'next-page',
      },
    });
    const request = JSON.parse(String(proxy.mock.calls[0][1]?.body));
    expect(request).toMatchObject({
      projectId: project.id,
      binding: 'UPLOADS',
      limit: 50,
      prefix: 'photos/',
      cursor: 'previous',
    });
    expect(request.aiToken).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(request.aiToken);
  });

  it('hides known migration tables without hiding similarly named customer tables', async () => {
    const sqlite = new DatabaseSync(':memory:');
    const managed = [
      '_void_migrations',
      '_void_migration_attempts',
      '_void_migration_fences',
      '_void_migration_lock',
      '_migrations',
      '__drizzle_migrations',
    ];
    const customer = ['notes', 'attachments', '_void_customer_data', '_void_migrations_archive'];
    for (const name of [...managed, ...customer]) {
      sqlite.exec('CREATE TABLE "' + name + '" (content TEXT)');
      sqlite.prepare('INSERT INTO "' + name + '" VALUES (?)').run('kept');
    }
    proxy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ results: sqlite.prepare(body.sql).all(...body.params) });
    });
    try {
      expect(
        await payload(
          call('resources.inspect', { project: project.id, resourceId: 'res_database' }),
        ),
      ).toMatchObject({ data: { kind: 'tables', tables: [...customer].sort() } });
      for (const table of managed) {
        expect(
          (
            await call('resources.inspect', {
              project: project.id,
              resourceId: 'res_database',
              table,
            })
          ).status,
        ).toBe(400);
      }
      for (const table of customer) {
        expect(
          await payload(
            call('resources.inspect', { project: project.id, resourceId: 'res_database', table }),
          ),
        ).toMatchObject({ data: { kind: 'rows', rows: [['kept']] } });
      }
    } finally {
      sqlite.close();
    }
  });

  it('uses fixed read-only SQLite queries, quotes identifiers, and masks credential cells', async () => {
    const sqlite = new DatabaseSync(':memory:');
    const table = 'users"; DROP TABLE users;--';
    sqlite.exec(
      'CREATE TABLE "users""; DROP TABLE users;--" (name TEXT, password TEXT, session_token TEXT, amount INTEGER, data BLOB);',
    );
    sqlite
      .prepare('INSERT INTO "users""; DROP TABLE users;--" VALUES (?, ?, ?, ?, ?)')
      .run('Ada', 'secret-password', 'secret-token', 42, new Uint8Array([1, 2]));
    const queries: Array<string> = [];
    proxy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      queries.push(body.sql);
      return Response.json({ results: sqlite.prepare(body.sql).all(...body.params) });
    });
    try {
      expect(
        await payload(
          call('resources.inspect', { project: project.id, resourceId: 'res_database' }),
        ),
      ).toMatchObject({ data: { kind: 'tables', tables: [table] } });
      expect(
        await payload(
          call('resources.inspect', { project: project.id, resourceId: 'res_database', table }),
        ),
      ).toMatchObject({
        data: {
          kind: 'rows',
          table,
          columns: ['name', 'password', 'session_token', 'amount', 'data'],
          rows: [['Ada', '[redacted]', '[redacted]', 42, '[binary]']],
          nextOffset: null,
        },
      });
      expect(queries.every((query) => /^(SELECT|PRAGMA table_info)/.test(query))).toBe(true);
      expect(
        (
          await call('resources.inspect', {
            project: project.id,
            resourceId: 'res_database',
            table: 'unrelated',
          })
        ).status,
      ).toBe(400);
    } finally {
      sqlite.close();
    }
  });

  it('redacts common API and access key names while keeping ordinary fields readable', async () => {
    const sqlite = new DatabaseSync(':memory:');
    const credentials = [
      'api_key',
      'apiKey',
      'API-KEY',
      'access_key',
      'accessKey',
      'aws_access_key_id',
    ];
    const ordinary = ['api_version', 'access_count', 'public_key', 'keyboard', 'name'];
    const columns = [...credentials, ...ordinary];
    sqlite.exec(`CREATE TABLE settings (${columns.map((name) => `"${name}" TEXT`).join(', ')})`);
    sqlite
      .prepare(`INSERT INTO settings VALUES (${columns.map(() => '?').join(', ')})`)
      .run(
        ...credentials.map((name) => `sensitive-${name}`),
        ...ordinary.map((name) => `visible-${name}`),
      );
    proxy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ results: sqlite.prepare(body.sql).all(...body.params) });
    });
    try {
      const answer = await payload(
        call('resources.inspect', {
          project: project.id,
          resourceId: 'res_database',
          table: 'settings',
        }),
      );
      expect(answer).toMatchObject({
        data: {
          kind: 'rows',
          columns,
          rows: [
            [...credentials.map(() => '[redacted]'), ...ordinary.map((name) => `visible-${name}`)],
          ],
        },
      });
      expect(JSON.stringify(answer)).not.toContain('sensitive-');
    } finally {
      sqlite.close();
    }
  });

  it('separates an empty page from unavailable capability and rejects unbounded input', async () => {
    proxy.mockResolvedValue(Response.json({ objects: [], truncated: false }));
    expect(
      await payload(call('resources.inspect', { project: project.id, resourceId: 'res_files' })),
    ).toMatchObject({ data: { kind: 'files', objects: [], cursor: null } });
    delete env.PLATFORM_PROXY;
    expect(
      await payload(call('resources.inspect', { project: project.id, resourceId: 'res_files' })),
    ).toMatchObject({ data: { kind: 'unavailable' } });
    expect(
      await payload(call('resources.inspect', { project: project.id, resourceId: 'res_queue' })),
    ).toMatchObject({ data: { kind: 'unavailable' } });
    expect(
      (
        await call('resources.inspect', {
          project: project.id,
          resourceId: 'res_database',
          offset: 10_001,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('resources.inspect', {
          project: project.id,
          resourceId: 'res_files',
          cursor: 'x'.repeat(4097),
        })
      ).status,
    ).toBe(400);
  });

  it('discards a resource result if ownership changes during the read', async () => {
    const [foreign] = await env.db.select().from(projects).where(eq(projects.id, other.id));
    proxy.mockImplementation(async () => {
      await env.db
        .update(projects)
        .set({ user_id: foreign.user_id })
        .where(eq(projects.id, project.id));
      return Response.json({ objects: [{ key: 'private.txt', size: 12 }], truncated: false });
    });
    const response = await call('resources.inspect', {
      project: project.id,
      resourceId: 'res_files',
    });
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('private.txt');
  });

  it('reads actual deployment activity and failure context without URL query credentials', async () => {
    const deployment = await createTestDeployment(env.db, project.id);
    const queries: Array<string> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        queries.push(String(init.body));
        return Response.json({
          data: [
            {
              ts: Date.now() - 1000,
              outcome: 'exception',
              logData: '[{"level":"error","message":"Upload processing failed"}]',
              exceptionData: '[{"name":"TypeError","message":"Missing object key"}]',
              url: 'https://app.test/upload?token=private#secret',
              method: 'POST',
              statusCode: '500',
              ingestedAt: new Date().toISOString(),
            },
          ],
        });
      }),
    );
    const result = await payload(call('projects.activity', { project: project.id }));
    expect(result).toMatchObject({
      data: {
        appId: project.id,
        scope: 'app',
        available: true,
        events: [{ level: 'error', request: { url: 'https://app.test/upload', status: 500 } }],
      },
    });
    expect(JSON.stringify(result)).toContain('Missing object key');
    expect(JSON.stringify(result)).not.toContain('token=');
    expect(queries[0]).toContain(deployment.id);
    expect(queries[0]).toContain(`user-${project.slug}`);
  });

  it('hides control requests while retaining customer traffic and HTTP failure severity', async () => {
    await createTestDeployment(env.db, project.id);
    const inputs = [
      ['https://worker/__platform/d1/query', 404],
      ['https://worker/__platform/r2/list', 404],
      ['https://internal/__platform/ready', 200],
      ['https://internal/__platform/migrate/start', 500],
      ['https://app.test/__platform/d1/query', 404],
      ['https://app.test/upload', 500],
      ['https://worker/customer', 200],
      ['https://internal/__platformish', 200],
      ['https://worker.example/__platform/ready', 400],
      ['https://app.test/exception', 400],
    ] as const;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: inputs.map(([url, statusCode], index) => ({
            ts: Date.now() - 1000 - index,
            outcome: 'ok',
            logData: '[]',
            exceptionData: url.endsWith('/exception')
              ? '[{"name":"Error","message":"Request failed"}]'
              : '[]',
            url,
            method: 'POST',
            statusCode: String(statusCode),
            ingestedAt: new Date().toISOString(),
          })),
        }),
      ),
    );
    const result = await payload(call('projects.activity', { project: project.id }));
    expect(result).toMatchObject({
      data: {
        available: true,
        events: [
          { level: 'warn', message: 'Request returned HTTP 404', request: { url: inputs[4][0] } },
          { level: 'error', message: 'Request returned HTTP 500', request: { url: inputs[5][0] } },
          { level: 'info', request: { url: inputs[6][0] } },
          { level: 'info', request: { url: inputs[7][0] } },
          { level: 'warn', request: { url: inputs[8][0] } },
          { level: 'error', request: { url: inputs[9][0] } },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('https://worker/__platform/');
    expect(JSON.stringify(result)).not.toContain('https://internal/__platform/');
  });

  it('refuses a cross-project deployment pointer before reading logs', async () => {
    const foreign = await createTestDeployment(env.db, other.id);
    await env.db
      .update(projects)
      .set({ active_deployment_id: foreign.id })
      .where(eq(projects.id, project.id));
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    expect(await payload(call('projects.activity', { project: project.id }))).toMatchObject({
      data: { available: false, events: [] },
    });
    expect(network).not.toHaveBeenCalled();
  });

  it('discards activity when ownership changes during the log query', async () => {
    await createTestDeployment(env.db, project.id);
    const [foreign] = await env.db.select().from(projects).where(eq(projects.id, other.id));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await env.db
          .update(projects)
          .set({ user_id: foreign.user_id })
          .where(eq(projects.id, project.id));
        return Response.json({ data: [] });
      }),
    );
    expect((await call('projects.activity', { project: project.id })).status).toBe(409);
  });

  it('does not substitute synthetic logs with local dev bypass', async () => {
    await createTestDeployment(env.db, project.id);
    env.DEV_AUTH_BYPASS = 'true';
    expect(await payload(call('projects.activity', { project: project.id }))).toMatchObject({
      data: { available: false, events: [] },
    });
  });
});

it('reads a group resource only for that connected app and exact group owner', async () => {
  await env.db
    .update(users)
    .set({ provider_id: 'group:server:team' })
    .where(eq(users.provider_id, 'person'));
  expect((await call('projects.resources', { project: project.id })).status).toBe(404);
  expect(
    (
      await call('projects.resources', {
        project: project.id,
        owner: { person: 'group:server:team' },
      })
    ).status,
  ).toBe(400);
  expect(
    (await call('projects.resources', { project: project.id, owner: { group: 'server:wrong' } }))
      .status,
  ).toBe(404);
  const answer = await payload(
    call('projects.resources', { project: project.id, owner: { group: 'server:team' } }),
  );
  expect(answer).toMatchObject({ data: { appId: project.id, available: true } });
  const foreign = await registerOAuthClient(env.db, {
    name: 'Different connection',
    operator: 'Test',
    redirectUris: ['https://other.test/callback'],
    scopes: ['profile'],
  });
  expect(
    (
      await call(
        'projects.resources',
        { project: project.id, owner: { group: 'server:team' } },
        'Basic ' + btoa(foreign.client.id + ':' + foreign.clientSecret),
      )
    ).status,
  ).toBe(404);
});

describe('connected app resource actions', () => {
  const execute = (action: string, input: unknown, resourceId = 'res_files') =>
    call('resources.execute', { project: project.id, resourceId, action, input });
  const file = (
    content = 'Hello',
    options: { etag?: string; native?: boolean; contentType?: string } = {},
  ) => {
    const etag = options.etag ?? 'original-etag';
    const headers = new Headers({
      'content-type': options.contentType ?? 'text/plain',
      etag: `"${etag}"`,
    });
    if (options.native !== false) {
      headers.set(
        'x-platform-r2-object',
        encodeURIComponent(
          JSON.stringify({
            key: 'note.txt',
            size: new TextEncoder().encode(content).length,
            etag,
            httpMetadata: { contentType: 'text/plain', cacheControl: 'private' },
            customMetadata: { author: 'owner' },
          }),
        ),
      );
    }
    return new Response(content, { headers });
  };
  beforeEach(async () => {
    await env.db.insert(resources).values({
      id: 'res_keys',
      project_id: project.id,
      type: 'kv',
      cf_id: 'private-namespace',
      binding_name: 'CACHE',
    });
  });
  it('describes only supported bounded actions without provider identifiers', async () => {
    const result = await payload(call('projects.resources', { project: project.id }));
    expect(result).toMatchObject({
      data: {
        resources: expect.arrayContaining([
          expect.objectContaining({
            id: 'res_files',
            actions: [
              expect.objectContaining({
                id: 'files.readText',
                effect: 'read',
                result: 'file-text',
              }),
              expect.objectContaining({
                id: 'files.saveText',
                effect: 'write',
                fields: [
                  expect.objectContaining({ name: 'key', maxLength: 1024 }),
                  expect.objectContaining({ name: 'text', maxLength: 65_536 }),
                ],
              }),
            ],
          }),
          expect.objectContaining({ id: 'res_queue', actions: [] }),
        ]),
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-namespace');
  });
  it('requires the connected client, exact owner and project resource', async () => {
    const body = {
      project: project.id,
      resourceId: 'res_files',
      action: 'files.readText',
      input: { key: 'note.txt' },
    };
    expect((await call('resources.execute', body, 'Basic bad')).status).toBe(401);
    expect(
      (await call('resources.execute', { ...body, owner: { person: 'someone-else' } })).status,
    ).toBe(404);
    expect((await call('resources.execute', { ...body, project: other.id })).status).toBe(404);
    expect((await execute('files.readText', { key: 'note.txt' }, 'res_foreign')).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });
  it('rejects unknown actions, injected fields, unbounded or incomplete inputs before provider access', async () => {
    for (const [action, input] of [
      ['sql.run', { sql: 'DROP TABLE notes' }],
      ['files.readText', { key: 'note.txt', binding: 'OTHER' }],
      ['files.readText', { key: '' }],
      ['files.saveText', { key: 'note.txt', text: 'x' }],
      ['files.saveText', { key: 'note.txt', text: 'é'.repeat(40_000), expectedEtag: 'old' }],
      ['keys.list', { cursor: 'x'.repeat(4097) }],
    ] as const) {
      expect((await execute(action, input)).status).toBe(400);
    }
    expect(proxy).not.toHaveBeenCalled();
  });
  it('opens native text and saves through only a conditional write with all metadata preserved', async () => {
    proxy.mockResolvedValueOnce(file());
    expect(await payload(execute('files.readText', { key: 'note.txt' }))).toMatchObject({
      data: { kind: 'file-text', text: 'Hello', etag: 'original-etag', size: 5, editable: true },
    });
    proxy
      .mockResolvedValueOnce(file())
      .mockResolvedValueOnce(Response.json({ key: 'note.txt', etag: 'new-etag' }));
    expect(
      await payload(
        execute('files.saveText', {
          key: 'note.txt',
          text: 'Updated',
          expectedEtag: 'original-etag',
        }),
      ),
    ).toMatchObject({ data: { kind: 'file-saved', key: 'note.txt', etag: 'new-etag' } });
    const [url, init] = proxy.mock.calls[2];
    expect(String(url)).toBe('https://proxy/r2/put-conditional');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      projectId: project.id,
      binding: 'UPLOADS',
      key: 'note.txt',
      value: 'Updated',
      onlyIf: { etagMatches: 'original-etag' },
      httpMetadata: { contentType: 'text/plain', cacheControl: 'private' },
      customMetadata: { author: 'owner' },
    });
  });
  it('reports unknown when authorization lookup fails after the provider accepted a save', async () => {
    proxy.mockResolvedValueOnce(file()).mockImplementationOnce(async () => {
      vi.spyOn(env.db, 'select').mockImplementationOnce(() => {
        throw new Error('Database unavailable');
      });
      return Response.json({ key: 'note.txt', etag: 'saved-etag' });
    });
    try {
      expect(
        await payload(
          execute('files.saveText', {
            key: 'note.txt',
            text: 'Saved',
            expectedEtag: 'original-etag',
          }),
        ),
      ).toMatchObject({ data: { kind: 'unknown' } });
      expect(proxy).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('refuses stale content before writing and treats a provider precondition miss as conflict', async () => {
    proxy.mockResolvedValueOnce(file('Hello', { etag: 'someone-else' }));
    expect(
      await payload(
        execute('files.saveText', { key: 'note.txt', text: 'New', expectedEtag: 'original-etag' }),
      ),
    ).toMatchObject({ data: { kind: 'conflict' } });
    expect(proxy).toHaveBeenCalledTimes(1);
    proxy.mockResolvedValueOnce(file()).mockResolvedValueOnce(Response.json(null));
    expect(
      await payload(
        execute('files.saveText', { key: 'note.txt', text: 'New', expectedEtag: 'original-etag' }),
      ),
    ).toMatchObject({ data: { kind: 'conflict' } });
  });
  it('keeps legacy reads read-only and never downgrades unsupported or uncertain conditional writes', async () => {
    proxy.mockResolvedValueOnce(file('Hello', { native: false }));
    expect(await payload(execute('files.readText', { key: 'note.txt' }))).toMatchObject({
      data: { kind: 'file-text', editable: false },
    });
    proxy.mockResolvedValueOnce(file('Hello', { native: false }));
    expect(
      await payload(
        execute('files.saveText', { key: 'note.txt', text: 'New', expectedEtag: 'original-etag' }),
      ),
    ).toMatchObject({ data: { kind: 'unavailable' } });
    expect(proxy).toHaveBeenCalledTimes(2);
    for (const response of [
      new Response('unsupported', { status: 501 }),
      new Response('failed', { status: 502 }),
      Response.json({ success: true }),
    ]) {
      proxy.mockResolvedValueOnce(file()).mockResolvedValueOnce(response);
      expect(
        await payload(
          execute('files.saveText', {
            key: 'note.txt',
            text: 'New',
            expectedEtag: 'original-etag',
          }),
        ),
      ).toMatchObject({ data: { kind: response.status === 501 ? 'unavailable' : 'unknown' } });
    }
    expect(proxy.mock.calls.filter(([url]) => String(url).endsWith('/r2/put'))).toHaveLength(0);
  });
  it('refuses binary, oversized, malformed and missing file responses', async () => {
    const broken = file();
    broken.headers.set('x-platform-r2-object', '%broken');
    for (const response of [
      file('x'.repeat(65_537)),
      file('\u0000binary'),
      file('plain', { contentType: 'image/png' }),
      new Response(new Uint8Array([255, 254]), {
        headers: { etag: '"raw"', 'content-type': 'text/plain' },
      }),
      broken,
      Response.json(null),
    ]) {
      proxy.mockResolvedValueOnce(response);
      expect(await payload(execute('files.readText', { key: 'note.txt' }))).toMatchObject({
        data: { kind: 'unavailable' },
      });
    }
  });
  it('rechecks scope after reads and before writes', async () => {
    proxy.mockImplementationOnce(async () => {
      await env.db
        .update(resources)
        .set({ cf_id: 'new-bucket' })
        .where(eq(resources.id, 'res_files'));
      return file();
    });
    expect((await execute('files.readText', { key: 'note.txt' })).status).toBe(409);
    proxy.mockImplementationOnce(async () => {
      await env.db
        .update(resources)
        .set({ binding_name: 'OTHER' })
        .where(eq(resources.id, 'res_files'));
      return file();
    });
    expect(
      await payload(
        execute('files.saveText', { key: 'note.txt', text: 'New', expectedEtag: 'original-etag' }),
      ),
    ).toMatchObject({ data: { kind: 'unknown' } });
    expect(proxy).toHaveBeenCalledTimes(2);
  });
  it('lists bounded keys, excludes credential keys and redacts nested JSON credential values', async () => {
    proxy.mockResolvedValueOnce(
      Response.json({
        keys: [{ name: 'settings' }, { name: 'password' }, { name: 'session', expiration: 1000 }],
        list_complete: false,
        cursor: 'next',
      }),
    );
    expect(
      await payload(execute('keys.list', { prefix: '', cursor: 'previous' }, 'res_keys')),
    ).toMatchObject({
      data: {
        kind: 'keys',
        keys: [
          { name: 'settings', expiration: null },
          { name: 'session', expiration: 1000 },
        ],
        cursor: 'next',
      },
    });
    proxy.mockResolvedValueOnce(
      Response.json('{"title":"Hello","nested":{"api_key":"secret-value"}}'),
    );
    const result = await payload(execute('keys.read', { key: 'settings' }, 'res_keys'));
    expect(result).toMatchObject({
      data: { text: JSON.stringify({ title: 'Hello', nested: { api_key: '[redacted]' } }) },
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
    const before = proxy.mock.calls.length;
    expect(await payload(execute('keys.read', { key: 'access-token' }, 'res_keys'))).toMatchObject({
      data: { kind: 'unavailable' },
    });
    expect(proxy).toHaveBeenCalledTimes(before);
  });
  it('rejects malformed, missing and oversized key values and lists', async () => {
    for (const value of [
      { keys: 'bad' },
      { keys: [{ name: 'name', expiration: 'bad' }], list_complete: true },
      { keys: [], list_complete: false },
    ]) {
      proxy.mockResolvedValueOnce(Response.json(value));
      expect(await payload(execute('keys.list', {}, 'res_keys'))).toMatchObject({
        data: { kind: 'unavailable' },
      });
    }
    for (const value of [null, { bad: true }, 'x'.repeat(65_537), '\u0000binary']) {
      proxy.mockResolvedValueOnce(Response.json(value));
      expect(await payload(execute('keys.read', { key: 'settings' }, 'res_keys'))).toMatchObject({
        data: { kind: 'unavailable' },
      });
    }
  });
});
