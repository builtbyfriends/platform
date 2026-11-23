import type { PluginOption } from 'vite';
import { describe, expect, it } from 'vite-plus/test';
import {
  devTriggerSecretGuardPlugin,
  isDevTriggerSecretRequest,
  isVitestServer,
} from '../../src/plugin-dev-config.ts';

describe('isDevTriggerSecretRequest', () => {
  it.each([
    '/.bwf/dev-trigger-token',
    '/.BWF/Dev-Trigger-Token',
    '/.bwf/./dev-trigger-token',
    '/.bwf//dev-trigger-token',
    '/.bwf/x/../dev-trigger-token',
    '/%2ebwf/dev-trigger-token',
    '/%252ebwf/dev-trigger-token',
    '/.bwf%2fdev-trigger-token',
    '/.bwf%5cdev-trigger-token',
    '/.bwf./dev-trigger-token',
    '/.bwf/dev-trigger-token.',
    '/.bwf/dev-trigger-token?raw',
    '/.bwf/dev-trigger-token%',
    '/@fs/Users/me/app/.bwf/dev-trigger-token',
    '/.bwf/dev-triggers.ts?import',
    '/@id/.bwf/dev-triggers.ts',
    String.raw`\.bwf\dev-trigger-token`,
    '/.bwf/drizzle.config.json',
    '/.BWF/Drizzle.Config.json',
    '/%2ebwf/drizzle.config.json',
    '/@fs/Users/me/app/.bwf/drizzle.config.json',
    '/.bwf/drizzle.config.json?raw',
  ])('refuses %s', (url) => {
    expect(isDevTriggerSecretRequest(url)).toBe(true);
  });

  it.each([
    undefined,
    '',
    '/',
    '/src/main.ts',
    '/.bwf/entry.ts',
    '/.bwf/routes.d.ts',
    '/__platform/inbox?token=abc',
    '/__platform/scheduled',
    '/api/__platform/cron-trigger',
    '/platform/dev-trigger-token',
    '/.voidx/dev-trigger-token',
    '/drizzle.config.json',
    '/.bwf/drizzle.config.ts',
    '/?q=/.bwf/dev-trigger-token',
    '/@vite/client',
  ])('allows %s', (url) => {
    expect(isDevTriggerSecretRequest(url)).toBe(false);
  });
});

describe('devTriggerSecretGuardPlugin', () => {
  it('runs before other dev server plugins', () => {
    expect(devTriggerSecretGuardPlugin().enforce).toBe('pre');
  });
});

describe('isVitestServer', () => {
  it.each<[Array<PluginOption>]>([
    // Decision: Vitest 5 names each plugin of its server `vitest:*`.
    [[{ name: 'vite-plugin-cloudflare' }, { name: 'vitest:config' }]],
    // Decision: Vitest 3 and 4 also name their main plugin `vitest`.
    [[{ name: 'vitest' }]],
    // Decision: Vite flattens nested arrays and ignores falsy entries.
    [[false, null, [[{ name: 'vitest:test-config' }]]]],
  ])('finds Vitest in %j', (plugins) => {
    expect(isVitestServer({ plugins })).toBe(true);
  });

  it.each<[Array<PluginOption> | undefined]>([
    [undefined],
    [[]],
    [[false, [{ name: 'vite-plugin-cloudflare' }, { name: 'platform:env' }]]],
    // Decision: A plugin named after Vitest isn't Vitest's own.
    [[{ name: 'vitest-plugin-example' }]],
  ])('does not find Vitest in %j', (plugins) => {
    expect(isVitestServer({ plugins })).toBe(false);
  });
});
