import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogDrift, coverageDrift, coverageReport } from './check-cloudflare-catalog.mjs';

test('reports additions, removals, schema and alias drift without accepting a changed operation', () => {
  const previous = [{ id: 'a', schemaSha256: 'old', aliases: ['legacy'] }, { id: 'removed' }];
  const next = [{ id: 'a', schemaSha256: 'new', aliases: ['legacy'] }, { id: 'added' }];
  assert.deepEqual(catalogDrift(previous, next), {
    added: ['added'],
    removed: ['removed'],
    changed: ['a'],
  });
  assert.deepEqual(catalogDrift(next, next), { added: [], removed: [], changed: [] });
  assert.deepEqual(catalogDrift(previous, [{ ...previous[0], aliases: ['renamed'] }]).changed, [
    'a',
  ]);
  assert.throws(() => catalogDrift([], [{ id: 'same' }, { id: 'same' }]), /Duplicate/);
});
test('reports pinned coverage separately from installed policies and live acceptance', async () => {
  const report = await coverageReport();
  assert.equal(report.counts.discoverable, 3944);
  assert.equal(report.counts.apiOnly, 1000);
  assert.equal(report.counts.cliAliases, 2947);
  assert.equal(report.counts.providerPolicies, 12);
  assert.equal(report.counts.proxyPolicies, 3);
  assert.equal(report.operations.filter((entry) => entry.installedPolicies.length).length, 12);
  assert.ok(
    report.operations.every(
      (entry) => entry.liveTested === 'not-recorded' && entry.uiAccepted === 'not-recorded',
    ),
  );
  assert.ok(['matches-pin', 'not-installed'].includes(report.installedCli.status));
});

test('requires review for proxy operation versions and provenance changes too', () => {
  const previous = {
    source: { sha256: 'old' },
    operations: [],
    proxyOperations: [{ id: 'database.query', version: 'old' }],
  };
  assert.equal(coverageDrift(previous, previous).reviewRequired, false);
  const changed = coverageDrift(previous, {
    ...previous,
    proxyOperations: [{ id: 'database.query', version: 'new' }],
  });
  assert.deepEqual(changed.proxyOperations.changed, ['database.query']);
  assert.equal(changed.reviewRequired, true);
  assert.equal(
    coverageDrift(previous, { ...previous, source: { sha256: 'new' } }).reviewRequired,
    true,
  );
});
