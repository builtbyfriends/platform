import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Validator } from '@cfworker/json-schema';
import { type } from 'arktype';
import { describe, expect, it, vi } from 'vite-plus/test';
import { prepareCloudflareProviderWrite } from '../../src/infrastructure/cloudflare-provider-write.ts';
import type { Resource } from '../../src/types.ts';

function artifact(method: 'get' | 'put') {
  return {
    operationId: `r2-${method}-bucket-cors-policy`,
    method: method.toUpperCase(),
    path: '/accounts/{account_id}/r2/buckets/{bucket_name}/cors',
    document: JSON.parse(
      gunzipSync(
        readFileSync(
          new URL(`../fixtures/cloudflare-openapi/r2-cors-${method}.json.gz`, import.meta.url),
        ),
      ).toString(),
    ) as unknown,
  };
}
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
const body = {
  rules: [
    {
      id: 'Browser',
      allowed: { methods: ['GET'], origins: ['https://example.test'] },
      maxAgeSeconds: 0,
    },
  ],
};
const expected = { rules: [] };
function envelope(result: unknown) {
  return Response.json({ success: true, errors: [], messages: [], result });
}
function setup() {
  const prepared = prepareCloudflareProviderWrite(artifact('put'), artifact('get'), 'r2');
  if (!prepared) {
    throw Error('Missing write operation');
  }
  const caller = {
    resource: structuredClone(resource),
    project: { id: 'app' },
    stillAuthorized: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(envelope(expected))
    .mockResolvedValueOnce(envelope({}))
    .mockResolvedValueOnce(envelope(body));
  const write = (input: unknown = { body, expected }) =>
    prepared.write(bindings, caller, input, fetcher);
  return { prepared, caller, fetcher, write };
}

describe('reviewed provider configuration writes', () => {
  it('uses pinned nested input, owned scope and fresh readback', async () => {
    const { prepared, caller, fetcher, write } = setup();
    const output = await write();
    expect(output).toEqual({
      appId: 'app',
      resourceId: 'resource',
      action: 'r2-put-bucket-cors-policy',
      kind: 'provider-write',
      data: { name: 'Uploads', ...body },
    });
    expect(new Validator(prepared.outputSchema, '7').validate(output).valid).toBe(true);
    expect((await prepared.describe()).effect).toBe('write');
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(String(fetcher.mock.calls[1][0])).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${bindings.CF_ACCOUNT_ID}/r2/buckets/owned-bucket/cors`,
    );
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('cf-r2-jurisdiction')).toBe('eu');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(body);
    expect(caller.stillAuthorized).toHaveBeenCalledTimes(5);
  });

  it.each([
    { body },
    { body, expected, account_id: 'foreign' },
    { body: { ...body, secret: 'private' }, expected },
    { body: { rules: [{ allowed: { methods: ['OTHER'], origins: [] } }] }, expected },
    { body: {}, expected },
    { body, expected: { ...expected, name: 'Not a configuration field' } },
    { body: { rules: Array(201).fill(body.rules[0]) }, expected },
    { body: { rules: [{ ...body.rules[0], id: 'x'.repeat(16385) }] }, expected },
    {
      body: {
        rules: Array(200).fill({
          ...body.rules[0],
          allowed: { ...body.rules[0].allowed, headers: Array(20).fill('x') },
        }),
      },
      expected,
    },
    { body: { rules: Array(10).fill({ ...body.rules[0], id: 'x'.repeat(14000) }) }, expected },
  ])('rejects unsafe or unbounded configuration without any provider call (%#)', async (input) => {
    const { write, fetcher } = setup();
    expect(await write(input)).toMatchObject({ kind: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves omitted versus empty configuration when comparing an opened snapshot', async () => {
    const { fetcher, write } = setup();
    fetcher.mockReset().mockResolvedValueOnce(envelope({}));
    expect(await write()).toMatchObject({ kind: 'conflict' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher
      .mockReset()
      .mockResolvedValueOnce(envelope({}))
      .mockResolvedValueOnce(envelope({}))
      .mockResolvedValueOnce(envelope(body));
    expect(await write({ body, expected: {} })).toMatchObject({ kind: 'provider-write' });
  });

  it('compares objects independently of property order and retains array order', async () => {
    const { fetcher, write } = setup();
    fetcher
      .mockReset()
      .mockResolvedValueOnce(
        envelope({
          rules: [
            {
              maxAgeSeconds: 0,
              allowed: { origins: ['https://example.test'], methods: ['GET'] },
              id: 'Browser',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(envelope({}))
      .mockResolvedValueOnce(envelope({ rules: [] }));
    expect(await write({ body: { rules: [] }, expected: body })).toMatchObject({
      kind: 'provider-write',
    });
  });

  it('stops before sending when ownership changes during the preflight', async () => {
    const { caller, write, fetcher } = setup();
    caller.stillAuthorized.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await write()).toMatchObject({ kind: 'unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses to replace configuration containing fields omitted by the approved projection', async () => {
    const { write, fetcher } = setup();
    fetcher
      .mockReset()
      .mockResolvedValueOnce(envelope({ ...expected, futureSetting: 'not reviewed' }));
    expect(await write()).toMatchObject({ kind: 'unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the verification read adds unreviewed fields after submission', async () => {
    const { write, fetcher } = setup();
    fetcher
      .mockReset()
      .mockResolvedValueOnce(envelope(expected))
      .mockResolvedValueOnce(envelope({}))
      .mockResolvedValueOnce(envelope({ ...body, futureSetting: 'not reviewed' }));
    expect(await write()).toMatchObject({ kind: 'unknown' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(['resource', 'account', 'kind', 'project'] as const)(
    'rejects invalid scope (%s)',
    async (change) => {
      const { caller, prepared, fetcher } = setup();
      if (change === 'resource') {
        caller.resource.cf_id = '../foreign';
      }
      if (change === 'kind') {
        caller.resource.type = 'kv';
      }
      if (change === 'project') {
        caller.resource.project_id = 'foreign';
      }
      expect(
        await prepared.write(
          { ...bindings, ...(change === 'account' ? { CF_ACCOUNT_ID: 'invalid' } : {}) },
          caller,
          { body, expected },
          fetcher,
        ),
      ).toMatchObject({ kind: 'unavailable' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([400, 403, 429, 408, 500, 302])(
    'distinguishes rejection from uncertain provider failures (%s)',
    async (status) => {
      const { fetcher, write, prepared } = setup();
      fetcher
        .mockReset()
        .mockResolvedValueOnce(envelope(expected))
        .mockResolvedValueOnce(new Response('', { status }));
      const output = await write();
      expect(output).toMatchObject({
        kind: [400, 403, 429].includes(status) ? 'unavailable' : 'unknown',
      });
      expect(new Validator(prepared.outputSchema, '7').validate(output).valid).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(output).not.toHaveProperty('data');
    },
  );

  it.each(['timeout', 'malformed', 'readback', 'changed', 'ownership'] as const)(
    'does not report success or retry after an uncertain change (%s)',
    async (failure) => {
      const { fetcher, write, caller } = setup();
      fetcher.mockReset().mockResolvedValueOnce(envelope(expected));
      if (failure === 'timeout') {
        fetcher.mockRejectedValueOnce(Error('private provider details'));
      } else if (failure === 'malformed') {
        fetcher.mockResolvedValueOnce(
          Response.json({ success: false, errors: [], messages: [], result: {} }),
        );
      } else {
        fetcher.mockResolvedValueOnce(envelope({}));
      }
      if (failure === 'readback') {
        fetcher.mockRejectedValueOnce(Error('read failed'));
      }
      if (failure === 'changed') {
        fetcher.mockResolvedValueOnce(envelope(expected));
      }
      if (failure === 'ownership') {
        caller.stillAuthorized
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(true)
          .mockResolvedValue(false);
      }
      const output = await write();
      expect(output).toMatchObject({ kind: 'unknown' });
      expect(output).not.toHaveProperty('data');
      expect(JSON.stringify(output)).not.toContain('private provider details');
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    },
  );

  it('rejects unapproved methods, paths, resource types and mismatched paired schemas', () => {
    expect(
      prepareCloudflareProviderWrite(
        { ...artifact('put'), method: 'DELETE' },
        artifact('get'),
        'r2',
      ),
    ).toBeNull();
    expect(prepareCloudflareProviderWrite(artifact('put'), artifact('get'), 'kv')).toBeNull();
    expect(
      prepareCloudflareProviderWrite(
        { ...artifact('put'), path: '/accounts/{account_id}/r2/buckets' },
        artifact('get'),
        'r2',
      ),
    ).toBeNull();
    expect(() =>
      prepareCloudflareProviderWrite(
        artifact('put'),
        { ...artifact('get'), operationId: 'other' },
        'r2',
      ),
    ).toThrow();
  });
  it.each(['readOnly', 'writeOnly'] as const)(
    'refuses selected fields that become %s',
    (annotation) => {
      const write = artifact('put');
      const document = type({
        components: {
          schemas: {
            'r2_cors-rule': {
              properties: { id: { 'readOnly?': 'boolean', 'writeOnly?': 'boolean' } },
            },
          },
        },
      }).assert(write.document);
      document.components.schemas['r2_cors-rule'].properties.id[annotation] = true;
      expect(() => prepareCloudflareProviderWrite(write, artifact('get'), 'r2')).toThrow();
    },
  );

  it('rejects a new child path or request header in the pinned mutation schema', () => {
    const write = artifact('put');
    const document = type({
      paths: {
        '/accounts/{account_id}/r2/buckets/{bucket_name}/cors': {
          put: { parameters: 'unknown[]' },
        },
      },
    }).assert(write.document);
    const parameters =
      document.paths['/accounts/{account_id}/r2/buckets/{bucket_name}/cors'].put.parameters;
    parameters.push({ name: 'consumer_id', in: 'path', schema: { type: 'string' } });
    expect(() => prepareCloudflareProviderWrite(write, artifact('get'), 'r2')).toThrow('Unowned');
    parameters.pop();
    parameters.push({ name: 'Authorization', in: 'header', schema: { type: 'string' } });
    expect(() => prepareCloudflareProviderWrite(write, artifact('get'), 'r2')).toThrow('Unowned');
  });
});
