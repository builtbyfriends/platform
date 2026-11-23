import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { getProjectCredential } from '../../src/db.ts';
import app from '../../src/index.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  rpcData,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

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

function call(name: string, jwt: string, body: unknown) {
  return app.fetch(
    new Request(`http://localhost/rpc/${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe('proxy-held credentials', () => {
  it('stores a token encrypted, lists it without the token, and removes it', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cred-app');

    const set = await call('credentials.set', user.jwt, {
      projectId: project.id,
      provider: 'github',
      token: 'ghp_plain',
      repositories: ['acme/widgets'],
    });
    expect(set.status).toBe(200);
    const row = await getProjectCredential(env.db, project.id, 'github');
    expect(row?.ciphertext).not.toContain('ghp_plain');

    const list = await call('credentials.list', user.jwt, { projectId: project.id });
    const text = JSON.stringify(rpcData(await list.json()));
    expect(text).toContain('acme/widgets');
    expect(text).not.toContain('ghp_plain');
    expect(text).not.toContain(row!.ciphertext);

    await call('credentials.remove', user.jwt, { projectId: project.id, provider: 'github' });
    expect(await getProjectCredential(env.db, project.id, 'github')).toBeNull();
  });

  it('refuses a user who does not own the project', async () => {
    const owner = await createTestUser(env.db);
    const other = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'cred-private');
    const res = await call('credentials.set', other.jwt, {
      projectId: project.id,
      provider: 'github',
      token: 'x',
      repositories: ['a/b'],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await getProjectCredential(env.db, project.id, 'github')).toBeNull();
  });
});
