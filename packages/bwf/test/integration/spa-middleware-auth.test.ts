import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
} from '../../../../test/integration-helpers.ts';
import type { IsolatedPlayground } from '../../../../test/integration-helpers.ts';
import { isGeneratedAssetHeaders } from '../../src/asset-worker-bypass.ts';
import { renderBwfConfig } from '../../src/config-write.ts';
import { readConfig } from '../../src/config.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SOURCE_PLAYGROUND = 'playground/spa';
let playground: IsolatedPlayground;
let authMiddleware = '';
let documentRoute = '';
let middlewareDir = '';
let middlewareBackupDir = '';
let publicDir = '';
let protectedAsset = '';
let edgeHeaderAsset = '';
let edgeRedirectAsset = '';
let bwfConfig = '';
let dist = '';
const AUTH_HEADER = 'Basic Z3Vlc3Q6d2VkZGluZw==';

const middlewareSource = `import { basicAuth } from '@builtbyfriends/bwf';

export default basicAuth({
  username: 'guest',
  password: 'wedding',
  realm: 'Preview',
});
`;

const documentRouteSource = `export const GET = () =>
  new Response('document route response', {
    headers: { 'Content-Type': 'text/plain' },
  });
`;

const staleCloudflareAssets = {
  binding: 'ASSETS',
  not_found_handling: 'none',
  run_worker_first: ['/', '/*.html'],
} as const;

let child: ReturnType<typeof spawn> | undefined;
let previousBwfConfig: string | undefined;
let middlewareBackedUp = false;
let publicDirCreated = false;

function saveBwfConfig(): void {
  previousBwfConfig = readFileSync(bwfConfig, 'utf8');
}

function writeStaleCloudflareConfig(): void {
  const config = readConfig(playground.root);
  writeFileSync(
    bwfConfig,
    renderBwfConfig({
      ...config,
      cloudflare: {
        ...config.cloudflare,
        assets: {
          ...staleCloudflareAssets,
          run_worker_first: [...staleCloudflareAssets.run_worker_first],
        },
      },
    }),
  );
}

function restoreBwfConfig(): void {
  if (previousBwfConfig !== undefined) {
    writeFileSync(bwfConfig, previousBwfConfig);
    previousBwfConfig = undefined;
  }
}

function disableMiddlewareDir(): void {
  rmSync(middlewareBackupDir, { recursive: true, force: true });
  if (existsSync(middlewareDir)) {
    renameSync(middlewareDir, middlewareBackupDir);
    middlewareBackedUp = true;
  }
}

function restoreMiddlewareDir(): void {
  if (!middlewareBackedUp) {
    return;
  }
  rmSync(middlewareDir, { recursive: true, force: true });
  if (existsSync(middlewareBackupDir)) {
    renameSync(middlewareBackupDir, middlewareDir);
  }
  middlewareBackedUp = false;
}

function writeProtectedAsset(): void {
  if (!existsSync(publicDir)) {
    mkdirSync(publicDir);
    publicDirCreated = true;
  }
  writeFileSync(protectedAsset, 'protected static asset');
}

async function startSpaDevServer(): Promise<string> {
  const server = await startServer((port) => {
    child = spawn('vp', ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: playground.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BWF_INSPECTOR_PORT: 'false',
      },
    });
    return child;
  }, 30_000);
  return server.base;
}

async function startSpaPreviewServer(): Promise<string> {
  const server = await startServer((port) => {
    child = spawn(
      'vp',
      ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
        cwd: playground.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, BWF_INSPECTOR_PORT: 'false' },
      },
    );
    return child;
  }, 30_000);
  return server.base;
}

function readBuiltAssetConfig(): {
  not_found_handling?: string;
  run_worker_first?: boolean | Array<string>;
} {
  const emittedWrangler = JSON.parse(readFileSync(join(dist, 'ssr/wrangler.json'), 'utf8')) as {
    assets?: {
      not_found_handling?: string;
      run_worker_first?: boolean | Array<string>;
    };
  };
  return emittedWrangler.assets ?? {};
}

function expectNoGeneratedAssetHeaders(): void {
  const headers = join(dist, 'client/_headers');
  if (existsSync(headers)) {
    expect(isGeneratedAssetHeaders(readFileSync(headers, 'utf8'))).toBe(false);
  }
}

beforeAll(() => {
  playground = createIsolatedPlayground(ROOT, SOURCE_PLAYGROUND);
  authMiddleware = join(playground.root, 'middleware/00.basic-auth-regression.ts');
  documentRoute = join(playground.root, 'routes/dashboard.ts');
  middlewareDir = join(playground.root, 'middleware');
  middlewareBackupDir = join(playground.root, `.middleware.e2e-backup-${process.pid}`);
  publicDir = join(playground.root, 'public');
  protectedAsset = join(publicDir, 'platform-basic-auth-regression.txt');
  edgeHeaderAsset = join(publicDir, 'platform-native-header-regression.txt');
  edgeRedirectAsset = join(publicDir, 'platform-native-redirect-regression.txt');
  bwfConfig = join(playground.root, 'bwf.config.ts');
  dist = join(playground.root, 'dist');
});

afterAll(() => {
  playground?.cleanup();
});

afterEach(async () => {
  if (child) {
    await killChild(child);
    child = undefined;
  }
  rmSync(documentRoute, { force: true });
  restoreMiddlewareDir();
  rmSync(authMiddleware, { force: true });
  rmSync(protectedAsset, { force: true });
  rmSync(edgeHeaderAsset, { force: true });
  rmSync(edgeRedirectAsset, { force: true });
  if (publicDirCreated) {
    rmSync(publicDir, { recursive: true, force: true });
    publicDirCreated = false;
  }
  restoreBwfConfig();
});

describe('SPA asset routing policy', () => {
  it('keeps API-only projects on static SPA fallback while routing API requests to the worker', () => {
    saveBwfConfig();
    disableMiddlewareDir();
    writeStaleCloudflareConfig();
    rmSync(dist, { recursive: true, force: true });

    execSync('vp build', { cwd: playground.root, stdio: 'pipe' });

    const assetConfig = readBuiltAssetConfig();
    expect(assetConfig.not_found_handling).toBe('single-page-application');
    expect(assetConfig.run_worker_first).toEqual([
      '/api',
      '/api/*',
      '/__platform',
      '/__platform/*',
    ]);
    expectNoGeneratedAssetHeaders();
  });

  it('applies native production routing rules before existing static assets', async () => {
    saveBwfConfig();
    disableMiddlewareDir();
    writeStaleCloudflareConfig();
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(edgeHeaderAsset, 'header asset');
    writeFileSync(edgeRedirectAsset, 'redirect asset must not win');
    const config = readConfig(playground.root);
    const routing = {
      headers: {
        '/platform-native-header-regression.txt': ['X-Platform-Native-Rule: applied'],
      },
      redirects: {
        '/platform-native-redirect-regression.txt': {
          to: '/redirect-target',
          status: 302 as const,
        },
      },
    };
    writeFileSync(bwfConfig, renderBwfConfig({ ...config, routing }));
    rmSync(dist, { recursive: true, force: true });
    const buildEnv = { ...process.env };
    delete buildEnv.PLATFORM_DEPLOY_PROJECT_ID;
    delete buildEnv.BWF_DEPLOY_BUILD;
    execSync('vp build', {
      cwd: playground.root,
      stdio: 'pipe',
      env: buildEnv,
    });

    expect(readBuiltAssetConfig().run_worker_first).toEqual(['/**']);
    expectNoGeneratedAssetHeaders();
    const base = await startSpaPreviewServer();
    const headerResponse = await fetch(`${base}/platform-native-header-regression.txt`);
    expect(headerResponse.status).toBe(200);
    expect(await headerResponse.text()).toBe('header asset');
    expect(headerResponse.headers.get('x-platform-native-rule')).toBe('applied');

    const redirectResponse = await fetch(`${base}/platform-native-redirect-regression.txt`, {
      redirect: 'manual',
    });
    expect(redirectResponse.status).toBe(302);
    expect(redirectResponse.headers.get('location')).toContain('/redirect-target');
    expect(await redirectResponse.text()).not.toContain('redirect asset must not win');
  });

  it('routes document routes through the worker before SPA fallback HTML', async () => {
    saveBwfConfig();
    disableMiddlewareDir();
    writeStaleCloudflareConfig();
    writeFileSync(documentRoute, documentRouteSource);

    const base = await startSpaDevServer();
    const response = await fetch(`${base}/dashboard`, {
      headers: { Accept: 'text/html' },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('document route response');
  });

  it('runs middleware before serving SPA fallback HTML on nested navigations', async () => {
    saveBwfConfig();
    writeFileSync(authMiddleware, middlewareSource);
    writeStaleCloudflareConfig();
    writeProtectedAsset();

    const base = await startSpaDevServer();
    const unauthenticatedAsset = await fetch(`${base}/platform-basic-auth-regression.txt`);
    expect(unauthenticatedAsset.status).toBe(401);
    expect(await unauthenticatedAsset.text()).toBe('Authentication required');

    const authenticatedAsset = await fetch(`${base}/platform-basic-auth-regression.txt`, {
      headers: { Authorization: AUTH_HEADER },
    });
    expect(authenticatedAsset.status).toBe(200);
    expect(await authenticatedAsset.text()).toBe('protected static asset');

    const unauthenticated = await fetch(`${base}/nested/spa/path`, {
      headers: { Accept: 'text/html' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe(
      'Basic realm="Preview", charset="UTF-8"',
    );
    expect(await unauthenticated.text()).toBe('Authentication required');

    const authenticated = await fetch(`${base}/nested/spa/path`, {
      headers: {
        Accept: 'text/html',
        Authorization: AUTH_HEADER,
      },
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get('content-type')).toContain('text/html');
    expect(await authenticated.text()).toContain('<title>Vite Cloud Playground</title>');
  });
});
