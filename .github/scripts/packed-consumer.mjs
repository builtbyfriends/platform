import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import { collectBrowserDiagnostics } from '../../test/browser-helpers.ts';
import { inspectPackage, startPackedRegistry } from './packed-registry.mjs';
import { packedServerUrl } from './packed-server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const suite = process.env.BWF_PACKED_SUITE ?? 'smoke';
assert(['smoke', 'full'].includes(suite), 'BWF_PACKED_SUITE must be smoke or full');
const full = suite === 'full';
const toolchain = process.env.BWF_PACKED_TOOLCHAIN ?? 'vite';
assert(['vite', 'vite-plus'].includes(toolchain), 'BWF_PACKED_TOOLCHAIN must be vite or vite-plus');
const useVitePlus = toolchain === 'vite-plus';
const vitePlusManifest = JSON.parse(
  readFileSync(join(root, 'node_modules/vite-plus/package.json'), 'utf8'),
);
const vitePlusVersion = vitePlusManifest.version;
// Decision: vite-plus pins its own core and refuses any other, so init has to write that alias.
const vitePlusCore = vitePlusManifest.dependencies.vite;
const work = mkdtempSync(join(tmpdir(), 'platform-packed-consumer-'));
const archiveDir = join(work, 'archives');
mkdirSync(archiveDir);
console.log(`Packed consumer artifacts: ${work}`);
console.log(`Packed consumer suite: ${suite}`);
console.log(`Packed consumer toolchain: ${toolchain}`);
const environment = { ...process.env, CI: 'true' };
for (const key of Object.keys(environment)) {
  if (/^(PLATFORM_|VP_|CLOUDFLARE_|CF_|WRANGLER_|NPM_TOKEN$|NODE_AUTH_TOKEN$)/i.test(key)) {
    delete environment[key];
  }
}
const config = join(work, 'npmrc');
writeFileSync(config, 'audit=false\nfund=false\nengine-strict=true\n');
environment.npm_config_userconfig = config;
environment.NPM_CONFIG_USERCONFIG = config;
environment.PNPM_CONFIG_NPMRC_AUTH_FILE = config;
let commandNumber = 0;

function launch(command, args, cwd, env = environment) {
  const logPath = join(work, `command-${++commandNumber}.log`);
  const log = createWriteStream(logPath, { mode: 0o600 });
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tail = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      log.write(chunk);
      tail = (tail + chunk.toString()).slice(-16_000);
    });
  }
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      log.end();
      resolve(code);
    });
  });
  return {
    child,
    completion,
    logPath,
    failure() {
      return `${command} ${args.join(' ')} failed; ${logPath}\n${tail}`;
    },
    output() {
      return tail;
    },
    async stop() {
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}
        const force = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }, 5000);
        await completion.finally(() => clearTimeout(force));
      }
    },
  };
}

async function run(command, args, cwd, env = environment) {
  const task = launch(command, args, cwd, env);
  const timeout = setTimeout(() => {
    void task.stop();
  }, 300_000);
  try {
    const code = await task.completion;
    assert.equal(code, 0, task.failure());
  } finally {
    clearTimeout(timeout);
    await task.stop();
  }
}

const packages = [];
for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }
  const directory = join(root, 'packages', entry.name);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (manifest.private) {
    continue;
  }
  const archive = join(archiveDir, `${entry.name}.tgz`);
  await run('vp', ['pm', 'pack', '--out', archive], directory);
  packages.push(inspectPackage(archive));
}
const registry = await startPackedRegistry(packages);
// Decision: Packed tests have to install new local builds, even when the matching npm release is less than
// a day old. Keep this policy inside the temporary fixture config.
environment.XDG_CONFIG_HOME = join(work, 'config');
const pnpmConfigDirectory = join(environment.XDG_CONFIG_HOME, 'pnpm');
mkdirSync(pnpmConfigDirectory, { recursive: true });
writeFileSync(
  join(pnpmConfigDirectory, 'config.yaml'),
  `registries:\n  default: ${registry.origin}\nminimumReleaseAge: 0\n`,
);
environment.npm_config_registry = registry.origin;
environment.NPM_CONFIG_REGISTRY = registry.origin;
environment.PNPM_CONFIG_REGISTRY = registry.origin;
const version = packages.find((pkg) => pkg.manifest.name === '@builtbyfriends/bwf').manifest
  .version;
const managers = process.env.BWF_PACKED_PM ? [process.env.BWF_PACKED_PM] : ['npm', 'pnpm'];
assert(managers.every((manager) => ['npm', 'pnpm'].includes(manager)));
const frameworks = ['react'];
const app = (label) => `import { useEffect, useState } from 'react';
export default function App() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    document.getElementById('root')?.setAttribute('data-hydrated', 'true');
  }, []);
  return <><h1>Packed ${label}</h1><button onClick={() => setCount(count + 1)}>Count {count}</button></>;
}
`;

let browser;
const failures = [];
try {
  if (full) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  }
  for (const manager of managers) {
    for (const framework of frameworks) {
      const label = `${manager}-${framework}`;
      try {
        const fixture = join(work, label);
        console.log(`Checking packed ${label}: create-bwf and interactive init`);
        await run(
          process.execPath,
          [
            join(root, '.github/scripts/packed-init.mjs'),
            fixture,
            framework,
            manager,
            version,
            toolchain,
          ],
          work,
        );
        const agentInstructions = readFileSync(join(fixture, 'AGENTS.md'), 'utf8');
        assert.equal(agentInstructions.match(/^- /gm)?.length, 3);
        assert(agentInstructions.includes('node_modules/@builtbyfriends/bwf/docs/'));
        assert(agentInstructions.includes('@builtbyfriends/bwf/lint'));
        assert(
          existsSync(join(fixture, 'node_modules/@builtbyfriends/bwf/docs/guide/quickstart.md')),
        );
        assert(
          existsSync(join(fixture, '.git')),
          'Init should initialize the accepted Git repository',
        );
        assert.notEqual(
          spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: fixture }).status,
          0,
          'Init must not create an initial commit automatically',
        );
        assert.equal(
          execFileSync('git', ['ls-files'], { cwd: fixture, encoding: 'utf8' }),
          '',
          'Init must not stage files automatically',
        );
        assert.deepEqual(
          execFileSync(
            'git',
            [
              'check-ignore',
              'node_modules/dependency',
              '.env',
              '.env.local',
              '.env.production',
              '.env.example',
            ],
            {
              cwd: fixture,
              encoding: 'utf8',
            },
          )
            .trim()
            .split('\n'),
          ['node_modules/dependency', '.env', '.env.local', '.env.production', '.env.example'],
          'Init must ignore local environment files',
        );
        writeFileSync(
          join(fixture, '.npmrc'),
          `registry=${registry.origin}\nengine-strict=true\n${manager === 'pnpm' ? 'strict-peer-dependencies=true\n' : ''}audit=false\nfund=false\n`,
        );
        const cli = join(fixture, 'node_modules/@builtbyfriends/bwf/dist/cli/cli.mjs');
        await run(process.execPath, [cli, '--help'], fixture);
        const manifest = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'));
        if (useVitePlus) {
          assert.equal(
            manifest.devDependencies['vite-plus'],
            vitePlusVersion,
            'Vite+ init must match the tested workspace toolchain',
          );
          assert.equal(
            manifest.devDependencies.vite,
            vitePlusCore,
            'Vite+ init must use the core the tested Vite+ release pins',
          );
          const installedVitePlus = JSON.parse(
            readFileSync(join(fixture, 'node_modules/vite-plus/package.json'), 'utf8'),
          );
          assert.equal(installedVitePlus.name, 'vite-plus');
          assert.equal(
            installedVitePlus.version.split('.')[0],
            vitePlusVersion.split('.')[0],
            'The consumer must use a compatible Vite+ release',
          );
        } else {
          assert(
            !manifest.devDependencies?.['vite-plus'],
            'Plain Vite init must not install Vite+',
          );
          const installedVite = JSON.parse(
            readFileSync(join(fixture, 'node_modules/vite/package.json'), 'utf8'),
          );
          assert.equal(installedVite.name, 'vite');
          assert(installedVite.version.startsWith('8.'), 'The consumer must use public Vite 8');
        }
        assert.equal(
          JSON.parse(
            readFileSync(join(fixture, 'node_modules/@builtbyfriends/bwf/package.json'), 'utf8'),
          ).version,
          version,
        );
        await run(process.execPath, [cli, 'prepare'], fixture);
        await run(manager, manager === 'npm' ? ['ci'] : ['install', '--frozen-lockfile'], fixture);
        writeFileSync(join(fixture, 'src/App.tsx'), app(label));
        mkdirSync(join(fixture, 'routes/api'), { recursive: true });
        writeFileSync(
          join(fixture, 'routes/api/packed.ts'),
          `import { defineHandler } from '@builtbyfriends/bwf';\nimport { kv } from '@builtbyfriends/bwf/kv';\nexport const GET = defineHandler(async () => { await kv.put('packed', 'ok'); return { value: await kv.get('packed') }; });\n`,
        );
        // Decision: bwf/email pulls a CommonJS dependency into the Worker. Only an installed package shows whether
        // dev serves it.
        writeFileSync(
          join(fixture, 'routes/api/packed-email.ts'),
          `import { defineHandler } from '@builtbyfriends/bwf';\nimport { sendEmail } from '@builtbyfriends/bwf/email';\nexport const GET = defineHandler(async () => { return sendEmail({ from: 'packed@example.com', to: 'inbox@example.com', subject: 'Packed', text: 'ok' }); });\n`,
        );
        mkdirSync(join(fixture, 'public'), { recursive: true });
        writeFileSync(join(fixture, 'public/packed.txt'), label);
        const vite = join(
          fixture,
          useVitePlus ? 'node_modules/vite-plus/bin/vp' : 'node_modules/vite/bin/vite.js',
        );
        await run(process.execPath, [vite, 'build'], fixture);
        await run(
          process.execPath,
          [join(fixture, 'node_modules/typescript/bin/tsc'), '--noEmit'],
          fixture,
        );
        if (useVitePlus) {
          // Decision: Vitest loads the app's Vite config, bwf's plugin included, and runs the tests in Node.js.
          // The test comes from docs/guide/testing.md and replaces the KV module it uses.
          mkdirSync(join(fixture, 'src'), { recursive: true });
          writeFileSync(
            join(fixture, 'src/visits.ts'),
            `import { kv } from '@builtbyfriends/bwf/kv';\nexport async function countVisit(): Promise<number> {\n  const visits = ((await kv.get<number>('visits')) ?? 0) + 1;\n  await kv.put('visits', visits);\n  return visits;\n}\n`,
          );
          writeFileSync(
            join(fixture, 'src/visits.test.ts'),
            `import { expect, it, vi } from 'vite-plus/test';\nimport { countVisit } from './visits';\nvi.mock('@builtbyfriends/bwf/kv', () => {\n  const values = new Map<string, unknown>();\n  return { kv: { get: async (key: string) => values.get(key) ?? null, put: async (key: string, value: unknown) => { values.set(key, value); } } };\n});\nit('counts visits', async () => {\n  await countVisit();\n  expect(await countVisit()).toBe(2);\n});\n`,
          );
          await run(process.execPath, [vite, 'test', 'run'], fixture);
          rmSync(join(fixture, 'src/visits.ts'));
          rmSync(join(fixture, 'src/visits.test.ts'));
        }
        await run(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { findPackageJSON } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const manifestPath = findPackageJSON('@builtbyfriends/platform', import.meta.resolve('@builtbyfriends/bwf'));
const entry = JSON.parse(readFileSync(manifestPath, 'utf8')).exports['./installer'].import;
const { resolvePlatformRuntime } = await import(new URL(entry, pathToFileURL(manifestPath)));
const runtime = resolvePlatformRuntime();
if (runtime.manifest.platformVersion !== ${JSON.stringify(version)}) throw new Error('Runtime version mismatch');`,
          ],
          fixture,
        );
        for (const mode of full ? ['dev', 'preview'] : ['dev']) {
          const task = launch(
            process.execPath,
            [vite, mode, '--host', '127.0.0.1', '--port', '0', '--strictPort'],
            fixture,
          );
          try {
            const deadline = Date.now() + 90_000;
            let base;
            let response;
            while (Date.now() < deadline) {
              if (task.child.exitCode !== null) {
                throw new Error(task.failure());
              }
              // Decision: Let Vite bind port 0 and report the actual port. If we reserve and then release an ephemeral
              // port, workerd's RPC listener can claim it during config loading, and probing it sends HTTP to
              // that RPC.
              base ??= packedServerUrl(task.output());
              if (base) {
                try {
                  response = await fetch(base, { signal: AbortSignal.timeout(2000) });
                  if (response.ok) {
                    break;
                  }
                } catch {}
              }
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            assert(response?.ok, task.failure());
            assert((await response.text()).includes('<div id="root">'));
            assert.equal(await (await fetch(`${base}/packed.txt`)).text(), label);
            const apiResponse = await fetch(`${base}/api/packed`);
            const apiBody = await apiResponse.text();
            assert.equal(apiResponse.status, 200, `${apiBody}\n${task.failure()}`);
            assert.deepEqual(JSON.parse(apiBody), { value: 'ok' });
            const emailResponse = await fetch(`${base}/api/packed-email`);
            const emailBody = await emailResponse.text();
            assert.equal(emailResponse.status, 200, `${emailBody}\n${task.failure()}`);
            // Decision: Preview runs the built Worker: it has no dev inbox and no send binding.
            const email = JSON.parse(emailBody);
            if (mode === 'dev') {
              assert.equal(email.ok, true, emailBody);
            } else {
              assert.equal(email.error?.code, 'BINDING_MISSING', emailBody);
            }
            if (!browser) {
              continue;
            }
            const page = await browser.newPage();
            const diagnostics = collectBrowserDiagnostics(page);
            try {
              await page.goto(base);
              await page.locator('#root[data-hydrated="true"]').waitFor();
              await page.getByRole('heading', { name: `Packed ${label}`, exact: true }).waitFor();
              await page.getByRole('button', { name: 'Count 0', exact: true }).click();
              await page.getByRole('button', { name: 'Count 1', exact: true }).waitFor();
            } catch (error) {
              throw new Error(
                `Packed ${label} ${mode} browser verification failed:\n${String(error.stack ?? error)}\n${diagnostics()}`,
                { cause: error },
              );
            } finally {
              await page.close();
            }
          } finally {
            await task.stop();
          }
        }
        console.log(
          `Passed packed ${label} (${suite}): init, frozen install, ${useVitePlus ? 'Vite+ build/typecheck/test' : 'public Vite build/typecheck'}, assets, KV, email, runtime integrity${full ? ', dev/preview, browser render' : ', dev HTTP'}`,
        );
      } catch (error) {
        failures.push({ fixture: label, error: String(error.stack ?? error) });
        console.error(`Failed packed ${label}: ${String(error.stack ?? error)}`);
      }
    }
  }
} finally {
  await browser?.close();
  await registry.close();
}
if (failures.length) {
  const path = join(work, 'failures.json');
  writeFileSync(path, JSON.stringify(failures, null, 2), { mode: 0o600 });
  throw new Error(
    `${failures.length} packed consumer fixture(s) failed. Full diagnostics: ${path}`,
  );
}
console.log(`Packed consumer acceptance passed. Logs and fixtures: ${work}`);
