import MagicString from 'magic-string';
import { parseSync } from 'vite';
import { isAstProgram, isIdentifier, isLiteral } from '../shared/ast.ts';
import type { AstNode, AstProgram } from '../shared/ast.ts';

type Span = { start: number; end: number };
type Edit = Span & { replacement: string };

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  );
}

function childNode(value: unknown): AstNode | undefined {
  return isAstNode(value) ? value : undefined;
}

function childNodes(value: unknown): Array<AstNode> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const children: Array<AstNode> = [];
  for (const item of value) {
    if (!isAstNode(item)) {
      return undefined;
    }
    children.push(item);
  }
  return children;
}

function identifierName(node: AstNode | undefined): string | undefined {
  return isIdentifier(node) ? node.name : undefined;
}

function span(node: AstNode): Span {
  if (node.start === undefined || node.end === undefined) {
    throw new Error('deploy: Bundle syntax node has no source range.');
  }
  return { start: node.start, end: node.end };
}

function nodes(root: AstNode): Array<AstNode> {
  const found: Array<AstNode> = [];
  const pending: Array<AstNode> = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      break;
    }
    found.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isAstNode(child)) {
            pending.push(child);
          }
        }
      } else if (isAstNode(value)) {
        pending.push(value);
      }
    }
  }
  return found;
}

/**
 * Replace the `createRequire(import.meta.url)` binding that the bundler emits for CommonJS
 * database drivers with `requireShim`, which serves Node built-ins from static imports.
 * workerd gives modules no `import.meta.url`, so the original binding fails at startup.
 * PostgreSQL bundles also replace `pgpass`, which reads the filesystem.
 */
export function transformWorkerRequireBundle(
  code: string,
  filename: string,
  requireShim: string,
  database: 'PostgreSQL' | 'MySQL',
): string {
  if (!code.includes('createRequire') && !code.includes('pgpass')) {
    return code;
  }
  const parsedProgram = parseSync(filename, code).program;
  if (!isAstProgram(parsedProgram)) {
    return code;
  }
  const program: AstProgram = parsedProgram;
  const edits: Array<Edit> = [];
  let hasRequireBinding = false;
  let pgpassCalls = 0;
  for (const statement of program.body ?? []) {
    if (
      statement.type === 'ImportDeclaration' &&
      childNode(statement.source)?.value === 'node:module'
    ) {
      const specifiers = childNodes(statement.specifiers);
      if (
        specifiers?.length !== 1 ||
        identifierName(childNode(specifiers[0]?.imported)) !== 'createRequire'
      ) {
        throw new Error(
          `deploy: Unsupported node:module import in ${database} bundle ${filename}.`,
        );
      }
      edits.push({ ...span(statement), replacement: '' });
    }
    if (statement.type === 'VariableDeclaration') {
      const declarations = childNodes(statement.declarations);
      if (
        declarations?.some(
          (declaration) => identifierName(childNode(declaration.id)) === '__require',
        )
      ) {
        if (declarations.length !== 1 || hasRequireBinding) {
          throw new Error(`deploy: Unsupported require binding in ${database} bundle ${filename}.`);
        }
        hasRequireBinding = true;
        edits.push({ ...span(statement), replacement: requireShim });
      }
    }
  }
  for (const node of nodes(program)) {
    if (node.type !== 'CallExpression' || identifierName(childNode(node.callee)) !== '__require') {
      continue;
    }
    const args = childNodes(node.arguments);
    const [firstArg] = args ?? [];
    if (args?.length !== 1 || !isLiteral(firstArg) || firstArg.value !== 'pgpass') {
      continue;
    }
    pgpassCalls++;
    edits.push({ ...span(node), replacement: '__platformPgpassNoop' });
  }
  if (code.includes('createRequire') && !hasRequireBinding) {
    throw new Error(
      `deploy: Could not locate the generated require binding in ${database} bundle ${filename}.`,
    );
  }
  if (code.includes('pgpass') && pgpassCalls === 0 && code.includes('__require')) {
    throw new Error(
      `deploy: Could not locate the pgpass require in ${database} bundle ${filename}.`,
    );
  }
  const ms = new MagicString(code);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    ms.overwrite(edit.start, edit.end, edit.replacement);
  }
  const transformed = ms.toString();
  if (transformed.includes('createRequire') || transformed.includes('__require("pgpass")')) {
    throw new Error(
      `deploy: ${database} bundle ${filename} still contains an unsupported require.`,
    );
  }
  return pgpassCalls > 0
    ? `const __platformPgpassNoop = Object.assign(function pgpass(_connectionInfo, callback) { callback(undefined); }, { warnTo() {} });\n${transformed}`
    : transformed;
}
