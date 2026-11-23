import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
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
import { createIsolatedPlayground } from '../../../../test/integration-helpers.ts';
import type { IsolatedPlayground } from '../../../../test/integration-helpers.ts';
import type { ProjectRole } from '../../src/cli/client.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

const noopSpinner = {
  start: vi.fn(),
  stop: vi.fn(),
  message: vi.fn(),
  clear: vi.fn(),
};
vi.mock('@voidzero-dev/vite-plus-prompts', async () => {
  const actual = await vi.importActual<typeof import('@voidzero-dev/vite-plus-prompts')>(
    '@voidzero-dev/vite-plus-prompts',
  );
  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
    },
    spinner: () => noopSpinner,
  };
});
vi.mock('../../src/cli/output.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/cli/output.ts')>('../../src/cli/output.ts');
  return { ...actual, createSpinner: () => noopSpinner };
});

const { runDeploy } = await import('../../src/cli/deploy.ts');

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SOURCE_PLAYGROUND = 'playground/spa';
let playground: IsolatedPlayground;
let fixture = '';
let projectJson = '';

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;
let savedToken: string | undefined;
let savedProject: string | undefined;

type Captured = {
  finalizeBody: {
    manifest?: {
      alwaysUseHttps?: boolean;
      bindings?: Record<string, unknown>;
      vars?: Record<string, string>;
    };
  } | null;
};

// Decision: Every asset is reported as present, so the deploy skips uploads and goes straight to finalize.
function installPlatformMocks(role: ProjectRole = 'owner'): Captured {
  const captured: Captured = { finalizeBody: null };

  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const reqInit = init ?? {};
    const method = (reqInit.method ?? 'GET').toUpperCase();

    const rpcInput =
      typeof reqInit.body === 'string' && reqInit.body ? JSON.parse(reqInit.body) : {};
    const procedure = method === 'POST' ? /\/rpc\/([\w.]+)$/.exec(url)?.[1] : undefined;

    if (procedure === 'projects.resolve' && rpcInput.slug === 'named-layouts-test') {
      return json({ data: { project: null } });
    }
    if (
      (procedure === 'projects.get' && rpcInput.projectId === 'proj_named_layouts_test') ||
      procedure === 'projects.create'
    ) {
      const project = {
        id: 'proj_named_layouts_test',
        user_id: 'user_owner',
        slug: 'named-layouts-test',
        type: 'worker',
        created_at: '2026-09-01T00:00:00.000Z',
        custom_domain: null,
        role,
        owner: { id: 'user_owner', login: 'owner' },
      };
      return json({ data: project });
    }

    if (procedure === 'deploy.preflight') {
      const total = Object.keys(rpcInput.assetManifest ?? {}).length;
      return json({ data: { needed: [], total, skipped: total } });
    }

    if (procedure === 'deploy.finalize') {
      captured.finalizeBody = rpcInput.body;
      return json({
        data: {
          deploymentId: 'dep_test',
          events: [
            {
              event: 'done',
              deployment: 'dep_test',
              url: 'https://named-layouts.test.void.app',
              urls: ['https://named-layouts.test.void.app'],
              assets: 0,
              workers: 1,
            },
          ],
        },
      });
    }

    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  });

  return captured;
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('managed deployment manifests (built Worker)', () => {
  beforeAll(() => {
    playground = createIsolatedPlayground(ROOT, SOURCE_PLAYGROUND);
    fixture = playground.root;
    projectJson = join(fixture, '.bwf', 'project.json');

    const result = spawn.sync('vp', ['build'], {
      cwd: fixture,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, BWF_TOKEN: 'test-token-do-not-use' },
    });
    expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);

    mkdirSync(join(fixture, '.bwf'), { recursive: true });
    writeFileSync(
      projectJson,
      JSON.stringify({
        projectId: 'proj_named_layouts_test',
        slug: 'named-layouts-test',
        platformUrl: 'https://platform.example.test',
      }),
    );
  }, 180_000);

  afterAll(() => {
    playground?.cleanup();
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = withPlatformDiscovery(fetchMock);
    fetchMock.mockReset();

    savedToken = process.env.BWF_TOKEN;
    savedProject = process.env.BWF_PROJECT;
    // Decision: Explicit token bypasses getToken() + the GitHub-Actions OIDC branch.
    process.env.BWF_TOKEN = 'test-token-do-not-use';
    vi.stubEnv('BWF_API_URL', 'https://platform.example.test');
    vi.stubEnv('PLATFORM_REGISTRY_DIR', join(fixture, 'registry'));
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      displayName: 'Test platform',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.example.test',
    });
    // Decision: Select the saved project; runDeploy verifies its current role through the API.
    delete process.env.BWF_PROJECT;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    if (savedToken === undefined) {
      delete process.env.BWF_TOKEN;
    } else {
      process.env.BWF_TOKEN = savedToken;
    }
    if (savedProject === undefined) {
      delete process.env.BWF_PROJECT;
    } else {
      process.env.BWF_PROJECT = savedProject;
    }
  });

  it('sends custom inference.bindings names in the manifest bindings', async () => {
    const configPath = join(fixture, 'bwf.config.ts');
    const original = readFileSync(configPath, 'utf8');
    writeFileSync(
      configPath,
      original.replace(
        'export default defineConfig({',
        "export default defineConfig({\n  inference: { bindings: { kv: 'MY_KV', storage: 'MY_BUCKET' } },",
      ),
    );
    try {
      const captured = installPlatformMocks();

      await runDeploy(fixture, { skipBuild: true });

      expect(captured.finalizeBody?.manifest?.bindings).toMatchObject({
        kv: ['MY_KV'],
        r2: ['MY_BUCKET'],
      });
    } finally {
      writeFileSync(configPath, original);
    }
  });

  it.each([true, false])(
    'includes configured worker.vars and HTTPS policy %s in the deployment request',
    async (alwaysUseHttps) => {
      const configPath = join(fixture, 'bwf.config.ts');
      const original = readFileSync(configPath, 'utf8');
      const dotenvPath = join(fixture, '.env');
      const originalDotenv = existsSync(dotenvPath) ? readFileSync(dotenvPath) : undefined;
      const vars = { API_URL: 'https://api.example.test', EMPTY_SETTING: '' };
      writeFileSync(
        configPath,
        original
          .replace('worker: {', `worker: { vars: ${JSON.stringify(vars)},`)
          .replace('worker: {', `routing: { alwaysUseHttps: ${alwaysUseHttps} },\n  worker: {`),
      );
      writeFileSync(dotenvPath, 'API_URL=https://local.example.test\nADMIN_TOKEN=local-secret\n');
      try {
        const captured = installPlatformMocks();
        await runDeploy(fixture, { skipBuild: true });
        expect(captured.finalizeBody?.manifest?.vars).toEqual(vars);
        expect(captured.finalizeBody?.manifest?.alwaysUseHttps).toBe(alwaysUseHttps);
      } finally {
        writeFileSync(configPath, original);
        if (originalDotenv === undefined) {
          rmSync(dotenvPath, { force: true });
        } else {
          writeFileSync(dotenvPath, originalDotenv);
        }
      }
    },
  );

  it('uses the alternate project for Worker packaging while retaining the saved link', async () => {
    const original = readFileSync(projectJson, 'utf8');
    const saved = JSON.stringify({
      projectId: 'project-on-original-platform',
      slug: 'named-layouts-test',
      platformUrl: 'https://original.example.test',
      platform: 'platform',
    });
    writeFileSync(projectJson, saved);
    try {
      const captured = installPlatformMocks();
      await runDeploy(fixture, { projectSlug: 'named-layouts-test', skipBuild: true });
      expect(readFileSync(projectJson, 'utf8')).toBe(saved);
      expect(captured.finalizeBody?.manifest).toBeDefined();
      const calls = fetchMock.mock.calls.map(([url, init]) => ({
        url: String(url),
        body: typeof init?.body === 'string' ? init.body : '',
      }));
      expect(calls.every(({ url }) => url.startsWith('https://platform.example.test/'))).toBe(true);
      // Decision: Project IDs travel in the RPC input, so check the bodies for the saved one.
      expect(calls.some(({ body }) => body.includes('project-on-original-platform'))).toBe(false);
      const finalize = calls.find(({ url }) => url.endsWith('/rpc/deploy.finalize'));
      expect(JSON.parse(finalize?.body ?? '{}').projectId).toBe('proj_named_layouts_test');
    } finally {
      writeFileSync(projectJson, original);
    }
  });

  it('rejects a saved reader project before building or uploading', async () => {
    const captured = installPlatformMocks('reader');

    // Decision: Do not skip the build: access must be checked before a build path is selected,
    // regardless of the fixture's existing artifacts.
    await expect(runDeploy(fixture)).rejects.toThrow(
      'You have reader access to "named-layouts-test" and cannot deploy.',
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/rpc\/projects\.get$/);
    expect(JSON.parse(init.body as string)).toEqual({ projectId: 'proj_named_layouts_test' });
    expect(captured.finalizeBody).toBeNull();
  });
});
