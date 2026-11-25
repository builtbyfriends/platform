import { describe, expect, it } from 'vite-plus/test';
import { catalogPage, cloudflareCatalog } from '../../src/infrastructure/cloudflare-catalog.ts';

describe('pinned Cloudflare catalog', () => {
  it('validates the shipped snapshot and its operation coverage', async () => {
    const catalog = await cloudflareCatalog();
    expect(catalog.operations).toHaveLength(2947);
    expect(catalog.operations.every((entry) => entry.execution === 'discovery-only')).toBe(true);
    expect(catalog.source.cliVersion).toBe('1.0.0-rc.2');
  });

  it('bounds large pages by metadata size without losing operations', async () => {
    const catalog = await cloudflareCatalog();
    const scope = { appId: 'app', resourceId: null, product: 'zero-trust' };

    const expected = catalog.operations
      .filter((entry) => entry.command.startsWith('cf zero-trust '))
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
