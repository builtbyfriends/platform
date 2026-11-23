import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
} from '../../../../test/integration-helpers.ts';
import type { IsolatedPlayground } from '../../../../test/integration-helpers.ts';

const repository = join(import.meta.dirname, '../../../..');
const httpExtensions = ['tsx', 'jsx'];
describe.each(['react', 'hono/jsx'])('server JSX with %s', (jsxImportSource) => {
  let playground: IsolatedPlayground;
  const servers: Array<ReturnType<typeof spawn>> = [];
  const bases: Record<string, string> = {};
  let devTypes: string;

  beforeAll(async () => {
    playground = createIsolatedPlayground(repository, 'playground/spa');
    const root = playground.root;
    rmSync(join(root, 'routes'), { recursive: true });
    mkdirSync(join(root, 'routes'));
    const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
    tsconfig.compilerOptions.jsxImportSource = jsxImportSource;
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
    writeFileSync(
      join(root, 'vite.config.ts'),
      `import { writeFileSync } from 'node:fs';
import { defineConfig } from 'vite-plus';
import { bwfPlugin } from '@builtbyfriends/bwf';
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: ${JSON.stringify(jsxImportSource)} } },
  plugins: [bwfPlugin(), {
    name: 'record-built-module-graphs',
    generateBundle() {
      writeFileSync('.bwf/jsx-' + this.environment.name + '.json', JSON.stringify([...this.getModuleIds()]));
    },
  }],
});`,
    );
    const handler = (text: string) => `import { defineHandler } from '@builtbyfriends/bwf';
${jsxImportSource === 'react' ? "import { renderToStaticMarkup } from 'react-dom/server';" : ''}
export const GET = defineHandler(c => c.html(${jsxImportSource === 'react' ? `renderToStaticMarkup(<h1>${text}</h1>)` : `<h1>${text}</h1>`}));`;
    for (const ext of httpExtensions) {
      mkdirSync(join(root, 'routes', ext));
      for (const [file, text] of [
        [`jsx.${ext}`, 'JSX handler'],
        [`environment.dev.${ext}`, 'Development JSX handler'],
        [`environment.prod.${ext}`, 'Production JSX handler'],
        [`debug.dev.${ext}`, 'DEV_ONLY_JSX_HANDLER'],
      ]) {
        writeFileSync(join(root, 'routes', ext, file), handler(text));
      }
    }
    const dev = await startServer(
      (port) =>
        spawn('vp', ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      20_000,
    );
    servers.push(dev.child);
    bases.dev = dev.base;
    devTypes = readFileSync(join(root, '.bwf/routes.d.ts'), 'utf8');

    const build = spawn.sync('vp', ['build'], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'production' },
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(build.status, `${build.stdout ?? ''}${build.stderr ?? ''}`).toBe(0);
    const prod = await startServer(
      (port) =>
        spawn('vp', ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, BWF_INSPECTOR_PORT: 'false' },
        }),
      20_000,
    );
    servers.push(prod.child);
    bases.prod = prod.base;
  });

  afterAll(async () => {
    await Promise.all(servers.map((child) => killChild(child)));
    playground?.cleanup();
  });

  it.each(httpExtensions.flatMap((ext) => ['dev', 'prod'].map((env) => ({ ext, env }))))(
    'executes .$ext HTTP handlers and selects environment routes in $env',
    async ({ ext, env }) => {
      const response = await fetch(`${bases[env]}/${ext}/jsx`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toBe('<h1>JSX handler</h1>');
      const selected = await fetch(`${bases[env]}/${ext}/environment`);
      expect(selected.status).toBe(200);
      expect(await selected.text()).toBe(
        `<h1>${env === 'dev' ? 'Development' : 'Production'} JSX handler</h1>`,
      );
      expect((await fetch(`${bases[env]}/${ext}/debug`)).status).toBe(env === 'dev' ? 200 : 404);
    },
  );

  it('generates environment-specific JSX HTTP types and excludes dev routes from the production graph', () => {
    const prodTypes = readFileSync(join(playground.root, '.bwf/routes.d.ts'), 'utf8');
    for (const [env, types] of [
      ['dev', devTypes],
      ['prod', prodTypes],
    ]) {
      for (const ext of httpExtensions) {
        expect(types).toContain(`"/${ext}/jsx": {`);
        expect(types).toContain(`typeof import("../routes/${ext}/environment.${env}.${ext}")`);
        expect(types).not.toContain(`environment.${env === 'dev' ? 'prod' : 'dev'}.${ext}`);
      }
    }
    const serverGraph = readFileSync(
      join(playground.root, '.bwf/jsx-platform_worker.json'),
      'utf8',
    );
    for (const ext of httpExtensions) {
      expect(serverGraph).toContain(`/routes/${ext}/jsx.${ext}`);
      expect(serverGraph).toContain(`/routes/${ext}/environment.prod.${ext}`);
      expect(serverGraph).not.toContain(`/routes/${ext}/environment.dev.${ext}`);
      expect(serverGraph).not.toContain(`/routes/${ext}/debug.dev.${ext}`);
    }
    // Decision: The Worker bundles its dependencies, so the graph holds resolved package files.
    expect(serverGraph).toContain(
      jsxImportSource === 'react' ? 'react/jsx-runtime' : 'hono/dist/jsx/jsx-runtime',
    );
  });
});
