import { readUsageSigningKey, signUsageEvent } from '@platform-service/api/usage-auth';
import type { Env } from './env.ts';

export type RequestType = 'api' | 'static' | 'ssr' | 'websocket';
export type FailureKind =
  | 'platform-static-asset-timeout'
  | 'platform-static-asset-error'
  | 'platform-static-asset-missing';

export function recordRequest(
  env: Env,
  data: {
    projectId: string;
    type: RequestType;
    method: string;
    status: number;
    responseBytes: number;
    durationMs: number;
    slug: string;
    failureKind?: FailureKind;
  },
): void {
  env.ANALYTICS.writeDataPoint({
    indexes: [data.projectId],
    blobs: [
      data.projectId,
      data.type,
      data.method,
      String(data.status),
      data.slug,
      data.failureKind ?? '',
    ],
    doubles: [1, data.responseBytes, data.durationMs],
  });
}

/**
 * Split a WfP script name into the pieces the `platform_logs` dataset is keyed on.
 *
 * Mirrors `parseScriptName` in `packages/tail/src/index.ts`, restricted to the
 * `user-*` names dispatch can attribute. This MUST agree with the tail worker:
 * `GET /projects/:id/logs` selects on `index1 = 'user-<slug>'`, so a key the
 * tail worker would not have produced is a row the user can never read.
 * `packages/dispatch/test/unit/platform-log.test.ts` asserts the agreement
 * against the tail implementation itself.
 *
 * Returns `null` for anything that is not a user worker, so a platform script
 * name can never be written under a project's key.
 */
export function splitWorkerName(
  workerName: string,
): { projectKey: string; deployId: string } | null {
  if (!workerName.startsWith('user-')) {
    return null;
  }
  const dplIndex = workerName.lastIndexOf('-dpl_');
  if (dplIndex > 4) {
    return {
      projectKey: workerName.slice(0, dplIndex),
      deployId: workerName.slice(dplIndex + 1),
    };
  }
  return { projectKey: workerName, deployId: '' };
}

// Decision: Analytics Engine caps the sum of a data point's blobs at 16 KB, with no per-blob limit, and drops
// a data point over the cap (recordPlatformLog would swallow that). The longest URL seen in
// platform_logs is 6,703 bytes (p99 195), and the row carries the URL twice. These two caps keep
// each blob set under about 3.5 KB whatever the input.
const MAX_LOG_URL_BYTES = 2048;
const MAX_LOG_PATH_BYTES = 1024;

/**
 * Cut `value` to at most `maxBytes` of UTF-8, on a character boundary.
 *
 * The budget must be measured in the bytes that actually go on the wire, not in
 * UTF-16 code units — one CJK character is 1 unit and 3 bytes. Cutting mid
 * sequence is worse than useless: the split tail decodes to U+FFFD, which is
 * itself 3 bytes and pushes the field back over its budget. So the slice walks
 * back over continuation bytes and drops an incomplete lead byte before
 * decoding. A truncated value ends in an ellipsis so the reader can tell.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length <= maxBytes) {
    return value;
  }

  const ellipsis = '…';
  if (maxBytes < 3) {
    return '';
  }

  let end = maxBytes - 3;

  while (end > 0 && (encoded[end] & 0xc0) === 0x80) {
    end--;
  }

  return new TextDecoder().decode(encoded.slice(0, end)) + ellipsis;
}

/**
 * Write one row into `platform_logs` explaining a 503 that dispatch generated.
 *
 * A worker cut at the dispatch budget never returns, so it emits no tail event
 * of its own worth reading: the runtime records the invocation as `canceled`,
 * which is indistinguishable from a real client hang-up. Only dispatch knows it
 * was the one that hung up, so only dispatch can say so. Without this row
 * `bwf project logs` is empty for exactly the failure the user most needs
 * explained.
 *
 * The row is the same seven-blob/two-double shape `packages/tail/src/index.ts`
 * writes, so the existing read path needs no change. `outcome` is `canceled` to
 * match the tail row for the same invocation rather than invent a status.
 *
 * With `PLATFORM_RUNTIME_LOGS=minimal` the row carries no URL: blob4 is empty
 * and the message names only the method, budget and status.
 *
 * Best effort by construction: every call site is already returning a 503, and
 * an uncaught throw there would surface to the client as a 500. A dropped log
 * line is strictly better than that, so all failures are swallowed.
 */
export function recordPlatformLog(
  env: Env,
  data: {
    workerName: string | undefined;
    method: string;
    url: string;
    status: number;
    timeoutMs: number;
  },
): void {
  if (!data.workerName) {
    return;
  }
  const parsed = splitWorkerName(data.workerName);
  if (!parsed) {
    return;
  }

  const minimal = env.PLATFORM_RUNTIME_LOGS === 'minimal';
  let target = '';
  if (!minimal) {
    let pathname = data.url;
    try {
      pathname = new URL(data.url).pathname;
    } catch {
      // Decision: The raw string is kept: a message is worth more than a thrown URL parse.
    }
    target = ` ${truncateUtf8(pathname, MAX_LOG_PATH_BYTES)}`;
  }

  const message =
    `Platform: your worker did not respond within ${data.timeoutMs} ms. ` +
    `${data.method}${target} was cut short and ` +
    `returned ${data.status}. The operation may still have side effects; ` +
    `check its outcome before retrying.`;

  try {
    env.LOGS.writeDataPoint({
      // Decision: `projectKey` isn't truncated. It's the read key, so a shortened one would make a row that
      // GET /projects/:id/logs can't select. The project slug bounds it, and the tail worker writes the
      // same value whole.
      indexes: [parsed.projectKey],
      blobs: [
        'canceled',
        JSON.stringify([{ level: 'error', message: [message], timestamp: Date.now() }]),
        '[]',
        minimal ? '' : truncateUtf8(data.url, MAX_LOG_URL_BYTES),
        data.method,
        String(data.status),
        parsed.deployId,
      ],
      doubles: [Date.now(), data.status],
    });
  } catch {
    // Decision: The 503 being explained mustn't turn into a 500.
  }
}

export async function sendUsageEvent(
  env: Env,
  data: {
    projectId: string;
    userId: string;
    slug: string;
    requests: number;
    responseBytes: number;
    status?: number;
    failureKind?: FailureKind;
  },
): Promise<void> {
  const key = await readUsageSigningKey(env.ROUTING);
  if (!key) {
    // Decision: The API health check creates the key before installation traffic is enabled. During a staged
    // upgrade this fails closed instead of sending an unsigned frame the consumer would reject.
    throw new Error('Usage metering is not initialized. Check the platform API /health endpoint.');
  }
  const eventId = crypto.randomUUID();
  await env.USAGE_QUEUE.send(await signUsageEvent(key, 'dispatch', eventId, data));
}
