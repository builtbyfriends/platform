import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'pathslash';
import { parseDocument } from 'yaml';
import { isJsonObject } from './json-value.ts';
import type { JsonObject } from './json-value.ts';
import { SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES } from './template.ts';

/** Keep every Vite consumer on the core used by the selected Vite+ toolchain. */
export function configureVitePlusScaffold(
  root: string,
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm',
  pkg: JsonObject,
): void {
  const core = SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite;
  if (packageManager === 'pnpm') {
    editYaml(root, 'pnpm-workspace.yaml', (document) => {
      if (document.hasIn(['overrides', 'vite'])) {
        document.deleteIn(['overrides', 'vite']);
      }
      document.setIn(['overrides', 'vite@*'], core);
      document.setIn(['peerDependencyRules', 'allowedVersions', 'vite'], '*');
    });
  } else if (packageManager === 'yarn') {
    const resolutions: JsonObject = isJsonObject(pkg.resolutions) ? { ...pkg.resolutions } : {};
    resolutions.vite = core;
    pkg.resolutions = resolutions;
    editYaml(root, '.yarnrc.yml', (document) => {
      document.set('nodeLinker', 'node-modules');
    });
  } else {
    const overrides: JsonObject = isJsonObject(pkg.overrides) ? { ...pkg.overrides } : {};
    overrides.vite = packageManager === 'npm' ? '$vite' : core;
    pkg.overrides = overrides;
  }
}

function editYaml(
  root: string,
  name: string,
  edit: (document: ReturnType<typeof parseDocument>) => void,
): void {
  const path = join(root, name);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const document = parseDocument(before);
  if (document.errors.length) {
    throw new Error(`Could not parse ${name}: ${document.errors[0].message}`);
  }
  edit(document);
  writeFileSync(path, document.toString());
}
