import { parseSync } from 'vite';
import {
  astChild,
  astChildren,
  isAstProgram,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isImportNamespaceSpecifier,
  isImportSpecifier,
  isMemberExpression,
  isObjectExpression,
  isVariableDeclaration,
} from './ast.ts';
import type { AstNode, AstProgram } from './ast.ts';
import { isResourceName } from './resource-name.ts';
import { staticLiteral, unwrapStaticExpression } from './static-exports.ts';

type ResourceDefinition = { helper: string; options?: AstNode; name?: string };

/** Inspect default helper definitions without running application code. */
export function readResourceDefinition(
  filename: string,
  source: string,
  helpers: ReadonlySet<string>,
): ResourceDefinition | null {
  let program: AstProgram;
  try {
    const parsed = parseSync(filename, source).program;
    if (!isAstProgram(parsed)) {
      return null;
    }
    program = parsed;
  } catch {
    return null;
  }

  const constants = new Map<string, AstNode>();
  const definitions = new Map<string, AstNode>();
  const importedHelpers = new Map<string, string>();
  const namespaces = new Map<string, ReadonlySet<string>>();
  const bindings = new Set<string>();
  function recordBindings(node: AstNode | undefined): void {
    if (isIdentifier(node)) {
      bindings.add(node.name);
    } else if (node?.type === 'ObjectPattern') {
      for (const property of astChildren(node, 'properties')) {
        recordBindings(astChild(property, property.type === 'RestElement' ? 'argument' : 'value'));
      }
    } else if (node?.type === 'ArrayPattern') {
      for (const element of astChildren(node, 'elements')) {
        recordBindings(element);
      }
    } else if (node?.type === 'AssignmentPattern' || node?.type === 'RestElement') {
      recordBindings(astChild(node, 'left') ?? astChild(node, 'argument'));
    }
  }
  for (const statement of program.body ?? []) {
    if (isImportDeclaration(statement)) {
      const declaration = statement;
      const source = declaration.source.value;
      const supported =
        source === '@builtbyfriends/bwf/ws'
          ? new Set(['defineRoom', 'defineWebSocket'])
          : source === '@builtbyfriends/bwf/durable'
            ? new Set(['defineDurableState', 'defineDurableObject'])
            : source === '@builtbyfriends/bwf/workflow'
              ? new Set(['defineWorkflow'])
              : new Set<string>();
      for (const specifier of declaration.specifiers ?? []) {
        recordBindings(astChild(specifier, 'local'));
        if (isImportNamespaceSpecifier(specifier)) {
          namespaces.set(specifier.local.name, supported);
        } else if (isImportSpecifier(specifier)) {
          const named = specifier;
          const imported = isIdentifier(named.imported)
            ? named.imported.name
            : staticLiteral(named.imported);
          if (typeof imported === 'string' && supported.has(imported) && helpers.has(imported)) {
            importedHelpers.set(named.local.name, imported);
          }
        }
      }
      continue;
    }
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? astChild(statement, 'declaration') : statement;
    if (declaration) {
      recordBindings(astChild(declaration, 'id'));
    }
    if (!declaration || !isVariableDeclaration(declaration)) {
      continue;
    }
    for (const variable of declaration.declarations ?? []) {
      recordBindings(variable.id);
      if (isIdentifier(variable.id) && variable.init) {
        definitions.set(variable.id.name, variable.init);
        if (declaration.kind === 'const') {
          constants.set(variable.id.name, variable.init);
        }
      }
    }
  }

  function resolve(node: AstNode | undefined, seen = new Set<string>()): AstNode | undefined {
    node = unwrapStaticExpression(node);
    if (!isIdentifier(node) || !constants.has(node.name) || seen.has(node.name)) {
      return node;
    }
    seen.add(node.name);
    return resolve(constants.get(node.name), seen);
  }

  type StaticName = { present: boolean; value?: string };

  function isStaticUndefined(node: AstNode | undefined): boolean {
    node = resolve(node);
    return isIdentifier(node) && node.name === 'undefined' && !bindings.has(node.name);
  }

  function readName(options: AstNode | undefined, seen = new Set<AstNode>()): StaticName {
    options = resolve(options);
    if (!isObjectExpression(options) || seen.has(options)) {
      return { present: false };
    }
    seen.add(options);
    let name: StaticName = { present: false };
    for (const property of options.properties ?? []) {
      if (property.type === 'SpreadElement') {
        const spread = resolve(astChild(property, 'argument'));
        if (isObjectExpression(spread)) {
          const spreadName = readName(spread, seen);
          if (spreadName.present) {
            name = spreadName;
          }
        } else if (name.value !== undefined) {
          throw new Error(`${filename}: resource name cannot be overridden by a dynamic spread.`);
        }
        continue;
      }
      if (property.type !== 'Property') {
        continue;
      }
      const key = astChild(property, 'key');
      const keyName = !property.computed && isIdentifier(key) ? key.name : staticLiteral(key);
      if (keyName !== 'name') {
        if (property.computed && keyName === undefined && name.value !== undefined) {
          throw new Error(`${filename}: resource name cannot be overridden by a dynamic key.`);
        }
        continue;
      }
      const valueNode = astChild(property, 'value');
      if (isStaticUndefined(valueNode)) {
        name = { present: true };
        continue;
      }
      const value = staticLiteral(resolve(valueNode));
      if (!isResourceName(value)) {
        throw new Error(
          `${filename}: resource name must be a static string containing a word starting with a letter.`,
        );
      }
      name = { present: true, value };
    }
    seen.delete(options);
    return name;
  }

  const statement = program.body?.find((node) => node.type === 'ExportDefaultDeclaration');
  const declaration = unwrapStaticExpression(
    statement ? astChild(statement, 'declaration') : undefined,
  );
  const call = resolve(isIdentifier(declaration) ? definitions.get(declaration.name) : declaration);
  if (!isCallExpression(call)) {
    return null;
  }
  const callee = resolve(call.callee);
  let helper: string | undefined;
  if (isIdentifier(callee)) {
    helper =
      importedHelpers.get(callee.name) ?? (helpers.has(callee.name) ? callee.name : undefined);
  } else if (isMemberExpression(callee) && isIdentifier(callee.object)) {
    const property =
      !callee.computed && isIdentifier(callee.property)
        ? callee.property.name
        : staticLiteral(callee.property);
    if (
      typeof property === 'string' &&
      helpers.has(property) &&
      namespaces.get(callee.object.name)?.has(property)
    ) {
      helper = property;
    }
  }
  if (!helper) {
    return null;
  }
  const options = resolve(call.arguments?.[0]);
  const name = readName(options).value;
  const definition: ResourceDefinition = { helper, options };
  if (name !== undefined) {
    definition.name = name;
  }
  return definition;
}
