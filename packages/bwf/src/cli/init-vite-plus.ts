import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'pathslash';
// Decision: Only the manifest is bundled, so a new app pins the Vite+ release bwf builds with.
import vitePlusManifest from 'vite-plus/package.json' with { type: 'json' };
import { parseDocument } from 'yaml';

export const SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES: {
  readonly vite: string;
  readonly 'vite-plus': string;
} = {
  vite: vitePlusManifest.dependencies.vite,
  // Decision: Pin the Vite+ release beside its exact core so a later release cannot drift.
  'vite-plus': vitePlusManifest.version,
};

type JsonObject = Record<string, unknown>;

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
    pkg.resolutions = { ...(pkg.resolutions as JsonObject | undefined), vite: core };
    editYaml(root, '.yarnrc.yml', (document) => {
      document.set('nodeLinker', 'node-modules');
    });
  } else {
    pkg.overrides = {
      ...(pkg.overrides as JsonObject | undefined),
      vite: packageManager === 'npm' ? '$vite' : core,
    };
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
