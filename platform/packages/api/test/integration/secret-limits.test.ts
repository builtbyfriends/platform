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
import app from '../../src/index.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  rpcRequest,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('secret limits', () => {
  it('rejects secret value that is too large', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'big-secret-app');
    mockCfApi();

    const res = await app.fetch(
      rpcRequest('secrets.set', user.jwt, {
        projectId: project.id,
        name: 'BIG_SECRET',
        value: 'x'.repeat(128 * 1024 + 1),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'VALUE_TOO_LARGE', message: 'secret value too large' },
    });
  });

  it('rejects secret name that is too long', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'long-name-app');
    mockCfApi();

    const longName = 'A' + 'B'.repeat(256);
    const res = await app.fetch(
      rpcRequest('secrets.set', user.jwt, { projectId: project.id, name: longName, value: 'x' }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'NAME_TOO_LONG', message: 'secret name too long' },
    });
  });
});
