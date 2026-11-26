/// <reference types="node" />
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  buildCloudflareCatalog,
  extractCloudflareOperation,
  indexCloudflareOperations,
  writeCloudflareSnapshot,
} from './cloudflare-openapi.mjs';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const fixture = () => ({
  openapi: '3.0.3',
  info: { title: 'Fixture', version: '1' },
  servers: [{ url: 'https://example.test' }],
  security: [{ token: [] }],
  paths: {
    '/things/{id}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
      ],
      get: {
        operationId: 'getThing',
        summary: 'Get a thing',
        tags: ['Things'],
        deprecated: true,
        responses: {
          200: { description: 'Thing', content: { 'application/json': { schema: ref('Thing') } } },
        },
      },
      post: {
        operationId: 'createThing',
        requestBody: { required: true, content: { 'application/json': { schema: ref('Thing') } } },
        responses: { 201: { description: 'Created' } },
      },
    },
  },
  components: {
    securitySchemes: { token: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Thing: {
        allOf: [ref('Name')],
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          child: { nullable: true, allOf: [ref('Thing')] },
          kind: { oneOf: [ref('Name'), { type: 'integer', minimum: 0, maximum: 10 }] },
        },
      },
      Name: { type: 'string', pattern: '^[a-z]+$', minLength: 1, maxLength: 10 },
      Unrelated: { type: 'boolean' },
    },
  },
  'x-forge-commands': { unrelated: 'not needed' },
});
const selection = { method: 'GET', path: '/things/{id}' };

test('retains complete constraints, path inputs, security and cyclic reference closure without expansion', () => {
  const original = fixture();
  const extracted = extractCloudflareOperation(original, selection);
  assert.deepEqual(extracted.document.components.schemas, {
    Thing: original.components.schemas.Thing,
    Name: original.components.schemas.Name,
  });
  assert.deepEqual(
    extracted.document.paths[selection.path].parameters,
    original.paths[selection.path].parameters,
  );
  assert.deepEqual(extracted.document.security, original.security);
  assert.deepEqual(
    extracted.document.components.securitySchemes,
    original.components.securitySchemes,
  );
  assert.equal(extracted.document.paths[selection.path].post, undefined);
  assert.equal(extracted.document['x-forge-commands'], undefined);
  assert.equal(extracted.metadata.execution, 'discovery-only');
  assert.equal(extracted.metadata.summary, 'Get a thing');
  assert.deepEqual(extracted.metadata.tags, ['Things']);
  assert.equal(extracted.metadata.deprecated, true);
  extracted.document.components.schemas.Name.type = 'number';
  assert.equal(original.components.schemas.Name.type, 'string');
});

test('retains required bodies and response media rather than generating summary fields', () => {
  const original = fixture();
  const extracted = extractCloudflareOperation(original, { ...selection, method: 'POST' });
  assert.deepEqual(
    extracted.document.paths[selection.path].post,
    original.paths[selection.path].post,
  );
});

test('follows references in properties whose names match metadata keywords', () => {
  const original = fixture();
  for (const name of ['example', 'default', 'enum', 'value', 'x-key']) {
    original.components.schemas.Thing.properties[name] = ref(name);
    original.components.schemas[name] = { type: 'string' };
  }
  const extracted = extractCloudflareOperation(original, selection);
  for (const name of ['example', 'default', 'enum', 'value', 'x-key']) {
    assert.deepEqual(extracted.document.components.schemas[name], { type: 'string' });
  }
});

test('keeps example and default payloads verbatim without treating data as schema references', () => {
  const original = fixture();
  original.components.schemas.Thing.example = { $ref: 'https://example.test/data' };
  original.components.schemas.Thing.default = { $ref: 'not a schema' };
  original.paths[selection.path].get.responses[200].content['application/json'].examples = {
    payload: { $ref: '#/components/examples/payload' },
  };
  original.components.examples = { payload: { value: { $ref: 'https://example.test/data' } } };
  const extracted = extractCloudflareOperation(original, selection);
  assert.deepEqual(extracted.document.components.examples, original.components.examples);
  assert.deepEqual(
    extracted.document.components.schemas.Thing.example,
    original.components.schemas.Thing.example,
  );
});

test('retains discriminator mapping closure and escaped component names', () => {
  const original = fixture();
  original.components.schemas.Thing.discriminator = {
    propertyName: 'type',
    mapping: { named: 'Other', escaped: '#/components/schemas/a~1b~0c' },
  };
  original.components.schemas.Other = { type: 'string' };
  original.components.schemas['a/b~c'] = { type: 'boolean' };
  const extracted = extractCloudflareOperation(original, selection);
  assert.deepEqual(extracted.document.components.schemas.Other, { type: 'string' });
  assert.deepEqual(extracted.document.components.schemas['a/b~c'], { type: 'boolean' });
});

test('keeps operation security overrides and rejects undefined schemes', () => {
  const original = fixture();
  original.paths[selection.path].get.security = [];
  assert.deepEqual(
    extractCloudflareOperation(original, selection).document.paths[selection.path].get.security,
    [],
  );
  original.paths[selection.path].get.security = [{ undefined_scheme: [] }];
  assert.throws(
    () => extractCloudflareOperation(original, selection),
    /Missing reference.*undefined_scheme/,
  );
});

for (const reference of [
  '#/components/schemas/missing',
  '#/components/schemas/Thing/properties/missing',
  'https://example.test/schema.json',
  '#/paths/other',
]) {
  test(`rejects unresolved or unsupported reference ${reference}`, () => {
    const original = fixture();
    original.components.schemas.Thing.properties.bad = { $ref: reference };
    assert.throws(() => extractCloudflareOperation(original, selection), /reference/);
  });
}

test('rejects duplicate operation IDs, missing selections and oversized operation artifacts', () => {
  const original = fixture();
  original.paths[selection.path].post.operationId = 'getThing';
  assert.throws(() => indexCloudflareOperations(original), /Duplicate operationId/);
  assert.throws(
    () => extractCloudflareOperation(fixture(), { method: 'DELETE', path: '/unknown' }),
    /Unknown operation/,
  );
  original.paths[selection.path].post.operationId = 'createThing';
  original.components.schemas.Thing.description = 'x'.repeat(1024 * 1024);
  assert.throws(() => extractCloudflareOperation(original, selection), /1 MiB/);
});

test('writes digest-named gzip artifacts with exact source provenance and reports incomplete operations', async () => {
  const directory = await mkdtemp(new URL('openapi-compiler-', pathToFileURL(`${tmpdir()}/`)));
  try {
    const original = fixture();
    original.paths[selection.path].get.operationId = '../../outside';
    original.paths[selection.path].post.security = [{ missing: [] }];
    const raw = JSON.stringify(original);
    const sourcePath = new URL('source.json', pathToFileURL(`${directory}/`));
    const outputDirectory = `${directory}/artifacts`;
    await writeFile(sourcePath, raw);
    const report = await buildCloudflareCatalog({
      sourcePath,
      outputDirectory,
      revision: 'a'.repeat(40),
    });
    const snapshotPath = new URL('snapshot.ts', pathToFileURL(`${directory}/`));
    const snapshot = await writeCloudflareSnapshot(report, snapshotPath);
    const snapshotText = await readFile(snapshotPath, 'utf8');
    const encoded = JSON.parse(snapshotText.match(/cloudflareOpenApiIndexGzip = (.*);/)[1]);
    const pinned = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')));
    assert.equal(snapshot.entries, 1);
    assert.deepEqual(Object.keys(pinned[0]), [
      'operationId',
      'method',
      'path',
      'sha256',
      'bytes',
      'gzipBytes',
    ]);
    assert.equal(pinned[0].sha256, report.operations[0].sha256);
    assert.equal(report.coverage.operations, 2);
    assert.equal(report.coverage.extracted, 1);
    assert.equal(report.coverage.excluded, 1);
    assert.match(report.exclusions[0].reason, /Missing reference/);
    assert.equal(report.source.bytes, Buffer.byteLength(raw));
    assert.match(report.source.sha256, /^[a-f0-9]{64}$/);
    assert.match(report.operations[0].file, /^[a-f0-9]{64}\.json\.gz$/);
    assert.equal((await readdir(outputDirectory)).length, 2);
    const gzip = await readFile(
      new URL(report.operations[0].file, pathToFileURL(`${outputDirectory}/`)),
    );
    assert.equal(gzip.length, report.operations[0].gzipBytes);
    const json = gunzipSync(gzip);
    assert.equal(json.length, report.operations[0].bytes);
    assert.equal(JSON.parse(json).paths[selection.path].get.operationId, '../../outside');
    await assert.rejects(
      buildCloudflareCatalog({ sourcePath, outputDirectory, revision: 'a'.repeat(40) }),
      /Artifact already exists/,
    );
    await assert.rejects(buildCloudflareCatalog({ sourcePath, revision: '../wrong' }), /revision/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
