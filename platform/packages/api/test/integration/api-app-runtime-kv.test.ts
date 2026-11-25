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
import { projects, resources, users } from '../../src/schema.ts';
import app from '../../src/worker/index.ts';
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

let env: TestEnv;
let registration: Awaited<ReturnType<typeof registerOAuthClient>>;
let project: { id: string; slug: string };
let foreign: { id: string; slug: string };
let ownerId: string;
let content: string | null;
let metadata: unknown;
let expiration: number | undefined;
const namespace = 'a'.repeat(32);
const provider = vi.fn<typeof fetch>();
const ok = (result: unknown, extra = {}) =>
  Response.json({ success: true, errors: [], result, ...extra });
function respond(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.method === 'PUT') {
    return Promise.resolve(ok({}));
  }
  const url = new URL(String(input));
  if (url.pathname.endsWith('/keys')) {
    return Promise.resolve(
      ok(content === null ? [] : [{ name: url.searchParams.get('prefix'), metadata, expiration }], {
        result_info: { cursor: '' },
      }),
    );
  }
  return Promise.resolve(
    content === null ? new Response(null, { status: 404 }) : new Response(content),
  );
}
const basic = () => `Basic ${btoa(`${registration.client.id}:${registration.clientSecret}`)}`;
const call = (
  action = 'keys.inspect',
  input: unknown = { key: 'settings' },
  extra = {},
  auth = basic(),
  path = 'resources.execute',
) =>
  app.fetch(
    new Request(`https://platform.test/app-billing/${path}`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        project: project.id,
        resourceId: 'res_keys',
        owner: { person: 'person' },
        action,
        input,
        ...extra,
      }),
    }),
    env,
    createMockExecutionContext(),
  );
const data = async (response: Promise<Response> | Response) => {
  const result = await response;
  expect(result.status).toBe(200);
  const parsed: unknown = await result.json();
  if (!isRecord(parsed) || !isRecord(parsed.data)) {
    throw Error('Invalid test response');
  }
  return parsed.data;
};
const save = (expectedFingerprint: unknown, overrides = {}) => ({
  key: 'settings',
  text: '{ "title": "Updated" }\n',
  mode: expectedFingerprint === 'missing' ? 'create' : 'replace',
  expectedFingerprint,
  expiration: 'preserve',
  review: 'last-write-wins',
  ...overrides,
});
const writes = () => provider.mock.calls.filter(([, init]) => init?.method === 'PUT');
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  registration = await registerOAuthClient(env.db, {
    name: 'KV editor',
    operator: 'Test',
    redirectUris: ['https://app.test/callback'],
    scopes: ['profile'],
  });
  const owner = await createTestUser(
    env.db,
    'keys-owner',
    'app:' + registration.client.id,
    'person',
  );
  ownerId = owner.id;
  const other = await createTestUser(env.db, 'foreign');
  project = await createTestProject(env.db, owner.id);
  foreign = await createTestProject(env.db, other.id);
  const deployment = await createTestDeployment(env.db, project.id);
  await env.db
    .update(projects)
    .set({ active_deployment_id: deployment.id, status: 'active' })
    .where(eq(projects.id, project.id));
  await env.db.insert(resources).values([
    { id: 'res_keys', project_id: project.id, type: 'kv', cf_id: namespace, binding_name: 'CACHE' },
    {
      id: 'res_other',
      project_id: foreign.id,
      type: 'kv',
      cf_id: 'b'.repeat(32),
      binding_name: 'CACHE',
    },
  ]);
  content = '{ "title": "Original", "count": 1 }\n';
  metadata = { origin: 'app', api_key: 'private-metadata-value' };
  expiration = Math.ceil(Date.now() / 1000) + 3600;
  provider.mockReset().mockImplementation(respond);
  vi.stubGlobal('fetch', provider);
  env.CF_API_TOKEN = 'test-token';
  delete env.DEV_AUTH_BYPASS;
});
afterEach(() => vi.unstubAllGlobals());
describe('key editing through the owner-scoped direct adapter', () => {
  it('advertises direct edit actions without advertising unavailable proxy reads', async () => {
    const result = JSON.stringify(await data(call('', {}, {}, basic(), 'projects.resources')));
    expect(result).toContain('keys.inspect');
    expect(result).toContain('keys.save');
    expect(result).not.toContain('keys.list');
    expect(result).not.toContain('keys.read');
    expect(provider).not.toHaveBeenCalled();
  });
  it('returns exact editable text and opaque version without metadata or provider IDs', async () => {
    const result = await data(call());
    expect(result).toMatchObject({
      kind: 'key-editor',
      key: 'settings',
      exists: true,
      text: content,
      editable: true,
      expiration,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(result)).not.toContain('private-metadata-value');
    expect(JSON.stringify(result)).not.toContain(namespace);
    expect(await data(call())).toMatchObject({ fingerprint: result.fingerprint });
  });
  it('preserves private metadata and absolute expiry while accepting exact edited bytes', async () => {
    const opened = await data(call());
    provider.mockClear();
    const result = await data(call('keys.save', save(opened.fingerprint)));
    expect(result).toMatchObject({
      kind: 'key-saved',
      key: 'settings',
      expiration,
      consistency: 'eventual',
      acceptedAt: expect.any(Number),
    });
    expect(result).not.toHaveProperty('fingerprint');
    expect(provider).toHaveBeenCalledTimes(3);
    const [url, init] = writes()[0];
    expect(new URL(String(url)).searchParams.get('expiration')).toBe(String(expiration));
    expect(init?.redirect).toBe('manual');
    const body = init?.body;
    expect(body).toBeInstanceOf(FormData);
    if (!(body instanceof FormData)) {
      throw Error('Expected multipart');
    }
    expect(JSON.parse(String(body.get('metadata')))).toEqual(metadata);
    const value = body.get('value');
    if (!(value instanceof Blob)) {
      throw Error('Expected bytes');
    }
    expect(await value.text()).toBe(save(opened.fingerprint).text);
  });
  it.each(['none', 'preserve'])(
    'creates a missing key with explicit review and %s expiry',
    async (expiry) => {
      content = null;
      const opened = await data(call());
      expect(opened).toMatchObject({
        exists: false,
        editable: true,
        fingerprint: 'missing',
        text: '',
        expiration: null,
      });
      expect(await data(call('keys.save', save('missing', { expiration: expiry })))).toMatchObject({
        kind: 'key-saved',
        expiration: null,
      });
      expect(new URL(String(writes()[0][0])).search).toBe('');
    },
  );
  it('sets a later expiry and explicitly removes an existing expiry', async () => {
    const opened = await data(call());
    const later = expiration! + 3600;
    expect(
      await data(call('keys.save', save(opened.fingerprint, { expiration: String(later) }))),
    ).toMatchObject({ kind: 'key-saved', expiration: later });
    expect(
      await data(call('keys.save', save(opened.fingerprint, { expiration: 'none' }))),
    ).toMatchObject({ kind: 'key-saved', expiration: null });
    expect(new URL(String(writes()[1][0])).search).toBe('');
  });
  it.each(['text', 'metadata', 'expiration', 'removed'])(
    'conflicts when %s changes after opening',
    async (change) => {
      const opened = await data(call());
      if (change === 'text') {
        content = 'Other';
      }
      if (change === 'metadata') {
        metadata = { other: true };
      }
      if (change === 'expiration') {
        expiration = expiration! + 60;
      }
      if (change === 'removed') {
        content = null;
      }
      expect(await data(call('keys.save', save(opened.fingerprint)))).toMatchObject({
        kind: 'conflict',
      });
      expect(writes()).toHaveLength(0);
    },
  );
  it('conflicts when a requested new key already exists', async () => {
    expect(await data(call('keys.save', save('missing')))).toMatchObject({ kind: 'conflict' });
    expect(writes()).toHaveLength(0);
  });
  it.each(['', '\ufeff'])(
    'withholds protected JSON and its fingerprint even with a byte order mark %s',
    async (prefix) => {
      content = prefix + '{"nested":{"api_key":"secret-value"},"title":"Visible"}';
      const opened = await data(call());
      expect(opened).toMatchObject({ editable: false, fingerprint: null });
      expect(opened.text).toContain('[redacted]');
      expect(opened.text).not.toContain('secret-value');
      expect(await data(call('keys.save', save('a'.repeat(64))))).toMatchObject({
        kind: 'unavailable',
      });
      expect(writes()).toHaveLength(0);
    },
  );
  it('blocks adding protected fields through editable JSON', async () => {
    const opened = await data(call());
    expect(
      await data(call('keys.save', save(opened.fingerprint, { text: '{"password":"new"}' }))),
    ).toMatchObject({ kind: 'unavailable' });
    expect(writes()).toHaveLength(0);
  });
  it.each([403, 500, 307])(
    'does not mistake provider %s for missing data or write after it',
    async (status) => {
      provider.mockResolvedValueOnce(new Response(null, { status }));
      expect(await data(call('keys.save', save('missing')))).toMatchObject({ kind: 'unavailable' });
      expect(writes()).toHaveLength(0);
    },
  );
  it('refuses an ambiguous empty list with a continuation cursor', async () => {
    content = null;
    provider.mockResolvedValueOnce(ok([], { result_info: { cursor: 'more' } }));
    expect(await data(call())).toMatchObject({ kind: 'unavailable' });
  });
  it('refuses disagreement between list and raw value', async () => {
    provider.mockResolvedValueOnce(ok([], { result_info: { cursor: '' } }));
    expect(await data(call())).toMatchObject({ kind: 'unavailable' });
  });
  it.each(['binary', 'invalid-utf8', 'oversize', 'metadata'])(
    'refuses unsafe %s values',
    async (kind) => {
      if (kind === 'metadata') {
        metadata = { text: 'x'.repeat(1025) };
      } else {
        provider.mockImplementation((url, init) =>
          String(url).includes('/values/')
            ? Promise.resolve(
                new Response(
                  kind === 'invalid-utf8'
                    ? new Uint8Array([255])
                    : kind === 'binary'
                      ? new Uint8Array([0, 1])
                      : 'x'.repeat(65_537),
                ),
              )
            : respond(url, init),
        );
      }
      expect(await data(call())).toMatchObject({ kind: 'unavailable' });
    },
  );
  it.each(['preserve', 'none', String(Math.ceil(Date.now() / 1000) + 7200)])(
    'rejects near-expired keys even when requesting %s',
    async (expiry) => {
      expiration = Math.ceil(Date.now() / 1000) + 30;
      const opened = await data(call());
      expect(
        await data(call('keys.save', save(opened.fingerprint, { expiration: expiry }))),
      ).toMatchObject({
        kind: 'unavailable',
      });
      expect(writes()).toHaveLength(0);
    },
  );
  it.each([
    { review: undefined },
    { review: 'yes' },
    { mode: 'replace' },
    { expectedFingerprint: 'x' },
    { expiration: '-1' },
    { expiration: '1.5' },
    { key: 'api-token' },
    { key: 'é'.repeat(257) },
    { key: '..' },
    { text: 'é'.repeat(32_769) },
    { text: '\ud800' },
    { arbitrary: true },
  ])('rejects invalid input before provider access %#', async (change) => {
    expect((await call('keys.save', save('missing', change))).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });
  it('keeps the 64 KiB editor boundary for raw and redacted output', async () => {
    content = 'x'.repeat(65_536);
    expect(await data(call())).toMatchObject({ editable: true, text: content });
    content = JSON.stringify(
      Object.fromEntries(Array.from({ length: 3000 }, (_, i) => ['token' + i, 0])),
    );
    expect(new TextEncoder().encode(content).length).toBeLessThan(65_536);
    expect(await data(call())).toMatchObject({ kind: 'unavailable' });
  });
  it('does not change raw JSON formatting or byte order marks', async () => {
    content = '\ufeff{  "title": "你好" }\n';
    expect(await data(call())).toMatchObject({ text: content, editable: true });
  });
  it('hides write descriptors without configured credentials or an active deployment', async () => {
    env.CF_API_TOKEN = '';
    expect(
      JSON.stringify(await data(call('', {}, {}, basic(), 'projects.resources'))),
    ).not.toContain('keys.save');
    expect(await data(call())).toMatchObject({ kind: 'unavailable' });
    env.CF_API_TOKEN = 'test-token';
    await env.db
      .update(projects)
      .set({ active_deployment_id: null })
      .where(eq(projects.id, project.id));
    expect(
      JSON.stringify(await data(call('', {}, {}, basic(), 'projects.resources'))),
    ).not.toContain('keys.save');
    expect(provider).not.toHaveBeenCalled();
  });
  it('encodes special key names without changing the value request path', async () => {
    const key = "folder/你好 '#?.json";
    expect(await data(call('keys.inspect', { key }))).toMatchObject({ key, editable: true });
    const url = new URL(String(provider.mock.calls[1][0]));
    expect(url.pathname.endsWith('/values/' + encodeURIComponent(key))).toBe(true);
  });
  it('keeps owner, connected-app and resource access checks before provider access', async () => {
    expect((await call('keys.inspect', { key: 'settings' }, {}, 'Basic bad')).status).toBe(401);
    expect(
      (await call('keys.inspect', { key: 'settings' }, { owner: { person: 'other' } })).status,
    ).toBe(404);
    expect((await call('keys.inspect', { key: 'settings' }, { project: foreign.id })).status).toBe(
      404,
    );
    expect(
      (await call('keys.inspect', { key: 'settings' }, { resourceId: 'res_other' })).status,
    ).toBe(404);
    expect(provider).not.toHaveBeenCalled();
  });
  it('blocks suspended owners and hides editing descriptors', async () => {
    await env.db.update(users).set({ suspended_reason: 'admin' }).where(eq(users.id, ownerId));
    expect(await data(call())).toMatchObject({ kind: 'unavailable' });
    expect(
      JSON.stringify(await data(call('', {}, {}, basic(), 'projects.resources'))),
    ).not.toContain('keys.save');
    expect(provider).not.toHaveBeenCalled();
  });
  it('blocks a suspended project before reading or writing provider data', async () => {
    await env.db
      .update(projects)
      .set({ suspended_reason: 'admin' })
      .where(eq(projects.id, project.id));
    expect(await data(call())).toMatchObject({ kind: 'unavailable' });
    expect(await data(call('keys.save', save('missing')))).toMatchObject({ kind: 'unavailable' });
    expect(
      JSON.stringify(await data(call('', {}, {}, basic(), 'projects.resources'))),
    ).not.toContain('keys.save');
    expect(provider).not.toHaveBeenCalled();
  });
  it('supports only active owned previews', async () => {
    await env.db
      .update(projects)
      .set({
        preview_client_id: registration.client.id,
        preview_workspace_id: 'workspace',
        preview_expires_at: new Date(Date.now() + 60_000).toISOString(),
        slug: 'preview-keys',
      })
      .where(eq(projects.id, project.id));
    expect(await data(call())).toMatchObject({ kind: 'key-editor' });
    await env.db
      .update(projects)
      .set({ preview_expires_at: new Date(Date.now() - 1).toISOString() })
      .where(eq(projects.id, project.id));
    expect((await call()).status).toBe(404);
  });
  it('refuses a changed deployment before writing', async () => {
    const opened = await data(call());
    provider.mockImplementation(async (url, init) => {
      const result = await respond(url, init);
      if (String(url).includes('/values/')) {
        await env.db
          .update(projects)
          .set({ active_deployment_id: null })
          .where(eq(projects.id, project.id));
      }
      return result;
    });
    expect(await data(call('keys.save', save(opened.fingerprint)))).toMatchObject({
      kind: 'unavailable',
    });
    expect(writes()).toHaveLength(0);
  });
  it.each(['throw', 'malformed', 'redirect', 'error', 'ownership'])(
    'returns unknown without retry after %s during write',
    async (failure) => {
      const opened = await data(call());
      provider.mockImplementation(async (url, init) => {
        if (init?.method !== 'PUT') {
          return respond(url, init);
        }
        if (failure === 'throw') {
          throw Error('Disconnected');
        }
        if (failure === 'malformed') {
          return Response.json({ success: true });
        }
        if (failure === 'redirect') {
          return new Response(null, { status: 307 });
        }
        if (failure === 'error') {
          return new Response(null, { status: 500 });
        }
        await env.db
          .update(projects)
          .set({ active_deployment_id: null })
          .where(eq(projects.id, project.id));
        return ok({});
      });
      expect(await data(call('keys.save', save(opened.fingerprint)))).toMatchObject({
        kind: 'unknown',
      });
      expect(writes()).toHaveLength(1);
    },
  );
});
