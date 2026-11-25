import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { home, keyring } = vi.hoisted(() => ({
  home: { value: '' },
  keyring: new Map<string, string>(),
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => home.value,
}));
vi.mock('../../src/cli/keyring.ts', () => ({
  readKeyringPassword: (service: string, account: string) =>
    keyring.get(`${service}\0${account}`) ?? null,
  writeKeyringPassword: (service: string, account: string, value: string) => {
    keyring.set(`${service}\0${account}`, value);
    return true;
  },
  deleteKeyringPassword: vi.fn(),
}));

import {
  platformRegistryDirectory,
  readPendingInstallationSecrets,
  writePendingInstallationSecrets,
} from '../../src/cli/platform-registry.ts';

beforeEach(() => {
  home.value = mkdtempSync(join(tmpdir(), 'bwf-registry-home-'));
  keyring.clear();
  vi.stubEnv('PLATFORM_REGISTRY_DIR', undefined);
  vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', undefined);
  vi.stubEnv('PLATFORM_RECOVERY_KEY', undefined);
  vi.stubEnv('VOID_PLATFORM_RECOVERY_KEY', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home.value, { recursive: true, force: true });
});

function addRegistry(name: string) {
  const directory = join(home.value, name, 'platforms');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'registry.json'), '{}');
  return directory;
}

describe('platform registry from earlier releases', () => {
  it('uses ~/.bwf/platforms when no earlier registry exists', () => {
    expect(platformRegistryDirectory()).toBe(toSlash(join(home.value, '.bwf', 'platforms')));
  });

  it('keeps using an earlier registry in place', () => {
    const voidDirectory = addRegistry('.void');
    expect(platformRegistryDirectory()).toBe(toSlash(voidDirectory));
    const platformDirectory = addRegistry('.platform');
    expect(platformRegistryDirectory()).toBe(toSlash(platformDirectory));
    const bwfDirectory = addRegistry('.bwf');
    expect(platformRegistryDirectory()).toBe(toSlash(bwfDirectory));
  });

  it('reads the old registry directory variable', () => {
    vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', '/tmp/old-registry');
    expect(platformRegistryDirectory()).toBe('/tmp/old-registry');
    vi.stubEnv('PLATFORM_REGISTRY_DIR', '/tmp/new-registry');
    expect(platformRegistryDirectory()).toBe('/tmp/new-registry');
  });

  it('reads the recovery key from the old keychain service', () => {
    const directory = join(home.value, '.void', 'platforms');
    const manifest = {
      account: { id: 'account_1' },
      id: 'installation-1',
      ownershipNonce: 'nonce',
    } as never;
    const key = Buffer.alloc(32, 9).toString('base64');
    vi.stubEnv('PLATFORM_RECOVERY_KEY', key);
    mkdirSync(join(directory, 'account_1'), { recursive: true });
    writePendingInstallationSecrets(manifest, { token: 'secret' }, directory);
    vi.stubEnv('PLATFORM_RECOVERY_KEY', undefined);
    expect(() => readPendingInstallationSecrets(manifest, directory)).toThrow('encryption key');
    const account = `recovery:${createHash('sha256').update(toSlash(directory)).digest('hex')}`;
    keyring.set(`dev.void.cli.platform\0${account}`, key);
    expect(readPendingInstallationSecrets(manifest, directory)).toEqual({ token: 'secret' });
  });

  it('reads the old recovery key variable', () => {
    const directory = join(home.value, '.void', 'platforms');
    const manifest = {
      account: { id: 'account_1' },
      id: 'installation-1',
      ownershipNonce: 'nonce',
    } as never;
    const key = Buffer.alloc(32, 9).toString('base64');
    vi.stubEnv('PLATFORM_RECOVERY_KEY', key);
    mkdirSync(join(directory, 'account_1'), { recursive: true });
    writePendingInstallationSecrets(manifest, { token: 'secret' }, directory);
    vi.stubEnv('PLATFORM_RECOVERY_KEY', undefined);
    vi.stubEnv('VOID_PLATFORM_RECOVERY_KEY', key);
    expect(readPendingInstallationSecrets(manifest, directory)).toEqual({ token: 'secret' });
  });
});
