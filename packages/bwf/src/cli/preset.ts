import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'pathslash';
import { readProjectPaths } from '../project-paths.ts';
import type { ProjectPaths } from '../project-paths.ts';
import {
  getPackageDependencies,
  hasPackageDependency,
  readPackageJson,
} from '../shared/package-json.ts';

/** Build output conventions for a known SSG (static site generator). */
type SsgPreset = {
  /** Package name to detect in package.json dependencies. */
  dep: string;
  /** Default build command (binary name — localBin resolves the full path). */
  buildCommand: string;
  /** Default output directory, relative to project root. */
  outputDir: string;
  /** App type for the deploy manifest. */
  appType: 'static' | 'spa';
  resolve?: (root: string) => Partial<Pick<StaticPreset, 'buildCommand' | 'outputDir'>> | undefined;
};

/**
 * Known output conventions for SSGs.
 * Keyed by the SSG name — detection iterates in insertion order.
 */
const SSG_PRESETS: Record<string, SsgPreset> = {
  vitepress: {
    dep: 'vitepress',
    buildCommand: 'vitepress build',
    outputDir: '.vitepress/dist',
    appType: 'static',
    resolve(root) {
      if (existsSync(join(root, 'docs/.vitepress'))) {
        return {
          buildCommand: 'vitepress build docs',
          outputDir: 'docs/.vitepress/dist',
        };
      }
    },
  },
  docusaurus: {
    dep: '@docusaurus/core',
    buildCommand: 'docusaurus build',
    outputDir: 'build',
    appType: 'static',
  },
};

export type StaticPreset = {
  buildCommand: string | null;
  outputDir: string;
  appType: 'spa' | 'static';
};

/**
 * Resolve a project-local command, rewriting `vite` to `vp` when the project
 * depends on Vite+ and preferring node_modules/.bin when available.
 */
export function resolveProjectCommand(root: string, command: string): string {
  const [bin, ...args] = command.trim().split(/\s+/);
  const resolvedBin = shellQuoteExecutable(localBin(root, resolveCommandBin(root, bin)));
  return args.length > 0 ? `${resolvedBin} ${args.join(' ')}` : resolvedBin;
}

/**
 * Shell-quote a resolved executable path so it survives being concatenated into
 * a command string. The deploy path runs these via `execSync`/`spawnSync`,
 * which invoke a shell, so a bare absolute path containing a space (e.g. a
 * project root like `/tmp/my app`) would be word-split by the shell and try to
 * exec the wrong binary. Paths with no shell-significant characters are returned
 * unchanged, so ordinary paths stay byte-identical and copy-pasteable; only the
 * executable segment is quoted (the trailing subcommand args are known-safe
 * tokens). Platform-aware: cmd.exe (Windows) uses double quotes, POSIX shells
 * use single quotes.
 */
function shellQuoteExecutable(value: string): string {
  if (process.platform === 'win32') {
    // Decision: cmd.exe: wrap in double quotes when the path contains a space or a shell
    // metacharacter. Windows filenames cannot contain `"`, so there is no
    // embedded quote to escape.
    return /[\s&|<>^()"]/.test(value) ? `"${value}"` : value;
  }
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** Resolve the bundled cf transport without consulting project dependencies. */
export function resolveCloudflareOperationArgv(): Array<string> {
  const directory = dirname(import.meta.filename);
  const entry = [
    join(directory, 'cloudflare-operation-process.ts'),
    join(directory, 'cloudflare-operation-process.mjs'),
    join(directory, 'cli', 'cloudflare-operation-process.mjs'),
  ].find((candidate) => existsSync(candidate));
  if (!entry) {
    throw new Error(
      `Platform's bundled Cloudflare tooling is unavailable. Reinstall the project's dependencies from its trusted lockfile, then retry.`,
    );
  }
  return [process.execPath, entry];
}

/**
 * Format a user-facing command string, rewriting `vite` to `vp` when the
 * project depends on Vite+ without expanding to an absolute local bin path.
 */
export function formatProjectCommand(root: string, command: string): string {
  const [bin, ...args] = command.trim().split(/\s+/);
  const formattedBin = resolveCommandBin(root, bin);
  return args.length > 0 ? `${formattedBin} ${args.join(' ')}` : formattedBin;
}

/**
 * Detect a static deploy preset based on the project root.
 * Returns null when the project requires a full worker deploy.
 *
 * `strictBackend` refuses (throws) instead of returning an SSG preset when the
 * project ALSO has backend sources. SSG detection (step 2) deliberately runs
 * before the backend check (step 3), so without this an SSG repo that grew a
 * single `routes/api/*.ts` would deploy as a pure static site with the backend
 * silently dropped and no diagnostic. Opt-in because only the UNCONFIGURED
 * auto-detect path is ambiguous: `--dir` and a configured
 * `inference.appType: "static" | "spa"` are the user stating what they want, and
 * must keep working silently.
 */
export function detectPreset(
  root: string,
  options?: { dir?: string; spa?: boolean; strictBackend?: boolean },
): StaticPreset | null {
  if (options?.dir) {
    return {
      buildCommand: null,
      outputDir: resolve(root, options.dir),
      appType: options.spa ? 'spa' : 'static',
    };
  }

  const pkg = readPackageJson(root);
  if (pkg) {
    const allDeps = getPackageDependencies(pkg);
    for (const preset of Object.values(SSG_PRESETS)) {
      if (preset.dep in allDeps) {
        if (options?.strictBackend) {
          const backendSources = findBackendSources(root);
          if (backendSources.length > 0) {
            throw new Error(ssgWithBackendMessage(preset.dep, backendSources));
          }
        }
        const overrides = preset.resolve?.(root);
        const cmd = overrides?.buildCommand ?? preset.buildCommand;
        const out = overrides?.outputDir ?? preset.outputDir;
        return {
          buildCommand: resolveProjectCommand(root, cmd),
          outputDir: resolve(root, out),
          appType: preset.appType,
        };
      }
    }
  }

  if (hasBackendFiles(root)) {
    return null;
  }

  if (pkg && hasViteLike(pkg)) {
    const buildCommand = resolveProjectScriptCommand(root, 'build');
    return {
      buildCommand: buildCommand ?? resolveProjectCommand(root, 'vite build'),
      outputDir: resolve(root, 'dist'),
      appType: 'spa',
    };
  }

  if (existsSync(join(root, 'dist/index.html'))) {
    return {
      buildCommand: null,
      outputDir: resolve(root, 'dist'),
      appType: options?.spa ? 'spa' : 'static',
    };
  }

  if (existsSync(join(root, 'index.html'))) {
    return {
      buildCommand: null,
      outputDir: root,
      appType: options?.spa ? 'spa' : 'static',
    };
  }

  return null;
}

/**
 * The refusal shown when an SSG project also carries backend sources and no
 * `inference.appType` says which one to deploy. Names the exact directories
 * found and both ways out.
 */
function ssgWithBackendMessage(ssgDep: string, backendSources: Array<string>): string {
  return [
    `deploy: "${ssgDep}" was detected, but this project also has backend code: ${backendSources.join(', ')}.`,
    'A static deploy would silently drop it, so bwf will not guess. Pick one in bwf.config.ts:',
    '',
    '  Deploy the static output only (the backend is NOT deployed):',
    '    { "inference": { "appType": "static" } }',
    '',
    '  Deploy both — the SSG emits the site, then bwf packages it with the worker:',
    '    { "inference": { "appType": "platform", "build": "<ssg> build && vite build" } }',
    '    ...and in vite.config.ts add bwfPlugin() plus `publicDir: "<ssg output dir>"`,',
    '    so the generated site is copied into the client build alongside the worker.',
  ].join('\n');
}

/**
 * Resolve a local node_modules/.bin executable path.
 * Falls back to bare command name if the bin doesn't exist locally.
 */
function localBin(root: string, name: string): string {
  const bin = join(root, 'node_modules', '.bin', name);
  return existsSync(bin) ? bin : name;
}

function resolveCommandBin(root: string, name: string): string {
  if (name === 'vite') {
    return detectViteBinary(root);
  }
  return name;
}

function detectPackageManager(root: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(join(root, 'yarn.lock'))) {
    return 'yarn';
  }
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) {
    return 'bun';
  }
  return 'npm';
}

function resolveProjectScriptCommand(root: string, scriptName: string): string | null {
  const pkg = readPackageJson(root);
  const script = pkg?.scripts;
  if (!script || typeof script !== 'object' || Array.isArray(script)) {
    return null;
  }
  if (typeof (script as Record<string, unknown>)[scriptName] !== 'string') {
    return null;
  }

  switch (detectPackageManager(root)) {
    case 'pnpm':
      return `pnpm ${scriptName}`;
    case 'yarn':
      return `yarn ${scriptName}`;
    case 'bun':
      return `bun run ${scriptName}`;
    default:
      return `npm run ${scriptName}`;
  }
}

function hasViteLike(pkg: Record<string, unknown>): boolean {
  return hasPackageDependency(pkg, 'vite') || hasPackageDependency(pkg, 'vite-plus');
}

function detectViteBinary(root: string): 'vite' | 'vp' {
  const pkg = readPackageJson(root);
  if (pkg && hasPackageDependency(pkg, 'vite-plus')) {
    return 'vp';
  }
  return 'vite';
}

/**
 * Every backend source in the project that requires a full worker deploy, named
 * relative to the root (e.g. `routes/`).
 *
 * Returned as a list rather than a boolean so a caller that has to REJECT a
 * static deploy can tell the user exactly what would have been dropped.
 */
export function findBackendSources(root: string): Array<string> {
  const paths = readProjectPaths(root);
  const found: Array<string> = [];
  for (const dir of backendDirs(paths)) {
    if (existsSync(dir)) {
      found.push(`${relative(root, dir)}/`);
    }
  }
  return found;
}

export function hasBackendFiles(root: string): boolean {
  const paths = readProjectPaths(root);
  return backendDirs(paths).some((dir) => existsSync(dir));
}

function backendDirs(paths: ProjectPaths): Array<string> {
  return [paths.routesDir, paths.middlewareDir, paths.cronsDir, paths.queuesDir, paths.emailDir];
}
