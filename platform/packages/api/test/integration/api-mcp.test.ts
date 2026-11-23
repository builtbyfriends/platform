import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vite-plus/test';
import app from '../../src/index.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
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

type JsonRpcResult = {
  result?: {
    tools?: Array<{ name: string }>;
    isError?: boolean;
    content?: Array<{ text: string }>;
  };
  error?: { message: string };
};

async function mcp(token: string | undefined, method: string, params: object = {}) {
  const res = await app.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Host: 'localhost',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    env,
  );
  const text = await res.text();
  const data =
    text.startsWith('event:') || text.includes('\ndata:') ? /data: (.*)/.exec(text)?.[1] : text;
  return { status: res.status, body: (data ? JSON.parse(data) : {}) as JsonRpcResult };
}

describe('/mcp', () => {
  it('refuses a request with no credential', async () => {
    const { status } = await mcp(undefined, 'tools/list');
    expect(status).toBe(401);
  });

  it('lists the procedures that chose MCP as tools for a signed-in user', async () => {
    const user = await createTestUser(env.db);
    const { status, body } = await mcp(user.jwt, 'tools/list');
    expect(status).toBe(200);
    const names = body.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain('deployments_list');
    expect(names).not.toContain('deploy_finalize');
  });

  it('runs a tool through the same authorization as /rpc', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const stranger = await createTestUser(env.db, 'stranger');
    const project = await createTestProject(env.db, owner.id, 'mcp-app');

    const own = await mcp(owner.jwt, 'tools/call', {
      name: 'deployments_list',
      arguments: { projectId: project.id },
    });
    expect(own.body.result?.isError).toBeFalsy();
    expect(JSON.parse(own.body.result!.content![0].text)).toMatchObject({ deployments: [] });

    const other = await mcp(stranger.jwt, 'tools/call', {
      name: 'deployments_list',
      arguments: { projectId: project.id },
    });
    expect(other.body.result?.isError).toBe(true);
    expect(JSON.parse(other.body.result!.content![0].text).error.code).toBe('FORBIDDEN');
  });
});
