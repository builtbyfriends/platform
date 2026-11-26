import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vite-plus/test';
import { prepareCloudflareProviderRead } from '../../src/infrastructure/cloudflare-provider-read.ts';
import type { Resource } from '../../src/types.ts';

const bindings = { CF_ACCOUNT_ID: 'a'.repeat(32), CF_API_TOKEN: 'private-token' };
const cases = [
  {
    kind: 'queue',
    id: 'queues-get-consumer',
    file: 'queue-consumer-get',
    parentFile: 'queue-consumers-get',
    parentId: 'queues-list-consumers',
    path: '/accounts/{account_id}/queues/{queue_id}/consumers',
    parameter: 'consumer_id',
    child: 'c'.repeat(32),
    cfId: 'b'.repeat(32),
    row: {
      consumer_id: 'c'.repeat(32),
      type: 'worker',
      settings: { max_concurrency: null, max_retries: 3 },
      script_name: 'private-script',
    },
  },
  {
    kind: 'r2',
    id: 'r2-get-custom-domain-settings',
    file: 'r2-custom-domain-get',
    parentFile: 'r2-custom-domains-get',
    parentId: 'r2-list-custom-domains',
    path: '/accounts/{account_id}/r2/buckets/{bucket_name}/domains/custom',
    parameter: 'domain',
    child: 'files.example.com',
    cfId: 'owned-bucket',
    row: {
      domain: 'files.example.com',
      enabled: false,
      status: { ownership: 'active', ssl: 'pending' },
      ciphers: ['AES128-GCM-SHA256'],
      zoneId: 'private-zone',
    },
  },
] as const;

function artifact(file: string, operationId: string, path: string) {
  const document: unknown = JSON.parse(
    gunzipSync(
      readFileSync(new URL(`../fixtures/cloudflare-openapi/${file}.json.gz`, import.meta.url)),
    ).toString(),
  );
  return { operationId, path, method: 'GET', document };
}

function setup(fixture: (typeof cases)[number]) {
  const parentArtifact = artifact(fixture.parentFile, fixture.parentId, fixture.path);
  const detailArtifact = artifact(
    fixture.file,
    fixture.id,
    `${fixture.path}/{${fixture.parameter}}`,
  );
  const adapter = prepareCloudflareProviderRead(detailArtifact, fixture.kind, { parentArtifact });
  if (!adapter) {
    throw Error('Missing adapter');
  }
  const resource: Resource = {
    id: 'resource',
    project_id: 'app',
    type: fixture.kind,
    cf_id: fixture.cfId,
    binding_name: 'My resource',
    metadata: {},
    created_at: '2026-11-26T00:00:00Z',
  };
  const caller = { resource, project: { id: 'app' }, stillAuthorized: vi.fn(async () => true) };
  const envelope = (result: unknown) =>
    Response.json({ success: true, errors: [], messages: [], result });
  const listing = (rows: ReadonlyArray<unknown> = [fixture.row]) =>
    envelope(fixture.kind === 'r2' ? { domains: rows } : rows);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(listing())
    .mockResolvedValueOnce(envelope(fixture.row))
    .mockResolvedValueOnce(listing());
  return {
    parentArtifact,
    detailArtifact,
    adapter,
    caller,
    fetcher,
    envelope,
    listing,
    read: (input: unknown = { child: fixture.child }) =>
      adapter.read(bindings, caller, input, fetcher),
  };
}

describe.each(cases)('owned $kind child detail', (fixture) => {
  it('proves membership before and after the detail and projects only permitted data', async () => {
    const test = setup(fixture);
    const result = await test.read();
    expect(result).toMatchObject({
      appId: 'app',
      resourceId: 'resource',
      action: fixture.id,
      kind: 'provider-read',
      data: { [fixture.parameter]: fixture.child },
    });
    expect(JSON.stringify(result)).not.toContain('private-');
    const urls = test.fetcher.mock.calls.map(([url]) => new URL(String(url)));
    const parent = fixture.path
      .replace('{account_id}', bindings.CF_ACCOUNT_ID)
      .replace(fixture.kind === 'r2' ? '{bucket_name}' : '{queue_id}', fixture.cfId);
    expect(urls.map((url) => url.pathname)).toEqual([
      `/client/v4${parent}`,
      `/client/v4${parent}/${fixture.child}`,
      `/client/v4${parent}`,
    ]);
    expect(urls.every((url) => !url.search)).toBe(true);
  });

  it.each([
    {},
    { child: '../other' },
    { child: 'x'.repeat(300) },
    { child: fixture.child, account_id: 'other' },
    { child: fixture.child, resourceId: 'foreign' },
    { child: fixture.child, query: { cursor: 'foreign' } },
  ])('rejects invalid selection %j before provider access', async (input) => {
    const test = setup(fixture);
    await expect(test.read(input)).rejects.toThrow();
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('does not read a child absent from this owned parent', async () => {
    const test = setup(fixture);
    test.fetcher.mockReset().mockResolvedValueOnce(test.listing([]));
    await expect(test.read()).rejects.toThrow('not in the connected resource');
    expect(test.fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects another child in the detail response', async () => {
    const test = setup(fixture);
    test.fetcher
      .mockReset()
      .mockResolvedValueOnce(test.listing())
      .mockResolvedValueOnce(
        test.envelope({
          ...fixture.row,
          [fixture.parameter]: fixture.kind === 'queue' ? 'd'.repeat(32) : 'other.example.com',
        }),
      );
    await expect(test.read()).rejects.toThrow('different resource');
    expect(test.fetcher).toHaveBeenCalledTimes(2);
  });

  it('discards a detail when membership is revoked during the read', async () => {
    const test = setup(fixture);
    test.fetcher
      .mockReset()
      .mockResolvedValueOnce(test.listing())
      .mockResolvedValueOnce(test.envelope(fixture.row))
      .mockResolvedValueOnce(test.listing([]));
    await expect(test.read()).rejects.toThrow('not in the connected resource');
  });

  it('discards a detail when the parent is rebound', async () => {
    const test = setup(fixture);
    test.caller.stillAuthorized
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    await expect(test.read()).rejects.toThrow('changed');
  });

  it('rejects malformed or incomplete membership responses', async () => {
    const test = setup(fixture);
    test.fetcher
      .mockReset()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: fixture.kind === 'r2' ? { domains: [fixture.row] } : [fixture.row],
          result_info: { cursor: 'more' },
        }),
      );
    await expect(test.read()).rejects.toThrow();
    expect(test.fetcher).toHaveBeenCalledTimes(1);
  });

  it('requires the exact parent schema and pins its policy in the detail version', async () => {
    const test = setup(fixture);
    expect(() => prepareCloudflareProviderRead(test.detailArtifact, fixture.kind)).toThrow(
      'ownership policy',
    );
    expect(() =>
      prepareCloudflareProviderRead(test.detailArtifact, fixture.kind, {
        parentArtifact: { ...test.parentArtifact, path: '/wrong' },
      }),
    ).toThrow('ownership policy');
    const first = await test.adapter.describe();
    expect(first.effect).toBe('read');
    expect(first.version).toMatch(/^[a-f0-9]{64}$/);
    expect((await setup(fixture).adapter.describe()).version).toBe(first.version);
  });
});
