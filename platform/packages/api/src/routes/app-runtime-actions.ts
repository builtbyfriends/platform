import { isRecord } from '@builtbyfriends/deploy-core';
import type { ApiEnv } from '../env.ts';
import { deriveProxyToken } from '../proxy-token.ts';
import type { Project, Resource } from '../types.ts';
import { databaseCell, databaseIndexes, databaseSchema } from './app-runtime-database.ts';
import { executeKeyAction, keyEditorAvailable, validKey, validKeySave } from './app-runtime-kv.ts';
import { changeQueueDelivery, queueStatus } from './app-runtime-queue.ts';
import { vectorQuery, vectorizeRecords } from './app-runtime-vectorize.ts';

const maxText = 65_536;
const secretKey =
  /password|secret|token|credential|private.?key|verification.?code|api[_-]?key|access[_-]?key/i;
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;
const nonempty = (value: unknown, max: number): value is string =>
  bounded(value, max) && value.length > 0;
type Field = {
  name: string;
  label: string;
  type: 'text' | 'textarea';
  required: boolean;
  maxLength: number;
  description?: string;
};
type Action = {
  id: string;
  label: string;
  effect: 'read' | 'write';
  fields: Array<Field>;
  view?: { scope: 'table' | 'resource'; label: string };
  result:
    | 'cell'
    | 'file-text'
    | 'file-saved'
    | 'keys'
    | 'key-value'
    | 'key-editor'
    | 'key-saved'
    | 'table-schema'
    | 'queue-status'
    | 'records';
};
const key: Field = { name: 'key', label: 'Key', type: 'text', required: true, maxLength: 1024 };
type ActionCatalog = {
  r2: Array<Action>;
  kv: Array<Action>;
  d1: Array<Action>;
  queue: Array<Action>;
  vectorize: Array<Action>;
};
const actions: ActionCatalog = {
  vectorize: [
    {
      id: 'index.info',
      label: 'View index',
      effect: 'read',
      fields: [],
      view: { scope: 'resource', label: 'Overview' },
      result: 'records',
    },
    {
      id: 'index.query',
      label: 'Search index',
      effect: 'read',
      fields: [
        {
          name: 'vector',
          label: 'Query vector',
          type: 'textarea',
          required: true,
          maxLength: 32_768,
          description:
            'Enter a JSON array of finite numbers with the dimensions shown in Overview. Text is not automatically converted to an embedding.',
        },
        {
          name: 'topK',
          label: 'Results',
          type: 'text',
          required: false,
          maxLength: 2,
          description: 'Choose 1–20 results. Defaults to 5.',
        },
      ],
      view: { scope: 'resource', label: 'Search' },
      result: 'records',
    },
  ],
  queue: [
    {
      id: 'queue.status',
      label: 'View queue status',
      effect: 'read',
      fields: [],
      result: 'queue-status',
    },
    ...(['pause', 'resume'] as const).map((operation): Action => ({
      id: `queue.${operation}`,
      label: operation === 'pause' ? 'Pause delivery' : 'Resume delivery',
      effect: 'write',
      fields: [
        {
          name: 'expectedDelivery',
          label: 'Current delivery state',
          type: 'text',
          required: true,
          maxLength: 7,
        },
      ],
      result: 'queue-status',
    })),
  ],
  d1: [
    {
      id: 'database.cell',
      label: 'Read full value',
      effect: 'read',
      fields: [
        { name: 'table', label: 'Table', type: 'text', required: true, maxLength: 200 },
        { name: 'column', label: 'Column', type: 'text', required: true, maxLength: 200 },
        { name: 'rowToken', label: 'Row reference', type: 'text', required: true, maxLength: 8192 },
      ],
      result: 'cell',
    },
    {
      id: 'database.indexes',
      label: 'View indexes',
      effect: 'read',
      fields: [{ name: 'table', label: 'Table', type: 'text', required: true, maxLength: 200 }],
      view: { scope: 'table', label: 'Indexes' },
      result: 'records',
    },
    {
      id: 'database.schema',
      label: 'View structure',
      effect: 'read',
      fields: [{ name: 'table', label: 'Table', type: 'text', required: true, maxLength: 200 }],
      result: 'table-schema',
    },
  ],
  r2: [
    {
      id: 'files.readText',
      label: 'Open file',
      effect: 'read',
      fields: [{ ...key, label: 'File path' }],
      result: 'file-text',
    },
    {
      id: 'files.saveText',
      label: 'Save file',
      effect: 'write',
      fields: [
        { ...key, label: 'File path' },
        { name: 'text', label: 'Contents', type: 'textarea', required: true, maxLength: maxText },
      ],
      result: 'file-saved',
    },
  ],
  kv: [
    {
      id: 'keys.inspect',
      label: 'Edit value',
      effect: 'read',
      fields: [{ ...key, maxLength: 512 }],
      result: 'key-editor',
    },
    {
      id: 'keys.save',
      label: 'Save value',
      effect: 'write',
      fields: [
        { ...key, maxLength: 512 },
        { name: 'text', label: 'Value', type: 'textarea', required: true, maxLength: maxText },
        { name: 'mode', label: 'Create or replace', type: 'text', required: true, maxLength: 7 },
        {
          name: 'expectedFingerprint',
          label: 'Opened version',
          type: 'text',
          required: true,
          maxLength: 64,
        },
        { name: 'expiration', label: 'Expiry', type: 'text', required: true, maxLength: 12 },
        {
          name: 'review',
          label: 'Concurrent update review',
          type: 'text',
          required: true,
          maxLength: 15,
        },
      ],
      result: 'key-saved',
    },
    {
      id: 'keys.list',
      label: 'Browse keys',
      effect: 'read',
      fields: [
        { name: 'prefix', label: 'Prefix', type: 'text', required: false, maxLength: 512 },
        { name: 'cursor', label: 'Next page', type: 'text', required: false, maxLength: 4096 },
      ],
      result: 'keys',
    },
    {
      id: 'keys.read',
      label: 'Open value',
      effect: 'read',
      fields: [{ ...key, maxLength: 512 }],
      result: 'key-value',
    },
  ],
};
export function resourceActions(resource: Resource, keyEditing = false): Array<Action> {
  if (resource.type === 'vectorize') {
    return actions.vectorize;
  }
  return resource.type === 'r2'
    ? actions.r2
    : resource.type === 'kv'
      ? actions.kv.filter(
          (action) => keyEditing || (action.id !== 'keys.inspect' && action.id !== 'keys.save'),
        )
      : resource.type === 'd1'
        ? actions.d1
        : resource.type === 'queue'
          ? actions.queue
          : [];
}
export type RuntimeActionInput = {
  vector?: string;
  topK?: string;
  column?: string;
  rowToken?: string;
  mode?: 'create' | 'replace';
  expectedFingerprint?: string;
  expiration?: string;
  review?: 'last-write-wins';
  expectedDelivery?: 'running' | 'paused';
  table?: string;
  key?: string;
  text?: string;
  expectedEtag?: string;
  prefix?: string;
  cursor?: string;
};
export function actionInput(action: unknown, input: unknown): RuntimeActionInput | null {
  if (!isRecord(input)) {
    return null;
  }
  const definition = [
    ...actions.r2,
    ...actions.kv,
    ...actions.d1,
    ...actions.queue,
    ...actions.vectorize,
  ].find((entry) => entry.id === action);
  if (!definition) {
    return null;
  }
  if (action === 'index.query' && !vectorQuery(input.vector, input.topK)) {
    return null;
  }
  if (
    (action === 'keys.save' && !validKeySave(input)) ||
    (action === 'keys.inspect' && (typeof input.key !== 'string' || !validKey(input.key)))
  ) {
    return null;
  }
  const allowed = new Set(definition.fields.map((field) => field.name));
  if (action === 'files.saveText') {
    allowed.add('expectedEtag');
  }
  if (Object.keys(input).some((name) => !allowed.has(name))) {
    return null;
  }
  for (const field of definition.fields) {
    const value = input[field.name];
    if (value === undefined && !field.required) {
      continue;
    }
    if (
      !bounded(value, field.maxLength) ||
      (['key', 'table', 'column', 'rowToken'].includes(field.name) && !value)
    ) {
      return null;
    }
  }
  if (
    action === 'files.saveText' &&
    (!nonempty(input.expectedEtag, 200) ||
      !bounded(input.text, maxText) ||
      new TextEncoder().encode(input.text).length > maxText)
  ) {
    return null;
  }
  if (
    (action === 'queue.pause' && input.expectedDelivery !== 'running') ||
    (action === 'queue.resume' && input.expectedDelivery !== 'paused')
  ) {
    return null;
  }
  return {
    vector: typeof input.vector === 'string' ? input.vector : undefined,
    topK: typeof input.topK === 'string' ? input.topK : undefined,
    mode: input.mode === 'create' || input.mode === 'replace' ? input.mode : undefined,
    expectedFingerprint:
      typeof input.expectedFingerprint === 'string' ? input.expectedFingerprint : undefined,
    expiration: typeof input.expiration === 'string' ? input.expiration : undefined,
    review: input.review === 'last-write-wins' ? input.review : undefined,
    expectedDelivery:
      input.expectedDelivery === 'running' || input.expectedDelivery === 'paused'
        ? input.expectedDelivery
        : undefined,
    table: typeof input.table === 'string' ? input.table : undefined,
    column: typeof input.column === 'string' ? input.column : undefined,
    rowToken: typeof input.rowToken === 'string' ? input.rowToken : undefined,
    key: typeof input.key === 'string' ? input.key : undefined,
    text: typeof input.text === 'string' ? input.text : undefined,
    expectedEtag: typeof input.expectedEtag === 'string' ? input.expectedEtag : undefined,
    prefix: typeof input.prefix === 'string' ? input.prefix : undefined,
    cursor: typeof input.cursor === 'string' ? input.cursor : undefined,
  };
}
async function readBytes(response: Response, limit: number) {
  if (!response.ok || !response.body) {
    throw new Error('Resource response is unavailable.');
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array)) {
        throw new Error('Invalid response stream.');
      }
      length += bytes.byteLength;
      if (length > limit) {
        throw new Error('This value is too large to open.');
      }
      chunks.push(bytes);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
function utf8(bytes: Uint8Array) {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (bytes.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
    throw new Error('Binary values cannot be opened as text.');
  }
  return value;
}
type JsonValue =
  | null
  | boolean
  | number
  | string
  | Array<JsonValue>
  | { [name: string]: JsonValue };
function jsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(jsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, jsonValue(entry)]),
    );
  }
  throw new Error('Invalid JSON value.');
}
async function json(response: Response): Promise<JsonValue> {
  return jsonValue(JSON.parse(utf8(await readBytes(response, maxText * 6 + 16_384))));
}
function stringMap(value: unknown): value is { [name: string]: string } {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}
function metadata(response: Response, keyName: string, size: number) {
  const encoded = response.headers.get('x-platform-r2-object');
  if (!encoded || encoded.length > 32_768) {
    return null;
  }
  const value: unknown = JSON.parse(decodeURIComponent(encoded));
  if (
    !isRecord(value) ||
    value.key !== keyName ||
    value.size !== size ||
    !nonempty(value.etag, 200)
  ) {
    return null;
  }
  if (value.httpMetadata !== undefined && !stringMap(value.httpMetadata)) {
    return null;
  }
  if (value.customMetadata !== undefined && !stringMap(value.customMetadata)) {
    return null;
  }
  return {
    etag: value.etag,
    httpMetadata: value.httpMetadata ?? {},
    customMetadata: value.customMetadata ?? {},
  };
}
function redact(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name,
        secretKey.test(name) ? '[redacted]' : redact(entry),
      ]),
    );
  }
  return value;
}
export async function executeResourceAction(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  action: string,
  input: RuntimeActionInput,
  stillAuthorized: () => Promise<boolean>,
) {
  const identity = { appId: project.id, resourceId: resource.id, action };
  const unavailable = (reason: string) => ({ ...identity, kind: 'unavailable' as const, reason });
  const conflict = () => ({
    ...identity,
    kind: 'conflict' as const,
    reason: 'This file changed. Open it again before saving.',
  });
  const unknown = () => ({
    ...identity,
    kind: 'unknown' as const,
    reason: 'The save could not be confirmed. Open the file again before making another change.',
  });
  if (
    !resourceActions(resource, keyEditorAvailable(env, project, resource)).some(
      (entry) => entry.id === action,
    )
  ) {
    return unavailable('This action is not available for this resource.');
  }
  if (action === 'keys.inspect' || action === 'keys.save') {
    if (!input.key || (action === 'keys.save' && !validKeySave(input))) {
      return unavailable('Review the key before saving.');
    }
    return {
      ...identity,
      ...(await executeKeyAction(
        env,
        project,
        resource,
        action,
        { ...input, key: input.key },
        stillAuthorized,
      )),
    };
  }
  if (action === 'queue.status') {
    return { ...identity, ...(await queueStatus(env, project, resource)) };
  }
  if (action === 'index.info' || action === 'index.query') {
    return { ...identity, ...(await vectorizeRecords(env, project, resource, action, input)) };
  }
  if (action === 'queue.pause' || action === 'queue.resume') {
    if (!input.expectedDelivery) {
      return unavailable('Refresh queue status before changing delivery.');
    }
    return {
      ...identity,
      ...(await changeQueueDelivery(
        env,
        project,
        resource,
        action,
        input.expectedDelivery,
        stillAuthorized,
      )),
    };
  }
  if (!env.PLATFORM_PROXY) {
    return unavailable('This action is not available for this resource.');
  }
  if (action === 'database.cell') {
    if (!input.table || !input.column || !input.rowToken) {
      return unavailable('Choose a row value from this database.');
    }
    return {
      ...identity,
      ...(await databaseCell(env, project, resource, {
        table: input.table,
        column: input.column,
        rowToken: input.rowToken,
      })),
    };
  }
  if (action === 'database.schema' || action === 'database.indexes') {
    if (!input.table) {
      return unavailable('Choose a table from this database.');
    }
    const read = action === 'database.indexes' ? databaseIndexes : databaseSchema;
    return { ...identity, ...(await read(env, project, resource, input.table)) };
  }
  const proxy = env.PLATFORM_PROXY;
  const token = await deriveProxyToken(env.JWT_SECRET, project.id, project.proxy_token_gen);
  const request = (
    path: '/r2/get' | '/r2/put-conditional' | '/kv/get' | '/kv/list',
    values: {
      key?: string;
      value?: string;
      prefix?: string;
      cursor?: string;
      limit?: number;
      type?: 'text';
      onlyIf?: { etagMatches: string };
      httpMetadata?: { [name: string]: string };
      customMetadata?: { [name: string]: string };
    },
  ) =>
    proxy.fetch(`https://proxy${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        ...values,
        projectId: project.id,
        binding: resource.binding_name,
        aiToken: token,
      }),
    });
  if (action === 'keys.list') {
    const result = await json(
      await request('/kv/list', { prefix: input.prefix, cursor: input.cursor, limit: 50 }),
    );
    if (
      !isRecord(result) ||
      !Array.isArray(result.keys) ||
      result.keys.length > 50 ||
      typeof result.list_complete !== 'boolean' ||
      (!result.list_complete && !nonempty(result.cursor, 4096))
    ) {
      throw new Error('Invalid key list.');
    }
    const keys = result.keys
      .map((entry: unknown) => {
        if (
          !isRecord(entry) ||
          !nonempty(entry.name, 512) ||
          (entry.expiration !== undefined &&
            (typeof entry.expiration !== 'number' ||
              !Number.isSafeInteger(entry.expiration) ||
              entry.expiration < 0))
        ) {
          throw new Error('Invalid key metadata.');
        }
        return {
          name: entry.name,
          expiration: typeof entry.expiration === 'number' ? entry.expiration : null,
        };
      })
      .filter((entry) => !secretKey.test(entry.name));
    return {
      ...identity,
      kind: 'keys' as const,
      keys,
      cursor: typeof result.cursor === 'string' && !result.list_complete ? result.cursor : null,
    };
  }
  if (!input.key || secretKey.test(input.key)) {
    return unavailable('This value cannot be opened here.');
  }
  if (action === 'keys.read') {
    const value = await json(await request('/kv/get', { key: input.key, type: 'text' }));
    if (value === null) {
      return unavailable('This key no longer exists.');
    }
    if (!bounded(value, maxText) || new TextEncoder().encode(value).length > maxText) {
      return unavailable('This value is too large to open.');
    }
    utf8(new TextEncoder().encode(value));
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }
    const preview = parsed === undefined ? value : JSON.stringify(redact(jsonValue(parsed)));
    return { ...identity, kind: 'key-value' as const, key: input.key, text: preview };
  }
  const response = await request('/r2/get', { key: input.key });
  const bytes = await readBytes(response, maxText);
  const content = utf8(bytes);
  const native = metadata(response, input.key, bytes.length);
  const etag = native?.etag ?? response.headers.get('etag')?.replaceAll(/^"|"$/g, '');
  if (!etag) {
    return unavailable('This file no longer exists or cannot be opened.');
  }
  const contentType = response.headers.get('content-type');
  if (
    contentType &&
    !/^(text\/|application\/(json|[^;]+\+json|xml|[^;]+\+xml|javascript|x-javascript|x-yaml|yaml)(;|$))/i.test(
      contentType,
    )
  ) {
    return unavailable('This file type cannot be opened as text.');
  }
  if (action === 'files.readText') {
    return {
      ...identity,
      kind: 'file-text' as const,
      key: input.key,
      text: content,
      contentType,
      etag,
      size: bytes.length,
      editable: native !== null,
    };
  }
  if (!native) {
    return unavailable('This app needs an updated deployment before files can be edited.');
  }
  if (native.etag !== input.expectedEtag) {
    return conflict();
  }
  if (!(await stillAuthorized())) {
    return unavailable('This resource changed. Refresh before saving.');
  }
  try {
    const saved = await request('/r2/put-conditional', {
      key: input.key,
      value: input.text,
      onlyIf: { etagMatches: native.etag },
      httpMetadata: native.httpMetadata,
      customMetadata: native.customMetadata,
    });
    if (saved.status === 404 || saved.status === 501) {
      return unavailable('This app needs an updated deployment before files can be edited.');
    }
    if (saved.status === 412) {
      return conflict();
    }
    if (!saved.ok) {
      return unknown();
    }
    const result = await json(saved);
    if (result === null) {
      return conflict();
    }
    if (!isRecord(result) || result.key !== input.key || !nonempty(result.etag, 200)) {
      return unknown();
    }
    return { ...identity, kind: 'file-saved' as const, key: input.key, etag: result.etag };
  } catch {
    return unknown();
  }
}
