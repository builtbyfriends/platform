import type { PreviewBuild } from './cf-build-output.ts';
import type { CfCommand } from './cf-version-api.ts';
import { isCleanCloudflareExit } from './cloudflare-process.ts';

const PREVIEW_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function isPreviewName(name: string): boolean {
  return PREVIEW_NAME.test(name);
}

/** A preview's copy of a database: the same name with the preview's name after it. */
export function previewDatabaseName(databaseName: string, preview: string): string {
  return `${databaseName}-${preview}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function runJson(runCf: CfCommand, args: Array<string>, cwd: string): Promise<unknown> {
  const result = await runCf(args, { cwd, capture: true });

  if (!isCleanCloudflareExit(result)) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');
    throw new Error(`cf ${args.slice(0, 2).join(' ')} failed${detail ? `: ${detail}` : '.'}`);
  }

  return result.data ?? parseJson(result.stdout);
}

async function findDatabase(runCf: CfCommand, name: string, cwd: string): Promise<string | null> {
  const found = await runJson(runCf, ['d1', 'list', '--name', name], cwd);

  const list = Array.isArray(found)
    ? found
    : isRecord(found) && Array.isArray(found.result)
      ? found.result
      : [];

  for (const entry of list) {
    if (isRecord(entry) && entry.name === name && typeof entry.uuid === 'string') {
      return entry.uuid;
    }
  }

  return null;
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
    const created = await runJson(runCf, ['d1', 'create', '--name', name], cwd);
    id = isRecord(created) && typeof created.uuid === 'string' ? created.uuid : null;

    if (id === null) {
      throw new Error(`cf d1 create did not return an id for ${name}.`);
    }
  }

  if (input.migrationsDir !== undefined) {
    await runJson(runCf, ['d1', 'migrations', 'apply', id, '--dir', input.migrationsDir], cwd);
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

  await runJson(input.runCf, ['d1', 'delete', id, '--force'], input.cwd);

  return true;
}

type D1Binding = { type: 'd1'; name?: string; id?: string };

function isD1Binding(value: unknown): value is D1Binding {
  return isRecord(value) && value.type === 'd1';
}

/** The D1 databases a built Worker binds, by binding name. */
export function d1BindingsOf(config: {
  env?: object;
}): Array<{ binding: string; databaseName: string }> {
  const bindings: Array<{ binding: string; databaseName: string }> = [];

  for (const [binding, value] of Object.entries(config.env ?? {})) {
    if (isD1Binding(value) && typeof value.name === 'string') {
      bindings.push({ binding, databaseName: value.name });
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
      const env: Record<string, unknown> = { ...config.env };

      for (const { binding, databaseName } of d1BindingsOf(config)) {
        const copy = await input.databaseFor(binding, databaseName);
        env[binding] = { ...(env[binding] as D1Binding), name: copy.name, id: copy.id };
      }

      return { ...config, env };
    },
  };
}

/** The preview's address in the JSON `cf previews deploy` prints. */
export function readPreviewUrl(output: string): string | undefined {
  const body = parseJson(output.slice(Math.max(0, output.indexOf('{'))));
  const urls = isRecord(body) ? body.preview_urls : undefined;

  return Array.isArray(urls) && typeof urls[0] === 'string' ? urls[0] : undefined;
}
