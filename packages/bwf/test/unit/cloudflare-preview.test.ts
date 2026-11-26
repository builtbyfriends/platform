import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getWorkerBundleDir,
  getWorkerConfigPath,
  readBuildOutput,
  writeRootConfig,
  writeWorkerConfig,
} from '@cloudflare/build-output-utils';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { parseDeployArgs } from '../../src/cli/args.ts';
import { prepareCfBuildOutput } from '../../src/cli/cf-build-output.ts';
import type { CfCommand } from '../../src/cli/cf-version-api.ts';
import {
  d1BindingsOf,
  ensurePreviewDatabase,
  assertNotDeclared,
  isPreviewName,
  previewBuild,
  previewDatabaseName,
  readPreviewUrl,
  removePreviewDatabase,
} from '../../src/cli/cloudflare-preview.ts';
import { tryEnablePreviewLogs } from '../../src/cli/deploy-cloudflare-preview.ts';
import { healthCheckEnv, runHealthCheck } from '../../src/cli/deploy-health-check.ts';
import { log } from '../../src/cli/deploy-helpers.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeCf(databases: Array<{ uuid: string; name: string }>) {
  const calls: Array<Array<string>> = [];

  const runCf: CfCommand = (args) => {
    calls.push(args);
    const [group, action] = args;
    let data: unknown = {};

    if (group === 'd1' && action === 'list') {
      data = databases.filter((database) => database.name === args[3]);
    } else if (group === 'd1' && action === 'create') {
      data = { uuid: 'created-id', name: args[3] };
    }

    return { status: 0, stdout: '', stderr: '', data };
  };

  return { runCf, calls };
}

describe('preview names and databases', () => {
  it('accepts a short lowercase name and refuses anything a Cloudflare name would not take', () => {
    expect(['pr-1254', 'a', 'x9'].every(isPreviewName)).toBe(true);
    expect(['', '-a', 'a-', 'A', 'a_b', 'a.b', 'x'.repeat(33)].some(isPreviewName)).toBe(false);
  });

  it("names a preview's copy of a database after the preview", () => {
    expect(previewDatabaseName('app-index', 'pr-7')).toBe('app-index-preview-pr-7');
  });

  it("refuses a copy's name that the app declares as a database of its own", () => {
    const declared = ['app', 'app-preview-staging'];

    expect(() => assertNotDeclared(previewDatabaseName('app', 'staging'), declared)).toThrow(
      /also a database this app declares/,
    );
    expect(() => assertNotDeclared(previewDatabaseName('app', 'pr-7'), declared)).not.toThrow();
    expect(previewDatabaseName('app', 'staging')).not.toBe('app-staging');
  });

  it('reads the address from what cf prints, whatever comes before the JSON', () => {
    const output = 'Build complete\n{"preview_urls":["https://pr-7-app.example.workers.dev"]}\n';
    expect(readPreviewUrl(output)).toBe('https://pr-7-app.example.workers.dev');
    expect(readPreviewUrl('{"preview_urls":[]}')).toBeUndefined();
    expect(readPreviewUrl('not json')).toBeUndefined();
  });

  it('reuses a database that exists, and applies migrations to it', async () => {
    const { runCf, calls } = fakeCf([{ uuid: 'existing-id', name: 'app-index-pr-7' }]);

    await expect(
      ensurePreviewDatabase({
        runCf,
        cwd: '.',
        name: 'app-index-pr-7',
        migrationsDir: '/app/db/migrations',
      }),
    ).resolves.toBe('existing-id');
    expect(calls.map((call) => call.slice(0, 3).join(' '))).toEqual([
      'd1 list --name',
      'd1 migrations apply',
    ]);
    expect(calls[1]).toEqual([
      'd1',
      'migrations',
      'apply',
      'existing-id',
      '--dir',
      '/app/db/migrations',
    ]);
  });

  it('creates a missing database, and leaves out migrations when there is no folder or they are skipped', async () => {
    const { runCf, calls } = fakeCf([]);

    await expect(
      ensurePreviewDatabase({ runCf, cwd: '.', name: 'app-index-pr-7', migrationsDir: undefined }),
    ).resolves.toBe('created-id');
    expect(calls).toEqual([
      ['d1', 'list', '--name', 'app-index-pr-7'],
      ['d1', 'create', '--name', 'app-index-pr-7'],
    ]);
  });

  it('stops when cf fails, and names the command', async () => {
    const runCf: CfCommand = () => ({
      status: 1,
      stdout: '',
      stderr: 'denied\nno permission',
      errors: undefined,
    });

    await expect(
      ensurePreviewDatabase({ runCf, cwd: '.', name: 'x', migrationsDir: undefined }),
    ).rejects.toThrow(/cf d1 list failed.*no permission/);
  });

  it('deletes the database made for a preview, and counts one that is already gone as removed', async () => {
    const present = fakeCf([{ uuid: 'db-1', name: 'app-index-pr-7' }]);
    const absent = fakeCf([]);

    await expect(
      removePreviewDatabase({ runCf: present.runCf, cwd: '.', name: 'app-index-pr-7' }),
    ).resolves.toBe(true);
    expect(present.calls.at(-1)).toEqual(['d1', 'delete', 'db-1', '--force']);
    await expect(
      removePreviewDatabase({ runCf: absent.runCf, cwd: '.', name: 'app-index-pr-7' }),
    ).resolves.toBe(false);
    expect(absent.calls.some((call) => call[1] === 'delete')).toBe(false);
  });
});

describe('binding a preview to its own databases', () => {
  const worker = {
    name: 'app',
    env: {
      INDEX: { type: 'd1', name: 'app-index', id: 'production-id' },
      FILES: { type: 'r2', name: 'files' },
      SECRET: { type: 'secret' },
    },
  };

  it('lists the D1 databases a Worker binds', () => {
    expect(d1BindingsOf(worker)).toEqual([{ binding: 'INDEX', databaseName: 'app-index' }]);
  });

  it('swaps the id and name of each D1 binding and leaves everything else as it was', async () => {
    const databaseFor = vi.fn(async (_binding: string, name: string) => ({
      name: `${name}-pr-7`,
      id: 'preview-id',
    }));

    const rewritten = await previewBuild({ preview: 'pr-7', databaseFor }).rewriteWorker(worker);

    expect(databaseFor).toHaveBeenCalledWith('INDEX', 'app-index');
    expect(rewritten.env).toEqual({
      ...worker.env,
      INDEX: { type: 'd1', name: 'app-index-pr-7', id: 'preview-id' },
    });
    expect(worker.env.INDEX.id).toBe('production-id');
  });

  it('stages a Preview build with its own context and databases, from a production build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-preview-output-'));
    roots.push(root);
    await writeRootConfig({
      root,
      settings: { accountId: 'account-id' },
      buildContext: { isPreview: false, mode: 'production' },
      producer: { name: 'test', version: '1.0.0' },
    });
    mkdirSync(getWorkerBundleDir(root), { recursive: true });
    writeFileSync(
      join(getWorkerBundleDir(root), 'index.js'),
      'export default { fetch() { return new Response("ok") } };',
    );
    await writeWorkerConfig({
      root,
      config: {
        name: 'app',
        compatibilityDate: '2026-10-12',
        env: {
          INDEX: { type: 'd1', name: 'app-index', id: 'production-id' },
          OWNER: { type: 'durable-object', worker: 'app', exportName: 'NewOwner' },
          OTHER: { type: 'durable-object', worker: 'other-app', exportName: 'Shared' },
          WELCOME: {
            type: 'workflow',
            name: 'welcome',
            worker: 'app',
            exportName: 'WelcomeWorkflow',
          },
          BILLING: {
            type: 'workflow',
            name: 'billing',
            worker: 'other-app',
            exportName: 'Billing',
          },
        },
        exports: {
          NewOwner: { type: 'durable-object', storage: 'sqlite' },
          WelcomeWorkflow: { type: 'workflow', name: 'welcome' },
        },
      },
      manifest: {
        type: 'complete',
        mainModule: 'index.js',
        modules: { 'index.js': { type: 'esm' } },
      },
    });
    const before = readFileSync(getWorkerConfigPath(root), 'utf8');

    const build = previewBuild({
      preview: 'pr-7',
      databaseFor: async (_binding, name) => ({ name: `${name}-pr-7`, id: 'preview-id' }),
    });

    const prepared = await prepareCfBuildOutput(root, 'account-id', undefined, root, build);

    try {
      const staged = await readBuildOutput(prepared!.directory);
      expect(staged.rootConfig.buildContext).toEqual({ isPreview: true, mode: 'preview' });
      expect(staged.workers.default.config.env).toEqual({
        INDEX: { type: 'd1', name: 'app-index-pr-7', id: 'preview-id' },
        OTHER: { type: 'durable-object', worker: 'other-app', exportName: 'Shared' },
        BILLING: { type: 'workflow', name: 'billing', worker: 'other-app', exportName: 'Billing' },
      });
      expect(staged.workers.default.config.exports).toEqual({
        NewOwner: { type: 'durable-object', storage: 'sqlite' },
        WelcomeWorkflow: { type: 'workflow', name: 'welcome' },
      });
    } finally {
      await prepared?.dispose();
    }

    expect(readFileSync(getWorkerConfigPath(root), 'utf8')).toBe(before);
    expect((await readBuildOutput(root)).rootConfig.buildContext.isPreview).toBe(false);
  });
});

describe('deploy --preview and --remove-preview', () => {
  it('reads the preview name for a Cloudflare deploy', () => {
    expect(parseDeployArgs(['--platform', 'cloudflare', '--preview', 'pr-7'])).toMatchObject({
      preview: 'pr-7',
    });
    expect(parseDeployArgs(['--platform', 'cloudflare', '--remove-preview', 'pr-7'])).toMatchObject(
      { removePreview: 'pr-7' },
    );
  });

  it('reads --secrets-file for a preview only', () => {
    expect(
      parseDeployArgs(['--platform', 'cloudflare', '--preview', 'pr-7', '--secrets-file', 's.env']),
    ).toMatchObject({ secretsFile: 's.env' });
    expect(() => parseDeployArgs(['--platform', 'cloudflare', '--secrets-file', 's.env'])).toThrow(
      '--secrets-file is used with --preview',
    );
    expect(() =>
      parseDeployArgs(['--platform', 'cloudflare', '--preview', 'pr-7', '--secrets-file']),
    ).toThrow('--secrets-file requires a file path');
  });

  it('asks for the Cloudflare platform, one flag at a time, and a usable name', () => {
    expect(() => parseDeployArgs(['--preview', 'pr-7'])).toThrow('require --platform cloudflare');
    expect(() =>
      parseDeployArgs(['--platform', 'cloudflare', '--preview', 'a', '--remove-preview', 'a']),
    ).toThrow('not both');
    expect(() => parseDeployArgs(['--platform', 'cloudflare', '--preview', 'Bad Name'])).toThrow(
      'lowercase letters',
    );
    expect(() => parseDeployArgs(['--platform', 'cloudflare', '--preview'])).toThrow(
      '--preview requires a name',
    );
  });
});

describe('the health check command', () => {
  it('gets its address and no Cloudflare credentials', () => {
    const env = healthCheckEnv('https://app.example.dev', {
      PATH: '/bin',
      CLOUDFLARE_API_TOKEN: 'secret',
      DATABASE_URL: 'postgres://x',
      BWF_TOKEN: 'token',
    });

    expect(env).toMatchObject({ PATH: '/bin', BWF_DEPLOY_URL: 'https://app.example.dev' });
    expect(Object.keys(env)).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(Object.keys(env)).not.toContain('DATABASE_URL');
    expect(Object.keys(env)).not.toContain('BWF_TOKEN');
  });

  it('passes on exit 0 and fails on any other exit, with what happened', async () => {
    const pass = `"${process.execPath}" -e "process.exit(process.env.BWF_DEPLOY_URL === 'https://a.dev' ? 0 : 3)"`;
    const fail = `"${process.execPath}" -e "process.exit(4)"`;

    await expect(runHealthCheck(pass, 'https://a.dev', tmpdir())).resolves.toEqual({
      ok: true,
      detail: '',
    });
    await expect(runHealthCheck(fail, 'https://a.dev', tmpdir())).resolves.toEqual({
      ok: false,
      detail: 'exited with code 4',
    });
  });
});

describe('turning on preview logs', () => {
  const context = {
    accountId: 'account',
    apiBaseUrl: 'https://api.example.test',
    configPath: '/app/wrangler.json',
    workerName: 'my-worker',
    runWrangler: () => {
      throw new Error('Cloudflare did not turn on logs (HTTP 400).');
    },
  };

  it('warns and returns when Cloudflare refuses, so the deploy goes on to the health check', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    await expect(tryEnablePreviewLogs(context, 'pr-12')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not turn on its logs'));
    warn.mockRestore();
  });
});
