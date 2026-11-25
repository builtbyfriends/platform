import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium } from 'playwright';
import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { analyzeApplication } from '../../src/application-routing.ts';
import { createProjectTsconfig } from '../../src/codegen/project-tsconfig.ts';
import { generateRouteTypes } from '../../src/codegen/route-types.ts';
import { readConfig } from '../../src/config.ts';

const packageRoot = join(import.meta.dirname, '../..');
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const typedCheck = `import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { etag } from 'hono/etag';
import { routeUrl, type Href, type RouteUrl } from '@builtbyfriends/bwf/routes';
import { defineConfig } from '@builtbyfriends/bwf/config';
import { defineHandler, defineMiddleware, type CloudContext } from '@builtbyfriends/bwf/handler';
import { connectLiveStream } from '@builtbyfriends/bwf/live/client';
import { connectEventStream } from '@builtbyfriends/bwf/sse/client';
declare const id: number;
declare const dynamic: string;
const user: RouteUrl = routeUrl('/users/:id', { params: { id } });
const plain: string = user;
const hrefs: Array<Href> = [
  '/',
  '/about',
  '/about?tab=activity',
  '/about#team',
  '/?tab=activity',
  '/users/42',
  \`/users/\${id}\`,
  '/files/docs/start',
  '/wild',
  '/wild/a/b',
  '/api/legacy',
  '/café menu',
  '/caf%C3%A9%20menu',
  '/caf%C3%A9%20menu?q=caf%C3%A9+menu',
  '/café/42',
  '/caf%C3%A9/42',
  '/api/users/42',
  '?page=2',
  '#details',
  'https://vite.dev/guide',
  'http://localhost:5173',
  'mailto:team@example.com',
  'tel:+15550100',
  user,
  dynamic as RouteUrl,
  ('https://' + dynamic) as Href,
];
// @ts-expect-error unknown routes are rejected
const unknown: Href = '/unknown';
// @ts-expect-error unchecked strings are rejected
const unchecked: Href = dynamic;
// @ts-expect-error relative paths are rejected
const relative: Href = '../about';
// @ts-expect-error protocol-relative URLs are rejected
const protocolRelative: Href = '//example.com/about';
// @ts-expect-error empty strings are rejected
const empty: Href = '';
// @ts-expect-error route URLs exclude external links
const external: RouteUrl = 'https://vite.dev';
void [plain, hrefs, unknown, unchecked, relative, protocolRelative, empty, external];
const paged: RouteUrl = \`\${user}?page=2\`;
const hashed: RouteUrl = \`\${user}#details\`;
const builtPaged: RouteUrl = \`\${routeUrl('/about')}?page=2\`;
// @ts-expect-error a suffix does not replace the route check
const unknownPaged: RouteUrl = '/unknown?page=2';
// @ts-expect-error a suffix needs its own separator
const unseparated: RouteUrl = \`\${user}page=2\`;
void [paged, hashed, builtPaged, unknownPaged, unseparated];
declare const context: CloudContext;
void context.rewrite('/users/42');
void context.rewrite(user);
void context.rewrite('/api/legacy');
// @ts-expect-error rewrites only reach the app's routes
void context.rewrite('https://example.com');
// @ts-expect-error rewrites do not take same-page hashes
void context.rewrite('#details');
context.redirect('/about');
context.redirect(user);
context.redirect(routeUrl('/users/:id', { params: { id } }));
context.redirect({ pathname: '/users/:id', params: { id } });
context.redirect('https://example.com/elsewhere');
context.redirect(new URL('https://example.com/login'));
context.redirect(dynamic as Href);
// @ts-expect-error unknown routes are rejected
context.redirect('/unknown');
// @ts-expect-error unchecked strings are rejected
context.redirect(dynamic);
defineHandler((c) => {
  c.redirect('/about');
  c.redirect({ pathname: '/users/:id', params: { id } });
  // @ts-expect-error unknown routes are rejected
  return c.redirect('/unknown');
});
defineMiddleware(async (c) => {
  c.redirect('https://example.com/login');
  // @ts-expect-error unknown routes are rejected
  return c.redirect('/unknown');
});
// Checked redirects keep the context usable with Hono helpers and middleware.
const honoContext: Context = context;
void [honoContext, getCookie(context, 'session')];
defineHandler(etag(), (c) => c.redirect('/about'));
defineMiddleware(async (c, next) => {
  if (!getCookie(c, 'session')) return c.redirect('/about');
  await next();
});
connectEventStream('/api/legacy');
connectEventStream(\`/api/users/\${id}\`);
connectEventStream(user);
connectEventStream('https://example.com/events');
connectEventStream(new URL('https://example.com/events'));
connectEventStream(dynamic as RouteUrl);
// @ts-expect-error event streams reject unknown routes
connectEventStream('/unknown');
// @ts-expect-error event streams do not take WebSocket URLs
connectEventStream('ws://example.com/events');
// @ts-expect-error event streams do not take same-page hashes
connectEventStream('#details');
// @ts-expect-error event streams reject unchecked strings
connectEventStream(dynamic);
connectLiveStream('/api/legacy');
connectLiveStream(\`/api/users/\${id}?room=1\`);
connectLiveStream('http://localhost:5173/live');
connectLiveStream(new URL('https://example.com/live'));
// @ts-expect-error live streams reject unknown routes
connectLiveStream('/unknown');
// @ts-expect-error live streams do not take WebSocket URLs
connectLiveStream('wss://example.com/live');
// @ts-expect-error live streams reject unchecked strings
connectLiveStream(dynamic);
// Config rewrites keep placeholders and static files.
defineConfig({
  routing: {
    typedRoutes: true,
    rewrites: { '/old/*': '/new/:splat', '/app/*': '/index.html' },
    fallbacks: { '/legacy/:id': '/legacy-proxy/:id' },
  },
});
`;

async function createFixture({
  typedRoutes = false,
  extraFiles = {},
}: { typedRoutes?: boolean; extraFiles?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'platform-route-util-'));
  roots.push(root);
  const files: Record<string, string> = {
    'check-typed.ts': typedCheck,
    'package.json': '{"type":"module"}',
    'routes/api/users/[id].ts':
      "import { defineHandler } from '@builtbyfriends/bwf/handler'; export const GET = defineHandler(() => ({ ok: true }));",
    'routes/api/legacy.ts':
      "import { defineHandler } from '@builtbyfriends/bwf/handler'; export default defineHandler(() => ({ ok: true }));",
    'routes/index.ts':
      "import { defineHandler } from '@builtbyfriends/bwf/handler'; export const GET = defineHandler(() => ({ ok: true }));",
    'routes/about.ts':
      "import { defineHandler } from '@builtbyfriends/bwf/handler'; export const GET = defineHandler(() => ({ ok: true }));",
    'routes/café menu.ts':
      "import { defineHandler } from '@builtbyfriends/bwf/handler'; export const GET = defineHandler(() => ({ ok: true }));",
    'routes/café/[id].ts':
      "import { defineHandler } from '@builtbyfriends/bwf/handler'; export const GET = defineHandler(() => ({ ok: true }));",
    'routes/users/[id].ts':
      "import { defineHandler } from '@builtbyfriends/bwf/handler'; export const GET = defineHandler(() => ({ ok: true }));",
    'routes/files/[...path].ts':
      "import { defineHandler } from '@builtbyfriends/bwf/handler'; export const GET = defineHandler(() => ({ ok: true }));",
    'routes/wild/[...].ts':
      "import { defineHandler } from '@builtbyfriends/bwf/handler'; export const GET = defineHandler(() => ({ ok: true }));",
    'check.ts': `import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  routeUrl,
  type RouteDestination,
  type RouteOptions,
  type RoutePath,
} from '@builtbyfriends/bwf/routes';
import { defineHandler, defineMiddleware, type CloudContext, type CloudEnv } from '@builtbyfriends/bwf/handler';
const path: RoutePath = '/users/:id';
const options: RouteOptions<typeof path> = { params: { id: 123 }, query: { tab: 'activity' }, hash: 'details' };
const url: string = routeUrl(path, options);
routeUrl('/');
routeUrl('/about');
routeUrl('/café menu');
routeUrl('/api/users/:id', { params: { id: '123' } });
routeUrl('/files/:path{.+}', { params: { path: 'docs/start' } });
routeUrl('/wild/*', { params: { '*': 'a/b' } });
routeUrl('/users/[id]', { params: { id: 123 } });
routeUrl('/files/[...path]', { params: { path: 'docs/start' } });
routeUrl('/wild/[...]', { params: { '*': 'a/b' } });
// @ts-expect-error bracket patterns require params
routeUrl('/users/[id]');
// @ts-expect-error bracket catch-all patterns require params
routeUrl('/files/[...path]');
// @ts-expect-error bracket anonymous catch-alls require a wildcard param
routeUrl('/wild/[...]');
// @ts-expect-error bracket params are checked
routeUrl('/users/[id]', { params: { wrong: 123 } });
// @ts-expect-error a known route's params are required
routeUrl('/users/:id');
// @ts-expect-error params cannot be omitted while providing other options
routeUrl('/users/:id', { query: { tab: 'activity' } });
// @ts-expect-error unknown routes are rejected
routeUrl('/unknown');
// @ts-expect-error extra params are rejected
routeUrl('/users/:id', { params: { id: '123', wrong: 'x' } });
// @ts-expect-error static routes do not accept params
routeUrl('/about', { params: {} });
// @ts-expect-error catch-all routes require params too
routeUrl('/files/:path{.+}');
// @ts-expect-error anonymous catch-all routes require a wildcard param
routeUrl('/wild/*');
void url;
const destination: RouteDestination = { pathname: '/users/:id', params: { id: 123 }, query: { tab: 'activity' } };
const bracketDestination: RouteDestination = { pathname: '/users/[id]', params: { id: 123 } };
void bracketDestination;
declare const honoContext: Context<CloudEnv>;
const context: CloudContext = honoContext;
const nativeContext: Context<CloudEnv> = context;
const readUser = (c: CloudContext) => c.get('user');
const middleware: MiddlewareHandler<CloudEnv> = async (c, next) => {
  readUser(c);
  await next();
};
defineHandler(middleware, c => c.redirect('/unknown'));
context.set('user', null);
// @ts-expect-error compatibility overloads must not bypass context variable types
context.set('user', 'not a user');
void [nativeContext, getCookie(context, 'session')];
const response: Response & { _status: 307 } = context.redirect(url, 307);
void response;
void context.rewrite(destination);
context.redirect(destination);
context.redirect('/unknown');
context.redirect('https://example.com/elsewhere');
context.redirect(new URL('https://example.com/login'));
// @ts-expect-error typed server rewrites reject unknown patterns
void context.rewrite({ pathname: '/unknown' });
defineHandler(c => c.redirect(url));
defineHandler(c => c.redirect(destination));
defineHandler(c => c.redirect('/unknown'));
defineMiddleware(async c => c.redirect(url));
defineMiddleware(async c => c.redirect(destination));
`,
    ...extraFiles,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  mkdirSync(join(root, 'node_modules/@builtbyfriends'), { recursive: true });
  symlinkSync(packageRoot, join(root, 'node_modules/@builtbyfriends/bwf'), 'junction');
  symlinkSync(join(packageRoot, 'node_modules/hono'), join(root, 'node_modules/hono'), 'junction');
  const { scan } = await analyzeApplication(root, {
    config: readConfig(root),
  });
  const { dts } = generateRouteTypes(scan, join(root, 'routes'), join(root, '.bwf'), {
    typedRoutes,
  });
  mkdirSync(join(root, '.bwf'));
  writeFileSync(join(root, '.bwf/routes.d.ts'), dts);
  writeFileSync(
    join(root, '.bwf/tsconfig.json'),
    JSON.stringify(createProjectTsconfig(root, true)),
  );
  return root;
}

function typecheck(
  root: string,
  declarations: 'generated' | 'package',
  include: Array<string>,
  compilerOptions: Record<string, unknown> = {},
) {
  const config = `tsconfig.${include.join('-')}.json`;
  writeFileSync(
    join(root, config),
    JSON.stringify({
      extends: './.bwf/tsconfig.json',
      compilerOptions: {
        target: 'ES2022',
        module: declarations === 'generated' ? 'ESNext' : 'NodeNext',
        moduleResolution: declarations === 'generated' ? 'Bundler' : 'NodeNext',
        lib: ['ES2022', 'DOM'],
        types: [],
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        ...(declarations === 'package' ? { paths: {} } : {}),
        ...compilerOptions,
      },
      include,
    }),
  );
  const tsc = join(
    dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
    'bin/tsc',
  );
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, config)], {
    encoding: 'utf8',
  });
  return { output: result.stdout + result.stderr, status: result.status };
}

describe('standalone routeUrl utility', () => {
  it.each(['generated', 'package'] as const)(
    'preserves HTTP and WebSocket contracts for both syntaxes through %s declarations',
    async (declarations) => {
      const root = await createFixture({
        extraFiles: {
          'routes/chat/[room].ws.ts': `import { defineRoom } from '@builtbyfriends/bwf/ws';
type Schema<T> = { '~standard': { version: 1; vendor: string; validate: (value: unknown) => { value: T }; types?: { input: T; output: T } } };
declare const message: Schema<{ text: string }>;
export default defineRoom({ messages: { client: message, server: message } });
`,
          'check-aliases.ts': `import { fetch } from '@builtbyfriends/bwf/client';
import { connect } from '@builtbyfriends/bwf/ws';
import type { RouteMap, RoutePathMap, WebSocketRouteMap } from '@builtbyfriends/bwf/routes';
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const aliases: [
  Same<RouteMap['/api/users/[id]'], RouteMap['/api/users/:id']>,
  Same<RoutePathMap['/files/[...path]'], RoutePathMap['/files/:path{.+}']>,
  Same<WebSocketRouteMap['/chat/[room]'], WebSocketRouteMap['/chat/:room']>,
] = [true, true, true];
void aliases;
const bracket = fetch('/api/users/[id]', { params: { id: '42' } });
const legacy = fetch('/api/users/:id', { params: { id: '42' } });
const responses: Same<typeof bracket, typeof legacy> = true;
void responses;
// @ts-expect-error methods stay constrained through bracket keys
fetch('/api/users/[id]', { method: 'POST' });
// @ts-expect-error legacy methods stay constrained
fetch('/api/users/:id', { method: 'POST' });
connect('/chat/[room]', { params: { room: 'lobby' } }).send({ text: 'hi' });
connect('/chat/:room', { params: { room: 'lobby' } }).send({ text: 'hi' });
// @ts-expect-error bracket WebSocket params are required
connect('/chat/[room]', {});
// @ts-expect-error legacy WebSocket params are required
connect('/chat/:room', {});
connect('/chat/[room]', { params: { room: 'lobby' } }).on('message', (message) => {
  const text: string = message.text;
  // @ts-expect-error server message types stay constrained
  void message.missing;
  void text;
});
`,
        },
      });
      expect(typecheck(root, declarations, ['check-aliases.ts'])).toEqual({
        output: '',
        status: 0,
      });
    },
  );

  it.each(['generated', 'package'] as const)(
    'typechecks through the %s declarations',
    async (declarations) => {
      const root = await createFixture();
      expect(typecheck(root, declarations, ['check.ts'])).toEqual({ output: '', status: 0 });
    },
  );

  it.each(['generated', 'package'] as const)(
    'checks URL strings against routes through the %s declarations with routing.typedRoutes',
    async (declarations) => {
      const root = await createFixture({ typedRoutes: true });
      expect(typecheck(root, declarations, ['check-typed.ts'])).toEqual({ output: '', status: 0 });
    },
  );

  it.each([
    { file: '[slug]', pattern: '/[slug]', legacy: '/:slug', param: 'slug' },
    { file: '[...slug]', pattern: '/[...slug]', legacy: '/:slug{.+}', param: 'slug' },
    { file: '[...]', pattern: '/[...]', legacy: '/*', param: '*' },
  ])('keeps raw URL checks with a root $file route', async ({ file, pattern, legacy, param }) => {
    const root = await createFixture({
      typedRoutes: true,
      extraFiles: {
        [`routes/${file}.ts`]:
          "import { defineHandler } from '@builtbyfriends/bwf/handler'; export const GET = defineHandler(() => ({ ok: true }));",
        'check-root-dynamic.ts': `import { routeUrl, type Href, type RoutePath, type RouteUrl } from '@builtbyfriends/bwf/routes';
const path: RoutePath = ${JSON.stringify(pattern)};
const url: RouteUrl = routeUrl(path, { params: { ${JSON.stringify(param)}: 'dashboard' } });
const alias: Href = routeUrl(${JSON.stringify(legacy)}, { params: { ${JSON.stringify(param)}: 'dashboard' } });
const text: string = url;
const known: Href[] = ['/about', '/users/42', '/files/docs/start', '/wild/a/b', url, alias];
// @ts-expect-error root dynamic routes do not admit misspelled static URLs
const typo: Href = '/abuot';
// @ts-expect-error root dynamic routes require explicit URL construction
const dynamic: RouteUrl = '/dashboard';
// @ts-expect-error root dynamic routes do not admit protocol-relative URLs
const external: Href = '//example.com';
// @ts-expect-error query strings do not bypass route checks
const query: RouteUrl = '/dashboard?tab=activity';
// @ts-expect-error params remain required for root dynamic routes
routeUrl(${JSON.stringify(pattern)});
void [known, text, typo, dynamic, external, query];
`,
      },
    });
    for (const declarations of ['generated', 'package'] as const) {
      expect(typecheck(root, declarations, ['check-typed.ts', 'check-root-dynamic.ts'])).toEqual({
        output: '',
        status: 0,
      });
    }
  });

  it('checks URL strings through the package types alone with routing.typedRoutes', () => {
    // Decision: The generated declarations repeat the route URL types, so check the
    // package's own copy without a generated .bwf/routes.d.ts.
    const root = mkdtempSync(join(tmpdir(), 'platform-route-stub-'));
    roots.push(root);
    mkdirSync(join(root, 'node_modules/@builtbyfriends'), { recursive: true });
    symlinkSync(packageRoot, join(root, 'node_modules/@builtbyfriends/bwf'), 'junction');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(root, 'routes.d.ts'),
      `export {};
declare module '@builtbyfriends/bwf/routes' {
  interface RoutePathMap { '/': never; '/docs/[...]': '*'; '/trailing/[...]/': '*'; '/users/[id]': 'id'; '/café menu': never }
  interface EncodedRoutePathMap { '/café menu': '/caf%C3%A9%20menu' }
  interface RouteTypesConfig { typedRoutes: true }
}
`,
    );
    writeFileSync(
      join(root, 'check.ts'),
      `import type { Href, RouteUrl } from '@builtbyfriends/bwf/routes';
const hrefs: Array<Href> = ['/', '/docs', '/docs/a/b', '/users/42', '/café menu', '/caf%C3%A9%20menu?q=1', '#top', 'https://vite.dev'];
const route: RouteUrl = '/caf%C3%A9%20menu';
const emptyCatchAll: RouteUrl = '/trailing/';
const nestedCatchAll: RouteUrl = '/trailing/a/b/';
// @ts-expect-error unknown routes are rejected
const unknown: Href = '/unknown';
// @ts-expect-error route URLs exclude external links
const external: RouteUrl = 'https://vite.dev';
void [hrefs, route, emptyCatchAll, nestedCatchAll, unknown, external];
`,
    );
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022', 'DOM'],
          types: [],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['routes.d.ts', 'check.ts'],
      }),
    );
    const tsc = join(
      dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
      'bin/tsc',
    );
    const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], {
      encoding: 'utf8',
    });
    expect({ output: result.stdout + result.stderr, status: result.status }).toEqual({
      output: '',
      status: 0,
    });
  });

  it('preserves URLs created in another realm', async () => {
    const root = await createFixture();
    writeFileSync(
      join(root, 'entry.ts'),
      `export { toUrlString } from ${JSON.stringify(join(packageRoot, 'src/runtime/route-url.ts'))};\n`,
    );
    await build({
      configFile: false,
      root,
      logLevel: 'silent',
      build: {
        minify: false,
        lib: { entry: join(root, 'entry.ts'), formats: ['es'], fileName: () => 'route.mjs' },
      },
    });
    const code = readFileSync(join(root, 'dist/route.mjs'), 'utf8');
    const original = 'https://other.example/users?tab=activity#details';
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<iframe></iframe>');
      const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
      // Decision: Keep the import in browser code so Vitest does not rewrite it for SSR.
      expect(
        await page.evaluate(`import(${JSON.stringify(dataUrl)}).then(({ toUrlString }) => {
          const iframe = document.querySelector('iframe');
          const value = new iframe.contentWindow.URL(${JSON.stringify(original)});
          return { isLocalURL: value instanceof URL, serialized: toUrlString(value) };
        })`),
      ).toEqual({ isLocalURL: false, serialized: original });
    } finally {
      await browser.close();
    }
  });

  it('bundles the public export for browsers and runs on Workers without Node compatibility', async () => {
    const root = await createFixture();
    writeFileSync(
      join(root, 'entry.ts'),
      `import { routeUrl } from '@builtbyfriends/bwf/routes';
export function buildUrls() {
  return [
    routeUrl('/users/[id]', { params: { id: 'a/b' }, query: { page: 2, tag: ['one', 'two'] }, hash: '/settings?tab=1&next=%2Fhome' }),
    routeUrl('/users/:id', { params: { id: 'a/b' }, query: { page: 2, tag: ['one', 'two'] }, hash: '/settings?tab=1&next=%2Fhome' }),
    routeUrl('/files/[...path]', { params: { path: 'docs/start here' } }),
    routeUrl('/files/:path{.+}', { params: { path: 'docs/start here' } }),
    routeUrl('/wild/[...]', { params: { '*': 'a/b' } }),
    routeUrl('/wild/*', { params: { '*': 'a/b' } }),
    routeUrl('/café menu', { query: { q: 'café menu' }, hash: 'café menu' }),
  ];
}
`,
    );
    await build({
      configFile: false,
      root,
      logLevel: 'silent',
      build: {
        minify: false,
        lib: { entry: join(root, 'entry.ts'), formats: ['es'], fileName: () => 'route.mjs' },
      },
    });
    const expected = [
      '/users/a%2Fb?page=2&tag=one&tag=two#/settings?tab=1&next=%2Fhome',
      '/users/a%2Fb?page=2&tag=one&tag=two#/settings?tab=1&next=%2Fhome',
      '/files/docs/start%20here',
      '/files/docs/start%20here',
      '/wild/a/b',
      '/wild/a/b',
      '/caf%C3%A9%20menu?q=caf%C3%A9+menu#caf%C3%A9%20menu',
    ];
    const scriptPath = join(root, 'dist/route.mjs');
    const code = readFileSync(scriptPath, 'utf8');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
      // Decision: Keep the dynamic import in browser code so Vitest does not rewrite it for SSR.
      expect(
        await page.evaluate(
          `import(${JSON.stringify(dataUrl)}).then((module) => module.buildUrls())`,
        ),
      ).toEqual(expected);
    } finally {
      await browser.close();
    }
    const workerPath = join(root, 'dist/worker.mjs');
    writeFileSync(
      workerPath,
      "import { buildUrls } from './route.mjs'; export default { fetch() { return Response.json(buildUrls()); } };\n",
    );
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-10-01',
        modules: [
          { type: 'ESModule', path: workerPath },
          { type: 'ESModule', path: scriptPath },
        ],
        modulesRoot: join(root, 'dist'),
      }),
    );
    try {
      const response = await runtime.dispatchFetch('https://app.test/');
      expect(await response.json()).toEqual(expected);
    } finally {
      await runtime.dispose();
    }
  });
});
