import { readFileSync } from 'node:fs';
import { type } from 'arktype';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  cloudflareProviderReadSelection,
  prepareCloudflareProviderRead,
} from '../../src/infrastructure/cloudflare-provider-read.ts';
import type { Resource } from '../../src/types.ts';

const fixture = type({
  operations: {
    '[string]': { operationId: 'string', method: 'string', path: 'string', document: 'unknown' },
  },
}).assert(
  JSON.parse(
    readFileSync(new URL('../fixtures/cloudflare-provider-reads.json', import.meta.url), 'utf8'),
  ),
);
const bindings = { CF_ACCOUNT_ID: 'a'.repeat(32), CF_API_TOKEN: 'private-test-token' };
const ids = {
  d1: '11111111-1111-4111-8111-111111111111',
  r2: 'owned-bucket',
  kv: '1'.repeat(32),
  queue: '2'.repeat(32),
};
type Kind = keyof typeof ids;
type Prepared = NonNullable<ReturnType<typeof prepareCloudflareProviderRead>>;

function setup(kind: Kind) {
  const artifact = structuredClone(fixture.operations[kind]);
  const resource: Resource = {
    id: 'resource',
    project_id: 'app',
    type: kind,
    cf_id: ids[kind],
    binding_name: 'My resource',
    metadata: {},
    created_at: '2026-11-25T00:00:00Z',
  };
  const caller = {
    resource,
    project: { id: 'app' },
    stillAuthorized: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
  const fetcher = vi.fn<typeof fetch>();
  const prepare = () => {
    const result = prepareCloudflareProviderRead(artifact, kind);
    if (!result) {
      throw Error('Missing supported fixture');
    }
    return result;
  };
  const data =
    kind === 'd1'
      ? {
          uuid: ids.d1,
          name: 'private-database-name',
          num_tables: 3,
          jurisdiction: null,
          read_replication: { mode: 'auto' },
        }
      : kind === 'r2'
        ? { name: ids.r2, storage_class: 'Standard', location: 'weur' }
        : kind === 'kv'
          ? { id: ids.kv, title: 'private-namespace-title', supports_url_encoding: true }
          : {
              queue_id: ids.queue,
              queue_name: 'private-queue-name',
              consumers_total_count: 2,
              settings: {
                delivery_paused: false,
                message_retention_period: 600,
                authorization_token: 'private-nested-token',
              },
            };
  fetcher.mockImplementation(async () =>
    Response.json({
      success: true,
      errors: [],
      messages: [],
      result: { ...data, api_token: 'private-provider-token' },
    }),
  );
  const read = (prepared: Prepared = prepare(), input: unknown = {}) =>
    prepared.read(bindings, caller, input, fetcher);
  return { artifact, caller, fetcher, prepare, read, data };
}

describe('schema-driven Cloudflare resource reads', () => {
  it('normalizes OpenAPI write-only requirements and exclusive numeric bounds', async () => {
    const { artifact, read, fetcher, data } = setup('r2');
    const document = type({
      components: {
        schemas: { r2_bucket: { properties: { '[string]': 'unknown' }, 'required?': 'string[]' } },
      },
    }).assert(artifact.document);
    document.components.schemas.r2_bucket.properties.secret = { type: 'string', writeOnly: true };
    document.components.schemas.r2_bucket.properties.count = {
      type: 'number',
      minimum: 0,
      exclusiveMinimum: true,
    };
    document.components.schemas.r2_bucket.required = ['secret'];
    await expect(read()).resolves.toMatchObject({ data: { name: 'My resource' } });
    for (const extra of [{ secret: 'private-secret' }, { count: 0 }]) {
      fetcher.mockResolvedValueOnce(
        Response.json({ success: true, errors: [], messages: [], result: { ...data, ...extra } }),
      );
      await expect(read()).rejects.toThrow('unexpected resource response');
    }
    fetcher.mockResolvedValueOnce(
      Response.json({ success: true, errors: [], messages: [], result: { ...data, count: 1 } }),
    );
    await expect(read()).resolves.toMatchObject({ data: { name: 'My resource' } });
  });

  it('describes the safe surface with a stable version tied to the provider schema', async () => {
    const { prepare, artifact } = setup('d1');
    const original = JSON.stringify(artifact);
    const first = await prepare().describe();
    const second = await prepare().describe();
    expect(first).toEqual(second);
    expect(first.version).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toMatchObject({
      id: artifact.operationId,
      effect: 'read',
      outputSchema: {
        properties: {
          data: { additionalProperties: false, properties: { num_tables: { type: 'number' } } },
        },
      },
    });
    expect(JSON.stringify(artifact)).toBe(original);
    const document = type({ info: { description: 'string' } }).assert(artifact.document);
    document.info.description += ' Revised provider description.';
    expect((await prepare().describe()).version).not.toBe(first.version);
  });

  it('rejects missing credentials and mismatched schema metadata before fetching', async () => {
    const { prepare, artifact, caller, fetcher } = setup('r2');
    await expect(
      prepare().read({ ...bindings, CF_API_TOKEN: '' }, caller, {}, fetcher),
    ).rejects.toThrow('not connected');
    await expect(
      prepare().read({ ...bindings, CF_ACCOUNT_ID: '../other' }, caller, {}, fetcher),
    ).rejects.toThrow('not connected');
    expect(() =>
      prepareCloudflareProviderRead({ ...artifact, operationId: 'other' }, 'r2'),
    ).toThrow('does not match');
    caller.resource.metadata.jurisdiction = 'other';
    await expect(prepare().read(bindings, caller, {}, fetcher)).rejects.toThrow(
      'identity is invalid',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['d1', 'r2', 'kv', 'queue'] as const)(
    'uses the same executor and real provider schema for %s metadata',
    async (kind) => {
      expect(cloudflareProviderReadSelection(kind)).toEqual({
        method: 'GET',
        path: fixture.operations[kind].path,
      });
      const { read, fetcher, caller } = setup(kind);
      const output = await read();
      expect(output).toMatchObject({
        appId: 'app',
        resourceId: 'resource',
        kind: 'provider-read',
        data: { name: 'My resource' },
      });
      expect(JSON.stringify(output)).not.toContain('private-');
      expect(JSON.stringify(output)).not.toContain(ids[kind]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, options] = fetcher.mock.calls[0];
      expect(String(url)).toBe(
        'https://api.cloudflare.com/client/v4' +
          fixture.operations[kind].path
            .replace('{account_id}', bindings.CF_ACCOUNT_ID)
            .replace(/\{[^}]+\}/, ids[kind]),
      );
      expect(options).toMatchObject({ method: 'GET', redirect: 'error' });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer private-test-token');
      expect(caller.stillAuthorized).toHaveBeenCalledTimes(2);
    },
  );

  it('retains useful typed metadata while excluding unapproved provider fields', async () => {
    expect((await setup('d1').read()).data).toEqual({
      name: 'My resource',
      num_tables: 3,
      jurisdiction: null,
      read_replication_mode: 'auto',
    });
    expect((await setup('queue').read()).data).toEqual({
      name: 'My resource',
      consumers_total_count: 2,
      settings_delivery_paused: false,
      settings_message_retention_period: 600,
    });
  });

  it('validates query values and serializes arrays using the provider style while keeping identity checks', async () => {
    const { read, fetcher } = setup('d1');
    await read(undefined, { query: { fields: ['name', 'num_tables'] } });
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('fields')).toBe(
      'name,num_tables,uuid',
    );
    fetcher.mockClear();
    await expect(read(undefined, { query: { fields: ['password'] } })).rejects.toThrow(
      'input fields',
    );
    await expect(read(undefined, { query: { fields: 'name' } })).rejects.toThrow('input fields');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('binds R2 jurisdiction to the owned resource rather than caller headers', async () => {
    const { read, fetcher, caller } = setup('r2');
    caller.resource.metadata = { jurisdiction: 'eu' };
    await read();
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('cf-r2-jurisdiction')).toBe('eu');
    fetcher.mockClear();
    await expect(read(undefined, { headers: { 'cf-r2-jurisdiction': 'default' } })).rejects.toThrow(
      'input fields',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects mismatched scopes, account selection, arbitrary paths and writes without requests', async () => {
    const { artifact, caller, prepare, fetcher, read } = setup('r2');
    expect(cloudflareProviderReadSelection('container')).toBeNull();
    expect(prepareCloudflareProviderRead(artifact, 'd1')).toBeNull();
    expect(prepareCloudflareProviderRead({ ...artifact, method: 'DELETE' }, 'r2')).toBeNull();
    expect(
      prepareCloudflareProviderRead({ ...artifact, path: artifact.path + '/cors' }, 'r2'),
    ).toBeNull();
    expect(
      prepareCloudflareProviderRead({ ...artifact, path: 'https://foreign.test/' }, 'r2'),
    ).toBeNull();
    for (const input of [
      { account_id: 'other' },
      { path: { bucket_name: 'other' } },
      { query: { url: 'https://foreign.test' } },
    ]) {
      await expect(read(undefined, input)).rejects.toThrow('input fields');
    }
    const prepared = prepare();
    caller.resource.project_id = 'other';
    await expect(read(prepared)).rejects.toThrow('not connected');
    caller.resource.project_id = 'app';
    caller.resource.cf_id = '../other';
    await expect(read(prepared)).rejects.toThrow('not connected');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects responses with a different identity, invalid schema or failed provider envelope', async () => {
    const { read, fetcher, data } = setup('kv');
    for (const result of [
      { ...data, id: '3'.repeat(32) },
      { ...data, supports_url_encoding: 'yes' },
      { ...data, title: 12 },
    ]) {
      fetcher.mockResolvedValueOnce(
        Response.json({ success: true, errors: [], messages: [], result }),
      );
      await expect(read()).rejects.toThrow(/different resource|unexpected resource response/);
    }
    fetcher.mockResolvedValueOnce(
      Response.json({
        success: false,
        errors: [{ code: 42, message: 'private-provider-token' }],
        result: data,
      }),
    );
    await expect(read()).rejects.toThrow(/different resource|unexpected resource response/);
  });

  it('rechecks authorization before the request and after reading its body', async () => {
    const { read, fetcher, caller } = setup('r2');
    caller.stillAuthorized.mockResolvedValueOnce(false);
    await expect(read()).rejects.toThrow('resource changed');
    expect(fetcher).not.toHaveBeenCalled();
    caller.stillAuthorized.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(read()).rejects.toThrow('resource changed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds response bodies and does not retry redirects, transport failures or provider errors', async () => {
    const { read, fetcher } = setup('r2');
    const cancel = vi.fn();
    fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(256 * 1024 + 1));
          },
          cancel,
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(read()).rejects.toThrow('too large');
    expect(cancel).toHaveBeenCalled();
    for (const status of [302, 401, 429, 500]) {
      fetcher.mockClear();
      fetcher.mockResolvedValueOnce(new Response('private-provider-token', { status }));
      await expect(read()).rejects.toThrow('could not return');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    fetcher.mockClear();
    fetcher.mockRejectedValueOnce(Error('Connection failed'));
    await expect(read()).rejects.toThrow('could not return');
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(
      new Response('private-provider-token', { headers: { 'content-type': 'application/json' } }),
    );
    await expect(read()).rejects.toThrow('invalid JSON');
  });
});
