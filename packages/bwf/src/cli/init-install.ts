import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { dirname, join } from 'pathslash';
import { hasPackageDependency, readPackageJson } from '../shared/package-json.ts';
import { SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES } from './init-vite-plus.ts';

export function installProjectDependencies(
  root: string,
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm',
): void {
  const pkg = readPackageJson(root);
  const useVitePlus = pkg !== null && hasPackageDependency(pkg, 'vite-plus');
  const installer = useVitePlus ? 'vp' : packageManager;
  log.step(`Installing dependencies with ${installer}`);

  // Decision: Init has just changed the manifest. Refresh the lockfile even when pnpm detects a CI host; later
  // CI builds can use frozen installs normally.
  let command: string = installer;
  let args =
    useVitePlus || packageManager === 'pnpm' ? ['install', '--no-frozen-lockfile'] : ['install'];
  if (useVitePlus) {
    let localBin: string | undefined;
    try {
      const require = createRequire(join(root, 'package.json'));
      localBin = join(dirname(require.resolve('vite-plus/package.json')), 'bin/vp');
    } catch {
      // Decision: The starter's Vite+ dependency hasn't been installed yet.
    }
    if (localBin) {
      command = process.execPath;
      args = [localBin, ...args];
    } else {
      const probe = spawnSync('vp', ['--version'], {
        cwd: root,
        stdio: 'ignore',
        shell: process.platform === 'win32',
        timeout: 5_000,
      });
      if (probe.status !== 0) {
        // Decision: npx bwf init has to work without a globally installed vp. Avoid asking an older pnpm to switch
        // itself to a pinned native pnpm 12.
        command = 'npx';
        const packageArg = `--package=vite-plus@${SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus']}`;
        args = [
          '--yes',
          // Decision: cmd.exe treats the semver caret as an escape outside quotes.
          process.platform === 'win32' ? `"${packageArg}"` : packageArg,
          'vp',
          ...args,
        ];
      }
    }
  }
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: command !== process.execPath && process.platform === 'win32',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${installer} install failed with exit code ${result.status ?? 'unknown'}`);
  }

  log.step(`Installed dependencies with ${installer}`);
}
