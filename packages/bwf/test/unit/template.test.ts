import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import {
  createSpaStarterTemplate,
  SCAFFOLD_BASE_DEV_DEPENDENCIES,
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
      'vite-plus': installed.version,
    });
    expect(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus']).toBe(catalogVitePlus);
    expect(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite).toBe(catalogVite);
  });
});

describe('Starter lint', () => {
  // Decision: A new app lints with the same Oxlint and tsrs as this repository, so the bwf preset behaves the
  // same in both.
  it('pins oxlint and tsrs to the versions this repository lints with', () => {
    const workspace = readFileSync(
      new URL('../../../../pnpm-workspace.yaml', import.meta.url),
      'utf8',
    );
    const vitePlus = JSON.parse(
      readFileSync(
        new URL('../../../../node_modules/vite-plus/package.json', import.meta.url),
        'utf8',
      ),
    ) as { dependencies: { oxlint: string } };

    expect(`=${SCAFFOLD_BASE_DEV_DEPENDENCIES.oxlint}`).toBe(vitePlus.dependencies.oxlint);
    expect(SCAFFOLD_BASE_DEV_DEPENDENCIES.tsrs).toBe(/^ {2}tsrs: (\S+)$/m.exec(workspace)?.[1]);
  });

  it.each(['spa', 'sqlite', 'postgresql', 'mysql'] as const)(
    'gives the %s starter code that passes the bwf lint preset',
    (starterMode) => {
      const template = createSpaStarterTemplate({
        framework: 'react',
        starterMode,
        bwfPackageSpec: 'latest',
      });
      const root = mkdtempSync(join(tmpdir(), 'bwf-starter-lint-'));

      try {
        for (const [file, content] of Object.entries(template.files)) {
          mkdirSync(dirname(join(root, file)), { recursive: true });
          writeFileSync(join(root, file), content);
        }

        writeFileSync(
          join(root, 'oxlint.config.ts'),
          `import bwf from ${JSON.stringify(fileURLToPath(new URL('../../src/lint.ts', import.meta.url)))};

export default { ...bwf, options: { ...bwf.options, typeAware: false } };
`,
        );

        const oxlint = fileURLToPath(
          new URL('../../../../node_modules/.bin/oxlint', import.meta.url),
        );
        // Decision: Only PATH and HOME go through, so the test runner's own settings don't change how Oxlint
        // finds its config.
        const result = spawnSync(oxlint, ['-c', 'oxlint.config.ts', '.'], {
          cwd: root,
          encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        });

        expect(result.stdout + result.stderr).toMatch(/^Found 0 warnings and 0 errors\./m);
        expect(result.status).toBe(0);
        expect(template.scripts.lint).toBe('oxlint');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
