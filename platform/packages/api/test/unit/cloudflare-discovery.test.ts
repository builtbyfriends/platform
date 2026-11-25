import { describe, expect, it } from 'vite-plus/test';
import { loadCloudflareDiscoveryCatalog } from '../../src/infrastructure/cloudflare-discovery.ts';

const get = {
  operationId: 'hyperdrive.get',
  httpMethod: 'GET',
  path: '/accounts/{account_id}/hyperdrive/configs/{hyperdrive_id}',
  pathParams: [
    { name: 'account_id', type: 'string', required: true },
    {
      name: 'hyperdrive_id',
      flag: 'hyperdrive-id',
      positional: true,
      type: 'string',
      required: true,
    },
  ],
  queryParams: [],
  hasRequestBody: false,
  requestBodyFields: [],
};

const query = {
  operationId: 'd1.query',
  httpMethod: 'POST',
  path: '/accounts/{account_id}/d1/database/{database_id}/query',
  pathParams: [
    { name: 'account_id', type: 'string', required: true },
    { name: 'database_id', type: 'string', required: true },
  ],
  queryParams: [],
  hasRequestBody: true,
  requestBodyFields: [
    { name: 'sql', type: 'string', required: false, description: 'Your SQL query.' },
    { name: 'batch', type: 'string', required: false },
  ],
};

const metadata = () => ({
  version: '1.0',
  generatedAt: '2026-11-23T00:00:00.000Z',
  schemas: { 'hyperdrive get': get, 'd1 query': query },
});

const load = (value = metadata()) =>
  loadCloudflareDiscoveryCatalog(JSON.stringify(value), '1.0.0-rc.2');

describe('Cloudflare discovery metadata', () => {
  it('keeps CLI summaries distinct from executable tenant operations and full schemas', async () => {
    const catalog = await load();
    expect(catalog.source).toEqual({
      kind: 'cloudflare-cli',
      cliVersion: '1.0.0-rc.2',
      schemaVersion: '1.0',
      generatedAt: '2026-11-23T00:00:00.000Z',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(catalog.operations.map((entry) => entry.id)).toEqual(['d1.query', 'hyperdrive.get']);
    expect(catalog.operations).toEqual([
      {
        ...query,
        operationId: undefined,
        id: 'd1.query',
        command: 'cf d1 query',
        inputCompleteness: 'summary',
        execution: 'discovery-only',
      },
      {
        ...get,
        operationId: undefined,
        id: 'hyperdrive.get',
        command: 'cf hyperdrive get',
        inputCompleteness: 'summary',
        execution: 'discovery-only',
      },
    ]);
    expect(catalog.operations[0]?.requestBodyFields[1]?.type).toBe('string');
    expect(catalog.operations[1]).not.toHaveProperty('effect');
  });

  it('fingerprints the source snapshot and strips unrecognized execution payloads', async () => {
    const original = await load();

    const injected = {
      ...metadata(),
      schemas: {
        ...metadata().schemas,
        'hyperdrive get': { ...get, execution: 'allowed', credentials: 'private' },
      },
    };

    const changed = await load(injected);
    expect(changed.source.sha256).not.toBe(original.source.sha256);
    expect(changed.operations).toEqual(original.operations);
    expect(JSON.stringify(changed)).not.toContain('private');
  });

  it('preserves the build-time marker used by the real CLI snapshot', async () => {
    const catalog = await load({ ...metadata(), generatedAt: 'build-time' });
    expect(catalog.source.generatedAt).toBe('build-time');
  });

  it.each(['latest', '^1.0.0', '1.0.0; curl example.com'])(
    'rejects unpinned CLI version %s',
    async (version) => {
      await expect(
        loadCloudflareDiscoveryCatalog(JSON.stringify(metadata()), version),
      ).rejects.toThrow('Pin an exact');
    },
  );

  it('rejects duplicate operation IDs', async () => {
    await expect(
      load({
        ...metadata(),
        schemas: { 'hyperdrive get': get, 'd1 query': { ...query, operationId: get.operationId } },
      }),
    ).rejects.toThrow('Duplicate');
  });

  it.each(['hyperdrive get --token=secret', 'hyperdrive get; curl', '../get'])(
    'rejects non-command metadata %s',
    async (command) => {
      await expect(
        loadCloudflareDiscoveryCatalog(
          JSON.stringify({ ...metadata(), schemas: { [command]: get } }),
          '1.0.0-rc.2',
        ),
      ).rejects.toThrow('Invalid Cloudflare discovery command');
    },
  );

  it.each(['https://example.com/', '//example.com/', '/accounts?token=secret', '/accounts\n'])(
    'rejects non-template API path %s',
    async (path) => {
      await expect(
        load({
          ...metadata(),
          schemas: { ...metadata().schemas, 'hyperdrive get': { ...get, path } },
        }),
      ).rejects.toThrow('Invalid Cloudflare discovery metadata');
    },
  );

  it('rejects incomplete documents, changed schema versions and malformed fields', async () => {
    for (const value of [
      {},
      { ...metadata(), version: '2.0' },
      { ...metadata(), generatedAt: 'not a date' },
      {
        ...metadata(),
        schemas: {
          'hyperdrive get': {
            ...get,
            pathParams: [{ name: 'account_id', type: 'function', required: true }],
          },
        },
      },
    ]) {
      await expect(
        loadCloudflareDiscoveryCatalog(JSON.stringify(value), '1.0.0-rc.2'),
      ).rejects.toThrow('Invalid Cloudflare discovery metadata');
    }
  });

  it('bounds input bytes and operation count', async () => {
    await expect(
      loadCloudflareDiscoveryCatalog('x'.repeat(8 * 1024 * 1024 + 1), '1.0.0-rc.2'),
    ).rejects.toThrow('size limit');
    await expect(
      loadCloudflareDiscoveryCatalog(JSON.stringify({ ...metadata(), schemas: {} }), '1.0.0-rc.2'),
    ).rejects.toThrow('operation limit');
  });
});
