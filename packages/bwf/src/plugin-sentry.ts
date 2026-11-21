import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'pathslash';
import type { Plugin } from 'vite';
import { writeFileAtomic } from './shared/atomic-write.ts';
import { ensureGitignoreLines } from './shared/gitignore.ts';

/** The Worker config bwf writes for Sentry's Vite plugin, which reads it from a file. */
export const SENTRY_CONFIG_FILE = '.bwf-sentry.json';

type SentryVitePlugin = (options: { wranglerConfigPath: string }) => Array<Plugin>;

function loadSentryVitePlugin(root: string): SentryVitePlugin | undefined {
  const manifest = join(root, 'package.json');
  if (!existsSync(manifest)) {
    return undefined;
  }
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
  const declared = ['dependencies', 'devDependencies'].some(
    (field) => '@sentry/cloudflare' in ((pkg[field] as Record<string, unknown>) ?? {}),
  );
  if (!declared) {
    return undefined;
  }
  return (
    createRequire(manifest)('@sentry/cloudflare/vite') as {
      sentryCloudflareVitePlugin: SentryVitePlugin;
    }
  ).sentryCloudflareVitePlugin;
}

type SentryWorkerConfig = {
  name?: string;
  compatibility_date?: string;
  durable_objects?: { bindings?: Array<{ name: string; class_name: string }> };
  workflows?: Array<{ name: string; class_name?: string }>;
  services?: Array<{ binding: string; service: string }>;
};

function unique<T>(lists: Array<Array<T> | undefined>, key: (item: T) => string): Array<T> {
  const items = new Map<string, T>();
  for (const item of lists.flatMap((list) => list ?? [])) {
    items.set(key(item), item);
  }
  return [...items.values()];
}

/** Each config layer the Cloudflare plugin merges, so the Durable Objects and workflows are all listed. */
export function sentryWorkerConfig(layers: Array<SentryWorkerConfig | undefined>): object {
  const present = layers.filter((layer): layer is SentryWorkerConfig => layer !== undefined);
  const last = <K extends keyof SentryWorkerConfig>(key: K): SentryWorkerConfig[K] =>
    present
      .map((layer) => layer[key])
      .filter((value) => value !== undefined)
      .at(-1);
  return {
    name: last('name'),
    main: '.bwf/entry.ts',
    compatibility_date: last('compatibility_date'),
    durable_objects: {
      bindings: unique(
        present.map((layer) => layer.durable_objects?.bindings),
        (binding) => binding.name,
      ),
    },
    workflows: unique(
      present.map((layer) => layer.workflows),
      (workflow) => workflow.name,
    ),
    services: unique(
      present.map((layer) => layer.services),
      (service) => service.binding,
    ),
  };
}

/**
 * Sentry, when the app installs `@sentry/cloudflare`: its Vite plugin wraps the Worker entry and
 * each Durable Object, and instruments dependencies at build time. Options come from the default
 * export of an `instrument.server.ts` next to the bwf config, or from `SENTRY_DSN` and the other `SENTRY_*` vars.
 * Without a DSN the SDK stays off.
 */
export function sentry(root: string): {
  plugins: Array<Plugin>;
  writeConfig(layers: Array<SentryWorkerConfig | undefined>): void;
} {
  const sentryCloudflareVitePlugin = loadSentryVitePlugin(root);
  if (!sentryCloudflareVitePlugin) {
    return { plugins: [], writeConfig: () => {} };
  }
  const path = join(root, SENTRY_CONFIG_FILE);
  ensureGitignoreLines(root, [SENTRY_CONFIG_FILE], {
    [SENTRY_CONFIG_FILE]: [`/${SENTRY_CONFIG_FILE}`],
  });
  const instrument = ['ts', 'mts', 'js', 'mjs'].find((ext) =>
    existsSync(join(root, `instrument.server.${ext}`)),
  );
  if (instrument) {
    mkdirSync(join(root, '.bwf'), { recursive: true });
    const text = `export { default } from '../instrument.server.${instrument}';\n`;
    const reexport = join(root, '.bwf', 'instrument.server.ts');
    if (!existsSync(reexport) || readFileSync(reexport, 'utf8') !== text) {
      writeFileAtomic(reexport, text);
    }
  }
  return {
    plugins: sentryCloudflareVitePlugin({ wranglerConfigPath: path }),
    writeConfig(layers) {
      const text = `${JSON.stringify(sentryWorkerConfig(layers), null, 2)}\n`;
      if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
        writeFileAtomic(path, text);
      }
    },
  };
}
