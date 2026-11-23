import { describe, expect, it, vi } from 'vite-plus/test';
import { processCronFiresBatch } from '../../src/cron-fires-queue.ts';
import type { CronFireMessage } from '../../src/cron-fires-queue.ts';
import type { ApiEnv } from '../../src/env.ts';

type QueueMessageStub = {
  body: CronFireMessage;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
};

function makeMessage(body: CronFireMessage): QueueMessageStub {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

function makeBatch(messages: Array<QueueMessageStub>) {
  return {
    queue: 'platform-cron-fires',
    messages,
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  } as unknown as MessageBatch<CronFireMessage>;
}

function makeEnv(fetchImpl: (req: Request) => Promise<Response>): ApiEnv['Bindings'] {
  return {
    DISPATCH: {
      get: vi.fn((_workerName: string) => ({ fetch: fetchImpl })),
    },
  } as unknown as ApiEnv['Bindings'];
}

describe('processCronFiresBatch', () => {
  it('acks message when user worker returns 2xx on /__platform/scheduled', async () => {
    const seen: Array<Request> = [];
    const env = makeEnv(async (req) => {
      seen.push(req);
      return new Response('{"ok":true}', { status: 200 });
    });
    const msg = makeMessage({
      workerName: 'user-foo-dpl_a',
      cron: '* * * * *',
      scheduledTime: 1_700_000_000_000,
      proxyToken: 'tok',
    });

    await processCronFiresBatch(makeBatch([msg]), env);

    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).pathname).toBe('/__platform/scheduled');
    expect(seen[0].headers.get('x-platform-internal')).toBe('tok');
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('falls back to legacy /__scheduled when /__platform/scheduled returns 404', async () => {
    const seen: Array<Request> = [];
    let n = 0;
    const env = makeEnv(async (req) => {
      seen.push(req);
      n += 1;
      return n === 1
        ? new Response('not found', { status: 404 })
        : new Response('{"ok":true}', { status: 200 });
    });
    const msg = makeMessage({
      workerName: 'user-foo-dpl_a',
      cron: '* * * * *',
      scheduledTime: 1_700_000_000_000,
    });

    await processCronFiresBatch(makeBatch([msg]), env);

    expect(seen).toHaveLength(2);
    expect(new URL(seen[1].url).pathname).toBe('/__scheduled');
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('acks 401 with AUTH_DRIFT marker (and does not retry — same token would yield same failure)', async () => {
    // Decision: Auth drift between CronScheduler's stored proxyToken and the worker's __PLATFORM_PROXY_TOKEN:
    // a retry sends the same token and gets the same 401, so the message is acked and the next
    // deploy's /sync fixes the token. The AUTH_DRIFT marker is stable so ops can alert on it.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fetchSpy = vi.fn(async () => new Response('unauthorized', { status: 401 }));
      const env = makeEnv(fetchSpy);
      const msg = makeMessage({
        workerName: 'user-foo-dpl_a',
        cron: '* * * * *',
        scheduledTime: 1_700_000_000_000,
        proxyToken: 'stale-tok',
      });

      await processCronFiresBatch(makeBatch([msg]), env);

      expect(msg.ack).toHaveBeenCalledOnce();
      expect(msg.retry).not.toHaveBeenCalled();
      const errArg = errSpy.mock.calls.find((args) =>
        typeof args[0] === 'string' ? args[0].includes('AUTH_DRIFT') : false,
      );
      expect(errArg).toBeDefined();
      expect(errArg![0]).toContain('user-foo-dpl_a');
      expect(errArg![0]).toContain('status=401');
    } finally {
      errSpy.mockRestore();
    }
  });

  it.each([401, 403])(
    'invokes the cron handler once when the worker rejects the token with %i',
    async (status) => {
      // Decision: The Worker's own middleware runs before the cron route checks the token, so a rejected fire
      // isn't sent again with another token.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const fetchSpy = vi.fn(async () => Response.json({ error: 'unauthorized' }, { status }));
        const msg = makeMessage({
          workerName: 'user-foo-dpl_a',
          cron: '* * * * *',
          scheduledTime: 1_700_000_000_000,
          proxyToken: 'tok',
        });

        await processCronFiresBatch(makeBatch([msg]), makeEnv(fetchSpy));

        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(msg.ack).toHaveBeenCalledOnce();
        expect(msg.retry).not.toHaveBeenCalled();
        const drift = errSpy.mock.calls.filter((args) =>
          typeof args[0] === 'string' ? args[0].includes('AUTH_DRIFT') : false,
        );
        expect(drift).toHaveLength(1);
      } finally {
        errSpy.mockRestore();
      }
    },
  );

  it('acks 5xx responses and does not retry the user worker', async () => {
    // Decision: Any Response means the user worker got the request and its handler ran or routed it. The queue
    // doesn't retry application failures: that would repeat side effects (emails, payments, writes) of
    // non-idempotent cron handlers.
    const fetchSpy = vi.fn(async () => new Response('boom', { status: 500 }));
    const env = makeEnv(fetchSpy);
    const msg = makeMessage({
      workerName: 'user-foo-dpl_a',
      cron: '*/5 * * * *',
      scheduledTime: 1_700_000_000_000,
      proxyToken: 'tok',
    });

    await processCronFiresBatch(makeBatch([msg]), env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('acks unknown dispatch errors (at-most-once for crons)', async () => {
    // Decision: A throw other than "Worker not found" can come from transport or from inside a partly run user
    // worker (CPU limit, OOM). The message can't tell them apart, so it's acked to keep cron handlers
    // at-most-once. Losing a transient delivery is accepted to avoid duplicate runs.
    const fetchSpy = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const env = makeEnv(fetchSpy);
    const msg = makeMessage({
      workerName: 'user-foo-dpl_a',
      cron: '* * * * *',
      scheduledTime: 1_700_000_000_000,
      proxyToken: 'tok',
    });

    await processCronFiresBatch(makeBatch([msg]), env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('drops (acks) the message when the worker is gone', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('Worker not found');
    });
    const env = makeEnv(fetchSpy);
    const msg = makeMessage({
      workerName: 'user-deleted-dpl_x',
      cron: '* * * * *',
      scheduledTime: 1_700_000_000_000,
    });

    await processCronFiresBatch(makeBatch([msg]), env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('processes multiple messages independently', async () => {
    const fetchSpy = vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      if (req.headers.get('x-platform-internal') === 'fail') {
        return new Response('fail', { status: 500 });
      }
      return new Response('{"ok":true}', { status: 200, headers: { 'x-path': url.pathname } });
    });
    const env = makeEnv(fetchSpy);

    const ok = makeMessage({
      workerName: 'user-a',
      cron: '* * * * *',
      scheduledTime: 1,
      proxyToken: 'ok',
    });
    const bad = makeMessage({
      workerName: 'user-b',
      cron: '* * * * *',
      scheduledTime: 1,
      proxyToken: 'fail',
    });

    await processCronFiresBatch(makeBatch([ok, bad]), env);

    expect(ok.ack).toHaveBeenCalledOnce();
    expect(ok.retry).not.toHaveBeenCalled();
    expect(bad.ack).toHaveBeenCalledOnce();
    expect(bad.retry).not.toHaveBeenCalled();
  });
});
