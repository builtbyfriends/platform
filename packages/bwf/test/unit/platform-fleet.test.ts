import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  setInstallationEndpoints,
} from '@builtbyfriends/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import { installationSpecificEnv, upgradeInstallations } from '../../src/cli/platform-fleet.ts';
import { writeInstallationManifest } from '../../src/cli/platform-registry.ts';

let registry = '';

function install(slug: string) {
  writeInstallationManifest(
    setInstallationEndpoints(
      createPlatformInstallationManifest({
        account: { id: `account_${slug}`, name: slug },
        createdAt: '2026-11-22T00:00:00.000Z',
        deployment: createPlatformDeploymentManifest({
          application: { baseDomain: `${slug}.example.com`, zoneName: `${slug}.example.com` },
          displayName: slug,
          installationSlug: slug,
        }),
        id: `${slug}-a1b2c3d4`,
        ownershipNonce: '0123456789abcdef0123456789abcdef',
        platformVersion: '1.0.0',
      }),
      { apiUrl: `https://api.${slug}.example.com`, dashboardUrl: null, proxyUrl: null },
      '2026-11-22T00:00:00.000Z',
    ),
    registry,
  );
}

const healthy = (async () => Response.json({ platformVersion: '1.1.0' })) as typeof fetch;

beforeEach(() => {
  registry = mkdtempSync(join(tmpdir(), 'platform-fleet-'));
  process.env.PLATFORM_REGISTRY_DIR = registry;
  install('one');
  install('two');
  install('three');
});

afterEach(() => {
  delete process.env.PLATFORM_REGISTRY_DIR;
  rmSync(registry, { recursive: true, force: true });
});

function upgradeArgs(...selectors: Array<string>) {
  const args = parsePlatformArgs(['upgrade', ...selectors, '--yes']);
  if (args.subcommand !== 'upgrade' || !args.selectors) {
    throw new Error('expected several selectors');
  }
  return { ...args, selectors: args.selectors };
}

describe('upgradeInstallations', () => {
  it('parses several installations only for upgrade', () => {
    expect(upgradeArgs('one', 'two').selectors).toEqual(['one', 'two']);
    expect(parsePlatformArgs(['upgrade', 'one'])).not.toHaveProperty('selectors');
    expect(() => parsePlatformArgs(['repair', 'one', 'two'])).toThrow(/Unexpected argument/);
    expect(parsePlatformArgs(['list', '--health'])).toEqual({ subcommand: 'list', health: true });
  });

  it('upgrades in order, checks health, and leaves others alone', async () => {
    const upgraded: Array<string> = [];
    await upgradeInstallations(
      upgradeArgs('two', 'one'),
      async (args) => void upgraded.push(args.selector),
      healthy,
      {},
    );
    expect(upgraded).toEqual(['two-a1b2c3d4', 'one-a1b2c3d4']);
  });

  it('stops at the first failure and names what was not started', async () => {
    const upgraded: Array<string> = [];
    const result = upgradeInstallations(
      upgradeArgs('one', 'two', 'three'),
      async (args) => {
        if (args.selector.startsWith('two')) {
          throw new Error('migration failed');
        }
        upgraded.push(args.selector);
      },
      healthy,
      {},
    );
    await expect(result).rejects.toThrow(
      /Stopped at two.*migration failed\nUpgraded: one-a1b2c3d4\nNot started: three-a1b2c3d4/s,
    );
    expect(upgraded).toEqual(['one-a1b2c3d4']);
  });

  it('stops when an upgraded installation is not healthy', async () => {
    const down = (async () => new Response('', { status: 503 })) as typeof fetch;
    await expect(
      upgradeInstallations(upgradeArgs('one', 'two'), async () => {}, down, {}),
    ).rejects.toThrow(/Stopped at one.*HTTP 503.*Not started: two-a1b2c3d4/s);
  });

  it('refuses credentials that would apply to every installation', async () => {
    expect(
      installationSpecificEnv({
        CLOUDFLARE_API_TOKEN: 'x',
        PLATFORM_DATABASE_URL: 'postgres://',
        PLATFORM_RECOVERY_KEY: 'k',
      }),
    ).toEqual(['CLOUDFLARE_API_TOKEN', 'PLATFORM_DATABASE_URL']);
    await expect(
      upgradeInstallations(upgradeArgs('one', 'two'), async () => {}, healthy, {
        PLATFORM_DATABASE_URL: 'postgres://',
      }),
    ).rejects.toThrow(/PLATFORM_DATABASE_URL would apply to every installation/);
  });

  it('refuses a platform that is only connected', async () => {
    await expect(
      upgradeInstallations(upgradeArgs('one', 'hosted'), async () => {}, healthy, {}),
    ).rejects.toThrow(/No local installation matches "hosted"/);
  });
});
