import { createPlatformDeploymentManifest } from '@builtbyfriends/platform';
import { expect, it } from 'vite-plus/test';
import {
  PlatformCloudflareClient,
  verifyPlatformRuntimeTokenPermissions,
} from '../../src/cli/platform-cloudflare.ts';
import { cloudflarePermissionForPath } from '../../src/cli/platform-credential-label.ts';
import { resolvePlatformRuntimeTokenToPreflight } from '../../src/cli/platform-management.ts';
import { assertPlatformVectorizeSupported } from '../../src/cli/platform-vectorize.ts';

it('requires an explicit runtime protocol for installations that enable managed Vectorize', () => {
  const deployment = createPlatformDeploymentManifest({
    application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
    displayName: 'Example',
    installationSlug: 'example',
  });
  expect(deployment.capabilities.vectorize).toBe(false);
  expect(() => assertPlatformVectorizeSupported(deployment, {})).not.toThrow();
  const enabled = { ...deployment, capabilities: { ...deployment.capabilities, vectorize: true } };
  expect(() => assertPlatformVectorizeSupported(enabled, {})).toThrow('Vectorize protocol 1');
  expect(() => assertPlatformVectorizeSupported(enabled, { vectorize: 1 })).not.toThrow();
});

it('requires the runtime token before enabling Vectorize on an existing installation', () => {
  const plan = { actions: [{ action: 'update', key: 'api-worker', kind: 'worker' }] };
  expect(() =>
    resolvePlatformRuntimeTokenToPreflight(
      plan,
      { cloudflareApiToken: '', workerSecretUpdates: {} },
      { enablingVectorize: true },
    ),
  ).toThrow('PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN');
  expect(
    resolvePlatformRuntimeTokenToPreflight(
      plan,
      { cloudflareApiToken: 'saved', workerSecretUpdates: {} },
      { enablingVectorize: true },
    ),
  ).toBe('saved');
  expect(
    resolvePlatformRuntimeTokenToPreflight(
      plan,
      { cloudflareApiToken: 'saved', workerSecretUpdates: { CF_API_TOKEN: 'replacement' } },
      { enablingVectorize: true },
    ),
  ).toBe('replacement');
});

it('probes Vectorize read access only when enabled and names a denied permission', async () => {
  const paths: Array<string> = [];
  const client = new PlatformCloudflareClient('synthetic-token', {
    fetcher: async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      return Response.json({ success: true, result: [] });
    },
  });
  const input = { accountId: 'account', applicationDomain: '', customDomains: false, zoneId: null };
  await verifyPlatformRuntimeTokenPermissions(client, input);
  expect(paths).not.toContain('/client/v4/accounts/account/vectorize/v2/indexes');
  await verifyPlatformRuntimeTokenPermissions(client, { ...input, vectorize: true });
  expect(paths.at(-1)).toBe('/client/v4/accounts/account/vectorize/v2/indexes');
  const denied = new PlatformCloudflareClient('synthetic-token', {
    fetcher: async (input) =>
      String(input).includes('/vectorize/')
        ? Response.json({ success: false, errors: [] }, { status: 403 })
        : Response.json({ success: true, result: [] }),
  });
  await expect(
    verifyPlatformRuntimeTokenPermissions(denied, { ...input, vectorize: true }),
  ).rejects.toThrow('Account → Vectorize → Edit');
  expect(cloudflarePermissionForPath('/accounts/account/vectorize/v2/indexes')).toBe(
    'Account → Vectorize → Edit',
  );
});
