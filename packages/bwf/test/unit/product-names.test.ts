import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vite-plus/test';

// Decision: This repository is part of the product: it takes an app as input and doesn't know which app
// it is. The app we build on it is one of those apps, so its name has no place in product
// code, tests, docs or package manifests. The reasons are in docs/scopes.md in that app's
// repository.
// The name is built from two parts so that this file passes its own check.
const appName = ['ded', 'worc'].join('');

// Decision: A deliberate mention goes here with its reason. A row that matches no file fails, so the
// list stays current.
const allowed: Array<{ file: string; reason: string }> = [
  {
    file: 'AGENTS.md',
    reason: 'Explains the product and our own setup to agents, and names the app.',
  },
  // Decision: Preserve the exact local rollback paths recorded in these deployment receipts.
  {
    file: 'platform/meta/database-indexes-deploy-2026-11-25.md',
    reason: 'Historical deployment evidence includes the local rollback path.',
  },
  {
    file: 'platform/meta/database-inspection-deploy-2026-11-25.md',
    reason: 'Historical deployment evidence includes the local rollback path.',
  },
  {
    file: 'platform/meta/job-activity-deploy-2026-11-25.md',
    reason: 'Historical deployment evidence includes the local rollback path.',
  },
  {
    file: 'platform/meta/queue-delivery-deploy-2026-11-25.md',
    reason: 'Historical deployment evidence includes the local rollback path.',
  },
  {
    file: 'platform/meta/queue-status-deploy-2026-11-25.md',
    reason: 'Historical deployment evidence includes the local rollback path.',
  },
];

function filesThatNameTheApp(): Array<string> {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  try {
    return execFileSync('git', ['grep', '-Iil', appName], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    // Decision: git grep exits with 1 when nothing matches.
    if ((error as { status?: number }).status === 1) {
      return [];
    }
    throw error;
  }
}

describe('product code stays free of app-specific names', () => {
  const found = filesThatNameTheApp();

  it('names no specific app outside the allowed list', () => {
    const allowedFiles = new Set(allowed.map((row) => row.file));
    expect(found.filter((file) => !allowedFiles.has(file))).toEqual([]);
  });

  it('has no allowed row that matches nothing', () => {
    expect(allowed.filter((row) => !found.includes(row.file))).toEqual([]);
  });
});
