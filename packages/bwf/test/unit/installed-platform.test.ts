import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { getPackageDir } from '../../src/cli/agents.ts';
import { assertInstalledBwfMatchesCli } from '../../src/cli/installed-platform.ts';

let root: string;
const cliVersion = (
  JSON.parse(readFileSync(join(getPackageDir(), 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

function project(installedVersion?: string | 'linked'): void {
  root = mkdtempSync(join(tmpdir(), 'platform-installed-plugin-version-test-'));
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"@builtbyfriends/bwf":"^0.20.0"}}');
  if (installedVersion) {
    const packageRoot = join(root, 'node_modules', '@builtbyfriends', 'bwf');
    if (installedVersion === 'linked') {
      mkdirSync(join(root, 'node_modules', '@builtbyfriends'), { recursive: true });
      symlinkSync(getPackageDir(), packageRoot, 'dir');
      return;
    }
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@builtbyfriends/bwf',
        version: installedVersion,
        main: './dist/index.mjs',
      }),
    );
    writeFileSync(join(packageRoot, 'dist', 'index.mjs'), 'export default {};\n');
  }
}

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('assertInstalledBwfMatchesCli', () => {
  it('accepts the same installed CLI and plugin version', () => {
    project('linked');
    expect(() => assertInstalledBwfMatchesCli(root)).not.toThrow();
  });

  it('stops different development builds with the same version', () => {
    project(cliVersion);
    expect(() => assertInstalledBwfMatchesCli(root)).toThrow('different bwf builds');
  });

  it('stops a newer global CLI before an older project plugin can build', () => {
    project('0.20.0');
    expect(() => assertInstalledBwfMatchesCli(root)).toThrow(
      `this CLI is platform@${cliVersion}, but the project's installed Vite plugin is platform@0.20.0`,
    );
  });

  it('reports a declared but uninstalled project package', () => {
    project();
    // Decision: Vitest resolves missing bare imports through the workspace. Check the missing-package case
    // with Node's own project-relative resolver.
    const source = new URL('../../src/cli/installed-platform.ts', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { assertInstalledBwfMatchesCli } from ${JSON.stringify(source)}; assertInstalledBwfMatchesCli(process.argv[1]);`,
        root,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('installed Vite plugin is missing');
  });
});
