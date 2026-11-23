import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  mkdir,
  mkdirSync,
  readFileSync,
  realpath,
  rmdir,
  rmdirSync,
  rmSync,
  stat,
  utimes,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse as parseJsoncRaw } from 'jsonc-parser';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, vi } from 'vite-plus/test';
import { operationFixture } from '../../../deploy-cloudflare/test/operation-fixture.ts';
import type {
  DesiredResourceSet,
  ProvisionLogger,
  RunWrangler,
  RunWranglerResult,
  WranglerCallContext,
} from '../../src/cli/provision.ts';

// Decision: proper-lockfile's callback-style fs seam. Tests override single calls on top of it.
export const passthruFs: {
  mkdir: typeof mkdir;
  stat: typeof stat;
  utimes: typeof utimes;
  rmdir: typeof rmdir;
  realpath: typeof realpath;
  rmdirSync: typeof rmdirSync;
} = { mkdir, stat, utimes, rmdir, realpath, rmdirSync };

// Decision: Remote work needs a resolvable account, as in a real deploy, so each test runs with this
// ambient account. Tests of the no-account and mismatch paths stub it themselves.
export const AMBIENT_ACCOUNT = 'ambient-test-account';

export interface ProvisionTestDir {
  tmpDir: string;
  wranglerPath: string;
  setup: (content: string) => void;
  readConfig: () => Record<string, unknown>;
  simulateUpdateConfig: (field: string, entry: Record<string, unknown>, path?: string) => void;
}

export function useProvisionTestDir(name: string): ProvisionTestDir {
  const tmpDir = join(import.meta.dirname, `.tmp-provision-test-${name}`);
  const wranglerPath = toSlash(join(tmpDir, 'wrangler.jsonc'));

  beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', AMBIENT_ACCOUNT);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  return {
    tmpDir,
    wranglerPath,
    setup(content) {
      rmSync(tmpDir, { recursive: true, force: true });
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(wranglerPath, content);
    },
    readConfig() {
      return parseJsoncRaw(readFileSync(wranglerPath, 'utf8')) as Record<string, unknown>;
    },
    simulateUpdateConfig(field, entry, path = wranglerPath) {
      const cfg = parseJsoncRaw(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const list = Array.isArray(cfg[field]) ? (cfg[field] as Array<Record<string, unknown>>) : [];
      const index = list.findIndex((e) => e.binding === entry.binding);
      if (index >= 0) {
        list[index] = { ...list[index], ...entry };
      } else {
        list.push(entry);
      }
      cfg[field] = list;
      writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
    },
  };
}

export function provisionOperationFixture(
  callback: (
    args: Array<string>,
    options: WranglerCallContext,
  ) => RunWranglerResult | Promise<RunWranglerResult>,
): RunWrangler {
  return operationFixture((args, options) =>
    callback(args, options as unknown as WranglerCallContext),
  );
}

export const silentLog: ProvisionLogger = { info: () => {}, warn: () => {} };

type Handler = { match: RegExp; reply: (sub: string) => RunWranglerResult };

export function makeRunner(handlers: Array<Handler>): {
  run: RunWrangler;
  calls: Array<Array<string>>;
} {
  const calls: Array<Array<string>> = [];
  const run: RunWrangler = provisionOperationFixture((args) => {
    calls.push(args);
    const sub = args.join(' ');
    for (const handler of handlers) {
      if (handler.match.test(sub)) {
        return handler.reply(sub);
      }
    }
    return { stdout: '', stderr: '', status: 0 };
  });
  return { run, calls };
}

export function stubEmptyHyperdriveList(): Array<string> {
  const urls: Array<string> = [];
  vi.stubGlobal('fetch', async (url: string | URL) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({ success: true, result: [], result_info: { total_count: 0 } }),
      { status: 200 },
    );
  });
  return urls;
}

export function isCall(argv: Array<string>, ...prefix: Array<string>): boolean {
  return prefix.every((token, i) => argv[i] === token);
}

export function ok(stdout: string = ''): RunWranglerResult {
  return { stdout, stderr: '', status: 0 };
}

export function fail(stdout: string, stderr: string = ''): RunWranglerResult {
  return { stdout, stderr, status: 1 };
}

// Decision: Synthetic ids in the real formats: KV and Hyperdrive ids are 32 lowercase hex characters,
// D1 ids are UUIDs. Equal-length seeds keep their order, so tie-break tests stay valid.
export function hex32(seed: string): string {
  const raw = Buffer.from(seed, 'utf8').toString('hex').slice(0, 32);
  return (raw + '0'.repeat(32)).slice(0, 32);
}

export function uuid(seed: string): string {
  const h = hex32(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export const emptyDesired: DesiredResourceSet = { kvNamespaces: [], queues: [] };

export { provisionCloudflareResources } from '../../src/cli/provision.ts';

export async function waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

export function spawnHang(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    detached: true,
    stdio: 'ignore',
  });
}

export function reap(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}
