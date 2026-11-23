import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createIsolatedPlayground } from '../../../../test/integration-helpers.ts';
import type { IsolatedPlayground } from '../../../../test/integration-helpers.ts';

const repository = join(import.meta.dirname, '../../../..');

// Decision: Run the app's tests as `vp test` runs them in the app's own terminal, not as part of this run.
const appTestEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('VITEST') && key !== 'TEST' && key !== 'NODE_ENV',
  ),
);

async function runAppTests(root: string, args: Array<string> = []) {
  const child = spawn('vp', ['test', 'run', ...args], {
    cwd: root,
    env: appTestEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, output };
}

function writeTest(root: string, source: string): void {
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests/app.test.ts'), source);
}

describe('vp test in a bwf app', () => {
  let playground: IsolatedPlayground;

  beforeAll(() => {
    playground = createIsolatedPlayground(repository, 'playground/spa');
    writeFileSync(
      join(playground.root, 'routes/api/health.ts'),
      "import { defineHandler } from '@builtbyfriends/bwf';\nexport const GET = defineHandler((c) => c.json({ status: 'ok' }));\n",
    );
    writeTest(
      playground.root,
      `import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import * as schema from '@schema';
import { db } from '@builtbyfriends/bwf/db';
import { GET } from '../routes/api/health.ts';

describe('app', () => {
  it('runs a route handler', async () => {
    const response = await new Hono().get('/api/health', GET).request('/api/health');
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('imports the schema and bwf/db', () => {
    expect(Object.keys(schema)).toContain('users');
    expect(db).toBeDefined();
  });
});
`,
    );
  });

  afterAll(() => {
    playground?.cleanup();
  });

  it('runs the tests without starting the Worker or migrating the local database', async () => {
    const { code, output } = await runAppTests(playground.root);

    expect(code, output).toBe(0);
    expect(output).toContain('2 passed');
    expect(output).not.toMatch(/Applied \d+ migration/);
    expect(existsSync(join(playground.root, '.bwf/v3'))).toBe(false);
  });

  it('runs them with nodejs_compat and in another mode', async () => {
    const configPath = join(playground.root, 'bwf.config.ts');
    const config = readFileSync(configPath, 'utf8');
    const compatibilityDate = "compatibility_date: '2026-02-24',";
    expect(config).toContain(compatibilityDate);
    writeFileSync(
      configPath,
      config.replace(
        compatibilityDate,
        `${compatibilityDate}\n    compatibility_flags: ['nodejs_compat'],`,
      ),
    );

    const { code, output } = await runAppTests(playground.root, ['--mode', 'staging']);

    expect(code, output).toBe(0);
    expect(output).toContain('2 passed');
  });
});
