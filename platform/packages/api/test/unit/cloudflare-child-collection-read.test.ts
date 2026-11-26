import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Validator } from '@cfworker/json-schema';
import { describe, expect, it, vi } from 'vite-plus/test';
import { prepareCloudflareProviderRead } from '../../src/infrastructure/cloudflare-provider-read.ts';
import type { Resource } from '../../src/types.ts';

const specifications = [
  {
    type: 'queue',
    file: 'queue-consumers-get',
    id: 'queues-list-consumers',
    path: '/accounts/{account_id}/queues/{queue_id}/consumers',
    sha: 'c6b5cf6b6d6c1e31f899ac08a9b618d7d2cae9a1c9b83dac7ffa8c9cb1844744',
    bytes: 8736,
    gzipBytes: 2479,
  },
  {
    type: 'r2',
    file: 'r2-custom-domains-get',
    id: 'r2-list-custom-domains',
    path: '/accounts/{account_id}/r2/buckets/{bucket_name}/domains/custom',
    sha: 'db45883e3b78c2cfd1469fb85db59550b82fb91eb6c4a071a300a2b00d55d105',
    bytes: 7299,
    gzipBytes: 2396,
  },
] as const;
const bindings = { CF_ACCOUNT_ID: 'a'.repeat(32), CF_API_TOKEN: 'private-token' };
const consumer = {
  consumer_id: 'c'.repeat(32),
  type: 'worker',
  created_on: '2026-11-25T00:00:00Z',
  script_name: 'private-worker',
  queue_name: 'private-queue',
  dead_letter_queue: 'private-other-queue',
  settings: { batch_size: 0, max_retries: 3, max_concurrency: 2 },
};
const domain = {
  domain: 'files.example.com',
  enabled: false,
  status: { ownership: 'active', ssl: 'pending' },
  minTLS: '1.2',
  zoneId: 'private-zone',
  zoneName: 'private-zone-name',
  ciphers: ['private-cipher'],
};
function setup(kind: 'r2' | 'queue') {
  const spec = specifications.find((item) => item.type === kind)!;
  const compressed = readFileSync(
    new URL(`../fixtures/cloudflare-openapi/${spec.file}.json.gz`, import.meta.url),
  );
  const bytes = gunzipSync(compressed);
  const artifact = {
    method: 'GET',
    path: spec.path,
    operationId: spec.id,
    document: JSON.parse(bytes.toString()),
  };
  const prepared = prepareCloudflareProviderRead(artifact, kind);
  if (!prepared) {
    throw Error('Missing child collection');
  }
  const resource: Resource = {
    id: 'owned',
    project_id: 'app',
    type: kind,
    cf_id: kind === 'queue' ? 'b'.repeat(32) : 'owned-bucket',
    binding_name: 'Resource',
    metadata: kind === 'r2' ? { jurisdiction: 'eu' } : {},
    created_at: '2026-11-25T00:00:00Z',
  };
  const caller = {
    project: { id: 'app' },
    resource,
    stillAuthorized: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
  const response = (rows: unknown = kind === 'queue' ? [consumer] : [domain], extra = {}) =>
    Response.json({
      success: true,
      errors: [],
      messages: [],
      result: kind === 'queue' ? rows : { domains: rows },
      ...extra,
    });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
  const read = (input: unknown = {}) => prepared.read(bindings, caller, input, fetcher);
  return { spec, compressed, bytes, artifact, prepared, caller, response, fetcher, read };
}

describe.each(['queue', 'r2'] as const)('owned complete %s collection', (kind) => {
  it('uses the pinned schema and owned parent, returning only approved fields and explicit complete-list pagination', async () => {
    const { spec, bytes, compressed, prepared, fetcher, caller, read } = setup(kind);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(spec.sha);
    expect(bytes.length).toBe(spec.bytes);
    expect(compressed.length).toBe(spec.gzipBytes);
    const result = await read();
    expect(result.data).toEqual({
      name: 'Resource',
      records:
        kind === 'queue'
          ? [
              {
                consumer_id: consumer.consumer_id,
                type: 'worker',
                created_on: consumer.created_on,
                settings_batch_size: 0,
                settings_max_retries: 3,
                settings_max_concurrency: 2,
              },
            ]
          : [
              {
                domain: domain.domain,
                enabled: false,
                minTLS: '1.2',
                status_ownership: 'active',
                status_ssl: 'pending',
              },
            ],
      pagination: { limit: null, count: 1, nextCursor: null, hasMore: false },
    });
    expect(new Validator(prepared.outputSchema, '7').validate(result).valid).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-');
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe(
      `/client/v4${spec.path.replace('{account_id}', bindings.CF_ACCOUNT_ID).replace(kind === 'queue' ? '{queue_id}' : '{bucket_name}', caller.resource.cf_id)}`,
    );
    expect(url.search).toBe('');
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    if (kind === 'r2') {
      expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('cf-r2-jurisdiction')).toBe('eu');
    }
    expect(caller.stillAuthorized).toHaveBeenCalledTimes(2);
  });

  it('keeps an empty complete list distinct from a failed reading', async () => {
    const { fetcher, response, read } = setup(kind);
    fetcher.mockResolvedValueOnce(response([]));
    expect(await read()).toMatchObject({
      data: { records: [], pagination: { limit: null, count: 0, hasMore: false } },
    });
    fetcher.mockResolvedValueOnce(
      Response.json({ error: 'private-provider-diagnostic' }, { status: 403 }),
    );
    await expect(read()).rejects.toThrow('could not return');
    fetcher.mockRejectedValueOnce(Error('private-token'));
    await expect(read()).rejects.toThrow('could not return');
  });

  it.each([
    { query: { cursor: 'next' } },
    { query: { limit: 10 } },
    { query: { prefix: 'other' } },
    { query: { account_id: 'foreign' } },
    { path: '/foreign' },
    { headers: { 'cf-r2-jurisdiction': 'fedramp' } },
    { consumer_id: 'foreign' },
  ])('rejects scope and pagination overrides %j before access', async (input) => {
    const { fetcher, read } = setup(kind);
    await expect(read(input)).rejects.toThrow('input fields');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rechecks ownership before and after fetching and rejects another project inventory', async () => {
    const { caller, fetcher, read } = setup(kind);
    caller.resource.project_id = 'other';
    await expect(read()).rejects.toThrow('not connected');
    caller.resource.project_id = 'app';
    caller.stillAuthorized.mockResolvedValueOnce(false);
    await expect(read()).rejects.toThrow('resource changed');
    expect(fetcher).not.toHaveBeenCalled();
    caller.stillAuthorized.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(read()).rejects.toThrow('resource changed');
  });

  it('rejects missing identities, duplicate records, excessive collections and changed pagination', async () => {
    const { fetcher, response, read } = setup(kind);
    const row = kind === 'queue' ? consumer : domain;
    const identity = kind === 'queue' ? 'consumer_id' : 'domain';
    for (const rows of [
      [{ ...row, [identity]: '' }],
      [row, row],
      Array.from({ length: 201 }, (_, i) => ({
        ...row,
        [identity]: kind === 'queue' ? i.toString(16).padStart(32, '0') : `${i}.example.com`,
      })),
    ]) {
      fetcher.mockResolvedValueOnce(response(rows));
      await expect(read()).rejects.toThrow();
    }
    fetcher.mockResolvedValueOnce(response([row], { result_info: { cursor: 'unexpected-next' } }));
    await expect(read()).rejects.toThrow('unexpected pagination');
    fetcher.mockResolvedValueOnce(response([row], { result_info: {} }));
    await expect(read()).rejects.toThrow('unexpected pagination');
  });

  it('bounds provider bytes and refuses a malformed or missing collection', async () => {
    const { fetcher, response, read } = setup(kind);
    fetcher.mockResolvedValueOnce(response([], { unrelated: 'x'.repeat(256 * 1024) }));
    await expect(read()).rejects.toThrow('too large');
    for (const result of [undefined, null, {}]) {
      fetcher.mockResolvedValueOnce(
        Response.json({ success: true, errors: [], messages: [], result }),
      );
      await expect(read()).rejects.toThrow();
    }
  });

  it('fails closed when the schema adds input paths, queries or private selected fields', () => {
    const { artifact } = setup(kind);
    for (const location of ['path', 'query']) {
      const changed = structuredClone(artifact);
      changed.document.paths[changed.path].get.parameters.push({
        name: 'foreign',
        in: location,
        schema: { type: 'string' },
      });
      expect(() => prepareCloudflareProviderRead(changed, kind)).toThrow();
    }
    const changed = structuredClone(artifact);
    if (kind === 'queue') {
      changed.document.components.schemas['mq_worker-consumer-response'].properties.type.writeOnly =
        true;
    } else {
      changed.document.components.schemas.r2_list_custom_domains_response.properties.domains.items.properties.domain.writeOnly = true;
    }
    expect(() => prepareCloudflareProviderRead(changed, kind)).toThrow('private field');
    expect(prepareCloudflareProviderRead({ ...artifact, method: 'POST' }, kind)).toBeNull();
    expect(() =>
      prepareCloudflareProviderRead({ ...artifact, operationId: 'other' }, kind),
    ).toThrow();
  });
});

it('projects both allowed consumer variants without leaking worker or dead-letter identities', async () => {
  const { fetcher, response, read } = setup('queue');
  fetcher.mockResolvedValueOnce(
    response([
      consumer,
      {
        consumer_id: 'd'.repeat(32),
        type: 'http_pull',
        queue_name: 'private-other',
        settings: { visibility_timeout_ms: 6000, batch_size: 5 },
      },
    ]),
  );
  expect(await read()).toMatchObject({
    data: {
      records: [
        expect.objectContaining({ type: 'worker' }),
        {
          consumer_id: 'd'.repeat(32),
          type: 'http_pull',
          settings_visibility_timeout_ms: 6000,
          settings_batch_size: 5,
        },
      ],
    },
  });
  fetcher.mockResolvedValueOnce(response([{ ...consumer, type: 'unknown' }]));
  await expect(read()).rejects.toThrow('unexpected resource response');
});

it.each([undefined, null, 10])(
  'accepts evidenced Queue diagnostics and documented concurrency %s without changing the artifact',
  async (concurrency) => {
    const { artifact, bytes, prepared, fetcher, response, read } = setup('queue');
    expect(artifact.document).toEqual(JSON.parse(bytes.toString()));
    const before = JSON.stringify(artifact);
    fetcher.mockResolvedValueOnce(
      response([{ ...consumer, settings: { max_concurrency: concurrency } }], {
        errors: null,
        messages: null,
        result_info: { page: 1, per_page: 20, count: 1, total_count: 1, total_pages: 1 },
      }),
    );
    const result = await read();
    expect(result).toMatchObject({ data: { pagination: { hasMore: false, count: 1 } } });
    expect(new Validator(prepared.outputSchema, '7').validate(result).valid).toBe(true);
    expect(JSON.stringify(artifact)).toBe(before);
    const row = (result.data as { records: Array<{ settings_max_concurrency?: number | null }> })
      .records[0];
    expect(row.settings_max_concurrency).toBe(concurrency);
  },
);

it.each([
  { errors: 'bad' },
  { messages: {} },
  { success: false },
  { result_info: { page: 2, per_page: 20, count: 1, total_count: 1, total_pages: 1 } },
  { result_info: { page: 1, per_page: 20, count: 1, total_count: 2, total_pages: 2 } },
  { result_info: { page: 1, per_page: 20, count: 0, total_count: 1, total_pages: 1 } },
  { result_info: { page: 1, per_page: '20', count: 1, total_count: 1, total_pages: 1 } },
  { result_info: { page: 1, per_page: 201, count: 1, total_count: 1, total_pages: 1 } },
  {
    result_info: {
      page: 1,
      per_page: 20,
      count: 1,
      total_count: 1,
      total_pages: 1,
      cursor: 'next',
    },
  },
])('rejects invalid raw Queue envelopes or partial/unknown pagination %j', async (extra) => {
  const { fetcher, response, read } = setup('queue');
  fetcher.mockResolvedValueOnce(response([consumer], extra));
  await expect(read()).rejects.toThrow();
});

it.each(['automatic', {}, []])(
  'rejects invalid concurrency %j instead of filtering the raw response',
  async (value) => {
    const { fetcher, response, read } = setup('queue');
    fetcher.mockResolvedValueOnce(
      response([{ ...consumer, settings: { max_concurrency: value } }]),
    );
    await expect(read()).rejects.toThrow('unexpected resource response');
  },
);

it('fails closed when an audited response correction changes upstream', () => {
  for (const name of ['mq_api-v4-error', 'mq_api-v4-message', 'mq_max-concurrency']) {
    const { artifact } = setup('queue');
    artifact.document.components.schemas[name].type = 'string';
    expect(() => prepareCloudflareProviderRead(artifact, 'queue')).toThrow(
      'correction no longer matches',
    );
  }
});
