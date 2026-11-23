import { existsSync, readFileSync } from 'node:fs';
import {
  type AliasOptions,
  isRunnableDevEnvironment,
  parseSync,
  runnerImport,
  type ViteDevServer,
} from 'vite';
import { discoverSchema } from '../drizzle/discover.ts';
import { readProjectPaths, type ProjectPaths } from '../project-paths.ts';
import type { BwfAuthConfig } from '../runtime/auth.ts';
import { isAstProgram, type AstNode, type AstProgram } from '../shared/ast.ts';

function isBwfAuthConfigSource(code: string, filename: string): boolean {
  if (!code.includes('@builtbyfriends/bwf/auth')) {
    return false;
  }
  let program: AstProgram;
  try {
    const parsed = parseSync(filename, code).program;
    if (!isAstProgram(parsed)) {
      return false;
    }
    program = parsed;
  } catch {
    return false;
  }
  return (program.body ?? []).some((node: AstNode) => {
    if (
      node.type !== 'ImportDeclaration' &&
      node.type !== 'ExportNamedDeclaration' &&
      node.type !== 'ExportAllDeclaration'
    ) {
      return false;
    }
    return (node.source as { value?: unknown } | undefined)?.value === '@builtbyfriends/bwf/auth';
  });
}

export function findBwfAuthConfig(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
): string | null {
  for (const absPath of paths.authConfigCandidates) {
    if (!existsSync(absPath)) {
      continue;
    }
    const code = readFileSync(absPath, 'utf-8');
    if (isBwfAuthConfigSource(code, absPath)) {
      return absPath;
    }
  }
  return null;
}

/**
 * The dev server evaluates the auth config in this Node environment. A native
 * `import()` would keep the first evaluation for the life of the process; the
 * module runner reads the config again once its files are invalidated, and the
 * module graph lists the local files the config imports.
 */
export const AUTH_CONFIG_ENVIRONMENT = 'platform_auth_config';

export type ModuleImporter = (path: string) => Promise<Record<string, unknown>>;

/**
 * The dev server's importer for the auth config: its auth config environment, or
 * a one-off runner with the server's aliases when it has no such environment.
 */
export function devAuthConfigImporter(server: ViteDevServer): ModuleImporter {
  const environment = server.environments[AUTH_CONFIG_ENVIRONMENT];
  return environment && isRunnableDevEnvironment(environment)
    ? (path) => environment.runner.import(path)
    : (path) => {
        const { root, mode, resolve } = server.config;
        return viteAuthConfigImporter(root, mode, resolve)(path);
      };
}

/**
 * Builds and CLI commands evaluate the auth config once in a throwaway module
 * runner, so its imports resolve as in dev: without file extensions and through
 * the app's aliases. A native `import()` resolves neither.
 */
export function viteAuthConfigImporter(
  root: string,
  mode: string | undefined,
  resolve: { alias?: AliasOptions; tsconfigPaths?: boolean } | undefined,
): ModuleImporter {
  return async (path) => {
    const { module } = await runnerImport<Record<string, unknown>>(path, {
      root,
      mode,
      logLevel: 'silent',
      resolve: { alias: resolve?.alias, tsconfigPaths: resolve?.tsconfigPaths },
    });
    return module;
  };
}

/**
 * The importer for commands outside Vite, such as `bwf prepare`. It does not load
 * the app's Vite config: evaluating it constructs the app's plugins, and bwf's
 * write generated files and Cloudflare config when constructed. Imports resolve
 * without extensions, through tsconfig `paths`, and through bwf's `@schema`
 * alias; an alias set only in vite.config resolves in dev and builds.
 */
export function projectAuthConfigImporter(root: string): ModuleImporter {
  return (path) => {
    const schema = discoverSchema(root);
    return viteAuthConfigImporter(root, 'development', {
      alias: schema ? { '@schema': schema.path } : undefined,
      tsconfigPaths: true,
    })(path);
  };
}

/** Evaluate the auth config through the importer of the current command. */
export async function loadBwfAuthConfig(
  configPath: string | null,
  importModule: ModuleImporter,
): Promise<BwfAuthConfig | undefined> {
  if (!configPath) {
    return undefined;
  }
  const mod = await importModule(configPath);
  // Decision: The Worker imports only the default export.
  if (!Object.hasOwn(mod, 'default')) {
    throw new Error(
      `${configPath} has no default export. Export the auth config with \`export default defineAuth(...)\`.`,
    );
  }
  return mod.default as BwfAuthConfig | undefined;
}
