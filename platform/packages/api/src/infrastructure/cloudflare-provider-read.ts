import { isRecord } from '@builtbyfriends/deploy-core';
import { Validator, type Schema } from '@cfworker/json-schema';
import type { ApiEnv } from '../env.ts';
import type { Resource } from '../types.ts';
import type { ResourceCaller } from './resource-operations.ts';

export type CloudflareReadArtifact = {
  operationId: string;
  method: string;
  path: string;
  document: unknown;
};

export type ReadFields = true | { fields: { [key: string]: ReadFields } } | { items: ReadFields };
type ReadValue = string | number | boolean | null | Array<ReadValue> | { [key: string]: ReadValue };
export const projectionLimits = {
  depth: 8,
  items: 200,
  values: 4096,
  string: 16384,
  bytes: 128 * 1024,
};

export const corsFields: Exclude<ReadFields, true> = {
  fields: {
    rules: {
      items: {
        fields: {
          id: true,
          allowed: {
            fields: {
              headers: { items: true },
              methods: { items: true },
              origins: { items: true },
            },
          },
          exposeHeaders: { items: true },
          maxAgeSeconds: true,
        },
      },
    },
  },
};

const policies: Array<{
  type: Resource['type'];
  path: string;
  parameter: string;
  identity: string;
  identitySource?: 'resolved';
  identityPattern?: string;
  responseOwnership?: 'selected-resource';
  parameterAlternative?: number;
  fields: Array<string>;
  structured?: { fields: { [key: string]: ReadFields } };
  collection?: {
    defaultLimit: number;
    maxItems: number;
    recordIdentity: Schema;
    identityMaxBytes?: number;
    query?: { [name: string]: { schema: Schema; maxBytes: number } };
  };
}> = [
  {
    type: 'durable-object',
    path: '/accounts/{account_id}/workers/durable_objects/namespaces/{id}/objects',
    parameter: 'id',
    identity: 'id',
    identitySource: 'resolved',
    identityPattern: '^[a-fA-F0-9]{32}$',
    fields: ['id', 'hasStoredData'],
    collection: {
      defaultLimit: 50,
      maxItems: 200,
      recordIdentity: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
    },
  },
  {
    type: 'd1',
    path: '/accounts/{account_id}/d1/database/{database_id}',
    parameter: 'database_id',
    identity: 'uuid',
    // Decision: The provider's UUID/name oneOf overlaps for UUID strings. Owned resources use the UUID branch, not caller-selected names.
    parameterAlternative: 0,
    fields: [
      'created_at',
      'file_size',
      'num_tables',
      'jurisdiction',
      'version',
      'read_replication/mode',
    ],
  },
  {
    type: 'r2',
    path: '/accounts/{account_id}/r2/buckets/{bucket_name}',
    parameter: 'bucket_name',
    identity: 'name',
    fields: ['creation_date', 'jurisdiction', 'location', 'storage_class'],
  },
  {
    type: 'r2',
    path: '/accounts/{account_id}/r2/buckets/{bucket_name}/domains/managed',
    parameter: 'bucket_name',
    identity: 'bucketId',
    // Decision: The response uses an internal bucket ID, not the owned bucket name. The exact injected URL and selected-resource checks before/after the read prove scope.
    responseOwnership: 'selected-resource',
    fields: ['domain', 'enabled'],
  },
  {
    type: 'r2',
    path: '/accounts/{account_id}/r2/buckets/{bucket_name}/cors',
    parameter: 'bucket_name',
    identity: 'name',
    // Decision: Configuration responses omit bucket identity; the exact injected bucket path and fresh selected-resource checks prove ownership.
    responseOwnership: 'selected-resource',
    fields: [],
    structured: corsFields,
  },
  {
    type: 'kv',
    path: '/accounts/{account_id}/storage/kv/namespaces/{namespace_id}',
    parameter: 'namespace_id',
    identity: 'id',
    fields: ['jurisdiction', 'mode', 'supports_url_encoding'],
  },
  {
    type: 'kv',
    path: '/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/keys',
    parameter: 'namespace_id',
    identity: 'name',
    identityPattern: '^[a-fA-F0-9]{32}$',
    fields: ['name', 'expiration'],
    collection: {
      defaultLimit: 50,
      maxItems: 200,
      recordIdentity: { type: 'string', minLength: 1, maxLength: 512 },
      identityMaxBytes: 512,
      query: {
        prefix: {
          schema: {
            type: 'string',
            maxLength: 512,
            pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]*$',
          },
          maxBytes: 512,
        },
      },
    },
  },
  {
    type: 'hyperdrive',
    path: '/accounts/{account_id}/hyperdrive/configs/{hyperdrive_id}',
    parameter: 'hyperdrive_id',
    identity: 'id',
    // Decision: Origin, integration and certificate identities contain connection details; expose operational settings without these provider identities or credentials.
    fields: [
      'created_on',
      'modified_on',
      'restarted_on',
      'origin_connection_limit',
      'caching/disabled',
      'caching/max_age',
      'caching/stale_while_revalidate',
      'mtls/sslmode',
    ],
  },
  {
    type: 'queue',
    path: '/accounts/{account_id}/queues/{queue_id}',
    parameter: 'queue_id',
    identity: 'queue_id',
    // Decision: Queue consumers/producers can contain other resource identities and credentials; only audited scalar metadata leaves this adapter.
    fields: [
      'created_on',
      'modified_on',
      'jurisdiction',
      'consumers_total_count',
      'producers_total_count',
      'settings/delivery_delay',
      'settings/delivery_paused',
      'settings/message_retention_period',
    ],
  },
];

function record(value: unknown) {
  if (!isRecord(value)) {
    throw Error('Invalid provider operation schema.');
  }
  return value;
}

export function resolve(document: CloudflareReadArtifact['document'], value: unknown) {
  let current = record(value);
  const seen = new Set<string>();
  while (typeof current.$ref === 'string') {
    const reference = current.$ref;
    if (!reference.startsWith('#/components/') || seen.has(reference)) {
      throw Error('Unsupported provider schema reference.');
    }
    seen.add(reference);
    let target = document;
    for (const key of decodeURIComponent(reference.slice(2)).split('/')) {
      const name = key.replace(/~1/g, '/').replace(/~0/g, '~');
      const parent = record(target);
      if (!Object.hasOwn(parent, name)) {
        throw Error('Missing provider schema reference.');
      }
      target = parent[name];
    }
    current = record(target);
  }
  return current;
}

function normalize(
  value: unknown,
  document: unknown,
  direction: 'input' | 'output',
  depth = 0,
): Schema {
  if (typeof value === 'boolean') {
    return value ? {} : { not: {} };
  }
  if (depth > 64) {
    throw Error('Provider schema is too deeply nested.');
  }
  const original = record(value);
  const annotations = resolve(document, original);
  // Decision: Read-only annotations also occur on required URL identities. They constrain request bodies, not the parameters accepted by these GET operations.
  if (direction === 'output' && annotations.writeOnly === true) {
    return { not: {} };
  }
  const schema: Schema = { ...original };
  if (schema.$ref && !schema.$ref.startsWith('#/components/schemas/')) {
    throw Error('Unsupported provider schema reference.');
  }
  delete schema.nullable;
  if (original.nullable === true && typeof schema.type === 'string') {
    schema.type = [schema.type, 'null'];
    if (schema.enum && !schema.enum.includes(null)) {
      schema.enum = [...schema.enum, null];
    }
  }
  for (const key of ['exclusiveMinimum', 'exclusiveMaximum'] as const) {
    const bound = key === 'exclusiveMinimum' ? 'minimum' : 'maximum';
    if (schema[key] === true) {
      if (typeof schema[bound] !== 'number') {
        throw Error('Invalid exclusive provider schema bound.');
      }
      schema[key] = schema[bound];
      delete schema[bound];
    } else if (schema[key] === false) {
      delete schema[key];
    }
  }
  if (original.properties !== undefined) {
    const properties = record(original.properties);
    schema.properties = Object.fromEntries(
      Object.entries(properties).map(([name, child]) => [
        name,
        normalize(child, document, direction, depth + 1),
      ]),
    );
  }
  if (schema.required && direction === 'output') {
    schema.required = schema.required.filter(
      (name) => !writeOnlyProperty(original, name, document),
    );
  }
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (original[key] !== undefined) {
      if (!Array.isArray(original[key])) {
        throw Error('Invalid provider schema alternatives.');
      }
      schema[key] = original[key].map((child) => normalize(child, document, direction, depth + 1));
    }
  }
  for (const key of ['items', 'additionalProperties', 'not'] as const) {
    if (original[key] !== undefined) {
      schema[key] = normalize(original[key], document, direction, depth + 1);
    }
  }
  return schema;
}

function writeOnlyProperty(
  value: unknown,
  name: string,
  document: unknown,
  seen = new Set<unknown>(),
  depth = 0,
): boolean {
  if (depth > 64) {
    throw Error('Provider schema is too deeply nested.');
  }
  const schema = resolve(document, value);
  if (seen.has(schema)) {
    return false;
  }
  seen.add(schema);
  if (isRecord(schema.properties) && Object.hasOwn(schema.properties, name)) {
    if (resolve(document, schema.properties[name]).writeOnly === true) {
      return true;
    }
  }
  return (
    Array.isArray(schema.allOf) &&
    schema.allOf.some((branch) => writeOnlyProperty(branch, name, document, seen, depth + 1))
  );
}

export function validationSchema(
  schema: unknown,
  document: unknown,
  direction: 'input' | 'output',
): Schema {
  const components = record(record(document).components);
  const schemas = record(components.schemas ?? {});
  return {
    ...normalize(schema, document, direction),
    components: {
      schemas: Object.fromEntries(
        Object.entries(schemas).map(([key, value]) => [key, normalize(value, document, direction)]),
      ),
    },
  };
}

function scalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function fieldSchema(value: unknown, path: Array<string>, document: unknown): Schema | undefined {
  const schema = resolve(document, value);
  if (path.length === 0) {
    return normalize(schema, document, 'output');
  }
  if (path[0] === '*' && schema.type === 'array') {
    return fieldSchema(schema.items, path.slice(1), document);
  }
  const properties = schema.properties;
  if (isRecord(properties) && Object.hasOwn(properties, path[0])) {
    const child = fieldSchema(properties[path[0]], path.slice(1), document);
    if (child) {
      return child;
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const child = fieldSchema(branch, path, document);
      if (child) {
        return child;
      }
    }
  }
  return undefined;
}

export function structuredProjection(
  source: Schema,
  selection: ReadFields,
  document: unknown,
  depth = 0,
  path: Array<string> = ['result'],
  direction: 'input' | 'output' = 'output',
): { schema: Schema; project: (value: unknown, budget: { values: number }) => ReadValue } {
  if (depth > projectionLimits.depth) {
    throw Error('The provider projection is too deeply nested.');
  }
  const selectedSchema = fieldSchema(source, path, document);
  if (!selectedSchema) {
    throw Error('The provider projection no longer matches its schema.');
  }
  const resolved = resolve(document, selectedSchema);
  if (resolved.writeOnly === true || (direction === 'input' && resolved.readOnly === true)) {
    throw Error('The provider projection includes a private field.');
  }
  const count = (budget: { values: number }) => {
    if (++budget.values > projectionLimits.values) {
      throw Error('The provider response contains too many values.');
    }
  };
  if (selection === true) {
    if (!['string', 'number', 'integer', 'boolean'].includes(String(resolved.type))) {
      throw Error('The provider projection requires an explicit scalar field.');
    }
    return {
      schema: {
        allOf: [normalize(resolved, document, direction), { maxLength: projectionLimits.string }],
      },
      project(value, budget) {
        count(budget);
        if (
          !scalar(value) ||
          (typeof value === 'string' && value.length > projectionLimits.string)
        ) {
          throw Error('The provider response contains an invalid scalar.');
        }
        return value;
      },
    };
  }
  if ('items' in selection) {
    if (resolved.type !== 'array') {
      throw Error('The provider projection requires an array.');
    }
    const item = structuredProjection(
      source,
      selection.items,
      document,
      depth + 1,
      [...path, '*'],
      direction,
    );
    return {
      schema: { type: 'array', maxItems: projectionLimits.items, items: item.schema },
      project(value, budget) {
        count(budget);
        if (!Array.isArray(value) || value.length > projectionLimits.items) {
          throw Error('The provider response contains an invalid array.');
        }
        return value.map((entry) => item.project(entry, budget));
      },
    };
  }
  const children = Object.entries(selection.fields).map(([name, fields]) => {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) {
      throw Error('The provider projection contains an unsafe property.');
    }
    return [
      name,
      structuredProjection(source, fields, document, depth + 1, [...path, name], direction),
    ] as const;
  });
  const required = Array.isArray(resolved.required)
    ? resolved.required.filter((name) => children.some(([key]) => key === name))
    : [];
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(children.map(([name, child]) => [name, child.schema])),
      required,
    },
    project(value, budget) {
      count(budget);
      const input = record(value);
      return Object.fromEntries(
        children
          .filter(([name]) => Object.hasOwn(input, name))
          .map(([name, child]) => [name, child.project(input[name], budget)]),
      );
    },
  };
}

export async function boundedJson(response: Response) {
  const limit = 256 * 1024;
  if (!response.body) {
    throw Error('The provider returned no data.');
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read().catch(() => {
        throw Error('The provider response could not be read.');
      });
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > limit) {
        throw Error('The provider response is too large.');
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const output: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return output;
  } catch {
    throw Error('The provider returned invalid JSON.');
  }
}

export function cloudflareProviderReadSelections(resourceType: Resource['type']) {
  return policies
    .filter((entry) => entry.type === resourceType)
    .map((policy) => ({ method: 'GET' as const, path: policy.path }));
}

export function prepareCloudflareProviderRead(
  artifact: CloudflareReadArtifact,
  resourceType: Resource['type'],
  options?: { requireCompleteProjection: true },
) {
  const policy = policies.find(
    (entry) => entry.type === resourceType && entry.path === artifact.path,
  );
  if (!policy || artifact.method !== 'GET') {
    return null;
  }
  const document = record(artifact.document);
  if (document.openapi !== '3.0.3') {
    throw Error('Unsupported provider schema version.');
  }
  const item = record(record(document.paths)[artifact.path]);
  const operation = record(item.get);
  if (operation.operationId !== artifact.operationId || operation.requestBody) {
    throw Error('Provider operation schema does not match the selection.');
  }
  const parameters = new Map<string, ReturnType<typeof record>>();
  for (const list of [item.parameters ?? [], operation.parameters ?? []]) {
    if (!Array.isArray(list)) {
      throw Error('Invalid provider parameters.');
    }
    for (const value of list) {
      const parameter = { ...resolve(document, value) };
      if (
        typeof parameter.name !== 'string' ||
        !['path', 'query', 'header'].includes(String(parameter.in))
      ) {
        throw Error('Unsupported provider parameter.');
      }
      if (parameter.in === 'path' && !['account_id', policy.parameter].includes(parameter.name)) {
        throw Error('Unowned provider path parameter.');
      }
      if (parameter.in === 'header' && parameter.name !== 'cf-r2-jurisdiction') {
        throw Error('Unsupported provider request header.');
      }
      if (
        parameter.in === 'path' &&
        parameter.name === policy.parameter &&
        policy.parameterAlternative !== undefined
      ) {
        const alternatives = record(parameter.schema).oneOf;
        if (!Array.isArray(alternatives) || !alternatives[policy.parameterAlternative]) {
          throw Error('The provider identity policy no longer matches its schema.');
        }
        parameter.schema = alternatives[policy.parameterAlternative];
      }
      parameters.set(`${parameter.in}:${parameter.name}`, parameter);
    }
  }
  if (policy.collection) {
    const approved = new Set(['limit', 'cursor', ...Object.keys(policy.collection.query ?? {})]);
    if (
      [...parameters.values()].some(
        (parameter) => parameter.in === 'query' && !approved.has(String(parameter.name)),
      )
    ) {
      throw Error('The provider collection contains an unapproved query parameter.');
    }
    for (const [name, bound] of Object.entries(policy.collection.query ?? {})) {
      const parameter = parameters.get(`query:${name}`);
      if (!parameter) {
        throw Error('The provider collection query no longer matches its schema.');
      }
      parameter.schema = { allOf: [parameter.schema, bound.schema] };
    }
    const limit = parameters.get('query:limit');
    const cursor = parameters.get('query:cursor');
    if (!limit || !cursor) {
      throw Error('The provider pagination policy no longer matches its schema.');
    }
    limit.schema = {
      allOf: [limit.schema, { type: 'integer', minimum: 10, maximum: policy.collection.maxItems }],
      default: policy.collection.defaultLimit,
    };
    cursor.schema = {
      allOf: [
        cursor.schema,
        {
          type: 'string',
          minLength: 1,
          maxLength: 2048,
          pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]*$',
        },
      ],
    };
  }
  const fields = (location: string): Schema => {
    const entries = [...parameters.values()].filter((entry) => entry.in === location);
    return {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        entries.map((entry) => [String(entry.name), record(entry.schema)]),
      ),
      required: entries
        .filter((entry) => entry.required === true)
        .map((entry) => String(entry.name)),
    };
  };
  const inputSchema = validationSchema(
    { type: 'object', additionalProperties: false, properties: { query: fields('query') } },
    document,
    'input',
  );
  const inputValidator = new Validator(inputSchema, '7');
  const pathValidator = new Validator(validationSchema(fields('path'), document, 'input'), '7');
  const headerValidator = new Validator(validationSchema(fields('header'), document, 'input'), '7');
  const response = resolve(document, record(operation.responses)['200']);
  const responseSchema = record(record(response.content)['application/json']).schema;
  const outputValidator = new Validator(validationSchema(responseSchema, document, 'output'), '7');
  const structured = policy.structured
    ? structuredProjection(record(responseSchema), policy.structured, document)
    : null;
  const completeProjection =
    options?.requireCompleteProjection && structured
      ? new Validator(
          { ...structured.schema, components: validationSchema({}, document, 'output').components },
          '7',
        )
      : null;
  if (options?.requireCompleteProjection && !completeProjection) {
    throw Error('The configuration requires a complete structured response.');
  }
  const properties: { [field: string]: Schema } = {};
  for (const field of policy.fields) {
    const schema = fieldSchema(
      responseSchema,
      ['result', ...(policy.collection ? ['*'] : []), ...field.split('/')],
      document,
    );
    if (!schema) {
      throw Error('The provider metadata policy no longer matches its schema.');
    }
    properties[field.replaceAll('/', '_')] = schema;
  }
  const dataSchema: Schema = policy.collection
    ? {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'records', 'pagination'],
        properties: {
          name: { type: 'string' },
          records: {
            type: 'array',
            maxItems: policy.collection.maxItems,
            items: {
              type: 'object',
              additionalProperties: false,
              required: [policy.identity],
              properties: {
                ...properties,
                [policy.identity]: {
                  allOf: [properties[policy.identity], policy.collection.recordIdentity],
                },
              },
            },
          },
          pagination: {
            type: 'object',
            additionalProperties: false,
            required: ['limit', 'count', 'nextCursor', 'hasMore'],
            properties: {
              limit: { type: 'integer', minimum: 10, maximum: policy.collection.maxItems },
              count: { type: 'integer', minimum: 0, maximum: policy.collection.maxItems },
              nextCursor: { type: ['string', 'null'], minLength: 1, maxLength: 2048 },
              hasMore: {
                type: ['boolean', 'null'],
                description:
                  'Null when the provider omitted its continuation cursor; completeness is unknown.',
              },
            },
          },
        },
      }
    : {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string' }, ...properties, ...structured?.schema.properties },
      };
  const outputSchema: Schema = {
    type: 'object',
    additionalProperties: false,
    required: ['appId', 'resourceId', 'action', 'kind', 'data'],
    properties: {
      appId: { type: 'string' },
      resourceId: { type: 'string' },
      action: { type: 'string', const: artifact.operationId },
      kind: { type: 'string', const: 'provider-read' },
      data: dataSchema,
    },
    ...(structured ? { components: validationSchema({}, document, 'output').components } : {}),
  };
  const safeOutputValidator = new Validator(outputSchema, '7');
  const descriptor = {
    id: artifact.operationId,
    effect: 'read' as const,
    title:
      typeof operation.summary === 'string' ? operation.summary.slice(0, 200) : 'Resource details',
    description:
      typeof operation.description === 'string'
        ? operation.description.slice(0, 2000)
        : 'Read metadata for this resource.',
    inputSchema,
    outputSchema,
  };
  const versionSource = JSON.stringify({
    adapterVersion: 1,
    document,
    policy,
    inputSchema,
    outputSchema,
    ...(structured ? { projectionVersion: 1, projectionLimits } : {}),
    ...(options ? { options } : {}),
  });

  return {
    id: artifact.operationId,
    effect: 'read' as const,
    inputSchema,
    outputSchema,
    async describe() {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(versionSource));
      const version = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      return { ...descriptor, version };
    },
    async read(
      bindings: Pick<ApiEnv['Bindings'], 'CF_ACCOUNT_ID' | 'CF_API_TOKEN'>,
      caller: Omit<ResourceCaller, 'project'> & { project: Pick<ResourceCaller['project'], 'id'> },
      input: unknown,
      fetcher: typeof fetch = fetch,
    ) {
      const { resource, project, stillAuthorized } = caller;
      const providerIdentity =
        policy.identitySource === 'resolved'
          ? await caller.resolveProviderIdentity?.()
          : resource.cf_id;
      if (
        resource.type !== policy.type ||
        resource.project_id !== project.id ||
        !bindings.CF_API_TOKEN ||
        !/^[a-f0-9]{32}$/i.test(bindings.CF_ACCOUNT_ID) ||
        !providerIdentity ||
        /[\\/?#\p{Cc}]/u.test(providerIdentity) ||
        ['.', '..'].includes(providerIdentity) ||
        (policy.identityPattern && !new RegExp(policy.identityPattern).test(providerIdentity))
      ) {
        throw Error('This provider resource is not connected.');
      }
      const selected = record(input);
      const query = selected.query === undefined ? {} : selected.query;
      if (!inputValidator.validate({ ...selected, query }).valid) {
        throw Error('Check the operation input fields.');
      }
      for (const [name, bound] of Object.entries(policy.collection?.query ?? {})) {
        const value = record(query)[name];
        if (typeof value === 'string' && new TextEncoder().encode(value).length > bound.maxBytes) {
          throw Error('Check the operation input fields.');
        }
      }
      const queryValues = record({
        ...(policy.collection ? { limit: policy.collection.defaultLimit } : {}),
        ...record(query),
      });
      const headers = parameters.has('header:cf-r2-jurisdiction')
        ? { 'cf-r2-jurisdiction': resource.metadata.jurisdiction ?? 'default' }
        : {};
      const path = { account_id: bindings.CF_ACCOUNT_ID, [policy.parameter]: providerIdentity };
      if (!pathValidator.validate(path).valid || !headerValidator.validate(headers).valid) {
        throw Error('The provider resource identity is invalid.');
      }
      const url = new URL(
        `https://api.cloudflare.com/client/v4${policy.path.replace('{account_id}', encodeURIComponent(bindings.CF_ACCOUNT_ID)).replace(`{${policy.parameter}}`, encodeURIComponent(providerIdentity))}`,
      );
      const requestHeaders = new Headers({
        Authorization: `Bearer ${bindings.CF_API_TOKEN}`,
        Accept: 'application/json',
      });
      for (const parameter of parameters.values()) {
        if (parameter.in === 'path') {
          continue;
        }
        const values = parameter.in === 'query' ? queryValues : record(headers);
        let value = values[String(parameter.name)];
        if (value === undefined) {
          continue;
        }
        if (parameter.name === 'fields' && Array.isArray(value)) {
          value = [...new Set([...value, policy.identity])];
        }
        if (Array.isArray(value) && parameter.in === 'query' && value.every(scalar)) {
          if (parameter.style !== undefined && parameter.style !== 'form') {
            throw Error('Unsupported provider query serialization.');
          }
          if (parameter.explode === false) {
            url.searchParams.set(String(parameter.name), value.join(','));
          } else {
            for (const item of value) {
              url.searchParams.append(String(parameter.name), String(item));
            }
          }
        } else if (scalar(value)) {
          if (parameter.in === 'query') {
            url.searchParams.set(String(parameter.name), String(value));
          } else {
            requestHeaders.set(String(parameter.name), String(value));
          }
        } else {
          throw Error('Unsupported provider parameter value.');
        }
      }
      if (!(await stillAuthorized())) {
        throw Error('This resource changed. Refresh before continuing.');
      }
      const result = await fetcher(url, {
        method: 'GET',
        headers: requestHeaders,
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      }).catch(() => {
        throw Error('The provider could not return this resource.');
      });
      if (
        result.status !== 200 ||
        !/^application\/json(?:;|$)/i.test(result.headers.get('content-type') ?? '')
      ) {
        await result.body?.cancel();
        throw Error('The provider could not return this resource.');
      }
      const envelope = await boundedJson(result);
      if (!outputValidator.validate(envelope).valid) {
        throw Error('The provider returned an unexpected resource response.');
      }
      const returned = record(envelope);
      if (completeProjection && !completeProjection.validate(returned.result).valid) {
        throw Error('The configuration contains fields that cannot be safely replaced.');
      }
      const resourceResult = policy.collection ? returned.result : record(returned.result);
      if (
        returned.success !== true ||
        (!policy.collection &&
          policy.responseOwnership !== 'selected-resource' &&
          record(resourceResult)[policy.identity] !== providerIdentity)
      ) {
        throw Error('The provider returned a different resource.');
      }
      if (
        !(await stillAuthorized()) ||
        (policy.identitySource === 'resolved' &&
          (await caller.resolveProviderIdentity?.()) !== providerIdentity)
      ) {
        throw Error('This resource changed. Refresh before continuing.');
      }
      const projectFields = (data: unknown) => {
        const values: { [field: string]: string | number | boolean | null } = {};
        for (const field of policy.fields) {
          let value: unknown = data;
          for (const key of field.split('/')) {
            value = isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
          }
          if (value !== undefined) {
            if (!scalar(value)) {
              throw Error('The provider metadata changed unexpectedly.');
            }
            values[field.replaceAll('/', '_')] = value;
          }
        }
        return values;
      };
      const collectionData = () => {
        const rows = returned.result;
        if (
          !Array.isArray(rows) ||
          typeof queryValues.limit !== 'number' ||
          rows.length > queryValues.limit
        ) {
          throw Error('The provider returned an invalid result page.');
        }
        const info = returned.result_info === undefined ? {} : record(returned.result_info);
        const cursor = info.cursor;
        if (
          (cursor !== undefined &&
            (typeof cursor !== 'string' || cursor.length > 2048 || /\p{Cc}/u.test(cursor))) ||
          (cursor && cursor === queryValues.cursor) ||
          (info.count !== undefined && info.count !== rows.length)
        ) {
          throw Error('The provider returned invalid pagination.');
        }
        const records = rows.map(projectFields);
        const identityMaxBytes = policy.collection?.identityMaxBytes;
        if (
          identityMaxBytes &&
          records.some((row) => {
            const identity = row[policy.identity];
            return (
              typeof identity !== 'string' ||
              new TextEncoder().encode(identity).length > identityMaxBytes
            );
          })
        ) {
          throw Error('The provider returned an invalid record identity.');
        }
        if (new Set(records.map((row) => row[policy.identity])).size !== records.length) {
          throw Error('The provider returned duplicate records.');
        }
        return {
          name: resource.binding_name,
          records,
          pagination: {
            limit: queryValues.limit,
            count: records.length,
            nextCursor: cursor || null,
            hasMore: cursor === undefined ? null : cursor !== '',
          },
        };
      };
      const output = {
        appId: project.id,
        resourceId: resource.id,
        action: artifact.operationId,
        kind: 'provider-read' as const,
        data: policy.collection
          ? collectionData()
          : {
              name: resource.binding_name,
              ...projectFields(returned.result),
              ...(structured ? record(structured.project(returned.result, { values: 0 })) : {}),
            },
      };
      if (
        (structured || policy.collection) &&
        new TextEncoder().encode(JSON.stringify(output)).length > projectionLimits.bytes
      ) {
        throw Error('The projected provider response is too large.');
      }
      if (!safeOutputValidator.validate(output).valid) {
        throw Error('The provider metadata changed unexpectedly.');
      }
      return output;
    },
  };
}
