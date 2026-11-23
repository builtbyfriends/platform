import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import {
  SCAFFOLD_FRAMEWORKS,
  SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES,
} from '../../src/cli/template.ts';

describe('React starter', () => {
  // Decision: The starter and the playgrounds use the same @vitejs/plugin-react, so a catalog bump has to
  // update the starter too.
  it("pins @vitejs/plugin-react to the workspace catalog's range", () => {
    const workspace = readFileSync(
      new URL('../../../../pnpm-workspace.yaml', import.meta.url),
      'utf8',
    );
    const range = /^ {2}'@vitejs\/plugin-react': (\S+)$/m.exec(workspace)?.[1];

    expect(range).toBeDefined();
    expect(SCAFFOLD_FRAMEWORKS.react.devDependencies?.['@vitejs/plugin-react']).toBe(range);
  });
});

describe('Vite+ starter', () => {
  // Decision: vite-plus refuses any core other than the one it pins, so a new app has to get the core from
  // the same release as its vite-plus.
  it("pins vite-plus and its core to the workspace catalog's Vite+ release", () => {
    const workspace = readFileSync(
      new URL('../../../../pnpm-workspace.yaml', import.meta.url),
      'utf8',
    );
    const catalogVitePlus = /^ {2}vite-plus: (\S+)$/m.exec(workspace)?.[1];
    const catalogVite = /^ {2}vite: (\S+)$/m.exec(workspace)?.[1];
    const installed = JSON.parse(
      readFileSync(
        new URL('../../../../node_modules/vite-plus/package.json', import.meta.url),
        'utf8',
      ),
    ) as { version: string; dependencies: { vite: string } };

    expect(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES).toEqual({
      vite: installed.dependencies.vite,
      'vite-plus': `^${installed.version}`,
    });
    expect(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus']).toBe(`^${catalogVitePlus}`);
    expect(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite).toBe(catalogVite);
  });
});
