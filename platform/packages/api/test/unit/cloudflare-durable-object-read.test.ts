import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Validator } from '@cfworker/json-schema';
import { describe, expect, it, vi } from 'vite-plus/test';
import { prepareCloudflareProviderRead } from '../../src/infrastructure/cloudflare-provider-read.ts';
import type { Resource } from '../../src/types.ts';

const artifact = {
  method: 'GET',
  path: '/accounts/{account_id}/workers/durable_objects/namespaces/{id}/objects',
  operationId: 'durable-objects-namespace-list-objects',
  document: JSON.parse(
    gunzipSync(
      readFileSync(
        new URL('../fixtures/cloudflare-openapi/durable-object-get.json.gz', import.meta.url),
      ),
    ).toString(),
  ),
};
const namespace = 'a'.repeat(32);
const instance = 'b'.repeat(64);
const resource: Resource = {
  id: 'owned-resource',
  project_id: 'app',
  type: 'durable-object',
  cf_id: 'managed-host-worker',
  binding_name: 'Rooms',
  metadata: { namespaceId: namespace },
  created_at: '2026-11-25T00:00:00Z',
};
const bindings = { CF_ACCOUNT_ID: 'c'.repeat(32), CF_API_TOKEN: 'private-token' };
function envelope(
  result: unknown = [{ id: instance, hasStoredData: true, secret: 'private-record-data' }],
  result_info: unknown = { count: 1, cursor: 'next+/=' },
) {
  return Response.json({ success: true, errors: [], messages: [], result, result_info });
}
function setup() {
  const prepared = prepareCloudflareProviderRead(artifact, 'durable-object');
  if (!prepared) {
    throw Error('Missing prepared instance operation');
  }
  const caller = {
    project: { id: 'app' },
    resource: structuredClone(resource),
    stillAuthorized: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    resolveProviderIdentity: vi.fn<() => Promise<string | null>>().mockResolvedValue(namespace),
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => envelope());
  const read = (input: unknown = {}) => prepared.read(bindings, caller, input, fetcher);
  return { prepared, caller, fetcher, read };
}

describe('schema-backed bounded instance lists', () => {
  it('uses a proven namespace rather than the inventory Worker name and exposes only safe rows', async () => {
    const { prepared, caller, fetcher, read } = setup();
    const result = await read();
    expect(result).toEqual({
      appId: 'app',
      resourceId: resource.id,
      action: artifact.operationId,
      kind: 'provider-read',
      data: {
        name: 'Rooms',
        records: [{ id: instance, hasStoredData: true }],
        pagination: { limit: 50, count: 1, nextCursor: 'next+/=', hasMore: true },
      },
    });
    expect(new Validator(prepared.outputSchema, '7').validate(result).valid).toBe(true);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${bindings.CF_ACCOUNT_ID}/workers/durable_objects/namespaces/${namespace}/objects?limit=50`,
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(caller.resolveProviderIdentity).toHaveBeenCalledTimes(2);
    expect(caller.stillAuthorized).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(resource.cf_id);
    expect(JSON.stringify(result)).not.toContain('private-');
    expect((await prepared.describe()).effect).toBe('read');
  });

  it('serializes bounded cursor requests and preserves false or absent stored-data flags', async () => {
    const { fetcher, read } = setup();
    fetcher.mockResolvedValueOnce(
      envelope([{ id: instance, hasStoredData: false }, { id: 'd'.repeat(64) }], {
        count: 2,
        cursor: '',
      }),
    );
    expect(await read({ query: { limit: 10, cursor: 'previous+/=' } })).toMatchObject({
      data: {
        records: [{ id: instance, hasStoredData: false }, { id: 'd'.repeat(64) }],
        pagination: { limit: 10, count: 2, nextCursor: null, hasMore: false },
      },
    });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get('cursor')).toBe('previous+/=');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('does not claim a complete inventory when the provider omits pagination', async () => {
    const { fetcher, read } = setup();
    fetcher.mockResolvedValueOnce(
      Response.json({ success: true, errors: [], messages: [], result: [] }),
    );
    expect(await read()).toMatchObject({
      data: { records: [], pagination: { count: 0, nextCursor: null, hasMore: null } },
    });
  });

  it.each([
    { limit: 9 },
    { limit: 201 },
    { limit: 10.5 },
    { limit: '10' },
    { cursor: '' },
    { cursor: 'x'.repeat(2049) },
    { cursor: 'unsafe\nvalue' },
    { namespaceId: namespace },
  ])('rejects invalid pagination input %j before provider access', async (query) => {
    const { fetcher, read } = setup();
    await expect(read({ query })).rejects.toThrow('input fields');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unresolved, missing and changed ownership rather than falling back to metadata', async () => {
    const { caller, fetcher, read, prepared } = setup();
    caller.resolveProviderIdentity.mockResolvedValueOnce(null);
    await expect(read()).rejects.toThrow('not connected');
    await expect(
      prepared.read(bindings, { ...caller, resolveProviderIdentity: undefined }, {}, fetcher),
    ).rejects.toThrow('not connected');
    caller.resolveProviderIdentity.mockResolvedValueOnce('managed-host-worker');
    await expect(read()).rejects.toThrow('not connected');
    expect(fetcher).not.toHaveBeenCalled();
    caller.resolveProviderIdentity
      .mockResolvedValueOnce(namespace)
      .mockResolvedValueOnce('d'.repeat(32));
    await expect(read()).rejects.toThrow('resource changed');
    caller.stillAuthorized.mockResolvedValueOnce(false);
    await expect(read()).rejects.toThrow('resource changed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { result: [{ id: instance }, { id: instance }], info: { count: 2, cursor: '' } },
    { result: [{}], info: { count: 1, cursor: '' } },
    { result: [{ id: '../unsafe' }], info: { count: 1, cursor: '' } },
    { result: [{ id: instance, hasStoredData: 'yes' }], info: { count: 1, cursor: '' } },
    { result: [{ id: instance }], info: { count: 20, cursor: '' } },
    { result: [{ id: instance }], info: { count: 1, cursor: 'previous' } },
    { result: [{ id: instance }], info: { cursor: 'x'.repeat(2049) } },
    { result: [{ id: instance }], info: { cursor: 'unsafe\nvalue' } },
    { result: null, info: {} },
  ])('rejects malformed pages without publishing partial rows', async ({ result, info }) => {
    const { fetcher, read } = setup();
    fetcher.mockResolvedValueOnce(envelope(result, info));
    await expect(read({ query: { cursor: 'previous' } })).rejects.toThrow();
  });

  it('rejects pages above the requested limit and oversized responses', async () => {
    const { fetcher, read } = setup();
    fetcher.mockResolvedValueOnce(
      envelope(
        Array.from({ length: 11 }, (_, index) => ({ id: index.toString(16).padStart(64, '0') })),
        { count: 11, cursor: 'next' },
      ),
    );
    await expect(read({ query: { limit: 10 } })).rejects.toThrow('invalid result page');
    fetcher.mockResolvedValueOnce(envelope([{ id: instance, extra: 'x'.repeat(256 * 1024) }]));
    await expect(read()).rejects.toThrow('too large');
  });
});
