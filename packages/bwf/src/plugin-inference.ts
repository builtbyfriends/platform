import { join, toSlash } from 'pathslash';
import { globSync } from 'tinyglobby';
import { applyBindingOverrides } from './application-features.ts';
import { inferBindingsFromSource, mergeBindings } from './inference/walk.ts';
import type { InferredBindings } from './inference/walk.ts';
import { readProjectPaths } from './project-paths.ts';
import type { ProjectPaths } from './project-paths.ts';
import {
  isRouteEnabledForEnvironment,
  parseRouteFilename,
  parseWebSocketFilename,
} from './router/parse-filename.ts';
import type { RouteEnvironment } from './router/parse-filename.ts';
import { isWebSocketPatternFile } from './router/websocket.ts';
import { conventionFileGlobs, isRouteFile } from './shared/convention-files.ts';
import { deriveFromSource } from './shared/source-analysis-cache.ts';

const SOURCE_GLOB = '**/*.{ts,tsx,mts,js,jsx,mjs}';

/**
 * Directories to scan for binding inference in bwf app mode.
 *
 * `email` is included so a `sendEmail()` call from inside an inbound handler
 * (`email/<addr>.ts`) registers `needsEmail = true`. Otherwise the manifest
 * flag and the dev-inbox plugin would miss those callsites.
 */
export const DEFAULT_SCAN_DIRS = [
  'routes',
  'middleware',
  'queues',
  'crons',
  'procedures',
  'email',
  'durable-objects',
  'workflows',
  'src',
] as const;

export type InferenceOptions = {
  /** Explicit binding overrides — takes precedence over inference */
  bindings?: {
    db?: boolean | string;
    kv?: boolean | string;
    storage?: boolean | string;
    ai?: boolean | string;
    email?: boolean;
  };
  paths?: ProjectPaths;
  /** Filter route files for a Vite serve/build environment. Other source files are always scanned. */
  environment?: RouteEnvironment;
};

/**
 * Synchronously infer which Cloudflare bindings the project needs
 * by scanning route/middleware/source files with oxc-parser.
 *
 * Without an environment this scans the full source superset, which is used
 * during plugin construction for binding-name reservation and plugin setup.
 *
 * @param scanDirs - Override the default scan directories
 */
export function inferProjectBindings(
  root: string,
  options?: InferenceOptions,
  scanDirs?: ReadonlyArray<string>,
): InferredBindings {
  const paths = options?.paths ?? readProjectPaths(root);
  const dirs =
    scanDirs ??
    (paths.sourceDir ? [paths.sourceDir, 'durable-objects', 'workflows'] : DEFAULT_SCAN_DIRS);
  const allBindings: Array<InferredBindings> = [];
  const scannedFiles = new Set<string>();
  const routesPrefix = `${toSlash(paths.routesDir).replace(/\/$/, '')}/`;
  const scanSourceFiles = (dirPath: string): Array<string> =>
    globSync(conventionFileGlobs(dirPath, SOURCE_GLOB, paths.routesDir), {
      cwd: dirPath,
      absolute: true,
    });
  const addFile = (file: string): void => {
    const normalizedFile = toSlash(file);
    if (scannedFiles.has(normalizedFile)) {
      return;
    }
    scannedFiles.add(normalizedFile);
    const routePath = normalizedFile.startsWith(routesPrefix)
      ? normalizedFile.slice(routesPrefix.length)
      : undefined;
    if (options?.environment && routePath !== undefined && isRouteFile(routePath)) {
      const route = isWebSocketPatternFile(routePath)
        ? parseWebSocketFilename(routePath)
        : parseRouteFilename(routePath);
      if (!isRouteEnabledForEnvironment(route, options.environment)) {
        return;
      }
    }
    allBindings.push(
      deriveFromSource(file, 'bindings', (code) =>
        inferBindingsFromSource(code, file.split('/').pop() ?? 'unknown.ts'),
      ),
    );
  };

  for (const dir of dirs) {
    const dirPath = join(root, dir);
    let files: Array<string>;
    try {
      files = scanSourceFiles(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      addFile(file);
    }
  }

  // Decision: Custom scan directories should still see client/auth helpers and colocated
  // server-only modules under src/.
  const dirsSet = new Set(dirs);
  const srcRel = paths.sourceDir ? paths.sourceDir : 'src';
  if (!dirsSet.has(srcRel)) {
    const srcPath = paths.sourceDir ? paths.sourceRoot : join(root, 'src');
    let srcFiles: Array<string>;
    try {
      srcFiles = scanSourceFiles(srcPath);
    } catch {
      srcFiles = [];
    }
    for (const file of srcFiles) {
      addFile(file);
    }
  }

  // Decision: Overrides apply to their named binding only. Setting KV must not suppress
  // auth, Sandbox, queues, or any other feature found in the same application.
  return applyBindingOverrides(mergeBindings(allBindings), options?.bindings);
}
