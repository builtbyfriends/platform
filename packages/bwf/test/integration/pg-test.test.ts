import { once } from 'node:events';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import spawn from 'cross-spawn';
import { createServer } from 'pglite-server';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { killChild, startServer } from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const ENV_PATH = join(ROOT, 'playground/pg-test/.env');
type User = { id: number; name: string; email: string };
type Post = { id: number; title: string; author: string };

async function list<T>(base: string, path: string): Promise<Array<T>> {
  const response = await fetch(base + path);
  expect(response.status).toBe(200);
  return (await response.json()) as Array<T>;
}

describe('playground/pg-test', () => {
  let pglite: PGlite;
  let pgServer: ReturnType<typeof createServer>;
  let pgPort: number;
  let devChild: ReturnType<typeof spawn>;
  let BASE: string;

  beforeAll(async () => {
    pglite = new PGlite();
    await pglite.waitReady;

    const migrationSql = readFileSync(
      join(ROOT, 'playground/pg-test/db/migrations/0000_initial.sql'),
      'utf8',
    );
    await pglite.exec(migrationSql);

    pgServer = createServer(pglite);
    pgServer.listen(0);
    await once(pgServer, 'listening');
    pgPort = (pgServer.address() as import('node:net').AddressInfo).port;

    const databaseUrl = `postgresql://postgres@127.0.0.1:${pgPort}/postgres`;
    writeFileSync(ENV_PATH, `DATABASE_URL=${databaseUrl}\n`);

    const server = await startServer((port) => {
      devChild = spawn(
        'vp',
        [
          'run',
          '--filter',
          './playground/pg-test',
          'dev',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--strictPort',
        ],
        {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            BWF_INSPECTOR_PORT: 'false',
          },
        },
      );
      return devChild;
    }, 30_000);
    BASE = server.base;
  });

  afterAll(async () => {
    if (devChild) {
      await killChild(devChild);
    }
    if (pgServer) {
      pgServer.close();
      await once(pgServer, 'close');
    }
    if (pglite) {
      await pglite.close();
    }
    try {
      unlinkSync(ENV_PATH);
    } catch {}
  });

  it('serves the SPA shell', async () => {
    const res = await fetch(BASE + '/', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Database (PostgreSQL)');
  });

  it('creates a user and a post through the API', async () => {
    const createUser = await fetch(BASE + '/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'alice@test.com' }),
    });
    expect(createUser.status).toBe(201);
    const alice = (await createUser.json()) as User;

    const createPost = await fetch(BASE + '/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hello World', body: 'Test post', authorId: alice.id }),
    });
    expect(createPost.status).toBe(201);
    expect(await list<Post>(BASE, '/api/posts')).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Hello World', author: 'Alice' })]),
    );
  });

  it('deletes a post through the API', async () => {
    const post = (await list<Post>(BASE, '/api/posts')).find((p) => p.title === 'Hello World');
    if (!post) {
      throw new Error('Expected Hello World post to exist before deleting it');
    }
    const deleteRes = await fetch(BASE + `/api/posts/${post.id}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(200);
    expect(
      (await list<Post>(BASE, '/api/posts')).find((p) => p.title === 'Hello World'),
    ).toBeUndefined();
  });

  it('deletes a user and their posts', async () => {
    const alice = (await list<User>(BASE, '/api/users')).find((u) => u.name === 'Alice');
    if (!alice) {
      throw new Error('Expected Alice to exist before deleting her');
    }
    await fetch(BASE + '/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'To Be Deleted', body: 'Gone soon', authorId: alice.id }),
    });
    const deleteRes = await fetch(BASE + `/api/users/${alice.id}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(200);
    expect((await list<User>(BASE, '/api/users')).find((u) => u.name === 'Alice')).toBeUndefined();
    expect(
      (await list<Post>(BASE, '/api/posts')).find((p) => p.author === 'Alice'),
    ).toBeUndefined();
  });

  it('API routes: create and list users', async () => {
    const createRes = await fetch(BASE + '/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob', email: 'bob@test.com' }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as User;
    expect(created.name).toBe('Bob');

    const listRes = await fetch(BASE + '/api/users');
    expect(listRes.status).toBe(200);
    const users = (await listRes.json()) as Array<User>;
    expect(users).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Bob', email: 'bob@test.com' })]),
    );

    const getRes = await fetch(BASE + `/api/users/${created.id}`);
    expect(getRes.status).toBe(200);
    const user = (await getRes.json()) as User;
    expect(user.name).toBe('Bob');
  });
});
