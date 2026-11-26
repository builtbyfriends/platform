import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vite-plus/test';

it('validates immutable Cloudflare artifacts and publishes through bounded mocked requests', () => {
  const output = execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../../../../scripts/publish-cloudflare-openapi.test.mjs', import.meta.url),
      ),
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(output).toContain('# pass 9');
  expect(output).toContain('# fail 0');
});
