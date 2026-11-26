/// <reference types="node" />
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const own = (value, key) => Object.hasOwn(value, key);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function indexCloudflareOperations(document) {
  if (document.openapi !== '3.0.3' || !document.info || !document.paths) {
    throw Error('Expected an OpenAPI 3.0.3 document with info and paths.');
  }
  const ids = new Set();
  const operations = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.has(method)) {
        continue;
      }
      if (typeof operation.operationId !== 'string' || !operation.operationId) {
        throw Error(`Missing operationId: ${method.toUpperCase()} ${path}`);
      }
      if (ids.has(operation.operationId)) {
        throw Error(`Duplicate operationId: ${operation.operationId}`);
      }
      ids.add(operation.operationId);
      operations.push({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path,
        summary: operation.summary ?? '',
        tags: operation.tags ?? [],
        deprecated: operation.deprecated === true,
      });
    }
  }
  return operations;
}

function componentReference(document, reference) {
  if (typeof reference !== 'string' || !reference.startsWith('#/components/')) {
    throw Error(`Unsupported non-component or external reference: ${String(reference)}`);
  }
  const segments = decodeURIComponent(reference.slice(2))
    .split('/')
    .map((decoded) => {
      if (/~(?:[^01]|$)/.test(decoded)) {
        throw Error(`Invalid JSON pointer: ${reference}`);
      }
      return decoded.replace(/~1/g, '/').replace(/~0/g, '~');
    });
  if (segments.length < 3) {
    throw Error(`Incomplete component reference: ${reference}`);
  }
  let target = document;
  for (const segment of segments) {
    if (!target || typeof target !== 'object' || !own(target, segment)) {
      throw Error(`Missing reference: ${reference}`);
    }
    target = target[segment];
  }
  return segments.slice(1, 3);
}

function extract(document, selection) {
  const method = selection.method.toLowerCase();
  if (!methods.has(method) || !own(document.paths, selection.path)) {
    throw Error(`Unknown operation: ${selection.method} ${selection.path}`);
  }
  const pathItem = document.paths[selection.path];
  if (!own(pathItem, method)) {
    throw Error(`Unknown operation: ${method} ${selection.path}`);
  }
  const selectedPath = Object.fromEntries(
    Object.entries(pathItem).filter(([key]) => !methods.has(key) || key === method),
  );
  const extracted = Object.fromEntries(
    Object.entries(document).filter(
      ([key]) => !['paths', 'components', 'x-forge-commands'].includes(key),
    ),
  );
  extracted.paths = { [selection.path]: selectedPath };
  extracted.components = Object.create(null);
  const pending = [];
  const visited = new Set();
  const add = (reference) => {
    const [category, name] = componentReference(document, reference);
    const identity = JSON.stringify([category, name]);
    if (visited.has(identity)) {
      return;
    }
    visited.add(identity);
    extracted.components[category] ??= Object.create(null);
    const component = document.components[category][name];
    extracted.components[category][name] = component;
    pending.push({ component, category });
  };
  const maps = new Set([
    'properties',
    'patternProperties',
    'schemas',
    'headers',
    'links',
    'callbacks',
    'content',
    'paths',
    'securitySchemes',
    'responses',
    'encoding',
  ]);
  const scan = (value, mode = 'object') => {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (mode === 'map') {
      for (const nested of Object.values(value)) {
        scan(nested);
      }
      return;
    }
    if (typeof value.$ref === 'string') {
      add(value.$ref);
    }
    if (value.discriminator?.mapping) {
      for (const reference of Object.values(value.discriminator.mapping)) {
        add(
          reference.startsWith('#') || reference.includes('/')
            ? reference
            : `#/components/schemas/${reference.replace(/~/g, '~0').replace(/\//g, '~1')}`,
        );
      }
    }
    if (Array.isArray(value.security)) {
      for (const requirement of value.security) {
        for (const name of Object.keys(requirement)) {
          add(`#/components/securitySchemes/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`);
        }
      }
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'example' || key === 'default' || key === 'enum' || key.startsWith('x-')) {
        continue;
      }
      if (key === 'examples' && nested && typeof nested === 'object') {
        for (const example of Object.values(nested)) {
          if (example && typeof example.$ref === 'string') {
            add(example.$ref);
          }
        }
      } else if (key !== 'value' || mode !== 'example') {
        scan(nested, maps.has(key) ? 'map' : 'object');
      }
    }
  };
  scan(extracted);
  while (pending.length) {
    const { component, category } = pending.pop();
    scan(component, category === 'examples' ? 'example' : 'object');
  }
  const result = structuredClone(extracted);
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) {
    throw Error('Operation document exceeds the 1 MiB artifact limit.');
  }
  return {
    document: result,
    metadata: {
      operationId: pathItem[method].operationId,
      summary: pathItem[method].summary ?? '',
      tags: pathItem[method].tags ?? [],
      deprecated: pathItem[method].deprecated === true,
      method: method.toUpperCase(),
      path: selection.path,
      execution: 'discovery-only',
      componentCount: visited.size,
      excludedRootExtensions: own(document, 'x-forge-commands') ? ['x-forge-commands'] : [],
    },
  };
}

export function extractCloudflareOperation(document, selection) {
  indexCloudflareOperations(document);
  return extract(document, selection);
}

export async function buildCloudflareCatalog({
  sourcePath,
  revision,
  outputDirectory,
  selections,
}) {
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw Error('An exact 40-character source revision is required.');
  }
  if ((await stat(sourcePath)).size > 64 * 1024 * 1024) {
    throw Error('Source exceeds the 64 MiB build-time limit.');
  }
  const raw = await readFile(sourcePath);
  const document = JSON.parse(raw.toString('utf8'));
  const allOperations = indexCloudflareOperations(document);
  const chosen = selections ?? allOperations;
  const artifacts = [];
  const exclusions = [];
  const destination = outputDirectory ? pathToFileURL(`${outputDirectory}/`) : undefined;
  if (destination) {
    await mkdir(destination, { recursive: true });
  }
  const selected = new Set();
  for (const selection of chosen) {
    const identity = `${selection.method.toUpperCase()} ${selection.path}`;
    if (selected.has(identity)) {
      throw Error(`Duplicate selection: ${identity}`);
    }
    selected.add(identity);
    let extracted;
    try {
      extracted = extract(document, selection);
    } catch (error) {
      exclusions.push({ method: selection.method, path: selection.path, reason: error.message });
      continue;
    }
    const json = JSON.stringify(extracted.document);
    const digest = sha256(json);
    const gzip = gzipSync(json);
    const filename = `${digest}.json.gz`;
    if (destination) {
      await writeFile(new URL(filename, destination), gzip, { flag: 'wx' }).catch((error) => {
        if (error.code !== 'EEXIST') {
          throw error;
        }
        throw Error(`Artifact already exists; choose an empty output directory: ${filename}`);
      });
    }
    artifacts.push({
      ...extracted.metadata,
      sha256: digest,
      file: filename,
      bytes: Buffer.byteLength(json),
      gzipBytes: gzip.length,
    });
  }
  const report = {
    formatVersion: 1,
    source: {
      kind: 'cloudflare-openapi',
      revision,
      sha256: sha256(raw),
      bytes: raw.length,
      openapi: document.openapi,
    },
    coverage: {
      paths: Object.keys(document.paths).length,
      operations: allOperations.length,
      schemas: Object.keys(document.components?.schemas ?? {}).length,
      selected: chosen.length,
      extracted: artifacts.length,
      excluded: exclusions.length,
      totalBytes: artifacts.reduce((sum, entry) => sum + entry.bytes, 0),
      totalGzipBytes: artifacts.reduce((sum, entry) => sum + entry.gzipBytes, 0),
      maxBytes: Math.max(0, ...artifacts.map((entry) => entry.bytes)),
      maxGzipBytes: Math.max(0, ...artifacts.map((entry) => entry.gzipBytes)),
    },
    operations: artifacts,
    exclusions,
  };
  if (destination) {
    await writeFile(new URL('index.json', destination), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
    });
  }
  return report;
}

export async function writeCloudflareSnapshot(report, destination) {
  const entries = report.operations.map(
    ({ operationId, method, path, sha256, bytes, gzipBytes, summary, tags, deprecated }) => ({
      operationId,
      method,
      path,
      sha256,
      bytes,
      gzipBytes,
      summary,
      tags,
      deprecated,
    }),
  );
  const index = JSON.stringify(entries);
  const gzip = gzipSync(index);
  const source = { revision: report.source.revision, sha256: report.source.sha256 };
  const text = [
    '// Decision: Only the pinned index is bundled; complete operation documents are loaded individually from artifact storage.',
    'export const cloudflareOpenApiSource = ' + JSON.stringify(source, null, 2) + ' as const;',
    'export const cloudflareOpenApiCoverage = ' +
      JSON.stringify(
        {
          operations: report.coverage.operations,
          extracted: report.coverage.extracted,
          exclusions: report.exclusions,
        },
        null,
        2,
      ) +
      ' as const;',
    'export const cloudflareOpenApiIndexSha256 = ' + JSON.stringify(sha256(index)) + ';',
    'export const cloudflareOpenApiIndexGzip = ' + JSON.stringify(gzip.toString('base64')) + ';',
    '',
  ].join('\n');
  await writeFile(destination, text);
  return {
    entries: entries.length,
    bytes: Buffer.byteLength(index),
    gzipBytes: gzip.length,
    sourceBytes: Buffer.byteLength(text),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [sourcePath, revision, outputDirectory, selectionsPath, snapshotPath] =
    process.argv.slice(2);
  if (!sourcePath || !revision) {
    throw Error(
      'Usage: node scripts/cloudflare-openapi.mjs <openapi.json> <git revision> [output directory] [selections.json or -] [snapshot.ts]',
    );
  }
  const selections =
    selectionsPath && selectionsPath !== '-'
      ? JSON.parse(await readFile(selectionsPath, 'utf8'))
      : undefined;
  const report = await buildCloudflareCatalog({
    sourcePath,
    revision,
    outputDirectory,
    selections,
  });
  const snapshot = snapshotPath ? await writeCloudflareSnapshot(report, snapshotPath) : undefined;
  process.stdout.write(
    `${JSON.stringify({ source: report.source, coverage: report.coverage, exclusions: report.exclusions, snapshot }, null, 2)}\n`,
  );
  if (report.exclusions.length) {
    process.exitCode = 1;
  }
}
