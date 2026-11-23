import type { ApiEnv } from './env.ts';

/**
 * One enqueued cron firing. The CronScheduler DO writes one of these per
 * distinct cron expression whose minute matches `now`. The DO itself cannot reach the
 * user worker via `DISPATCH.get(...).fetch(...)` because workerd dispatches
 * such calls to a named entrypoint matching the calling DO's class —
 * "CronScheduler" — which doesn't exist on user workers, so every fetch fails
 * with `The entrypoint name CronScheduler was not found`. The queue handler
 * runs as a fresh fetch event outside of any DO/RPC context, so the
 * dispatched call resolves to the user worker's default entrypoint.
 */
export type CronFireMessage = Readonly<{
  workerName: string;
  cron: string;
  scheduledTime: number;
  proxyToken?: string;
}>;

type InvokeOutcome = Readonly<{
  /** True if a Response was received, regardless of status code. */
  responseReceived: boolean;
  status?: number;
  bodySnippet?: string;
  /** True only when the worker script no longer exists. */
  unreachable?: boolean;
}>;

/**
 * Cloudflare's WfP dispatch surfaces a missing-worker error as a thrown
 * Error whose message starts with "Worker not found". This predicate is
 * the only way to distinguish "user worker is permanently gone" from
 * other transient dispatch failures.
 */
function isWorkerNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Worker not found');
}

async function invokeWorker(
  env: ApiEnv['Bindings'],
  message: CronFireMessage,
): Promise<InvokeOutcome> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (message.proxyToken) {
    headers['x-platform-internal'] = message.proxyToken;
  }
  const body = JSON.stringify({ cron: message.cron, scheduledTime: message.scheduledTime });

  let res: Response;
  try {
    const worker = env.DISPATCH.get(message.workerName);
    res = await worker.fetch(
      new Request('https://internal/__platform/scheduled', { method: 'POST', headers, body }),
    );
    // Decision: Workers deployed before the /__platform/* routes listen on /__scheduled, so retry there on a 404.
    if (res.status === 404) {
      // Decision: Drain the 404 body before reassigning, like the success path below. The .catch() matters: this
      // runs inside the outer try, and a throwing body read would land in `catch (err)` and be counted
      // as a transport failure.
      await res.arrayBuffer().catch(() => {});
      res = await worker.fetch(
        new Request('https://internal/__scheduled', { method: 'POST', headers, body }),
      );
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Decision: Not retried: see the at-most-once note in processCronFiresBatch.
    return {
      responseReceived: false,
      unreachable: isWorkerNotFoundError(error),
      bodySnippet: msg,
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      responseReceived: true,
      status: res.status,
      bodySnippet: text.slice(0, 200),
    };
  }
  // Decision: Read the whole body so the dispatch subrequest finishes cleanly. Otherwise workerd marks the user
  // worker's tail event as `outcome: "canceled"` even though the handler ran. Use arrayBuffer(), not
  // cancel(): cancel() aborts the stream, so workerd still sees an unfinished subrequest.
  // Catch the body-read rejection here: if it escaped, Promise.allSettled in processCronFiresBatch
  // would swallow it and skip msg.ack(), and Queues would retry the message and run the cron twice.
  // At-most-once delivery matters more than tail-log polish.
  await res.arrayBuffer().catch(() => {});
  return { responseReceived: true, status: res.status };
}

export async function processCronFiresBatch(
  batch: MessageBatch<CronFireMessage>,
  env: ApiEnv['Bindings'],
): Promise<void> {
  await Promise.allSettled(
    batch.messages.map(async (msg) => {
      const outcome = await invokeWorker(env, msg.body);

      // Decision: A Response came back, so the user worker's handler ran (or the runtime made a routing decision,
      // such as a 404 for a missing handler). The request was delivered once. A retry could repeat side
      // effects (emails, payments, DB writes) for handlers that fail partway, so application failures
      // are left to the user.
      if (outcome.responseReceived) {
        const status = outcome.status;
        if (status === 401 || status === 403) {
          // Decision: Auth drift between CronScheduler's stored proxyToken and the user worker's baked
          // __PLATFORM_PROXY_TOKEN. A retry gets the same 401, so ack; the next deploy's /sync resyncs the
          // token. The log line uses a stable marker that ops can alert on. Just after a token rotation
          // patches the Worker, its old version can still answer briefly; that fire is dropped too and not
          // replayed with another token, because the Worker's own middleware already ran.
          console.error(
            `[cron-fires] AUTH_DRIFT non-delivery for ${msg.body.workerName} (cron ${msg.body.cron}): status=${status} body=${outcome.bodySnippet ?? ''}; acking — next deploy will resync token`,
          );
        } else if (status != null && status >= 400) {
          console.warn(
            `[cron-fires] non-ok response from ${msg.body.workerName} (cron ${msg.body.cron}): status=${status} body=${outcome.bodySnippet ?? ''}`,
          );
        }
        msg.ack();
        return;
      }

      // Decision: The worker is gone (deleted or evicted), so drop the message instead of retrying forever. The
      // deploy, rollback and project-deletion paths that delete the worker script also clear the
      // CronScheduler DO (see the invariant at the top of cron-scheduler.ts).
      if (outcome.unreachable) {
        console.warn(
          `[cron-fires] dropping message: worker not found for ${msg.body.workerName} (cron ${msg.body.cron})`,
        );
        msg.ack();
        return;
      }

      // Decision: Any other thrown error can be a transport failure (dispatch never reached the worker) or an
      // exception from inside the worker after it partly ran (CPU limit, OOM, uncaught at top level).
      // The error string can't tell them apart, so ack to keep cron handlers at-most-once. The next
      // matching minute fires again. Losing a delivery is accepted to avoid duplicate runs.
      console.error(
        `[cron-fires] dispatch error not classified as missing-worker; acked to preserve at-most-once for cron handlers: ${msg.body.workerName} (cron ${msg.body.cron}): ${outcome.bodySnippet ?? ''}`,
      );
      msg.ack();
    }),
  );
}
