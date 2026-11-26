import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, it } from 'vite-plus/test';

const require = createRequire(import.meta.url);

type CfCommands = { commands: Array<{ fullPath: Array<string> }> };

function installedCfCommands(): Set<string> {
  const metadata: CfCommands = JSON.parse(
    readFileSync(
      join(dirname(require.resolve('cf/package.json')), 'dist', '_meta', 'commands.json'),
      'utf8',
    ),
  );

  return new Set(metadata.commands.map((entry) => entry.fullPath.join(' ')));
}

function commandsRunBy(source: string): Array<string> {
  const found = new Set<string>();

  for (const match of source.matchAll(/runCf\(\[([^\]]*)\]/g)) {
    const words: Array<string> = [];

    for (const part of match[1].split(',')) {
      const literal = /^\s*'([a-z][a-z0-9-]*)'\s*$/.exec(part);

      if (!literal) {
        break;
      }

      words.push(literal[1]);
    }

    if (words.length > 0) {
      found.add(words.join(' '));
    }
  }

  return [...found];
}

it('only runs cf commands that the installed cf has', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', '..', 'src', 'cli', 'cloudflare-operation-process.ts'),
    'utf8',
  );

  const known = installedCfCommands();
  const run = commandsRunBy(source);

  expect(run).toContain('workers secrets bulk-edit');

  expect(
    run.filter(
      (command) => ![...known].some((full) => full === command || full.startsWith(`${command} `)),
    ),
  ).toEqual([]);
});
