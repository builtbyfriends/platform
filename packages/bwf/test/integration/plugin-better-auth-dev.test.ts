import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { bwfPlugin } from '../../src/index.ts';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const roots: Array<string> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('bwf dev better-auth module', () => {
  it('loads one OAuth state module for the worker runtime and app code', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'platform-better-auth-')));
    roots.push(root);
    // Decision: The package export is `dist/index.mjs`.
    const betterAuthEntry = fileURLToPath(import.meta.resolve('better-auth'));
    const betterAuthRoot = realpathSync(dirname(dirname(betterAuthEntry)));
    mkdirSync(join(root, 'node_modules', '@builtbyfriends', 'bwf'), { recursive: true });
    symlinkSync(betterAuthRoot, join(root, 'node_modules', 'better-auth'), 'dir');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: { 'better-auth': '*', '@builtbyfriends/bwf': '*' },
      }),
    );
    // Decision: Auth apps enable nodejs_compat because Better Auth hashes passwords with node:crypto.
    writeFileSync(
      join(root, 'bwf.json'),
      JSON.stringify({
        worker: { compatibility_date: '2026-02-24', compatibility_flags: ['nodejs_compat'] },
      }),
    );
    // Decision: An installed `@builtbyfriends/bwf` is excluded from dependency optimization, so its import of
    // better-auth stays on the package source. This probe is that file: the relative path
    // is the module the runtime reaches, and the route imports the public subpath a plugin uses.
    writeFileSync(
      join(root, 'node_modules', '@builtbyfriends', 'bwf', 'package.json'),
      JSON.stringify({
        name: '@builtbyfriends/bwf',
        type: 'module',
        exports: { './oauth-probe': './oauth-probe.mjs' },
      }),
    );
    writeFileSync(
      join(root, 'node_modules', '@builtbyfriends', 'bwf', 'oauth-probe.mjs'),
      "export { getOAuthState } from '../../better-auth/dist/api/state/oauth.mjs';\n",
    );
    mkdirSync(join(root, 'routes', 'api'), { recursive: true });
    writeFileSync(
      join(root, 'routes', 'api', 'oauth-state.ts'),
      [
        "import { getOAuthState as fromApp } from 'better-auth/api';",
        "import { getOAuthState as fromRuntime } from '@builtbyfriends/bwf/oauth-probe';",
        'export const GET = () => Response.json({ same: fromApp === fromRuntime });',
        '',
      ].join('\n'),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, repoRoot] } },
      plugins: [bwfPlugin()],
    });
    try {
      await server.listen();
      const response = await fetch(new URL('/api/oauth-state', server.resolvedUrls!.local[0]));
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(JSON.parse(body)).toEqual({ same: true });
    } finally {
      await server.close();
    }
  }, 60_000);
});
