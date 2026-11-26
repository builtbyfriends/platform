import { type } from 'arktype';
import {
  cloudflareOpenApiIndexGzip,
  cloudflareOpenApiIndexSha256,
  cloudflareOpenApiSource,
} from './cloudflare-openapi-snapshot.ts';

const digest = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const entrySchema = type({
  operationId: 'string > 0',
  method: "'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'TRACE'",
  path: 'string > 0',
  sha256: digest,
  'summary?': type('string').atMostLength(2000),
  'tags?': type('string').atMostLength(200).array().atMostLength(30),
  'deprecated?': 'boolean',
  bytes: type('number.integer')
    .atLeast(1)
    .atMost(1024 * 1024),
  gzipBytes: type('number.integer')
    .atLeast(1)
    .atMost(1024 * 1024),
});
const indexSchema = entrySchema.array().atMostLength(5000);
export type CloudflareOpenApiEntry = typeof entrySchema.infer;

async function verifiedJson(stream: ReadableStream<Uint8Array>, limit: number, expected: string) {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > limit) {
        throw Error('Operation schema exceeds its pinned size.');
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== expected) {
    throw Error('Operation schema does not match its pinned digest.');
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return value;
}

let index: Promise<Array<CloudflareOpenApiEntry>> | undefined;

export function cloudflareOpenApiIndex() {
  index ??= (async () => {
    const bytes = Uint8Array.from(atob(cloudflareOpenApiIndexGzip), (character) =>
      character.charCodeAt(0),
    );
    const value = await verifiedJson(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
      2 * 1024 * 1024,
      cloudflareOpenApiIndexSha256,
    );
    return indexSchema.assert(value);
  })();
  return index;
}

export function cloudflareOpenApiKey(entry: CloudflareOpenApiEntry) {
  return `infrastructure/cloudflare-openapi/${cloudflareOpenApiSource.sha256}/${entry.sha256}.json.gz`;
}

export async function cloudflareOperationSchema(bucket: R2Bucket, entry: CloudflareOpenApiEntry) {
  const object = await bucket.get(cloudflareOpenApiKey(entry));
  if (!object) {
    return null;
  }
  if (object.size !== entry.gzipBytes) {
    await object.body.cancel();
    throw Error('Operation schema has changed.');
  }
  const document = await verifiedJson(
    object.body.pipeThrough(new DecompressionStream('gzip')),
    entry.bytes,
    entry.sha256,
  );
  return {
    source: {
      kind: 'cloudflare-openapi' as const,
      ...cloudflareOpenApiSource,
      openapi: '3.0.3' as const,
    },
    operationId: entry.operationId,
    method: entry.method,
    path: entry.path,
    sha256: entry.sha256,
    execution: 'discovery-only' as const,
    document,
  };
}
