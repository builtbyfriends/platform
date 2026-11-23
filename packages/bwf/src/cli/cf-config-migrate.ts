import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '@builtbyfriends/deploy-core';
import {
  bindings,
  CloudflareConfigSchema,
  exports as workerExports,
  triggers,
} from '@cloudflare/config';
import { convertWranglerConfig } from './cf-config-convert/config-converter.ts';
import type { MigrationFollowUp, OutputValue } from './cf-config-convert/types.ts';

type JsonObject = Record<string, unknown>;

export function record(value: unknown): JsonObject | null {
  return isRecord(value) ? value : null;
}

function recordList(value: unknown): Array<JsonObject> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items: Array<JsonObject> = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    items.push(entry);
  }
  return items;
}

function empty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0) ||
    (record(value) !== null && Object.keys(value).length === 0)
  );
}

function normalizeQueueConcurrency(raw: JsonObject): JsonObject {
  const queues = record(raw.queues);
  if (!Array.isArray(queues?.consumers)) {
    return { ...raw };
  }
  return {
    ...raw,
    queues: {
      ...queues,
      consumers: queues.consumers.map((value: unknown) => {
        const consumer = record(value);
        // Decision: Wrangler's null and cf's omitted limit both mean automatic concurrency.
        if (consumer?.max_concurrency !== null) {
          return value;
        }
        const { max_concurrency: _automatic, ...rest } = consumer;
        return rest;
      }),
    },
  };
}

/** Remove build-only fields and settings translated into cf's typed config below. */
function migrationInput(raw: JsonObject): JsonObject {
  const result = normalizeQueueConcurrency(raw);
  const environments = record(result.env);
  if (environments) {
    result.env = Object.fromEntries(
      Object.entries(environments).map(([name, value]) => {
        const environment = record(value);
        return [name, environment ? normalizeQueueConcurrency(environment) : value];
      }),
    );
  }
  if (
    !empty(result.rules) &&
    !isDeepStrictEqual(result.rules, [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }])
  ) {
    throw new Error('cf cannot yet preserve custom Worker module rules in a prebuilt bundle.');
  }
  if (empty(result.logfwdr) || isDeepStrictEqual(result.logfwdr, { bindings: [] })) {
    delete result.logfwdr;
  }
  for (const key of [
    'configPath',
    'userConfigPath',
    'topLevelName',
    'main',
    'jsx_factory',
    'jsx_fragment',
    'rules',
    'python_modules',
    'dev',
    'no_bundle',
    'build',
    'keep_vars',
    'keep_secrets',
    'keep_assets',
    'send_metrics',
    'workflows',
  ]) {
    delete result[key];
  }
  for (const [key, value] of Object.entries(result)) {
    if (empty(value)) {
      delete result[key];
    }
  }
  return result;
}

function applyPreservationFlags(raw: JsonObject, worker: JsonObject): void {
  // Decision: cf forwards unsafe.metadata to the Worker upload metadata, including these API flags.
  // A written keep_bindings replaces cf's default, which keeps secrets. Wrangler adds the secret types
  // next to keep_vars, so keep_vars alone mustn't drop secrets either.
  const keepBindings =
    raw.keep_vars === true || raw.keep_secrets === true
      ? [...(raw.keep_vars === true ? ['plain_text', 'json'] : []), 'secret_text', 'secret_key']
      : [];
  if (keepBindings.length === 0 && raw.keep_assets !== true) {
    return;
  }
  const unsafe = record(worker.unsafe) ?? {};
  const metadata = record(unsafe.metadata) ?? {};
  const previous = metadata.keep_bindings;
  if (
    previous !== undefined &&
    (!Array.isArray(previous) || !previous.every((value) => typeof value === 'string'))
  ) {
    throw new Error('Invalid keep_bindings in the built Cloudflare config.');
  }
  worker.unsafe = {
    ...unsafe,
    metadata: {
      ...metadata,
      ...(keepBindings.length > 0 && {
        keep_bindings: [...new Set([...(previous ?? []), ...keepBindings])],
      }),
      ...(raw.keep_assets === true && { keep_assets: true }),
    },
  };
}

function applyWorkflows(raw: JsonObject, worker: JsonObject): void {
  if (empty(raw.workflows)) {
    return;
  }
  if (!Array.isArray(raw.workflows)) {
    throw new Error('Invalid Workflow bindings in the built Cloudflare config.');
  }
  const env = record(worker.env) ?? {};
  const exports = record(worker.exports) ?? {};
  for (const item of raw.workflows) {
    const workflow = record(item);
    if (
      !workflow ||
      typeof workflow.binding !== 'string' ||
      typeof workflow.name !== 'string' ||
      typeof workflow.class_name !== 'string' ||
      (workflow.script_name !== undefined && typeof workflow.script_name !== 'string')
    ) {
      throw new Error('Invalid Workflow binding in the built Cloudflare config.');
    }
    const allowed = new Set([
      'binding',
      'name',
      'class_name',
      'script_name',
      'limits',
      'concurrency',
      'schedules',
      'default_retention',
    ]);
    for (const key of Object.keys(workflow)) {
      if (!allowed.has(key)) {
        throw new Error(`cf cannot migrate Workflow setting ${key}.`);
      }
    }
    if (Object.hasOwn(env, workflow.binding)) {
      throw new Error(`Duplicate Worker binding ${workflow.binding}.`);
    }
    env[workflow.binding] = {
      type: 'workflow',
      name: workflow.name,
      worker: workflow.script_name ?? worker.name,
      exportName: workflow.class_name,
    };
    if (workflow.script_name !== undefined && workflow.script_name !== worker.name) {
      continue;
    }
    const retention = record(workflow.default_retention);
    if (Object.hasOwn(exports, workflow.class_name)) {
      throw new Error(`Duplicate Worker export ${workflow.class_name}.`);
    }
    const schedules =
      Array.isArray(workflow.schedules) && workflow.schedules.length === 0
        ? undefined
        : workflow.schedules;
    exports[workflow.class_name] = {
      type: 'workflow',
      name: workflow.name,
      ...(workflow.limits !== undefined && { limits: workflow.limits }),
      ...(workflow.concurrency !== undefined && { concurrency: workflow.concurrency }),
      ...(schedules !== undefined && { schedules }),
      ...(!!retention && {
        defaultRetention: {
          ...(retention.success_retention !== undefined && {
            successRetention: retention.success_retention,
          }),
          ...(retention.error_retention !== undefined && {
            errorRetention: retention.error_retention,
          }),
        },
      }),
    };
  }
  worker.env = env;
  worker.exports = exports;
}

function assertHandledFollowUps(followUps: Array<MigrationFollowUp>): void {
  for (const item of followUps) {
    if (!item.blocking) {
      continue;
    }
    // Decision: We use only Worker settings for prebuilt output, not the generated Vite config.
    // Upgrading that unused config's plugin isn't needed; keep other follow-ups blocking.
    if (item.code === 'vite-plugin-install-disabled' && item.sourcePath === undefined) {
      continue;
    }
    const path = item.sourcePath ?? item.code;
    const handled =
      ((path === 'assets.directory' || /^env\.[^.]+\.assets\.directory$/.test(path)) &&
        item.message.includes('assets directory')) ||
      (/^d1_databases\.\d+$/.test(path) && /`migrations_(?:dir|table)`/.test(item.message)) ||
      /^durable_objects\.bindings\.\d+$/.test(path) ||
      path === 'migrations' ||
      path === 'containers';
    if (!handled) {
      throw new Error(`cf cannot migrate Cloudflare setting ${path}: ${item.message}`);
    }
  }
}

function durableObjectExports(raw: JsonObject) {
  const migrations = raw.migrations;
  if (migrations === undefined || (Array.isArray(migrations) && migrations.length === 0)) {
    return {};
  }
  const migrationList = recordList(migrations);
  if (!migrationList) {
    throw new Error('Invalid Durable Object migrations in the built Cloudflare config.');
  }
  const exports: JsonObject = {};
  for (const migration of migrationList) {
    const known = new Set([
      'tag',
      'new_classes',
      'new_sqlite_classes',
      'renamed_classes',
      'deleted_classes',
    ]);
    for (const key of Object.keys(migration)) {
      if (!known.has(key)) {
        throw new Error(`cf cannot migrate Durable Object migration setting ${key}.`);
      }
    }
    for (const [field, storage] of [
      ['new_classes', 'legacy-kv'],
      ['new_sqlite_classes', 'sqlite'],
    ] as const) {
      const classes = migration[field] ?? [];
      if (!Array.isArray(classes) || !classes.every((name) => typeof name === 'string')) {
        throw new Error(`Invalid ${field} in the built Cloudflare config.`);
      }
      for (const name of classes) {
        exports[name] = { type: 'durable-object', storage };
      }
    }
    const renamed = migration.renamed_classes ?? [];
    const renamedList = recordList(renamed);
    if (!renamedList) {
      throw new Error('Invalid renamed_classes in the built Cloudflare config.');
    }
    for (const item of renamedList) {
      if (typeof item.from !== 'string' || typeof item.to !== 'string') {
        throw new Error('Invalid Durable Object class rename in the built Cloudflare config.');
      }
      const old = record(exports[item.from]);
      if (!old || (old.storage !== 'sqlite' && old.storage !== 'legacy-kv')) {
        throw new Error(`Cannot determine the storage of renamed Durable Object ${item.from}.`);
      }
      exports[item.from] = { type: 'durable-object', state: 'renamed', renamedTo: item.to };
      exports[item.to] = { type: 'durable-object', storage: old.storage };
    }
    const deleted = migration.deleted_classes ?? [];
    if (!Array.isArray(deleted) || !deleted.every((name) => typeof name === 'string')) {
      throw new Error('Invalid deleted_classes in the built Cloudflare config.');
    }
    for (const name of deleted) {
      exports[name] = { type: 'durable-object', state: 'deleted' };
    }
  }
  return exports;
}

type SandboxImage = { dockerfile: string; buildContext?: string } | { reference: string };

function containersFromWrangler(raw: JsonObject, exports: JsonObject): Array<JsonObject> {
  const values = raw.containers;
  if (values === undefined) {
    return [];
  }
  const valueList = recordList(values);
  if (!valueList) {
    throw new Error('Invalid Containers in the built Cloudflare config.');
  }
  return valueList.map((value) => {
    if (typeof value.name !== 'string' || typeof value.class_name !== 'string') {
      throw new Error('cf requires a name and class_name for each Container.');
    }
    const managed = value.scheduling_policy === 'durable_object';
    const fields = new Set(
      managed
        ? ['name', 'class_name', 'scheduling_policy', 'images']
        : ['name', 'class_name', 'image', 'max_instances', 'instance_type'],
    );
    for (const key of Object.keys(value)) {
      if (!fields.has(key)) {
        throw new Error(`cf cannot migrate Container setting ${key}.`);
      }
    }
    const declaration = record(exports[value.class_name]);
    if (!declaration || declaration.storage !== 'sqlite') {
      throw new Error(`Container ${value.name} needs a SQLite Durable Object export.`);
    }
    declaration.container = value.name;
    if (managed) {
      const images = record(value.images);
      if (!images) {
        throw new Error('A Sandbox requires a named image.');
      }
      return {
        name: value.name,
        schedulingPolicy: 'durable-object',
        images: Object.fromEntries(
          Object.entries(images).map(([name, image]): [string, SandboxImage] => {
            const source = record(image);
            if (
              !source ||
              Object.keys(source).some(
                (key) => !['dockerfile', 'build_context', 'image'].includes(key),
              ) ||
              (source.dockerfile !== undefined && source.image !== undefined) ||
              (source.build_context !== undefined && typeof source.build_context !== 'string')
            ) {
              throw new Error('Invalid Sandbox image.');
            }
            if (typeof source.dockerfile === 'string') {
              return [
                name,
                {
                  dockerfile: source.dockerfile,
                  ...(typeof source.build_context === 'string' && {
                    buildContext: source.build_context,
                  }),
                },
              ];
            }
            if (typeof source.image === 'string') {
              return [name, { reference: source.image }];
            }
            throw new Error('Invalid Sandbox image source.');
          }),
        ),
      };
    }
    if (typeof value.image !== 'string') {
      throw new Error('A Container requires an image.');
    }
    return {
      name: value.name,
      image: { reference: value.image },
      ...(typeof value.max_instances === 'number' && { maxInstances: value.max_instances }),
      ...(typeof value.instance_type === 'string' && { instanceType: value.instance_type }),
    };
  });
}

const configHelpers = new Map<string, Map<string, unknown>>([
  ['bindings', new Map(Object.entries(bindings))],
  ['exports', new Map(Object.entries(workerExports))],
  ['triggers', new Map(Object.entries(triggers))],
]);

function isConfigHelper(value: unknown): value is (...args: Array<unknown>) => unknown {
  return typeof value === 'function';
}

/** Build the value that the converter describes, calling cf's config helpers where it names one. */
function outputValue(value: OutputValue): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(outputValue);
  }
  if (value.kind === 'call') {
    const [namespace, name] = value.callee.split('.');
    const helper = configHelpers.get(namespace)?.get(name);
    if (!isConfigHelper(helper)) {
      throw new Error(`cf has no configuration helper ${value.callee}.`);
    }
    const built: unknown = helper(...value.args.map(outputValue));
    return built;
  }
  return Object.fromEntries(
    value.properties.map(({ key, value: item }) => [key, outputValue(item)]),
  );
}

export type WranglerTranslation = { config: unknown; followUps: Array<MigrationFollowUp> };

/**
 * Translate Wrangler-format settings to a parsed cf configuration and the follow-ups that the
 * converter could not translate. `mode` selects a Wrangler environment by name.
 */
export function translateWranglerConfig(raw: JsonObject, mode: string): WranglerTranslation {
  // Decision: Settings are JSON: a key without a value is absent. The copy also keeps the converter from sharing
  // objects with the caller.
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the JSON round trip drops keys without a value, which structuredClone keeps
  const settings: unknown = JSON.parse(JSON.stringify(raw));
  if (!isRecord(settings)) {
    throw new TypeError('The Wrangler settings are not an object.');
  }
  const converted = convertWranglerConfig(settings, 'vite', []);
  const branch = converted.environments.get(mode) ?? converted.base;
  const input = record(outputValue(branch.config));
  const worker = record(input?.worker);
  const env = record(worker?.env);
  if (input && worker && env) {
    // Decision: A binding that's switched off is absent from the parsed configuration.
    input.worker = {
      ...worker,
      env: Object.fromEntries(
        Object.entries(env).filter(
          ([, binding]) => binding !== false && binding !== null && binding !== undefined,
        ),
      ),
    };
  }
  const parsed = CloudflareConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('cf could not translate the built Cloudflare configuration.');
  }
  // Decision: Only JSON values, because the settings will be written to a file.
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the JSON round trip keeps only JSON values
  const config: unknown = JSON.parse(JSON.stringify(parsed.data));
  return { config, followUps: converted.followUps };
}

type MigratedConfig = ReturnType<typeof CloudflareConfigSchema.parse>;

export function migrateBuiltWranglerConfig(raw: JsonObject, mode = 'production'): MigratedConfig {
  const environment = record(record(raw.env)?.[mode]);
  const effective = environment ? { ...raw, ...environment } : raw;
  if (environment) {
    for (const key of ['durable_objects', 'workflows', 'containers']) {
      if (!(key in environment)) {
        delete effective[key];
      }
    }
  }
  const migration = translateWranglerConfig(migrationInput(raw), mode);
  assertHandledFollowUps(migration.followUps);
  const result = record(migration.config);
  const worker = record(result?.worker);
  if (!result || !worker) {
    throw new Error('cf did not generate a Worker configuration.');
  }
  applyPreservationFlags(effective, worker);
  applyWorkflows(effective, worker);
  const exports = { ...record(worker.exports), ...durableObjectExports(effective) };
  const containers = containersFromWrangler(effective, exports);
  if (containers.length > 0) {
    const envBindings = record(worker.env);
    const durableBindings = record(effective.durable_objects)?.bindings;
    if (!envBindings || !Array.isArray(durableBindings)) {
      throw new Error('A Container Durable Object binding was not found in the built config.');
    }
    const effectiveContainers = recordList(effective.containers) ?? [];
    for (const container of containers) {
      const className = effectiveContainers.find(
        (entry) => entry.name === container.name,
      )?.class_name;
      const binding: unknown = durableBindings.find(
        (entry: unknown) => record(entry)?.class_name === className,
      );
      if (
        !isRecord(binding) ||
        typeof binding.name !== 'string' ||
        (binding.script_name !== undefined && binding.script_name !== worker.name)
      ) {
        throw new Error(`Container ${container.name} must use a local Durable Object binding.`);
      }
      // Decision: cf's typed Durable Object binding serializes even a self reference with script_name, and its
      // Container uploader reads any script_name as an external Worker. The unsafe binding is the same
      // upload metadata without that external-script marker.
      envBindings[binding.name] = {
        type: 'unsafe:durable_object_namespace',
        class_name: className,
      };
    }
    result.containers = containers;
  }
  if (Object.keys(exports).length > 0) {
    worker.exports = exports;
  }
  return CloudflareConfigSchema.parse(result);
}
