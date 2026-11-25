import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CloudflareOperation } from '@builtbyfriends/deploy-cloudflare';
import { describe, expect, it } from 'vite-plus/test';
import { translateWranglerConfig } from '../../src/cli/cf-config-migrate.ts';
import { verifyGeneratedDeployConfig } from '../../src/cli/deploy-artifact-validation.ts';
import { snapshotBindingIdentities } from '../../src/cli/deploy-binding-snapshot.ts';
import { computeDesiredCloudflareResources } from '../../src/cli/deploy-resources.ts';
import { buildBwfManifest } from '../../src/cli/package.ts';
import {
  checkCloudflareProvisionDrift,
  provisionCloudflareResources,
} from '../../src/cli/provision.ts';
import type { RunWrangler } from '../../src/cli/provision.ts';
import { generateBindingTypes } from '../../src/codegen/binding-types.ts';
import { validateConfig } from '../../src/config.ts';
import {
  emptyDesired,
  ok,
  silentLog,
  useProvisionTestDir as provisionTestDirectory,
} from './provision-fixtures.ts';
const { tmpDir, wranglerPath, setup, readConfig } = provisionTestDirectory('vectorize');
const index = { bindingName: 'SEARCH', dimensions: 384, metric: 'cosine' as const };
const desired = {
  ...emptyDesired,
  vectorize: [{ ...index, name: 'app-vec-1234', description: 'bwf:app:SEARCH' }],
};
const remote = {
  name: 'app-vec-1234',
  description: 'bwf:app:SEARCH',
  config: { dimensions: 384, metric: 'cosine' },
};
const bindings = {
  needsD1: false,
  needsKV: false,
  needsR2: false,
  needsAuth: false,
  needsQueues: false,
  needsAI: false,
  needsSandbox: false,
};

describe('Vectorize declarations', () => {
  it('compiles declared indexes and generates native Worker environment types', () => {
    const config = validateConfig({ vectorize: [index] });
    expect(generateBindingTypes(config)).toContain('"SEARCH": VectorizeIndex;');
    expect(buildBwfManifest({ bindings, vectorize: config.vectorize })).toMatchObject({
      version: 6,
      vectorize: [index],
    });
    expect(buildBwfManifest({ bindings })).not.toHaveProperty('vectorize');
    expect(buildBwfManifest({ bindings }).version).toBe(3);
    expect(() => validateConfig({ vectorize: [{ ...index, dimensions: 0 }] })).toThrow(
      'dimensions',
    );
    expect(() =>
      buildBwfManifest({ bindings, vectorize: [index], vars: { SEARCH: 'conflict' } }),
    ).toThrow('collide');
    expect(() =>
      generateBindingTypes({
        vectorize: [index],
        cloudflare: { services: [{ binding: 'SEARCH' }] },
      }),
    ).toThrow('collides');
  });
  it('creates, verifies, pins and reuses an index without changing its identity', async () => {
    setup('{}');
    let exists = false;
    const calls: Array<CloudflareOperation> = [];
    const run: RunWrangler = (operation) => {
      calls.push(operation);
      if (operation.type === 'vectorize.create') {
        exists = true;
        return { ...ok(), data: remote };
      }
      return exists
        ? { ...ok(), data: remote }
        : { stdout: '', stderr: 'missing', status: 1, failure: 'not-found' };
    };
    expect(checkCloudflareProvisionDrift(wranglerPath, desired).missing).toHaveLength(1);
    const first = await provisionCloudflareResources(tmpDir, wranglerPath, desired, {
      runWrangler: run,
      log: silentLog,
    });
    expect(first.resources[0].action).toBe('created');
    expect(readConfig().vectorize).toEqual([{ binding: 'SEARCH', index_name: remote.name }]);
    expect(checkCloudflareProvisionDrift(wranglerPath, desired).missing).toEqual([]);
    await provisionCloudflareResources(tmpDir, wranglerPath, desired, {
      runWrangler: run,
      log: silentLog,
    });
    expect(calls.map((call) => call.type)).toEqual([
      'vectorize.info',
      'vectorize.create',
      'vectorize.info',
      'vectorize.info',
    ]);
  });
  it.each(['unowned', 'dimensions', 'metric', 'unknown', 'missing-pinned'])(
    'fails closed for %s without creating or replacing',
    async (scenario) => {
      setup(
        scenario === 'missing-pinned'
          ? JSON.stringify({ vectorize: [{ binding: 'SEARCH', index_name: remote.name }] })
          : '{}',
      );
      const calls: Array<CloudflareOperation> = [];
      const run: RunWrangler = (operation) => {
        calls.push(operation);
        if (scenario === 'unknown') {
          return { stdout: '', stderr: 'forbidden', status: 1 };
        }
        if (scenario === 'missing-pinned') {
          return { stdout: '', stderr: 'missing', status: 1, failure: 'not-found' };
        }
        return {
          ...ok(),
          data: {
            ...remote,
            description: scenario === 'unowned' ? 'another app' : remote.description,
            config: {
              dimensions: scenario === 'dimensions' ? 768 : 384,
              metric: scenario === 'metric' ? 'euclidean' : 'cosine',
            },
          },
        };
      };
      await expect(
        provisionCloudflareResources(tmpDir, wranglerPath, desired, {
          runWrangler: run,
          log: silentLog,
        }),
      ).rejects.toThrow(/provision:/);
      expect(calls.map((call) => call.type)).toEqual(['vectorize.info']);
    },
  );
  it('recovers a verified owned creation without creating a duplicate', async () => {
    setup('{}');
    const run: RunWrangler = () => ({ ...ok(), data: remote });
    const result = await provisionCloudflareResources(tmpDir, wranglerPath, desired, {
      runWrangler: run,
      log: silentLog,
    });
    expect(result.resources[0].action).toBe('adopted');
  });
  it('does no Vectorize work for an app without declarations', async () => {
    setup('{}');
    const run: RunWrangler = () => {
      throw new Error('Unexpected provider request');
    };
    expect(
      (
        await provisionCloudflareResources(tmpDir, wranglerPath, emptyDesired, {
          runWrangler: run,
          log: silentLog,
        })
      ).resources,
    ).toEqual([]);
  });
  it.each([
    { vars: { SEARCH: 'collision' } },
    { cloudflare: { services: [{ binding: 'SEARCH' }] } },
    { cloudflare: { durable_objects: { bindings: [{ name: 'SEARCH', class_name: 'Other' }] } } },
    { inference: { bindings: { kv: 'SEARCH' } } },
  ])('rejects binding collisions before account operations: %j', (other) => {
    expect(() => validateConfig({ vectorize: [index], ...other })).toThrow('collides');
  });
  it('allows an explicitly pinned Vectorize index and uses its Worker type', () => {
    const config = validateConfig({
      vectorize: [index],
      cloudflare: { vectorize: [{ binding: 'SEARCH', index_name: 'existing' }] },
    });
    expect(generateBindingTypes(config)?.match(/SEARCH/g)).toHaveLength(1);
  });
  it('validates desired configuration before provisioning other resources', async () => {
    setup('{}');
    const run: RunWrangler = () => {
      throw new Error('Unexpected provider request');
    };
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...desired, vectorize: [{ ...desired.vectorize[0], dimensions: 0 }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow('dimensions');
  });
  it('verifies and adopts an explicitly configured native index instead of deriving another name', async () => {
    setup('{}');
    const config = validateConfig({
      vectorize: [index],
      cloudflare: { vectorize: [{ binding: 'SEARCH', index_name: 'authored-index' }] },
    });
    const { desired: configured } = await computeDesiredCloudflareResources(
      tmpDir,
      config,
      wranglerPath,
    );
    expect(configured.vectorize?.[0]).toMatchObject({ name: 'authored-index', existing: true });
    const calls: Array<CloudflareOperation> = [];
    const run: RunWrangler = (operation) => {
      calls.push(operation);
      return {
        ...ok(),
        data: { ...remote, name: 'authored-index', description: 'Created by the account owner' },
      };
    };
    await provisionCloudflareResources(tmpDir, wranglerPath, configured, {
      runWrangler: run,
      log: silentLog,
    });
    expect(calls.map(({ type }) => type)).toEqual(['vectorize.info']);
    expect(readConfig().vectorize).toEqual([{ binding: 'SEARCH', index_name: 'authored-index' }]);
    const missing: RunWrangler = () => ({
      stdout: '',
      stderr: '',
      status: 1,
      failure: 'not-found',
    });
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, configured, {
        runWrangler: missing,
        log: silentLog,
      }),
    ).rejects.toThrow('will not be replaced');
    await expect(
      computeDesiredCloudflareResources(
        tmpDir,
        {
          ...config,
          cloudflare: { vectorize: [{ binding: 'SEARCH', index_name: 'different-index' }] },
        },
        wranglerPath,
      ),
    ).rejects.toThrow('pinned index identity');
  });
  it('derives stable distinct names and carries the pinned identity through native upload', async () => {
    setup('{}');
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'a'.repeat(63) }));
    const config = validateConfig({ vectorize: [index, { ...index, bindingName: 'search' }] });
    const first = await computeDesiredCloudflareResources(tmpDir, config, wranglerPath);
    const second = await computeDesiredCloudflareResources(tmpDir, config, wranglerPath);
    expect(first.desired.vectorize).toEqual(second.desired.vectorize);
    expect(new Set(first.desired.vectorize?.map((entry) => entry.name)).size).toBe(2);
    expect(first.desired.vectorize?.every((entry) => entry.name.length <= 64)).toBe(true);
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'a'.repeat(40) + 'b'.repeat(23) }),
    );
    const another = await computeDesiredCloudflareResources(tmpDir, config, wranglerPath);
    expect(another.desired.vectorize?.[0].name).not.toBe(first.desired.vectorize?.[0].name);
    const pinned = {
      name: 'app',
      account_id: 'account',
      compatibility_date: '2026-01-01',
      vectorize: [{ binding: 'SEARCH', index_name: remote.name }],
    };
    const snapshot = snapshotBindingIdentities(pinned);
    mkdirSync(join(tmpDir, 'dist/ssr'), { recursive: true });
    mkdirSync(join(tmpDir, '.wrangler/deploy'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.wrangler/deploy/config.json'),
      JSON.stringify({ configPath: '../../dist/ssr/wrangler.json' }),
    );
    writeFileSync(join(tmpDir, 'dist/ssr/wrangler.json'), JSON.stringify(pinned));
    const verified = verifyGeneratedDeployConfig(tmpDir, {
      accountId: 'account',
      workerName: 'app',
      desired,
      bindingIdentitySnapshot: snapshot,
    });
    expect(verified.ok, verified.reason).toBe(true);
    expect(translateWranglerConfig(pinned, 'production').config).toMatchObject({
      worker: { env: { SEARCH: { type: 'vectorize', name: remote.name } } },
    });
    writeFileSync(
      join(tmpDir, 'dist/ssr/wrangler.json'),
      JSON.stringify({ ...pinned, vectorize: [{ binding: 'SEARCH', index_name: 'retargeted' }] }),
    );
    expect(
      verifyGeneratedDeployConfig(tmpDir, {
        accountId: 'account',
        workerName: 'app',
        desired,
        bindingIdentitySnapshot: snapshot,
      }).ok,
    ).toBe(false);
  });
});
