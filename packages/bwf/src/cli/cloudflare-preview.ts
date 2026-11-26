import { type } from 'arktype';
import type { Type } from 'arktype';
import type { PreviewBuild } from './cf-build-output.ts';
import type { CfCommand } from './cf-version-api.ts';
import { isCleanCloudflareExit } from './cloudflare-process.ts';

export { isPreviewName } from './preview-name.ts';

const DatabaseEntry = type({ name: 'string', uuid: 'string' });
const DatabaseList = DatabaseEntry.array().or({ result: DatabaseEntry.array() });
const CreatedDatabase = type({ uuid: 'string' });
const OwnDurableObjectBinding = type({ type: "'durable-object'", 'worker?': 'string' });
const D1Binding = type({ type: "'d1'", 'name?': 'string', 'id?': 'string' });
const PreviewDeployOutput = type({ preview_urls: 'string[]' });
const Json = type('string.json.parse');

/** A preview's copy of a database. The word "preview" keeps it from matching a database a person named themselves. */
export function previewDatabaseName(databaseName: string, preview: string): string {
  return `${databaseName}-preview-${preview}`;
}

/** Stop before a preview would reuse, migrate or delete a database the app declares as its own. */
export function assertNotDeclared(copy: string, declared: ReadonlyArray<string>): void {
  if (declared.includes(copy)) {
    throw new Error(
      `The preview's database name ${copy} is also a database this app declares. Rename one of them so a preview never touches the app's own data.`,
    );
  }
}

function parseWith<S extends Type>(schema: S, text: string): S['infer'] | undefined {
  const json = Json(text);

  if (json instanceof type.errors) {
    return undefined;
  }

  const parsed = schema(json);

  return parsed instanceof type.errors ? undefined : parsed;
}

async function runCfJson<S extends Type>(
  runCf: CfCommand,
  args: Array<string>,
  cwd: string,
  schema: S,
): Promise<S['infer'] | undefined> {
  const result = await runCf(args, { cwd, capture: true });

  if (!isCleanCloudflareExit(result)) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');

    throw new Error(`cf ${args.slice(0, 2).join(' ')} failed${detail ? `: ${detail}` : '.'}`);
  }

  if (result.data !== undefined) {
    const parsed = schema(result.data);

    return parsed instanceof type.errors ? undefined : parsed;
  }

  return parseWith(schema, result.stdout);
}

async function runCfQuiet(runCf: CfCommand, args: Array<string>, cwd: string): Promise<void> {
  const result = await runCf(args, { cwd, capture: true });

  if (!isCleanCloudflareExit(result)) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');

    throw new Error(`cf ${args.slice(0, 2).join(' ')} failed${detail ? `: ${detail}` : '.'}`);
  }
}

async function findDatabase(runCf: CfCommand, name: string, cwd: string): Promise<string | null> {
  const found = await runCfJson(runCf, ['d1', 'list', '--name', name], cwd, DatabaseList);
  const list = Array.isArray(found) ? found : (found?.result ?? []);

  return list.find((entry) => entry.name === name)?.uuid ?? null;
}

/**
 * Find or create the preview's copy of a D1 database, and apply the migrations in `migrationsDir` to it.
 * Cloudflare keeps D1 databases apart only when a preview is bound to a separate one.
 */
export async function ensurePreviewDatabase(input: {
  runCf: CfCommand;
  cwd: string;
  name: string;
  migrationsDir: string | undefined;
}): Promise<string> {
  const { runCf, cwd, name } = input;
  let id = await findDatabase(runCf, name, cwd);

  if (id === null) {
    const created = await runCfJson(runCf, ['d1', 'create', '--name', name], cwd, CreatedDatabase);

    if (created === undefined) {
      throw new Error(`cf d1 create did not return an id for ${name}.`);
    }

    id = created.uuid;
  }

  if (input.migrationsDir !== undefined) {
    await runCfQuiet(runCf, ['d1', 'migrations', 'apply', id, '--dir', input.migrationsDir], cwd);
  }

  return id;
}

/** Delete the preview's copy of a database. A database that is already gone counts as removed. */
export async function removePreviewDatabase(input: {
  runCf: CfCommand;
  cwd: string;
  name: string;
}): Promise<boolean> {
  const id = await findDatabase(input.runCf, input.name, input.cwd);

  if (id === null) {
    return false;
  }

  await runCfQuiet(input.runCf, ['d1', 'delete', id, '--force'], input.cwd);

  return true;
}

function isOwnDurableObjectBinding(value: unknown, workerName: string | undefined): boolean {
  const parsed = OwnDurableObjectBinding(value);

  return (
    !(parsed instanceof type.errors) &&
    (parsed.worker === undefined || parsed.worker === workerName)
  );
}

/** The D1 databases a built Worker binds, by binding name. */
export function d1BindingsOf(config: {
  env?: object;
}): Array<{ binding: string; databaseName: string }> {
  const bindings: Array<{ binding: string; databaseName: string }> = [];

  for (const [binding, value] of Object.entries(config.env ?? {})) {
    const parsed = D1Binding(value);

    if (!(parsed instanceof type.errors) && parsed.name !== undefined) {
      bindings.push({ binding, databaseName: parsed.name });
    }
  }

  return bindings;
}

/** Bind each D1 database of a built Worker to the preview's copy of it. */
export function previewBuild(input: {
  preview: string;
  databaseFor: (binding: string, databaseName: string) => Promise<{ name: string; id: string }>;
}): PreviewBuild {
  return {
    async rewriteWorker(config) {
      const swapped = new Map<string, { name: string; id: string }>();

      for (const { binding, databaseName } of d1BindingsOf(config)) {
        swapped.set(binding, await input.databaseFor(binding, databaseName));
      }

      // Decision: A binding to the Worker's own class reaches the namespace of the live script, which has no class a pull request just added (Cloudflare error 10061) and would share its owners' data with production. The classes stay in exports, so the preview reaches its own owners through ctx.exports.
      const env = Object.fromEntries(
        Object.entries(config.env ?? {})
          .filter(([, value]) => !isOwnDurableObjectBinding(value, config.name))
          .map(([binding, value]) => [
            binding,
            swapped.has(binding) ? { ...value, ...swapped.get(binding) } : value,
          ]),
      );

      return { ...config, env };
    },
  };
}

/** The preview's address in the JSON `cf previews deploy` prints. */
export function readPreviewUrl(output: string): string | undefined {
  const body = parseWith(PreviewDeployOutput, output.slice(Math.max(0, output.indexOf('{'))));

  return body?.preview_urls[0];
}
