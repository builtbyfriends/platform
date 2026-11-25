import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
} from '../../../../test/integration-helpers.ts';
import type { IsolatedPlayground, StartedServer } from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '../../../..');
const PLAYGROUND = 'playground/server-auth-errors';
const EMAIL = 'demo@example.com';
const redirects = ['return-redirect', 'throw-redirect', 'auth-redirect'] as const;

let playground: IsolatedPlayground;
let server: StartedServer;
let cookie = '';

beforeAll(async () => {
  playground = createIsolatedPlayground(ROOT, PLAYGROUND);
  server = await startServer(
    (port) =>
      spawn('vp', ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: playground.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, BWF_INSPECTOR_PORT: 'false' },
      }),
    60_000,
    { expectStatus: 200, expectBody: 'Server Auth Errors Example' },
  );
});

afterAll(async () => {
  if (server) {
    await killChild(server.child);
  }
  playground?.cleanup();
});

function get(path: string, signedIn: boolean) {
  return fetch(`${server.base}${path}`, {
    redirect: 'manual',
    headers: { accept: 'text/html', ...(signedIn ? { cookie } : {}) },
  });
}

describe('signed out', () => {
  it('answers the API profile with a plain-text 401', async () => {
    const response = await get('/api/profile', false);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
  });

  it('answers requireAuth in middleware with a 401', async () => {
    expect((await get('/middleware/require-auth', false)).status).toBe(401);
  });

  it.each(redirects)('redirects the %s middleware guard to /login', async (guard) => {
    const response = await get(`/middleware/${guard}`, false);
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location')!, server.base).pathname).toBe('/login');
  });
});

describe('signed in', () => {
  beforeAll(async () => {
    const login = await fetch(`${server.base}/api/demo-login`, { method: 'POST' });
    expect(login.status, await login.text()).toBe(200);
    cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  });

  it('returns the API profile', async () => {
    const response = await get('/api/profile', true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'Demo user', email: EMAIL });
  });

  it.each(['require-auth', ...redirects])('lets the %s guard through to the app', async (guard) => {
    const response = await get(`/middleware/${guard}`, true);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Server Auth Errors Example');
  });
});
