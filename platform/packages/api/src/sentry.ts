import { withSentry } from '@sentry/cloudflare';

type SentryEnv = Readonly<{
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  PLATFORM_VERSION?: string;
  VERSION_METADATA?: Readonly<{ id: string }>;
}>;

type Handler = Record<string, unknown>;

/**
 * Decision: Error reporting for the API Worker (the control plane) is optional for a self-hosted platform. With no
 * SENTRY_DSN secret, each call goes straight to the original handler, so an installation without Sentry runs exactly as
 * before. With one set, Sentry reports uncaught errors from the fetch, scheduled and queue handlers. Tracing stays off and
 * tracePropagationTargets is empty, so no sentry-trace or baggage header is added to outgoing requests.
 * Dispatch, proxy, email-gateway and tail don't use this: Sentry's request wrapper read response bodies that dispatch
 * streams to apps ("Response body object should not be disturbed or locked" in its tests), and dispatch and tail run
 * without nodejs_compat, which Sentry needs. Those Workers carry app traffic, so they're watched from outside instead.
 */
export function withOptionalSentry<T extends Handler>(worker: string, handler: T): T {
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  const wrapped = withSentry(
    (env: SentryEnv) => ({
      dsn: env.SENTRY_DSN,
      environment: env.SENTRY_ENVIRONMENT ?? 'production',
      release: env.PLATFORM_VERSION ?? env.VERSION_METADATA?.id,
      initialScope: { tags: { worker } },
      tracesSampleRate: 0,
      tracePropagationTargets: [],
    }),
    // Decision: withSentry instruments the object it gets in place, so it gets a copy and the original stays untouched.
    { ...handler } as never,
  ) as unknown as Handler;
  const result: Handler = {};
  for (const [name, original] of Object.entries(handler)) {
    if (typeof original !== 'function') {
      result[name] = original;
      continue;
    }
    result[name] = function (this: unknown, ...args: Array<unknown>) {
      const env = args[1] as SentryEnv | undefined;
      const target =
        env?.SENTRY_DSN && typeof wrapped[name] === 'function' ? wrapped[name] : original;
      return (target as (...a: Array<unknown>) => unknown).apply(this, args);
    };
  }
  return result as T;
}
