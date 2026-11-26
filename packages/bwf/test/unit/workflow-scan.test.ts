import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { compileWorkerEntry } from '../../src/router/compile.ts';
import { deriveWorkflowResourceIdentity, scanWorkflowModules } from '../../src/workflow/scan.ts';

const roots: Array<string> = [];

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-workflow-scan-'));
  roots.push(root);
  mkdirSync(join(root, 'workflows'));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(root, 'workflows', name), source);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('scanWorkflowModules', () => {
  it('finds nothing when the project has no workflows folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-workflow-scan-'));
    roots.push(root);
    expect(scanWorkflowModules(root)).toEqual([]);
  });

  it('derives the binding, class and Workflow name from the file name', () => {
    const root = project({ 'send-welcome.ts': 'export default class {}' });
    expect(scanWorkflowModules(root)).toEqual([
      {
        filePath: toSlash(join(root, 'workflows', 'send-welcome.ts')),
        bindingName: 'SEND_WELCOME',
        className: 'SendWelcomeWorkflow',
        workflowName: 'send-welcome',
      },
    ]);
  });

  it('uses the explicit name from defineWorkflow, through an imported alias', () => {
    const root = project({
      'welcome.ts': `import { defineWorkflow as workflow } from '@builtbyfriends/bwf/workflow';
      class Welcome {};
      export default workflow({ name: 'onboarding', class: Welcome });`,
    });
    expect(scanWorkflowModules(root)[0]).toMatchObject({
      name: 'onboarding',
      ...deriveWorkflowResourceIdentity('onboarding'),
    });
  });

  it('rejects file names that give the same generated names', () => {
    const root = project({
      'send-welcome.ts': 'export default class {}',
      'send_welcome.ts': 'export default class {}',
    });
    expect(() => scanWorkflowModules(root)).toThrow(/duplicate generated name/);
  });

  it('exports each class from the generated Worker entry and binds its definition', () => {
    const entry = compileWorkerEntry({
      runtimeEnvPath: '/runtime/env.ts',
      workflows: [
        {
          bindingName: 'SEND_WELCOME',
          className: 'SendWelcomeWorkflow',
          filePath: '/app/workflows/send-welcome.ts',
        },
      ],
    });
    expect(entry).toContain('import __platformWorkflow0 from "/app/workflows/send-welcome.ts";');
    expect(entry).toContain('__platformWorkflow0.__bind("SEND_WELCOME", undefined);');
    expect(entry).toContain('export { SendWelcomeWorkflow };');
  });
});
