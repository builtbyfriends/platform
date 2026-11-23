import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative } from 'pathslash';
import { normalizePath } from 'vite';
import type { Plugin } from 'vite';
import { DRIZZLE_OPERATORS, generateDbDts } from './codegen/db-types.ts';
import { ensureProjectTsconfig } from './codegen/project-tsconfig.ts';
import {
  getDatabaseCasing,
  getDatabaseDialect,
  readConfig,
  resolveBindingNames,
} from './config.ts';
import type { DatabaseCasing, BwfConfig } from './config.ts';
import { discoverSchema } from './drizzle/discover.ts';
import { bwfWarn } from './log.ts';
import { readProjectPaths, resolveProjectPaths } from './project-paths.ts';
import type { ProjectPaths } from './project-paths.ts';

// Decision: Resolve drizzle-orm paths from void's own deps so they work in any project
// (including metaframeworks where drizzle-orm isn't a direct dependency).
const drizzleD1Resolved = fileURLToPath(import.meta.resolve('drizzle-orm/d1'));
const drizzleOrmResolved = fileURLToPath(import.meta.resolve('drizzle-orm'));
const envModuleResolved = fileURLToPath(import.meta.resolve('#self/_env'));
const dbSessionResolved = fileURLToPath(import.meta.resolve('#self/runtime/db-session'));
const drizzleNodePgResolved = fileURLToPath(import.meta.resolve('drizzle-orm/node-postgres'));
const drizzleMysql2Resolved = fileURLToPath(import.meta.resolve('drizzle-orm/mysql2'));

const VIRTUAL_DB_ID = '\0virtual:platform-db';
const VIRTUAL_SCHEMA_DB_ID = '\0virtual:platform-db-schema';

// Decision: Workers tie a connection to the request that opened it. bwf/db's PostgreSQL and MySQL
// templates share one drizzle instance whose client looks up the current request's pool on
// every call, so a query built or prepared in one request runs on the pool of the request that
// executes it. `has` and `getPrototypeOf` answer drizzle's pool checks before a transaction.
// Every pool has the same shape, so those answers are kept: outside a request scope, where each
// lookup builds a pool, a check would otherwise build one that never runs a query.
const REQUEST_POOL_PROXY = `
function requestPool(resolve, own = {}) {
  const has = new Map();
  let prototype;
  return new Proxy({}, {
    get(_, prop) {
      if (Object.hasOwn(own, prop)) return own[prop];
      const pool = resolve();
      const value = Reflect.get(pool, prop);
      return typeof value === "function" ? value.bind(pool) : value;
    },
    has(_, prop) {
      if (Object.hasOwn(own, prop)) return true;
      if (!has.has(prop)) has.set(prop, Reflect.has(resolve(), prop));
      return has.get(prop);
    },
    getPrototypeOf: () => (prototype ??= Object.getPrototypeOf(resolve())),
  });
}
`;
type BwfDbModuleOptions = {
  d1BindingName?: string;
  forceVirtualDb?: boolean;
  /** Drizzle's `casing` from `database.casing`. Unset passes none to drizzle. */
  casing?: DatabaseCasing;
};
type DrizzlePluginOptions = BwfDbModuleOptions & {
  localD1DatabaseId?: string;
  localD1PersistRoot?: string;
  redirectDbTypePaths?: boolean;
};

/**
 * The app's `@builtbyfriends/bwf/db` module for its dialect, schema and D1 binding. Resolving and loading
 * have no side effects, so the Vite plugin and `bwfDbBundlerPlugin` share them.
 */
function createBwfDbModule(
  root: string,
  dialect: 'sqlite' | 'postgresql' | 'mysql',
  options: BwfDbModuleOptions,
  paths: ProjectPaths = readProjectPaths(root),
) {
  const schema = discoverSchema(root, paths);
  // Decision: The package's own `@builtbyfriends/bwf/db` is a D1 client, so PostgreSQL and MySQL need this one.
  // It cannot apply `database.casing` either, which also names the columns of tables that an
  // app keeps outside its schema.
  const hasDbRuntime =
    schema != null ||
    options.forceVirtualDb === true ||
    options.casing !== undefined ||
    dialect !== 'sqlite';
  const d1BindingName = options.d1BindingName ?? 'DB';

  return {
    schema,
    hasDbRuntime,

    resolveId(id: string, importer: string | undefined): string | undefined {
      if (id === '@builtbyfriends/bwf/db') {
        if (!hasDbRuntime) {
          return;
        } /* Decision: A missing runtime falls through to the real module (a stub). Schema files are not redirected,
           to avoid a circular dependency: virtual:platform-db imports the schema, which imports bwf/db.
           Schema files need only the SQL helpers, not the runtime DB instance. */
        if (schema && importer) {
          // Decision: Normalize separators for Windows — Vite uses forward slashes,
          // but schema.path from Node's path.join uses backslashes on Windows.
          const normalizedImporter = normalizePath(importer);
          const normalizedSchemaPath = normalizePath(schema.path);
          if (
            schema.type === 'file' &&
            (normalizedImporter === normalizedSchemaPath ||
              normalizedImporter.startsWith(normalizePath(paths.schemaDir) + '/'))
          ) {
            return VIRTUAL_SCHEMA_DB_ID;
          }
          if (schema.type === 'directory' && normalizedImporter.startsWith(normalizedSchemaPath)) {
            return VIRTUAL_SCHEMA_DB_ID;
          }
        }
        return VIRTUAL_DB_ID;
      }

      // Decision: Resolve @schema alias explicitly via resolveId so it works where
      // Vite's config-level resolve.alias may not be applied.
      if (schema && (id === '@schema' || id.startsWith('@schema/'))) {
        if (id === '@schema') {
          return schema.path;
        }
        return join(schema.path, id.slice('@schema/'.length));
      }
    },

    load: {
      filter: { id: /^\0virtual:platform-db(?:-schema)?$/ },
      handler(id: string): string {
        if (id === VIRTUAL_SCHEMA_DB_ID) {
          return `
export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(drizzleOrmResolved)};
export const db = {};
export function createDb() {
  throw new Error("db: createDb() is unavailable when importing bwf/db from a schema file.");
}
`;
        }

        // Decision: bwf/db virtual module. Each dialect keeps the SQL helper export first: schema files
        // that db/schema.ts reaches from outside db/ import bwf/db while this module is still
        // loading. Vite SSR runs imports in source order, so the helpers must be loaded before
        // the schema import.
        const schemaImport = schema
          ? `import * as schema from ${JSON.stringify(schema.path)};`
          : '';
        const casingOption = options.casing ? `casing: ${JSON.stringify(options.casing)}` : '';
        const drizzleOptions = [schema ? 'schema' : '', casingOption].filter(Boolean);
        const drizzleConfig = drizzleOptions.length > 0 ? `, { ${drizzleOptions.join(', ')} }` : '';
        // Decision: The same options as keys after the client in drizzle's single-object form.
        const drizzleOptionKeys = drizzleOptions.map((option) => `, ${option}`).join('');

        if (dialect === 'mysql') {
          // Decision: drizzle builds the pool from `connection`, so its bare mysql2 import is the only one
          // and the worker prebundle serves it. Its config check rejects `mode` without `schema`.
          const mysqlDrizzleConfig =
            (schema ? ', schema, mode: "default"' : '') + (casingOption ? `, ${casingOption}` : '');
          return `
export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(drizzleOrmResolved)};
import { drizzle } from ${JSON.stringify(drizzleMysql2Resolved)};
import { getRuntimeBinding, getRuntimeRequestResource } from ${JSON.stringify(envModuleResolved)};
${schemaImport}

const _requestResourceKey = {};

function getConnectionString() {
  const url = getRuntimeBinding("DATABASE_URL");
  if (url) return url;
  const hd = getRuntimeBinding("HYPERDRIVE");
  if (hd?.connectionString) return hd.connectionString;
  throw new Error("db: MySQL is not configured. Add DATABASE_URL to .env for local dev, or configure Hyperdrive for production.");
}

// mysql2 closes idle connections only from a timer that it starts when it builds a pool with
// maxIdle below connectionLimit, and that timer runs until the pool ends: workerd rejects it in
// global scope, and nothing ends bwf's pools. Time each connection from its release instead,
// which runs in the request that ran the query.
function closeIdleConnections(pool, idleTimeout) {
  const timers = new WeakMap();
  pool.on("release", (connection) => {
    const timer = setTimeout(() => connection.destroy(), idleTimeout);
    // A Node script that ends its pool exits without waiting for this timer.
    timer.unref?.();
    timers.set(connection, timer);
  });
  pool.on("acquire", (connection) => clearTimeout(timers.get(connection)));
  return pool;
}

function createPools() {
  const pool = closeIdleConnections(
    drizzle({
      connection: {
        uri: getConnectionString(),
        connectionLimit: 1,
        // Workers forbid eval, which mysql2 uses to build its row parsers.
        disableEval: true,
      },
    }).$client,
    1000,
  );
  return { pool, promisePool: pool.promise() };
}

function getPools() {
  // Framework entries that bwf does not own run outside its request scope:
  // they get a client for each use, never one shared across requests.
  return getRuntimeRequestResource(_requestResourceKey, createPools, createPools);
}
${REQUEST_POOL_PROXY}
const promiseClient = requestPool(() => getPools().promisePool);
// drizzle asks for the promise API while it builds the database, which can run in global
// scope. No request exists there to own a pool, so answer without one.
const client = requestPool(() => getPools().pool, { promise: () => promiseClient });

let instance;

export const db = new Proxy({}, {
  get(_, prop) {
    // drizzle reports a query's errors as "Failed query", so build the request's pool here:
    // a missing connection string then throws its own message. Outside a request, build none.
    getRuntimeRequestResource(_requestResourceKey, createPools, () => undefined);
    instance ??= drizzle({ client${mysqlDrizzleConfig} });
    const value = Reflect.get(instance, prop);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export function createDb(connectionString) {
  const db = drizzle({ connection: { uri: connectionString, disableEval: true }${mysqlDrizzleConfig} });
  // 60 seconds is mysql2's own idleTimeout default.
  closeIdleConnections(db.$client, 60000);
  return db;
}
`;
        }

        if (dialect === 'postgresql') {
          // Decision: Like MySQL: drizzle builds the pool, so its bare pg import is the only one.
          return `
export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(drizzleOrmResolved)};
import { drizzle } from ${JSON.stringify(drizzleNodePgResolved)};
import { getRuntimeBinding, getRuntimeRequestResource } from ${JSON.stringify(envModuleResolved)};
${schemaImport}

const _requestResourceKey = {};

function getConnectionString() {
  const url = getRuntimeBinding("DATABASE_URL");
  if (url) return url;
  const hd = getRuntimeBinding("HYPERDRIVE");
  if (hd?.connectionString) return hd.connectionString;
  throw new Error("db: PostgreSQL is not configured. Add DATABASE_URL to .env for local dev, or configure Hyperdrive for production.");
}

function createPool() {
  return drizzle({
    connection: {
      connectionString: getConnectionString(),
      max: 1,
      idleTimeoutMillis: 1000,
    },
  }).$client;
}

function getPool() {
  // Framework entries that bwf does not own run outside its request scope:
  // they get a client for each use, never one shared across requests.
  return getRuntimeRequestResource(_requestResourceKey, createPool, createPool);
}
${REQUEST_POOL_PROXY}
let instance;

export const db = new Proxy({}, {
  get(_, prop) {
    // drizzle reports a query's errors as "Failed query", so build the request's pool here:
    // a missing connection string then throws its own message. Outside a request, build none.
    getRuntimeRequestResource(_requestResourceKey, createPool, () => undefined);
    instance ??= drizzle({ client: requestPool(getPool)${drizzleOptionKeys} });
    const value = Reflect.get(instance, prop);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export function createDb(connectionString) {
  return drizzle(connectionString${drizzleConfig});
}
`;
        }

        return `
export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(drizzleOrmResolved)};
import { drizzle } from ${JSON.stringify(drizzleD1Resolved)};
import { getRuntimeRequestResource } from ${JSON.stringify(envModuleResolved)};
import { createD1SessionAccess, resolveD1SessionStart } from ${JSON.stringify(dbSessionResolved)};
${schemaImport}

const _requestResourceKey = {};
const sessions = createD1SessionAccess(${JSON.stringify(d1BindingName)});

export function setSession(start) {
  sessions.setSession(start);
}

export function getBookmark(client) {
  return sessions.getBookmark(client === db ? undefined : client);
}

export const db = new Proxy({}, {
  get(_, prop) {
    // Promise assimilation and inspection are not database use.
    if (
      prop === 'then' ||
      prop === 'toJSON' ||
      prop === Symbol.toStringTag ||
      prop === Symbol.for('nodejs.util.inspect.custom')
    ) {
      return undefined;
    }
    const instance = getRuntimeRequestResource(
      _requestResourceKey,
      () => drizzle(sessions.getSession()${drizzleConfig}),
      () => drizzle(sessions.getSession()${drizzleConfig})
    );
    return Reflect.get(instance, prop);
  },
});

export function createDb(d1, options) {
  return drizzle(d1.withSession(resolveD1SessionStart(
    options?.session === undefined ? "first-unconstrained" : options.session,
    "createDb"
  ))${drizzleConfig});
}

`;
      },
    },
  };
}

/**
 * Vite plugin for Drizzle integration.
 *
 * - Intercepts `@builtbyfriends/bwf/db` imports in SSR/worker environments and serves
 *   a virtual module that creates a Drizzle DB instance, using the user's
 *   schema when present.
 * - Generates `.bwf/db.d.ts` with proper Drizzle types.
 * - Sets up `@schema` Vite alias for convenient imports when a schema exists.
 * - Updates `.bwf/tsconfig.json` with TypeScript paths.
 */
export function drizzlePlugin(
  root: string,
  hasRouteTypes: boolean,
  dialect: 'sqlite' | 'postgresql' | 'mysql' = 'sqlite',
  options: DrizzlePluginOptions = {},
): Plugin {
  const outDir = join(root, '.bwf');
  const paths = readProjectPaths(root);
  const dbModule = createBwfDbModule(root, dialect, options, paths);
  const { schema, hasDbRuntime } = dbModule;

  // Decision: Always write tsconfig (for routes.d.ts, queues.d.ts, etc.)
  ensureProjectTsconfig(root, hasRouteTypes, hasDbRuntime, schema != null, {
    redirectDbModule: options.redirectDbTypePaths,
    paths,
  });

  if (hasDbRuntime) {
    generateDbDts(outDir, schema ?? null, dialect);
  }

  return {
    name: 'platform:drizzle',
    enforce: 'pre',

    config() {
      if (!schema) {
        return;
      }

      return {
        resolve: {
          alias: {
            '@schema': schema.path,
          },
        },
      };
    },

    resolveId: {
      filter: { id: /^(@builtbyfriends\/bwf\/db|@schema)/ },
      handler(id, importer) {
        if (id === '@builtbyfriends/bwf/db' && this.environment?.name === 'client') {
          return;
        }
        const resolved = dbModule.resolveId(id, importer);
        return resolved;
      },
    },

    load: dbModule.load,

    async configureServer() {
      if (!schema) {
        return;
      }

      const migrationsDir = paths.migrationsDir;
      const hasMigrations =
        existsSync(migrationsDir) && readdirSync(migrationsDir).some((f) => f.endsWith('.sql'));

      if (!hasMigrations) {
        if (dialect === 'sqlite') {
          const { getApplicationTables, getMiniflareDatabasePath } =
            await import('./migrations/runner.ts');
          const dbPath = getMiniflareDatabasePath(
            options.localD1PersistRoot ?? join(root, '.bwf'),
            options.localD1DatabaseId ?? 'local',
          );
          const tables = await getApplicationTables(dbPath).catch(() => []);
          if (tables.length > 0) {
            return;
          }
        }

        bwfWarn(
          `Schema found but no migrations in ${paths.sourceRelative('db/migrations')}/.\n` +
            '         `bwf db push` syncs the schema to your local DB without creating migration files.\n' +
            '         Run `bwf db generate` to create migration files for dev startup and deploy.',
        );
      }
    },
  };
}

/**
 * `@builtbyfriends/bwf/db` and `@schema` for bundles that do not run bwf's Vite plugins, such as the cron and
 * queue handler bundle that deploys build. Without it they load the package's static `@builtbyfriends/bwf/db`, a D1 client without the app's
 * schema. It reads the dialect, schema and D1 binding from the project, as the Vite plugin does.
 * Its hooks are plain Rollup hooks; Vite also needs `enforce` to run them before its resolver.
 *
 * For a bundle that runs in workerd, `sqlDriver` builds a copy of the PostgreSQL or MySQL driver
 * from its entry file, and the plugin serves that module for `pg` or `mysql2` (for
 * `mysql2/promise`, the promise API from the same build). Each import gets the copy that the
 * bundler resolves for it: the generated client's drizzle-orm gets the one it depends on, and an
 * app's own import gets the app's version.
 */
export function bwfDbBundlerPlugin(
  root: string,
  options: {
    config?: BwfConfig;
    sqlDriver?: (dialect: 'postgresql' | 'mysql', entry: string) => Promise<string>;
  } = {},
): Plugin {
  const config = options.config ?? readConfig(root);
  const dialect = getDatabaseDialect(config);
  const d1BindingName = resolveBindingNames(config.inference?.bindings)?.d1;
  const dbModule = createBwfDbModule(
    root,
    dialect,
    // Decision: The package's own `@builtbyfriends/bwf/db` reads D1 from the `DB` binding.
    {
      d1BindingName,
      forceVirtualDb: d1BindingName !== undefined,
      casing: getDatabaseCasing(config),
    },
    resolveProjectPaths(root, config),
  );
  const driverPackage =
    dialect === 'postgresql' ? 'pg' : dialect === 'mysql' ? 'mysql2' : undefined;
  const drivers = new Map<string, Promise<string>>();
  const driverDirs: Array<string> = [];
  return {
    name: 'platform:db',
    enforce: 'pre',
    async resolveId(id, importer, resolveOptions) {
      const promiseApi = driverPackage === 'mysql2' && MYSQL2_PROMISE.test(id);
      if ((id === driverPackage || promiseApi) && options.sqlDriver && dialect !== 'sqlite') {
        // Decision: Resolve it as a `require` would. For an import, Rollup's CommonJS plugin loads a CommonJS
        // driver to wrap it: that hides the file, and its build of the driver can fail on optional
        // native modules.
        const custom = resolveOptions?.custom;
        const resolved = await this.resolve(id, importer, {
          ...resolveOptions,
          skipSelf: true,
          custom: { ...custom, 'node-resolve': { ...custom?.['node-resolve'], isRequire: true } },
        });
        const entry =
          resolved && !resolved.external
            ? resolvePackageEntry(driverPackage, resolved.id)
            : undefined;
        if (entry === undefined) {
          return resolved;
        }
        let driver = drivers.get(entry);
        if (!driver) {
          assertWorkerDriver(driverPackage, entry, root, importer);
          driver = options.sqlDriver(dialect, entry).then((path) => {
            driverDirs.push(`${normalizePath(dirname(path))}/`);
            return path;
          });
          drivers.set(entry, driver);
        }
        // Decision: The promise API sits next to the driver, named the way `sqlDriver` names the driver.
        return promiseApi ? (await driver).replace(/mysql2\.mjs$/, 'promise.mjs') : driver;
      }
      // Decision: The driver needs workerd's own Node modules.
      if (
        id.startsWith('node:') &&
        importer &&
        driverDirs.some((dir) => normalizePath(importer).startsWith(dir))
      ) {
        return { id, external: true };
      }
      const resolved = dbModule.resolveId(id, importer);
      if (resolved !== undefined && id !== '@builtbyfriends/bwf/db') {
        // Decision: `@schema` can name a schema folder or a file without its extension. Only Vite's
        // config alias hands those to a resolver, so apply the bundler's own rules here.
        return this.resolve(resolved, importer, { skipSelf: true });
      }
      return resolved ?? null;
    },
    load(id) {
      if (id !== VIRTUAL_DB_ID && id !== VIRTUAL_SCHEMA_DB_ID) {
        return null;
      }
      return dbModule.load.handler(id);
    },
  };
}

/** mysql2's promise API, which `bundleWorkerSqlDriver` builds next to the driver. */
const MYSQL2_PROMISE = /^mysql2\/promise(?:\.js)?$/;

/**
 * The first driver versions that run in Workers: pg 8.11 brings pg-cloudflare, its socket there,
 * and mysql2 3.13 the `disableEval` option, without which it compiles its parsers with
 * `new Function`, which workerd forbids.
 */
const WORKER_DRIVER_MINIMUM: Record<'pg' | 'mysql2', [major: number, minor: number]> = {
  pg: [8, 11],
  mysql2: [3, 13],
};

/** Throw when the driver whose entry file is `entry` is older than Workers need. */
function assertWorkerDriver(
  name: 'pg' | 'mysql2',
  entry: string,
  root: string,
  importer: string | undefined,
): void {
  let version: string | undefined;
  try {
    const packageJson = createRequire(entry).resolve(`${name}/package.json`);
    ({ version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: string });
  } catch {
    return;
  }
  const match = /^(\d+)\.(\d+)\./.exec(version ?? '');
  const [major, minor] = WORKER_DRIVER_MINIMUM[name];
  if (
    !match ||
    Number(match[1]) > major ||
    (Number(match[1]) === major && Number(match[2]) >= minor)
  ) {
    return;
  }
  const source = importer ? ` Imported by ${relative(root, importer)}.` : '';
  throw new Error(
    `${name} ${version} cannot run in Cloudflare Workers, which need ${name} ${major}.${minor} or later. Upgrade ${name}.${source}`,
  );
}

/**
 * The CommonJS entry of package `name`, from `file` inside one of its copies (which a bundler may
 * have resolved to an ES module entry), or undefined if `file` is not on disk.
 */
function resolvePackageEntry(name: string, file: string): string | undefined {
  if (!isAbsolute(file)) {
    return undefined;
  }
  try {
    return createRequire(file).resolve(name);
  } catch {
    return undefined;
  }
}
