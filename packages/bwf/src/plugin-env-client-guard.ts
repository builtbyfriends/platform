import { relative } from 'pathslash';
import { parseSync, type Plugin } from 'vite';
import { bindingResolver } from './shared/ast-bindings.ts';
import {
  isIdentifier,
  isMemberExpression,
  type AstImportDeclaration,
  type AstImportNamespaceSpecifier,
  type AstImportSpecifier,
  type AstMemberExpression,
  isAstProgram,
  type AstProgram,
} from './shared/ast.ts';
import { isClientEnvKey } from './shared/env.ts';

type EnvPublicModule = Pick<
  typeof import('./runtime/env-public.ts'),
  '_getRegisteredSchema' | '_hasRegisteredSchema' | '_getSchemaDefaults' | 'validateAllEnv'
>;

let cachedModule: EnvPublicModule | null = null;

export async function loadEnvPublic(): Promise<EnvPublicModule> {
  if (cachedModule) {
    return cachedModule;
  }
  const mod = await import('./runtime/env-public.ts');
  cachedModule = mod;
  return mod;
}

// Decision: Files we don't bother parsing — the AST walker would either fail or have
// nothing relevant to find. Anything else with a `@builtbyfriends/bwf/env` import is fair
// game.
const SKIP_EXT =
  /\.(?:css|s[ac]ss|less|styl|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|wasm|mp[34]|webm|md|mdx)(?:\?|$)/;

const SCRIPT_LANG_RE = /[?&]lang\.([a-z0-9]+)/i;

/**
 * Cheap prefilter shared with the fold plugin: is this a client script
 * module that mentions `@builtbyfriends/bwf/env`? Anything we'd want to parse is JS/TS or
 * has a script sub-resource (a `lang.tsx` / `lang.ts` / `lang.js` query). The `@builtbyfriends/bwf/env` substring check lets most files skip the AST
 * walk; a false positive only means an unneeded parse.
 */
export function isBwfEnvScriptCandidate(id: string, code: string): boolean {
  if (id.includes('/node_modules/') || SKIP_EXT.test(id)) {
    return false;
  }
  const langMatch = SCRIPT_LANG_RE.exec(id);
  const isScriptQuery = langMatch !== null && /^(?:m?[jt]sx?|cjs)$/i.test(langMatch[1]!);
  const isPlainScript = /\.(?:[mc]?[jt]sx?)(?:\?|$)/.test(id);
  if (!isScriptQuery && !isPlainScript) {
    return false;
  }
  return code.includes('@builtbyfriends/bwf/env');
}

export type ImportBindings = {
  /** Identifiers that are the `env` proxy directly (e.g. `import { env }` or `import { env as e }`). */
  directNames: Set<string>;
  /** Identifiers that are the namespace import (e.g. `import * as bwfEnv`); reads look like `<name>.env.X`. */
  namespaceNames: Set<string>;
};

export function extractEnvBindings(program: AstProgram): ImportBindings | null {
  const direct = new Set<string>();
  const namespace = new Set<string>();
  let found = false;

  for (const node of program.body ?? []) {
    if (node.type !== 'ImportDeclaration') {
      continue;
    }
    const source = (node as AstImportDeclaration).source;
    if (source.value !== '@builtbyfriends/bwf/env') {
      continue;
    }
    found = true;
    for (const spec of (node as AstImportDeclaration).specifiers ?? []) {
      if (spec.type === 'ImportSpecifier') {
        const importedName = (spec as AstImportSpecifier).imported;
        if (!isIdentifier(importedName)) {
          continue;
        }
        if (importedName.name === 'env') {
          direct.add((spec as AstImportSpecifier).local.name);
        }
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        namespace.add((spec as AstImportNamespaceSpecifier).local.name);
      }
    }
  }

  if (!found || (direct.size === 0 && namespace.size === 0)) {
    return null;
  }
  return { directNames: direct, namespaceNames: namespace };
}

type OffsetIndex = {
  /** Sorted array of byte offsets at which a new line starts (line N starts at lineStarts[N-1]). */
  lineStarts: Array<number>;
};

function buildOffsetIndex(code: string): OffsetIndex {
  const lineStarts: Array<number> = [0];
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10 /* Decision: 10 is the character code of a newline. */) {
      lineStarts.push(i + 1);
    }
  }
  return { lineStarts };
}

function offsetToLineCol(index: OffsetIndex, offset: number): { line: number; column: number } {
  const lineStarts = index.lineStarts;
  let lowerBound = 0;
  let upperBound = lineStarts.length - 1;
  while (lowerBound < upperBound) {
    const midpoint = (lowerBound + upperBound + 1) >>> 1;
    if (lineStarts[midpoint]! <= offset) {
      lowerBound = midpoint;
    } else {
      upperBound = midpoint - 1;
    }
  }
  return { line: lowerBound + 1, column: offset - lineStarts[lowerBound]! + 1 };
}

/**
 * Visit every `env.X` (or `<ns>.env.X`) member expression where `env` is
 * bound to the `@builtbyfriends/bwf/env` proxy.
 */
export function walkEnvReads(
  program: AstProgram,
  bindings: ImportBindings,
  visit: (node: AstMemberExpression) => void,
): void {
  const references: Array<{
    node: AstMemberExpression;
    name: string;
    bindingType: 'ImportSpecifier' | 'ImportNamespaceSpecifier';
  }> = [];
  const resolve = bindingResolver(program, {
    names: new Set([...bindings.directNames, ...bindings.namespaceNames]),
    visit(current) {
      if (!isMemberExpression(current)) {
        return false;
      }

      if (isIdentifier(current.object) && bindings.directNames.has(current.object.name)) {
        references.push({
          node: current,
          name: current.object.name,
          bindingType: 'ImportSpecifier',
        });
        return true;
      }

      const obj = current.object;
      if (
        isMemberExpression(obj) &&
        !obj.computed &&
        isIdentifier(obj.object) &&
        bindings.namespaceNames.has(obj.object.name) &&
        isIdentifier(obj.property) &&
        obj.property.name === 'env'
      ) {
        references.push({
          node: current,
          name: obj.object.name,
          bindingType: 'ImportNamespaceSpecifier',
        });
        return true;
      }
      return false;
    },
  });
  // Decision: Resolve after the walk so later declarations and hoisted bindings are known.
  for (const { node, name, bindingType } of references) {
    if (resolve(node, name)?.type === bindingType) {
      visit(node);
    }
  }
}

type Hit = {
  kind: 'error' | 'warn';
  property: string | null;
  start: number;
};

/**
 * Collect every `@builtbyfriends/bwf/env` read. Computed access produces a warning hit
 * with `property === null`; everything else carries the property name.
 */
function findHits(program: AstProgram, bindings: ImportBindings): Array<Hit> {
  const hits: Array<Hit> = [];
  walkEnvReads(program, bindings, (node) => recordHit(node, hits));
  return hits;
}

function recordHit(node: AstMemberExpression, hits: Array<Hit>): void {
  if (node.computed) {
    hits.push({ kind: 'warn', property: null, start: node.start! });
    return;
  }
  if (!isIdentifier(node.property)) {
    return;
  }
  hits.push({ kind: 'error', property: node.property.name, start: node.start! });
}

/**
 * Vite plugin that fails the client build when a server-only env key
 * (anything in `defineEnv` not prefixed with `VITE_`) is referenced from a
 * module that ends up in the client bundle. The runtime proxy in
 * `env-public-client.ts` already throws for the same class of bug at
 * request time — this plugin moves the diagnosis forward to compile time
 * so it shows up in `pnpm build` and the dev overlay, not in production
 * after an admin clicks the offending route.
 *
 * No-op when no `env.ts` is registered. Server / SSR / worker environments
 * are skipped — only the `client` environment is checked.
 */
export function envClientGuardPlugin(root: string): Plugin {
  return {
    name: 'platform:env-client-guard',
    // Decision: Run after other transforms so the `code` we get is plain JS we can parse.
    enforce: 'post',
    async transform(code, id) {
      // Decision: Only run on the client environment. SSR, worker, RSC etc. legitimately
      // read server keys via the same `@builtbyfriends/bwf/env` import.
      if (this.environment?.name !== 'client') {
        return;
      }

      if (!isBwfEnvScriptCandidate(id, code)) {
        return;
      }

      const { _hasRegisteredSchema, _getRegisteredSchema } = await loadEnvPublic();
      if (!_hasRegisteredSchema()) {
        return;
      }
      const schema = _getRegisteredSchema();
      if (!schema || Object.keys(schema).length === 0) {
        return;
      }

      let parsed: ReturnType<typeof parseSync>;
      try {
        parsed = parseSync(id, code);
      } catch {
        // Decision: If the file doesn't parse with the rolldown parser, leave it alone
        // — Vite's own pipeline will surface the syntax error.
        return;
      }

      if (!isAstProgram(parsed.program)) {
        return;
      }
      const program: AstProgram = parsed.program;
      const bindings = extractEnvBindings(program);
      if (!bindings) {
        return;
      }

      const hits = findHits(program, bindings);
      if (hits.length === 0) {
        return;
      }

      const offsets = buildOffsetIndex(code);
      const relPath = relative(root, id.split('?')[0]!) || id;

      for (const hit of hits) {
        const { line, column } = offsetToLineCol(offsets, hit.start);

        if (hit.kind === 'warn') {
          this.warn({
            message:
              `Computed access to "env[…]" at ${relPath}:${line}:${column} cannot be statically verified. ` +
              `If the key being read is server-only, this will throw at runtime in the browser. ` +
              `Prefer literal property access (env.VITE_FOO) so the build can check the split.`,
            loc: { line, column, file: id },
          });
          continue;
        }

        const key = hit.property!;
        // Decision: Unknown to the schema? Could be a CF binding or a typo — neither
        // is the guard's concern. The runtime proxy still catches misuse.
        if (!(key in schema)) {
          continue;
        }
        if (isClientEnvKey(key)) {
          continue;
        }

        this.error({
          message:
            `Server-only env "${key}" referenced from client code at ${relPath}:${line}:${column}.\n` +
            `If this should be available in the browser, rename it with the VITE_* prefix in env.ts.\n` +
            `If it must stay server-only, remove this reference and read the value via a server route or loader.`,
          loc: { line, column, file: id },
        });
      }
    },
  };
}
