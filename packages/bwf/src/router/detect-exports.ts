import { readFileSync } from 'node:fs';
import { basename } from 'pathslash';
import { parseSync } from 'vite';
import { bindingNames } from '../shared/ast-bindings.ts';
import { isIdentifier, moduleExportName, isAstProgram } from '../shared/ast.ts';
import type {
  AstExportNamedDeclaration,
  AstFunctionDeclaration,
  AstProgram,
  AstVariableDeclaration,
} from '../shared/ast.ts';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

/**
 * Detect which HTTP method names are exported from a route file.
 * Scans top-level named exports for identifiers matching HTTP methods.
 */
export function detectHttpExports(absPath: string): Array<string> {
  const code = readFileSync(absPath, 'utf8');
  const filename = basename(absPath);
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filename, code);
  } catch {
    return [];
  }

  const methods: Array<string> = [];
  if (!isAstProgram(parsed.program)) {
    return [];
  }
  const program: AstProgram = parsed.program;

  for (const node of program.body ?? []) {
    if (node.type === 'ExportNamedDeclaration') {
      const declarationNode = node as AstExportNamedDeclaration;
      if (declarationNode.exportKind === 'type') {
        continue;
      }
      const decl = declarationNode.declaration;
      if (decl) {
        if (decl.type === 'VariableDeclaration') {
          for (const declarator of (decl as AstVariableDeclaration).declarations ?? []) {
            methods.push(...bindingNames(declarator.id).filter((name) => HTTP_METHODS.has(name)));
          }
        } else if (decl.type === 'FunctionDeclaration') {
          const fn = decl as AstFunctionDeclaration;
          if (isIdentifier(fn.id) && HTTP_METHODS.has(fn.id.name)) {
            methods.push(fn.id.name);
          }
        }
      }
      if (declarationNode.specifiers) {
        for (const spec of declarationNode.specifiers) {
          if (spec.exportKind === 'type') {
            continue;
          }
          const exported = moduleExportName(spec.exported);
          if (exported && HTTP_METHODS.has(exported)) {
            methods.push(exported);
          }
        }
      }
    }
  }

  return methods;
}
