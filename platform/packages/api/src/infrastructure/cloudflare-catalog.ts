import { loadCloudflareDiscoveryCatalog } from './cloudflare-discovery.ts';
import type {
  CloudflareDiscoveryCatalog,
  CloudflareDiscoveryOperation,
} from './cloudflare-discovery.ts';
import {
  cloudflareOpenApiIndexSha256,
  cloudflareOpenApiSource,
} from './cloudflare-openapi-snapshot.ts';
import { cloudflareOpenApiIndex } from './cloudflare-openapi.ts';
import type { CloudflareOpenApiEntry } from './cloudflare-openapi.ts';
import {
  cloudflareSnapshotDigest,
  cloudflareSnapshotGzip,
  cloudflareSnapshotVersion,
} from './cloudflare-snapshot.ts';

export type CatalogOperation = Omit<
  CloudflareDiscoveryOperation,
  'command' | 'httpMethod' | 'hasRequestBody'
> & {
  command?: string;
  hasRequestBody?: boolean;
  fieldsTruncated?: boolean;
  aliases: Array<string>;
  commands: Array<string>;
  product: string;
  summary: string;
  tags: Array<string>;
  deprecated: boolean;
  schemaSha256: string;
  httpMethod: CloudflareOpenApiEntry['method'];
};
export type Catalog = {
  source: CloudflareDiscoveryCatalog['source'] & {
    openapi: typeof cloudflareOpenApiSource & { indexSha256: string };
  };
  operations: Array<CatalogOperation>;
};

export function joinCatalog(
  cli: CloudflareDiscoveryCatalog,
  index: Array<CloudflareOpenApiEntry>,
): Catalog {
  const endpoints = new Map<string, Array<CloudflareDiscoveryOperation>>();
  for (const operation of cli.operations) {
    const key = `${operation.httpMethod} ${operation.path}`;
    endpoints.set(key, [...(endpoints.get(key) ?? []), operation]);
  }
  const ids = new Set(index.map((entry) => entry.operationId));
  if (ids.size !== index.length) {
    throw Error('Duplicate OpenAPI operation ID.');
  }
  const operations = index
    .map((entry): CatalogOperation => {
      const matches = endpoints.get(`${entry.method} ${entry.path}`) ?? [];
      for (const alias of matches) {
        if (ids.has(alias.id) && alias.id !== entry.operationId) {
          throw Error('Ambiguous discovery alias.');
        }
      }
      const first = matches[0];
      const segments = entry.path
        .split('/')
        .filter(Boolean)
        .filter((part) => !part.startsWith('{'));
      const product =
        first?.command.split(' ')[1] ??
        segments[Number(segments[0] === 'accounts' || segments[0] === 'zones')] ??
        segments[0];
      return {
        id: entry.operationId,
        aliases: matches.map((value) => value.id),
        commands: matches.map((value) => value.command),
        ...(first && { command: first.command }),
        product,
        summary: entry.summary ?? entry.operationId,
        tags: entry.tags ?? [],
        deprecated: entry.deprecated ?? false,
        schemaSha256: entry.sha256,
        httpMethod: entry.method,
        path: entry.path,
        pathParams: first?.pathParams ?? [],
        queryParams: first?.queryParams ?? [],
        requestBodyFields: first?.requestBodyFields ?? [],
        ...(first && { hasRequestBody: first.hasRequestBody }),
        inputCompleteness: 'summary',
        execution: 'discovery-only',
      };
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    source: {
      ...cli.source,
      openapi: { ...cloudflareOpenApiSource, indexSha256: cloudflareOpenApiIndexSha256 },
    },
    operations,
  };
}

let loaded: Promise<Catalog> | undefined;
export function cloudflareCatalog(): Promise<Catalog> {
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
    return joinCatalog(catalog, await cloudflareOpenApiIndex());
  })();
  return loaded;
}

export function normalizeCatalogQuery(query?: string) {
  return query?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
}

export function catalogPage(
  catalog: Catalog,
  scope: {
    appId: string;
    resourceId: string | null;
    product: string | null;
    query?: string;
    method?: CloudflareOpenApiEntry['method'];
  },
  limit: number,
  cursor?: string,
) {
  const query = normalizeCatalogQuery(scope.query);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || query.length > 200) {
    throw Error('invalid_catalog_request');
  }
  const products = new Map<string, number>();
  for (const operation of catalog.operations) {
    products.set(operation.product, (products.get(operation.product) ?? 0) + 1);
  }
  const tokens = query.split(' ').filter(Boolean);
  const operations =
    scope.product || query || scope.method
      ? catalog.operations.filter((entry) => {
          if (
            (scope.product && entry.product !== scope.product) ||
            (scope.method && entry.httpMethod !== scope.method)
          ) {
            return false;
          }
          const text = [
            entry.id,
            ...entry.aliases,
            ...entry.commands,
            entry.path,
            entry.summary,
            ...entry.tags,
          ]
            .join(' ')
            .toLowerCase();
          return tokens.every((token) => text.includes(token));
        })
      : [];
  const selection = { ...scope, query, method: scope.method ?? null };
  const prefix = `${catalog.source.sha256}:${catalog.source.openapi.indexSha256}:${encodeURIComponent(JSON.stringify(selection))}:`;
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
  const page: Array<CatalogOperation> = [];
  let pageBytes = 2;
  for (const entry of operations.slice(offset, offset + limit)) {
    // Decision: Complete field documentation is fetched separately; summary pages have a strict byte cap even for a single operation.
    const compact = {
      ...entry,
      fieldsTruncated:
        entry.pathParams.length > 8 ||
        entry.queryParams.length > 8 ||
        entry.requestBodyFields.length > 8,
      pathParams: entry.pathParams
        .slice(0, 8)
        .map(({ name, type, required }) => ({ name, type, required })),
      queryParams: entry.queryParams
        .slice(0, 8)
        .map(({ name, type, required }) => ({ name, type, required })),
      requestBodyFields: entry.requestBodyFields
        .slice(0, 8)
        .map(({ name, type, required }) => ({ name, type, required })),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(compact)).byteLength + 1;
    if (pageBytes + bytes > 32_768) {
      if (!page.length) {
        throw Error('catalog_entry_too_large');
      }
      break;
    }
    page.push(compact);
    pageBytes += bytes;
  }
  return {
    source: catalog.source,
    scope: {
      resourceId: scope.resourceId,
      product: scope.product,
      query,
      method: scope.method ?? null,
    },
    products: scope.product
      ? []
      : [...products]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([id, operationCount]) => ({ id, operationCount })),
    operations: page,
    totalMatches: operations.length,
    nextCursor:
      offset + page.length < operations.length ? `${prefix}${offset + page.length}` : null,
  };
}
