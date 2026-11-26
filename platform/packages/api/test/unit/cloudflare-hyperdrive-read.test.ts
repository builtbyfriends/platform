import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vite-plus/test';
import { prepareCloudflareProviderRead } from '../../src/infrastructure/cloudflare-provider-read.ts';
import type { Resource } from '../../src/types.ts';

const artifact = {
  method: 'GET',
  path: '/accounts/{account_id}/hyperdrive/configs/{hyperdrive_id}',
  operationId: 'get-hyperdrive',
  document: JSON.parse(
    gunzipSync(
      readFileSync(
        new URL('../fixtures/cloudflare-openapi/hyperdrive-get.json.gz', import.meta.url),
      ),
    ).toString(),
  ),
};
const resource: Resource = {
  id: 'owned-resource',
  project_id: 'app',
  type: 'hyperdrive',
  cf_id: 'b'.repeat(32),
  binding_name: 'Database connection',
  metadata: {},
  created_at: '2026-11-25T00:00:00Z',
};
const origin = {
  host: 'private-db.example.com',
  port: 5432,
  scheme: 'postgres',
  user: 'private-user',
  database: 'private-database',
};
const result = {
  id: resource.cf_id,
  name: 'private-provider-name',
  origin,
  caching: { disabled: false, max_age: 120, stale_while_revalidate: 30 },
  mtls: { sslmode: 'verify-full', ca_certificate_id: 'private-certificate' },
  origin_connection_limit: 20,
  restarted_on: null,
};
function setup() {
  const prepared = prepareCloudflareProviderRead(artifact, 'hyperdrive');
  if (!prepared) {
    throw Error('Expected Hyperdrive descriptor');
  }
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ success: true, errors: [], messages: [], result }));
  const caller = {
    project: { id: 'app' },
    resource: structuredClone(resource),
    stillAuthorized: vi.fn().mockResolvedValue(true),
  };
  return {
    prepared,
    fetcher,
    caller,
    read: () =>
      prepared.read(
        { CF_ACCOUNT_ID: 'a'.repeat(32), CF_API_TOKEN: 'secret-token' },
        caller,
        {},
        fetcher,
      ),
  };
}

describe('owned Hyperdrive schema reads', () => {
  it('uses the real schema, preserves operational settings and excludes connection details', async () => {
    const { read, prepared } = setup();
    expect((await prepared.describe()).effect).toBe('read');
    expect((await read()).data).toEqual({
      name: 'Database connection',
      caching_disabled: false,
      caching_max_age: 120,
      caching_stale_while_revalidate: 30,
      mtls_sslmode: 'verify-full',
      origin_connection_limit: 20,
      restarted_on: null,
    });
  });

  it('rejects write-only credentials defined through allOf, without requiring them in a GET response', async () => {
    const { read, fetcher } = setup();
    await expect(read()).resolves.toMatchObject({ kind: 'provider-read' });
    for (const returnedOrigin of [
      { ...origin, password: 'private-password' },
      {
        host: origin.host,
        scheme: origin.scheme,
        user: origin.user,
        database: origin.database,
        access_client_id: 'private-client-id',
        access_client_secret: 'private-access-secret',
      },
    ]) {
      fetcher.mockResolvedValueOnce(
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: { ...result, origin: returnedOrigin },
        }),
      );
      await expect(read()).rejects.toThrow('unexpected resource response');
    }
  });

  it('redacts unrecognized sensitive fields even when the schema permits additional properties', async () => {
    const { read, fetcher } = setup();
    fetcher.mockResolvedValueOnce(
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: {
          ...result,
          origin: { ...origin, access_client_secret: 'private-secret' },
          token: 'private-token',
        },
      }),
    );
    expect(JSON.stringify(await read())).not.toContain('private-');
  });

  it('discards reads when ownership changes and rejects a different provider resource', async () => {
    const { read, fetcher, caller } = setup();
    caller.stillAuthorized.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(read()).rejects.toThrow('resource changed');
    fetcher.mockResolvedValueOnce(
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { ...result, id: 'c'.repeat(32) },
      }),
    );
    await expect(read()).rejects.toThrow('different resource');
  });
});
