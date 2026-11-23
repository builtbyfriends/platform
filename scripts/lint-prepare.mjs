import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const cli = fileURLToPath(new URL('packages/bwf/dist/cli/cli.mjs', root));
const apps = [
  'platform/packages/dashboard',
  'playground/kitchen-sink',
  'playground/mysql-test',
  'playground/pg-api-test',
  'playground/pg-test',
  'playground/server-auth-errors',
  'playground/spa',
  'playground/websockets',
];

for (const app of apps) {
  execFileSync(process.execPath, [cli, 'prepare'], {
    cwd: new URL(`${app}/`, root),
    stdio: 'inherit',
  });
}
