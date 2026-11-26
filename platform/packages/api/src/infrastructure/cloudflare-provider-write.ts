import { isRecord } from '@builtbyfriends/deploy-core';
import { Validator, type Schema } from '@cfworker/json-schema';
import type { Resource } from '../types.ts';
import {
  boundedJson,
  corsFields,
  prepareCloudflareProviderRead,
  projectionLimits,
  resolve,
  structuredProjection,
  validationSchema,
  type CloudflareReadArtifact,
} from './cloudflare-provider-read.ts';

const policies = [
  {
    type: 'r2',
    method: 'PUT',
    path: '/accounts/{account_id}/r2/buckets/{bucket_name}/cors',
    parameter: 'bucket_name',
    operationId: 'r2-put-bucket-cors-policy',
    readOperationId: 'r2-get-bucket-cors-policy',
    fields: corsFields,
    required: ['rules'],
  },
] as const;

export function cloudflareProviderWriteSelections(resourceType: Resource['type']) {
  return policies.filter((policy) => policy.type === resourceType);
}

function record(value: unknown) {
  if (!isRecord(value)) {
    throw Error('Invalid provider configuration.');
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function prepareCloudflareProviderWrite(
  artifact: CloudflareReadArtifact,
  readArtifact: CloudflareReadArtifact,
  resourceType: Resource['type'],
) {
  const policy = policies.find(
    (entry) =>
      entry.type === resourceType &&
      entry.path === artifact.path &&
      entry.method === artifact.method &&
      entry.operationId === artifact.operationId,
  );
  if (!policy) {
    return null;
  }
  const reader = prepareCloudflareProviderRead(readArtifact, resourceType, {
    requireCompleteProjection: true,
  });
  if (
    !reader ||
    readArtifact.operationId !== policy.readOperationId ||
    readArtifact.path !== policy.path
  ) {
    throw Error('The configuration read no longer matches its write policy.');
  }
  const document = record(artifact.document);
  if (document.openapi !== '3.0.3') {
    throw Error('Unsupported provider schema version.');
  }
  const item = record(record(document.paths)[policy.path]);
  const operation = record(item[policy.method.toLowerCase()]);
  if (operation.operationId !== policy.operationId) {
    throw Error('The provider operation no longer matches its write policy.');
  }
  const parameters = [
    ...(Array.isArray(item.parameters) ? item.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ].map((value) => resolve(document, value));
  if (
    parameters.some(
      (entry) =>
        !(
          (entry.in === 'path' && ['account_id', policy.parameter].includes(String(entry.name))) ||
          (entry.in === 'header' && entry.name === 'cf-r2-jurisdiction')
        ),
    )
  ) {
    throw Error('Unowned provider configuration parameter.');
  }
  const parameterSchema = (location: string) =>
    validationSchema(
      {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(
          parameters
            .filter((entry) => entry.in === location)
            .map((entry) => [String(entry.name), entry.schema]),
        ),
        required: parameters
          .filter((entry) => entry.in === location && entry.required === true)
          .map((entry) => String(entry.name)),
      },
      document,
      'input',
    );
  const paths = new Validator(parameterSchema('path'), '7');
  const headers = new Validator(parameterSchema('header'), '7');
  const body = resolve(document, operation.requestBody);
  const content = record(body.content);
  if (Object.keys(content).length !== 1 || !content['application/json']) {
    throw Error('Only reviewed JSON configuration bodies are supported.');
  }
  const source = record(record(content['application/json']).schema);
  const projection = structuredProjection(source, policy.fields, document, 0, [], 'input');
  const configuration: Schema = {
    ...projection.schema,
    allOf: [validationSchema(source, document, 'input')],
  };
  const inputSchema: Schema = {
    type: 'object',
    additionalProperties: false,
    required: ['body', 'expected'],
    properties: {
      body: {
        ...configuration,
        required: [...new Set([...(projection.schema.required ?? []), ...policy.required])],
      },
      expected: {
        ...projection.schema,
        description:
          'The configuration captured when this edit was opened. Omitted fields stay omitted.',
      },
    },
    components: validationSchema({}, document, 'input').components,
  };
  const inputValidator = new Validator(inputSchema, '7');
  const response = resolve(document, record(operation.responses)['200']);
  const responseValidator = new Validator(
    validationSchema(
      record(record(response.content)['application/json']).schema,
      document,
      'output',
    ),
    '7',
  );
  const observedSchema = reader.outputSchema.properties?.data;
  if (!observedSchema) {
    throw Error('The configuration read has no data schema.');
  }
  const outputSchema: Schema = {
    type: 'object',
    additionalProperties: false,
    required: ['appId', 'resourceId', 'action', 'kind'],
    properties: {
      appId: { type: 'string' },
      resourceId: { type: 'string' },
      action: { const: policy.operationId },
      kind: { enum: ['provider-write', 'conflict', 'unavailable', 'unknown'] },
      data: observedSchema,
      reason: { type: 'string' },
    },
    oneOf: [
      {
        properties: { kind: { const: 'provider-write' } },
        required: ['data'],
        not: { required: ['reason'] },
      },
      {
        properties: { kind: { enum: ['conflict', 'unavailable', 'unknown'] } },
        required: ['reason'],
        not: { required: ['data'] },
      },
    ],
    components: reader.outputSchema.components,
  };
  const descriptor = {
    id: policy.operationId,
    effect: 'write' as const,
    title:
      typeof operation.summary === 'string'
        ? operation.summary.slice(0, 200)
        : 'Update configuration',
    description:
      'Replace the reviewed configuration. Checks for changes before sending; concurrent external edits can still overwrite one another. Read the result before retrying an unconfirmed change.',
    inputSchema,
    outputSchema,
  };
  return {
    ...descriptor,
    async describe() {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            document,
            read: await reader.describe(),
            policy,
            projectionLimits,
            descriptor,
          }),
        ),
      );
      return {
        ...descriptor,
        version: Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
      };
    },
    async write(...[bindings, caller, input, fetcher = fetch]: Parameters<typeof reader.read>) {
      const identity = {
        appId: caller.project.id,
        resourceId: caller.resource.id,
        action: policy.operationId,
      };
      const outcome = (kind: 'conflict' | 'unknown' | 'unavailable', reason: string) => ({
        ...identity,
        kind,
        reason,
      });
      const uncertain = () =>
        outcome(
          'unknown',
          'The change could not be confirmed. Refresh the configuration before trying again.',
        );
      if (!inputValidator.validate(input).valid) {
        return outcome('unavailable', 'Check the configuration fields.');
      }
      const selected = record(input);
      try {
        projection.project(selected.body, { values: 0 });
        projection.project(selected.expected, { values: 0 });
        if (new TextEncoder().encode(JSON.stringify(input)).length > projectionLimits.bytes) {
          throw Error('Configuration exceeds its byte limit.');
        }
      } catch {
        return outcome('unavailable', 'This configuration exceeds the supported size.');
      }
      const resource = caller.resource;
      const scope = { account_id: bindings.CF_ACCOUNT_ID, [policy.parameter]: resource.cf_id };
      const jurisdiction = { 'cf-r2-jurisdiction': resource.metadata.jurisdiction ?? 'default' };
      if (!paths.validate(scope).valid || !headers.validate(jurisdiction).valid) {
        return outcome('unavailable', 'This provider resource is not connected.');
      }
      try {
        const current = await reader.read(bindings, caller, {}, fetcher);
        const opened = projection.project(current.data, { values: 0 });
        if (canonical(opened) !== canonical(selected.expected)) {
          return outcome(
            'conflict',
            'The configuration changed since it was opened. Refresh before applying this change.',
          );
        }
        if (!(await caller.stillAuthorized())) {
          return outcome('unavailable', 'This resource changed. Refresh before continuing.');
        }
      } catch {
        return outcome(
          'unavailable',
          'Could not check the current configuration. No change was sent.',
        );
      }
      const url = new URL(
        `https://api.cloudflare.com/client/v4${policy.path.replace('{account_id}', encodeURIComponent(bindings.CF_ACCOUNT_ID)).replace(`{${policy.parameter}}`, encodeURIComponent(resource.cf_id))}`,
      );
      try {
        const response = await fetcher(url, {
          method: policy.method,
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
          headers: {
            Authorization: `Bearer ${bindings.CF_API_TOKEN}`,
            Accept: 'application/json',
            'content-type': 'application/json',
            'cf-r2-jurisdiction': String(jurisdiction['cf-r2-jurisdiction']),
          },
          body: JSON.stringify(selected.body),
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          return response.status >= 400 && response.status < 500 && response.status !== 408
            ? outcome(
                'unavailable',
                'The provider rejected this configuration. Refresh before trying again.',
              )
            : uncertain();
        }
        if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
          await response.body?.cancel();
          return uncertain();
        }
        if (!responseValidator.validate(await boundedJson(response)).valid) {
          return uncertain();
        }
        const observed = await reader.read(bindings, caller, {}, fetcher);
        if (
          canonical(projection.project(observed.data, { values: 0 })) !== canonical(selected.body)
        ) {
          return uncertain();
        }
        return { ...identity, kind: 'provider-write' as const, data: observed.data };
      } catch {
        return uncertain();
      }
    },
  };
}
