import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'vite';
import type { Manifest } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  renderCloudflareStaticEntry,
  stageCloudflareStaticAssets,
} from '../../../deploy-cloudflare/src/index.ts';
import { analyzeApplicationSync } from '../../src/application-analysis.ts';
import {
  GENERATED_ASSET_HEADERS_MARKER,
  resolveAssetWorkerBypass,
} from '../../src/asset-worker-bypass.ts';
import type { AssetWorkerBypassFacts } from '../../src/asset-worker-bypass.ts';
import { planStaticEdgeRouting } from '../../src/cli/deploy-cloudflare-static.ts';
import type { StaticEdgeRouting } from '../../src/cli/deploy-cloudflare-static.ts';
import type { RoutingConfig } from '../../src/config.ts';
import { routingPlugin } from '../../src/plugin-routing.ts';

const runtimeSource = (file: string) => join(import.meta.dirname, '../../src/runtime', file);

function bypassFacts(overrides: Partial<AssetWorkerBypassFacts>): AssetWorkerBypassFacts {
  return {
    runWorkerFirst: ['/**'],
    notFoundHandling: 'none',
    base: '/',
    hasMiddleware: false,
    authEnabled: false,
    headerRuleCount: 0,
    redirectRuleCount: 0,
    fallbackRuleCount: 0,
    publicEdgeFiles: false,
    patterns: ['/'],
    assetsDir: 'assets',
    immutableFiles: [],
    ...overrides,
  };
}
let directory: string;
let runtime: Miniflare | undefined;
let clientAsset: string;
let cssAsset: string;
let privateAsset: string;
let customAsset: string;
let uncachedAsset: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'platform-native-asset-policy-'));
  const assets = join(directory, 'client');
  const output = join(directory, 'output');
  const clientRoot = join(directory, 'app');
  const routingOptions = {
    getApplicationAnalysis: (environment: 'dev' | 'prod') =>
      analyzeApplicationSync(clientRoot, { config: {}, environment }),
    isAuthEnabled: () => false,
  };
  mkdirSync(clientRoot);
  writeFileSync(join(clientRoot, 'package.json'), '{"type":"module"}');
  writeFileSync(join(clientRoot, 'client.js'), 'import "./client.css"; window.value = 1;');
  writeFileSync(join(clientRoot, 'client.css'), 'body { color: red; }');
  for (const file of ['private', 'custom', 'uncached', 'app-settings']) {
    writeFileSync(join(clientRoot, `${file}.js`), `window.${file.replace('-', '_')} = 1;`);
  }
  mkdirSync(join(clientRoot, 'public'));
  writeFileSync(
    join(clientRoot, 'public/_headers'),
    '/static/uncached-*\n  Cache-Control: public, max-age=0, must-revalidate\n',
  );
  await build({
    root: clientRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      routingPlugin(clientRoot, routingOptions),
      {
        name: 'explicit-stable-css',
        buildStart() {
          this.emitFile({
            type: 'asset',
            name: 'app.css',
            originalFileName: 'app.css',
            fileName: 'static/app-settings.css',
            source: '.settings { color: blue; }',
          });
        },
      },
    ],
    build: {
      outDir: assets,
      emptyOutDir: true,
      assetsDir: 'static',
      rollupOptions: {
        input: Object.fromEntries(
          ['client', 'private', 'custom', 'uncached', 'app-settings'].map((name) => [
            name,
            join(clientRoot, `${name}.js`),
          ]),
        ),
        output: {
          entryFileNames: (chunk) =>
            chunk.name === 'app-settings' ? 'static/app-settings.js' : 'static/[name]-[hash].js',
          assetFileNames: 'static/[name]-[hash].[ext]',
        },
      },
    },
  });
  const manifest = JSON.parse(readFileSync(join(assets, '.vite/manifest.json'), 'utf8'));
  clientAsset = manifest['client.js'].file;
  cssAsset = manifest['client.js'].css[0];
  privateAsset = manifest['private.js'].file;
  customAsset = manifest['custom.js'].file;
  uncachedAsset = manifest['uncached.js'].file;
  expect(manifest['uncached.js']).not.toHaveProperty('immutableFiles');
  expect(manifest['client.js'].immutableFiles).toEqual([clientAsset]);
  expect(manifest['app.css'].file).toBe('static/app-settings.css');
  expect(manifest['app.css']).not.toHaveProperty('immutableFiles');
  expect(manifest['app-settings.js'].file).toBe('static/app-settings.js');
  expect(manifest['app-settings.js']).not.toHaveProperty('immutableFiles');
  const stableOutput = join(directory, 'stable-client');
  await build({
    root: clientRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [routingPlugin(clientRoot, routingOptions)],
    build: {
      outDir: stableOutput,
      assetsDir: 'static',
      rollupOptions: {
        input: join(clientRoot, 'client.js'),
        output: {
          entryFileNames: 'static/[name]-settings.js',
          assetFileNames: 'static/[name]-settings.[ext]',
        },
      },
    },
  });
  const stableManifest = JSON.parse(
    readFileSync(join(stableOutput, '.vite/manifest.json'), 'utf8'),
  ) as Manifest;
  // Decision: A single-input build can use a synthetic manifest key. Verify the emitted
  // entry and its stable filenames rather than assuming its source-path key.
  const stableEntries = Object.values(stableManifest).filter((entry) => entry.isEntry);
  expect(stableEntries).toHaveLength(1);
  const [stableEntry] = stableEntries;
  expect(stableEntry).toMatchObject({
    file: 'static/client-settings.js',
    css: ['static/client-settings.css'],
  });
  expect(stableEntry).not.toHaveProperty('immutableFiles');
  for (const file of [stableEntry.file, ...stableEntry.css!]) {
    writeFileSync(join(assets, file), readFileSync(join(stableOutput, file)));
  }
  writeFileSync(
    join(assets, '.vite/manifest.json'),
    JSON.stringify({ ...manifest, stable: stableEntry }),
  );
  mkdirSync(join(assets, 'api'));
  writeFileSync(join(assets, 'api/data.json'), '{"static":"api"}');
  mkdirSync(join(assets, 'api/files'));
  writeFileSync(join(assets, 'api/files/open.json'), '{"static":"api miss"}');
  writeFileSync(join(assets, 'api/files/hidden.json'), '{"static":"hidden"}');
  writeFileSync(join(assets, 'api/files/probe.json'), '{"static":"probe"}');
  writeFileSync(join(assets, 'api/files/clone.json'), '{"static":"clone"}');
  writeFileSync(join(assets, 'api/files/compressed.json'), '{"static":"compressed"}');
  writeFileSync(join(assets, 'api/files/clone-original.json'), '{"static":"clone original"}');
  writeFileSync(join(assets, 'api/files/pipe.json'), '{"static":"pipe"}');
  writeFileSync(join(assets, 'rewrite-miss'), 'rewrite asset');
  mkdirSync(join(assets, 'files'));
  writeFileSync(join(assets, 'files/open.json'), '{"static":"open"}');
  mkdirSync(join(assets, 'static'), { recursive: true });
  for (const file of ['app-settings.json', 'client.js', 'page-abcdefgh.html']) {
    writeFileSync(
      join(assets, 'static', file),
      file.endsWith('.html') ? '<html>asset</html>' : 'export const value = 1;',
    );
  }
  writeFileSync(
    join(assets, '_headers'),
    `/${privateAsset}\n  Cache-Control: private, no-store\n/${customAsset}\n  Cache-Control: public, max-age=120\n/${uncachedAsset}\n  Cache-Control: public, max-age=0, must-revalidate\n`,
  );
  const entry = join(directory, 'worker.ts');
  writeFileSync(
    entry,
    `
    import { Hono } from ${JSON.stringify(fileURLToPath(import.meta.resolve('hono')))};
    import { compress } from ${JSON.stringify(fileURLToPath(import.meta.resolve('hono/compress')))};
    import { applyAssetCachePolicy, createAssetFallback } from ${JSON.stringify(runtimeSource('routing-worker.ts'))};
    import { createAssetNotFound, createRoutingRuntime } from ${JSON.stringify(runtimeSource('routing.ts'))};
    const apps = {};
    for (const mode of ['app', 'static', 'headers', 'compressed']) {
      const routes = mode === 'app' || mode === 'compressed';
      const app = new Hono();
      const routing = createRoutingRuntime(app, {});
      app.use(routing.contextMiddleware);
      if (mode === 'headers') {
        app.use(routing.headerMiddleware([{ pattern: '/static/*', headers: [
          ['Cache-Control', 'public, max-age=31536000, immutable'],
          ['X-Platform-Header', 'configured'],
        ] }]));
        app.get('/health', (c) => c.text('healthy', 200, { 'cache-control': 'private, no-store' }));
      }
      app.notFound(routing.trackNotFound(createAssetNotFound({ routing, assetsDir: 'static' })));
      if (routes) {
        if (mode === 'compressed') app.use(compress());
        app.use('/api/files/clone-original.json', async (c, next) => {
          await next();
          await c.res.clone().arrayBuffer();
        });
        app.use('/api/files/pipe.json', async (c, next) => {
          await next();
          if (c.res.body) c.res = new Response(c.res.body.pipeThrough(new TransformStream()), c.res);
        });
        app.use('/rewrite-miss', async (c, next) => {
          c.res.headers.set('X-Previous-Header', 'present');
          await next();
          c.header('X-Route-Probe', 'configured');
        });
        app.get('/rewrite-miss', (c) => c.rewrite('/api/no-route/missing'));
        app.use('/api/files/clone.json', async (c, next) => {
          await next();
          c.header('X-Route-Probe', 'configured');
          c.res = c.res.clone();
        });
        app.use('/api/files/probe.json', async (c, next) => {
          await c.rewrite('/api/probe');
          await next();
        });
        app.use('/api/files/hidden.json', async (c, next) => {
          await next();
          if (c.res.status === 404) {
            c.res = c.text('Hidden', 404);
          }
        });
        app.get('/api/:name', (c) => c.json({ error: 'missing' }, 404));
      }
      apps[mode] = app;
    }
    const outer = createAssetFallback({ assetsDir: 'static' });
    export default { async fetch(request, env, context) {
      const url = new URL(request.url);
      if (url.pathname === '/cache-proof') {
        const key = new Request('https://cache.test/static/client-abcdefgh.js');
        await caches.default.put(key, new Response(new Uint8Array([1, 2, 3]), { headers: { 'cache-control': 'public, max-age=600' } }));
        const original = await caches.default.match(key);
        let immutable = false;
        try { original.headers.set('x-immutable-probe', '1'); } catch { immutable = true; }
        const result = applyAssetCachePolicy(key, original, 'static');
        return Response.json({ immutable, originalContentType: original.headers.get('content-type'), resultContentType: result.headers.get('content-type'), originalPolicy: original.headers.get('cache-control'), resultPolicy: result.headers.get('cache-control'), body: [...new Uint8Array(await result.arrayBuffer())] });
      }
      const mode = url.searchParams.get('mode') ?? 'app';
      if (mode === 'native' || mode === 'compressed') {
        return outer(request, env, await apps[mode === 'native' ? 'app' : mode].fetch(request, env, context));
      }
      return mode === 'outer'
        ? outer(request, env, new Response('not found', { status: 404 }))
        : apps[mode].fetch(request, env, context);
    }};
  `,
  );
  await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    build: {
      outDir: output,
      emptyOutDir: true,
      ssr: entry,
      target: 'esnext',
      rollupOptions: {
        external: [/^cloudflare:/, /^node:/],
        output: { entryFileNames: 'worker.mjs', codeSplitting: false },
      },
    },
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: '2026-07-01',
      compatibilityFlags: ['nodejs_compat'],
      modules: true,
      modulesRoot: output,
      scriptPath: join(output, 'worker.mjs'),
      assets: {
        directory: assets,
        binding: 'ASSETS',
        run_worker_first: true,
        routerConfig: { has_user_worker: true },
        assetConfig: {
          html_handling: 'none',
          not_found_handling: 'none',
        },
      },
    }),
  );
});

afterAll(async () => {
  await runtime?.dispose();
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('native asset cache policy in real Workers', () => {
  it.each(['app', 'static', 'outer'])(
    'normalizes successful native ASSETS responses in %s',
    async (mode) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await runtime!.dispatchFetch(
          `https://app.test/${clientAsset}?mode=${mode}`,
        );
        expect(response.status, response.status === 200 ? undefined : await response.text()).toBe(
          200,
        );
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(response.headers.get('content-type')).toContain('javascript');
        expect(await response.text()).toContain('value');
      }
      const css = await runtime!.dispatchFetch(`https://app.test/${cssAsset}?mode=${mode}`);
      expect(css.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
      expect(await css.text()).toContain('color');
    },
  );

  it.each(['app', 'static', 'outer'])(
    'preserves authored privacy, unhashed/HTML defaults and missing files in %s',
    async (mode) => {
      for (const [file, policy] of [
        [privateAsset, 'private, no-store'],
        [customAsset, 'public, max-age=120'],
        [uncachedAsset, 'public, max-age=0, must-revalidate'],
        ['static/app-settings.json', 'public, max-age=0, must-revalidate'],
        ['static/app-settings.js', 'public, max-age=0, must-revalidate'],
        ['static/app-settings.css', 'public, max-age=0, must-revalidate'],
        ['static/client-settings.js', 'public, max-age=0, must-revalidate'],
        ['static/client-settings.css', 'public, max-age=0, must-revalidate'],
        ['static/client.js', 'public, max-age=0, must-revalidate'],
        ['static/page-abcdefgh.html', 'public, max-age=0, must-revalidate'],
      ]) {
        const response = await runtime!.dispatchFetch(`https://app.test/${file}?mode=${mode}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe(policy);
      }
      const missing = await runtime!.dispatchFetch(
        `https://app.test/static/missing-abcdefgh.js?mode=${mode}`,
      );
      expect(missing.status).toBe(404);
      expect(missing.headers.get('cache-control') ?? '').not.toContain('immutable');
    },
  );

  it.each(['css', 'javascript'])(
    'overrides an existing ASSETS cache policy for %s',
    async (kind) => {
      const file = kind === 'css' ? cssAsset : uncachedAsset;
      const response = await runtime!.dispatchFetch(`https://app.test/${file}?mode=headers`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(response.headers.get('x-platform-header')).toBe('configured');
      expect(response.headers.get('content-type')).toContain(
        kind === 'css' ? 'text/css' : 'javascript',
      );
      expect(await response.text()).toContain(kind === 'css' ? 'color' : 'uncached');
    },
  );

  it('applies matching headers to real asset misses and preserves unmatched responses', async () => {
    const missing = await runtime!.dispatchFetch(
      'https://app.test/static/missing-abcdefgh.js?mode=headers',
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(missing.headers.get('x-platform-header')).toBe('configured');
    await missing.arrayBuffer();

    const unmatched = await runtime!.dispatchFetch('https://app.test/health?mode=headers');
    expect(unmatched.status).toBe(200);
    expect(unmatched.headers.get('cache-control')).toBe('private, no-store');
    expect(unmatched.headers.has('x-platform-header')).toBe(false);
    await expect(unmatched.text()).resolves.toBe('healthy');
  });

  it('wraps an immutable Cache API response without mutating its headers or consuming its body', async () => {
    const response = await runtime!.dispatchFetch('https://app.test/cache-proof');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      immutable: true,
      originalContentType: null,
      resultContentType: 'text/javascript; charset=utf-8',
      originalPolicy: 'public, max-age=600',
      resultPolicy: 'public, max-age=600',
      body: [1, 2, 3],
    });
  });
});

describe('native asset Worker bypass in real Workers', () => {
  let bypassDirectory: string;
  let bypass: Miniflare | undefined;

  beforeAll(async () => {
    bypassDirectory = mkdtempSync(join(tmpdir(), 'platform-native-asset-bypass-'));
    const assets = join(bypassDirectory, 'client');
    mkdirSync(join(assets, 'static', 'nested'), { recursive: true });
    for (const file of ['client-abcdefgh.js', 'client.js', 'nested/chunk-abcdefgh.js']) {
      writeFileSync(join(assets, 'static', file), 'export const value = 1;');
    }
    const plan = resolveAssetWorkerBypass(
      bypassFacts({
        assetsDir: 'static',
        immutableFiles: ['static/client-abcdefgh.js', 'static/nested/chunk-abcdefgh.js'],
      }),
    )!;
    writeFileSync(join(assets, '_headers'), plan.headers!);
    const runWorkerFirst = plan.runWorkerFirst;
    expect(runWorkerFirst).toEqual([
      '/**',
      '!/static/client-abcdefgh.js',
      '!/static/nested/chunk-abcdefgh.js',
    ]);
    bypass = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-07-01',
        modules: true,
        script: `export default { async fetch(request, env) {
          const asset = await env.ASSETS.fetch(request);
          const response = new Response(asset.body, asset);
          response.headers.set('x-platform-worker', '1');
          return response;
        } };`,
        assets: {
          directory: assets,
          binding: 'ASSETS',
          run_worker_first: runWorkerFirst,
          routerConfig: { has_user_worker: true },
          assetConfig: { html_handling: 'none', not_found_handling: 'none' },
        },
      }),
    );
  });

  afterAll(async () => {
    await bypass?.dispose();
    if (bypassDirectory) {
      rmSync(bypassDirectory, { recursive: true, force: true });
    }
  });

  it('serves listed chunks immutable without starting the Worker, even with cookies', async () => {
    for (const path of ['/static/client-abcdefgh.js', '/static/nested/chunk-abcdefgh.js']) {
      const response = await bypass!.dispatchFetch(`https://app.test${path}`, {
        headers: { cookie: '__Secure-better-auth.session_token=abc; _ga=1' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(response.headers.get('etag')).toBeTruthy();
      expect(response.headers.has('x-platform-worker')).toBe(false);
      await response.arrayBuffer();
    }
  });

  it('sends unlisted files and misses in the assets folder to the Worker', async () => {
    const unlisted = await bypass!.dispatchFetch('https://app.test/static/client.js');
    expect(unlisted.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(unlisted.headers.get('x-platform-worker')).toBe('1');
    await unlisted.arrayBuffer();
    for (const path of ['/static/gone-abcdefgh.js', '/static/42', '/static/']) {
      const missing = await bypass!.dispatchFetch(`https://app.test${path}`);
      expect(missing.status, path).toBe(404);
      expect(missing.headers.get('cache-control') ?? '').not.toContain('immutable');
      expect(missing.headers.get('x-platform-worker'), path).toBe('1');
      await missing.arrayBuffer();
    }
  });

  it('still sends other paths to the Worker', async () => {
    for (const path of ['/', '/api/x', '/static']) {
      const response = await bypass!.dispatchFetch(`https://app.test${path}`);
      expect(response.headers.get('x-platform-worker')).toBe('1');
      await response.arrayBuffer();
    }
  });
});

describe('native static edge Worker routing in real Workers', () => {
  const immutable = 'public, max-age=31536000, immutable';
  let staticDirectory: string;
  let site: Miniflare | undefined;
  let spa: Miniflare | undefined;
  let https: Miniflare | undefined;

  type StaticDeploy = { routing: StaticEdgeRouting; assets: string; output: string };

  async function deployStaticSite(name: string, routing?: RoutingConfig): Promise<StaticDeploy> {
    const root = join(staticDirectory, name);
    const outputDir = join(root, 'dist');
    mkdirSync(join(outputDir, 'assets'), { recursive: true });
    writeFileSync(join(outputDir, 'index.html'), '<h1>Home</h1>');
    writeFileSync(join(outputDir, 'about.html'), '<h1>About</h1>');
    writeFileSync(join(outputDir, '404.html'), '<h1>Not found</h1>');
    writeFileSync(join(outputDir, 'assets/app-abcdefgh.js'), 'export const value = 1;');
    writeFileSync(join(outputDir, 'assets/plain.js'), 'export const value = 2;');
    writeFileSync(
      join(outputDir, '_headers'),
      `${GENERATED_ASSET_HEADERS_MARKER}\n/assets/app-abcdefgh.js\n  Cache-Control: ${immutable}\n`,
    );
    const edgeRouting = planStaticEdgeRouting({
      outputDir,
      appType: 'static',
      routing,
      htmlHandling: undefined,
    });
    const assets = join(root, 'assets');
    stageCloudflareStaticAssets({
      sourceDirectory: outputDir,
      destinationDirectory: assets,
      headers: edgeRouting.assetHeaders,
    });
    writeFileSync(
      join(root, 'static-edge.mjs'),
      renderCloudflareStaticEntry({
        runtimeImport: join(import.meta.dirname, '../../../edge/src/index.ts'),
        ...edgeRouting.entry,
        versionMetadataBinding: 'VERSION',
      }),
    );
    writeFileSync(
      join(root, 'worker.mjs'),
      `import edge from './static-edge.mjs';
      export default { async fetch(request, env, context) {
        const response = await edge.fetch(request, env, context);
        const marked = new Response(response.body, response);
        marked.headers.set('x-platform-worker', '1');
        return marked;
      } };`,
    );
    const output = join(root, 'output');
    await build({
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      build: {
        outDir: output,
        emptyOutDir: true,
        ssr: join(root, 'worker.mjs'),
        target: 'esnext',
        rollupOptions: { output: { entryFileNames: 'worker.mjs', codeSplitting: false } },
      },
    });
    return { routing: edgeRouting, assets, output };
  }

  function startStaticSite(
    deploy: StaticDeploy,
    notFoundHandling: '404-page' | 'single-page-application',
  ): Miniflare {
    return new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-07-01',
        modules: true,
        modulesRoot: deploy.output,
        scriptPath: join(deploy.output, 'worker.mjs'),
        bindings: { VERSION: { id: 'version-1' } },
        assets: {
          directory: deploy.assets,
          binding: 'ASSETS',
          run_worker_first: deploy.routing.assetConfig.run_worker_first,
          routerConfig: { has_user_worker: true },
          assetConfig: {
            html_handling: 'auto-trailing-slash',
            not_found_handling: notFoundHandling,
          },
        },
      }),
    );
  }

  async function expectReadiness(runtime: Miniflare): Promise<void> {
    for (const headers of [{}, { 'sec-fetch-mode': 'navigate' }]) {
      const ready = await runtime.dispatchFetch('https://site.test/__platform/ready', { headers });
      expect(ready.status).toBe(200);
      expect(ready.headers.get('x-platform-worker')).toBe('1');
      expect(ready.headers.get('cache-control')).toBe('no-store');
      await expect(ready.json()).resolves.toEqual({ ready: true, versionId: 'version-1' });
    }
  }

  beforeAll(async () => {
    staticDirectory = mkdtempSync(join(tmpdir(), 'platform-native-static-edge-'));
    const [plain, redirected] = await Promise.all([
      deployStaticSite('site'),
      deployStaticSite('https', { alwaysUseHttps: true }),
    ]);
    site = startStaticSite(plain, '404-page');
    spa = startStaticSite(plain, 'single-page-application');
    https = startStaticSite(redirected, '404-page');
  });

  afterAll(async () => {
    await Promise.all([site?.dispose(), spa?.dispose(), https?.dispose()]);
    if (staticDirectory) {
      rmSync(staticDirectory, { recursive: true, force: true });
    }
  });

  it('serves pages, files and the 404 page without the Worker', async () => {
    for (const [path, body] of [
      ['/', '<h1>Home</h1>'],
      ['/about', '<h1>About</h1>'],
    ]) {
      const page = await site!.dispatchFetch(`https://site.test${path}`);
      expect(page.status, path).toBe(200);
      expect(page.headers.has('x-platform-worker'), path).toBe(false);
      expect(await page.text()).toBe(body);
    }
    for (const [path, policy] of [
      ['/assets/app-abcdefgh.js', immutable],
      ['/assets/plain.js', 'public, max-age=0, must-revalidate'],
    ]) {
      const file = await site!.dispatchFetch(`https://site.test${path}`);
      expect(file.headers.get('cache-control'), path).toBe(policy);
      expect(file.headers.has('x-platform-worker'), path).toBe(false);
      await file.arrayBuffer();
    }
    const missing = await site!.dispatchFetch('https://site.test/missing');
    expect(missing.status).toBe(404);
    expect(missing.headers.has('x-platform-worker')).toBe(false);
    expect(await missing.text()).toBe('<h1>Not found</h1>');
    const post = await site!.dispatchFetch('https://site.test/', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.has('x-platform-worker')).toBe(false);
    await post.arrayBuffer();
    await expectReadiness(site!);
  });

  it('serves SPA deep links from the shell without the Worker', async () => {
    for (const headers of [{}, { 'sec-fetch-mode': 'navigate' }]) {
      const link = await spa!.dispatchFetch('https://site.test/deep/link', { headers });
      expect(link.status).toBe(200);
      expect(link.headers.has('x-platform-worker')).toBe(false);
      expect(await link.text()).toBe('<h1>Home</h1>');
    }
    await expectReadiness(spa!);
  });

  it('keeps the Worker in front of every request when a rule needs it', async () => {
    const redirect = await https!.dispatchFetch('http://site.test/about', { redirect: 'manual' });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe('https://site.test/about');
    expect(redirect.headers.get('x-platform-worker')).toBe('1');
    for (const path of ['/', '/assets/plain.js']) {
      const response = await https!.dispatchFetch(`https://site.test${path}`);
      expect(response.headers.get('x-platform-worker'), path).toBe('1');
      await response.arrayBuffer();
    }
    const chunk = await https!.dispatchFetch('https://site.test/assets/app-abcdefgh.js');
    expect(chunk.headers.get('cache-control')).toBe(immutable);
    expect(chunk.headers.get('x-platform-worker')).toBe('1');
    await chunk.arrayBuffer();
    await expectReadiness(https!);
  });
});

it.each(['GET', 'HEAD'])('preserves intentional 404s and serves assets for %s', async (method) => {
  const cases = [
    ['/api/data.json', 404, '{"error":"missing"}'],
    ['/api/files/hidden.json', 200, '{"static":"hidden"}'],
    ['/api/files/open.json', 200, '{"static":"api miss"}'],
    ['/api/files/probe.json', 200, '{"static":"probe"}'],
    ['/api/files/clone.json', 200, '{"static":"clone"}'],
    ['/rewrite-miss', 200, 'rewrite asset'],
    ['/files/open.json', 200, '{"static":"open"}'],
  ] as const;
  for (const [path, status, body] of cases) {
    const response = await runtime!.dispatchFetch('https://app.test' + path + '?mode=native', {
      method,
    });
    expect(response.status, path).toBe(status);
    expect(await response.text(), path).toBe(method === 'GET' ? body : '');
  }
});

it('keeps assets and intentional 404s distinct through compression', async () => {
  const cases = [
    ['/api/files/compressed.json', 200, '{"static":"compressed"}'],
    ['/api/files/clone.json', 200, '{"static":"clone"}'],
    ['/api/files/clone-original.json', 200, '{"static":"clone original"}'],
    ['/api/files/pipe.json', 200, '{"static":"pipe"}'],
    ['/api/files/hidden.json', 200, '{"static":"hidden"}'],
    ['/api/data.json', 404, '{"error":"missing"}'],
  ] as const;
  for (const method of ['GET', 'HEAD']) {
    for (const [path, status, body] of cases) {
      const response = await runtime!.dispatchFetch(
        'https://app.test' + path + '?mode=compressed',
        {
          method,
          headers: { 'Accept-Encoding': 'gzip' },
        },
      );
      expect(response.status, `${method} ${path}`).toBe(status);
      const bytes = new Uint8Array(await response.arrayBuffer());

      // Decision: Route middleware such as compress() also applies to assets served from the Worker.
      const text =
        method === 'GET' &&
        // Decision: Miniflare reports a Worker's own encoding as mf-content-encoding.
        (response.headers.get('content-encoding') ??
          response.headers.get('mf-content-encoding')) === 'gzip'
          ? gunzipSync(bytes).toString()
          : new TextDecoder().decode(bytes);
      expect(text, `${method} ${path}`).toBe(method === 'GET' ? body : '');
    }
  }
});
