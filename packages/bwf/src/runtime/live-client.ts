/// <reference lib="dom" />
import type {
  LiveClientEvent,
  LiveControlErrorCode,
  LiveControlOperation,
  LiveControlResponse,
} from './live.ts';
import type { RequestUrl } from './route-url.ts';

export type LiveRevokedEvent = {
  subscriptionId: string;
  topic: string;
  reason?: string;
};

export type LiveSubscribeOptions<Data = unknown> = {
  id: string;
  topic: string;
  lastEventId?: string;
  onEvent?: (event: LiveClientEvent<Data>) => void;
  /** The app ended this subscription (`stream.revoke()`). It isn't sent again when the stream reopens. */
  onRevoked?: (event: LiveRevokedEvent) => void;
};

export type ConnectLiveStreamOptions = {
  withCredentials?: boolean;
  fetch?: typeof fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  eventSource?: EventSourceConstructor;
  keepOpen?: boolean;
  retryDelay?: number;
  onError?: (error: Event | Error) => void;
};

export type LiveClient = {
  readonly connectionId: string;
  subscribe<Data = unknown>(options: LiveSubscribeOptions<Data>): Promise<() => Promise<void>>;
  close(): void;
};

type EventSourceLike = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
};

type EventSourceConstructor = new (
  url: string,
  options?: { withCredentials?: boolean },
) => EventSourceLike;

type Subscription = {
  id: string;
  topic: string;
  lastEventId?: string;
  onEvent?: (event: LiveClientEvent) => void;
  onRevoked?: (event: LiveRevokedEvent) => void;
  /** The server took it. Only these are sent again when the stream reopens. */
  confirmed?: boolean;
};

/**
 * A subscribe or unsubscribe the server didn't take. `code` is the server's error code when it
 * sent one, and `status` is the HTTP status of the control request.
 */
export class LiveStreamError extends Error {
  constructor(
    message: string,
    readonly code?: LiveControlErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LiveStreamError';
  }
}

// Decision: Codes that say the connection is gone or the server failed, not that it refused the subscribe.
const RETRYABLE_CODES: ReadonlySet<LiveControlErrorCode> = new Set([
  'CONNECTION_NOT_FOUND',
  'CONNECTION_CLOSED',
  'INTERNAL_ERROR',
]);
const MAX_RETRY_DELAY_MS = 30_000;

type PendingOperation = {
  operation: LiveControlOperation;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/**
 * Open one `EventSource` to a `defineLiveStream()` route and send subscribe and
 * unsubscribe requests to the same URL.
 *
 * With `routing.typedRoutes`, a string `url` must match one of the app's routes
 * or be an absolute `http://`/`https://` URL. Cast a path built at runtime with
 * `as RouteUrl`.
 */
export function connectLiveStream(
  url: RequestUrl | URL,
  options: ConnectLiveStreamOptions = {},
): LiveClient {
  const EventSourceCtor =
    options.eventSource ?? (globalThis as { EventSource?: EventSourceConstructor }).EventSource;
  if (!EventSourceCtor) {
    throw new Error('live: EventSource is not available in this runtime.');
  }
  const ResolvedEventSource = EventSourceCtor;
  const fetchImpl = options.fetch ?? fetch;
  const connectionId = crypto.randomUUID();
  const subscriptions = new Map<string, Subscription>();
  const subscriptionVersions = new Map<string, number>();
  let source: EventSourceLike | null = null;
  let openPromise: Promise<void> | null = null;
  let rejectOpen: ((error: Error) => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let resubscribeOnNextOpen = false;
  let resubscribeWithNextFlush = false;
  let closed = false;
  let pendingOperations: Array<PendingOperation> = [];
  let pendingFlush: Promise<void> | null = null;
  let flushChain: Promise<void> = Promise.resolve();
  let nextSubscriptionVersion = 0;
  let sourceOpen = false;
  let reconnectAttempts = 0;
  // Decision: Subscribes waiting to be tried again. Calling one tries it now.
  const retryWaiters = new Set<() => void>();
  // Decision: An unsubscribe of an id nothing uses: it only asks whether the server still knows this connection.
  const probeId = `bwf-probe:${connectionId}`;
  const retryDelay = options.retryDelay ?? 1000;
  if (!Number.isFinite(retryDelay) || retryDelay < 0) {
    throw new Error('live: retryDelay must be a non-negative finite number.');
  }
  const wakeTarget = globalThis as {
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
  wakeTarget.addEventListener?.('online', wake);
  wakeTarget.addEventListener?.('focus', wake);

  function backoff(attempt: number): number {
    return Math.min(retryDelay * 2 ** attempt, Math.max(retryDelay, MAX_RETRY_DELAY_MS));
  }

  function wanted(): boolean {
    return (
      options.keepOpen === true ||
      [...subscriptions.values()].some((subscription) => subscription.confirmed)
    );
  }

  /**
   * The network came back or the page got focus: try waiting subscribes and a waiting reconnect
   * now, and check that the server still knows an open stream.
   */
  function wake(): void {
    if (closed) {
      return;
    }
    for (const retry of retryWaiters) {
      retry();
    }
    reconnectAttempts = 0;
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      resubscribeOnNextOpen = false;
      void openSource(true).catch((error) => {
        if (!closed) {
          reportError(error);
        }
      });
      return;
    }
    if (sourceOpen && wanted()) {
      void enqueue({ kind: 'unsubscribe', id: probeId }).catch(() => {});
    }
  }

  function waitForRetry(attempt: number): Promise<void> {
    return new Promise((resolve) => {
      const retry = (): void => {
        clearTimeout(timer);
        retryWaiters.delete(retry);
        resolve();
      };
      const timer = setTimeout(retry, backoff(attempt));
      retryWaiters.add(retry);
    });
  }

  /** Whether a failed subscribe is worth sending again: the request didn't reach a working server. */
  function retryable(error: unknown): boolean {
    if (closed) {
      return false;
    }
    if (error instanceof LiveStreamError) {
      if (error.code !== undefined) {
        return RETRYABLE_CODES.has(error.code);
      }
      return error.status === undefined || error.status >= 500 || error.status === 429;
    }
    // Decision: A fetch that never reached the server, or a gateway page in place of JSON.
    return error instanceof TypeError || error instanceof SyntaxError;
  }

  /** The server lost this connection (a deploy restarts it), so open the stream again. */
  function reopen(stale: EventSourceLike): void {
    if (closed || source !== stale) {
      return;
    }
    stale.close();
    source = null;
    openPromise = null;
    rejectOpen = null;
    sourceOpen = false;
    if (wanted()) {
      void openSource(true).catch((error) => {
        if (!closed) {
          reportError(error);
        }
      });
    }
  }

  function streamUrl(): string {
    const resolved = new URL(String(url), globalThis.location?.href);
    resolved.searchParams.set('connectionId', connectionId);
    return resolved.href;
  }

  function ensureOpen(): Promise<void> {
    if (closed) {
      return Promise.reject(new Error('live: stream is closed.'));
    }
    const shouldResubscribe = resubscribeOnNextOpen;
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (openPromise) {
      return openPromise;
    }
    resubscribeOnNextOpen = false;
    if (shouldResubscribe) {
      resubscribeWithNextFlush = true;
    }
    return openSource(false);
  }

  function openSource(resubscribeOnOpen: boolean): Promise<void> {
    const current = new ResolvedEventSource(streamUrl(), {
      withCredentials: options.withCredentials,
    });
    source = current;
    let opened = false;
    openPromise = new Promise<void>((resolve, reject) => {
      rejectOpen = reject;
      const onOpen = (): void => {
        if (source !== current) {
          return;
        }
        sourceOpen = true;
        reconnectAttempts = 0;
        if (!opened) {
          opened = true;
          rejectOpen = null;
          resolve();
          if (resubscribeOnOpen) {
            void resubscribeAll().catch(reportError);
          }
          return;
        }
        void resubscribeAll().catch(reportError);
      };
      const onError = (event: Event): void => {
        reportError(event);
        if (source !== current) {
          return;
        }
        if (!opened) {
          current.removeEventListener('open', onOpen);
          current.removeEventListener('error', onError);
          current.removeEventListener('message', onMessage);
          current.removeEventListener('revoked', onRevoked);
          current.close();
          source = null;
          openPromise = null;
          rejectOpen = null;
          reject(new LiveStreamError('live: stream failed to open.'));
          if (resubscribeOnOpen) {
            scheduleReconnectTimer();
          }
          return;
        }
        if (source === current) {
          sourceOpen = false;
        }
        scheduleReconnect(current);
      };
      current.addEventListener('open', onOpen);
      current.addEventListener('error', onError);
      current.addEventListener('message', onMessage);
      current.addEventListener('revoked', onRevoked);
    });
    return openPromise;
  }

  function scheduleReconnect(current: EventSourceLike): void {
    if (closed || reconnectTimer != null) {
      return;
    }
    current.close();
    if (source === current) {
      source = null;
      openPromise = null;
    }
    if (!options.keepOpen && subscriptions.size === 0) {
      return;
    }
    scheduleReconnectTimer();
  }

  function scheduleReconnectTimer(): void {
    if (closed || reconnectTimer != null || (!options.keepOpen && subscriptions.size === 0)) {
      return;
    }
    resubscribeOnNextOpen = true;
    // Decision: An outage waits longer between tries; an open stream or a wake starts the waits over.
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      resubscribeOnNextOpen = false;
      if (closed || (!options.keepOpen && subscriptions.size === 0)) {
        return;
      }
      void openSource(true).catch((error) => {
        if (!closed) {
          reportError(error);
        }
      });
    }, backoff(reconnectAttempts++));
  }

  function reportError(error: Event | Error | unknown): void {
    if (error instanceof Event || error instanceof Error) {
      options.onError?.(error);
    } else {
      options.onError?.(new Error(String(error)));
    }
  }

  function onMessage(raw: Event): void {
    const message = raw as MessageEvent;
    let event: LiveClientEvent;
    try {
      event = JSON.parse(String(message.data)) as LiveClientEvent;
    } catch (error) {
      reportError(error);
      return;
    }
    const subscription = subscriptions.get(event.subscriptionId);
    if (!subscription) {
      return;
    }
    if (subscription.topic !== event.topic) {
      return;
    }
    if (event.eventId) {
      subscription.lastEventId = event.eventId;
    }
    subscription.onEvent?.(event);
  }

  function onRevoked(raw: Event): void {
    let event: LiveRevokedEvent;
    try {
      event = JSON.parse(String((raw as MessageEvent).data)) as LiveRevokedEvent;
    } catch (error) {
      reportError(error);
      return;
    }
    const subscription = subscriptions.get(event.subscriptionId);
    if (!subscription || subscription.topic !== event.topic) {
      return;
    }
    subscriptions.delete(subscription.id);
    subscriptionVersions.delete(subscription.id);
    subscription.onRevoked?.(event);
    closeIfIdle();
  }

  function enqueue(operation: LiveControlOperation): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      pendingOperations.push({ operation, resolve, reject });
    });
    scheduleFlush();
    return promise;
  }

  function scheduleFlush(): void {
    if (pendingFlush) {
      return;
    }
    const scheduled = flushChain.then(flush);
    pendingFlush = scheduled;
    flushChain = scheduled.catch(() => {});
    void scheduled.finally(() => {
      if (pendingFlush === scheduled) {
        pendingFlush = null;
      }
      if (pendingOperations.length > 0) {
        scheduleFlush();
      }
    });
  }

  async function flush(): Promise<void> {
    const pending = pendingOperations;
    pendingOperations = [];
    if (pending.length === 0) {
      return;
    }
    let posted: EventSourceLike | null = null;
    try {
      await ensureOpen();
      posted = source;
      let operations = pending.map((entry) => entry.operation);
      if (resubscribeWithNextFlush) {
        resubscribeWithNextFlush = false;
        const pendingIds = new Set(operations.map((operation) => operation.id));
        operations = [
          ...[...subscriptions.values()]
            .filter((subscription) => subscription.confirmed && !pendingIds.has(subscription.id))
            .map(subscribeOperation),
          ...operations,
        ];
      }
      const headers = new Headers(
        typeof options.headers === 'function' ? await options.headers() : options.headers,
      );
      headers.set('content-type', 'application/json');
      const response = await fetchImpl(String(url), {
        method: 'POST',
        headers,
        credentials: options.withCredentials ? 'include' : 'same-origin',
        body: JSON.stringify({
          connectionId,
          operations,
        }),
      });
      const result = (await response.json()) as LiveControlResponse;
      if (!response.ok || !result.accepted) {
        throw result.accepted
          ? new LiveStreamError(response.statusText, undefined, response.status)
          : new LiveStreamError(result.error.message, result.error.code, response.status);
      }
      const remaining = [...result.results];
      for (const entry of pending) {
        const index = remaining.findIndex(
          (item) => item.id === entry.operation.id && item.kind === entry.operation.kind,
        );
        const item = index === -1 ? undefined : remaining.splice(index, 1)[0];
        if (!item) {
          entry.reject(new Error(`live: missing control result for ${entry.operation.id}.`));
        } else if (item.ok) {
          entry.resolve();
        } else {
          entry.reject(new LiveStreamError(item.error.message, item.error.code, response.status));
        }
      }
    } catch (error) {
      if (
        posted &&
        error instanceof LiveStreamError &&
        (error.code === 'CONNECTION_NOT_FOUND' || error.code === 'CONNECTION_CLOSED')
      ) {
        reopen(posted);
      }
      for (const entry of pending) {
        entry.reject(error);
      }
    }
  }

  async function resubscribeAll(): Promise<void> {
    const activeSubscriptions = [...subscriptions.values()].filter(
      (subscription) => subscription.confirmed,
    );
    if (activeSubscriptions.length === 0) {
      return;
    }
    await Promise.all(
      activeSubscriptions.map((subscription) => enqueue(subscribeOperation(subscription))),
    );
  }

  function closeIfIdle(): void {
    if (!options.keepOpen && subscriptions.size === 0) {
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      resubscribeOnNextOpen = false;
      resubscribeWithNextFlush = false;
      source?.close();
      source = null;
      openPromise = null;
      rejectOpen = null;
      sourceOpen = false;
    }
  }

  return {
    connectionId,
    async subscribe(subscribeOptions) {
      const version = ++nextSubscriptionVersion;
      const previousSubscription = subscriptions.get(subscribeOptions.id);
      const previousVersion = subscriptionVersions.get(subscribeOptions.id);
      subscriptionVersions.set(subscribeOptions.id, version);
      const subscription: Subscription = {
        id: subscribeOptions.id,
        topic: subscribeOptions.topic,
        lastEventId: subscribeOptions.lastEventId,
        onEvent: subscribeOptions.onEvent as ((event: LiveClientEvent) => void) | undefined,
        onRevoked: subscribeOptions.onRevoked,
      };
      subscriptions.set(subscription.id, subscription);
      const rollback = (): void => {
        if (subscriptionVersions.get(subscription.id) === version) {
          if (previousSubscription) {
            subscriptions.set(subscription.id, previousSubscription);
            if (previousVersion != null) {
              subscriptionVersions.set(subscription.id, previousVersion);
            } else {
              subscriptionVersions.delete(subscription.id);
            }
          } else {
            subscriptions.delete(subscription.id);
            subscriptionVersions.delete(subscription.id);
          }
        }
        queueMicrotask(closeIfIdle);
      };
      // Decision: A subscribe that can't reach a working server (the stream didn't open, the network is down,
      // a deploy restarted the server) is tried again with growing waits, and at once when the
      // network comes back or the page gets focus. A refusal ends it.
      for (let attempt = 0; !subscription.confirmed; attempt++) {
        try {
          await enqueue(subscribeOperation(subscription));
          subscription.confirmed = true;
        } catch (error) {
          const current = (): boolean =>
            !closed && subscriptions.get(subscription.id) === subscription;
          if (retryable(error) && current()) {
            reportError(error);
            await waitForRetry(attempt);
            if (current()) {
              continue;
            }
          }
          rollback();
          throw closed ? new Error('live: stream is closed.') : error;
        }
      }
      if (closed) {
        throw new Error('live: stream is closed.');
      }
      let unsubscribed = false;
      return async () => {
        if (unsubscribed) {
          return;
        }
        unsubscribed = true;
        if (
          subscriptionVersions.get(subscription.id) !== version ||
          subscriptions.get(subscription.id) !== subscription
        ) {
          return;
        }
        await enqueue({ kind: 'unsubscribe', id: subscription.id });
        if (subscriptions.get(subscription.id) === subscription) {
          subscriptions.delete(subscription.id);
          subscriptionVersions.delete(subscription.id);
        }
        closeIfIdle();
      };
    },
    close() {
      const closeError = new Error('live: stream is closed.');
      closed = true;
      sourceOpen = false;
      wakeTarget.removeEventListener?.('online', wake);
      wakeTarget.removeEventListener?.('focus', wake);
      for (const retry of retryWaiters) {
        retry();
      }
      subscriptions.clear();
      subscriptionVersions.clear();
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      resubscribeOnNextOpen = false;
      resubscribeWithNextFlush = false;
      for (const entry of pendingOperations) {
        entry.reject(closeError);
      }
      pendingOperations = [];
      rejectOpen?.(closeError);
      rejectOpen = null;
      source?.close();
      source = null;
      openPromise = null;
    },
  };
}

function subscribeOperation(subscription: Subscription): LiveControlOperation {
  return {
    kind: 'subscribe',
    id: subscription.id,
    topic: subscription.topic,
    ...(subscription.lastEventId !== undefined && { lastEventId: subscription.lastEventId }),
  };
}
