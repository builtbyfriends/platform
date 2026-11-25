import type { Manifest } from '@builtbyfriends/realtime';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createPlatformDiscoveryCatalog } from '../../src/infrastructure/platform-discovery.ts';

describe('Platform discovery metadata', () => {
  it('reuses registered route schemas without granting execution or calling procedures', () => {
    const manifest: Manifest = {
      version: 1,
      procedures: [
        {
          name: 'projects.resources',
          path: '/rpc/projects/resources',
          input: {
            type: 'object',
            properties: { projectId: { type: 'string' } },
            required: ['projectId'],
          },
          output: { type: 'array', items: { type: 'object' } },
          errors: { FORBIDDEN: { status: 403, message: 'Access denied' } },
          cli: { command: 'project resources', description: 'List project resources' },
        },
      ],
    };

    const registry = { manifest: vi.fn(() => manifest), call: vi.fn() };
    const catalog = createPlatformDiscoveryCatalog(registry);
    expect(registry.manifest).toHaveBeenCalledExactlyOnceWith('/rpc');
    expect(registry.call).not.toHaveBeenCalled();
    expect(catalog.source).toEqual({
      kind: 'platform-rpc',
      manifestVersion: 1,
      manifestPath: '/rpc/manifest.json',
      openapiPath: '/rpc/openapi.json',
    });
    expect(catalog.operations).toEqual([
      { ...manifest.procedures[0], execution: 'discovery-only' },
    ]);
    expect(manifest.procedures[0]).not.toHaveProperty('execution');
  });

  it('does not invent routes when no procedures opted into the manifest', () => {
    expect(
      createPlatformDiscoveryCatalog({ manifest: () => ({ version: 1, procedures: [] }) })
        .operations,
    ).toEqual([]);
  });
});
