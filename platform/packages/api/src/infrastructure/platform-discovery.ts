import type { ManifestEntry, Registry } from '@builtbyfriends/realtime';

export type PlatformDiscoveryOperation = ManifestEntry & {
  execution: 'discovery-only';
};

export type PlatformDiscoveryCatalog = {
  source: {
    kind: 'platform-rpc';
    manifestVersion: 1;
    manifestPath: '/rpc/manifest.json';
    openapiPath: '/rpc/openapi.json';
  };
  operations: Array<PlatformDiscoveryOperation>;
};

export function createPlatformDiscoveryCatalog(
  registry: Pick<Registry, 'manifest'>,
): PlatformDiscoveryCatalog {
  const manifest = registry.manifest('/rpc');

  return {
    source: {
      kind: 'platform-rpc',
      manifestVersion: manifest.version,
      manifestPath: '/rpc/manifest.json',
      openapiPath: '/rpc/openapi.json',
    },
    operations: manifest.procedures.map((entry) => ({
      ...entry,
      execution: 'discovery-only',
    })),
  };
}
