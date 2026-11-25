import { isRecord } from '@builtbyfriends/deploy-core';
import { getNextFireTime } from '../cron-scheduler.ts';
import type { Db } from '../db/client.ts';
import { getDeployment } from '../db/deployments.ts';
import type { ApiEnv } from '../env.ts';
import { getProjectDeploymentWorkerName } from '../naming.ts';
import { projectSuspensionKey } from '../suspension.ts';
import type { Project } from '../types.ts';

export const scheduleAction = {
  id: 'schedule.overview',
  label: 'View schedule',
  effect: 'read' as const,
  fields: [],
  view: { scope: 'resource' as const, label: 'Overview' },
  result: 'records' as const,
};
const text = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
type Schedule = { name: string; cron: string };
export type RuntimeSchedule = Schedule & { id: string; manifest: string };
function schedules(value: unknown): Array<Schedule> | null {
  if (!Array.isArray(value) || value.length > 100) {
    return null;
  }
  const result: Array<Schedule> = [];
  for (const item of value) {
    if (!isRecord(item) || !text(item.name) || !text(item.cron)) {
      return null;
    }
    result.push({ name: item.name, cron: item.cron });
  }
  return new Set(result.map((item) => item.name)).size === result.length ? result : null;
}
export async function runtimeSchedules(db: Db, project: Project): Promise<Array<RuntimeSchedule>> {
  if (project.preview_client_id || !project.active_deployment_id) {
    return [];
  }
  const deployment = await getDeployment(db, project.active_deployment_id);
  if (!deployment || deployment.project_id !== project.id || !deployment.manifest) {
    return [];
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(deployment.manifest);
  } catch {
    return [];
  }
  const declared = isRecord(manifest) ? schedules(manifest.schedules) : null;
  if (!declared) {
    return [];
  }
  const manifestText = deployment.manifest;
  return Promise.all(
    declared.map(async (schedule) => {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify([project.id, schedule.name])),
      );
      const id =
        'schedule_' +
        btoa(String.fromCharCode(...new Uint8Array(digest)))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replaceAll('=', '');
      return { ...schedule, id, manifest: manifestText };
    }),
  );
}
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error('Schedule inspection timed out.')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function schedulerStatus(env: ApiEnv['Bindings'], projectId: string): Promise<unknown> {
  const response = await env.CRON_SCHEDULER.get(env.CRON_SCHEDULER.idFromName(projectId)).fetch(
    new Request('https://do/status', { signal: AbortSignal.timeout(3500) }),
  );
  if (!response.ok || !response.body) {
    throw Error('Schedule status unavailable.');
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) {
        break;
      }
      length += item.value.byteLength;
      if (length > 65536) {
        throw Error('Schedule status exceeds this view.');
      }
      chunks.push(item.value);
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
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function scheduleOverview(
  env: ApiEnv['Bindings'],
  project: Project,
  schedule: RuntimeSchedule,
) {
  if (
    !project.active_deployment_id ||
    project.preview_client_id ||
    !env.CRON_SCHEDULER ||
    !env.ROUTING
  ) {
    throw Error('Schedule inspection unavailable.');
  }
  const [status, routing, suspension] = await Promise.all([
    bounded(schedulerStatus(env, project.id), 4000),
    bounded(env.ROUTING.get(project.slug), 1000),
    bounded(env.ROUTING.get(projectSuspensionKey(project.id)), 1000).catch(() => undefined),
  ]);
  const worker = getProjectDeploymentWorkerName(project.slug, project.active_deployment_id);
  const route: unknown = routing ? JSON.parse(routing) : null;
  if (
    !isRecord(route) ||
    route.projectId !== project.id ||
    route.userId !== project.user_id ||
    route.version !== project.active_deployment_id ||
    route.workerName !== worker
  ) {
    throw Error('The published app connection changed.');
  }
  if (
    !isRecord(status) ||
    (status.nextAlarm !== null &&
      (typeof status.nextAlarm !== 'number' ||
        !Number.isSafeInteger(status.nextAlarm) ||
        status.nextAlarm <= 0 ||
        status.nextAlarm > 8640000000000000))
  ) {
    throw Error('Invalid schedule status.');
  }
  let registration = 'Not registered';
  if (status.state !== null) {
    if (!isRecord(status.state) || !text(status.state.workerName, 500)) {
      throw Error('Invalid scheduler registration.');
    }
    const registered = schedules(status.state.schedules);
    if (!registered) {
      throw Error('Invalid scheduler registration.');
    }
    const item = registered.find((entry) => entry.name === schedule.name);
    registration =
      status.state.workerName !== worker || (item && item.cron !== schedule.cron)
        ? 'Deployment mismatch'
        : item
          ? 'Registered'
          : 'Not registered';
  }
  const checkedAt = Date.now();
  const next = getNextFireTime([schedule], checkedAt);
  const rows: Array<{ id: string; cells: Array<string | null> }> = [
    { id: 'cron', cells: ['Schedule', schedule.cron] },
    { id: 'zone', cells: ['Time zone', 'UTC'] },
    { id: 'registration', cells: ['Registration', registration] },
    {
      id: 'suspension',
      cells: [
        'Scheduled firing suspended',
        suspension === undefined ? 'Unknown' : suspension === null ? 'No' : 'Yes',
      ],
    },
    {
      id: 'prediction',
      cells: [
        'Next time from expression (predicted)',
        next === null ? null : new Date(next).toISOString(),
      ],
    },
    {
      id: 'alarm',
      cells: [
        'Project scheduler alarm (shared)',
        status.nextAlarm === null ? null : new Date(status.nextAlarm).toISOString(),
      ],
    },
    { id: 'execution', cells: ['Execution readiness and history', 'Not reported by this view'] },
  ];
  return {
    kind: 'records' as const,
    checkedAt,
    columns: [
      { id: 'setting', label: 'Setting' },
      { id: 'value', label: 'Value' },
    ],
    rows,
    truncated: false,
  };
}
