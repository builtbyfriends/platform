import { describe, expect, it } from 'vite-plus/test';
import { reuseDecision } from '../../../../.github/scripts/reuse-pr-checks.ts';
import { snapshotVersion } from '../../../../.github/scripts/snapshot-version.ts';

describe('snapshot versions', () => {
  it('adds the pull request and a letter-led commit id to the release it will become', () => {
    expect(snapshotVersion('1.13.9', '133', 'a1b2c3d4e5f6')).toBe('1.13.9-snap.133.ga1b2c3d');
  });

  it('names the next release when the base version is already released', () => {
    expect(snapshotVersion('1.13.9', '133', 'a1b2c3d4e5f6', true)).toBe(
      '1.13.10-snap.133.ga1b2c3d',
    );
  });

  it('keeps an all-digit commit id a valid prerelease part', () => {
    expect(snapshotVersion('1.13.9', '133', '0123456789ab')).toBe('1.13.9-snap.133.g0123456');
  });

  it('builds from the release part of a prerelease version', () => {
    expect(snapshotVersion('1.13.9-rc.1', '7', 'abcdef1')).toBe('1.13.9-snap.7.gabcdef1');
  });

  it.each([
    ['1.13', '133', 'abcdef1'],
    ['1.13.9', '01', 'abcdef1'],
    ['1.13.9', '1', 'xyz'],
  ])('refuses %s, %s, %s', (base, change, sha) => {
    expect(() => snapshotVersion(base, change, sha)).toThrow();
  });
});

describe('reusing a pull request’s checks for a release', () => {
  const sha = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const pr = {
    number: 133,
    merged_at: '2026-11-26T17:43:06Z',
    merge_commit_sha: sha,
    head: { sha: head },
  };
  const done = { name: 'done', status: 'completed', conclusion: 'success' };
  const unit = { name: 'test', status: 'completed', conclusion: 'success' };
  const base = {
    sha,
    tree: 'tree-1',
    pullRequests: [pr],
    treeOf: () => 'tree-1',
    checkRunsOf: () => [done, unit],
  };

  it('reuses them when the files match and every check passed', () => {
    expect(reuseDecision(base).reuse).toBe(true);
  });

  it('runs the full checks for a push with no pull request', () => {
    expect(reuseDecision({ ...base, pullRequests: [] }).reuse).toBe(false);
  });

  it('runs the full checks when main holds files the checked head did not', () => {
    expect(reuseDecision({ ...base, treeOf: () => 'tree-2' }).reuse).toBe(false);
  });

  it.each([
    ['a failed check', [done, { ...unit, conclusion: 'failure' }]],
    ['a check still running', [done, { ...unit, status: 'in_progress', conclusion: null }]],
    ['no done check', [unit]],
    ['no checks', []],
  ])('runs the full checks with %s', (_name, runs) => {
    expect(reuseDecision({ ...base, checkRunsOf: () => runs }).reuse).toBe(false);
  });

  it('counts skipped checks as passed', () => {
    const skipped = { name: 'live-e2e', status: 'completed', conclusion: 'skipped' };
    expect(reuseDecision({ ...base, checkRunsOf: () => [done, skipped] }).reuse).toBe(true);
  });
});
