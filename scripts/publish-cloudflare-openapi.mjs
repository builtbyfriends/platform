/// <reference types="node" />
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  cloudflareOpenApiSource,
  cloudflareOpenApiIndexSha256,
} from '../platform/packages/api/src/infrastructure/cloudflare-openapi-snapshot.ts';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const methods = new Set(['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE']);
const positive = (value, limit) => Number.isSafeInteger(value) && value > 0 && value <= limit;

async function boundedFile(url, limit) {
  const file = await open(url, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || !positive(info.size, limit)) {
      throw Error('Artifact file is not a bounded regular file.');
    }
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) {
        break;
      }
      length += bytesRead;
    }
    if (length !== info.size) {
      throw Error('Artifact changed during verification.');
    }
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

export async function validateCloudflareArtifacts(
  directory,
  { source = cloudflareOpenApiSource, indexSha256 = cloudflareOpenApiIndexSha256 } = {},
) {
  const base = pathToFileURL(`${directory}/`);
  const manifest = JSON.parse(
    (await boundedFile(new URL('index.json', base), 8 * 1024 * 1024)).toString('utf8'),
  );
  if (
    !manifest ||
    manifest.formatVersion !== 1 ||
    manifest.source?.kind !== 'cloudflare-openapi' ||
    manifest.source.openapi !== '3.0.3' ||
    !digest.test(manifest.source.sha256) ||
    !/^[a-f0-9]{40}$/.test(manifest.source.revision) ||
    manifest.source.sha256 !== source.sha256 ||
    manifest.source.revision !== source.revision ||
    !Array.isArray(manifest.operations) ||
    !positive(manifest.operations.length, 10_000) ||
    !Array.isArray(manifest.exclusions) ||
    manifest.coverage?.extracted !== manifest.operations.length ||
    manifest.coverage.excluded !== manifest.exclusions.length ||
    manifest.coverage.selected !== manifest.operations.length + manifest.exclusions.length
  ) {
    throw Error('Manifest does not match the pinned Cloudflare source or coverage.');
  }
  const entries = [];
  const ids = new Set();
  const paths = new Set();
  const files = new Set();
  for (const entry of manifest.operations) {
    if (
      !entry ||
      typeof entry.operationId !== 'string' ||
      !entry.operationId ||
      entry.operationId.length > 512 ||
      !methods.has(entry.method) ||
      typeof entry.path !== 'string' ||
      !entry.path.startsWith('/') ||
      !digest.test(entry.sha256) ||
      entry.file !== `${entry.sha256}.json.gz` ||
      !positive(entry.bytes, 1024 * 1024) ||
      !positive(entry.gzipBytes, 1024 * 1024) ||
      ids.has(entry.operationId) ||
      paths.has(`${entry.method} ${entry.path}`) ||
      files.has(entry.file)
    ) {
      throw Error('Manifest contains an invalid or duplicate operation artifact.');
    }
    ids.add(entry.operationId);
    paths.add(`${entry.method} ${entry.path}`);
    files.add(entry.file);
    entries.push({
      operationId: entry.operationId,
      method: entry.method,
      path: entry.path,
      sha256: entry.sha256,
      bytes: entry.bytes,
      gzipBytes: entry.gzipBytes,
      summary: entry.summary,
      tags: entry.tags,
      deprecated: entry.deprecated,
    });
  }
  if (hash(JSON.stringify(entries)) !== indexSha256) {
    throw Error('Manifest operations do not match the pinned index.');
  }
  const total = entries.reduce((sum, entry) => sum + entry.gzipBytes, 0);
  if (total > 64 * 1024 * 1024) {
    throw Error('Artifact set exceeds the 64 MiB publication limit.');
  }
  const artifacts = [];
  for (const entry of entries) {
    const file = `${entry.sha256}.json.gz`;
    const body = await boundedFile(new URL(file, base), entry.gzipBytes);
    const inflated = gunzipSync(body, { maxOutputLength: entry.bytes });
    if (
      body.length !== entry.gzipBytes ||
      inflated.length !== entry.bytes ||
      hash(inflated) !== entry.sha256
    ) {
      throw Error(`Artifact integrity check failed: ${entry.sha256}`);
    }
    const document = JSON.parse(inflated.toString('utf8'));
    if (
      document.openapi !== '3.0.3' ||
      document.paths?.[entry.path]?.[entry.method.toLowerCase()]?.operationId !== entry.operationId
    ) {
      throw Error(`Artifact operation does not match its index: ${entry.sha256}`);
    }
    artifacts.push({ key: `infrastructure/cloudflare-openapi/${source.sha256}/${file}`, body });
  }
  return { source, artifacts, bytes: total, excluded: manifest.exclusions.length };
}

export async function publishCloudflareArtifacts(
  { directory, bucket, concurrency = 4, dryRun = false, skipKeys = [] },
  { environment = process.env, fetcher = fetch, sleep = delay, pinned, onProgress = () => {} } = {},
) {
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw Error('A valid existing R2 bucket name is required.');
  }
  if (!positive(concurrency, 8)) {
    throw Error('Concurrency must be between 1 and 8.');
  }
  const verified = await validateCloudflareArtifacts(directory, pinned);
  const available = new Set(verified.artifacts.map((artifact) => artifact.key));
  if (
    !Array.isArray(skipKeys) ||
    skipKeys.some((key) => typeof key !== 'string' || !available.has(key)) ||
    new Set(skipKeys).size !== skipKeys.length
  ) {
    throw Error('Resume keys must be unique keys from the verified artifact set.');
  }
  const skipped = new Set(skipKeys);
  const pending = verified.artifacts.filter((artifact) => !skipped.has(artifact.key));
  const summary = {
    source: verified.source,
    bucket,
    objects: verified.artifacts.length,
    bytes: verified.bytes,
    excluded: verified.excluded,
    skipped: skipped.size,
  };
  if (dryRun) {
    return { ...summary, uploaded: 0, dryRun: true };
  }
  const account = environment.CLOUDFLARE_ACCOUNT_ID;
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (
    typeof account !== 'string' ||
    !/^[a-f0-9]{32}$/.test(account) ||
    typeof token !== 'string' ||
    !token.trim() ||
    /[\r\n]/.test(token)
  ) {
    throw Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment.');
  }
  let next = 0;
  let uploaded = 0;
  let stopped = false;
  const upload = async (artifact) => {
    const key = artifact.key.split('/').map(encodeURIComponent).join('/');
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/r2/buckets/${encodeURIComponent(bucket)}/objects/${key}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try {
        response = await fetcher(url, {
          method: 'PUT',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/gzip',
            'Content-Length': String(artifact.body.length),
            'cf-r2-data-catalog-check': 'true',
          },
          body: artifact.body,
        });
      } catch {
        if (attempt === 3) {
          throw Error(
            'R2 upload did not complete; rerun publication to retry identical artifacts.',
          );
        }
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      await response.body?.cancel().catch(() => {});
      if (response.ok) {
        return;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        const header = response.headers.get('retry-after');
        const seconds = header && /^\d+$/.test(header) ? Number(header) : undefined;
        const date = header && seconds === undefined ? Date.parse(header) : NaN;
        const wait =
          seconds === undefined
            ? Number.isFinite(date)
              ? date - Date.now()
              : 1000 * 2 ** attempt
            : seconds * 1000;
        await sleep(Math.min(300_000, Math.max(1000, wait)));
        continue;
      }
      throw Error(
        `R2 upload failed with HTTP ${response.status}; rerun publication after resolving the error.`,
      );
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (!stopped && next < pending.length) {
      const artifact = pending[next++];
      try {
        await upload(artifact);
        uploaded++;
        onProgress({ uploaded, total: pending.length });
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failed) {
    throw failed.reason;
  }
  return { ...summary, uploaded, dryRun: false };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [directory, bucket, mode] = process.argv.slice(2);
  if (
    !directory ||
    !bucket ||
    !['--dry-run', '--publish'].includes(mode) ||
    process.argv.length !== 5
  ) {
    process.stderr.write(
      'Usage: node scripts/publish-cloudflare-openapi.mjs <artifact directory> <existing bucket> --dry-run|--publish\n',
    );
    process.exitCode = 1;
  } else {
    try {
      const result = await publishCloudflareArtifacts(
        { directory, bucket, dryRun: mode === '--dry-run' },
        {
          onProgress: ({ uploaded, total }) => {
            if (uploaded % 100 === 0 || uploaded === total) {
              process.stdout.write(`Uploaded ${uploaded}/${total} artifacts\n`);
            }
          },
        },
      );
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`Publication failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
