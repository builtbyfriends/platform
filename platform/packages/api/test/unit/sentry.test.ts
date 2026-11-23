import { expect, it, vi } from 'vite-plus/test';

const { withSentry } = vi.hoisted(() => ({
  withSentry: vi.fn(
    (_options: unknown, handler: Record<string, (...args: Array<unknown>) => unknown>) => ({
      fetch: (...args: Array<unknown>) => ['sentry', handler.fetch(...args)],
    }),
  ),
}));
vi.mock('@sentry/cloudflare', () => ({ withSentry }));

const { withOptionalSentry } = await import('../../src/sentry.ts');

const handler = { fetch: (_request: unknown, _env: unknown) => 'plain', label: 'kept' };

it('calls the original handler when no SENTRY_DSN is set', () => {
  const worker = withOptionalSentry('api', handler);
  expect(worker.fetch(new Request('https://example.test'), {})).toBe('plain');
  expect(worker.label).toBe('kept');
});

it('goes through Sentry when SENTRY_DSN is set', () => {
  const worker = withOptionalSentry('api', handler);
  expect(
    worker.fetch(new Request('https://example.test'), { SENTRY_DSN: 'https://key@example.test/1' }),
  ).toEqual(['sentry', 'plain']);
});

it('adds no trace headers to outgoing requests and keeps tracing off', () => {
  withOptionalSentry('api', handler);
  const options = (withSentry.mock.calls[0][0] as (env: object) => Record<string, unknown>)({
    SENTRY_DSN: 'https://key@example.test/1',
    PLATFORM_VERSION: '1.2.3',
  });
  expect(options).toMatchObject({
    tracePropagationTargets: [],
    tracesSampleRate: 0,
    release: '1.2.3',
  });
});
