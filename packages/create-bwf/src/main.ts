import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as p from '@voidzero-dev/vite-plus-prompts';
import { resolve } from 'pathslash';
import pc from 'picocolors';
import { parseCreateArgs, validateProjectName } from './args.ts';
import { detectPM, pmExec, pmInstall, run, writePnpmBuildPolicy } from './pm.ts';

const pm = detectPM();

async function main() {
  console.log();

  const createArgs = parseCreateArgs(process.argv.slice(2));
  let appName = createArgs.appName;

  if (!appName && !process.stdin.isTTY) {
    p.log.error('create-bwf: Pass a project name when running without an interactive terminal.');
    process.exit(1);
  }

  if (!appName) {
    const name = await p.text({
      message: 'Project name:',
      defaultValue: 'my-app',
      placeholder: 'my-app',
      validate: validateProjectName,
    });
    if (p.isCancel(name) || typeof name !== 'string') {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    appName = name;
  }

  const targetDir = resolve(appName);

  if (existsSync(targetDir)) {
    const entries = readdirSync(targetDir);
    if (entries.length > 0) {
      p.log.error(`create-bwf: Directory '${pc.bold(appName)}' is not empty.`);
      process.exit(1);
    }
  }

  // Decision: The release publishes the scaffolder and CLI at the same version. Keep that exact version,
  // including prereleases, instead of switching to latest.
  const { version: bwfVersion } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

  mkdirSync(targetDir, { recursive: true });

  const pkg = {
    name: appName,
    private: true,
    type: 'module',
    devDependencies: {
      // Decision: The CLI is published under the @builtbyfriends scope. The unscoped `bwf` package on npm
      // is someone else's; only the bin is named `bwf`.
      '@builtbyfriends/bwf': bwfVersion,
    },
  };

  writeFileSync(resolve(targetDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  // Decision: pnpm 12 fails the first install when a dependency has an unapproved build script. Write
  // bwf's narrow policy before installing the CLI so a fresh project can bootstrap without
  // turning off pnpm's build-script protection.
  writePnpmBuildPolicy(targetDir, pm);

  p.log.step('Installing bwf...');
  await run(pmInstall(pm), targetDir);

  p.log.step('Scaffolding starter...');
  await run([...pmExec(pm), 'bwf', 'init', ...createArgs.initArgs], targetDir);

  p.log.step('Installing starter dependencies...');
  await run(pmInstall(pm), targetDir);

  p.outro(`\n${pc.green(`✓ Created ${appName}`)}`, { withGuide: false });
  p.outro(`cd ${appName} && ${pm === 'npm' ? 'npm run' : pm} dev`);
}

main().catch((error) => {
  p.log.error(error.message);
  process.exit(1);
});
