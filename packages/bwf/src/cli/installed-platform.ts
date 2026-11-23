import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'pathslash';
import { getPackageDir } from './agents.ts';
import { isJsonObject } from './json-value.ts';
import type { JsonObject } from './json-value.ts';

function readManifest(path: string): JsonObject {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return isJsonObject(parsed) ? parsed : {};
}

/** A global CLI still builds with the project's installed Vite plugin. */
export function assertInstalledBwfMatchesCli(root: string): void {
  const projectManifest = join(root, 'package.json');
  if (!existsSync(projectManifest)) {
    return;
  }
  const project = readManifest(projectManifest);
  const declaresBwf = ['dependencies', 'devDependencies', 'optionalDependencies'].some((key) => {
    const dependencies = project[key];
    return isJsonObject(dependencies) && '@builtbyfriends/bwf' in dependencies;
  });
  if (!declaresBwf) {
    return;
  }

  const cliPackageDir = getPackageDir();
  const cli = readManifest(join(cliPackageDir, 'package.json'));
  const cliVersion = typeof cli.version === 'string' ? cli.version : undefined;
  let installedVersion: string | undefined;
  let installedPackageDir: string | undefined;
  try {
    const entry = createRequire(projectManifest).resolve('@builtbyfriends/bwf');
    let directory = dirname(entry);
    for (let depth = 0; depth < 8; depth++) {
      const manifest = join(directory, 'package.json');
      if (existsSync(manifest)) {
        const installed = readManifest(manifest);
        if (installed.name === '@builtbyfriends/bwf') {
          installedVersion = typeof installed.version === 'string' ? installed.version : undefined;
          installedPackageDir = directory;
          break;
        }
      }
      directory = dirname(directory);
    }
  } catch {
    // Decision: The error below also covers a declared package that hasn't been installed.
  }
  if (installedVersion !== cliVersion) {
    throw new Error(
      `deploy: this CLI is platform@${cliVersion}, but the project's installed Vite plugin is ` +
        `${installedVersion ? `platform@${installedVersion}` : 'missing'}. ` +
        'Install the same bwf version in the project (or link this development checkout) ' +
        'before deploying. The build imports the project package; mixing versions can ' +
        'rewrite legacy config and produce an unsafe Cloudflare deploy target.',
    );
  }
  if (
    installedPackageDir &&
    existsSync(join(cliPackageDir, 'src', 'index.ts')) &&
    realpathSync(installedPackageDir) !== realpathSync(cliPackageDir)
  ) {
    throw new Error(
      'deploy: this development CLI and the project Vite plugin come from different bwf ' +
        'builds, even though their package versions match. Link the same development checkout ' +
        'into the project before deploying.',
    );
  }
}
