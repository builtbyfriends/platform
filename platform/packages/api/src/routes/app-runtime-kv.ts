import { isRecord } from '@builtbyfriends/deploy-core';
import type { ApiEnv } from '../env.ts';
import type { Project, Resource } from '../types.ts';

const maxText = 65_536;
const protectedName =
  /password|secret|token|credential|private.?key|verification.?code|api[_-]?key|access[_-]?key/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export type KeySaveInput = {
  key: string;
  text: string;
  mode: 'create' | 'replace';
  expectedFingerprint: string;
  expiration: string;
  review: 'last-write-wins';
};
function hasControl(value: string, multiline = false) {
  return value.split('').some((character) => {
    const code = character.charCodeAt(0);
    return code === 127 || (code < 32 && !(multiline && [9, 10, 13].includes(code)));
  });
}
export function validKey(key: string) {
  return (
    key.length > 0 &&
    encoder.encode(key).length <= 512 &&
    key !== '.' &&
    key !== '..' &&
    decoder.decode(encoder.encode(key)) === key &&
    !hasControl(key) &&
    !protectedName.test(key)
  );
}
export function validKeySave<
  T extends {
    key?: unknown;
    text?: unknown;
    mode?: unknown;
    expectedFingerprint?: unknown;
    expiration?: unknown;
    review?: unknown;
  },
>(input: T): input is T & KeySaveInput {
  return (
    typeof input.key === 'string' &&
    validKey(input.key) &&
    typeof input.text === 'string' &&
    encoder.encode(input.text).length <= maxText &&
    decoder.decode(encoder.encode(input.text)) === input.text &&
    !hasControl(input.text, true) &&
    input.review === 'last-write-wins' &&
    ((input.mode === 'create' && input.expectedFingerprint === 'missing') ||
      (input.mode === 'replace' &&
        typeof input.expectedFingerprint === 'string' &&
        /^[a-f0-9]{64}$/.test(input.expectedFingerprint))) &&
    typeof input.expiration === 'string' &&
    (input.expiration === 'preserve' ||
      input.expiration === 'none' ||
      /^\d{1,12}$/.test(input.expiration))
  );
}
export function keyEditorAvailable(env: ApiEnv['Bindings'], project: Project, resource: Resource) {
  return (
    resource.type === 'kv' &&
    resource.project_id === project.id &&
    /^[a-f0-9]{32}$/i.test(resource.cf_id) &&
    project.status === 'active' &&
    !!project.active_deployment_id &&
    !!env.CF_ACCOUNT_ID &&
    !!env.CF_API_TOKEN
  );
}
function remaining(deadline: number) {
  const duration = deadline - Date.now();
  if (duration <= 0) {
    throw Error('Key operation timed out.');
  }
  return duration;
}
async function checkAccess(check: () => Promise<boolean>, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error('Key authorization timed out.')),
          Math.min(1000, remaining(deadline)),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function bytes(response: Response, max: number, deadline: number) {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('Key response timed out.')), remaining(deadline));
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) {
        break;
      }
      if (!(chunk.value instanceof Uint8Array)) {
        throw Error('Invalid key response.');
      }
      size += chunk.value.byteLength;
      if (size > max) {
        throw Error('This value is too large to edit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const value = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.length;
  }
  return value;
}
async function envelope(response: Response, max: number, deadline: number) {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw Error('Key service is unavailable.');
  }
  const data: unknown = JSON.parse(decoder.decode(await bytes(response, max, deadline)));
  if (
    !isRecord(data) ||
    data.success !== true ||
    !Array.isArray(data.errors) ||
    data.errors.length !== 0
  ) {
    throw Error('Invalid key service result.');
  }
  return data;
}
type Json = null | boolean | number | string | Array<Json> | { [key: string]: Json };
function canonical(value: unknown, depth = 0): Json {
  if (depth > 32) {
    throw Error('JSON is too deeply nested.');
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonical(entry, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((name) => [name, canonical(value[name], depth + 1)]),
    );
  }
  throw Error('Invalid JSON.');
}
function display(text: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.startsWith('\ufeff') ? text.slice(1) : text);
  } catch {
    return { text, protected: false };
  }
  const value = canonical(parsed);
  let protectedValue = false;
  const redacted = JSON.stringify(value, (name, entry: Json) => {
    if (protectedName.test(name)) {
      protectedValue = true;
      return '[redacted]';
    }
    return entry;
  });
  if (protectedValue && encoder.encode(redacted).length > maxText) {
    throw Error('The protected preview is too large.');
  }
  return { text: protectedValue ? redacted : text, protected: protectedValue };
}
type Snapshot = {
  exists: boolean;
  text: string;
  metadata: Json;
  expiration: number | null;
  fingerprint: string;
};
async function snapshot(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  key: string,
  deadline: number,
): Promise<Snapshot> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/storage/kv/namespaces/${resource.cf_id}`;
  const request = (path: string) =>
    fetch(base + path, {
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(remaining(deadline)),
    });
  const listed = await envelope(
    await request(`/keys?${new URLSearchParams({ prefix: key, limit: '1' })}`),
    8192,
    deadline,
  );
  if (
    !Array.isArray(listed.result) ||
    listed.result.length > 1 ||
    !isRecord(listed.result_info) ||
    (listed.result_info.cursor !== undefined && typeof listed.result_info.cursor !== 'string')
  ) {
    throw Error('Invalid key listing.');
  }
  const entry: unknown = listed.result[0];
  if (
    entry !== undefined &&
    (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.startsWith(key))
  ) {
    throw Error('Invalid key listing.');
  }
  const exact = isRecord(entry) && entry.name === key ? entry : null;
  const response = await request(`/values/${encodeURIComponent(key)}`);
  if (!exact) {
    void response.body?.cancel().catch(() => {});
    if (response.status !== 404 || (!entry && listed.result_info.cursor)) {
      throw Error('Key reads disagree. Refresh before editing.');
    }
    return { exists: false, text: '', metadata: null, expiration: null, fingerprint: 'missing' };
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw Error('Key reads disagree. Refresh before editing.');
  }
  const raw = await bytes(response, maxText, deadline);
  const text = decoder.decode(raw);
  if (hasControl(text, true)) {
    throw Error('Binary values cannot be edited as text.');
  }
  const expiration = exact.expiration ?? null;
  if (
    expiration !== null &&
    (typeof expiration !== 'number' || !Number.isSafeInteger(expiration) || expiration <= 0)
  ) {
    throw Error('Invalid key expiry.');
  }
  const metadata = canonical(exact.metadata ?? null);
  if (encoder.encode(JSON.stringify(metadata)).length > 1024) {
    throw Error('Invalid key metadata.');
  }
  const signing = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    signing,
    encoder.encode(
      JSON.stringify([
        'key-editor-v1',
        project.id,
        resource.id,
        resource.cf_id,
        key,
        text,
        metadata,
        expiration,
      ]),
    ),
  );
  const fingerprint = Array.from(new Uint8Array(signed), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return { exists: true, text, metadata, expiration, fingerprint };
}
export async function executeKeyAction(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  action: 'keys.inspect' | 'keys.save',
  input: { key: string } | KeySaveInput,
  stillAuthorized: () => Promise<boolean>,
) {
  const deadline = Date.now() + 10_000;
  let dispatched = false;
  const outcome = (kind: 'unavailable' | 'conflict' | 'unknown', reason: string) => ({
    kind,
    reason,
  });
  try {
    if (
      !keyEditorAvailable(env, project, resource) ||
      !validKey(input.key) ||
      !(await checkAccess(stillAuthorized, deadline))
    ) {
      return outcome('unavailable', 'This key cannot be edited here.');
    }
    const current = await snapshot(env, project, resource, input.key, deadline);
    if (!(await checkAccess(stillAuthorized, deadline))) {
      return outcome('unavailable', 'This resource changed. Refresh before editing.');
    }
    const shown = display(current.text);
    if (action === 'keys.inspect') {
      return {
        kind: 'key-editor' as const,
        key: input.key,
        exists: current.exists,
        text: shown.text,
        editable: !shown.protected,
        fingerprint: shown.protected ? null : current.fingerprint,
        expiration: current.expiration,
        checkedAt: Date.now(),
        ...(shown.protected
          ? { reason: 'Protected fields are hidden. This value cannot be edited here.' }
          : {}),
      };
    }
    if (!validKeySave(input)) {
      return outcome('unavailable', 'Review the value and expiry before saving.');
    }
    if (shown.protected || display(input.text).protected) {
      return outcome('unavailable', 'Values containing protected fields cannot be edited here.');
    }
    if (
      current.fingerprint !== input.expectedFingerprint ||
      current.exists !== (input.mode === 'replace')
    ) {
      return outcome('conflict', 'This key changed. Open it again and review your changes.');
    }
    if (current.expiration !== null && current.expiration < Math.ceil(Date.now() / 1000) + 60) {
      return outcome(
        'unavailable',
        'This key is expiring soon. Wait, then reopen it before making another change.',
      );
    }
    const expiration =
      input.expiration === 'preserve'
        ? current.expiration
        : input.expiration === 'none'
          ? null
          : Number(input.expiration);
    if (
      expiration !== null &&
      (!Number.isSafeInteger(expiration) ||
        expiration < Math.ceil(Date.now() / 1000) + 60 ||
        expiration > 253_402_300_799)
    ) {
      return outcome(
        'unavailable',
        'Expiry must be at least 60 seconds from now. Choose a later time or no expiry.',
      );
    }
    const body = new FormData();
    body.set(
      'value',
      new Blob([encoder.encode(input.text)], { type: 'application/octet-stream' }),
      'value',
    );
    if (current.metadata !== null) {
      body.set('metadata', JSON.stringify(current.metadata));
    }
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/storage/kv/namespaces/${resource.cf_id}/values/${encodeURIComponent(input.key)}`,
    );
    if (expiration !== null) {
      url.searchParams.set('expiration', String(expiration));
    }
    if (!(await checkAccess(stillAuthorized, deadline))) {
      return outcome('unavailable', 'This resource changed. Refresh before saving.');
    }
    const signal = AbortSignal.timeout(remaining(deadline));
    dispatched = true;
    await envelope(
      await fetch(url.toString(), {
        method: 'PUT',
        redirect: 'manual',
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
        body,
        signal,
      }),
      16_384,
      deadline,
    );
    if (!(await checkAccess(stillAuthorized, deadline))) {
      return outcome(
        'unknown',
        'The key update was sent, but access changed before it could be confirmed.',
      );
    }
    return {
      kind: 'key-saved' as const,
      key: input.key,
      acceptedAt: Date.now(),
      expiration,
      consistency: 'eventual' as const,
    };
  } catch {
    return dispatched
      ? outcome(
          'unknown',
          'The update could not be confirmed. Wait, then open the key before making another change.',
        )
      : outcome(
          'unavailable',
          'Could not prepare this key. Refresh and try again; binary, protected or values over 64 KiB cannot be edited.',
        );
  }
}
