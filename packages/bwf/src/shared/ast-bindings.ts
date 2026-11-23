import { walk } from 'estree-walker';
import { astChild, astChildren, isAstNode, isIdentifier } from './ast.ts';
import type { AstNode, AstProgram } from './ast.ts';

/** Names introduced by a binding pattern, excluding keys and default expressions. */
export function bindingNames(node: AstNode | null | undefined): Array<string> {
  if (isIdentifier(node)) {
    return [node.name];
  }
  if (node?.type === 'ObjectPattern') {
    return astChildren(node, 'properties').flatMap((property) =>
      bindingNames(astChild(property, property.type === 'RestElement' ? 'argument' : 'value')),
    );
  }
  if (node?.type === 'ArrayPattern') {
    return astChildren(node, 'elements').flatMap(bindingNames);
  }
  if (node?.type === 'AssignmentPattern' || node?.type === 'RestElement') {
    return bindingNames(astChild(node, 'left') ?? astChild(node, 'argument'));
  }
  if (node?.type === 'TSParameterProperty') {
    return bindingNames(astChild(node, 'parameter'));
  }
  return [];
}

type Scope = {
  parent?: Scope;
  bindings?: Map<string, AstNode>;
  varScope: boolean;
};

type WalkNode = Parameters<typeof walk>[0];

function isWalkNode(value: unknown): value is WalkNode {
  return isAstNode(value);
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/**
 * Resolve lexical bindings after collecting declarations, including hoisted and later bindings.
 * A visitor can collect references in the same pass; return true to retain a node's scope.
 * Names can limit binding collection when only specific imports need resolution.
 */
export function bindingResolver(
  program: AstProgram,
  options?: { visit?: (node: AstNode) => boolean; names?: ReadonlySet<string> },
): (node: AstNode, name: string) => AstNode | undefined {
  const scopes = new WeakMap<AstNode, Scope>();
  const outerScopes = new WeakMap<AstNode, Scope>();
  let scope: Scope = { varScope: true };
  const declare = (pattern: AstNode | undefined, declaration: AstNode, target = scope) => {
    for (const name of bindingNames(pattern)) {
      if (!options?.names || options.names.has(name)) {
        (target.bindings ??= new Map()).set(name, declaration);
      }
    }
  };
  if (!isWalkNode(program)) {
    return () => undefined;
  }
  walk(program, {
    enter(node, rawParent, key) {
      if (!isAstNode(node)) {
        return;
      }
      const parent = isAstNode(rawParent) ? rawParent : null;
      const outerScope = scope;
      // Decision: The discriminant and all its descendants precede the case block's scope.
      if (parent?.type === 'SwitchStatement' && key === 'discriminant') {
        scope = scope.parent ?? scope;
      }
      if (
        [
          'FunctionDeclaration',
          'ClassDeclaration',
          'TSEnumDeclaration',
          'TSModuleDeclaration',
        ].includes(node.type)
      ) {
        declare(astChild(node, 'id'), node);
      }
      const isFunction = FUNCTIONS.has(node.type);
      if (
        isFunction ||
        node.type === 'BlockStatement' ||
        node.type === 'StaticBlock' ||
        node.type === 'CatchClause' ||
        node.type === 'ForStatement' ||
        node.type === 'ForInStatement' ||
        node.type === 'ForOfStatement' ||
        node.type === 'SwitchStatement' ||
        node.type === 'ClassDeclaration' ||
        node.type === 'ClassExpression' ||
        node.type === 'TSModuleDeclaration'
      ) {
        scope = {
          parent: scope,
          varScope:
            isFunction ||
            node.type === 'StaticBlock' ||
            node.type === 'TSModuleDeclaration' ||
            (node.type === 'BlockStatement' && !!parent && FUNCTIONS.has(parent.type)),
        };
      }
      if (scope !== outerScope) {
        outerScopes.set(node, outerScope);
      }
      if (!options?.visit || options.visit(node)) {
        scopes.set(node, scope);
      }
      if (isFunction) {
        if (node.type === 'FunctionExpression') {
          declare(astChild(node, 'id'), node);
        }
        for (const parameter of astChildren(node, 'params')) {
          declare(parameter, parameter);
        }
      } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
        declare(astChild(node, 'id'), node);
      } else if (node.type === 'CatchClause') {
        declare(astChild(node, 'param'), node);
      } else if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
        for (const specifier of astChildren(node, 'specifiers')) {
          if (specifier.importKind !== 'type') {
            declare(astChild(specifier, 'local'), specifier);
          }
        }
      } else if (node.type === 'VariableDeclaration') {
        let target = scope;
        if (node.kind === 'var') {
          while (!target.varScope && target.parent) {
            target = target.parent;
          }
        }
        for (const declaration of astChildren(node, 'declarations')) {
          declare(astChild(declaration, 'id'), declaration, target);
        }
      }
    },
    leave(raw) {
      const outer = isAstNode(raw) ? outerScopes.get(raw) : undefined;
      if (outer) {
        scope = outer;
      }
    },
  });
  return (node, name) => {
    let current = scopes.get(node);
    while (current) {
      const binding = current.bindings?.get(name);
      if (binding) {
        return binding;
      }
      current = current.parent;
    }
    return undefined;
  };
}
