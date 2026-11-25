import { loadCloudflareDiscoveryCatalog } from './cloudflare-discovery.ts';
import type {
  CloudflareDiscoveryCatalog,
  CloudflareDiscoveryOperation,
} from './cloudflare-discovery.ts';
import {
  cloudflareSnapshotDigest,
  cloudflareSnapshotGzip,
  cloudflareSnapshotVersion,
} from './cloudflare-snapshot.ts';

let loaded: Promise<CloudflareDiscoveryCatalog> | undefined;

export function cloudflareCatalog(): Promise<CloudflareDiscoveryCatalog> {
  loaded ??= (async () => {
    const bytes = Uint8Array.from(atob(cloudflareSnapshotGzip), (character) =>
      character.charCodeAt(0),
    );

    const json = await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text();

    const catalog = await loadCloudflareDiscoveryCatalog(json, cloudflareSnapshotVersion);

    if (catalog.source.sha256 !== cloudflareSnapshotDigest) {
      throw Error('Cloudflare discovery snapshot does not match its pinned digest.');
    }

    return catalog;
  })();

  return loaded;
}

export function catalogPage(
  catalog: CloudflareDiscoveryCatalog,
  scope: { appId: string; resourceId: string | null; product: string | null },
  limit: number,
  cursor?: string,
) {
  const products = new Map<string, number>();

  for (const operation of catalog.operations) {
    const product = operation.command.split(' ')[1];
    products.set(product, (products.get(product) ?? 0) + 1);
  }

  const operations = scope.product
    ? catalog.operations.filter((entry) => entry.command.startsWith(`cf ${scope.product} `))
    : [];

  const prefix = `${catalog.source.sha256}:${encodeURIComponent(JSON.stringify(scope))}:`;
  const offsetText = cursor ? cursor.slice(prefix.length) : '0';
  const offset = Number(offsetText);

  if (
    cursor &&
    (!cursor.startsWith(prefix) ||
      !/^(0|[1-9]\d*)$/.test(offsetText) ||
      !Number.isSafeInteger(offset) ||
      offset >= operations.length)
  ) {
    throw Error('invalid_cursor');
  }

  const page: Array<CloudflareDiscoveryOperation> = [];
  const encoder = new TextEncoder();
  let pageBytes = 2;

  for (const entry of operations.slice(offset, offset + limit)) {
    const bytes = encoder.encode(JSON.stringify(entry)).byteLength + 1;

    if (page.length && pageBytes + bytes > 32_768) {
      break;
    }

    page.push(entry);
    pageBytes += bytes;
  }

  return {
    source: catalog.source,
    scope: { resourceId: scope.resourceId, product: scope.product },
    products: scope.product
      ? []
      : [...products].map(([id, operationCount]) => ({ id, operationCount })),
    operations: page,
    nextCursor:
      offset + page.length < operations.length ? `${prefix}${offset + page.length}` : null,
  };
}
