import { isRecord } from '@builtbyfriends/deploy-core';
import type { ApiEnv } from '../env.ts';
import { getProjectDeploymentWorkerName, getProjectQueueName } from '../naming.ts';
import { cfFetch, CF_API_BASE } from '../provisioning/cloudflare-api.ts';
import { deriveProxyToken } from '../proxy-token.ts';
import type { Project, Resource } from '../types.ts';

type Backlog = { count: number; bytes: number; oldestMessageAt: number | null };
export type QueueStatus = {
  kind: 'queue-status';
  checkedAt: number;
  delivery: 'running' | 'paused' | 'unknown';
  backlog: Backlog | null;
  consumer: {
    connected: true;
    retryAttempts: number | null;
    retryDelaySeconds: number | null;
    batchSize: number | null;
    batchWaitSeconds: number | null;
    maxConcurrency: number | null;
  };
};
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function setting(value: unknown): number | null {
  if (value === undefined) {
    return null;
  }
  if (!nonnegative(value)) {
    throw new Error('Invalid queue settings.');
  }
  return value;
}
function backlog(value: unknown): Backlog | null {
  if (!isRecord(value) || !nonnegative(value.backlog_count) || !nonnegative(value.backlog_bytes)) {
    return null;
  }
  const oldest = value.oldest_message_timestamp_ms;
  if (
    oldest !== null &&
    oldest !== undefined &&
    (!nonnegative(oldest) || oldest > 8_640_000_000_000_000)
  ) {
    return null;
  }
  if (value.backlog_count > 0 && !nonnegative(oldest)) {
    return null;
  }
  return {
    count: value.backlog_count,
    bytes: value.backlog_bytes,
    oldestMessageAt: typeof oldest === 'number' && oldest > 0 ? oldest : null,
  };
}
async function readRouting(env: ApiEnv['Bindings'], key: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      env.ROUTING.get(key),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Queue routing is unavailable.')), 750);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function queueStatus(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
): Promise<QueueStatus> {
  if (
    resource.type !== 'queue' ||
    resource.project_id !== project.id ||
    !/^[a-f0-9]{32}$/i.test(resource.cf_id) ||
    !project.active_deployment_id ||
    project.preview_client_id ||
    !env.CF_ACCOUNT_ID ||
    !env.CF_API_TOKEN
  ) {
    throw new Error('Queue status is unavailable.');
  }
  const name = getProjectQueueName(project.id, resource.binding_name);
  const routingKey = `queue:${name}`;
  const routing = await readRouting(env, routingKey);
  const route: unknown = routing ? JSON.parse(routing) : null;
  if (
    !isRecord(route) ||
    route.projectId !== project.id ||
    route.queueName !== resource.binding_name ||
    route.workerName !==
      getProjectDeploymentWorkerName(project.slug, project.active_deployment_id) ||
    route.proxyToken !==
      (await deriveProxyToken(env.JWT_SECRET, project.id, project.proxy_token_gen))
  ) {
    throw new Error('Queue delivery is not linked to this app deployment.');
  }
  const url = `${CF_API_BASE}/${encodeURIComponent(env.CF_ACCOUNT_ID)}/queues/${resource.cf_id}`;
  const read = (path: '' | '/consumers' | '/metrics') =>
    cfFetch<unknown>(`${url}${path}`, env.CF_API_TOKEN, {
      // Decision: Leave room for both routing fences and the caller's ten-second request deadline.
      signal: AbortSignal.timeout(path === '/metrics' ? 2000 : 4000),
    });
  const [queue, consumers] = await Promise.all([read(''), read('/consumers')]);
  if (
    !isRecord(queue) ||
    queue.queue_id !== resource.cf_id ||
    queue.queue_name !== name ||
    !isRecord(queue.settings) ||
    (queue.settings.delivery_paused !== undefined &&
      typeof queue.settings.delivery_paused !== 'boolean') ||
    !Array.isArray(consumers) ||
    consumers.length !== 1
  ) {
    throw new Error('Queue configuration could not be verified.');
  }
  const consumer: unknown = consumers[0];
  if (
    !isRecord(consumer) ||
    consumer.type !== 'worker' ||
    consumer.script !== (env.DISPATCH_WORKER_NAME ?? 'platform-dispatch') ||
    !isRecord(consumer.settings)
  ) {
    throw new Error('Queue consumer could not be verified.');
  }
  const settings = consumer.settings;
  const wait = setting(settings.max_wait_time_ms);
  const verified: QueueStatus['consumer'] = {
    connected: true,
    retryAttempts: setting(settings.max_retries),
    retryDelaySeconds: setting(settings.retry_delay),
    batchSize: setting(settings.batch_size),
    batchWaitSeconds: wait === null ? null : wait / 1000,
    // Decision: An absent or null concurrency cap in verified consumer settings means automatic scaling.
    maxConcurrency: settings.max_concurrency === null ? null : setting(settings.max_concurrency),
  };
  let metrics: Backlog | null = null;
  try {
    metrics = backlog(await read('/metrics'));
  } catch {
    // Decision: A missing measurement doesn't erase verified delivery settings or imply an empty queue.
  }
  if ((await readRouting(env, routingKey)) !== routing) {
    throw new Error('Queue delivery changed while reading.');
  }
  return {
    kind: 'queue-status',
    checkedAt: Date.now(),
    delivery:
      queue.settings.delivery_paused === undefined
        ? 'unknown'
        : queue.settings.delivery_paused
          ? 'paused'
          : 'running',
    backlog: metrics,
    consumer: verified,
  };
}
