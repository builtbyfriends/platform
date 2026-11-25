import { isRecord } from '@builtbyfriends/deploy-core';
import { getPlatformCapabilities } from '../capabilities.ts';
import type { Db } from '../db/client.ts';
import { getDeployment } from '../db/deployments.ts';
import type { ApiEnv } from '../env.ts';
import { deriveProxyToken } from '../proxy-token.ts';
import type { Project } from '../types.ts';

export const aiModelsAction = {
  id: 'ai.models',
  label: 'Find models',
  effect: 'read' as const,
  fields: [
    {
      name: 'search',
      label: 'Search models',
      type: 'text' as const,
      required: false,
      maxLength: 100,
    },
  ],
  view: { scope: 'resource' as const, label: 'Models' },
  result: 'records' as const,
};

export async function runtimeAi(db: Db, project: Project) {
  if (project.preview_client_id || !project.active_deployment_id) {
    return null;
  }
  const deployment = await getDeployment(db, project.active_deployment_id);
  if (!deployment || deployment.project_id !== project.id || !deployment.manifest) {
    return null;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(deployment.manifest);
  } catch {
    return null;
  }
  if (!isRecord(manifest) || !isRecord(manifest.bindings) || manifest.bindings.ai !== true) {
    return null;
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(project.id));
  const id =
    'ai_' +
    btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
  return { id, manifest: deployment.manifest };
}

const unavailable = (reason: string) => ({ kind: 'unavailable' as const, reason });
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/\p{Cc}/u.test(value);

async function catalogJson(response: Response): Promise<unknown> {
  if (!response.body) {
    throw Error('Missing model catalog.');
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > 512 * 1024) {
        throw Error('Model catalog exceeds this view.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function aiModels(
  env: Pick<ApiEnv['Bindings'], 'PLATFORM_CAPABILITIES' | 'PLATFORM_PROXY' | 'JWT_SECRET'>,
  project: Project,
  search?: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    if (!getPlatformCapabilities(env).ai) {
      return unavailable('AI is not enabled on this installation.');
    }
    if (!env.PLATFORM_PROXY) {
      return unavailable('The model catalog is not connected on this installation.');
    }
    const proxy = env.PLATFORM_PROXY;
    const operation = (async () => {
      const response = await proxy.fetch('https://proxy/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          projectId: project.id,
          aiToken: await deriveProxyToken(env.JWT_SECRET, project.id, project.proxy_token_gen),
          inputs: {
            page: 1,
            per_page: 100,
            hide_experimental: true,
            ...(search?.trim() && { search: search.trim() }),
          },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return unavailable(
          response.status === 429
            ? 'The model catalog is blocked by an AI usage or request limit. Try again later.'
            : response.status === 501
              ? 'AI is not enabled on this connection.'
              : 'Could not read the model catalog. Refresh and try again.',
        );
      }
      const value = await catalogJson(response);
      if (!Array.isArray(value) || value.length > 100) {
        throw Error('Invalid model catalog.');
      }
      const rows = value.map((model: unknown) => {
        if (!isRecord(model) || !text(model.name, 200)) {
          throw Error('Invalid model name.');
        }
        const task = isRecord(model.task) && text(model.task.name, 120) ? model.task.name : null;
        return { id: model.name, cells: [model.name, task] };
      });
      if (new Set(rows.map((row) => row.id)).size !== rows.length) {
        throw Error('Duplicate model names.');
      }
      return {
        kind: 'records' as const,
        checkedAt: Date.now(),
        columns: [
          { id: 'model', label: 'Model' },
          { id: 'task', label: 'Task' },
        ],
        rows,
        truncated: value.length === 100,
      };
    })();
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Error('Model catalog timed out.'));
        }, 5000);
      }),
    ]);
  } catch {
    return unavailable('Could not read the model catalog. Refresh and try again.');
  } finally {
    clearTimeout(timer);
  }
}
