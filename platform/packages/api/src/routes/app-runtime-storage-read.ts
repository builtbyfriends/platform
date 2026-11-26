import { isRecord } from '@builtbyfriends/deploy-core';
import type { ApiEnv } from '../env.ts';
import { deriveProxyToken } from '../proxy-token.ts';
import type { Project, Resource } from '../types.ts';

export async function proxyRead(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  path: '/r2/list' | '/d1/query',
  input: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    sql?: string;
    params?: Array<string | number>;
    method?: 'all';
  },
  signal: AbortSignal = AbortSignal.timeout(10_000),
) {
  if (!env.PLATFORM_PROXY) {
    throw new Error('Storage inspection is not connected on this installation.');
  }
  const response = await env.PLATFORM_PROXY.fetch(`https://proxy${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      ...input,
      projectId: project.id,
      binding: resource.binding_name,
      aiToken: await deriveProxyToken(env.JWT_SECRET, project.id, project.proxy_token_gen),
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error('Could not read this resource. Try again.');
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        throw new Error('Invalid response stream.');
      }
      size += value.length;
      if (size > 512 * 1024) {
        throw new Error('This page is too large to inspect.');
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(value)) {
    throw new Error('Invalid storage response.');
  }
  return value;
}
