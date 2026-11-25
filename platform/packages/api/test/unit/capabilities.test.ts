import { describe, expect, it } from 'vite-plus/test';
import { getPlatformCapabilities } from '../../src/capabilities.ts';

describe('platform capabilities', () => {
  it('enables managed Sandbox when hosted configuration is absent', () => {
    expect(getPlatformCapabilities({})).toEqual({
      ai: true,
      customDomains: true,
      email: true,
      githubActions: true,
      githubOAuth: true,
      googleOAuth: true,
      managedBuilds: true,
      sandbox: true,
      vectorize: false,
    });
  });

  it('honors the installed platform Sandbox capability', () => {
    expect(
      getPlatformCapabilities({
        PLATFORM_CAPABILITIES: JSON.stringify({
          ai: true,
          customDomains: true,
          email: true,
          githubActions: true,
          githubOAuth: true,
          googleOAuth: true,
          managedBuilds: true,
          sandbox: true,
        }),
      }).sandbox,
    ).toBe(true);
  });

  it('requires an explicit search index capability and accepts older capability maps', () => {
    const existing = { ...getPlatformCapabilities({}) };
    delete existing.vectorize;
    expect(
      getPlatformCapabilities({ PLATFORM_CAPABILITIES: JSON.stringify(existing) }).vectorize,
    ).toBe(false);
    expect(
      getPlatformCapabilities({
        PLATFORM_CAPABILITIES: JSON.stringify({ ...existing, vectorize: true }),
      }).vectorize,
    ).toBe(true);
  });

  it('rejects incomplete capability configuration', () => {
    expect(() => getPlatformCapabilities({ PLATFORM_CAPABILITIES: '{"ai":true}' })).toThrow(
      'customDomains',
    );
  });
});
