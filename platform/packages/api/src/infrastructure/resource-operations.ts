import {
  createProcedures,
  defineRegistry,
  toJsonSchema,
  BUILTIN_ERRORS,
  type AuthProvider,
} from '@builtbyfriends/realtime';
import { type } from 'arktype';
import type { ApiEnv } from '../env.ts';
import {
  actionInput,
  executeResourceAction,
  type RuntimeActionInput,
} from '../routes/app-runtime-actions.ts';
import type { Project, Resource } from '../types.ts';
import { queryDatabase } from './database-query.ts';
import { DatabaseQueryError } from './database-select.ts';

export type ResourceCaller = {
  project: Project;
  resource: Resource;
  stillAuthorized: () => Promise<boolean>;
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

export const resourceOperationRegistry = defineRegistry([readFile, saveFile, readQuery]);

export function resourceOperationSupported(id: string, resourceType: string) {
  return resourceType === 'r2'
    ? id === 'files.readText' || id === 'files.saveText'
    : resourceType === 'd1' && id === 'database.query';
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
export function resourceOperationDescriptors() {
  return (descriptors ??= describeOperations());
}
