import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vite-plus/test';

it('compiles bounded Cloudflare schemas, constraints and artifact provenance', () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../../../../../scripts/cloudflare-openapi.test.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(output).toContain('# pass 12');
  expect(output).toContain('# fail 0');
});
