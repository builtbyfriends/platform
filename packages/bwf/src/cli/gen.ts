import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { log, select, isCancel, cancel } from '@voidzero-dev/vite-plus-prompts';
import { join, dirname, relative } from 'pathslash';
import { readConfig, getDatabaseDialect } from '../config.ts';
import type { DatabaseDialect } from '../config.ts';
import { PLACEHOLDER_DB_URL, writeDrizzleConfig } from '../drizzle/config.ts';
import { snapshotDrizzleOutputs } from '../drizzle/generate.ts';
import { collectMigrations, readJournal } from '../migrations/collect.ts';
import { assertJournalCoherence } from '../migrations/validate.ts';
import { readProjectPaths } from '../project-paths.ts';
import type { GenArgs } from './gen-args.ts';
import { isJsonObject } from './json-value.ts';
import { printSuccess } from './output.ts';
import { buildDrizzleKitSpawnEnv, drizzleKitBin } from './yarn-pnp.ts';

export async function runGenCommand(root: string, args: GenArgs): Promise<void> {
  console.log();

  if (args.subcommand === 'model') {
    await runModel(root, args.name, args.columns);
  } else if (args.subcommand === 'migration') {
    runMigration(root, args.name);
  } else if (args.subcommand === 'route') {
    runRoute(root, args.path, args.methods);
  } else if (args.subcommand === 'middleware') {
    runMiddleware(root, args.name);
  } else if (args.subcommand === 'cron') {
    runCron(root, args.name);
  } else if (args.subcommand === 'queue') {
    runQueue(root, args.name);
  } else {
    runProcedure(root, args.name);
  }
}

function writeIfNotExists(filePath: string, content: string): boolean {
  if (existsSync(filePath)) {
    log.warn(`Skipped (already exists): ${filePath}`);
    return false;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  log.step(`Created ${filePath}`);
  return true;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatTimestamp(date: Date): string {
  return (
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds())
  );
}

function getMigrationTimestamp(migrationsDir: string): string {
  const now = new Date();
  let ts = formatTimestamp(now);
  while (readdirSync(migrationsDir).some((f) => f.startsWith(ts + '_'))) {
    now.setSeconds(now.getSeconds() + 1);
    ts = formatTimestamp(now);
  }
  return ts;
}

function getNextMiddlewareNumber(middlewareDir: string): string {
  if (!existsSync(middlewareDir)) {
    return '01';
  }
  const files = readdirSync(middlewareDir);
  let max = 0;
  for (const file of files) {
    const match = file.match(/^(\d+)\./);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return String(max + 1).padStart(2, '0');
}

type ColumnSpec = {
  name: string;
  type: string;
  nullable: boolean;
};

type ColumnBuilder = { fn: string; options?: string };

const TEXT_COLUMN: ColumnBuilder = { fn: 'text' };

// Decision: Types without a builder (`datetime`, `blob`) fall back to a plain `text()` column.
const COLUMN_BUILDERS: Record<DatabaseDialect, Partial<Record<string, ColumnBuilder>>> = {
  sqlite: {
    string: TEXT_COLUMN,
    text: TEXT_COLUMN,
    integer: { fn: 'integer' },
    boolean: { fn: 'integer', options: '{ mode: "boolean" }' },
    real: { fn: 'real' },
  },
  postgresql: {
    string: TEXT_COLUMN,
    text: TEXT_COLUMN,
    integer: { fn: 'integer' },
    boolean: { fn: 'boolean' },
    real: { fn: 'doublePrecision' },
  },
  mysql: {
    string: TEXT_COLUMN,
    text: TEXT_COLUMN,
    integer: { fn: 'int' },
    boolean: { fn: 'boolean' },
    real: { fn: 'double' },
  },
};

const BASE_IMPORTS: Record<DatabaseDialect, Array<string>> = {
  sqlite: ['text', 'integer'],
  postgresql: ['text', 'serial', 'timestamp'],
  mysql: ['int', 'text', 'timestamp'],
};

function drizzleColumnDef(dialect: DatabaseDialect, col: ColumnSpec): string {
  const { name } = col;
  const builder = COLUMN_BUILDERS[dialect][col.type];
  if (!builder) {
    return `  ${name}: text("${name}"),`;
  }
  const args = builder.options ? `"${name}", ${builder.options}` : `"${name}"`;
  const notNull = col.nullable ? '' : '.notNull()';
  const defaultValue = col.type === 'boolean' ? '.default(false)' : '';
  return `  ${name}: ${builder.fn}(${args})${notNull}${defaultValue},`;
}

function drizzleImportsForColumns(
  dialect: DatabaseDialect,
  columns: Array<ColumnSpec>,
): Array<string> {
  const imports = new Set(BASE_IMPORTS[dialect]);
  for (const col of columns) {
    imports.add(COLUMN_BUILDERS[dialect][col.type]?.fn ?? 'text');
  }
  return [...imports].sort();
}

type Validator = 'valibot' | 'zod' | 'arktype' | 'none';

export function detectValidator(root: string): Validator | null {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    return null;
  }

  const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const dependencies = isJsonObject(pkg) && isJsonObject(pkg.dependencies) ? pkg.dependencies : {};
  const devDependencies =
    isJsonObject(pkg) && isJsonObject(pkg.devDependencies) ? pkg.devDependencies : {};
  const allDeps = { ...dependencies, ...devDependencies };

  if ('valibot' in allDeps) {
    return 'valibot';
  }
  if ('zod' in allDeps) {
    return 'zod';
  }
  if ('arktype' in allDeps) {
    return 'arktype';
  }
  return null;
}

async function resolveValidator(root: string): Promise<Validator> {
  const detected = detectValidator(root);
  if (detected) {
    log.info(`Detected validator: ${detected}`);
    return detected;
  }

  const choice = await select({
    message: 'No validation library detected. Which would you like to use?',
    options: [
      { value: 'valibot', label: 'Valibot' },
      { value: 'zod', label: 'Zod' },
      { value: 'arktype', label: 'ArkType' },
      { value: 'none', label: 'No validation' },
    ],
  });

  if (isCancel(choice) || typeof choice === 'symbol') {
    cancel('Cancelled.');
    process.exit(0);
  }

  if (choice !== 'none') {
    log.warn(`Remember to install ${choice}: npm install ${choice}`);
  }

  return choice;
}

type SchemaValidator = Exclude<Validator, 'none'>;

type ValidatorTypes = {
  string: string;
  number: string;
  boolean: string;
  blob: string;
  optional: (base: string) => string;
};

const VALIDATOR_TYPES: Record<SchemaValidator, ValidatorTypes> = {
  valibot: {
    string: 'v.string()',
    number: 'v.number()',
    boolean: 'v.boolean()',
    blob: 'v.instance(Blob)',
    optional: (base) => `v.optional(${base})`,
  },
  zod: {
    string: 'z.string()',
    number: 'z.number()',
    boolean: 'z.boolean()',
    blob: 'z.instanceof(Blob)',
    optional: (base) => `${base}.optional()`,
  },
  arktype: {
    string: 'string',
    number: 'number',
    boolean: 'boolean',
    blob: 'instanceof Blob',
    optional: (base) => `${base} | undefined`,
  },
};

// Decision: Column types not listed here (`string`, `text`, `datetime`) validate as strings.
const VALUE_KINDS = new Map<string, 'number' | 'boolean' | 'blob'>([
  ['integer', 'number'],
  ['real', 'number'],
  ['boolean', 'boolean'],
  ['blob', 'blob'],
]);

function validatorType(validator: SchemaValidator, col: ColumnSpec): string {
  const types = VALIDATOR_TYPES[validator];
  const base = types[VALUE_KINDS.get(col.type) ?? 'string'];
  return col.nullable ? types.optional(base) : base;
}

function getImportLine(validator: Validator): string | null {
  switch (validator) {
    case 'valibot':
      return 'import * as v from "valibot";';
    case 'zod':
      return 'import { z } from "zod";';
    case 'arktype':
      return 'import { type } from "arktype";';
    case 'none':
      return null;
  }
}

function getBodySchema(validator: SchemaValidator, columns: Array<ColumnSpec>): string {
  if (validator === 'arktype') {
    const fields = columns
      .map((c) => `    ${c.name}: "${validatorType(validator, c)}",`)
      .join('\n');
    return `type({\n${fields}\n  })`;
  }
  const fields = columns.map((c) => `    ${c.name}: ${validatorType(validator, c)},`).join('\n');
  const prefix = validator === 'valibot' ? 'v' : 'z';
  return `${prefix}.object({\n${fields}\n  })`;
}

function getParamsSchema(validator: Validator): string {
  switch (validator) {
    case 'valibot':
      return 'v.object({ id: v.string() })';
    case 'zod':
      return 'z.object({ id: z.string() })';
    case 'arktype':
      return 'type({ id: "string" })';
    case 'none':
      return '';
  }
}

function generateIndexRoute(
  name: string,
  columns: Array<ColumnSpec>,
  validator: Validator,
): string {
  const importLine = getImportLine(validator);
  const imports = [
    importLine,
    'import { defineHandler } from "@builtbyfriends/bwf";',
    'import { db } from "@builtbyfriends/bwf/db";',
    `import { ${name} } from "@schema";`,
  ]
    .filter(Boolean)
    .join('\n');

  const insertFields = columns.map((c) => `${c.name}: body.${c.name}`).join(', ');

  if (columns.length === 0 || validator === 'none') {
    const values = columns.length > 0 ? `{ ${insertFields} }` : 'body';
    return `import { defineHandler } from "@builtbyfriends/bwf";
import { db } from "@builtbyfriends/bwf/db";
import { ${name} } from "@schema";

export const GET = defineHandler(async () => {
  return db.select().from(${name});
});

export const POST = defineHandler(async (c) => {
  const body = await c.req.json();
  await db.insert(${name}).values(${values});
  return { created: true };
});
`;
  }

  const bodySchema = getBodySchema(validator, columns);
  return `${imports}

export const GET = defineHandler(async () => {
  return db.select().from(${name});
});

export const POST = defineHandler.withValidator({
  body: ${bodySchema},
})(async (c, { body }) => {
  await db.insert(${name}).values({ ${insertFields} });
  return { created: true };
});
`;
}

function generateIdRoute(name: string, validator: Validator): string {
  if (validator === 'none') {
    return `import { defineHandler } from "@builtbyfriends/bwf";
import { db, eq } from "@builtbyfriends/bwf/db";
import { ${name} } from "@schema";

export const GET = defineHandler(async (c) => {
  const id = c.req.param("id");
  const [row] = await db.select().from(${name}).where(eq(${name}.id, Number(id)));

  if (!row) {
    return new Response("Not found", { status: 404 });
  }
  return row;
});
`;
  }

  const importLine = getImportLine(validator) ?? '';
  const paramsSchema = getParamsSchema(validator);

  return `${importLine}
import { defineHandler } from "@builtbyfriends/bwf";
import { db, eq } from "@builtbyfriends/bwf/db";
import { ${name} } from "@schema";

export const GET = defineHandler.withValidator({
  params: ${paramsSchema},
})(async (c, { params }) => {
  const [row] = await db.select().from(${name}).where(eq(${name}.id, Number(params.id)));

  if (!row) {
    return new Response("Not found", { status: 404 });
  }
  return row;
});
`;
}

async function runModel(root: string, name: string, columns: Array<ColumnSpec>): Promise<void> {
  const validator = await resolveValidator(root);

  const dialect = getDatabaseDialect(readConfig(root));
  const paths = readProjectPaths(root);

  const schemaDir = paths.schemaDir;
  const barrelPath = paths.schemaFile;
  const modelPath = join(schemaDir, `${name}.ts`);

  const colDefs = columns.map((col) => drizzleColumnDef(dialect, col));
  const columnImports = drizzleImportsForColumns(dialect, columns).join(', ');
  let content: string;
  if (dialect === 'postgresql') {
    content = [
      `import { pgTable, ${columnImports} } from "@builtbyfriends/bwf/schema-pg";`,
      '',
      `export const ${name} = pgTable("${name}", {`,
      `  id: serial("id").primaryKey(),`,
      ...colDefs,
      `  createdAt: timestamp("created_at").notNull().defaultNow(),`,
      `  updatedAt: timestamp("updated_at").notNull().defaultNow(),`,
      '});',
      '',
    ].join('\n');
  } else if (dialect === 'mysql') {
    content = [
      `import { mysqlTable, ${columnImports} } from "@builtbyfriends/bwf/schema-mysql";`,
      '',
      `export const ${name} = mysqlTable("${name}", {`,
      `  id: int("id").autoincrement().primaryKey(),`,
      ...colDefs,
      `  createdAt: timestamp("created_at").notNull().defaultNow(),`,
      `  updatedAt: timestamp("updated_at").notNull().defaultNow(),`,
      '});',
      '',
    ].join('\n');
  } else {
    content = [
      `import { sqliteTable, ${columnImports} } from "@builtbyfriends/bwf/schema-d1";`,
      `import { sql } from "@builtbyfriends/bwf/db";`,
      '',
      `export const ${name} = sqliteTable("${name}", {`,
      `  id: integer("id").primaryKey({ autoIncrement: true }),`,
      ...colDefs,
      '  createdAt: text("created_at").notNull().default(sql`(datetime(\'now\'))`),',
      '  updatedAt: text("updated_at").notNull().default(sql`(datetime(\'now\'))`),',
      '});',
      '',
    ].join('\n');
  }

  mkdirSync(schemaDir, { recursive: true });
  writeIfNotExists(modelPath, content);

  const exportLine = `export * from "./schema/${name}";`;
  if (existsSync(barrelPath)) {
    const existing = readFileSync(barrelPath, 'utf8');
    if (!existing.includes(exportLine)) {
      writeFileSync(barrelPath, existing.trimEnd() + '\n' + exportLine + '\n');
    }
  } else {
    writeFileSync(barrelPath, exportLine + '\n');
  }

  // Decision: Regenerate .bwf, including all files that .bwf/tsconfig.json lists.
  const { prepareProject } = await import('../codegen/prepare.ts');
  await prepareProject(root);

  log.step(`Created ${relative(root, modelPath)}`);
  log.step(`Updated ${relative(root, barrelPath)}`);

  const routeIndexPath = join(paths.routesDir, 'api', name, 'index.ts');
  writeIfNotExists(routeIndexPath, generateIndexRoute(name, columns, validator));

  const routeIdPath = join(paths.routesDir, 'api', name, '[id].ts');
  writeIfNotExists(routeIdPath, generateIdRoute(name, validator));

  printSuccess('Model scaffolding complete. Run `bwf db push` to apply.');
}

function runMigration(root: string, name: string): void {
  const paths = readProjectPaths(root);
  const migrationsDir = paths.migrationsDir;
  const dir = paths.sourceRelative('db/migrations');
  mkdirSync(migrationsDir, { recursive: true });

  // Decision: The same preflight as the other db commands, before any write. It runs before the bundle check so
  // a leftover migrations.js without a journal gets the partial-state recovery advice.
  const currentMigrations = collectMigrations(migrationsDir);
  try {
    assertJournalCoherence(migrationsDir, currentMigrations, paths.sourceRelative);
  } catch (error: unknown) {
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // Decision: Bundled mode needs a matching `m000N` import in migrations.js for each journal entry, and only
  // drizzle-kit can regenerate that file.
  const bundlePath = join(migrationsDir, 'migrations.js');
  if (existsSync(bundlePath)) {
    log.error(
      `Your project uses Drizzle's bundled migration format (${dir}/migrations.js).\n` +
        '`bwf gen migration` cannot add custom hand-written migrations to a bundled project\n' +
        'because the bundle must be regenerated by drizzle-kit.\n\n' +
        'Either run `drizzle-kit generate` to regenerate the bundle, or migrate away from\n' +
        `bundled mode by deleting ${dir}/migrations.js and re-running \`bwf db generate\`.`,
    );
    process.exit(1);
  }

  // Decision: With journal entries, delegate to `drizzle-kit generate --custom`: it also snapshots the current
  // schema, so the next `bwf db generate` doesn't emit again DDL that the custom migration applies.
  const existingJournal = readJournal(migrationsDir, paths.sourceRelative);
  const lastEntry = existingJournal?.entries.at(-1);
  if (existingJournal !== undefined && lastEntry !== undefined) {
    const metaDir = join(migrationsDir, 'meta');
    // Decision: Use the snapshot named by the last journal tag, not the newest file in meta/, which may be a
    // stale leftover.
    const lastSnapshotPrefix = lastEntry.tag.split('_')[0];
    const prevSnapshotPath = join(metaDir, `${lastSnapshotPrefix}_snapshot.json`);
    if (!existsSync(prevSnapshotPath)) {
      log.error(
        `${dir}/meta/_journal.json's last entry is \`${lastEntry.tag}\` but the matching snapshot \`${lastSnapshotPrefix}_snapshot.json\` is missing under meta/.`,
      );
      log.error(
        'Restore the snapshot from version control, or regenerate migrations with `bwf db generate` before running `bwf gen migration`.',
      );
      process.exit(1);
    }

    const rollBack = snapshotDrizzleOutputs(migrationsDir);
    const sqlFilesBefore = new Set(readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')));

    // Decision: The existing snapshot chain was built for the journal's dialect. Refuse instead of appending a
    // snapshot in a different dialect.
    let journalDialect: 'sqlite' | 'postgresql' | 'mysql';
    if (existingJournal.dialect === 'sqlite') {
      journalDialect = 'sqlite';
    } else if (existingJournal.dialect === 'postgresql') {
      journalDialect = 'postgresql';
    } else if (existingJournal.dialect === 'mysql') {
      journalDialect = 'mysql';
    } else {
      log.error(
        `${dir}/meta/_journal.json has an unsupported dialect: \`${existingJournal.dialect}\`.`,
      );
      log.error(
        `bwf supports \`sqlite\`, \`postgresql\`, and \`mysql\` only. Restore the journal from version control, or drop ${dir}/ and regenerate from scratch.`,
      );
      process.exit(1);
    }
    const configDialect = getDatabaseDialect(readConfig(root));
    if (configDialect !== journalDialect) {
      log.error(
        `${dir}/meta/_journal.json was generated for ${journalDialect}, but bwf.config.ts is configured for ${configDialect}.`,
      );
      log.error(
        `Generating a new custom migration now would append a snapshot in the wrong dialect. Revert bwf.config.ts's \`database\` field to ${journalDialect}, or drop ${dir}/ and regenerate from scratch.`,
      );
      process.exit(1);
    }
    const authSchemaPath = join(root, '.bwf', 'better-auth-schema.ts');
    const additionalSchemas = existsSync(authSchemaPath) ? [authSchemaPath] : undefined;
    const configPath = writeDrizzleConfig(
      root,
      PLACEHOLDER_DB_URL[journalDialect],
      journalDialect,
      { additionalSchemas },
    );

    const result = spawnSync(
      process.execPath,
      [drizzleKitBin, 'generate', '--config', configPath, '--custom', '--name', name],
      {
        cwd: root,
        stdio: 'pipe',
        encoding: 'utf8',
        // Decision: Yarn PnP projects need the PnP loader to resolve `@builtbyfriends/bwf/schema-*`.
        env: buildDrizzleKitSpawnEnv(root),
      },
    );

    if (result.error || result.status !== 0) {
      rollBack();
      const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
      log.error(
        [
          `Failed to run \`drizzle-kit generate --custom --name ${name}\`.`,
          ...(detail ? [detail] : []),
          '',
          `This is usually a schema-compilation error. Fix any TypeScript errors in ${paths.sourceRelative('db/schema.ts')} and try again.`,
        ].join('\n'),
      );
      process.exit(1);
    }

    const newSqlFile = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .find((f) => !sqlFilesBefore.has(f));
    if (newSqlFile) {
      log.step(`Created ${dir}/${newSqlFile}`);
    }

    printSuccess('Migration created and journal updated.');
    return;
  }

  const timestamp = getMigrationTimestamp(migrationsDir);
  const tag = `${timestamp}_${name}`;
  const filePath = join(migrationsDir, `${tag}.sql`);

  if (writeIfNotExists(filePath, `-- ${name}\n`)) {
    printSuccess('Migration created.');
  }
}

function runRoute(root: string, routePath: string, methods: Array<string>): void {
  const filePath = join(readProjectPaths(root).routesDir, routePath + '.ts');
  const exports = methods
    .map((m) => {
      const upper = m.toUpperCase();
      return `export const ${upper} = defineHandler(async () => {
  return { message: "${upper} ${routePath}" };
});`;
    })
    .join('\n\n');

  const content = `import { defineHandler } from "@builtbyfriends/bwf";

${exports}
`;
  if (writeIfNotExists(filePath, content)) {
    printSuccess('Route created.');
  }
}

function runMiddleware(root: string, name: string): void {
  const middlewareDir = readProjectPaths(root).middlewareDir;
  mkdirSync(middlewareDir, { recursive: true });

  const num = getNextMiddlewareNumber(middlewareDir);
  const filePath = join(middlewareDir, `${num}.${name}.ts`);
  const content = `import { defineMiddleware } from "@builtbyfriends/bwf";

export default defineMiddleware(async (c, next) => {
  // TODO: implement ${name} middleware
  await next();
});
`;
  if (writeIfNotExists(filePath, content)) {
    printSuccess('Middleware created.');
  }
}

function runCron(root: string, name: string): void {
  const filePath = join(readProjectPaths(root).cronsDir, name + '.ts');
  const content = `import { defineScheduled } from "@builtbyfriends/bwf";

export const cron = "* * * * *";

export default defineScheduled(async (controller, env) => {
  // TODO: implement ${name}
});
`;
  if (writeIfNotExists(filePath, content)) {
    printSuccess('Cron job created.');
  }
}

function runQueue(root: string, name: string): void {
  const filePath = join(readProjectPaths(root).queuesDir, name + '.ts');
  const content = `import { defineQueue } from "@builtbyfriends/bwf";

type Message = {};

// export const maxBatchSize = 10;
// export const maxBatchTimeout = 5;
// export const maxConcurrency = 2;

export default defineQueue<Message>(async (batch, env) => {
  for (const message of batch.messages) {
    // TODO: process message
  }
});
`;
  if (writeIfNotExists(filePath, content)) {
    printSuccess('Queue consumer created.');
  }
}

function runProcedure(root: string, name: string): void {
  const segments = name.split('.');
  const exportName = segments.pop() ?? name;
  const filePath = join(readProjectPaths(root).proceduresDir, ...segments) + '.ts';
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
  if (existing && new RegExp(`export const ${exportName}\\b`).test(existing)) {
    log.warn(`Skipped (already exists): ${name} in ${filePath}`);
    return;
  }
  const body = `// Decide each step below before deploying: an unfinished procedure stops the Worker
// from starting. Each step takes a choice (.auth, .input, ...) or an opt-out with a
// reason (.noAuth({ reason }), .noInput({ reason }), ...).
export const ${exportName} = procedure()
  .auth(signedIn)
  // .input(schema) | .noInput({ reason })
  // .output(schema)
  // .authz({ policy, check }) | .noAuthz({ reason })
  // .errors({ NOT_FOUND: { status: 404, message: "..." } }) | .noErrors({ reason })
  // .analytics(...) | .noAnalytics({ reason })
  // .mcp(...) | .noMcp({ reason })
  // .cli(...) | .noCli({ reason })
  // .aiTool(...) | .noAiTool({ reason })
  .handler(({ input, ctx, env }) => {
    // TODO: implement ${name}
  });
`;
  mkdirSync(dirname(filePath), { recursive: true });
  if (existing) {
    writeFileSync(filePath, existing.replace(/\n*$/, '\n\n') + body);
    log.step(`Added ${name} to ${filePath}`);
  } else {
    writeFileSync(
      filePath,
      `import { procedure, signedIn } from "@builtbyfriends/bwf/procedure";\n\n${body}`,
    );
    log.step(`Created ${filePath}`);
  }
  printSuccess('Procedure created.');
}
