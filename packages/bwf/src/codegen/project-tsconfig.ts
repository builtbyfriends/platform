import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'pathslash';
import { readProjectPaths } from '../project-paths.ts';
import type { ProjectPaths } from '../project-paths.ts';
import { writeFileIfChanged } from './write-if-changed.ts';

export type ProjectTsconfigOptions = {
  redirectDbModule?: boolean;
  paths?: ProjectPaths;
};

export type ProjectTsconfig = {
  files: Array<string>;
  compilerOptions?: {
    paths?: Record<string, Array<string>>;
  };
};

/**
 * Build the generated .bwf/tsconfig.json contents. Lists the generated
 * declaration files so TypeScript discovers them via the `files` field
 * (which is inherited by `extends`, unlike `include`).
 *
 * @param hasRouteTypes - When true, include routes.d.ts. When omitted,
 *   auto-detect by checking for a routes/ directory.
 * @param hasDb - When true, include db.d.ts and redirect `@builtbyfriends/bwf/db` to it.
 * @param hasSchema - When true, configure `@schema` paths for the user's
 *   Drizzle schema.
 */
export function createProjectTsconfig(
  root: string,
  hasRouteTypes?: boolean,
  hasDb?: boolean,
  hasSchema?: boolean,
  options: ProjectTsconfigOptions = {},
): ProjectTsconfig {
  const pathsConfig = options.paths ?? readProjectPaths(root);
  const outDir = join(root, '.bwf');
  const includeRoutes = hasRouteTypes ?? existsSync(pathsConfig.routesDir);
  const includeQueues = existsSync(pathsConfig.queuesDir);
  const includeEnv = existsSync(join(outDir, 'env.d.ts'));
  const includeAuth = existsSync(join(outDir, 'auth.d.ts'));
  const includeBindings = existsSync(join(outDir, 'bindings.d.ts'));
  const includeProcedures = existsSync(pathsConfig.proceduresDir);
  const files = [
    ...(includeRoutes ? ['routes.d.ts'] : []),
    ...(hasDb ? ['db.d.ts'] : []),
    ...(includeQueues ? ['queues.d.ts'] : []),
    ...(includeEnv ? ['env.d.ts'] : []),
    ...(includeAuth ? ['auth.d.ts'] : []),
    ...(includeBindings ? ['bindings.d.ts'] : []),
    ...(includeProcedures ? ['procedures.d.ts'] : []),
  ];

  const tsconfig: ProjectTsconfig = { files };

  if (hasDb) {
    const paths: Record<string, Array<string>> = {};

    if (options.redirectDbModule !== false) {
      // Decision: moduleResolution "bundler" ignores ambient declarations when a specifier resolves to a
      // package file, so bwf/db, bwf/routes and bwf/queues map to .bwf/*.d.ts.
      paths['@builtbyfriends/bwf/db'] = ['./db.d.ts'];
    }

    if (hasSchema) {
      const isDir = existsSync(pathsConfig.schemaDir) && !existsSync(pathsConfig.schemaFile);

      // Decision: Paths are relative to .bwf/ (where this tsconfig lives), so use ../
      const schemaRel = relative(outDir, pathsConfig.schemaDir);
      const schemaFileRel = relative(outDir, pathsConfig.schemaFile);
      paths['@schema'] = [isDir ? `${schemaRel}/index.ts` : schemaFileRel];
      paths['@schema/*'] = [`${schemaRel}/*`];
    }

    tsconfig.compilerOptions = { paths };
  }

  if (includeRoutes) {
    const compilerOptions = (tsconfig.compilerOptions ??= {});
    const paths = (compilerOptions.paths ??= {});
    paths['@builtbyfriends/bwf/routes'] = ['./routes.d.ts'];
  }

  if (includeQueues) {
    const compilerOptions = (tsconfig.compilerOptions ??= {});
    const paths = (compilerOptions.paths ??= {});
    paths['@builtbyfriends/bwf/queues'] = ['./queues.d.ts'];
  }

  return tsconfig;
}

/**
 * Ensure .bwf/tsconfig.json exists so the user's root tsconfig can extend it.
 */
export function ensureProjectTsconfig(
  root: string,
  hasRouteTypes?: boolean,
  hasDb?: boolean,
  hasSchema?: boolean,
  options: ProjectTsconfigOptions = {},
): boolean {
  const tsconfig = createProjectTsconfig(root, hasRouteTypes, hasDb, hasSchema, options);
  return writeFileIfChanged(
    join(root, '.bwf', 'tsconfig.json'),
    JSON.stringify(tsconfig, null, 2) + '\n',
  );
}

/**
 * Add or drop `auth.d.ts` in an existing .bwf/tsconfig.json to match whether
 * `.bwf/auth.d.ts` exists, keeping every other entry as written. The dev/build
 * routing plugin uses this after it writes or removes auth.d.ts, so it does not
 * recompute the routes/db choices the Drizzle plugin or `bwf prepare` made.
 * A missing or unreadable tsconfig is left for those writers to create.
 */
export function syncAuthTypesInProjectTsconfig(root: string): boolean {
  const outDir = join(root, '.bwf');
  const tsconfigPath = join(outDir, 'tsconfig.json');
  let tsconfig: ProjectTsconfig;
  try {
    tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8')) as ProjectTsconfig;
  } catch {
    return false;
  }
  const files = Array.isArray(tsconfig.files) ? tsconfig.files : [];
  const others = files.filter((file) => file !== 'auth.d.ts');
  tsconfig.files = existsSync(join(outDir, 'auth.d.ts')) ? [...others, 'auth.d.ts'] : others;
  return writeFileIfChanged(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n');
}
