import {
  createProcedures,
  defineRegistry,
  toJsonSchema,
  BUILTIN_ERRORS,
  type AuthProvider,
} from '@builtbyfriends/realtime';
import { Validator, type Schema } from '@cfworker/json-schema';
import { type } from 'arktype';
import type { ApiEnv } from '../env.ts';
import {
  actionInput,
  executeResourceAction,
  type RuntimeActionInput,
} from '../routes/app-runtime-actions.ts';
import type { Project, Resource } from '../types.ts';
import { cloudflareOpenApiIndex, cloudflareOperationSchema } from './cloudflare-openapi.ts';
import {
  cloudflareProviderReadSelections,
  prepareCloudflareProviderRead,
} from './cloudflare-provider-read.ts';
import { queryDatabase } from './database-query.ts';
import { DatabaseQueryError } from './database-select.ts';

export type ResourceCaller = {
  project: Project;
  resource: Resource;
  stillAuthorized: () => Promise<boolean>;
  resolveProviderIdentity?: () => Promise<string | null>;
};
type Execution = { bindings: ApiEnv['Bindings']; caller: ResourceCaller };
const auth: AuthProvider<ResourceCaller, Execution> = {
  name: 'connected-resource',
  resolve: (_request, execution) => execution.caller,
  actorId: (caller) => caller.project.user_id,
};
const { procedure, profile } = createProcedures<Execution>();
const owned = profile('owned-resource')
  .auth(auth)
  .authz({ policy: 'current-owned-resource', check: (caller) => caller.stillAuthorized() })
  .noAnalytics({ reason: 'The enclosing API request already records request analytics' })
  .noAiTool({ reason: 'The connected application mediates its own reviewed UI actions' })
  .noCli({
    reason: 'Connected applications invoke this resource registry through their authenticated API',
  });

const key = type('string > 0').atMostLength(1024);
const etag = type('string > 0').atMostLength(200);
const text = type('string').atMostLength(65_536);
const readInput = type({ key }).onUndeclaredKey('reject');
const saveInput = type({ key, text, expectedEtag: etag }).onUndeclaredKey('reject');
const saveJson = {
  ...toJsonSchema(saveInput, 'input'),
  properties: {
    key: toJsonSchema(key, 'input'),
    text: { ...toJsonSchema(text, 'input'), 'x-maxUtf8Bytes': 65_536 },
    expectedEtag: toJsonSchema(etag, 'input'),
  },
};
const boundedSave = {
  '~standard': {
    ...saveInput['~standard'],
    jsonSchema: { input: () => saveJson, output: () => saveJson },
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Standard Schema validates untrusted JSON at this boundary.
    validate: async (value: unknown) => {
      const result = await saveInput['~standard'].validate(value);
      if (result.issues) {
        return result;
      }
      if (!actionInput('files.saveText', result.value)) {
        return { issues: [{ message: 'Text exceeds the 64 KiB UTF-8 limit', path: ['text'] }] };
      }
      return result;
    },
  },
};
const identity = { appId: 'string', resourceId: 'string', action: 'string' } as const;
const unavailable = type({ ...identity, kind: "'unavailable'", reason: 'string' }).onUndeclaredKey(
  'reject',
);
const uncertain = type({
  ...identity,
  kind: "'conflict' | 'unknown'",
  reason: 'string',
}).onUndeclaredKey('reject');
const readOutput = type({
  ...identity,
  kind: "'file-text'",
  key,
  text,
  etag: 'string',
  contentType: 'string | null',
  size: 'number.integer >= 0',
  editable: 'boolean',
})
  .onUndeclaredKey('reject')
  .or(unavailable);
const saveOutput = type({ ...identity, kind: "'file-saved'", key, etag })
  .onUndeclaredKey('reject')
  .or(unavailable)
  .or(uncertain);
const errors = {
  RESOURCE_CHANGED: { status: 409, message: 'This resource changed. Refresh before continuing.' },
} as const;
const queryInput = type({ sql: type('string > 0').atMostLength(8192) }).onUndeclaredKey('reject');
const queryJson = {
  ...toJsonSchema(queryInput, 'input'),
  properties: { sql: { type: 'string', minLength: 1, maxLength: 8192, 'x-maxUtf8Bytes': 8192 } },
};
const boundedQuery = {
  '~standard': {
    ...queryInput['~standard'],
    jsonSchema: { input: () => queryJson, output: () => queryJson },
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Standard Schema validates untrusted JSON before any database request.
    validate: async (value: unknown) => {
      const result = await queryInput['~standard'].validate(value);
      if (result.issues) {
        return result;
      }
      return new TextEncoder().encode(result.value.sql).length <= 8192
        ? result
        : { issues: [{ message: 'SQL exceeds the 8 KiB UTF-8 limit', path: ['sql'] }] };
    },
  },
};
const queryOutput = type({
  ...identity,
  kind: "'query-rows'",
  columns: 'string[]',
  rows: '(string | number | boolean | null)[][]',
  truncated: 'boolean',
  cellsTruncated: 'boolean',
  limit: 'number.integer >= 0',
  durationMs: 'number >= 0',
})
  .onUndeclaredKey('reject')
  .or(unavailable);

async function run(execution: Execution, action: string, input: RuntimeActionInput) {
  const { bindings, caller } = execution;
  const { project, resource, stillAuthorized } = caller;
  return executeResourceAction(bindings, project, resource, action, input, stillAuthorized);
}

const readFile = procedure('files.readText')
  .use(owned)
  .input(readInput)
  .output(readOutput)
  .errors(errors)
  .mcp({
    title: 'Open file',
    description: 'Read a text file up to 64 KiB.',
    effect: 'read',
    idempotent: true,
  })
  .handler(async ({ env, input, fail }) => {
    let result;
    try {
      result = await run(env, 'files.readText', input);
    } catch {
      result = {
        appId: env.caller.project.id,
        resourceId: env.caller.resource.id,
        action: 'files.readText',
        kind: 'unavailable',
        reason: 'Could not open this text file.',
      };
    }
    if (!(await env.caller.stillAuthorized())) {
      return fail('RESOURCE_CHANGED');
    }
    return readOutput.assert(result);
  });

const saveFile = procedure('files.saveText')
  .use(owned)
  .input(boundedSave)
  .output(saveOutput)
  .errors(errors)
  .mcp({
    title: 'Save file',
    description: 'Save a text file if its opened version still matches.',
    effect: 'write',
    idempotent: false,
  })
  .handler(async ({ env, input }) => {
    const unknown = {
      appId: env.caller.project.id,
      resourceId: env.caller.resource.id,
      action: 'files.saveText',
      kind: 'unknown',
      reason: 'The save could not be confirmed. Open the file again before making another change.',
    };
    try {
      const result = await run(env, 'files.saveText', input);
      if (!(await env.caller.stillAuthorized())) {
        return saveOutput.assert(unknown);
      }
      return saveOutput.assert(result);
    } catch {
      return saveOutput.assert(unknown);
    }
  });

const readQuery = procedure('database.query')
  .use(owned)
  .input(boundedQuery)
  .output(queryOutput)
  .errors(errors)
  .mcp({
    title: 'Query table',
    description:
      'Read one regular app table with SELECT, public columns, filters, aggregates and sorting. Up to 200 rows; protected and generated columns, joins, subqueries, CTEs and writes are unavailable.',
    effect: 'read',
    idempotent: true,
  })
  .handler(async ({ env, input, fail }) => {
    let result;
    try {
      result = await queryDatabase(env.bindings, env.caller, input.sql);
    } catch (error) {
      result = {
        appId: env.caller.project.id,
        resourceId: env.caller.resource.id,
        action: 'database.query',
        kind: 'unavailable',
        reason:
          error instanceof DatabaseQueryError
            ? error.message
            : 'Could not run this query. Use a regular app table and try again.',
      };
    }
    if (!(await env.caller.stillAuthorized())) {
      return fail('RESOURCE_CHANGED');
    }
    return queryOutput.assert(result);
  });

const operationManifest = [
  { procedure: readFile, resourceType: 'r2', requires: 'PLATFORM_PROXY' },
  { procedure: saveFile, resourceType: 'r2', requires: 'PLATFORM_PROXY' },
  { procedure: readQuery, resourceType: 'd1', requires: 'PLATFORM_PROXY' },
] satisfies Array<{
  procedure: { name: string };
  resourceType: Resource['type'];
  requires: keyof ApiEnv['Bindings'];
}>;

export const resourceOperationRegistry = defineRegistry(
  operationManifest.map((entry) => entry.procedure),
);

function providerSchema(schema: Schema) {
  const validator = new Validator(schema, '7');
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'cfworker-json-schema',
      jsonSchema: { input: () => schema, output: () => schema },
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The registry validates untrusted operation JSON using its pinned provider schema.
      validate: (value: unknown) =>
        validator.validate(value).valid
          ? { value }
          : { issues: [{ message: 'The operation data does not match its schema.' }] },
    },
  };
}

async function providerOperation(
  resourceType: Resource['type'],
  bindings: ApiEnv['Bindings'],
  entry: Awaited<ReturnType<typeof cloudflareOpenApiIndex>>[number],
) {
  const artifact = await cloudflareOperationSchema(bindings.STATIC_ASSETS_R2, entry);
  if (!artifact) {
    return null;
  }
  const adapter = prepareCloudflareProviderRead(artifact, resourceType);
  if (!adapter) {
    return null;
  }
  const described = await adapter.describe();
  const providerErrors = {
    ...errors,
    PROVIDER_UNAVAILABLE: { status: 502, message: 'Could not load this resource. Try again.' },
  } as const;
  // Decision: Provider IDs are not valid Realtime names. An injective hexadecimal encoding keeps handlers distinct and stable when another artifact is absent.
  const registryName = `provider.read${Array.from(new TextEncoder().encode(adapter.id), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const operation = procedure(registryName)
    .use(owned)
    .input(providerSchema(adapter.inputSchema))
    .output(providerSchema(adapter.outputSchema))
    .errors(providerErrors)
    .mcp({
      title: described.title,
      description: described.description,
      effect: 'read',
      idempotent: true,
    })
    .handler(async ({ env, input, fail }) => {
      try {
        const output = await adapter.read(env.bindings, env.caller, input);
        if (!(await env.caller.stillAuthorized())) {
          return fail('RESOURCE_CHANGED');
        }
        return output;
      } catch {
        if (!(await env.caller.stillAuthorized())) {
          return fail('RESOURCE_CHANGED');
        }
        return fail('PROVIDER_UNAVAILABLE');
      }
    });
  const descriptor = {
    ...described,
    errors: Object.entries({ ...BUILTIN_ERRORS, ...providerErrors }).map(([code, error]) => ({
      code,
      ...error,
    })),
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(descriptor)),
  );
  const version = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return { procedure: operation, descriptor: { ...descriptor, version } };
}

async function providerOperations(
  resourceType: Resource['type'],
  bindings: ApiEnv['Bindings'],
  caller?: ResourceCaller,
) {
  const selections = cloudflareProviderReadSelections(resourceType);
  if (
    !selections.length ||
    !bindings.CF_API_TOKEN ||
    !/^[a-f0-9]{32}$/i.test(bindings.CF_ACCOUNT_ID) ||
    !bindings.STATIC_ASSETS_R2 ||
    (resourceType === 'durable-object' && !(await caller?.resolveProviderIdentity?.()))
  ) {
    return [];
  }
  const index = await cloudflareOpenApiIndex();
  const available = [];
  // Decision: Only the selected resource's explicit policies load schemas. Sequential preparation bounds transient memory; one broken artifact does not hide another operation.
  for (const selection of selections) {
    const entry = index.find(
      (candidate) => candidate.method === selection.method && candidate.path === selection.path,
    );
    if (!entry) {
      continue;
    }
    const operation = await providerOperation(resourceType, bindings, entry).catch(() => null);
    if (operation) {
      available.push(operation);
    }
  }
  return available;
}

export async function resourceOperationsFor(
  resourceType: Resource['type'],
  bindings: ApiEnv['Bindings'],
  caller?: ResourceCaller,
) {
  const registered = operationManifest.filter((entry) => entry.resourceType === resourceType);
  const available = registered.filter((entry) => !!bindings[entry.requires]);
  const names = new Set<string>(available.map((entry) => entry.procedure.name));
  const providers = await providerOperations(resourceType, bindings, caller).catch(() => []);
  const operations = [
    ...(await resourceOperationDescriptors()).filter((entry) => names.has(entry.id)),
    ...providers.map((provider) => provider.descriptor),
  ];
  return {
    reason: operations.length
      ? null
      : !registered.length && !cloudflareProviderReadSelections(resourceType).length
        ? 'Schema-backed operations are not registered for this resource yet.'
        : 'Resource operations are not connected on this installation.',
    operations,
    registryNames: new Map([
      ...available.map((entry) => [entry.procedure.name, entry.procedure.name] as const),
      ...providers.map((provider) => [provider.descriptor.id, provider.procedure.name] as const),
    ]),
    registry: providers.length
      ? defineRegistry([
          ...available.map((entry) => entry.procedure),
          ...providers.map((provider) => provider.procedure),
        ])
      : resourceOperationRegistry,
  };
}

async function describeOperations() {
  return Promise.all(
    [...resourceOperationRegistry.procedures.values()].map(async (operation) => {
      const metadata = operation.decisions.mcp;
      if (metadata.kind !== 'tool') {
        throw Error('A resource operation needs effect metadata.');
      }
      const descriptor = {
        id: operation.name,
        effect: metadata.effect,
        title: metadata.title ?? operation.name,
        description: metadata.description,
        inputSchema: operation.jsonSchema.input,
        outputSchema: operation.jsonSchema.output,
        errors: Object.entries({ ...BUILTIN_ERRORS, ...operation.errors }).map(([code, error]) => ({
          code,
          ...error,
        })),
      };
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(descriptor)),
      );
      return {
        ...descriptor,
        version: Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
      };
    }),
  );
}
let descriptors: ReturnType<typeof describeOperations> | undefined;
function resourceOperationDescriptors() {
  return (descriptors ??= describeOperations());
}
