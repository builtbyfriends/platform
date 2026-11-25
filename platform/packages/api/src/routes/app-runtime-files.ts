import { Buffer } from 'node:buffer';
import { isRecord } from '@builtbyfriends/deploy-core';
import { Hono } from 'hono';
import { guardHumanStream } from '../../../proxy/src/human-stream.ts';
import type { Db } from '../db/client.ts';
import { getProjectResources } from '../db/resources.ts';
import { getUser } from '../db/users.ts';
import type { ApiEnv } from '../env.ts';
import { deriveProxyToken } from '../proxy-token.ts';
import { isAdminSuspended } from '../suspension.ts';
import type { Project, Resource } from '../types.ts';
import type { ResolveProject, RuntimeOwner } from './app-runtime.ts';

export const fileUploadMaxBytes = 5 * 1024 * 1024;
const protectedKey =
  /password|secret|token|credential|private.?key|verification.?code|api[_-]?key|access[_-]?key/i;
const text = <T>(value: T, max: number): value is T & string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

function fileKey(key: string) {
  return (
    text(key, 1024) &&
    new TextEncoder().encode(key).length <= 1024 &&
    new TextDecoder().decode(new TextEncoder().encode(key)) === key &&
    !key
      .split('')
      .some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '\\',
      ) &&
    !key.startsWith('/') &&
    !key.split('/').some((part) => part === '.' || part === '..') &&
    !protectedKey.test(key)
  );
}

export async function fileOwnerActive(db: Db, project: Project) {
  const owner = await getUser(db, project.user_id);
  return !!owner && !isAdminSuspended(owner.suspended_reason) && !project.suspended_reason;
}

export function fileTransfers(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  active: boolean,
) {
  if (resource.type !== 'r2' || !env.PLATFORM_PROXY || !active) {
    return undefined;
  }
  if (project.active_deployment_id) {
    return { download: true, upload: { maxBytes: fileUploadMaxBytes } };
  }
  return { download: true };
}

class FileBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 408 | 413,
  ) {
    super(message);
  }
}

async function readBytes(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  deadline: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!body) {
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new FileBodyError('The file transfer timed out.', 408);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          abort = () => reject(new FileBodyError('The file transfer was cancelled.', 408));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) {
            abort();
          }
          timer = setTimeout(
            () => reject(new FileBodyError('The file transfer timed out.', 408)),
            remaining,
          );
        }),
      ]).finally(() => {
        clearTimeout(timer);
        if (abort) {
          signal.removeEventListener('abort', abort);
        }
      });
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > max) {
        throw new FileBodyError('Files can be up to 5 MiB.', 413);
      }
      chunks.push(chunk.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

function mediaType(value: string | null) {
  return value && value.length <= 200 && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n]*)?$/.test(value)
    ? value
    : 'application/octet-stream';
}

export function appRuntimeFileRoutes(resolve: ResolveProject) {
  return new Hono<ApiEnv>().on(['GET', 'PUT'], '/resources.files', async (context) => {
    const query = new URL(context.req.url).searchParams;
    if (
      [...query.keys()].some(
        (name) =>
          !['project', 'resourceId', 'key', 'owner'].includes(name) ||
          query.getAll(name).length !== 1,
      )
    ) {
      return context.json({ error: 'invalid_file' }, 400);
    }
    const projectRef = query.get('project');
    const resourceId = query.get('resourceId');
    const key = query.get('key');
    const ownerQuery = query.get('owner');
    if (!text(ownerQuery, 2048)) {
      return context.json({ error: 'invalid_owner' }, 400);
    }
    let value: unknown;
    try {
      value = JSON.parse(ownerQuery);
    } catch {
      return context.json({ error: 'invalid_owner' }, 400);
    }
    const owner: RuntimeOwner | null =
      isRecord(value) && Object.keys(value).length === 1
        ? text(value.person, 200) && !value.person.startsWith('group:')
          ? { person: value.person }
          : text(value.group, 200)
            ? { group: value.group }
            : null
        : null;
    if (!text(projectRef, 200) || !text(resourceId, 200) || !key || !fileKey(key) || !owner) {
      return context.json({ error: 'invalid_file' }, 400);
    }
    const project = await resolve(context, projectRef, owner);
    if (!project || !(await fileOwnerActive(context.get('db'), project))) {
      return context.json({ error: 'unknown_project' }, 404);
    }
    const resource = (await getProjectResources(context.get('db'), project.id)).find(
      (entry) => entry.id === resourceId && entry.type === 'r2',
    );
    if (!resource) {
      return context.json({ error: 'unknown_resource' }, 404);
    }
    const uploading = context.req.method === 'PUT';
    const identity = {
      appId: project.id,
      resourceId,
      action: uploading ? 'files.upload' : 'files.download',
      key,
    };
    const outcome = (kind: 'unavailable' | 'unknown' | 'conflict', reason: string) =>
      context.json({ data: { ...identity, kind, reason } }, kind === 'conflict' ? 409 : 503);
    const proxy = context.env.PLATFORM_PROXY;
    if (!proxy || (uploading && !project.active_deployment_id)) {
      return outcome(
        'unavailable',
        'This app needs an active deployment before files can be uploaded.',
      );
    }
    const authorized = async () => {
      const current = await resolve(context, project.id, owner);
      const currentResource = (await getProjectResources(context.get('db'), project.id)).find(
        (entry) => entry.id === resource.id,
      );
      return (
        !!current &&
        current.user_id === project.user_id &&
        current.status === project.status &&
        current.proxy_token_gen === project.proxy_token_gen &&
        current.active_deployment_id === project.active_deployment_id &&
        currentResource?.type === 'r2' &&
        currentResource.cf_id === resource.cf_id &&
        currentResource.binding_name === resource.binding_name &&
        (await fileOwnerActive(context.get('db'), current))
      );
    };
    let writeStarted = false;
    let activeResponse: Response | undefined;
    const signal = context.req.raw.signal;
    try {
      signal.throwIfAborted();
      const token = await deriveProxyToken(
        context.env.JWT_SECRET,
        project.id,
        project.proxy_token_gen,
      );
      const base = { projectId: project.id, binding: resource.binding_name, aiToken: token, key };
      if (uploading) {
        const declared = context.req.header('content-length');
        if (
          context.req.header('content-encoding') ||
          (declared !== undefined && !/^\d+$/.test(declared))
        ) {
          return context.json({ error: 'invalid_file_length' }, 400);
        }
        if (declared !== undefined && Number(declared) > fileUploadMaxBytes) {
          return context.json(
            { error: 'file_too_large', message: 'Files can be up to 5 MiB.' },
            413,
          );
        }
        const bytes = await readBytes(
          context.req.raw.body,
          fileUploadMaxBytes,
          Date.now() + 30_000,
          signal,
        );
        if (declared !== undefined && Number(declared) !== bytes.byteLength) {
          return context.json({ error: 'invalid_file_length' }, 400);
        }
        const body = JSON.stringify({
          ...base,
          // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access -- Worker node:buffer is checked by the API TypeScript configuration.
          base64: Buffer.from(bytes).toString('base64'),
          onlyIf: { etagDoesNotMatch: '*' },
          contentType: mediaType(context.req.header('content-type') ?? null),
        });
        if (!(await authorized())) {
          return outcome('unavailable', 'This resource changed. Refresh before uploading.');
        }
        signal.throwIfAborted();
        writeStarted = true;
        const response = (activeResponse = await proxy.fetch('https://proxy/r2/put-conditional', {
          method: 'POST',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        }));
        if (!(await authorized())) {
          throw Error('Unconfirmed upload');
        }
        if (response.status === 404 || response.status === 501) {
          void response.body?.cancel().catch(() => {});
          return outcome(
            'unavailable',
            'This app needs an updated deployment before files can be uploaded.',
          );
        }
        if (response.status === 412) {
          void response.body?.cancel().catch(() => {});
          return outcome('conflict', 'A file already exists at this path. Choose another name.');
        }
        if (!response.ok) {
          throw Error('Unconfirmed upload');
        }
        const result: unknown = JSON.parse(
          new TextDecoder().decode(
            await readBytes(response.body, 32_768, Date.now() + 10_000, signal),
          ),
        );
        if (result === null) {
          return outcome('conflict', 'A file already exists at this path. Choose another name.');
        }
        if (
          !isRecord(result) ||
          result.key !== key ||
          result.size !== bytes.byteLength ||
          !text(result.etag, 200) ||
          !(await authorized())
        ) {
          throw Error('Unconfirmed upload');
        }
        return context.json({
          data: { ...identity, kind: 'file-saved', etag: result.etag, size: result.size },
        });
      }
      signal.throwIfAborted();
      const response = (activeResponse = await proxy.fetch('https://proxy/r2/get', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(base),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      }));
      const etag = response.headers.get('etag');
      const size = response.headers.get('content-length');
      if (
        !response.ok ||
        !response.body ||
        !etag ||
        !size ||
        !/^\d+$/.test(size) ||
        !Number.isSafeInteger(Number(size))
      ) {
        void response.body?.cancel().catch(() => {});
        return outcome('unavailable', 'This file no longer exists or cannot be downloaded.');
      }
      if (!(await authorized())) {
        void response.body.cancel().catch(() => {});
        return context.json({ error: 'resource_changed' }, 409);
      }
      const filename = encodeURIComponent(key.split('/').at(-1) || 'file').replaceAll("'", '%27');
      // oxlint-disable-next-line typescript/no-unsafe-argument -- Fetch response bodies contain byte chunks; DOM declarations leave their chunk type unbounded.
      return new Response(guardHumanStream(response.body, authorized, signal), {
        headers: {
          'content-type': mediaType(response.headers.get('content-type')),
          'content-length': size,
          etag,
          'content-disposition': `attachment; filename*=UTF-8''${filename}`,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
        },
      });
    } catch (error) {
      if (!activeResponse?.body?.locked) {
        void activeResponse?.body?.cancel().catch(() => {});
      }
      if (error instanceof FileBodyError && !writeStarted) {
        return context.json({ error: 'invalid_file', message: error.message }, error.status);
      }
      return outcome(
        writeStarted ? 'unknown' : 'unavailable',
        writeStarted
          ? 'The upload could not be confirmed. Refresh the file list before trying again.'
          : 'Could not transfer this file. Refresh and try again.',
      );
    }
  });
}
