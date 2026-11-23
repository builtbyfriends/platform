import { execFileSync } from 'node:child_process';
import { join } from 'pathslash';

const root = join(import.meta.dirname, '..');
const cli = join(root, 'packages/bwf/dist/cli/cli.mjs');
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
  execFileSync(process.execPath, [cli, 'prepare'], { cwd: join(root, app), stdio: 'inherit' });
}
