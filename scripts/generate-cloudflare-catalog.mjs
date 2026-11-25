/// <reference types="node" />
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { loadCloudflareDiscoveryCatalog } from '../platform/packages/api/src/infrastructure/cloudflare-discovery.ts';

const [snapshotPath, version] = process.argv.slice(2);

if (!snapshotPath || !version) {
  throw Error(
    'Usage: node scripts/generate-cloudflare-catalog.mjs <cf schemas.json> <exact version>',
  );
}

const raw = await readFile(snapshotPath, 'utf8');
const catalog = await loadCloudflareDiscoveryCatalog(raw, version);

const destination = new URL(
  '../platform/packages/api/src/infrastructure/cloudflare-snapshot.ts',
  import.meta.url,
);

await writeFile(
  destination,
  [
    '// Decision: Pinned public cf metadata enables offline discovery; gzip keeps it out of the Worker parse budget.',
    `export const cloudflareSnapshotVersion = '${version}';`,
    '',
    `export const cloudflareSnapshotDigest =\n  '${catalog.source.sha256}';`,
    '',
    `export const cloudflareSnapshotGzip =\n  '${gzipSync(raw).toString('base64')}';`,
    '',
  ].join('\n'),
);
