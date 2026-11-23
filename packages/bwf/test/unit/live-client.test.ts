import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { connectLiveStream } from '../../src/runtime/live-client.ts';
import type { ConnectLiveStreamOptions } from '../../src/runtime/live-client.ts';
import { MockEventSource } from '../helpers/mock-event-source.ts';

const originalLocation = (globalThis as { location?: unknown }).location;

describe('connectLiveStream', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('location', { href: 'https://platform.test/page' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    (globalThis as { location?: unknown }).location = originalLocation;
  });

  it('opens one EventSource and sends subscribe after open', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        accepted: true,
        connectionId: 'connection',
        results: [{ ok: true, kind: 'subscribe', id: 'post-card', topic: 'post:12' }],
      }),
    );
    const live = openLive(fetchMock, { withCredentials: true });

    const pending = live.subscribe({ id: 'post-card', topic: 'post:12' });
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    const source = MockEventSource.instances[0]!;
    expect(source.url).toContain('/live?connectionId=');
    expect(source.options?.withCredentials).toBe(true);

    source.emit('open', new Event('open'));
    await pending;

    expect(fetchMock).toHaveBeenCalledWith('/live', {
      method: 'POST',
      headers: expect.any(Headers),
      credentials: 'include',
      body: expect.stringContaining('"topic":"post:12"'),
    });
  });

  it('rejects a subscribe waiting for the initial open when closed', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ackAll(init));
    const live = openLive(fetchMock);

    const pending = live.subscribe({ id: 'post-card', topic: 'post:12' });
    await Promise.resolve();
    const source = MockEventSource.instances[0]!;

    live.close();

    await expect(pending).rejects.toThrow('live: stream is closed.');
    expect(source.closed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes message envelopes by subscription id and unsubscribes individually', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ackAll(init));
    const handler = vi.fn();
    const live = openLive(fetchMock);
    const unsubscribe = live.subscribe({ id: 'comments', topic: 'comment:2323', onEvent: handler });
    const source = await emitOpen();
    await unsubscribe;

    source.emit(
      'message',
      JSON.stringify({ subscriptionId: 'comments', topic: 'comment:2323', data: { ok: true } }),
    );
    expect(handler).toHaveBeenCalledWith({
      subscriptionId: 'comments',
      topic: 'comment:2323',
      data: { ok: true },
    });

    await (
      await unsubscribe
    )();
    expect(fetchMock).toHaveBeenLastCalledWith('/live', {
      method: 'POST',
      headers: expect.any(Headers),
      credentials: 'same-origin',
      body: expect.stringContaining('"kind":"unsubscribe"'),
    });
  });

  it('routes events that arrive before the subscribe control ack resolves', async () => {
    const handler = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      MockEventSource.instances[0]!.emit(
        'message',
        JSON.stringify({
          subscriptionId: 'comments',
          topic: 'comment:2323',
          data: { early: true },
        }),
      );
      return ackAll(init);
    });
    const live = openLive(fetchMock);

    const unsubscribe = live.subscribe({ id: 'comments', topic: 'comment:2323', onEvent: handler });
    await emitOpen();
    await unsubscribe;

    expect(handler).toHaveBeenCalledWith({
      subscriptionId: 'comments',
      topic: 'comment:2323',
      data: { early: true },
    });
  });

  it('routes replacement events to the replacement handler before the control ack resolves', async () => {
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (controlBody(init).operations[0]?.topic === 'post:13') {
        MockEventSource.instances[0]!.emit(
          'message',
          JSON.stringify({ subscriptionId: 'card', topic: 'post:13', data: { early: true } }),
        );
      }
      return ackAll(init);
    });
    const live = openLive(fetchMock);

    const first = live.subscribe({ id: 'card', topic: 'post:12', onEvent: oldHandler });
    await emitOpen();
    await first;

    const second = live.subscribe({ id: 'card', topic: 'post:13', onEvent: newHandler });
    await second;

    expect(oldHandler).not.toHaveBeenCalled();
    expect(newHandler).toHaveBeenCalledWith({
      subscriptionId: 'card',
      topic: 'post:13',
      data: { early: true },
    });
  });

  it('keeps per-operation subscribe failures isolated in one control batch', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      Response.json({
        accepted: true,
        connectionId: controlBody(init).connectionId,
        results: [
          { ok: true, kind: 'subscribe', id: 'post-card', topic: 'post:12' },
          {
            ok: false,
            kind: 'subscribe',
            id: 'private-card',
            error: { code: 'FORBIDDEN', message: 'Forbidden' },
          },
        ],
      }),
    );
    const postHandler = vi.fn();
    const privateHandler = vi.fn();
    const live = openLive(fetchMock);

    const post = live.subscribe({ id: 'post-card', topic: 'post:12', onEvent: postHandler });
    const privatePost = live.subscribe({
      id: 'private-card',
      topic: 'post:private',
      onEvent: privateHandler,
    });
    const source = await emitOpen();

    await expect(post).resolves.toEqual(expect.any(Function));
    await expect(privatePost).rejects.toThrow('Forbidden');

    source.emit(
      'message',
      JSON.stringify({ subscriptionId: 'post-card', topic: 'post:12', data: { ok: true } }),
    );
    source.emit(
      'message',
      JSON.stringify({ subscriptionId: 'private-card', topic: 'post:private', data: {} }),
    );

    expect(postHandler).toHaveBeenCalledTimes(1);
    expect(privateHandler).not.toHaveBeenCalled();
  });

  it('keeps the previous subscription handler when replacement fails', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = controlBody(init);
      const operation = body.operations[0]!;
      if (operation.topic !== 'post:blocked') {
        return ackAll(init);
      }
      return Response.json({
        accepted: true,
        connectionId: body.connectionId,
        results: [
          {
            ok: false,
            kind: 'subscribe',
            id: operation.id,
            error: { code: 'FORBIDDEN', message: 'Forbidden' },
          },
        ],
      });
    });
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const live = openLive(fetchMock);

    const first = live.subscribe({ id: 'card', topic: 'post:12', onEvent: oldHandler });
    const source = await emitOpen();
    await first;

    await expect(
      live.subscribe({ id: 'card', topic: 'post:blocked', onEvent: newHandler }),
    ).rejects.toThrow('Forbidden');

    source.emit(
      'message',
      JSON.stringify({ subscriptionId: 'card', topic: 'post:12', data: { ok: true } }),
    );

    expect(oldHandler).toHaveBeenCalledTimes(1);
    expect(newHandler).not.toHaveBeenCalled();
  });

  it('does not let stale unsubscribe functions remove replacement subscriptions', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ackAll(init));
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const live = openLive(fetchMock);

    const firstUnsubscribe = live.subscribe({
      id: 'card',
      topic: 'post:12',
      onEvent: oldHandler,
    });
    const source = await emitOpen();
    const unsubscribeOld = await firstUnsubscribe;
    await flushMicrotasks();

    const secondUnsubscribe = live.subscribe({
      id: 'card',
      topic: 'post:13',
      onEvent: newHandler,
    });
    const unsubscribeNew = await secondUnsubscribe;
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await unsubscribeOld();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    source.emit(
      'message',
      JSON.stringify({ subscriptionId: 'card', topic: 'post:13', data: { ok: true } }),
    );
    expect(oldHandler).not.toHaveBeenCalled();
    expect(newHandler).toHaveBeenCalledTimes(1);

    await unsubscribeNew();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not let stale unsubscribe functions race in-flight replacements', async () => {
    let resolveReplacement: ((value: Response | PromiseLike<Response>) => void) | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (controlBody(init).operations[0]?.topic === 'post:13') {
        return await new Promise<Response>((resolve) => {
          resolveReplacement = resolve;
        });
      }
      return ackAll(init);
    });
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const live = openLive(fetchMock);

    const firstUnsubscribe = live.subscribe({
      id: 'card',
      topic: 'post:12',
      onEvent: oldHandler,
    });
    const source = await emitOpen();
    const unsubscribeOld = await firstUnsubscribe;

    const secondUnsubscribe = live.subscribe({
      id: 'card',
      topic: 'post:13',
      onEvent: newHandler,
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await unsubscribeOld();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveReplacement!(
      Response.json({
        accepted: true,
        connectionId: 'connection',
        results: [{ ok: true, kind: 'subscribe', id: 'card', topic: 'post:13' }],
      }),
    );
    const unsubscribeNew = await secondUnsubscribe;

    source.emit(
      'message',
      JSON.stringify({ subscriptionId: 'card', topic: 'post:13', data: { ok: true } }),
    );
    expect(oldHandler).not.toHaveBeenCalled();
    expect(newHandler).toHaveBeenCalledTimes(1);

    await unsubscribeNew();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('serializes control requests while a previous flush is in flight', async () => {
    let resolveReplacement: ((value: Response | PromiseLike<Response>) => void) | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (controlBody(init).operations[0]?.topic === 'post:13') {
        return await new Promise<Response>((resolve) => {
          resolveReplacement = resolve;
        });
      }
      return ackAll(init);
    });
    const live = openLive(fetchMock);

    const first = live.subscribe({ id: 'card', topic: 'post:12' });
    await emitOpen();
    await first;
    await flushMicrotasks();

    const replacement = live.subscribe({ id: 'card', topic: 'post:13' });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const newest = live.subscribe({ id: 'card', topic: 'post:14' });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveReplacement!(
      Response.json({
        accepted: true,
        connectionId: 'connection',
        results: [{ ok: true, kind: 'subscribe', id: 'card', topic: 'post:13' }],
      }),
    );
    await replacement;
    await newest;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]![1]?.body)).toContain('"topic":"post:13"');
    expect(String(fetchMock.mock.calls[2]![1]?.body)).toContain('"topic":"post:14"');
  });

  it('reconnects and resubscribes active subscriptions with lastEventId', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ackAll(init));
    const live = openLive(fetchMock, { retryDelay: 25 });
    const unsubscribe = live.subscribe({ id: 'post-card', topic: 'post:12', lastEventId: 'v1' });
    const firstSource = await emitOpen();
    await unsubscribe;

    firstSource.emit(
      'message',
      JSON.stringify({ subscriptionId: 'post-card', topic: 'post:12', eventId: 'v2', data: {} }),
    );
    firstSource.emit('error', new Event('error'));
    expect(firstSource.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(25);
    const secondSource = MockEventSource.instances[1]!;
    secondSource.emit('open', new Event('open'));
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenLastCalledWith('/live', {
      method: 'POST',
      headers: expect.any(Headers),
      credentials: 'same-origin',
      body: expect.stringContaining('"lastEventId":"v2"'),
    });
  });

  it('preserves resubscribe when a control operation interrupts a reconnect timer', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ackAll(init));
    const live = openLive(fetchMock, { retryDelay: 25 });
    const first = live.subscribe({ id: 'post-card', topic: 'post:12', lastEventId: 'v1' });
    const firstSource = await emitOpen();
    await first;
    await flushMicrotasks();

    firstSource.emit(
      'message',
      JSON.stringify({ subscriptionId: 'post-card', topic: 'post:12', eventId: 'v2', data: {} }),
    );
    firstSource.emit('error', new Event('error'));

    const second = live.subscribe({ id: 'comments', topic: 'comment:2323' });
    await flushMicrotasks();
    const secondSource = MockEventSource.instances[1]!;
    secondSource.emit('open', new Event('open'));
    await second;

    expect(fetchMock).toHaveBeenLastCalledWith('/live', {
      method: 'POST',
      headers: expect.any(Headers),
      credentials: 'same-origin',
      body: expect.stringContaining('"id":"post-card"'),
    });
    expect(String(fetchMock.mock.calls.at(-1)?.[1]?.body)).toContain('"id":"comments"');
    expect(String(fetchMock.mock.calls.at(-1)?.[1]?.body)).toContain('"lastEventId":"v2"');

    await vi.advanceTimersByTimeAsync(25);
    expect(MockEventSource.instances).toHaveLength(2);
  });

  describe('recovery', () => {
    let wakeTarget: EventTarget;
    beforeEach(() => {
      vi.useFakeTimers();
      wakeTarget = new EventTarget();
      vi.stubGlobal('addEventListener', wakeTarget.addEventListener.bind(wakeTarget));
      vi.stubGlobal('removeEventListener', wakeTarget.removeEventListener.bind(wakeTarget));
    });

    it('tries a subscribe again with growing waits when the stream fails to open', async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ackAll(init));
      const onError = vi.fn();
      const live = openLive(fetchMock, { retryDelay: 100, onError });
      let settled = false;
      const pending = live.subscribe({ id: 'post-card', topic: 'post:12' }).then((stop) => {
        settled = true;
        return stop;
      });

      await flushMicrotasks();
      MockEventSource.instances[0]!.emit('error', new Event('error'));
      await flushMicrotasks();
      expect(MockEventSource.instances[0]!.closed).toBe(true);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'live: stream failed to open.' }),
      );

      await vi.advanceTimersByTimeAsync(100);
      expect(MockEventSource.instances).toHaveLength(2);
      MockEventSource.instances[1]!.emit('error', new Event('error'));
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(100);
      expect(MockEventSource.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(100);
      expect(MockEventSource.instances).toHaveLength(3);
      expect(settled).toBe(false);

      MockEventSource.instances[2]!.emit('open', new Event('open'));
      await expect(pending).resolves.toEqual(expect.any(Function));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![1]?.body)).toContain('"id":"post-card"');
    });

    it('tries a subscribe again at once when the network comes back or the page gets focus', async () => {
      const fetchMock = vi
        .fn(async (_url: string, init?: RequestInit) => ackAll(init))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const live = openLive(fetchMock, { retryDelay: 60_000 });
      const pending = live.subscribe({ id: 'post-card', topic: 'post:12' });
      await emitOpen();
      await flushMicrotasks(10);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      wakeTarget.dispatchEvent(new Event('online'));
      await flushMicrotasks(10);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      wakeTarget.dispatchEvent(new Event('focus'));
      await expect(pending).resolves.toEqual(expect.any(Function));
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('tries a subscribe again when the server fails, and stops at a refusal', async () => {
      const replies = [
        () => new Response('<html>Bad gateway</html>', { status: 502 }),
        () =>
          Response.json(
            { accepted: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } },
            { status: 403 },
          ),
      ];
      const fetchMock = vi.fn(async () => replies.shift()!());
      const live = openLive(fetchMock, { retryDelay: 10 });
      const pending = live.subscribe({ id: 'post-card', topic: 'post:12' });
      const rejected = expect(pending).rejects.toMatchObject({
        name: 'LiveStreamError',
        message: 'Forbidden',
        code: 'FORBIDDEN',
        status: 403,
      });
      await emitOpen();
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reopens a stream the server no longer knows and subscribes again', async () => {
      let known = true;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
        known
          ? ackAll(init)
          : Response.json(
              {
                accepted: false,
                error: { code: 'CONNECTION_NOT_FOUND', message: 'live: connection is not open.' },
              },
              { status: 404 },
            ),
      );
      const live = openLive(fetchMock, { retryDelay: 10 });
      const first = live.subscribe({ id: 'post-card', topic: 'post:12', lastEventId: 'v1' });
      const firstSource = await emitOpen();
      await first;
      firstSource.emit(
        'message',
        JSON.stringify({ subscriptionId: 'post-card', topic: 'post:12', eventId: 'v2', data: {} }),
      );

      // Decision: A deploy restarted the server, and the stream still looks open here.
      known = false;
      const second = live.subscribe({ id: 'comments', topic: 'comment:2323' });
      await flushMicrotasks(10);
      expect(firstSource.closed).toBe(true);
      const secondSource = MockEventSource.instances[1]!;
      expect(secondSource.url).toBe(firstSource.url);

      known = true;
      secondSource.emit('open', new Event('open'));
      await flushMicrotasks(10);
      await vi.advanceTimersByTimeAsync(10);
      await expect(second).resolves.toEqual(expect.any(Function));
      const bodies = fetchMock.mock.calls.slice(2).map(([, init]) => String(init?.body));
      expect(
        bodies.some(
          (body) => body.includes('"id":"post-card"') && body.includes('"lastEventId":"v2"'),
        ),
      ).toBe(true);
      expect(bodies.some((body) => body.includes('"id":"comments"'))).toBe(true);
    });

    it('checks the connection on focus and reopens it when the server lost it', async () => {
      let known = true;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
        known
          ? ackAll(init)
          : Response.json(
              {
                accepted: false,
                error: { code: 'CONNECTION_NOT_FOUND', message: 'live: connection is not open.' },
              },
              { status: 404 },
            ),
      );
      const live = openLive(fetchMock);
      const first = live.subscribe({ id: 'post-card', topic: 'post:12' });
      const firstSource = await emitOpen();
      await first;

      known = false;
      wakeTarget.dispatchEvent(new Event('focus'));
      await flushMicrotasks(10);
      const probe = controlBody(fetchMock.mock.calls[1]![1]);
      expect(probe.operations).toEqual([
        { kind: 'unsubscribe', id: expect.stringContaining('bwf-probe:') },
      ]);
      expect(firstSource.closed).toBe(true);

      known = true;
      MockEventSource.instances[1]!.emit('open', new Event('open'));
      await flushMicrotasks(10);
      expect(String(fetchMock.mock.calls.at(-1)?.[1]?.body)).toContain('"id":"post-card"');
    });

    it('does not check a connection that has no subscriptions', async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ackAll(init));
      const live = openLive(fetchMock);
      const stop = live.subscribe({ id: 'post-card', topic: 'post:12' });
      await emitOpen();
      await (
        await stop
      )();
      wakeTarget.dispatchEvent(new Event('focus'));
      await flushMicrotasks(10);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects a subscribe waiting to be tried again when the stream closes', async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ackAll(init));
      const live = openLive(fetchMock, { retryDelay: 60_000 });
      const pending = live.subscribe({ id: 'post-card', topic: 'post:12' });
      const rejected = expect(pending).rejects.toThrow('live: stream is closed.');
      await flushMicrotasks();
      MockEventSource.instances[0]!.emit('error', new Event('error'));
      await flushMicrotasks();

      live.close();
      await rejected;
      wakeTarget.dispatchEvent(new Event('online'));
      await flushMicrotasks(10);
      expect(MockEventSource.instances).toHaveLength(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('waits longer between reconnects while the stream keeps failing', async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ackAll(init));
      const live = openLive(fetchMock, { retryDelay: 25 });
      const first = live.subscribe({ id: 'post-card', topic: 'post:12' });
      const firstSource = await emitOpen();
      await first;
      firstSource.emit('error', new Event('error'));

      await vi.advanceTimersByTimeAsync(25);
      expect(MockEventSource.instances).toHaveLength(2);
      MockEventSource.instances[1]!.emit('error', new Event('error'));
      await vi.advanceTimersByTimeAsync(25);
      expect(MockEventSource.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(25);
      expect(MockEventSource.instances).toHaveLength(3);

      MockEventSource.instances[2]!.emit('error', new Event('error'));
      wakeTarget.dispatchEvent(new Event('focus'));
      expect(MockEventSource.instances).toHaveLength(4);
    });
  });
});

type ControlBody = {
  connectionId: string;
  operations: Array<{ kind: string; id: string; topic?: string }>;
};

function controlBody(init: RequestInit | undefined): ControlBody {
  return JSON.parse(String(init?.body)) as ControlBody;
}

function ackAll(init: RequestInit | undefined): Response {
  const body = controlBody(init);
  return Response.json({
    accepted: true,
    connectionId: body.connectionId,
    results: body.operations.map((op) => ({
      ok: true,
      kind: op.kind,
      id: op.id,
      topic: op.topic,
    })),
  });
}

function openLive(fetchMock: unknown, options: ConnectLiveStreamOptions = {}) {
  return connectLiveStream('/live', {
    eventSource: MockEventSource,
    fetch: fetchMock as typeof fetch,
    ...options,
  });
}

async function emitOpen(): Promise<MockEventSource> {
  await Promise.resolve();
  const source = MockEventSource.instances[0]!;
  source.emit('open', new Event('open'));
  return source;
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}
