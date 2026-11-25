import { execSync } from 'node:child_process';
import type { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { basename, join, relative } from 'node:path/posix';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import crossSpawn from 'cross-spawn';

// Decision: Windows CI runners are 2-3x slower for builds and server startup.
const CI_TIMEOUT_SCALE = process.platform === 'win32' ? 3 : 1;

const START_ATTEMPTS = 3;

const GENERATED_PLAYGROUND_ENTRIES = new Set([
  '.astro',
  '.cloudflare',
  '.next',
  '.nuxt',
  '.output',
  '.react-router',
  '.svelte-kit',
  '.tanstack',
  '.bwf',
  '.vite-cloud',
  '.wrangler',
  'build',
  'dist',
  'node_modules',
]);

export type IsolatedPlayground = {
  root: string;
  workspacePath: string;
  cleanup: () => void;
};

function shouldCopyPlaygroundPath(sourceRoot: string, path: string): boolean {
  const normalizedSourceRoot = sourceRoot.replaceAll('\\', '/');
  const normalizedPath = path.replaceAll('\\', '/');
  const relativePath = relative(normalizedSourceRoot, normalizedPath);
  const topLevelEntry = relativePath.split('/')[0];
  return relativePath === '' || !GENERATED_PLAYGROUND_ENTRIES.has(topLevelEntry);
}

// Decision: The playground is copied outside the workspace package globs so concurrent task-graph scans
// don't find a manifest while the fixture is created or removed. Dependencies stay linked to the
// source tree; generated state isn't copied.
export function createIsolatedPlayground(
  workspaceRoot: string,
  sourceWorkspacePath: string,
): IsolatedPlayground {
  const sourceRoot = join(workspaceRoot, sourceWorkspacePath);
  const playgroundLocal = join(workspaceRoot, 'playground-local', '.test-fixtures');
  mkdirSync(playgroundLocal, { recursive: true });
  const root = mkdtempSync(join(playgroundLocal, `test-${basename(sourceWorkspacePath)}-`));

  cpSync(sourceRoot, root, {
    recursive: true,
    filter(path) {
      // Decision: cpSync reports native backslash paths on Windows, while these paths use forward slashes.
      // Normalizing first keeps the top-level node_modules out of the isolated dependency tree.
      return shouldCopyPlaygroundPath(sourceRoot, path);
    },
  });

  const sourceNodeModules = join(sourceRoot, 'node_modules');
  if (existsSync(sourceNodeModules)) {
    const fixtureNodeModules = join(root, 'node_modules');
    mkdirSync(fixtureNodeModules);
    const linkDependency = (source: string, destination: string) =>
      symlinkSync(
        realpathSync(source),
        destination,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    // Decision: Linking the whole directory leaves pnpm's relative package links behind a Windows junction at
    // a different depth, so each package's real target is pinned.
    for (const entry of readdirSync(sourceNodeModules, { withFileTypes: true })) {
      // Decision: Kit 3 writes project-specific generated configs here, not package dependencies.
      if (entry.name === '$app') {
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      if (entry.name.startsWith('.') && entry.name !== '.bin') {
        continue;
      }
      const source = join(sourceNodeModules, entry.name);
      const destination = join(fixtureNodeModules, entry.name);
      if (entry.name.startsWith('@')) {
        mkdirSync(destination);
        for (const name of readdirSync(source)) {
          linkDependency(join(source, name), join(destination, name));
        }
      } else {
        linkDependency(source, destination);
      }
    }
  }

  // Decision: Avoids duplicate workspace package names when several copies exist at once.
  const packagePath = join(root, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: string };
  packageJson.name = `${packageJson.name ?? basename(sourceWorkspacePath)}-${basename(root)}`;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  return {
    root,
    workspacePath: relative(workspaceRoot, root),
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

// Decision: The port is free right now, but another process can still take it before use.
async function getFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  return port;
}

export type WaitForServerOptions = {
  expectBody?: string;
  rejectBody?: string;
  expectStatus?: number;
  isAlive?: () => boolean;
  isReady?: () => boolean;
  requestTimeoutMs?: number;
  diagnostics?: () => string;
};

export type StartServerOptions = Omit<
  WaitForServerOptions,
  'isAlive' | 'isReady' | 'diagnostics'
> & {
  // Decision: Pass `false` for a server that doesn't print its URL (Nuxt under Vitest). Answers then count as
  // soon as they match, so also pass an `expectBody` that only this app serves.
  printsUrl?: boolean;
};

export type StartedServer = {
  child: ReturnType<typeof spawn>;
  port: number;
  base: string;
  output: () => string;
};

// Decision: The server binds its port seconds after the port is chosen, and another process can take it in
// that time. spawnServer has to make the server stop instead of moving to the next port (pass
// `--strictPort` to Vite), since a moving server can take another starting test's port. When the
// port is taken, the server starts again on a new one.
//
// Another process on the port can also answer, so answers count only after the server prints its
// own URL: Vite and Astro print `Local: http://127.0.0.1:<port>/`, and the Node, Bun and Deno
// servers print `Listening on http://…:<port>`.
export async function startServer(
  spawnServer: (port: number) => ReturnType<typeof spawn>,
  timeoutMs: number,
  { printsUrl = true, ...options }: StartServerOptions = {},
): Promise<StartedServer> {
  for (let attempt = 1; ; attempt++) {
    const port = await getFreePort();
    const child = spawnServer(port);
    const output = collectServerOutput(child);
    const closed = new Promise((resolve) => child.once('close', resolve));
    const base = `http://127.0.0.1:${port}`;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    // Decision: Vite without `--strictPort` (Astro) keeps running and moves to the next port.
    const moved = () => output().includes(`Port ${port} is in use`);
    const listeningLine = new RegExp(
      String.raw`(?:Local:?|Listening on)\s+https?://[^\s/]+:${port}(?!\d)`,
    );
    let listening = false;
    try {
      await waitForServer(base, timeoutMs, {
        ...options,
        isAlive: () => !exited() && !moved(),
        isReady: () =>
          !printsUrl || (listening ||= listeningLine.test(stripVTControlCharacters(output()))),
        diagnostics: output,
      });
      return { child, port, base, output };
    } catch (error) {
      if (exited()) {
        // Decision: The last output can arrive after the exit.
        await Promise.race([closed, delay(1000)]);
      }
      // Decision: Vite with `--strictPort`, Node, Bun and Deno exit with one of these messages.
      const portTaken = moved() || (exited() && /already in use|EADDRINUSE/.test(output()));
      await killChild(child);
      if (!portTaken) {
        throw error;
      }
      if (attempt === START_ATTEMPTS) {
        throw new Error(`Another process took the server port ${START_ATTEMPTS} times`, {
          cause: error,
        });
      }
      console.warn(`Another process took port ${port}; starting the server on a new port.`);
    }
  }
}

export function spawnPlaygroundServer(
  workspaceRoot: string,
  playground: string,
  script: 'dev' | 'preview',
  port: number,
): ReturnType<typeof spawn> {
  return crossSpawn(
    'vp',
    [
      'run',
      '--filter',
      `./playground/${playground}`,
      script,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BWF_INSPECTOR_PORT: 'false' },
    },
  );
}

export async function waitForServer(
  url: string,
  timeoutMs: number,
  options?: WaitForServerOptions,
): Promise<void> {
  const effectiveTimeout = timeoutMs * CI_TIMEOUT_SCALE;
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    if (options?.isAlive && !options.isAlive()) {
      throw new Error(`Server stopped while waiting for ${url}\n${options.diagnostics?.() ?? ''}`);
    }
    if (options?.isReady && !options.isReady()) {
      await delay(200);
      continue;
    }
    try {
      const remainingMs = effectiveTimeout - (Date.now() - start);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(options?.requestTimeoutMs ?? 5000, remainingMs)),
      });
      const statusMatches =
        options?.expectStatus === undefined
          ? response.status > 0
          : response.status === options.expectStatus;
      if (statusMatches) {
        if (!options?.expectBody && !options?.rejectBody) {
          return;
        }
        const body = await response.text();
        if (
          (!options.expectBody || body.includes(options.expectBody)) &&
          (!options.rejectBody || !body.includes(options.rejectBody))
        ) {
          return;
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Timed out waiting for server at ${url} (waited ${effectiveTimeout}ms, scale=${CI_TIMEOUT_SCALE})\n${options?.diagnostics?.() ?? ''}`,
  );
}

export function collectServerOutput(child: ReturnType<typeof spawn>): () => string {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout = (stdout + String(chunk)).slice(-16_000);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-16_000);
  });
  return () => `Server stdout:\n${stdout}\nServer stderr:\n${stderr}`;
}

export async function killChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32' && child.pid) {
      // Decision: On Windows, SIGTERM doesn't reach child processes, so taskkill /T kills the whole tree
      // (workerd.exe included).
      try {
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch {}
    } else if (child.pid) {
      // Decision: On Unix, SIGTERM only reaches the direct child (pnpm). Grandchildren like vite -> miniflare ->
      // workerd become orphans that hold locks (D1 SQLite, ports), so the tree is walked bottom-up.
      killTree(child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => {
          deadline = setTimeout(resolve, 5000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform !== 'win32' && child.pid) {
        killTree(child.pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    }
  }
}

function killTree(pid: number, signal: NodeJS.Signals): void {
  // Decision: Children are found before the parent is killed: once it dies they move to init and pgrep -P
  // can't find them.
  let childPids: Array<number> = [];
  try {
    childPids = execSync(`pgrep -P ${pid}`, { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    // Decision: pgrep exits 1 when there are no children.
  }
  for (const childPid of childPids) {
    killTree(childPid, signal);
  }
  try {
    process.kill(pid, signal);
  } catch {}
}
