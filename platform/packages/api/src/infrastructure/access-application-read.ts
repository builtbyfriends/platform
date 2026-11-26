import { isRecord } from '@builtbyfriends/deploy-core';
import { createProcedures, defineRegistry, BUILTIN_ERRORS } from '@builtbyfriends/realtime';
import { Validator, type Schema } from '@cfworker/json-schema';
import type { ApiEnv } from '../env.ts';
import type { RuntimeResourceReference } from '../routes/app-runtime-resource-reference.ts';
import type { Project } from '../types.ts';
import { cloudflareOpenApiIndex, cloudflareOperationSchema } from './cloudflare-openapi.ts';
import {
  boundedJson,
  fieldSchema,
  resolve,
  validationSchema,
  type CloudflareReadArtifact,
} from './cloudflare-provider-read.ts';
import { providerSchema } from './resource-operations.ts';

export type AccessApplicationCaller = {
  project: Pick<Project, 'id' | 'user_id'>;
  reference: Extract<RuntimeResourceReference, { source: 'project-access' }>;
  stillAuthorized: () => Promise<boolean>;
};
const path = '/accounts/{account_id}/access/apps/{app_id}';
const operationId = 'access-applications-get-an-access-application';
export const accessApplicationReadSelection = { method: 'GET', path } as const;
const fields = ['type', 'session_duration', 'created_at', 'updated_at'];
const inputSchema: Schema = { type: 'object', additionalProperties: false, properties: {} };
const errors = {
  RESOURCE_CHANGED: { status: 409, message: 'This resource changed. Refresh before continuing.' },
  PROVIDER_UNAVAILABLE: { status: 502, message: 'Could not load this resource. Try again.' },
} as const;

function record(value: unknown) {
  if (!isRecord(value)) {
    throw Error('The Access application schema is not available.');
  }
  return value;
}

export function prepareAccessApplicationRead(artifact: CloudflareReadArtifact) {
  if (artifact.method !== 'GET' || artifact.path !== path || artifact.operationId !== operationId) {
    throw Error('The Access application operation does not match its policy.');
  }
  const document = record(artifact.document);
  const item = record(record(document.paths)[path]);
  const operation = record(item.get);
  if (
    document.openapi !== '3.0.3' ||
    operation.operationId !== operationId ||
    operation.requestBody ||
    item.parameters !== undefined
  ) {
    throw Error('The Access application schema does not match its policy.');
  }
  const parameters = operation.parameters;
  if (!Array.isArray(parameters) || parameters.length !== 2) {
    throw Error('The Access application parameters changed.');
  }
  const identities = Object.fromEntries(
    parameters.map((value) => {
      const parameter = resolve(document, value);
      if (
        parameter.in !== 'path' ||
        parameter.required !== true ||
        !['account_id', 'app_id'].includes(String(parameter.name))
      ) {
        throw Error('The Access application parameters changed.');
      }
      return [String(parameter.name), parameter.schema];
    }),
  );
  if (!identities.account_id || !identities.app_id) {
    throw Error('The Access application identity schema changed.');
  }
  const pathValidator = new Validator(
    validationSchema(
      {
        type: 'object',
        additionalProperties: false,
        required: ['account_id', 'app_id'],
        properties: identities,
      },
      document,
      'input',
    ),
    '7',
  );
  const response = resolve(document, record(operation.responses)['200']);
  const responseSchema = record(record(response.content)['application/json']).schema;
  const responseValidator = new Validator(
    validationSchema(responseSchema, document, 'output'),
    '7',
  );
  const properties = Object.fromEntries(
    fields.map((field) => {
      const schema = fieldSchema(responseSchema, ['result', field], document);
      if (!schema) {
        throw Error('The Access application projection no longer matches its schema.');
      }
      return [field, schema];
    }),
  );
  const outputSchema: Schema = {
    components: validationSchema({}, document, 'output').components,
    type: 'object',
    additionalProperties: false,
    required: ['appId', 'resourceId', 'action', 'kind', 'data'],
    properties: {
      appId: { type: 'string' },
      resourceId: { type: 'string' },
      action: { type: 'string', const: operationId },
      kind: { type: 'string', const: 'provider-read' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string' }, ...properties },
      },
    },
  };
  const outputValidator = new Validator(outputSchema, '7');
  const inputValidator = new Validator(inputSchema, '7');
  const descriptor = {
    id: operationId,
    effect: 'read' as const,
    title: 'Read Access application',
    description: 'Read metadata for this project’s Access application.',
    inputSchema,
    outputSchema,
    errors: Object.entries({ ...BUILTIN_ERRORS, ...errors }).map(([code, value]) => ({
      code,
      ...value,
    })),
  };
  return {
    inputSchema,
    outputSchema,
    async describe() {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify({ adapterVersion: 1, document, fields, descriptor }),
        ),
      );
      return {
        ...descriptor,
        version: Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
      };
    },
    async read(
      bindings: Pick<ApiEnv['Bindings'], 'CF_ACCOUNT_ID' | 'CF_API_TOKEN'>,
      caller: AccessApplicationCaller,
      input: unknown,
      fetcher: typeof fetch = fetch,
    ) {
      const { reference, project } = caller;
      const locator = {
        account_id: reference.locator.accountId,
        app_id: reference.locator.applicationId,
      };
      if (!inputValidator.validate(input).valid) {
        throw Error('Check the operation input fields.');
      }
      if (
        reference.projectId !== project.id ||
        locator.account_id !== bindings.CF_ACCOUNT_ID ||
        !bindings.CF_API_TOKEN ||
        !pathValidator.validate(locator).valid
      ) {
        throw Error('This Access application is not connected.');
      }
      if (!(await caller.stillAuthorized())) {
        throw Error('This resource changed. Refresh before continuing.');
      }
      const response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(locator.account_id)}/access/apps/${encodeURIComponent(locator.app_id)}`,
        {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
          headers: { Authorization: `Bearer ${bindings.CF_API_TOKEN}`, Accept: 'application/json' },
        },
      );
      if (
        response.status !== 200 ||
        !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
      ) {
        await response.body?.cancel();
        throw Error('The provider could not return this Access application.');
      }
      const envelope = await boundedJson(response);
      if (!responseValidator.validate(envelope).valid) {
        throw Error('The provider returned an unexpected Access application.');
      }
      const returned = record(envelope),
        application = record(returned.result);
      if (
        returned.success !== true ||
        application.id !== locator.app_id ||
        application.name !== reference.proof.applicationName ||
        !(await caller.stillAuthorized())
      ) {
        throw Error('This Access application changed. Refresh before continuing.');
      }
      const output = {
        appId: project.id,
        resourceId: reference.id,
        action: operationId,
        kind: 'provider-read' as const,
        data: {
          name: reference.name,
          ...Object.fromEntries(
            fields
              .filter((field) => application[field] !== undefined)
              .map((field) => [field, application[field]]),
          ),
        },
      };
      if (
        !outputValidator.validate(output).valid ||
        new TextEncoder().encode(JSON.stringify(output)).length > 128 * 1024
      ) {
        throw Error('The Access application metadata changed unexpectedly.');
      }
      return output;
    },
  };
}

export async function accessApplicationOperations(
  bindings: ApiEnv['Bindings'],
  caller: AccessApplicationCaller,
) {
  const empty = (
    reason: string,
    unavailableReason: 'installation_not_configured' | 'schema_unavailable' = 'schema_unavailable',
  ) => ({
    reason,
    operations: [],
    unavailable: [{ ...accessApplicationReadSelection, reason: unavailableReason }],
    registryNames: new Map<string, string>(),
    registry: defineRegistry([]),
  });
  if (
    !bindings.CF_API_TOKEN ||
    !bindings.STATIC_ASSETS_R2 ||
    caller.reference.locator.accountId !== bindings.CF_ACCOUNT_ID
  ) {
    return empty(
      'The installation is not configured to read this Access application.',
      'installation_not_configured',
    );
  }
  try {
    const entry = (await cloudflareOpenApiIndex()).find(
      (entry) => entry.operationId === operationId && entry.method === 'GET' && entry.path === path,
    );
    const artifact = entry && (await cloudflareOperationSchema(bindings.STATIC_ASSETS_R2, entry));
    if (!artifact) {
      return empty('The Access application schema is not available.');
    }
    const adapter = prepareAccessApplicationRead(artifact);
    const descriptor = await adapter.describe();
    const { procedure, profile } = createProcedures<{
      bindings: ApiEnv['Bindings'];
      caller: AccessApplicationCaller;
    }>();
    const owned = profile('owned-access-application')
      .auth({
        name: 'connected-resource',
        resolve: (_request, execution) => execution.caller,
        actorId: (caller) => caller.project.user_id,
      })
      .authz({ policy: 'current-owned-resource', check: (caller) => caller.stillAuthorized() })
      .noAnalytics({ reason: 'The enclosing API request already records request analytics' })
      .noAiTool({ reason: 'The connected application mediates its own reviewed UI actions' })
      .noCli({
        reason: 'Connected applications invoke this registry through their authenticated API',
      });
    const name = 'provider.accessApplicationRead';
    const operation = procedure(name)
      .use(owned)
      .input(providerSchema(adapter.inputSchema))
      .output(providerSchema(adapter.outputSchema))
      .errors(errors)
      .mcp({
        title: descriptor.title,
        description: descriptor.description,
        effect: 'read',
        idempotent: true,
      })
      .handler(async ({ env, input, fail }) => {
        try {
          const output = await adapter.read(env.bindings, env.caller, input);
          return (await env.caller.stillAuthorized()) ? output : fail('RESOURCE_CHANGED');
        } catch {
          return (await env.caller.stillAuthorized())
            ? fail('PROVIDER_UNAVAILABLE')
            : fail('RESOURCE_CHANGED');
        }
      });
    return {
      reason: null,
      unavailable: [],
      operations: [descriptor],
      registryNames: new Map([[operationId, name]]),
      registry: defineRegistry([operation]),
    };
  } catch {
    return empty('The Access application schema is not available.');
  }
}
