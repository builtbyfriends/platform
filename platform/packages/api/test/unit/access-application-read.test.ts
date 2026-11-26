import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vite-plus/test';
import { prepareAccessApplicationRead } from '../../src/infrastructure/access-application-read.ts';

const document = JSON.parse(
  gunzipSync(
    readFileSync(new URL('../fixtures/cloudflare-openapi/access-get.json.gz', import.meta.url)),
  ).toString(),
);
const artifact = {
  operationId: 'access-applications-get-an-access-application',
  method: 'GET',
  path: '/accounts/{account_id}/access/apps/{app_id}',
  document,
};
const accountId = 'a'.repeat(32),
  applicationId = '11111111-1111-4111-8111-111111111111';
function setup() {
  const caller = {
    project: { id: 'project', user_id: 'owner' },
    reference: {
      source: 'project-access' as const,
      id: 'ref_opaque',
      projectId: 'project',
      name: 'Project access',
      kind: 'protected' as const,
      locator: { accountId, applicationId },
      proof: {
        installation: 'installation',
        configurationRevision: 1,
        operation: 'generation',
        updatedAt: '2026-11-26T00:00:00Z',
        applicationName: 'private-application-name',
      },
    },
    stillAuthorized: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
  const bindings = { CF_ACCOUNT_ID: accountId, CF_API_TOKEN: 'private-token' };
  const data = {
    id: applicationId,
    name: 'private-application-name',
    type: 'self_hosted',
    domain: 'private.example.com',
    session_duration: '24h',
    created_at: '2026-11-25T00:00:00Z',
    updated_at: '2026-11-26T00:00:00Z',
    aud: 'private-audience',
    allowed_idps: ['private-idp'],
    api_token: 'private-response-token',
    policies: [{ id: 'private-policy', name: 'private-policy-name' }],
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      Response.json({ success: true, errors: [], messages: [], result: data }),
    );
  const prepared = prepareAccessApplicationRead(structuredClone(artifact));
  return {
    caller,
    bindings,
    data,
    fetcher,
    prepared,
    read: (input: unknown = {}) => prepared.read(bindings, caller, input, fetcher),
  };
}

describe('project-owned Access application read', () => {
  it('injects the account and application and returns only safe projected fields with opaque local identity', async () => {
    const fixture = setup();
    const output = await fixture.read();
    expect(fixture.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fixture.fetcher.mock.calls[0];
    expect(String(url)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps/${applicationId}`,
    );
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer private-token' },
    });
    expect(output).toEqual({
      appId: 'project',
      resourceId: 'ref_opaque',
      action: artifact.operationId,
      kind: 'provider-read',
      data: {
        name: 'Project access',
        type: 'self_hosted',
        session_duration: '24h',
        created_at: fixture.data.created_at,
        updated_at: fixture.data.updated_at,
      },
    });
    expect(JSON.stringify(output)).not.toMatch(
      /private-|11111111|example\.com|policies|allowed_idps|api_token|aud/,
    );
    expect(fixture.caller.stillAuthorized).toHaveBeenCalledTimes(2);
  });

  it.each([
    { account_id: 'foreign' },
    { app_id: 'foreign' },
    { query: {} },
    { path: {} },
    { url: 'https://foreign.test' },
  ])('rejects caller locator or query input before a provider request: %j', async (input) => {
    const fixture = setup();
    await expect(fixture.read(input)).rejects.toThrow('input');
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });

  it.each(['account', 'project', 'revoked', 'invalid-id'] as const)(
    'withholds requests for %s identity or authorization changes',
    async (change) => {
      const fixture = setup();
      if (change === 'account') {
        fixture.caller.reference.locator.accountId = 'b'.repeat(32);
      }
      if (change === 'project') {
        fixture.caller.reference.projectId = 'foreign';
      }
      if (change === 'revoked') {
        fixture.caller.stillAuthorized.mockResolvedValue(false);
      }
      if (change === 'invalid-id') {
        fixture.caller.reference.locator.applicationId = '../foreign';
      }
      await expect(fixture.read()).rejects.toThrow();
      expect(fixture.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(['application', 'name', 'generation', 'revoked', 'account'] as const)(
    'does not publish a response after a late %s change',
    async (change) => {
      const fixture = setup();
      fixture.fetcher.mockImplementation(async () => {
        if (change === 'application') {
          fixture.data.id = '22222222-2222-4222-8222-222222222222';
        }
        if (change === 'name') {
          fixture.data.name = 'replacement-name';
        }
        if (change === 'generation' || change === 'revoked' || change === 'account') {
          fixture.caller.stillAuthorized.mockResolvedValue(false);
        }
        return Response.json({ success: true, errors: [], messages: [], result: fixture.data });
      });
      await expect(fixture.read()).rejects.toThrow();
    },
  );

  it('pins the projection to the exact provider document and fails closed when the schema changes', async () => {
    const first = await setup().prepared.describe();
    expect(await setup().prepared.describe()).toEqual(first);
    expect(first.version).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      prepareAccessApplicationRead({ ...artifact, path: '/accounts/{account_id}/access/apps' }),
    ).toThrow();
    const changed = structuredClone(artifact);
    changed.document.paths[artifact.path].get.parameters.push({
      name: 'include_secrets',
      in: 'query',
      schema: { type: 'boolean' },
    });
    expect(() => prepareAccessApplicationRead(changed)).toThrow('parameters');
  });
});
