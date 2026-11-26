import { describe, expect, it } from 'vite-plus/test';
import { catalogPage, cloudflareCatalog } from '../../src/infrastructure/cloudflare-catalog.ts';

describe('pinned Cloudflare catalog', () => {
  it('validates the shipped snapshot and its operation coverage', async () => {
    const catalog = await cloudflareCatalog();
    expect(catalog.operations).toHaveLength(3944);
    expect(catalog.operations.every((entry) => entry.execution === 'discovery-only')).toBe(true);
    expect(catalog.source.cliVersion).toBe('1.0.0-rc.2');
  });

  it('bounds large pages by metadata size without losing operations', async () => {
    const catalog = await cloudflareCatalog();
    const scope = { appId: 'app', resourceId: null, product: 'zero-trust' };

    const expected = catalog.operations
      .filter((entry) => entry.product === 'zero-trust')
      .map((entry) => entry.id);

    const ids: Array<string> = [];
    let cursor: string | undefined;

    do {
      const page = catalogPage(catalog, scope, 50, cursor);
      expect(
        new TextEncoder().encode(JSON.stringify(page.operations)).byteLength,
      ).toBeLessThanOrEqual(32_768);
      expect(page.operations.length).toBeGreaterThan(0);
      ids.push(...page.operations.map((entry) => entry.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(ids).toEqual(expected);
  });

  it('rejects cursor reuse across projects and snapshot revisions', async () => {
    const catalog = await cloudflareCatalog();
    const scope = { appId: 'app', resourceId: 'resource', product: 'd1' };
    const first = catalogPage(catalog, scope, 1);
    expect(() => catalogPage(catalog, { ...scope, appId: 'other' }, 1, first.nextCursor!)).toThrow(
      'invalid_cursor',
    );
    expect(() =>
      catalogPage(
        { ...catalog, source: { ...catalog.source, sha256: 'changed' } },
        scope,
        1,
        first.nextCursor!,
      ),
    ).toThrow('invalid_cursor');
  });
});

it('exposes API-only summaries and preserves CLI aliases without creating execution permissions', async () => {
  const catalog = await cloudflareCatalog();
  expect(catalog.operations.filter((entry) => !entry.aliases.length)).toHaveLength(1000);
  const access = catalog.operations.find(
    (entry) => entry.path === '/accounts/{account_id}/access/apps' && entry.httpMethod === 'GET',
  );
  expect(access).toMatchObject({ execution: 'discovery-only' });
  expect(access?.command).toBeUndefined();
  expect(access?.summary).toContain('Access');
  expect(access?.schemaSha256).toMatch(/^[a-f0-9]{64}$/);
  const workflow = catalog.operations.find((entry) =>
    entry.aliases.includes('workflows.instances.pause'),
  );
  expect(workflow?.aliases).toEqual(
    expect.arrayContaining(['workflows.instances.pause', 'workflows.instances.resume']),
  );
});
it('searches summaries across products and binds cursors to query, method and both artifact digests', async () => {
  const catalog = await cloudflareCatalog();
  const scope = {
    appId: 'app',
    resourceId: null,
    product: null,
    query: 'access',
    method: 'GET' as const,
  };
  const first = catalogPage(catalog, scope, 1);
  expect(first.operations).toHaveLength(1);
  expect(first.totalMatches).toBeGreaterThan(1);
  expect(
    catalogPage(catalog, { ...scope, query: ' ACCESS ' }, 1, first.nextCursor!).operations,
  ).toHaveLength(1);
  for (const changed of [
    { ...scope, query: 'queue' },
    { ...scope, method: 'POST' as const },
  ]) {
    expect(() => catalogPage(catalog, changed, 1, first.nextCursor!)).toThrow('invalid_cursor');
  }
  expect(() =>
    catalogPage(
      {
        ...catalog,
        source: {
          ...catalog.source,
          openapi: { ...catalog.source.openapi, indexSha256: 'changed' },
        },
      },
      scope,
      1,
      first.nextCursor!,
    ),
  ).toThrow('invalid_cursor');
});

it('keeps Unicode cursor state bounded and round-trippable', async () => {
  const catalog = await cloudflareCatalog();
  const query = '界'.repeat(200);
  const entries = catalog.operations.slice(0, 2).map((entry) => ({ ...entry, summary: query }));
  const fixture = { ...catalog, operations: entries };
  const scope = { appId: '界'.repeat(200), resourceId: '界'.repeat(200), product: null, query };
  const page = catalogPage(fixture, scope, 1);
  expect(page.nextCursor!.length).toBeGreaterThan(2048);
  expect(page.nextCursor!.length).toBeLessThanOrEqual(8192);
  expect(catalogPage(fixture, scope, 1, page.nextCursor!).operations[0]?.id).toBe(entries[1]?.id);
});
