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
import { APP } from '../../src/app-credits.ts';
import { registerOAuthClient } from '../../src/auth/oauth.ts';
import app from '../../src/index.ts';
import { deploymentLogs } from '../../src/operator/deployment-operations.ts';
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
let ownerId: string;
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

const activityData = async (body: unknown) => {
  const value = await payload(call('projects.activity', body));
  if (!isRecord(value) || !isRecord(value.data)) {
    throw Error('Invalid activity response');
  }
  return value.data;
};

function activitySql(deploymentId: string, urls: Array<string>) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.function('startsWith', (value, prefix) =>
    String(value).startsWith(String(prefix)) ? 1 : 0,
  );
  sqlite.function('toDateTime', String);
  sqlite.exec(
    'CREATE TABLE platform_logs(timestamp TEXT, index1 TEXT, blob1 TEXT, blob2 TEXT, blob3 TEXT, blob4 TEXT, blob5 TEXT, blob6 TEXT, blob7 TEXT, blob8 TEXT, double1 INTEGER)',
  );
  const insert = sqlite.prepare(
    'INSERT INTO platform_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const now = Date.now() - 5000;
  urls.forEach((url, i) =>
    insert.run(
      new Date(now - i * 1000).toISOString().replace('T', ' ').slice(0, 19),
      'user-' + project.slug,
      'ok',
      '[]',
      '[]',
      url,
      'GET',
      '200',
      deploymentId,
      'ray-' + i,
      now - i * 1000,
    ),
  );
  return sqlite;
}

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
  const owner = await createTestUser(env.db, 'app-owner', APP + registration.client.id, 'person');
  ownerId = owner.id;
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
      expect(queries.every((query) => /^(SELECT|PRAGMA table_xinfo)/.test(query))).toBe(true);
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

  it('leaves operator logs unfiltered and refuses customer cursor scope', async () => {
    const deployment = await createTestDeployment(env.db, project.id);
    const sqlite = activitySql(deployment.id, [
      'https://worker/__platform/ready',
      'https://internal/__platform/r2/list',
      'https://app.test/import',
    ]);
    const fetcher = vi.fn(async (_url, init) =>
      Response.json({ data: sqlite.prepare(String(init.body)).all() }),
    );
    vi.stubGlobal('fetch', fetcher);
    try {
      const page = await deploymentLogs(env.db, env, deployment.id, { limit: 2 });
      expect(page.data).toHaveLength(2);
      expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain('startsWith');
      if (!page.nextCursor) {
        throw Error('Missing test cursor');
      }
      const cursor: unknown = JSON.parse(atob(page.nextCursor));
      if (!isRecord(cursor)) {
        throw Error('Invalid test cursor');
      }
      expect(cursor.scope).toBeUndefined();
      const second = await deploymentLogs(env.db, env, deployment.id, {
        limit: 2,
        cursor: page.nextCursor,
      });
      expect(second.data).toHaveLength(1);
      await expect(
        deploymentLogs(env.db, env, deployment.id, {
          cursor: btoa(JSON.stringify({ ...cursor, scope: 'customer-activity-v1' })),
        }),
      ).rejects.toThrow('Invalid deployment log cursor');
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      sqlite.close();
    }
  });

  it('filters housekeeping before counting customer pages in the actual generated SQL', async () => {
    const deployment = await createTestDeployment(env.db, project.id);
    const controls = Array.from(
      { length: 110 },
      (_, i) => `https://worker/__platform/r2/list?cursor=${i}`,
    );
    const customers = Array.from({ length: 60 }, (_, i) => `https://app.test/import/${i}`);
    const sqlite = activitySql(deployment.id, [...controls, ...customers]);
    const returnedCounts: Array<number> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const query = String(init.body);
        expect(query.length).toBeLessThan(10_000);
        const rows = sqlite.prepare(query).all();
        returnedCounts.push(rows.length);
        return Response.json({ data: rows });
      }),
    );
    try {
      const first = await activityData({ project: project.id });
      expect(first.events).toMatchObject(
        customers.slice(0, 50).map((url) => ({ request: { url } })),
      );
      expect(first.previousCursor).toBeNull();
      const second = await activityData({ project: project.id, cursor: first.cursor });
      expect(second.events).toMatchObject(customers.slice(50).map((url) => ({ request: { url } })));
      expect(second.cursor).toBeNull();
      expect(second.window).toEqual(first.window);
      const back = await activityData({ project: project.id, cursor: second.previousCursor });
      expect(back.events).toEqual(first.events);
      expect(back.window).toEqual(first.window);
      expect(returnedCounts).toEqual([51, 10, 51]);
    } finally {
      sqlite.close();
    }
  });

  it('keeps exact relay and public-host URLs in the SQL predicate while excluding control suffixes', async () => {
    const deployment = await createTestDeployment(env.db, project.id);
    const origins = ['https://worker', 'https://internal', 'http://worker', 'http://internal'];
    const hidden = origins.flatMap((origin) =>
      [
        '/__platform',
        '/__platform?probe=1',
        '/__platform#probe',
        '/__platform/ready',
        '/__platform/queue/status',
        '/__platform/scheduled/status',
      ].map((path) => origin + path),
    );
    const kept = origins.flatMap((origin) =>
      [
        '/__platform/queue',
        '/__platform/queue?token=private',
        '/__platform/scheduled#fragment',
        '/__queue',
        '/__scheduled',
        '/__platformish',
      ].map((path) => origin + path),
    );
    kept.push(
      'https://app.test/__platform/ready',
      'https://worker.example/__platform/ready',
      'https://app.test/__platform/queue',
      'https://app.test/__platform/scheduled',
      'https://app.test/normal?next=https://worker/__platform/ready',
      '',
    );
    const sqlite = activitySql(deployment.id, [...hidden, ...kept]);
    let observed: Array<string> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const rows = sqlite.prepare(String(init.body)).all();
        observed = rows.map((row) => String(row.url));
        return Response.json({ data: rows });
      }),
    );
    try {
      const result = await activityData({ project: project.id });
      expect(observed).toEqual(kept);
      expect(result.events).toHaveLength(kept.length);
      expect(JSON.stringify(result.events)).toContain('Background job');
      expect(JSON.stringify(result.events)).toContain('Scheduled task');
      expect(JSON.stringify(result.events)).not.toContain('token=private');
    } finally {
      sqlite.close();
    }
  });

  it.each([undefined, 'operator', 'customer-activity-v0'])(
    'refuses old or mismatched Activity cursor scope %s',
    async (scope) => {
      const deployment = await createTestDeployment(env.db, project.id);
      const until = Math.floor(Date.now() / 1000) * 1000;
      const cursor = btoa(
        JSON.stringify({
          id: deployment.id,
          range: '1h',
          since: until - 3_600_000,
          until,
          offset: 50,
          clock: 'ingestion',
          scope,
        }),
      );
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      expect((await call('projects.activity', { project: project.id, cursor })).status).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(['1h', '24h', '7d'] as const)(
    'reads the requested %s ingestion window',
    async (range) => {
      const deployment = await createTestDeployment(env.db, project.id);
      const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [] }));
      vi.stubGlobal('fetch', fetcher);
      env.PLATFORM_RUNTIME_LOGS = 'minimal';
      const result = await activityData({ project: project.id, range });
      expect(result).toMatchObject({
        range,
        deploymentId: deployment.id,
        partial: true,
        available: true,
        previousCursor: null,
        cursor: null,
      });
      if (
        !isRecord(result.window) ||
        typeof result.window.from !== 'number' ||
        typeof result.window.to !== 'number'
      ) {
        throw Error('Invalid window');
      }
      const { from, to } = result.window;
      expect(to - from).toBe(
        range === '7d' ? 604_800_000 : range === '24h' ? 86_400_000 : 3_600_000,
      );
      expect(from % 1000).toBe(0);
      expect(to % 1000).toBe(0);
      expect(to).toBeLessThanOrEqual(Date.now());
      const query = String(fetcher.mock.calls[0]?.[1]?.body);
      expect(query).toContain(new Date(from).toISOString().replace('T', ' ').slice(0, 19));
      expect(query).toContain(new Date(to).toISOString().replace('T', ' ').slice(0, 19));
      expect(query).toContain('ORDER BY ingestedAt DESC, ts DESC');
      expect(query).not.toMatch(/double1 >=/);
    },
  );

  it('timestamps successful activity after an awaited read crosses a second boundary', async () => {
    await createTestDeployment(env.db, project.id);
    let clock = Date.now(),
      readCompletedAt = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 1100;
      return clock;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await Promise.resolve();
        clock += 2000;
        readCompletedAt = clock;
        return Response.json({ data: [] });
      }),
    );
    try {
      const result = await activityData({ project: project.id });
      if (
        !isRecord(result.window) ||
        typeof result.window.to !== 'number' ||
        typeof result.checkedAt !== 'number'
      ) {
        throw Error('Invalid observed activity time');
      }
      expect(result.checkedAt).toBeGreaterThanOrEqual(result.window.to);
      expect(result.checkedAt).toBeGreaterThanOrEqual(readCompletedAt);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps both directions on the same captured window and defaults to one hour', async () => {
    await createTestDeployment(env.db, project.id);
    const row = {
      ts: Date.now() - 1000,
      ingestedAt: new Date().toISOString(),
      outcome: 'ok',
      logData: '[]',
      exceptionData: '[]',
      url: '/products',
      method: 'GET',
      statusCode: '200',
    };
    const fetcher = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ data: Array.from({ length: 51 }, () => row) })),
      );
    vi.stubGlobal('fetch', fetcher);
    const first = await activityData({ project: project.id });
    expect(first.range).toBe('1h');
    expect(first.previousCursor).toBeNull();
    expect(first.cursor).toEqual(expect.any(String));
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    try {
      const second = await activityData({ project: project.id, cursor: first.cursor });
      expect(second.window).toEqual(first.window);
      expect(second.previousCursor).toEqual(expect.any(String));
      expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain('OFFSET 50');
      const back = await activityData({ project: project.id, cursor: second.previousCursor });
      expect(back.window).toEqual(first.window);
      expect(back.previousCursor).toBeNull();
      expect(String(fetcher.mock.calls[2]?.[1]?.body)).toContain('OFFSET 0');
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    'mismatch',
    'missing-range',
    'too-wide',
    'fractional-bound',
    'future',
    'deployment',
    'clock',
  ])('rejects %s activity cursors before querying', async (change) => {
    const deployment = await createTestDeployment(env.db, project.id);
    const until = Math.floor(Date.now() / 1000) * 1000;
    const cursor = {
      id: deployment.id,
      range: '24h' as string | undefined,
      scope: 'customer-activity-v1',
      since: until - 86_400_000,
      until,
      offset: 50,
      clock: 'ingestion',
    };
    if (change === 'mismatch') {
      cursor.range = '1h';
    }
    if (change === 'missing-range') {
      delete cursor.range;
    }
    if (change === 'too-wide') {
      cursor.since = until - 691_200_000;
    }
    if (change === 'fractional-bound') {
      cursor.since -= 1;
      cursor.until -= 1;
    }
    if (change === 'future') {
      cursor.since += 60_000;
      cursor.until += 60_000;
    }
    if (change === 'deployment') {
      cursor.id = 'another-deployment';
    }
    if (change === 'clock') {
      cursor.clock = 'event';
    }
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(
      (
        await call('projects.activity', {
          project: project.id,
          range: '24h',
          cursor: btoa(JSON.stringify(cursor)),
        })
      ).status,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['8d', '', null, 24])('rejects invalid activity range %s', async (range) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await call('projects.activity', { project: project.id, range })).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports unavailable scope without claiming a queried window', async () => {
    expect(await activityData({ project: project.id, range: '7d' })).toMatchObject({
      range: '7d',
      deploymentId: null,
      window: null,
      available: false,
      previousCursor: null,
    });
    const deployment = await createTestDeployment(env.db, project.id);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    expect(await activityData({ project: project.id, range: '24h' })).toMatchObject({
      range: '24h',
      deploymentId: deployment.id,
      window: null,
      available: false,
      previousCursor: null,
    });
  });

  it('refuses suspended projects before captured activity queries', async () => {
    await createTestDeployment(env.db, project.id);
    await env.db
      .update(projects)
      .set({ suspended_reason: 'admin' })
      .where(eq(projects.id, project.id));
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await activityData({ project: project.id })).available).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses suspended owners before reading and after a query', async () => {
    await createTestDeployment(env.db, project.id);
    await env.db.update(users).set({ suspended_reason: 'admin' }).where(eq(users.id, ownerId));
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await activityData({ project: project.id })).available).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    await env.db.update(users).set({ suspended_reason: null }).where(eq(users.id, ownerId));
    fetcher.mockImplementation(async () => {
      await env.db.update(users).set({ suspended_reason: 'admin' }).where(eq(users.id, ownerId));
      return Response.json({ data: [] });
    });
    expect((await call('projects.activity', { project: project.id })).status).toBe(409);
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
      ['https://internal/__platform/queue/status', 500],
      ['https://worker/__platform/scheduled/status', 500],
      ['https://app.test/__platform/queue', 500],
      ['https://app.test/__platform/scheduled', 200],
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
          { level: 'error', message: 'Request returned HTTP 500', request: { url: inputs[12][0] } },
          { level: 'info', message: 'Request finished: ok', request: { url: inputs[13][0] } },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('https://worker/__platform/');
    expect(JSON.stringify(result)).not.toContain('https://internal/__platform/');
  });

  it.each([
    ['/__platform/queue', 'Background job'],
    ['/__platform/scheduled', 'Scheduled task'],
    ['/__queue', 'Background job'],
    ['/__scheduled', 'Scheduled task'],
  ])(
    'keeps customer failures from the %s relay without exposing its internal URL',
    async (path, label) => {
      await createTestDeployment(env.db, project.id);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            data: ['internal', 'worker'].map((host, index) => ({
              ts: Date.now() - 1000 - index,
              outcome: 'exception',
              logData: '[{"level":"error","message":"Import attempt failed"}]',
              exceptionData: '[{"name":"TypeError","message":"Invalid supplier record"}]',
              url: `https://${host}${path}?token=private#secret`,
              method: 'POST',
              statusCode: '500',
              ingestedAt: new Date().toISOString(),
            })),
          }),
        ),
      );
      const result = await payload(call('projects.activity', { project: project.id }));
      expect(result).toMatchObject({
        data: {
          appId: project.id,
          scope: 'app',
          available: true,
          events: Array.from({ length: 2 }, () => ({
            level: 'error',
            message: `${label}: TypeError: Invalid supplier record\nImport attempt failed`,
          })),
        },
      });
      expect(JSON.stringify(result)).not.toMatch(/https:\/\/(internal|worker)|token=|"request":/);
    },
  );

  it('refuses other owners before querying background activity', async () => {
    await createTestDeployment(env.db, project.id);
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    expect((await call('projects.activity', { project: other.id })).status).toBe(404);
    expect(
      (await call('projects.activity', { project: project.id, owner: { person: 'other-person' } }))
        .status,
    ).toBe(404);
    expect(network).not.toHaveBeenCalled();
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
        return Response.json({
          data: [
            {
              ts: Date.now() - 1000,
              outcome: 'exception',
              logData: '[]',
              exceptionData: '[{"message":"Private import error"}]',
              url: 'https://internal/__platform/queue',
              method: 'POST',
              statusCode: '500',
              ingestedAt: new Date().toISOString(),
            },
          ],
        });
      }),
    );
    const response = await call('projects.activity', { project: project.id });
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('Private import error');
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

describe('database structure and server queries', () => {
  let sqlite: DatabaseSync;
  const queries: Array<{ sql: string; params: Array<string | number> }> = [];
  type InspectionInput = {
    table?: string;
    resourceId?: string;
    offset?: number;
    filter?: unknown;
    sort?: unknown;
  };
  const inspect = (input: InspectionInput = {}) =>
    call('resources.inspect', {
      project: project.id,
      resourceId: 'res_database',
      table: 'items',
      ...input,
    });
  const schema = (table = 'items') =>
    call('resources.execute', {
      project: project.id,
      resourceId: 'res_database',
      action: 'database.schema',
      input: { table },
    });
  const indexes = (table = 'items') =>
    call('resources.execute', {
      project: project.id,
      resourceId: 'res_database',
      action: 'database.indexes',
      input: { table },
    });
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(
      "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'private-default', category TEXT, quantity INTEGER, api_key TEXT, caption TEXT GENERATED ALWAYS AS (name || '!') VIRTUAL)",
    );
    const insert = sqlite.prepare(
      'INSERT INTO items (name,category,quantity,api_key) VALUES (?,?,?,?)',
    );
    for (let i = 1; i <= 125; i++) {
      insert.run(
        i === 75 ? 'Café, 100%_quoted' : `Item ${i}`,
        i % 2 ? 'odd' : null,
        i,
        `private-${i}`,
      );
    }
    queries.length = 0;
    proxy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      queries.push({ sql: body.sql, params: body.params });
      return Response.json({ results: sqlite.prepare(body.sql).all(...body.params) });
    });
  });
  afterEach(() => sqlite.close());

  const readRows = async (input: InspectionInput = {}) => {
    const value = await payload(inspect(input));
    if (!isRecord(value) || !isRecord(value.data)) {
      throw Error('Missing row response');
    }
    const { rows, rowTokens, cellMetadata, kind } = value.data;
    if (!Array.isArray(rows) || !Array.isArray(rowTokens) || !Array.isArray(cellMetadata)) {
      throw Error('Missing row metadata');
    }
    return {
      kind,
      rows: rows.map((row: unknown) => {
        if (!Array.isArray(row)) {
          throw Error('Invalid row');
        }
        return row;
      }),
      cellMetadata: cellMetadata.map((row: unknown) => {
        if (!Array.isArray(row)) {
          throw Error('Invalid metadata');
        }
        return row;
      }),
      rowTokens: rowTokens.map((token: unknown) => {
        if (token !== null && typeof token !== 'string') {
          throw Error('Invalid token');
        }
        return token;
      }),
    };
  };
  const rowReference = (page: Awaited<ReturnType<typeof readRows>>, index = 0) => {
    const value = page.rowTokens[index];
    if (typeof value !== 'string') {
      throw Error('Expected safe row reference');
    }
    return value;
  };
  const readCell = (
    rowToken: string,
    column = 'name',
    table = 'items',
    resourceId = 'res_database',
  ) =>
    call('resources.execute', {
      project: project.id,
      resourceId,
      action: 'database.cell',
      input: { table, column, rowToken },
    });
  it('marks UTF-8 previews and reads the complete current value by signed primary key', async () => {
    const text = 'é'.repeat(499) + '🙂' + 'z'.repeat(4000);
    sqlite.prepare('UPDATE items SET name = ? WHERE id = 1').run(text);
    const page = await readRows();
    expect(page.rows[0][1]).toBe('é'.repeat(160));
    expect(page.cellMetadata[0][1]).toEqual({ type: 'text', totalBytes: 5002, truncated: true });
    expect(page.cellMetadata[0][4]).toEqual({
      type: 'protected',
      totalBytes: null,
      truncated: false,
    });
    expect(page.rowTokens[0]).toEqual(expect.any(String));
    const result = await payload(readCell(rowReference(page)));
    expect(result).toMatchObject({
      data: {
        kind: 'cell',
        table: 'items',
        column: 'name',
        rowToken: page.rowTokens[0],
        valueType: 'text',
        text,
        totalBytes: 5002,
        truncated: false,
        checkedAt: expect.any(Number),
      },
    });
    sqlite.prepare('UPDATE items SET name = ? WHERE id = 1').run('Current value');
    expect(await payload(readCell(rowReference(page)))).toMatchObject({
      data: { kind: 'cell', text: 'Current value' },
    });
    expect(await payload(readCell(rowReference(page), 'api_key'))).toMatchObject({
      data: { kind: 'unavailable' },
    });
  });
  it('bounds a full field at 64 KiB without splitting a Unicode code point', async () => {
    const text = 'a'.repeat(65_535) + '🙂' + 'end';
    sqlite.prepare('UPDATE items SET name = ? WHERE id = 1').run(text);
    const page = await readRows();
    expect(await payload(readCell(rowReference(page)))).toMatchObject({
      data: { kind: 'cell', text: 'a'.repeat(65_535), totalBytes: 65_542, truncated: true },
    });
  });
  it('returns explicit binary, null and normalized numeric full-field states', async () => {
    sqlite.exec("UPDATE items SET category = X'0001FF', quantity = 1.0 WHERE id = 1");
    const page = await readRows();
    expect(page.cellMetadata[0][2]).toEqual({ type: 'binary', totalBytes: 3, truncated: false });
    expect(page.cellMetadata[0][3]).toEqual({ type: 'number', totalBytes: 1, truncated: false });
    expect(await payload(readCell(rowReference(page), 'category'))).toMatchObject({
      data: { valueType: 'binary', text: null, totalBytes: 3, truncated: false },
    });
    expect(await payload(readCell(rowReference(page), 'quantity'))).toMatchObject({
      data: { valueType: 'number', text: '1', totalBytes: 1, truncated: false },
    });
    sqlite.exec('UPDATE items SET category = NULL WHERE id = 1');
    expect(await payload(readCell(rowReference(page), 'category'))).toMatchObject({
      data: { valueType: 'null', text: null, totalBytes: 0, truncated: false },
    });
  });
  it('preserves a leading BOM in text values and primary keys and round-trips real numbers', async () => {
    sqlite.exec('CREATE TABLE unicode_keys (id TEXT PRIMARY KEY, body TEXT, amount REAL)');
    const value = '\uFEFF' + 'Body'.repeat(500);
    sqlite
      .prepare('INSERT INTO unicode_keys VALUES (?,?,?)')
      .run('\uFEFFkey', value, 1.2345678901234567);
    const page = await readRows({ table: 'unicode_keys' });
    expect(page.rows[0][0]).toBe('\uFEFFkey');
    expect(page.rows[0][2]).toBe(1.2345678901234567);
    expect(page.cellMetadata[0][2]).toEqual({ type: 'number', totalBytes: 18, truncated: false });
    expect(await payload(readCell(rowReference(page), 'body', 'unicode_keys'))).toMatchObject({
      data: { text: value, totalBytes: 2003, truncated: false },
    });
    expect(await payload(readCell(rowReference(page), 'amount', 'unicode_keys'))).toMatchObject({
      data: { text: '1.2345678901234567', totalBytes: 18, truncated: false },
    });
  });
  it('rejects invalid UTF-8 instead of trimming malformed bytes from a bounded prefix', async () => {
    sqlite.exec(
      "UPDATE items SET name = CAST(X'FF' AS TEXT) || printf('%2000s','tail') WHERE id = 1",
    );
    expect(await payload(inspect())).toMatchObject({ data: { kind: 'unavailable' } });
  });
  it('keeps SQLite integers beyond JavaScript precision exact', async () => {
    for (const number of ['9007199254740993', '-9223372036854775808']) {
      sqlite.exec('UPDATE items SET quantity = ' + number + ' WHERE id = 1');
      const page = await readRows();
      expect(page.rows[0][3]).toBe(number);
      expect(page.cellMetadata[0][3]).toEqual({
        type: 'text',
        totalBytes: number.length,
        truncated: false,
      });
      expect(await payload(readCell(rowReference(page), 'quantity'))).toMatchObject({
        data: { valueType: 'number', text: number, totalBytes: number.length, truncated: false },
      });
    }
  });
  it('locates complete composite keys after insertions and rejects deleted rows', async () => {
    sqlite.exec(
      'CREATE TABLE compound (group_name TEXT, item INTEGER, body TEXT, PRIMARY KEY(group_name,item)) WITHOUT ROWID',
    );
    sqlite.prepare('INSERT INTO compound VALUES (?,?,?)').run('é,"group', 7, 'right row');
    const page = await readRows({ table: 'compound' });
    sqlite.prepare('INSERT INTO compound VALUES (?,?,?)').run('a', 1, 'new earlier row');
    expect(await payload(readCell(rowReference(page), 'body', 'compound'))).toMatchObject({
      data: { text: 'right row' },
    });
    sqlite.prepare('DELETE FROM compound WHERE item = ?').run(7);
    expect(await payload(readCell(rowReference(page), 'body', 'compound'))).toMatchObject({
      data: { kind: 'unavailable' },
    });
  });
  it('omits references for rowid-only, nullable, protected, binary and oversized keys', async () => {
    const cases = [
      ['no_key', 'body TEXT', "'preview'"],
      ['null_key', 'id TEXT PRIMARY KEY, body TEXT', "NULL, 'preview'"],
      ['secret_key', 'api_key TEXT PRIMARY KEY, body TEXT', "'secret', 'preview'"],
      ['binary_key', 'id BLOB PRIMARY KEY, body TEXT', "X'01', 'preview'"],
      ['large_key', 'id TEXT PRIMARY KEY, body TEXT', "printf('%1100s','key'), 'preview'"],
    ];
    for (const [table, definition, values] of cases) {
      sqlite.exec(
        'CREATE TABLE ' +
          table +
          ' (' +
          definition +
          '); INSERT INTO ' +
          table +
          ' VALUES (' +
          values +
          ')',
      );
      expect((await readRows({ table })).rowTokens).toEqual([null]);
    }
  });
  it('rejects foreign, altered, expired and schema-stale references', async () => {
    const page = await readRows();
    const token = rowReference(page);
    proxy.mockClear();
    expect(
      await payload(readCell(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))),
    ).toMatchObject({ data: { kind: 'unavailable' } });
    expect(proxy).not.toHaveBeenCalled();
    expect((await readCell(token, 'name', 'items', 'res_foreign')).status).toBe(404);
    expect(await payload(readCell(token, 'name', 'another_table'))).toMatchObject({
      data: { kind: 'unavailable' },
    });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 900_001);
    expect(await payload(readCell(token))).toMatchObject({ data: { kind: 'unavailable' } });
    clock.mockRestore();
    sqlite.exec('ALTER TABLE items ADD COLUMN added TEXT');
    expect(await payload(readCell(token))).toMatchObject({ data: { kind: 'unavailable' } });
  });
  it('fences references to the exact database binding and rejects access changed during a read', async () => {
    const page = await readRows();
    const token = rowReference(page);
    await env.db.insert(resources).values({
      id: 'second_db',
      project_id: project.id,
      type: 'd1',
      cf_id: 'another-db',
      binding_name: 'SECOND',
    });
    proxy.mockClear();
    expect(await payload(readCell(token, 'name', 'items', 'second_db'))).toMatchObject({
      data: { kind: 'unavailable' },
    });
    expect(proxy).not.toHaveBeenCalled();
    proxy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const results = sqlite.prepare(body.sql).all(...body.params);
      if (body.sql.includes(' LIMIT 2')) {
        await env.db
          .update(resources)
          .set({ cf_id: 'changed-db' })
          .where(eq(resources.id, 'res_database'));
      }
      return Response.json({ results });
    });
    expect((await readCell(token)).status).toBe(409);
  });
  it('rejects schema changes during field retrieval and strict malformed inputs', async () => {
    const page = await readRows();
    const token = rowReference(page);
    for (const input of [
      { table: 'items', column: 'name', rowToken: token, sql: 'SELECT secret' },
      { table: 'items', column: 'name' },
      { table: 'items', column: 'name', rowToken: 'x'.repeat(8193) },
    ]) {
      expect(
        (
          await call('resources.execute', {
            project: project.id,
            resourceId: 'res_database',
            action: 'database.cell',
            input,
          })
        ).status,
      ).toBe(400);
    }
    proxy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const results = sqlite.prepare(body.sql).all(...body.params);
      if (body.sql.includes(' LIMIT 2')) {
        sqlite.exec('ALTER TABLE items ADD COLUMN changed TEXT');
      }
      return Response.json({ results });
    });
    expect(await payload(readCell(token))).toMatchObject({ data: { kind: 'unavailable' } });
  });
  it('bounds wide SQL pages before transport while keeping explicit truncation metadata', async () => {
    const names = Array.from({ length: 100 }, (_, index) => 'c' + index);
    sqlite.exec(
      'CREATE TABLE wide (' +
        names
          .map((name, index) => name + (index === 0 ? ' INTEGER PRIMARY KEY' : ' TEXT'))
          .join(',') +
        ')',
    );
    const insert = sqlite.prepare(
      'INSERT INTO wide VALUES (' + names.map(() => '?').join(',') + ')',
    );
    for (let index = 1; index <= 51; index++) {
      insert.run(index, ...names.slice(1).map(() => '\\'.repeat(5000)));
    }
    let maxBytes = 0;
    proxy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const result = { results: sqlite.prepare(body.sql).all(...body.params) };
      maxBytes = Math.max(maxBytes, new TextEncoder().encode(JSON.stringify(result)).length);
      return Response.json(result);
    });
    const page = await readRows({ table: 'wide' });
    expect(page.kind).toBe('rows');
    expect(page.rows).toHaveLength(50);
    expect(page.cellMetadata[0][1]).toMatchObject({
      type: 'text',
      totalBytes: 5000,
      truncated: true,
    });
    expect(maxBytes).toBeLessThan(512 * 1024);
  });

  it('advertises schema and query capabilities, and omits them without a storage connection', async () => {
    expect(await payload(call('projects.resources', { project: project.id }))).toMatchObject({
      data: {
        resources: expect.arrayContaining([
          expect.objectContaining({
            id: 'res_database',
            browseCapabilities: { filterOperators: ['equals', 'contains', 'is-null'], sort: true },
            actions: [
              {
                id: 'database.cell',
                label: 'Read full value',
                effect: 'read',
                result: 'cell',
                fields: [
                  { name: 'table', label: 'Table', type: 'text', required: true, maxLength: 200 },
                  { name: 'column', label: 'Column', type: 'text', required: true, maxLength: 200 },
                  {
                    name: 'rowToken',
                    label: 'Row reference',
                    type: 'text',
                    required: true,
                    maxLength: 8192,
                  },
                ],
              },
              {
                id: 'database.indexes',
                label: 'View indexes',
                effect: 'read',
                fields: [
                  { name: 'table', label: 'Table', type: 'text', required: true, maxLength: 200 },
                ],
                view: { scope: 'table', label: 'Indexes' },
                result: 'records',
              },
              {
                id: 'database.schema',
                label: 'View structure',
                effect: 'read',
                fields: [
                  { name: 'table', label: 'Table', type: 'text', required: true, maxLength: 200 },
                ],
                result: 'table-schema',
              },
            ],
          }),
        ]),
      },
    });
    delete env.PLATFORM_PROXY;
    const result = await payload(call('projects.resources', { project: project.id }));
    expect(JSON.stringify(result)).not.toContain('browseCapabilities');
    expect(JSON.stringify(result)).not.toContain('database.schema');
    expect(JSON.stringify(result)).not.toContain('database.indexes');
  });
  it('returns bounded records for actual SQLite indexes without definition SQL or protected names', async () => {
    sqlite.exec(`
      CREATE UNIQUE INDEX named_unique ON items(name);
      CREATE INDEX composite_index ON items(category, quantity DESC);
      CREATE INDEX expression_index ON items(lower(name));
      CREATE INDEX partial_index ON items(category) WHERE api_key = 'private-condition';
      CREATE INDEX protected_columns ON items(api_key);
      CREATE INDEX api_key_private_index ON items(api_key);
    `);
    const result = await payload(indexes());
    expect(result).toMatchObject({
      data: {
        appId: project.id,
        resourceId: 'res_database',
        action: 'database.indexes',
        kind: 'records',
        table: 'items',
        checkedAt: expect.any(Number),
        columns: [
          { id: 'name', label: 'Index' },
          { id: 'unique', label: 'Unique' },
          { id: 'columns', label: 'Columns' },
          { id: 'origin', label: 'Created by' },
          { id: 'coverage', label: 'Coverage' },
        ],
        rows: [
          {
            id: 'composite_index',
            cells: [
              'composite_index',
              false,
              'category, quantity DESC',
              'Created index',
              'Full table',
            ],
          },
          {
            id: 'expression_index',
            cells: [
              'expression_index',
              false,
              'Expression (not shown)',
              'Created index',
              'Full table',
            ],
          },
          {
            id: 'named_unique',
            cells: ['named_unique', true, 'name', 'Created index', 'Full table'],
          },
          {
            id: 'partial_index',
            cells: [
              'partial_index',
              false,
              'category',
              'Created index',
              'Partial (condition not shown)',
            ],
          },
          {
            id: 'protected_columns',
            cells: ['protected_columns', false, '[protected]', 'Created index', 'Full table'],
          },
        ],
        truncated: true,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /api_key|private-condition|lower\(name\)|CREATE INDEX/,
    );
    expect(queries).toHaveLength(4);
    expect(queries.at(-1)?.params).toEqual(['items']);
    expect(queries.every(({ sql }) => /^(SELECT|PRAGMA)/.test(sql))).toBe(true);
  });
  it('keeps automatic constraints, reports empty results, and handles quoted table names', async () => {
    expect(await payload(indexes())).toMatchObject({ data: { rows: [], truncated: false } });
    sqlite.exec('CREATE TABLE "quoted""table" (name TEXT UNIQUE);');
    expect(await payload(indexes('quoted"table'))).toMatchObject({
      data: {
        table: 'quoted"table',
        rows: [
          {
            id: 'sqlite_autoindex_quoted"table_1',
            cells: [
              'sqlite_autoindex_quoted"table_1',
              true,
              'name',
              'Unique constraint',
              'Full table',
            ],
          },
        ],
        truncated: false,
      },
    });
    expect(queries.at(-1)?.params).toEqual(['quoted"table']);
  });
  it('caps index results at100 with a truthful truncated marker', async () => {
    for (let i = 0; i < 102; i++) {
      sqlite.exec(`CREATE INDEX idx_${i} ON items(name)`);
    }
    const result = await payload(indexes());
    if (!isRecord(result) || !isRecord(result.data)) {
      throw Error('Missing index result');
    }
    expect(result.data.rows).toHaveLength(100);
    expect(result.data.truncated).toBe(true);
  });
  it('bounds long and repeated index keys without claiming complete metadata', async () => {
    const column = 'x'.repeat(190);
    sqlite.exec(
      `CREATE TABLE wide ("${column}" TEXT); CREATE INDEX wide_index ON wide (${Array.from({ length: 101 }, () => `"${column}"`).join(',')})`,
    );
    const result = await payload(indexes('wide'));
    if (!isRecord(result) || !isRecord(result.data) || !Array.isArray(result.data.rows)) {
      throw Error('Missing index result');
    }
    const row: unknown = result.data.rows[0];
    if (!isRecord(row) || !Array.isArray(row.cells) || typeof row.cells[2] !== 'string') {
      throw Error('Missing index cells');
    }
    expect(row.cells[2]).toHaveLength(4096);
    expect(result.data.truncated).toBe(true);
  });
  it.each(['sqlite_schema', '_void_migrations', 'missing', 'items"; DROP TABLE items;--'])(
    'does not inspect forbidden or unowned table %s',
    async (table) => {
      expect(await payload(indexes(table))).toMatchObject({ data: { kind: 'unavailable' } });
      expect(queries.some(({ sql }) => sql.includes('pragma_index_list'))).toBe(false);
    },
  );
  it('refuses shadow tables and invalid index metadata instead of claiming an empty result', async () => {
    sqlite.exec('CREATE VIRTUAL TABLE search USING fts5(content)');
    expect(await payload(indexes('search_data'))).toMatchObject({ data: { kind: 'unavailable' } });
    proxy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        results: body.sql.includes('pragma_index_list')
          ? [{ name: 'broken' }]
          : sqlite.prepare(body.sql).all(...body.params),
      });
    });
    expect(await payload(indexes())).toMatchObject({ data: { kind: 'unavailable' } });
  });
  it('keeps indexes behind owner and changing-resource fences', async () => {
    expect(
      (
        await call('resources.execute', {
          project: project.id,
          resourceId: 'res_database',
          action: 'database.indexes',
          input: { table: 'items' },
          owner: { person: 'someone-else' },
        })
      ).status,
    ).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
    proxy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.sql.includes('pragma_index_list')) {
        await env.db
          .update(resources)
          .set({ cf_id: 'changed-db' })
          .where(eq(resources.id, 'res_database'));
      }
      return Response.json({ results: sqlite.prepare(body.sql).all(...body.params) });
    });
    expect((await indexes()).status).toBe(409);
  });
  it.each([{}, { table: '' }, { table: 'items', sql: 'DROP TABLE items' }])(
    'rejects invalid index input %j',
    async (input) => {
      expect(
        (
          await call('resources.execute', {
            project: project.id,
            resourceId: 'res_database',
            action: 'database.indexes',
            input,
          })
        ).status,
      ).toBe(400);
      expect(proxy).not.toHaveBeenCalled();
    },
  );
  it('returns declared structure and generated columns without defaults or credential values', async () => {
    const result = await payload(schema());
    expect(result).toMatchObject({
      data: {
        appId: project.id,
        resourceId: 'res_database',
        action: 'database.schema',
        kind: 'table-schema',
        table: 'items',
        columns: [
          { name: 'id', type: 'INTEGER', notNull: false, primaryKey: 1, redacted: false },
          { name: 'name', type: 'TEXT', notNull: true, primaryKey: 0, redacted: false },
          { name: 'category', type: 'TEXT', notNull: false, primaryKey: 0, redacted: false },
          { name: 'quantity', type: 'INTEGER', notNull: false, primaryKey: 0, redacted: false },
          { name: 'api_key', type: 'TEXT', notNull: false, primaryKey: 0, redacted: true },
          { name: 'caption', type: 'TEXT', notNull: false, primaryKey: 0, redacted: false },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-default|dflt_value|private-1/);
    sqlite.exec('CREATE TABLE composite (a TEXT, b INTEGER, PRIMARY KEY(b,a)) WITHOUT ROWID');
    expect(await payload(schema('composite'))).toMatchObject({
      data: {
        columns: [
          { name: 'a', notNull: true, primaryKey: 2 },
          { name: 'b', notNull: true, primaryKey: 1 },
        ],
      },
    });
    sqlite.exec(
      "CREATE TABLE generated (name TEXT, secret_token TEXT GENERATED ALWAYS AS ('private-generated')); INSERT INTO generated(name) VALUES ('visible')",
    );
    const generated = await payload(schema('generated'));
    expect(generated).toMatchObject({
      data: {
        columns: [
          { name: 'name', redacted: false },
          { name: 'secret_token', redacted: true },
        ],
      },
    });
    expect(JSON.stringify(generated)).not.toContain('private-generated');
    expect(await payload(inspect({ table: 'generated' }))).toMatchObject({
      data: { rows: [['visible', '[redacted]']] },
    });
    expect(
      (
        await inspect({
          table: 'generated',
          filter: { column: 'secret_token', operator: 'contains', value: 'private' },
        })
      ).status,
    ).toBe(400);
  });
  it('filters all rows using bound literal values and echoes the applied query', async () => {
    for (const value of ['Café, 100%_quoted', '%_', "'; DROP TABLE items; --"]) {
      const filter = { column: 'name', operator: 'contains', value };
      const result = await payload(inspect({ filter }));
      expect(result).toMatchObject({
        data: {
          kind: 'rows',
          query: { filter },
          nextOffset: null,
          rows: value.startsWith("'")
            ? []
            : [[75, 'Café, 100%_quoted', 'odd', 75, '[redacted]', 'Café, 100%_quoted!']],
        },
      });
      const selected = queries.at(-1)!;
      expect(selected.sql).not.toContain(value);
      expect(selected.params).toEqual([value, 51, 0]);
    }
    expect(
      await payload(inspect({ filter: { column: 'quantity', operator: 'equals', value: '75' } })),
    ).toMatchObject({
      data: { rows: [[75, 'Café, 100%_quoted', 'odd', 75, '[redacted]', 'Café, 100%_quoted!']] },
    });
    const nulls = await payload(inspect({ filter: { column: 'category', operator: 'is-null' } }));
    expect(nulls).toMatchObject({
      data: { nextOffset: 50, query: { filter: { column: 'category', operator: 'is-null' } } },
    });
    expect(await payload(inspect())).toMatchObject({ data: { query: {} } });
  });
  it('keeps repeated sort values and nullable primary keys stable across pages', async () => {
    sqlite.exec('CREATE TABLE nullable (id TEXT PRIMARY KEY, value TEXT)');
    const insert = sqlite.prepare('INSERT INTO nullable VALUES(NULL, ?)');
    for (let i = 0; i < 80; i++) {
      insert.run(`value ${i}`);
    }
    const sort = { column: 'id', direction: 'asc' };
    const first = await payload(inspect({ table: 'nullable', sort }));
    const second = await payload(inspect({ table: 'nullable', sort, offset: 50 }));
    expect(first).toMatchObject({
      data: {
        nextOffset: 50,
        query: { sort },
        rows: Array.from({ length: 50 }, (_, i) => [null, `value ${i}`]),
      },
    });
    expect(second).toMatchObject({
      data: {
        nextOffset: null,
        rows: Array.from({ length: 30 }, (_, i) => [null, `value ${i + 50}`]),
      },
    });
    expect(
      await payload(inspect({ sort: { column: 'quantity', direction: 'desc' } })),
    ).toMatchObject({
      data: {
        rows: expect.arrayContaining([[125, 'Item 125', 'odd', 125, '[redacted]', 'Item 125!']]),
      },
    });
  });
  it('reports the browse cap separately from the end and does not overlap off-boundary pages', async () => {
    sqlite.exec('CREATE TABLE many (id INTEGER PRIMARY KEY, name TEXT); BEGIN');
    const insert = sqlite.prepare("INSERT INTO many VALUES (?, 'same')");
    for (let id = 0; id < 10_051; id++) {
      insert.run(id);
    }
    sqlite.exec('COMMIT');
    const sort = { column: 'name', direction: 'asc' };
    expect(await payload(inspect({ table: 'many', sort, offset: 9999 }))).toMatchObject({
      data: { rows: [[9999, 'same']], nextOffset: 10_000, limitReached: false },
    });
    expect(await payload(inspect({ table: 'many', sort, offset: 10_000 }))).toMatchObject({
      data: {
        rows: Array.from({ length: 50 }, (_, i) => [10_000 + i, 'same']),
        nextOffset: null,
        limitReached: true,
      },
    });
    sqlite.exec('DELETE FROM many WHERE id = 10050');
    expect(await payload(inspect({ table: 'many', sort, offset: 10_000 }))).toMatchObject({
      data: { nextOffset: null, limitReached: false },
    });
  });
  it('rejects credential inference and invalid query shapes before reading data', async () => {
    for (const input of [
      { filter: { column: 'api_key', operator: 'equals', value: 'guess' } },
      { filter: { column: 'api_key', operator: 'is-null' } },
      { sort: { column: 'api_key', direction: 'asc' } },
      { sort: { column: 'name"; DROP TABLE items; --', direction: 'asc' } },
      { filter: { column: 'name', operator: 'equals' } },
      { filter: { column: 'name', operator: 'is-null', value: '' } },
      { filter: { column: 'name', operator: 'contains', value: 'a'.repeat(1001) } },
      { filter: { column: 'name', operator: 'equals', value: 'x', sql: 'SELECT 1' } },
      { sort: { column: 'name', direction: 'DESC; DROP TABLE items' } },
    ]) {
      expect((await inspect(input)).status).toBe(400);
    }
    expect(
      queries.every(
        (query) =>
          query.sql.startsWith('SELECT name FROM sqlite_schema') ||
          query.sql.startsWith('PRAGMA table_xinfo'),
      ),
    ).toBe(true);
    expect(
      (await inspect({ resourceId: 'res_files', sort: { column: 'name', direction: 'asc' } }))
        .status,
    ).toBe(400);
  });
  it('does not use a secret primary key or a shadowed rowid to order customer pages', async () => {
    sqlite.exec(
      'CREATE TABLE secret (token TEXT PRIMARY KEY, name TEXT) WITHOUT ROWID; CREATE TABLE shadowed (rowid TEXT, _rowid_ TEXT, oid TEXT, name TEXT)',
    );
    for (const table of ['secret', 'shadowed']) {
      expect(
        await payload(inspect({ table, sort: { column: 'name', direction: 'asc' } })),
      ).toMatchObject({
        data: {
          kind: 'unavailable',
          reason: 'This table has no safe unique row order for filtered or sorted pages.',
        },
      });
    }
  });
  it('keeps schema and filtered reads behind owner, deployment and binding fences', async () => {
    expect(
      (
        await call('resources.execute', {
          project: project.id,
          resourceId: 'res_database',
          action: 'database.schema',
          input: { table: 'items' },
          owner: { person: 'someone-else' },
        })
      ).status,
    ).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
    proxy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      await env.db
        .update(resources)
        .set({ cf_id: 'changed-db' })
        .where(eq(resources.id, 'res_database'));
      return Response.json({ results: sqlite.prepare(body.sql).all(...body.params) });
    });
    expect((await schema()).status).toBe(409);
    await env.db
      .update(resources)
      .set({ cf_id: 'private-db-id' })
      .where(eq(resources.id, 'res_database'));
    expect(
      (await inspect({ filter: { column: 'name', operator: 'equals', value: 'Item 1' } })).status,
    ).toBe(409);
  });
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
