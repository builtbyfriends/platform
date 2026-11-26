import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { readResourceDefinition } from '../shared/resource-definition.ts';
import { resourceNameWords } from '../shared/resource-name.ts';

export type WorkflowModule = {
  filePath: string;
  bindingName: string;
  className: string;
  workflowName: string;
  name?: string;
};

const MODULE_PATTERN = /\.(?:[cm]?[jt]s)$/;

const WORKFLOW_HELPERS = new Set(['defineWorkflow']);

export function inferWorkflowResourceName(filePath: string): string {
  return filePath.replaceAll('\\', '/').split('/').pop()!.replace(MODULE_PATTERN, '');
}

export function deriveWorkflowResourceIdentity(name: string): {
  bindingName: string;
  className: string;
  workflowName: string;
} {
  const parts = resourceNameWords(name);
  const classBase = parts.map((part) => part[0].toUpperCase() + part.slice(1)).join('');
  return {
    bindingName: parts.join('_').toUpperCase(),
    className: `${classBase}Workflow`,
    workflowName: parts.join('-').toLowerCase(),
  };
}

export function scanWorkflowModules(root: string): Array<WorkflowModule> {
  const directory = join(root, 'workflows');
  if (!existsSync(directory)) {
    return [];
  }

  const modules = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && MODULE_PATTERN.test(entry.name) && !entry.name.endsWith('.d.ts'),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const filePath = join(directory, entry.name);
      const definition = readResourceDefinition(
        filePath,
        readFileSync(filePath, 'utf8'),
        WORKFLOW_HELPERS,
      );
      const name = definition?.name;
      const resourceName = name ?? inferWorkflowResourceName(entry.name);
      if (resourceNameWords(resourceName).length === 0) {
        throw new Error(`workflow: cannot derive a name from workflows/${entry.name}.`);
      }
      return {
        filePath,
        ...deriveWorkflowResourceIdentity(resourceName),
        ...(name === undefined ? {} : { name }),
      };
    });

  const bindings = new Set<string>();
  const classes = new Set<string>();
  const names = new Set<string>();
  for (const module of modules) {
    if (
      bindings.has(module.bindingName) ||
      classes.has(module.className) ||
      names.has(module.workflowName)
    ) {
      throw new Error(
        `workflow: duplicate generated name for '${module.filePath}'. Choose a different resource name or rename one of the workflows files.`,
      );
    }
    bindings.add(module.bindingName);
    classes.add(module.className);
    names.add(module.workflowName);
  }
  return modules;
}
