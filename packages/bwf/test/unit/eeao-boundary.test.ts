import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

// Decision: Realtime is a separate project (the @builtbyfriends/realtime packages on npm). bwf talks to
// it only through the procedures adapter: runtime/procedure.ts, runtime/procedures.ts and the
// client runtime/rpc.ts. Nothing else in the framework imports a Realtime package, so the
// framework stays usable and testable without it.
const src = join(import.meta.dirname, '..', '..', 'src');
const adapter = new Set(['runtime/procedure.ts', 'runtime/procedures.ts', 'runtime/rpc.ts']);

function files(dir: string): Array<string> {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('eeao boundary', () => {
  it('only the procedures adapter imports Realtime packages', () => {
    const offenders = files(src)
      .map((f) => relative(src, f).replaceAll('\\', '/'))
      .filter((f) => !adapter.has(f))
      .filter((f) =>
        /['"]@builtbyfriends\/realtime(?:-[a-z]+)?['"/]/.test(readFileSync(join(src, f), 'utf8')),
      );
    expect(offenders).toEqual([]);
  });
});
