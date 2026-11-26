import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { compileWorkerEntry } from '../../src/router/compile.ts';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const temporary = mkdtempSync(join(tmpdir(), 'platform-workflow-'));
const output = join(temporary, 'dist');
type Runtime = { dispatchFetch(url: string): Promise<Response>; dispose(): Promise<void> };
let runtime: Runtime;

describe('a Workflow through the generated Worker', () => {
  beforeAll(async () => {
    const definition = join(temporary, 'greet.ts');
    const routes = join(temporary, 'routes.ts');
    const entry = join(temporary, 'entry.ts');
    writeFileSync(
      definition,
      `
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { defineWorkflow } from ${JSON.stringify(join(root, 'packages/bwf/src/runtime/workflow.ts'))};

class Greet extends WorkflowEntrypoint {
  async run(event, step) {
    const greeting = await step.do('greet', async () => 'hello ' + event.payload.name);
    return greeting;
  }
}

export default defineWorkflow({ class: Greet });
`,
    );
    writeFileSync(
      routes,
      `
import Greet from ${JSON.stringify(definition)};
export const scheduled = async () => {};
export const __platformCollectPrerenderPaths = async () => [];
export const __platformRenderStaticNotFound = async () => new Response(null, { status: 204 });
export const __platformHandleInternalRoute = async () => null;
export const __withRawEnv = (_env, fn) => fn();
export default { async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/start') {
    const instance = await Greet.create({ id: 'one', params: { name: url.searchParams.get('name') } });
    return Response.json({ id: instance.id });
  }
  const instance = await Greet.get('one');
  return Response.json(await instance.status());
}};
`,
    );
    writeFileSync(
      entry,
      compileWorkerEntry({
        runtimeEnvPath: join(root, 'packages/bwf/src/runtime/env.ts'),
        workflows: [{ bindingName: 'GREET', className: 'GreetWorkflow', filePath: definition }],
      }),
    );
    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'workflow-fixture',
          resolveId: (id) => (id === 'virtual:platform-routes' ? routes : null),
        },
      ],
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
        workflows: { GREET: { name: 'greet', className: 'GreetWorkflow' } },
        resourcePersistencePath: join(temporary, 'state'),
      }),
    ) as unknown as Runtime;
  }, 30_000);

  afterAll(async () => {
    await runtime?.dispose();
    rmSync(temporary, { recursive: true, force: true });
  });

  it('starts an instance from the binding and runs it to its result', async () => {
    const started = await runtime.dispatchFetch('http://localhost/start?name=ada');
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ id: 'one' });
    let status: { status: string; output?: unknown } = { status: 'queued' };
    for (let attempt = 0; attempt < 50 && status.status !== 'complete'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = (await (
        await runtime.dispatchFetch('http://localhost/status')
      ).json()) as typeof status;
    }
    expect(status).toMatchObject({ status: 'complete', output: 'hello ada' });
  });
});
