import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { captureOutput } from '../helpers/cli-command.ts';

const tempHomes: Array<string> = [];
const mockGetToken = vi.fn<() => string | null>();

vi.mock('../../src/cli/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/auth.ts')>()),
  getToken: () => mockGetToken(),
  getApiUrl: () => 'https://api.example.test',
}));

function setIsolatedHome(): void {
  const dir = mkdtempSync(join(tmpdir(), 'platform-home-'));
  tempHomes.push(dir);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

async function importRunListCommand() {
  vi.resetModules();
  const mod = await import('../../src/cli/list.ts');
  return mod.runListCommand;
}

describe('runListCommand', () => {
  beforeEach(() => {
    mockGetToken.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    delete process.env.BWF_TOKEN;
    delete process.env.BWF_API_URL;

    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    while (tempHomes.length > 0) {
      const dir = tempHomes.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits with error when not logged in', async () => {
    setIsolatedHome();

    const capture = captureOutput();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    const runListCommand = await importRunListCommand();
    const root = mkdtempSync(join(tmpdir(), 'platform-list-'));
    tempHomes.push(root);
    await expect(runListCommand(root)).rejects.toThrow('process.exit:1');
    const out = capture.output();
    capture.restore();

    expect(out).toContain('Not logged in');
  });

  it('exits with error when no linked project and no slug', async () => {
    setIsolatedHome();
    mockGetToken.mockReturnValue('test-token');

    const capture = captureOutput();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    const runListCommand = await importRunListCommand();
    const root = mkdtempSync(join(tmpdir(), 'platform-list-'));
    tempHomes.push(root);
    await expect(runListCommand(root)).rejects.toThrow('process.exit:1');
    const out = capture.output();
    capture.restore();

    expect(out).toContain('No linked project found');
  });

  it('lists each deployment with its app type', async () => {
    setIsolatedHome();
    mockGetToken.mockReturnValue('test-token');
    const root = mkdtempSync(join(tmpdir(), 'platform-list-'));
    tempHomes.push(root);
    mkdirSync(join(root, '.bwf'), { recursive: true });
    writeFileSync(
      join(root, '.bwf', 'project.json'),
      JSON.stringify({
        projectId: 'proj-1',
        slug: 'demo',
      }),
    );
    const deployment = (id: string, manifest: Record<string, unknown>) => ({
      id,
      status: 'live',
      source: 'cli',
      commit: null,
      manifest: JSON.stringify(manifest),
      error_message: null,
      retained: true,
      applied_migrations: null,
      created_at: '2026-01-01T00:00:00Z',
      deployed_at: '2026-01-01T00:00:00Z',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: {
            deployments: [
              deployment('dep-platform', { type: 'platform' }),
              deployment('dep-spa', { type: 'spa' }),
            ],
            activeDeploymentId: 'dep-platform',
          },
        }),
      ),
    );

    const capture = captureOutput();
    const runListCommand = await importRunListCommand();
    await runListCommand(root);
    const out = capture.output();
    capture.restore();

    const rowFor = (id: string) => out.split('\n').find((line) => line.includes(id)) ?? '';
    expect(rowFor('dep-platform')).toMatch(/\bplatform\b/);
    expect(rowFor('dep-spa')).toMatch(/\bspa\b/);
    expect(out).not.toMatch(/\bisr\b/);
  });

  it('prints platform warnings before the deployment table', async () => {
    setIsolatedHome();
    mockGetToken.mockReturnValue('test-token');
    const root = mkdtempSync(join(tmpdir(), 'platform-list-'));
    tempHomes.push(root);
    mkdirSync(join(root, '.bwf'), { recursive: true });
    writeFileSync(
      join(root, '.bwf', 'project.json'),
      JSON.stringify({ projectId: 'proj-1', slug: 'demo' }),
    );
    const body = (warnings?: Array<string>) => ({
      deployments: [
        {
          id: 'dep-live',
          status: 'live',
          source: 'cli',
          commit: null,
          manifest: JSON.stringify({ type: 'ssr' }),
          error_message: null,
          retained: true,
          applied_migrations: null,
          created_at: '2026-01-01T00:00:00Z',
          deployed_at: '2026-01-01T00:00:00Z',
        },
      ],
      activeDeploymentId: 'dep-live',
      ...(warnings ? { warnings } : {}),
    });

    const run = async (warnings?: Array<string>) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ data: body(warnings) })),
      );
      const capture = captureOutput();
      const runListCommand = await importRunListCommand();
      const { log } = await import('@voidzero-dev/vite-plus-prompts');
      const warnedAt: Array<number> = [];
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {
        warnedAt.push(capture.output().length);
      });
      // Decision: The prompts module survives vi.resetModules(), so a second spyOn returns the first spy with
      // its earlier calls.
      warn.mockClear();
      await runListCommand(root);
      const out = capture.output();
      capture.restore();
      return { warn, warnedAt, tableAt: out.indexOf('dep-live') };
    };

    const warned = await run(['stuck \u001b[31mred']);
    expect(warned.warn).toHaveBeenCalledTimes(1);
    expect(warned.warn).toHaveBeenCalledWith('stuck  [31mred');
    expect(warned.tableAt).toBeGreaterThan(warned.warnedAt[0]);

    const quiet = await run();
    expect(quiet.warn).not.toHaveBeenCalled();
  });
});
