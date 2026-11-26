import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Validator } from '@cfworker/json-schema';
import { type } from 'arktype';
import { describe, expect, it, vi } from 'vite-plus/test';
import { prepareCloudflareProviderRead } from '../../src/infrastructure/cloudflare-provider-read.ts';
import type { Resource } from '../../src/types.ts';

const artifact = {
  operationId: 'r2-get-bucket-cors-policy',
  method: 'GET',
  path: '/accounts/{account_id}/r2/buckets/{bucket_name}/cors',
  document: JSON.parse(
    gunzipSync(
      readFileSync(new URL('../fixtures/cloudflare-openapi/r2-cors-get.json.gz', import.meta.url)),
    ).toString(),
  ) as unknown,
};
const bindings = { CF_ACCOUNT_ID: 'a'.repeat(32), CF_API_TOKEN: 'private-token' };
const resource: Resource = {
  id: 'resource',
  project_id: 'app',
  type: 'r2',
  cf_id: 'owned-bucket',
  binding_name: 'Uploads',
  metadata: { jurisdiction: 'eu' },
  created_at: '2026-11-25T00:00:00Z',
};
const rule = {
  id: 'Browser uploads',
  allowed: {
    headers: ['content-type', 'x-requested-by'],
    methods: ['GET', 'PUT'],
    origins: ['https://example.test'],
  },
  exposeHeaders: ['etag'],
  maxAgeSeconds: 0,
};
function envelope(result: unknown) {
  return Response.json({ success: true, errors: [], messages: [], result });
}
function setup(selected = artifact) {
  const prepared = prepareCloudflareProviderRead(selected, 'r2');
  if (!prepared) {
    throw Error('Missing structured provider operation');
  }
  const caller = {
    resource: structuredClone(resource),
    project: { id: 'app' },
    stillAuthorized: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => envelope({ rules: [rule] }));
  const read = (input: unknown = {}) => prepared.read(bindings, caller, input, fetcher);
  return { prepared, caller, fetcher, read };
}

describe('bounded structured provider reads', () => {
  it('preserves nested rule fields, arrays and zero using the selected bucket', async () => {
    const { prepared, fetcher, caller, read } = setup();
    fetcher.mockResolvedValueOnce(envelope({ rules: [rule], privateToken: 'do-not-expose' }));
    const output = await read();
    expect(output).toEqual({
      appId: 'app',
      resourceId: 'resource',
      action: artifact.operationId,
      kind: 'provider-read',
      data: { name: 'Uploads', rules: [rule] },
    });
    expect(new Validator(prepared.outputSchema, '7').validate(output).valid).toBe(true);
    expect(JSON.stringify(output)).not.toContain('do-not-expose');
    expect(output.data).not.toHaveProperty('pagination');
    expect(String(fetcher.mock.calls[0][0])).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${bindings.CF_ACCOUNT_ID}/r2/buckets/owned-bucket/cors`,
    );
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('cf-r2-jurisdiction')).toBe('eu');
    expect(caller.stillAuthorized).toHaveBeenCalledTimes(2);
    expect((await prepared.describe()).effect).toBe('read');
  });

  it('preserves empty lists and missing optional fields without inventing pagination or defaults', async () => {
    const { fetcher, read } = setup();
    for (const result of [
      { rules: [] },
      {},
      { rules: [{ allowed: { methods: [], origins: [] } }] },
    ]) {
      fetcher.mockResolvedValueOnce(envelope(result));
      expect(await read()).toMatchObject({ data: { name: 'Uploads', ...result } });
    }
  });

  it.each([
    { rules: 'bad' },
    { rules: [{ id: 'missing allowed' }] },
    { rules: [{ allowed: { methods: ['INVALID'], origins: [] } }] },
    { rules: [{ ...rule, allowed: { ...rule.allowed, secret: 'unexpected' } }] },
    { rules: [{ ...rule, maxAgeSeconds: '0' }] },
  ])('rejects data that violates the pinned response schema (%j)', async (result) => {
    const { fetcher, read } = setup();
    fetcher.mockResolvedValueOnce(envelope(result));
    await expect(read()).rejects.toThrow('unexpected resource response');
  });

  it.each([
    { rules: Array.from({ length: 201 }, () => rule) },
    {
      rules: [
        { ...rule, allowed: { ...rule.allowed, origins: Array(201).fill('https://example.test') } },
      ],
    },
    { rules: [{ ...rule, id: 'x'.repeat(16385) }] },
    {
      rules: Array.from({ length: 200 }, () => ({
        ...rule,
        allowed: { ...rule.allowed, headers: Array(20).fill('x') },
      })),
    },
    { rules: Array.from({ length: 10 }, () => ({ ...rule, id: 'x'.repeat(14000) })) },
  ])('rejects responses above projection bounds (%#)', async (result) => {
    const { fetcher, read } = setup();
    fetcher.mockResolvedValueOnce(envelope(result));
    await expect(read()).rejects.toThrow(/invalid array|invalid scalar|too many values|too large/);
  });

  it('projects only explicit safe leaves even when a provider schema permits unknown fields', async () => {
    const selected = structuredClone(artifact);
    const document = type({
      components: {
        schemas: {
          'r2_cors-rule': {
            additionalProperties: 'boolean',
            properties: { allowed: { additionalProperties: 'boolean' } },
          },
        },
      },
    }).assert(selected.document);
    document.components.schemas['r2_cors-rule'].additionalProperties = true;
    document.components.schemas['r2_cors-rule'].properties.allowed.additionalProperties = true;
    const { fetcher, read } = setup(selected);
    fetcher.mockResolvedValueOnce(
      envelope({
        rules: [
          {
            ...rule,
            privateToken: 'rule-secret',
            allowed: { ...rule.allowed, secret: 'nested-secret' },
          },
        ],
      }),
    );
    const output = await read();
    expect(output.data).toEqual({ name: 'Uploads', rules: [rule] });
    expect(JSON.stringify(output)).not.toContain('secret');
  });

  it('fails preparation when an approved scalar becomes write-only or structured', () => {
    for (const change of [{ writeOnly: true }, { type: 'object' }]) {
      const selected = structuredClone(artifact);
      const document = type({
        components: { schemas: { 'r2_cors-rule': { properties: { id: 'unknown' } } } },
      }).assert(selected.document);
      document.components.schemas['r2_cors-rule'].properties.id = change;
      expect(() => setup(selected)).toThrow();
    }
  });

  it('rejects caller scope and paging input before any request', async () => {
    const { fetcher, read } = setup();
    for (const input of [
      { account_id: 'other' },
      { path: { bucket_name: 'other' } },
      { headers: { 'cf-r2-jurisdiction': 'default' } },
      { query: { cursor: 'not-a-paged-operation', limit: 10 } },
    ]) {
      await expect(read(input)).rejects.toThrow('input fields');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('checks current ownership before fetching and before returning structured data', async () => {
    const { caller, fetcher, read } = setup();
    caller.stillAuthorized.mockResolvedValueOnce(false);
    await expect(read()).rejects.toThrow('resource changed');
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockImplementationOnce(async () => {
      caller.stillAuthorized.mockResolvedValue(false);
      return envelope({ rules: [rule] });
    });
    await expect(read()).rejects.toThrow('resource changed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
