import { parseSync } from 'vite';
import { bindingNames } from './ast-bindings.ts';
import {
  isAstNode,
  isAstProgram,
  isExportAllDeclaration,
  isExportNamedDeclaration,
  isIdentifier,
  isVariableDeclaration,
  moduleExportName,
} from './ast.ts';
import type { AstNode, AstProgram } from './ast.ts';

/** How a module exports some names, as far as its source shows without running it. */
export type StaticExports = {
  /** Initializers of `export const name = value` declarations. */
  initializers: Map<string, AstNode>;
  /**
   * Names exported in a form whose value only running the module reveals: export
   * lists and re-exports, `let` and `var`, destructuring, functions, classes and enums.
   */
  unreadable: Set<string>;
  /** `export * from` may export any of the names. */
  exportsAll: boolean;
};

const LINE_TERMINATORS = new Set(['\n', '\r', '\u2028', '\u2029']);

/**
 * Whether `export` is followed by `*` once whitespace and comments are skipped,
 * so a comment between the two still counts. True only means the source needs
 * parsing: the text may sit in a string or comment. This is a scan because a
 * regular expression that skips repeated comments can backtrack exponentially.
 */
export function mayExportAll(source: string): boolean {
  for (
    let index = source.indexOf('export');
    index !== -1;
    index = source.indexOf('export', index + 1)
  ) {
    let cursor = index + 'export'.length;
    while (cursor < source.length) {
      if (/\s/.test(source[cursor])) {
        cursor += 1;
      } else if (source.startsWith('/*', cursor)) {
        const end = source.indexOf('*/', cursor + 2);
        cursor = end === -1 ? source.length : end + 2;
      } else if (source.startsWith('//', cursor)) {
        cursor += 2;
        while (cursor < source.length && !LINE_TERMINATORS.has(source[cursor])) {
          cursor += 1;
        }
      } else {
        break;
      }
    }
    if (source[cursor] === '*') {
      return true;
    }
  }
  return false;
}

const VALUE_DECLARATIONS = new Set([
  'FunctionDeclaration',
  'ClassDeclaration',
  'TSEnumDeclaration',
]);

/** Read how a parsed module exports `names` without evaluating user code. Type-only exports are skipped. */
function staticExports(program: AstProgram, names: ReadonlySet<string>): StaticExports {
  const result: StaticExports = {
    initializers: new Map(),
    unreadable: new Set(),
    exportsAll: false,
  };
  const markUnreadable = (name: string | undefined): void => {
    if (name !== undefined && names.has(name)) {
      result.unreadable.add(name);
    }
  };
  for (const statement of program.body ?? []) {
    if (isExportAllDeclaration(statement)) {
      const exported = statement;
      if (exported.exportKind === 'type') {
        continue;
      }
      if (exported.exported) {
        markUnreadable(moduleExportName(exported.exported));
      } else {
        result.exportsAll = true;
      }
      continue;
    }
    if (!isExportNamedDeclaration(statement)) {
      continue;
    }
    const exported = statement;
    if (exported.exportKind === 'type') {
      continue;
    }
    for (const specifier of exported.specifiers ?? []) {
      if (specifier.exportKind !== 'type') {
        markUnreadable(moduleExportName(specifier.exported));
      }
    }
    const declaration = exported.declaration;
    if (declaration && isVariableDeclaration(declaration)) {
      const variables = declaration;
      for (const variable of variables.declarations ?? []) {
        if (variables.kind === 'const' && isIdentifier(variable.id) && variable.init) {
          if (names.has(variable.id.name)) {
            result.initializers.set(variable.id.name, variable.init);
          }
          continue;
        }
        for (const name of bindingNames(variable.id)) {
          markUnreadable(name);
        }
      }
    } else if (declaration && VALUE_DECLARATIONS.has(declaration.type)) {
      const id = isAstNode(declaration.id) ? declaration.id : undefined;
      markUnreadable(isIdentifier(id) ? id.name : undefined);
    }
  }
  return result;
}

/** Parse a module and read how it exports `names` without evaluating user code. */
export function readStaticExports(
  filename: string,
  source: string,
  names: ReadonlySet<string>,
): StaticExports {
  const { program } = parseSync(filename, source);
  return isAstProgram(program)
    ? staticExports(program, names)
    : staticExports({ type: 'Program' }, names);
}

export function unwrapStaticExpression(node: AstNode | undefined): AstNode | undefined {
  while (
    node &&
    [
      'ParenthesizedExpression',
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSTypeAssertion',
    ].includes(node.type)
  ) {
    node = isAstNode(node.expression) ? node.expression : undefined;
  }
  return node;
}

export type StaticLiteral = string | number | boolean | bigint | RegExp | null | undefined;

function literalValue(value: unknown): StaticLiteral {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value === null ||
    value instanceof RegExp
  ) {
    return value;
  }
  return undefined;
}

function cookedText(node: unknown): string | undefined {
  if (typeof node !== 'object' || node === null || !('value' in node)) {
    return undefined;
  }
  const { value } = node;
  if (typeof value !== 'object' || value === null || !('cooked' in value)) {
    return undefined;
  }
  return typeof value.cooked === 'string' ? value.cooked : undefined;
}

export function staticLiteral(node: AstNode | undefined): StaticLiteral {
  node = unwrapStaticExpression(node);
  if (node?.type === 'Literal') {
    return literalValue(node.value);
  }
  if (node?.type === 'TemplateLiteral') {
    const { expressions, quasis } = node;
    if (
      Array.isArray(expressions) &&
      expressions.length === 0 &&
      Array.isArray(quasis) &&
      quasis.length === 1
    ) {
      return cookedText(quasis[0]);
    }
  }
  return undefined;
}
