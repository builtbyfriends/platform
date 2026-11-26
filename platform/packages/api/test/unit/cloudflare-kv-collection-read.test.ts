import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Validator } from '@cfworker/json-schema';
import { describe, expect, it, vi } from 'vite-plus/test';
import { prepareCloudflareProviderRead } from '../../src/infrastructure/cloudflare-provider-read.ts';
import type { Resource } from '../../src/types.ts';

const compressed = readFileSync(
  new URL('../fixtures/cloudflare-openapi/kv-keys-get.json.gz', import.meta.url),
);
const documentBytes = gunzipSync(compressed);
const artifact = {
  method: 'GET',
  path: '/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/keys',
  operationId: "workers-kv-namespace-list-a-namespace'-s-keys",
  document: JSON.parse(documentBytes.toString()),
};
const bindings = { CF_ACCOUNT_ID: 'a'.repeat(32), CF_API_TOKEN: 'private-token' };
const resource: Resource = {
  id: 'owned-cache',
  project_id: 'app',
  type: 'kv',
  cf_id: 'b'.repeat(32),
  binding_name: 'Cache',
  metadata: {},
  created_at: '2026-11-26T00:00:00Z',
};
function envelope(
  result: unknown = [{ name: 'session:one', expiration: 0, metadata: { token: 'private-value' } }],
  result_info: unknown = { count: 1, cursor: 'next+/=' },
) {
  return Response.json({ success: true, errors: [], messages: [], result, result_info });
}
function setup() {
  const prepared = prepareCloudflareProviderRead(artifact, 'kv');
  if (!prepared) {
    throw Error('Missing key list capability');
  }
  const caller = {
    project: { id: 'app' },
    resource: structuredClone(resource),
    stillAuthorized: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    resolveProviderIdentity: vi.fn<() => Promise<string | null>>().mockResolvedValue('foreign'),
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => envelope());
  const read = (input: unknown = {}) => prepared.read(bindings, caller, input, fetcher);
  return { prepared, caller, fetcher, read };
}

describe('owned schema-backed KV key collections', () => {
  it('uses the exact pinned operation and the owned namespace, without revealing values or metadata', async () => {
    expect(createHash('sha256').update(documentBytes).digest('hex')).toBe(
      '0135d3090c6754af0e3bf7941de6e55421d2823cf4df2912f7ed333b5a5108d9',
    );
    expect(documentBytes.length).toBe(8518);
    expect(compressed.length).toBe(2782);
    const { prepared, caller, fetcher, read } = setup();
    const result = await read();
    expect(result).toEqual({
      appId: 'app',
      resourceId: 'owned-cache',
      action: artifact.operationId,
      kind: 'provider-read',
      data: {
        name: 'Cache',
        records: [{ name: 'session:one', expiration: 0 }],
        pagination: { limit: 50, count: 1, nextCursor: 'next+/=', hasMore: true },
      },
    });
    expect(new Validator(prepared.outputSchema, '7').validate(result).valid).toBe(true);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${bindings.CF_ACCOUNT_ID}/storage/kv/namespaces/${resource.cf_id}/keys?limit=50`,
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(caller.resolveProviderIdentity).not.toHaveBeenCalled();
    expect(caller.stillAuthorized).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('private-');
    expect((await prepared.describe()).effect).toBe('read');
  });

  it('serializes prefix and cursor as query data and preserves omitted expiry', async () => {
    const { fetcher, read } = setup();
    fetcher.mockResolvedValueOnce(envelope([{ name: 'session:/?&é' }], { count: 1, cursor: '' }));
    expect(
      await read({ query: { prefix: 'session:/?&é', cursor: 'previous+/=', limit: 10 } }),
    ).toMatchObject({
      data: {
        records: [{ name: 'session:/?&é' }],
        pagination: { hasMore: false, nextCursor: null },
      },
    });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe(
      `/client/v4/accounts/${bindings.CF_ACCOUNT_ID}/storage/kv/namespaces/${resource.cf_id}/keys`,
    );
    expect(url.searchParams.get('prefix')).toBe('session:/?&é');
    expect(url.searchParams.get('cursor')).toBe('previous+/=');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('accepts an empty prefix and does not infer completeness from an absent cursor', async () => {
    const { fetcher, read } = setup();
    fetcher.mockResolvedValueOnce(envelope([], {}));
    expect(await read({ query: { prefix: '' } })).toMatchObject({
      data: { records: [], pagination: { hasMore: null, nextCursor: null, count: 0 } },
    });
  });

  it.each([
    { query: { prefix: 'x'.repeat(513) } },
    { query: { prefix: 'é'.repeat(257) } },
    { query: { prefix: '\n' } },
    { query: { prefix: {} } },
    { query: { limit: 9 } },
    { query: { limit: 201 } },
    { query: { limit: 10.5 } },
    { query: { cursor: '' } },
    { query: { cursor: 'x'.repeat(2049) } },
    { query: { cursor: '\n' } },
    { query: { namespace_id: 'c'.repeat(32) } },
    { query: { fields: ['metadata'] } },
    { account_id: 'c'.repeat(32) },
    { headers: {} },
    { path: '/accounts/foreign' },
  ])('rejects invalid or unowned input %j before fetching', async (input) => {
    const { fetcher, read } = setup();
    await expect(read(input)).rejects.toThrow('input fields');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects changed ownership before or after access and invalid inventory identities', async () => {
    const { caller, fetcher, read } = setup();
    caller.resource.cf_id = 'not-a-namespace';
    await expect(read()).rejects.toThrow('not connected');
    caller.resource.cf_id = resource.cf_id;
    caller.resource.project_id = 'foreign';
    await expect(read()).rejects.toThrow('not connected');
    caller.resource.project_id = 'app';
    caller.stillAuthorized.mockResolvedValueOnce(false);
    await expect(read()).rejects.toThrow('resource changed');
    expect(fetcher).not.toHaveBeenCalled();
    caller.stillAuthorized.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(read()).rejects.toThrow('resource changed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { rows: [{}], info: {} },
    { rows: [{ name: '' }], info: {} },
    { rows: [{ name: 'é'.repeat(257) }], info: {} },
    { rows: [{ name: 'x', expiration: 'tomorrow' }], info: {} },
    { rows: [{ name: 'x' }, { name: 'x' }], info: { count: 2, cursor: '' } },
    { rows: [{ name: 'x' }], info: { count: 2 } },
    { rows: [{ name: 'x' }], info: { cursor: 'previous' } },
    { rows: [{ name: 'x' }], info: { cursor: '\n' } },
    { rows: [{ name: 'x' }], info: { cursor: 'x'.repeat(2049) } },
    { rows: null, info: {} },
  ])('rejects malformed provider pages %j', async ({ rows, info }) => {
    const { fetcher, read } = setup();
    fetcher.mockResolvedValueOnce(envelope(rows, info));
    await expect(read({ query: { cursor: 'previous' } })).rejects.toThrow();
  });

  it('rejects excess records, oversized provider bodies and untrusted errors', async () => {
    const { fetcher, read } = setup();
    fetcher.mockResolvedValueOnce(
      envelope(
        Array.from({ length: 11 }, (_, i) => ({ name: String(i) })),
        { count: 11, cursor: '' },
      ),
    );
    await expect(read({ query: { limit: 10 } })).rejects.toThrow('invalid result page');
    fetcher.mockResolvedValueOnce(envelope([{ name: 'x', metadata: 'x'.repeat(256 * 1024) }]));
    await expect(read()).rejects.toThrow('too large');
    fetcher.mockResolvedValueOnce(
      Response.json({ error: 'private-provider-secret' }, { status: 403 }),
    );
    await expect(read()).rejects.toThrow('could not return');
  });

  it('fails closed on unapproved query fields or changed operation schemas', () => {
    const changed = structuredClone(artifact);
    changed.document.paths[changed.path].get.parameters.push({
      name: 'namespace',
      in: 'query',
      schema: { type: 'string' },
    });
    expect(() => prepareCloudflareProviderRead(changed, 'kv')).toThrow('unapproved query');
    expect(prepareCloudflareProviderRead({ ...artifact, method: 'POST' }, 'kv')).toBeNull();
    expect(prepareCloudflareProviderRead(artifact, 'queue')).toBeNull();
    expect(() =>
      prepareCloudflareProviderRead({ ...artifact, operationId: 'different' }, 'kv'),
    ).toThrow();
  });

  it('bounds the serialized projection even when each key and the provider body fit', async () => {
    const { fetcher, read } = setup();
    fetcher.mockResolvedValueOnce(
      envelope(
        Array.from({ length: 200 }, (_, index) => ({ name: `${index}${'"'.repeat(350)}` })),
        { count: 200, cursor: '' },
      ),
    );
    await expect(read({ query: { limit: 200 } })).rejects.toThrow(
      'projected provider response is too large',
    );
  });
});
