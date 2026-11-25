import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigEnv, UserConfig } from 'vite';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import type * as Auth from '../../src/cli/auth.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

vi.mock('../../src/plugin-cloudflare.ts', () => import('../helpers/cloudflare-vite-plugin.ts'));
vi.mock('../../src/cli/auth.ts', async (original) => ({
  ...(await original<typeof Auth>()),
  getToken: () => null,
}));
const roots: Array<string> = [];
type Configure = (config: UserConfig, environment: ConfigEnv) => unknown;
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects local and remote development and local preview explicitly while allowing published builds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-vectorize-plugin-'));
  roots.push(root);
  mkdirSync(join(root, 'routes'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(root, 'bwf.json'),
    JSON.stringify({ vectorize: [{ bindingName: 'SEARCH', dimensions: 384, metric: 'cosine' }] }),
  );
  writeFileSync(join(root, 'routes/index.ts'), 'export const GET = () => ({ ok: true });');
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const { bwfPlugin } = await import('../../src/index.ts');
  const plugins = bwfPlugin();
  const hook: Configure = getHookHandler(
    plugins.find(({ name }) => name === 'platform:remove-implicit-cloudflare-deploy-pointer')
      ?.config,
  );
  for (const isPreview of [false, true]) {
    expect(() => hook({}, { command: 'serve', mode: 'development', isPreview })).toThrow(
      'published deployment',
    );
  }
  expect(() => hook({}, { command: 'build', mode: 'production' })).not.toThrow();
});
