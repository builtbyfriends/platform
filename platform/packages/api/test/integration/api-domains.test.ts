import { eq } from 'drizzle-orm';
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
import {
  getPendingDomains,
  getPendingDomainsNewerThan,
  getPendingDomainsOlderThan,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import app, { scheduled, cleanupStalePendingDomains, FAST_CRON } from '../../src/index.ts';
import { tryActivateDomain } from '../../src/provisioning/activate-domain.ts';
import {
  domains,
  platformSettings,
  projectMembers,
  projectZeroTrust,
  users,
} from '../../src/schema.ts';
import type { Domain, Project } from '../../src/types.ts';
import { configurePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  cfSuccess,
  cfError,
  captureQueries,
  rpcRequest,
  rpcData,
  rpcError,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

const mockCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function makeBindings(e: TestEnv): ApiEnv['Bindings'] {
  return {
    HYPERDRIVE: e.HYPERDRIVE as unknown as Hyperdrive,
    ISR_CACHE: e.ISR_CACHE,
    ROUTING: e.ROUTING,
    STATIC_ASSETS: e.STATIC_ASSETS,
    STATIC_ASSETS_R2: e.STATIC_ASSETS_R2,
    DISPATCH: e.DISPATCH,
    CF_API_TOKEN: e.CF_API_TOKEN,
    CF_ACCOUNT_ID: e.CF_ACCOUNT_ID,
    CF_ZONE_ID: e.CF_ZONE_ID,
    JWT_SECRET: e.JWT_SECRET,
    PROJECT_SECRET_KEYS_JSON: e.PROJECT_SECRET_KEYS_JSON,
    PROJECT_SECRET_ACTIVE_KEY_VERSION: e.PROJECT_SECRET_ACTIVE_KEY_VERSION,
    R2_ACCESS_KEY_ID: e.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: e.R2_SECRET_ACCESS_KEY,
    R2_STATIC_ASSETS_BUCKET: e.R2_STATIC_ASSETS_BUCKET,
    GITHUB_CLIENT_ID: e.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: e.GITHUB_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: e.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: e.GOOGLE_CLIENT_SECRET,
    USAGE_COUNTER: e.USAGE_COUNTER,
    CRON_SCHEDULER: e.CRON_SCHEDULER,
    ERROR_ALERT_MONITOR: e.ERROR_ALERT_MONITOR,
    SANDBOX_CONCURRENCY_COUNTER: e.SANDBOX_CONCURRENCY_COUNTER,
    CRON_FIRES_QUEUE: { send: async () => {}, sendBatch: async () => {} } as unknown as Queue<
      import('../../src/cron-fires-queue.ts').CronFireMessage
    >,
  } as ApiEnv['Bindings'];
}

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

describe('POST /projects/:id/domains', () => {
  it('adds a custom domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'domain-app');
    const fetchMock = mockCfApi({
      createCustomHostname: () =>
        cfSuccess({
          id: 'ch-123',
          hostname: 'app.example.com',
          status: 'pending',
          ssl: {
            status: 'pending_validation',
            method: 'http',
            type: 'dv',
          },
          ownership_verification: {
            type: 'txt',
            name: '_cf-custom-hostname.app.example.com',
            value: 'ownership-v',
          },
        }),
    });

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, { projectId: project.id, hostname: 'app.example.com' }),
      env,
    );

    expect(res.status).toBe(200);
    const body = rpcData(await res.json()) as {
      id: string;
      hostname: string;
      status: string;
      cname_target: string;
      ownership_verification?: { name: string; value: string };
      ssl_validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
    };
    expect(body.id).toMatch(/^dom_/);
    expect(body.hostname).toBe('app.example.com');
    expect(body.status).toBe('pending');
    expect(body.cname_target).toBe('cname.buildwf.dev');
    expect(body.ownership_verification?.name).toBe('_cf-custom-hostname.app.example.com');
    expect(body.ssl_validation_records).toEqual([]);

    // Decision: The CF request has to have the HTTP-DCV shape without `custom_metadata`: that field needs a paid
    // Enterprise SSL for SaaS add-on the account doesn't have, and CF rejects each create that sends it.
    const cfCreateCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames') && init?.method === 'POST';
    });
    expect(cfCreateCall).toBeDefined();
    const cfBody = JSON.parse((cfCreateCall![1] as RequestInit).body as string) as {
      hostname: string;
      ssl: { method: string; type: string };
    };
    expect(cfBody.ssl.method).toBe('http');
    expect(cfBody).not.toHaveProperty('custom_metadata');
  });

  it('rolls back the CF hostname when an admin is downgraded before locked persistence', async () => {
    const owner = await createTestUser(env.db, 'domain-race-owner');
    const admin = await createTestUser(env.db, 'domain-race-admin');
    const project = await createTestProject(env.db, owner.id, 'domain-access-race');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: admin.id,
      role: 'admin',
      added_by_user_id: owner.id,
    });
    const fetchMock = mockCfApi({
      createCustomHostname: async () => {
        // Decision: The unlocked route check already granted settings. The downgrade wins before the final project
        // lock, so the CF first phase has to be compensated and no domain row may become durable.
        await env.db
          .update(projectMembers)
          .set({ role: 'reader' })
          .where(eq(projectMembers.user_id, admin.id));
        return cfSuccess({
          id: 'ch-access-race',
          hostname: 'access-race.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
        });
      },
    });

    const res = await app.fetch(
      rpcRequest('domains.add', admin.jwt, {
        projectId: project.id,
        hostname: 'access-race.example.com',
      }),
      env,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'ACCESS_DENIED', message: 'project access denied' },
    });
    expect(
      await env.db.select().from(domains).where(eq(domains.hostname, 'access-race.example.com')),
    ).toEqual([]);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/custom_hostnames/ch-access-race') &&
          (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toHaveLength(1);
  });

  it('compensates a protected-project create that loses the final domain-limit race', async () => {
    const user = await createTestUser(env.db, 'domain-limit-owner');
    const project = await createTestProject(env.db, user.id, 'domain-limit-race');
    await env.db.insert(projectZeroTrust).values({
      project_id: project.id,
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
    });
    await env.db.insert(domains).values(
      Array.from({ length: 99 }, (_, index) => ({
        id: `dom_limit_${index}`,
        project_id: project.id,
        hostname: `limit-${index}.example.com`,
        cf_hostname_id: `ch-limit-${index}`,
        status: 'active' as const,
      })),
    );
    const fetchMock = mockCfApi({
      createCustomHostname: async () => {
        await env.db.insert(domains).values({
          id: 'dom_limit_winner',
          project_id: project.id,
          hostname: 'limit-winner.example.com',
          cf_hostname_id: 'ch-limit-winner',
          status: 'active',
        });
        return cfSuccess({
          id: 'ch-limit-loser',
          hostname: 'limit-loser.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
        });
      },
    });

    const response = await app.fetch(
      rpcRequest('domains.add', user.jwt, {
        projectId: project.id,
        hostname: 'limit-loser.example.com',
      }),
      env,
    );

    expect(response.status).toBe(409);
    expect(rpcError(await response.json())).toBe(
      'Protected projects support at most 100 custom domains',
    );
    expect(
      await env.db.select().from(domains).where(eq(domains.project_id, project.id)),
    ).toHaveLength(100);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/custom_hostnames/ch-limit-loser') &&
          (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toHaveLength(1);
  });

  it('returns 404 for non-existent project', async () => {
    const user = await createTestUser(env.db);
    mockCfApi();

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, {
        projectId: 'proj_nonexistent',
        hostname: 'app.example.com',
      }),
      env,
    );

    expect(res.status).toBe(403);
  });

  it('returns 403 when user does not own project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-domain');
    mockCfApi();

    const res = await app.fetch(
      rpcRequest('domains.add', bob.jwt, { projectId: project.id, hostname: 'app.example.com' }),
      env,
    );

    expect(res.status).toBe(403);
  });

  it('returns 409 for duplicate hostname', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dup-domain');
    mockCfApi({
      createCustomHostname: () =>
        cfSuccess({
          id: 'ch-dup',
          hostname: 'taken.example.com',
          status: 'pending',
          ssl: { status: 'pending' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_existing',
      project_id: project.id,
      hostname: 'taken.example.com',
      cf_hostname_id: 'ch-existing',
    });

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, { projectId: project.id, hostname: 'taken.example.com' }),
      env,
    );

    expect(res.status).toBe(409);
    expect(rpcError(await res.json())).toBe('hostname already in use');
  });

  it('adopts an orphaned CF custom hostname when create reports a duplicate', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'adopt-orphan-domain');
    const fetchMock = mockCfApi({
      createCustomHostname: () => cfError('Duplicate custom hostname found.', 409),
      listCustomHostnames: () =>
        cfSuccess([
          {
            id: 'ch-orphan',
            hostname: 'orphan.example.com',
            status: 'pending',
            created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
            ssl: {
              status: 'pending_validation',
              method: 'http',
              type: 'dv',
            },
            ownership_verification: {
              type: 'txt',
              name: '_cf-custom-hostname.orphan.example.com',
              value: 'orphan-ownership-token',
            },
          },
        ]),
    });

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, {
        projectId: project.id,
        hostname: 'orphan.example.com',
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = rpcData(await res.json()) as {
      hostname: string;
      ownership_verification?: { name: string; value: string };
    };
    expect(body.hostname).toBe('orphan.example.com');
    expect(body.ownership_verification?.value).toBe('orphan-ownership-token');

    const [row] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'orphan.example.com'));
    expect(row?.cf_hostname_id).toBe('ch-orphan');

    const listCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames?') && (init?.method ?? 'GET') === 'GET';
    });
    expect(listCall).toBeDefined();
    const listUrl = new URL(String(listCall![0]));
    expect(listUrl.searchParams.get('hostname')).toBe('orphan.example.com');
    expect(listUrl.searchParams.has('hostname[contains]')).toBe(false);
  });

  it('passes through CF 429 when orphan lookup is rate-limited after duplicate create', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'adopt-orphan-rate-limit');
    mockCfApi({
      createCustomHostname: () => cfError('Duplicate custom hostname found.', 409),
      listCustomHostnames: () => cfError('rate limit exceeded', 429),
    });

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, {
        projectId: project.id,
        hostname: 'orphan-rate-limited.example.com',
      }),
      env,
    );

    expect(res.status).toBe(429);
    const body = { error: rpcError(await res.json()) };
    expect(body.error).toContain('rate limit exceeded');

    const [row] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'orphan-rate-limited.example.com'));
    expect(row).toBeUndefined();
  });

  it('falls back to the original duplicate response when orphan lookup fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'adopt-orphan-lookup-fails');
    mockCfApi({
      createCustomHostname: () => cfError('Duplicate custom hostname found.', 409),
      listCustomHostnames: () => cfError('Cloudflare unavailable', 500),
    });

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, {
        projectId: project.id,
        hostname: 'orphan-lookup-fails.example.com',
      }),
      env,
    );

    expect(res.status).toBe(409);
    const body = { error: rpcError(await res.json()) };
    expect(body.error).toContain('Duplicate custom hostname found.');

    const [row] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'orphan-lookup-fails.example.com'));
    expect(row).toBeUndefined();
  });

  it('does not adopt a newly-created CF custom hostname from an in-flight request', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'reject-inflight-domain');
    mockCfApi({
      createCustomHostname: () => cfError('Duplicate custom hostname found.', 409),
      listCustomHostnames: () =>
        cfSuccess([
          {
            id: 'ch-inflight',
            hostname: 'inflight.example.com',
            status: 'pending',
            created_at: new Date().toISOString(),
            ssl: {
              status: 'pending_validation',
              method: 'http',
              type: 'dv',
            },
          },
        ]),
    });

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, {
        projectId: project.id,
        hostname: 'inflight.example.com',
      }),
      env,
    );

    expect(res.status).toBe(409);
    const body = { error: rpcError(await res.json()) };
    expect(body.error).toContain('Duplicate custom hostname found.');

    const [row] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'inflight.example.com'));
    expect(row).toBeUndefined();
  });

  it('does not adopt an old active CF custom hostname without fresh ownership', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'reject-active-orphan-domain');
    mockCfApi({
      createCustomHostname: () => cfError('Duplicate custom hostname found.', 409),
      listCustomHostnames: () =>
        cfSuccess([
          {
            id: 'ch-active-orphan',
            hostname: 'active-orphan.example.com',
            status: 'active',
            created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            ssl: { status: 'active', method: 'http', type: 'dv' },
          },
        ]),
    });

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, {
        projectId: project.id,
        hostname: 'active-orphan.example.com',
      }),
      env,
    );

    expect(res.status).toBe(409);
    const body = { error: rpcError(await res.json()) };
    expect(body.error).toContain('Duplicate custom hostname found.');

    const [row] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'active-orphan.example.com'));
    expect(row).toBeUndefined();
  });

  it('does not delete a newly-created CF hostname another request persisted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'domain-db-insert-fail');
    const fetchMock = mockCfApi({
      createCustomHostname: async () => {
        await env.db.insert(domains).values({
          id: 'dom_race',
          project_id: project.id,
          hostname: 'race.example.com',
          cf_hostname_id: 'ch-race-created',
        });
        return cfSuccess({
          id: 'ch-race-created',
          hostname: 'race.example.com',
          status: 'pending',
          ssl: {
            status: 'pending_validation',
            method: 'http',
            type: 'dv',
          },
        });
      },
    });

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, { projectId: project.id, hostname: 'race.example.com' }),
      env,
    );

    expect(res.status).toBe(409);
    expect(rpcError(await res.json())).toBe('hostname already in use');

    const deletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/ch-race-created') && init?.method === 'DELETE';
    });
    expect(deletes).toHaveLength(0);

    const rows = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'race.example.com'));
    expect(rows).toHaveLength(1);
    expect(rows[0].cf_hostname_id).toBe('ch-race-created');
  });

  it('rejects buildwf.dev subdomains', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'reject-vc');
    mockCfApi();

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, { projectId: project.id, hostname: 'bad.buildwf.dev' }),
      env,
    );

    expect(res.status).toBe(400);
    expect(rpcError(await res.json())).toBe('cannot use buildwf.dev subdomains');
  });

  it('uses the installation domain for the CNAME target and reserved suffix', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'self-hosted-domain');
    mockCfApi({
      createCustomHostname: () =>
        cfSuccess({
          id: 'ch-self-hosted',
          hostname: 'www.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
          ownership_verification: {
            type: 'txt',
            name: '_cf-custom-hostname.www.example.com',
            value: 'ownership-v',
          },
        }),
    });
    const selfHostedEnv = { ...env, SITE_DOMAIN: 'apps.example.com' };
    const addDomain = (hostname: string) =>
      app.fetch(
        rpcRequest('domains.add', user.jwt, { projectId: project.id, hostname }),
        selfHostedEnv,
      );

    const rejected = await addDomain('bad.apps.example.com');
    expect(rejected.status).toBe(400);
    expect(rpcError(await rejected.json())).toBe('cannot use apps.example.com subdomains');

    const added = await addDomain('www.example.com');
    expect(added.status).toBe(200);
    const body = rpcData<{ cname_target: string }>(await added.json());
    expect(body.cname_target).toBe('cname.apps.example.com');
  });

  it('rejects invalid hostname format', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'invalid-host');
    mockCfApi();

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, { projectId: project.id, hostname: 'not a hostname' }),
      env,
    );

    expect(res.status).toBe(400);
    expect(rpcError(await res.json())).toBe('invalid hostname format');
  });

  it('returns 400 with the CF error message when CF rejects the hostname', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-rejects');
    mockCfApi({
      createCustomHostname: () => cfError('hostname is not a valid domain', 400),
    });

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, { projectId: project.id, hostname: 'foo.test' }),
      env,
    );

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = { error: rpcError(await res.json()) };
    expect(body.error).toContain('hostname is not a valid domain');

    const [row] = await env.db.select().from(domains).where(eq(domains.hostname, 'foo.test'));
    expect(row).toBeUndefined();
  });

  it('returns a generic JSON 500 (no err.message leak) for unexpected route errors', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'unexpected-throw');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secretMessage = 'boom: connection string postgres://user:hunter2@host/db failed';
    mockCfApi({
      createCustomHostname: () => {
        throw new Error(secretMessage);
      },
    });

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, {
        projectId: project.id,
        hostname: 'unexpected.example.com',
      }),
      env,
    );

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = { error: rpcError(await res.json()) };
    expect(body.error).toBe('Internal error');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(JSON.stringify(body)).not.toContain('postgres://');

    const errMessages = errSpy.mock.calls.map((call) =>
      call.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
    );
    expect(errMessages.some((msg) => msg.includes(secretMessage))).toBe(true);
  });

  it('returns 500 (not 401) when CF responds with 401 (our token broken)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-401');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCfApi({
      createCustomHostname: () => cfError('Authentication error', 401),
    });

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, {
        projectId: project.id,
        hostname: 'cf-auth-fail.example.com',
      }),
      env,
    );

    expect(res.status).toBe(500);
    const body = { error: rpcError(await res.json()) };
    expect(body.error).toBe('Internal error');

    const [row] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'cf-auth-fail.example.com'));
    expect(row).toBeUndefined();

    const errMessages = errSpy.mock.calls.map((call) =>
      call.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
    );
    expect(errMessages.some((msg) => msg.includes('Authentication error'))).toBe(true);
  });

  // Decision: CF 403 is ambiguous: a caller-fixable rule (like a hostname matching the SaaS zone apex) or an
  // auth failure (an under-scoped `CF_API_TOKEN`, CF error code 10000). The status alone can't tell,
  // so the route treats 403 like 401 to avoid leaking auth text: a generic 500, with the CF message
  // logged.
  it('returns 500 (not 403) when CF responds with 403 — auth/rule ambiguity', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-403');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cfAuthMessage = 'Authentication error (10000): API token under-scoped';
    mockCfApi({
      createCustomHostname: () => cfError(cfAuthMessage, 403),
    });

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, {
        projectId: project.id,
        hostname: 'cf-403-case.example.com',
      }),
      env,
    );

    expect(res.status).toBe(500);
    const body = { error: rpcError(await res.json()) };
    expect(body.error).toBe('Internal error');
    expect(JSON.stringify(body)).not.toContain('Authentication');
    expect(JSON.stringify(body)).not.toContain('under-scoped');

    const [row] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'cf-403-case.example.com'));
    expect(row).toBeUndefined();

    const errMessages = errSpy.mock.calls.map((call) =>
      call.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
    );
    expect(errMessages.some((msg) => msg.includes(cfAuthMessage))).toBe(true);
  });

  it('passes through CF 429 (rate limit) so the caller can back off', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-429');
    mockCfApi({
      createCustomHostname: () => cfError('rate limit exceeded', 429),
    });

    const res = await app.fetch(
      rpcRequest('domains.add', user.jwt, {
        projectId: project.id,
        hostname: 'rate-limited.example.com',
      }),
      env,
    );

    expect(res.status).toBe(429);
    const body = { error: rpcError(await res.json()) };
    expect(body.error).toContain('rate limit exceeded');
  });
});

describe('GET /projects/:id/domains', () => {
  it('lists domains for a project', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'list-domain');

    await env.db.insert(domains).values({
      id: 'dom_1',
      project_id: project.id,
      hostname: 'a.example.com',
      cf_hostname_id: 'ch-1',
      status: 'active',
    });
    await env.db.insert(domains).values({
      id: 'dom_2',
      project_id: project.id,
      hostname: 'b.example.com',
      cf_hostname_id: 'ch-2',
      status: 'pending',
    });

    const res = await app.fetch(
      rpcRequest('domains.list', user.jwt, { projectId: project.id }),
      env,
    );

    expect(res.status).toBe(200);
    const body = rpcData(await res.json()) as Array<{ hostname: string; status: string }>;
    expect(body).toHaveLength(2);
    expect(body[0].hostname).toBe('a.example.com');
    expect(body[1].hostname).toBe('b.example.com');
  });
});

describe('GET /projects/:id/domains/:domainId', () => {
  it('returns domain status from CF API', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'status-domain');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-status',
          hostname: 'status.example.com',
          status: 'pending',
          ssl: {
            status: 'pending_validation',
            method: 'txt',
            type: 'dv',
            validation_records: [
              {
                txt_name: '_acme-challenge.status.example.com',
                txt_value: 'acme-v',
                status: 'pending_validation',
              },
            ],
          },
          ownership_verification: {
            type: 'txt',
            name: '_cf-custom-hostname.status.example.com',
            value: 'ownership-v',
          },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_status',
      project_id: project.id,
      hostname: 'status.example.com',
      cf_hostname_id: 'ch-status',
      status: 'pending',
    });

    const res = await app.fetch(
      rpcRequest('domains.status', user.jwt, { projectId: project.id, domainId: 'dom_status' }),
      env,
    );

    expect(res.status).toBe(200);
    const body = rpcData(await res.json()) as {
      hostname: string;
      status: string;
      cname_target: string;
      ssl_status: string;
      ownership_verification?: { name: string; value: string };
      ssl_validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
    };
    expect(body.hostname).toBe('status.example.com');
    expect(body.status).toBe('pending');
    expect(body.cname_target).toBe('cname.buildwf.dev');
    expect(body.ssl_status).toBe('pending_validation');
    expect(body.ownership_verification?.name).toBe('_cf-custom-hostname.status.example.com');
    expect(body.ssl_validation_records).toBeDefined();
  });

  it('activates domain and writes KV when CF reports active', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'activate-domain');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-active',
          hostname: 'active.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_activate',
      project_id: project.id,
      hostname: 'active.example.com',
      cf_hostname_id: 'ch-active',
      status: 'pending',
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-activate-domain', projectId: project.id }),
    );

    const res = await app.fetch(
      rpcRequest('domains.status', user.jwt, { projectId: project.id, domainId: 'dom_activate' }),
      env,
    );

    expect(res.status).toBe(200);
    const body = rpcData<{ status: string }>(await res.json());
    expect(body.status).toBe('active');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_activate'));
    expect(row?.status).toBe('active');

    const domainRouting = await env.ROUTING.get('domain:active.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: 'user-activate-domain',
      projectId: project.id,
    });
  });

  it('does not write KV routing when CF reports active hostname but SSL is still validating', async () => {
    // Decision: CF can report `status: active` while `ssl.status` is `pending_validation` during cert renewal. The
    // CF for SaaS docs require `ssl.status === 'active'` before serving production traffic, so the gate
    // keeps the domain pending.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pending-ssl');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-pending-ssl',
          hostname: 'pending-ssl.example.com',
          status: 'active',
          ssl: {
            status: 'pending_validation',
            method: 'txt',
            type: 'dv',
            validation_records: [
              {
                txt_name: '_acme-challenge.pending-ssl.example.com',
                txt_value: 'acme-v',
                status: 'pending_validation',
              },
            ],
          },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_pending_ssl',
      project_id: project.id,
      hostname: 'pending-ssl.example.com',
      cf_hostname_id: 'ch-pending-ssl',
      status: 'pending',
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-pending-ssl', projectId: project.id }),
    );

    const res = await app.fetch(
      rpcRequest('domains.status', user.jwt, {
        projectId: project.id,
        domainId: 'dom_pending_ssl',
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = rpcData(await res.json()) as {
      status: string;
      ssl_status: string;
      ssl_validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
    };
    expect(body.status).toBe('pending');
    expect(body.ssl_status).toBe('pending_validation');
    expect(body.ssl_validation_records).toBeDefined();

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_pending_ssl'));
    expect(row?.status).toBe('pending');

    const domainRouting = await env.ROUTING.get('domain:pending-ssl.example.com');
    expect(domainRouting).toBeNull();
  });

  it('activates a fully-active HTTP-DCV hostname (no ownership_verification outstanding)', async () => {
    // Decision: The gate keys on `status`, `ssl.status` and a missing `ownership_verification`, not on
    // `ssl.method`, so an HTTP-DCV hostname that cleared ownership activates.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'http-dcv-active');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-http-dcv',
          hostname: 'http-dcv.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_http_dcv',
      project_id: project.id,
      hostname: 'http-dcv.example.com',
      cf_hostname_id: 'ch-http-dcv',
      status: 'pending',
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-http-dcv', projectId: project.id }),
    );

    const res = await app.fetch(
      rpcRequest('domains.status', user.jwt, { projectId: project.id, domainId: 'dom_http_dcv' }),
      env,
    );

    expect(res.status).toBe(200);
    expect(rpcData<{ status: string }>(await res.json()).status).toBe('active');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_http_dcv'));
    expect(row?.status).toBe('active');

    const domainRouting = await env.ROUTING.get('domain:http-dcv.example.com', 'json');
    expect(domainRouting).toEqual({ workerName: 'user-http-dcv', projectId: project.id });
  });

  it('does NOT activate when ownership_verification is still present despite active status', async () => {
    // Decision: Even with `status: active` and `ssl.status: active`, an outstanding `ownership_verification` means
    // the `_cf-custom-hostname` TXT isn't proven. That ownership gate is the anti-hijack lever: a
    // wildcard CNAME can't forge the per-host TXT, so the gate refuses to route while it's present.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'ownership-outstanding');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-ownership-outstanding',
          hostname: 'ownership-outstanding.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
          ownership_verification: {
            type: 'txt',
            name: '_cf-custom-hostname.ownership-outstanding.example.com',
            value: 'ownership-v',
          },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_ownership_outstanding',
      project_id: project.id,
      hostname: 'ownership-outstanding.example.com',
      cf_hostname_id: 'ch-ownership-outstanding',
      status: 'pending',
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-ownership-outstanding', projectId: project.id }),
    );

    const res = await app.fetch(
      rpcRequest('domains.status', user.jwt, {
        projectId: project.id,
        domainId: 'dom_ownership_outstanding',
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(rpcData<{ status: string }>(await res.json()).status).toBe('pending');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_ownership_outstanding'));
    expect(row?.status).toBe('pending');

    expect(await env.ROUTING.get('domain:ownership-outstanding.example.com')).toBeNull();
  });

  it('activates a legacy TXT-DCV hostname (backward compat, no stranding)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-txt');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-legacy-txt',
          hostname: 'legacy-txt.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'txt', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_legacy_txt',
      project_id: project.id,
      hostname: 'legacy-txt.example.com',
      cf_hostname_id: 'ch-legacy-txt',
      status: 'pending',
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-legacy-txt', projectId: project.id }),
    );

    const res = await app.fetch(
      rpcRequest('domains.status', user.jwt, { projectId: project.id, domainId: 'dom_legacy_txt' }),
      env,
    );

    expect(res.status).toBe(200);
    expect(rpcData<{ status: string }>(await res.json()).status).toBe('active');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_legacy_txt'));
    expect(row?.status).toBe('active');

    const domainRouting = await env.ROUTING.get('domain:legacy-txt.example.com', 'json');
    expect(domainRouting).toEqual({ workerName: 'user-legacy-txt', projectId: project.id });
  });

  it('returns cf_status matching CF raw status', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-status-passthrough');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-cf-status',
          hostname: 'cf-status.example.com',
          status: 'pending_validation',
          ssl: { status: 'pending_validation', method: 'txt', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_cf_status',
      project_id: project.id,
      hostname: 'cf-status.example.com',
      cf_hostname_id: 'ch-cf-status',
      status: 'pending',
    });

    const res = await app.fetch(
      rpcRequest('domains.status', user.jwt, { projectId: project.id, domainId: 'dom_cf_status' }),
      env,
    );

    expect(res.status).toBe(200);
    const body = rpcData<{ cf_status: string }>(await res.json());
    expect(body.cf_status).toBe('pending_validation');
  });

  it('awaiting_deployment is true when CF gate satisfied but slug routing absent', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'awaiting-deploy-true');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-awaiting',
          hostname: 'awaiting.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'txt', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_awaiting',
      project_id: project.id,
      hostname: 'awaiting.example.com',
      cf_hostname_id: 'ch-awaiting',
      status: 'pending',
    });

    const res = await app.fetch(
      rpcRequest('domains.status', user.jwt, { projectId: project.id, domainId: 'dom_awaiting' }),
      env,
    );

    expect(res.status).toBe(200);
    const body = rpcData(await res.json()) as { status: string; awaiting_deployment: boolean };
    expect(body.awaiting_deployment).toBe(true);
    expect(body.status).toBe('pending');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_awaiting'));
    expect(row?.status).toBe('pending');

    expect(await env.ROUTING.get('domain:awaiting.example.com')).toBeNull();
  });

  it('awaiting_deployment is false when slug routing is present', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'awaiting-deploy-false');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-routing',
          hostname: 'routed.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'txt', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_routed',
      project_id: project.id,
      hostname: 'routed.example.com',
      cf_hostname_id: 'ch-routing',
      status: 'pending',
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-routed', projectId: project.id }),
    );

    const res = await app.fetch(
      rpcRequest('domains.status', user.jwt, { projectId: project.id, domainId: 'dom_routed' }),
      env,
    );

    expect(res.status).toBe(200);
    const body = rpcData(await res.json()) as { status: string; awaiting_deployment: boolean };
    expect(body.awaiting_deployment).toBe(false);
    expect(body.status).toBe('active');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_routed'));
    expect(row?.status).toBe('active');

    expect(await env.ROUTING.get('domain:routed.example.com')).not.toBeNull();
  });

  it('awaiting_deployment is false when CF gate is not yet satisfied', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'awaiting-deploy-pending-cf');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-cf-pending',
          hostname: 'cf-pending.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'txt', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_cf_pending',
      project_id: project.id,
      hostname: 'cf-pending.example.com',
      cf_hostname_id: 'ch-cf-pending',
      status: 'pending',
    });

    const res = await app.fetch(
      rpcRequest('domains.status', user.jwt, { projectId: project.id, domainId: 'dom_cf_pending' }),
      env,
    );

    expect(res.status).toBe(200);
    const body = rpcData<{ awaiting_deployment: boolean }>(await res.json());
    expect(body.awaiting_deployment).toBe(false);
  });

  it('keeps domain pending when slug routing is absent', async () => {
    // Decision: CF reports active but the project was never deployed, so `project.slug` isn't in KV. Activating the
    // row without writing `domain:<hostname>` would leave traffic 404ing, since later polls wouldn't fire
    // the gate. DB and KV stay pending together until a deploy writes the slug entry.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-slug-routing');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-no-slug',
          hostname: 'no-slug.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'txt', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_no_slug',
      project_id: project.id,
      hostname: 'no-slug.example.com',
      cf_hostname_id: 'ch-no-slug',
      status: 'pending',
    });

    const res = await app.fetch(
      rpcRequest('domains.status', user.jwt, { projectId: project.id, domainId: 'dom_no_slug' }),
      env,
    );

    expect(res.status).toBe(200);
    expect(rpcData<{ status: string }>(await res.json()).status).toBe('pending');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_no_slug'));
    expect(row?.status).toBe('pending');

    expect(await env.ROUTING.get('domain:no-slug.example.com')).toBeNull();
  });

  it('does NOT re-trigger HTTP DCV via PATCH from the status route (PATCH is hourly-reconcile-only)', async () => {
    // Decision: The HTTP-DCV re-trigger PATCH runs only on the hourly reconcile tier to bound CF custom-hostname
    // API load. The status route polls CF with GET but doesn't PATCH.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'patch-dcv-retrigger');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-patch-pending',
          hostname: 'patch-pending.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_patch_pending',
      project_id: project.id,
      hostname: 'patch-pending.example.com',
      cf_hostname_id: 'ch-patch-pending',
      status: 'pending',
    });

    const res = await app.fetch(
      rpcRequest('domains.status', user.jwt, {
        projectId: project.id,
        domainId: 'dom_patch_pending',
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(rpcData<{ status: string }>(await res.json()).status).toBe('pending');

    const getCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return (
        url.includes('/custom_hostnames/ch-patch-pending') && (init?.method ?? 'GET') === 'GET'
      );
    });
    expect(getCalls.length).toBeGreaterThanOrEqual(1);

    const patchCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'PATCH';
    });
    expect(patchCalls).toHaveLength(0);
  });

  it('does NOT PATCH when CF reports fully active + gated (already validated)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'patch-skip-active');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-patch-active',
          hostname: 'patch-active.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_patch_active',
      project_id: project.id,
      hostname: 'patch-active.example.com',
      cf_hostname_id: 'ch-patch-active',
      status: 'pending',
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-patch-skip-active', projectId: project.id }),
    );

    const res = await app.fetch(
      rpcRequest('domains.status', user.jwt, {
        projectId: project.id,
        domainId: 'dom_patch_active',
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(rpcData<{ status: string }>(await res.json()).status).toBe('active');

    const patchCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'PATCH';
    });
    expect(patchCalls).toHaveLength(0);
  });

  it('does NOT PATCH an already-active domain row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'patch-skip-already-active');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-patch-already',
          hostname: 'patch-already.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_patch_already',
      project_id: project.id,
      hostname: 'patch-already.example.com',
      cf_hostname_id: 'ch-patch-already',
      status: 'active',
    });

    const res = await app.fetch(
      rpcRequest('domains.status', user.jwt, {
        projectId: project.id,
        domainId: 'dom_patch_already',
      }),
      env,
    );

    expect(res.status).toBe(200);

    const patchCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'PATCH';
    });
    expect(patchCalls).toHaveLength(0);
  });
});

describe('DELETE /projects/:id/domains/:domainId', () => {
  it('removes a custom domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'remove-domain');
    const fetchMock = mockCfApi();

    await env.db.insert(domains).values({
      id: 'dom_remove',
      project_id: project.id,
      hostname: 'remove.example.com',
      cf_hostname_id: 'ch-remove',
      status: 'active',
    });

    await env.ROUTING.put('domain:remove.example.com', JSON.stringify({ projectId: project.id }));

    const res = await app.fetch(
      rpcRequest('domains.remove', user.jwt, { projectId: project.id, domainId: 'dom_remove' }),
      env,
    );

    expect(res.status).toBe(200);
    expect(rpcData(await res.json())).toMatchObject({ ok: true });

    const [row] = await env.db.select().from(domains).where(eq(domains.id, 'dom_remove'));
    expect(row).toBeUndefined();

    const domainRouting = await env.ROUTING.get('domain:remove.example.com');
    expect(domainRouting).toBeNull();

    const deleteCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return (
        url.includes('/custom_hostnames/ch-remove') && (call[1] as RequestInit)?.method === 'DELETE'
      );
    });
    expect(deleteCall).toBeDefined();
  });

  it('still deletes DB record and KV when CF hostname deletion fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-fail-domain');
    mockCfApi({
      deleteCustomHostname: () => {
        throw new Error('CF API down');
      },
    });

    await env.db.insert(domains).values({
      id: 'dom_cf_fail',
      project_id: project.id,
      hostname: 'cf-fail.example.com',
      cf_hostname_id: 'ch-cf-fail',
      status: 'active',
    });

    await env.ROUTING.put('domain:cf-fail.example.com', JSON.stringify({ projectId: project.id }));

    const res = await app.fetch(
      rpcRequest('domains.remove', user.jwt, { projectId: project.id, domainId: 'dom_cf_fail' }),
      env,
    );

    expect(res.status).toBe(200);
    const body = rpcData(await res.json()) as { ok: boolean; warnings: Array<string> };
    expect(body.ok).toBe(true);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain('CF API down');

    const [row] = await env.db.select().from(domains).where(eq(domains.id, 'dom_cf_fail'));
    expect(row).toBeUndefined();

    const routing = await env.ROUTING.get('domain:cf-fail.example.com');
    expect(routing).toBeNull();
  });

  it('returns 404 for non-existent domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-domain');
    mockCfApi();

    const res = await app.fetch(
      rpcRequest('domains.remove', user.jwt, {
        projectId: project.id,
        domainId: 'dom_nonexistent',
      }),
      env,
    );

    expect(res.status).toBe(404);
  });
});

describe('scheduled() — stale pending domain janitor', () => {
  it('deletes stale (>7d) pending domains via CF + DB and leaves recent ones untouched', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-project');
    const fetchMock = mockCfApi();

    const nowMs = Date.now();
    const eightDaysAgo = new Date(nowMs - 8 * 24 * 60 * 60 * 1000).toISOString();

    await env.db.insert(domains).values({
      id: 'dom_stale',
      project_id: project.id,
      hostname: 'stale.example.com',
      cf_hostname_id: 'ch-stale',
      status: 'pending',
      created_at: eightDaysAgo,
    });
    await env.db.insert(domains).values({
      id: 'dom_recent',
      project_id: project.id,
      hostname: 'recent.example.com',
      cf_hostname_id: 'ch-recent',
      status: 'pending',
    });

    const { queries } = await captureQueries(env.db, () =>
      cleanupStalePendingDomains(makeBindings(env), env.db, nowMs),
    );
    expect(queries.some((query) => /from\s+"?projects"?.*for update/i.test(query))).toBe(true);

    const [staleRow] = await env.db.select().from(domains).where(eq(domains.id, 'dom_stale'));
    expect(staleRow).toBeUndefined();

    const [recentRow] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_recent'));
    expect(recentRow?.status).toBe('pending');

    const deleteCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'DELETE';
    });
    const deleteUrls = deleteCalls.map((call) =>
      typeof call[0] === 'string' ? call[0] : String(call[0]),
    );
    expect(deleteUrls.some((url) => url.includes('/custom_hostnames/ch-stale'))).toBe(true);
    expect(deleteUrls.some((url) => url.includes('/custom_hostnames/ch-recent'))).toBe(false);
  });

  it('leaves a recent pending domain entirely untouched (no CF delete)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-recent-only');
    const fetchMock = mockCfApi();

    await env.db.insert(domains).values({
      id: 'dom_recent_only',
      project_id: project.id,
      hostname: 'recent-only.example.com',
      cf_hostname_id: 'ch-recent-only',
      status: 'pending',
    });

    const controller = { scheduledTime: Date.now() } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_recent_only'));
    expect(row?.status).toBe('pending');

    const customHostnameDeletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'DELETE';
    });
    expect(customHostnameDeletes).toHaveLength(0);
  });

  it('removes a deleted stale domain from protected Zero Trust destinations', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-zero-trust');
    const applications = new Map<string, Record<string, unknown>>();
    let nextApplication = 1;
    let customHostnameStatus: 'active' | 'pending' = 'active';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.pathname.includes('/custom_hostnames/')) {
          if (init?.method === 'DELETE') {
            return cfSuccess(null);
          }
          return cfSuccess({
            id: 'ch-janitor-zero-trust',
            hostname: 'stale-protected.example.com',
            status: customHostnameStatus,
            ssl: {
              status: customHostnameStatus === 'active' ? 'active' : 'pending_validation',
              method: 'http',
              type: 'dv',
            },
          });
        }
        const path = url.pathname.split('/access/')[1] ?? '';
        if (path === 'organizations') {
          return cfSuccess({ auth_domain: 'company.cloudflareaccess.com' });
        }
        if (path === 'identity_providers/idp-1') {
          return cfSuccess({ id: 'idp-1', name: 'Company SSO' });
        }
        if (path === 'policies/policy-1') {
          return cfSuccess({
            id: 'policy-1',
            decision: 'allow',
            include: [{ email_domain: { domain: 'example.com' } }],
          });
        }
        if (path === 'apps' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          const id = `app-${nextApplication++}`;
          const application = { ...body, id, aud: `aud-${id}` };
          applications.set(id, application);
          return cfSuccess(application);
        }
        if (path === 'apps') {
          return cfSuccess([...applications.values()]);
        }
        const match = /^apps\/([^/]+)$/.exec(path);
        const applicationId = match?.[1];
        if (applicationId && init?.method === 'PUT') {
          const previous = applications.get(applicationId);
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          const application = { ...body, id: applicationId, aud: previous?.aud };
          applications.set(applicationId, application);
          return cfSuccess(application);
        }
        if (applicationId && init?.method === 'DELETE') {
          applications.delete(applicationId);
          return cfSuccess({ id: applicationId });
        }
        if (applicationId) {
          return cfSuccess(applications.get(applicationId));
        }
        throw new Error(`unexpected Cloudflare request: ${url}`);
      }),
    );
    const bindings = {
      ...makeBindings(env),
      SITE_DOMAIN: 'apps.example.com',
      PLATFORM_INSTALLATION_ID: 'installation-test',
    } as ApiEnv['Bindings'];

    await configurePlatformZeroTrust(bindings, env.db, {
      apiToken: 'access-management-token',
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
      protectNewProjects: true,
      existingProjects: 'protected',
    });

    const nowMs = Date.now();
    await env.db.insert(domains).values({
      id: 'dom_janitor_zero_trust',
      project_id: project.id,
      hostname: 'stale-protected.example.com',
      cf_hostname_id: 'ch-janitor-zero-trust',
      status: 'pending',
      created_at: new Date(nowMs - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const [pendingDomain] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.id, 'dom_janitor_zero_trust'));

    const activation = await tryActivateDomain(
      bindings,
      env.db,
      pendingDomain,
      project as unknown as Project,
    );
    expect(activation).toMatchObject({ activated: false, awaitingDeployment: true });
    expect(
      [...applications.values()].some((application) =>
        JSON.stringify(application.destinations).includes('stale-protected.example.com'),
      ),
    ).toBe(true);

    customHostnameStatus = 'pending';
    await cleanupStalePendingDomains(bindings, env.db, nowMs);

    const [deletedDomain] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.id, 'dom_janitor_zero_trust'));
    expect(deletedDomain).toBeUndefined();
    expect(
      [...applications.values()].some((application) =>
        JSON.stringify(application.destinations).includes('stale-protected.example.com'),
      ),
    ).toBe(false);
  });

  it('does NOT delete a stale row that CF reports active (verified after day 7)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-late-verify');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-late',
          hostname: 'late.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
        }),
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_late',
      project_id: project.id,
      hostname: 'late.example.com',
      cf_hostname_id: 'ch-late',
      status: 'pending',
      created_at: eightDaysAgo,
    });

    const controller = { scheduledTime: Date.now() } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_late'));
    expect(row?.status).toBe('pending');

    const deletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'DELETE';
    });
    expect(deletes).toHaveLength(0);
  });

  it('drops the DB row when CF reports the hostname already gone (404 on read)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-cf-gone');
    const fetchMock = mockCfApi({
      getCustomHostname: () => cfError('custom hostname not found', 404),
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_cf_gone',
      project_id: project.id,
      hostname: 'cf-gone.example.com',
      cf_hostname_id: 'ch-cf-gone',
      status: 'pending',
      created_at: eightDaysAgo,
    });

    let transactionDepth = 0;
    const originalTransaction = env.db.transaction.bind(env.db);
    vi.spyOn(env.db, 'transaction').mockImplementation(async (...args) => {
      transactionDepth += 1;
      try {
        return await originalTransaction(...args);
      } finally {
        transactionDepth -= 1;
      }
    });
    let routeDeletedUnderFence = false;
    const originalRoutingDelete = env.ROUTING.delete.bind(env.ROUTING);
    vi.spyOn(env.ROUTING, 'delete').mockImplementation(async (key) => {
      if (key === 'domain:cf-gone.example.com') {
        routeDeletedUnderFence = transactionDepth > 0;
      }
      return originalRoutingDelete(key);
    });

    const controller = { scheduledTime: Date.now() } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db.select().from(domains).where(eq(domains.id, 'dom_cf_gone'));
    expect(row).toBeUndefined();
    expect(routeDeletedUnderFence).toBe(true);

    const deletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'DELETE';
    });
    expect(deletes).toHaveLength(0);
  });

  it('treats a 404 from the CF delete as success and still removes the row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-delete-404');
    const fetchMock = mockCfApi({
      deleteCustomHostname: () => cfError('custom hostname not found', 404),
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_del_404',
      project_id: project.id,
      hostname: 'del-404.example.com',
      cf_hostname_id: 'ch-del-404',
      status: 'pending',
      created_at: eightDaysAgo,
    });

    const controller = { scheduledTime: Date.now() } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db.select().from(domains).where(eq(domains.id, 'dom_del_404'));
    expect(row).toBeUndefined();
    const deletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/ch-del-404') && init?.method === 'DELETE';
    });
    expect(deletes).toHaveLength(1);
  });

  it('ACTIVATES a stale (>7d) pending domain that CF reports active + gated (backlog starvation gap)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-activate');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-janitor-activate',
          hostname: 'janitor-activate.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
        }),
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_janitor_activate',
      project_id: project.id,
      hostname: 'janitor-activate.example.com',
      cf_hostname_id: 'ch-janitor-activate',
      status: 'pending',
      created_at: eightDaysAgo,
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-janitor-activate', projectId: project.id }),
    );

    // Decision: Call the janitor alone. The hourly scheduled() runs reconcile first, which would activate this
    // domain before the janitor sees it. Calling it directly reproduces the large-backlog case where only
    // the janitor can activate the domain.
    await cleanupStalePendingDomains(makeBindings(env), env.db, Date.now());

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_janitor_activate'));
    expect(row?.status).toBe('active');

    const domainRouting = await env.ROUTING.get('domain:janitor-activate.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: 'user-janitor-activate',
      projectId: project.id,
    });
  });

  it('does NOT activate a stale CF-active domain owned by an ADMIN-suspended account (and does NOT delete it)', async () => {
    const user = await createTestUser(env.db);
    await env.db
      .update(users)
      .set({ suspended_reason: 'tos_violation' })
      .where(eq(users.id, user.id));
    const project = await createTestProject(env.db, user.id, 'janitor-activate-suspended');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-janitor-suspended',
          hostname: 'janitor-suspended.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
        }),
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_janitor_suspended',
      project_id: project.id,
      hostname: 'janitor-suspended.example.com',
      cf_hostname_id: 'ch-janitor-suspended',
      status: 'pending',
      created_at: eightDaysAgo,
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-janitor-activate-suspended', projectId: project.id }),
    );

    await cleanupStalePendingDomains(makeBindings(env), env.db, Date.now());

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_janitor_suspended'));
    expect(row?.status).toBe('pending');

    expect(await env.ROUTING.get('domain:janitor-suspended.example.com')).toBeNull();
    const deletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'DELETE';
    });
    expect(deletes).toHaveLength(0);
  });

  it('retries the CF delete once when the first DELETE fails non-404, then removes the row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-delete-retry');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let deleteAttempts = 0;
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-del-retry',
          hostname: 'del-retry.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
        }),
      deleteCustomHostname: () => {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          return cfError('internal server error', 500);
        }
        return cfSuccess(null);
      },
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_del_retry',
      project_id: project.id,
      hostname: 'del-retry.example.com',
      cf_hostname_id: 'ch-del-retry',
      status: 'pending',
      created_at: eightDaysAgo,
    });

    // Decision: Run the janitor alone so other hourly maintenance doesn't change the DELETE retry count.
    await cleanupStalePendingDomains(makeBindings(env), env.db, Date.now());

    const [row] = await env.db.select().from(domains).where(eq(domains.id, 'dom_del_retry'));
    expect(row).toBeUndefined();

    expect(deleteAttempts).toBe(2);

    const errMessages = errSpy.mock.calls.map((call) =>
      call.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
    );
    expect(errMessages.some((msg) => msg.includes('ORPHANED'))).toBe(false);
  });
});

describe('scheduled() — cron-driven auto-activation reconciliation', () => {
  function gatePassingCfHostname(id: string, hostname: string) {
    return cfSuccess({
      id,
      hostname,
      status: 'active',
      ssl: { status: 'active', method: 'http', type: 'dv' },
    });
  }

  it('fast tier (*/2) activates a young pending domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'fast-young-activate');
    mockCfApi({
      getCustomHostname: () => gatePassingCfHostname('ch-fast-young', 'fast-young.example.com'),
    });

    const nowMs = Date.now();
    const fiveMinutesAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_fast_young',
      project_id: project.id,
      hostname: 'fast-young.example.com',
      cf_hostname_id: 'ch-fast-young',
      status: 'pending',
      created_at: fiveMinutesAgo,
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-fast-young-activate', projectId: project.id }),
    );

    const controller = {
      scheduledTime: nowMs,
      cron: FAST_CRON,
    } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_fast_young'));
    expect(row?.status).toBe('active');

    const domainRouting = await env.ROUTING.get('domain:fast-young.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: 'user-fast-young-activate',
      projectId: project.id,
    });
  });

  it('does not let malformed Zero Trust state starve fast domain reconciliation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'fast-invalid-zero-trust');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        gatePassingCfHostname('ch-fast-invalid-zero-trust', 'invalid-zero-trust.example.com'),
    });
    await env.db.insert(platformSettings).values({
      key: 'zeroTrust.configuration',
      value: { version: 999 },
    });
    await env.db.insert(domains).values({
      id: 'dom_fast_invalid_zero_trust',
      project_id: project.id,
      hostname: 'invalid-zero-trust.example.com',
      cf_hostname_id: 'ch-fast-invalid-zero-trust',
      status: 'pending',
      created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-fast-invalid-zero-trust', projectId: project.id }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await scheduled(
      { scheduledTime: Date.now(), cron: FAST_CRON } as ScheduledController,
      makeBindings(env),
      mockCtx,
    );

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_fast_invalid_zero_trust'));
    expect(row?.status).toBe('pending');
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/custom_hostnames/ch-fast-invalid-zero-trust'),
      ),
    ).toBe(true);
  });

  it('fast tier (*/2) ignores an old pending domain (created >30 min ago)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'fast-old-skip');
    mockCfApi({
      getCustomHostname: () => gatePassingCfHostname('ch-fast-old', 'fast-old.example.com'),
    });

    const nowMs = Date.now();
    const fortyFiveMinutesAgo = new Date(nowMs - 45 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_fast_old',
      project_id: project.id,
      hostname: 'fast-old.example.com',
      cf_hostname_id: 'ch-fast-old',
      status: 'pending',
      created_at: fortyFiveMinutesAgo,
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-fast-old-skip', projectId: project.id }),
    );

    const controller = {
      scheduledTime: nowMs,
      cron: FAST_CRON,
    } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_fast_old'));
    expect(row?.status).toBe('pending');

    expect(await env.ROUTING.get('domain:fast-old.example.com')).toBeNull();
  });

  it('hourly tier (:00) activates an old pending domain (>30 min)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'hourly-old-activate');
    mockCfApi({
      getCustomHostname: () => gatePassingCfHostname('ch-hourly-old', 'hourly-old.example.com'),
    });

    const nowMs = Date.now();
    const fortyFiveMinutesAgo = new Date(nowMs - 45 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_hourly_old',
      project_id: project.id,
      hostname: 'hourly-old.example.com',
      cf_hostname_id: 'ch-hourly-old',
      status: 'pending',
      created_at: fortyFiveMinutesAgo,
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-hourly-old-activate', projectId: project.id }),
    );

    const controller = {
      scheduledTime: nowMs,
      cron: '0 * * * *',
    } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_hourly_old'));
    expect(row?.status).toBe('active');

    // Decision: The hourly rollover loop may backfill userId, so match only the essential fields.
    const domainRouting = await env.ROUTING.get('domain:hourly-old.example.com', 'json');
    expect(domainRouting).toMatchObject({
      workerName: 'user-hourly-old-activate',
      projectId: project.id,
    });
  });

  it('hourly tier re-triggers HTTP DCV via PATCH for a pending, ungated, http-method domain', async () => {
    // Decision: The add-first flow creates the CF hostname with ssl.method 'http' before the user points their
    // CNAME. CF needs a PATCH to complete HTTP validation once the domain points at the Managed CNAME; a
    // GET alone doesn't re-trigger DCV, and the hostname can stay pending until CF deletes it after 7
    // days. The re-trigger runs only on the hourly tier, so an hourly run over a pending, ungated
    // http-method domain sends one no-change PATCH.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'hourly-patch-retrigger');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-hourly-patch',
          hostname: 'hourly-patch.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
        }),
    });

    const nowMs = Date.now();
    await env.db.insert(domains).values({
      id: 'dom_hourly_patch',
      project_id: project.id,
      hostname: 'hourly-patch.example.com',
      cf_hostname_id: 'ch-hourly-patch',
      status: 'pending',
      created_at: new Date(nowMs - 45 * 60 * 1000).toISOString(),
    });

    const controller = { scheduledTime: nowMs, cron: '0 * * * *' } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const patchCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/ch-hourly-patch') && init?.method === 'PATCH';
    });
    expect(patchCalls).toHaveLength(1);
    const patchBody = JSON.parse((patchCalls[0][1] as RequestInit).body as string) as {
      ssl: { method: string; type: string };
    };
    expect(patchBody.ssl.method).toBe('http');
    expect(patchBody.ssl.type).toBe('dv');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_hourly_patch'));
    expect(row?.status).toBe('pending');
  });

  it('fast tier does NOT PATCH a pending, ungated, http-method young domain (CF still polled)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'fast-no-patch');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-fast-no-patch',
          hostname: 'fast-no-patch.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
        }),
    });

    const nowMs = Date.now();
    await env.db.insert(domains).values({
      id: 'dom_fast_no_patch',
      project_id: project.id,
      hostname: 'fast-no-patch.example.com',
      cf_hostname_id: 'ch-fast-no-patch',
      status: 'pending',
      created_at: new Date(nowMs - 5 * 60 * 1000).toISOString(),
    });

    const controller = { scheduledTime: nowMs, cron: FAST_CRON } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const getCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return (
        url.includes('/custom_hostnames/ch-fast-no-patch') && (init?.method ?? 'GET') === 'GET'
      );
    });
    expect(getCalls.length).toBeGreaterThanOrEqual(1);

    const patchCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'PATCH';
    });
    expect(patchCalls).toHaveLength(0);
  });

  it('hourly tier does NOT PATCH a fully-active + gated domain (activates as before)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'hourly-gated-no-patch');
    const fetchMock = mockCfApi({
      getCustomHostname: () => gatePassingCfHostname('ch-hourly-gated', 'hourly-gated.example.com'),
    });

    const nowMs = Date.now();
    await env.db.insert(domains).values({
      id: 'dom_hourly_gated',
      project_id: project.id,
      hostname: 'hourly-gated.example.com',
      cf_hostname_id: 'ch-hourly-gated',
      status: 'pending',
      created_at: new Date(nowMs - 45 * 60 * 1000).toISOString(),
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-hourly-gated-no-patch', projectId: project.id }),
    );

    const controller = { scheduledTime: nowMs, cron: '0 * * * *' } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_hourly_gated'));
    expect(row?.status).toBe('active');

    const patchCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'PATCH';
    });
    expect(patchCalls).toHaveLength(0);
  });

  it('hourly tier does NOT PATCH a legacy TXT-method pending domain (leaves it on txt)', async () => {
    // Decision: A legacy TXT-DCV hostname (the user is still publishing `_acme-challenge` records) mustn't be
    // PATCHed to HTTP-DCV: that would discard their in-progress validation and break the no-migration
    // guarantee.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'hourly-legacy-txt');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-hourly-legacy-txt',
          hostname: 'hourly-legacy-txt.example.com',
          status: 'pending',
          ssl: {
            status: 'pending_validation',
            method: 'txt',
            type: 'dv',
            validation_records: [
              {
                txt_name: '_acme-challenge.hourly-legacy-txt.example.com',
                txt_value: 'acme-v',
                status: 'pending_validation',
              },
            ],
          },
        }),
    });

    const nowMs = Date.now();
    await env.db.insert(domains).values({
      id: 'dom_hourly_legacy_txt',
      project_id: project.id,
      hostname: 'hourly-legacy-txt.example.com',
      cf_hostname_id: 'ch-hourly-legacy-txt',
      status: 'pending',
      created_at: new Date(nowMs - 45 * 60 * 1000).toISOString(),
    });

    const controller = { scheduledTime: nowMs, cron: '0 * * * *' } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const patchCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'PATCH';
    });
    expect(patchCalls).toHaveLength(0);

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_hourly_legacy_txt'));
    expect(row?.status).toBe('pending');
  });

  it('gate not satisfied (ownership_verification still present) — never activated on either tier', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gate-blocked');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-gate-blocked',
          hostname: 'gate-blocked.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
          ownership_verification: {
            type: 'txt',
            name: '_cf-custom-hostname.gate-blocked.example.com',
            value: 'ownership-v',
          },
        }),
    });

    const nowMs = Date.now();
    const fiveMinutesAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_gate_blocked',
      project_id: project.id,
      hostname: 'gate-blocked.example.com',
      cf_hostname_id: 'ch-gate-blocked',
      status: 'pending',
      created_at: fiveMinutesAgo,
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-gate-blocked', projectId: project.id }),
    );

    for (const cron of [FAST_CRON, '0 * * * *']) {
      const controller = { scheduledTime: nowMs, cron } as ScheduledController;
      await scheduled(controller, makeBindings(env), mockCtx);
    }

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_gate_blocked'));
    expect(row?.status).toBe('pending');

    expect(await env.ROUTING.get('domain:gate-blocked.example.com')).toBeNull();
  });

  it('gate satisfied but no slug routing (awaiting deployment) — stays pending, no KV write', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'awaiting-deploy-cron');
    mockCfApi({
      getCustomHostname: () =>
        gatePassingCfHostname('ch-awaiting-deploy', 'awaiting-deploy.example.com'),
    });

    const nowMs = Date.now();
    const fiveMinutesAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_awaiting_deploy',
      project_id: project.id,
      hostname: 'awaiting-deploy.example.com',
      cf_hostname_id: 'ch-awaiting-deploy',
      status: 'pending',
      created_at: fiveMinutesAgo,
    });

    const controller = {
      scheduledTime: nowMs,
      cron: FAST_CRON,
    } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_awaiting_deploy'));
    expect(row?.status).toBe('pending');

    expect(await env.ROUTING.get('domain:awaiting-deploy.example.com')).toBeNull();
  });

  it('reconcile runs before cleanup: a >7d domain whose gate just passed is activated not deleted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'reconcile-before-cleanup');
    mockCfApi({
      getCustomHostname: () => gatePassingCfHostname('ch-near-cutoff', 'near-cutoff.example.com'),
    });

    const nowMs = Date.now();
    const eightDaysAgo = new Date(nowMs - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_near_cutoff',
      project_id: project.id,
      hostname: 'near-cutoff.example.com',
      cf_hostname_id: 'ch-near-cutoff',
      status: 'pending',
      created_at: eightDaysAgo,
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-near-cutoff', projectId: project.id }),
    );

    const controller = {
      scheduledTime: nowMs,
      cron: '0 * * * *',
    } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_near_cutoff'));
    expect(row?.status).toBe('active');

    // Decision: The hourly rollover loop may backfill userId, so match only the essential fields.
    const domainRouting = await env.ROUTING.get('domain:near-cutoff.example.com', 'json');
    expect(domainRouting).toMatchObject({
      workerName: 'user-near-cutoff',
      projectId: project.id,
    });
  });

  it('per-domain isolation: first domain CF error does not prevent second domain from activating', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'isolation-project');

    const nowMs = Date.now();
    const fiveMinutesAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();

    await env.db.insert(domains).values({
      id: 'dom_iso_fail',
      project_id: project.id,
      hostname: 'iso-fail.example.com',
      cf_hostname_id: 'ch-iso-fail',
      status: 'pending',
      created_at: fiveMinutesAgo,
    });
    await env.db.insert(domains).values({
      id: 'dom_iso_ok',
      project_id: project.id,
      hostname: 'iso-ok.example.com',
      cf_hostname_id: 'ch-iso-ok',
      status: 'pending',
      created_at: fiveMinutesAgo,
    });

    mockCfApi({
      getCustomHostname: (_url: string) => {
        if (_url.includes('ch-iso-fail')) {
          throw new Error('CF API unavailable');
        }
        return gatePassingCfHostname('ch-iso-ok', 'iso-ok.example.com');
      },
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-isolation-project', projectId: project.id }),
    );

    const controller = {
      scheduledTime: nowMs,
      cron: FAST_CRON,
    } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [failRow] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_iso_fail'));
    expect(failRow?.status).toBe('pending');

    const [okRow] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_iso_ok'));
    expect(okRow?.status).toBe('active');

    const domainRouting = await env.ROUTING.get('domain:iso-ok.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: 'user-isolation-project',
      projectId: project.id,
    });
  });

  it('does NOT activate a domain owned by an ADMIN-suspended account', async () => {
    const user = await createTestUser(env.db);
    await env.db
      .update(users)
      .set({ suspended_reason: 'tos_violation' })
      .where(eq(users.id, user.id));
    const project = await createTestProject(env.db, user.id, 'admin-suspended-skip');
    mockCfApi({
      getCustomHostname: () =>
        gatePassingCfHostname('ch-admin-suspended', 'admin-suspended.example.com'),
    });

    const nowMs = Date.now();
    const fiveMinutesAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_admin_suspended',
      project_id: project.id,
      hostname: 'admin-suspended.example.com',
      cf_hostname_id: 'ch-admin-suspended',
      status: 'pending',
      created_at: fiveMinutesAgo,
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-admin-suspended-skip', projectId: project.id }),
    );

    for (const cron of [FAST_CRON, '0 * * * *']) {
      const controller = { scheduledTime: nowMs, cron } as ScheduledController;
      await scheduled(controller, makeBindings(env), mockCtx);
    }

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_admin_suspended'));
    expect(row?.status).toBe('pending');
    expect(await env.ROUTING.get('domain:admin-suspended.example.com')).toBeNull();
  });

  it('CONTROL: still activates a domain owned by a USAGE-suspended account', async () => {
    const user = await createTestUser(env.db);
    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, user.id));
    const project = await createTestProject(env.db, user.id, 'usage-suspended-activate');
    mockCfApi({
      getCustomHostname: () =>
        gatePassingCfHostname('ch-usage-suspended', 'usage-suspended.example.com'),
    });

    const nowMs = Date.now();
    const fiveMinutesAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_usage_suspended',
      project_id: project.id,
      hostname: 'usage-suspended.example.com',
      cf_hostname_id: 'ch-usage-suspended',
      status: 'pending',
      created_at: fiveMinutesAgo,
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-usage-suspended-activate', projectId: project.id }),
    );

    const controller = { scheduledTime: nowMs, cron: FAST_CRON } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_usage_suspended'));
    expect(row?.status).toBe('active');
    const domainRouting = await env.ROUTING.get('domain:usage-suspended.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: 'user-usage-suspended-activate',
      projectId: project.id,
    });
  });

  it('tryActivateDomain activates a genuinely-pending gate-passing domain (positive control)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'claim-first-positive');
    mockCfApi({
      getCustomHostname: () => gatePassingCfHostname('ch-positive', 'positive.example.com'),
    });

    await env.db.insert(domains).values({
      id: 'dom_race_positive',
      project_id: project.id,
      hostname: 'positive.example.com',
      cf_hostname_id: 'ch-positive',
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-claim-first-positive', projectId: project.id }),
    );

    const [pendingRow] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.id, 'dom_race_positive'));
    const result = await tryActivateDomain(
      makeBindings(env),
      env.db,
      pendingRow,
      project as unknown as Project,
    );

    expect(result.activated).toBe(true);
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_race_positive'));
    expect(row?.status).toBe('active');
    const domainRouting = await env.ROUTING.get('domain:positive.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: 'user-claim-first-positive',
      projectId: project.id,
    });
  });

  it('getPendingDomains(limit) returns exactly `limit` rows oldest-first', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'limit-ordering');

    const baseMs = Date.now() - 10 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) {
      await env.db.insert(domains).values({
        id: `dom_limit_${i}`,
        project_id: project.id,
        hostname: `limit-${i}.example.com`,
        cf_hostname_id: `ch-limit-${i}`,
        status: 'pending',
        created_at: new Date(baseMs + i * 60 * 1000).toISOString(),
      });
    }

    const got = await getPendingDomains(env.db, 3);
    expect(got.length).toBe(3);
    expect(got.map((d) => d.id)).toEqual(['dom_limit_0', 'dom_limit_1', 'dom_limit_2']);

    const cutoff = new Date(baseMs - 60 * 60 * 1000).toISOString();
    const young = await getPendingDomainsNewerThan(env.db, cutoff, 2);
    expect(young.length).toBe(2);
    expect(young.map((d) => d.id)).toEqual(['dom_limit_0', 'dom_limit_1']);
  });

  it('getPendingDomainsOlderThan(cutoff, limit) returns exactly `limit` rows oldest-first', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stale-limit-ordering');

    const N = 5;
    const baseMs = Date.now() - 20 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < N; i++) {
      await env.db.insert(domains).values({
        id: `dom_stale_limit_${i}`,
        project_id: project.id,
        hostname: `stale-limit-${i}.example.com`,
        cf_hostname_id: `ch-stale-limit-${i}`,
        status: 'pending',
        created_at: new Date(baseMs + i * 60 * 1000).toISOString(),
      });
    }

    const cutoff = new Date(baseMs + N * 60 * 1000).toISOString();

    const k = 3;
    const got = await getPendingDomainsOlderThan(env.db, cutoff, k);
    expect(got.length).toBe(k);
    expect(got.map((d) => d.id)).toEqual([
      'dom_stale_limit_0',
      'dom_stale_limit_1',
      'dom_stale_limit_2',
    ]);
  });
});
