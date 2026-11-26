/// <reference types="node" />
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  publishCloudflareArtifacts,
  validateCloudflareArtifacts,
} from './publish-cloudflare-openapi.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const environment = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'private-test-token',
};
async function fixture(count = 2) {
  const directory = await mkdtemp(new URL('openapi-publish-', pathToFileURL(`${tmpdir()}/`)));
  const base = pathToFileURL(`${directory}/`);
  const source = {
    kind: 'cloudflare-openapi',
    openapi: '3.0.3',
    revision: 'b'.repeat(40),
    sha256: 'c'.repeat(64),
  };
  const operations = [];
  for (let n = 0; n < count; n++) {
    const operationId = `operation${n}`;
    const path = `/accounts/{account_id}/things/${n}`;
    const json = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Test', version: '1' },
      paths: { [path]: { get: { operationId, responses: { 200: { description: 'Okay' } } } } },
    });
    const sha256 = hash(json);
    const body = gzipSync(json);
    const file = `${sha256}.json.gz`;
    await writeFile(new URL(file, base), body);
    operations.push({
      operationId,
      method: 'GET',
      path,
      sha256,
      bytes: Buffer.byteLength(json),
      gzipBytes: body.length,
      file,
    });
  }
  const manifest = {
    formatVersion: 1,
    source,
    operations,
    coverage: { extracted: count, excluded: 0, selected: count },
    exclusions: [],
  };
  const entries = operations.map(({ operationId, method, path, sha256, bytes, gzipBytes }) => ({
    operationId,
    method,
    path,
    sha256,
    bytes,
    gzipBytes,
  }));
  await writeFile(new URL('index.json', base), JSON.stringify(manifest));
  return {
    directory,
    base,
    manifest,
    pinned: { source, indexSha256: hash(JSON.stringify(entries)) },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
const options = (value) => ({ directory: value.directory, bucket: 'static-assets-test' });

test('preflights the entire set and supports credential-free dry runs without a request', async () => {
  const value = await fixture();
  try {
    const report = await publishCloudflareArtifacts(
      { ...options(value), dryRun: true },
      {
        pinned: value.pinned,
        environment: {},
        fetcher: () => assert.fail('No network in dry run'),
      },
    );
    assert.equal(report.objects, 2);
    assert.equal(report.uploaded, 0);
    assert.equal(report.dryRun, true);
    await writeFile(new URL(value.manifest.operations[1].file, value.base), 'broken');
    let requests = 0;
    await assert.rejects(
      publishCloudflareArtifacts(options(value), {
        pinned: value.pinned,
        environment,
        fetcher: () => {
          requests++;
          return new Response(null);
        },
      }),
    );
    assert.equal(requests, 0);
  } finally {
    await value.close();
  }
});

test('uploads verified immutable content to the fixed origin with literal key separators and no redirects', async () => {
  const value = await fixture();
  try {
    const calls = [];
    const report = await publishCloudflareArtifacts(options(value), {
      pinned: value.pinned,
      environment,
      fetcher: async (url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 200 });
      },
    });
    assert.equal(report.uploaded, 2);
    for (let i = 0; i < calls.length; i++) {
      const { url, init } = calls[i];
      assert.equal(new URL(url).origin, 'https://api.cloudflare.com');
      assert.ok(
        url.includes(`/objects/infrastructure/cloudflare-openapi/${value.pinned.source.sha256}/`),
      );
      assert.ok(!url.includes('%2F'));
      assert.equal(init.method, 'PUT');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer private-test-token');
      assert.equal(init.headers['Content-Type'], 'application/gzip');
      assert.equal(init.headers['cf-r2-data-catalog-check'], 'true');
      assert.equal(init.headers['Content-Encoding'], undefined);
      assert.deepEqual(
        init.body,
        await readFile(new URL(value.manifest.operations[i].file, value.base)),
      );
    }
    assert.ok(!JSON.stringify(report).includes(environment.CLOUDFLARE_API_TOKEN));
  } finally {
    await value.close();
  }
});

test('enforces bounded concurrency and permits deterministic reruns', async () => {
  const value = await fixture(9);
  try {
    let active = 0;
    let maximum = 0;
    const bodies = new Map();
    const fetcher = async (url, init) => {
      active++;
      maximum = Math.max(active, maximum);
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (bodies.has(url)) {
        assert.deepEqual(init.body, bodies.get(url));
      }
      bodies.set(url, Buffer.from(init.body));
      active--;
      return new Response(null);
    };
    const args = { pinned: value.pinned, environment, fetcher };
    await publishCloudflareArtifacts({ ...options(value), concurrency: 3 }, args);
    await publishCloudflareArtifacts({ ...options(value), concurrency: 3 }, args);
    assert.equal(maximum, 3);
    assert.equal(bodies.size, 9);
  } finally {
    await value.close();
  }
});

test('retries rate limits and transient failures with bounded waits, without printing error bodies', async () => {
  const value = await fixture(1);
  try {
    const waits = [];
    let requests = 0;
    const report = await publishCloudflareArtifacts(options(value), {
      pinned: value.pinned,
      environment,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
      fetcher: async () => {
        requests++;
        if (requests === 1) {
          return new Response('private response', {
            status: 429,
            headers: { 'Retry-After': '3600' },
          });
        }
        if (requests === 2) {
          return new Response('private response', { status: 503 });
        }
        if (requests === 3) {
          throw Error('private-test-token in network diagnostics');
        }
        return new Response(null);
      },
    });
    assert.equal(report.uploaded, 1);
    assert.deepEqual(waits, [300_000, 2000, 4000]);
  } finally {
    await value.close();
  }
});

test('fails without retrying permission errors and stops scheduling further objects', async () => {
  const value = await fixture(5);
  try {
    let requests = 0;
    await assert.rejects(
      publishCloudflareArtifacts(
        { ...options(value), concurrency: 1 },
        {
          pinned: value.pinned,
          environment,
          fetcher: async () => {
            requests++;
            return new Response(environment.CLOUDFLARE_API_TOKEN, { status: 403 });
          },
        },
      ),
      (error) =>
        error.message.includes('HTTP 403') &&
        !error.message.includes(environment.CLOUDFLARE_API_TOKEN),
    );
    assert.equal(requests, 1);
  } finally {
    await value.close();
  }
});

test('does not expose network diagnostics containing credentials after retry exhaustion', async () => {
  const value = await fixture(1);
  try {
    let requests = 0;
    await assert.rejects(
      publishCloudflareArtifacts(options(value), {
        pinned: value.pinned,
        environment,
        sleep: async () => {},
        fetcher: async () => {
          requests++;
          throw Error(environment.CLOUDFLARE_API_TOKEN);
        },
      }),
      (error) =>
        !error.message.includes(environment.CLOUDFLARE_API_TOKEN) &&
        error.message.includes('did not complete'),
    );
    assert.equal(requests, 4);
  } finally {
    await value.close();
  }
});

test('rejects traversal, altered pins and symlink artifact files before network access', async () => {
  const value = await fixture(1);
  try {
    const entry = value.manifest.operations[0];
    entry.file = '../outside.json.gz';
    await writeFile(new URL('index.json', value.base), JSON.stringify(value.manifest));
    await assert.rejects(
      validateCloudflareArtifacts(value.directory, value.pinned),
      /invalid or duplicate/,
    );
    entry.file = `${entry.sha256}.json.gz`;
    await writeFile(new URL('index.json', value.base), JSON.stringify(value.manifest));
    await assert.rejects(
      validateCloudflareArtifacts(value.directory, {
        ...value.pinned,
        indexSha256: 'd'.repeat(64),
      }),
      /pinned index/,
    );
    await assert.rejects(
      validateCloudflareArtifacts(value.directory, {
        ...value.pinned,
        source: { ...value.pinned.source, sha256: 'd'.repeat(64) },
      }),
      /pinned Cloudflare source/,
    );
    const target = new URL(entry.file, value.base);
    await rm(target);
    await symlink(new URL('index.json', value.base), target);
    await assert.rejects(validateCloudflareArtifacts(value.directory, value.pinned));
  } finally {
    await value.close();
  }
});

test('rejects unsafe targets, credentials and concurrency without sending a request', async () => {
  const value = await fixture(1);
  try {
    const deps = {
      pinned: value.pinned,
      environment: {},
      fetcher: () => assert.fail('No request allowed'),
    };
    await assert.rejects(
      publishCloudflareArtifacts({ ...options(value), bucket: '../other' }, deps),
      /bucket/,
    );
    await assert.rejects(
      publishCloudflareArtifacts({ ...options(value), concurrency: 9 }, deps),
      /Concurrency/,
    );
    await assert.rejects(publishCloudflareArtifacts(options(value), deps), /environment/);
    await assert.rejects(
      publishCloudflareArtifacts(options(value), {
        ...deps,
        environment: { ...environment, CLOUDFLARE_ACCOUNT_ID: '../escape' },
      }),
      /environment/,
    );
  } finally {
    await value.close();
  }
});

test('rejects valid gzip with an altered digest and bounds decompression before publication', async () => {
  for (const bomb of [false, true]) {
    const value = await fixture(1);
    try {
      const entry = value.manifest.operations[0];
      const body = gzipSync(bomb ? 'x'.repeat(1024 * 1024) : 'x'.repeat(entry.bytes));
      entry.gzipBytes = body.length;
      await writeFile(new URL(entry.file, value.base), body);
      await writeFile(new URL('index.json', value.base), JSON.stringify(value.manifest));
      const entries = value.manifest.operations.map(
        ({ operationId, method, path, sha256, bytes, gzipBytes }) => ({
          operationId,
          method,
          path,
          sha256,
          bytes,
          gzipBytes,
        }),
      );
      value.pinned.indexSha256 = hash(JSON.stringify(entries));
      let requests = 0;
      await assert.rejects(
        publishCloudflareArtifacts(options(value), {
          pinned: value.pinned,
          environment,
          fetcher: () => {
            requests++;
            return new Response(null);
          },
        }),
        bomb ? /larger than/ : /integrity/,
      );
      assert.equal(requests, 0);
    } finally {
      await value.close();
    }
  }
});
