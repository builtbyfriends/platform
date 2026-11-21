import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { z } from 'zod';
import { procedure } from '../../src/runtime/procedure.ts';
import { mountProcedures } from '../../src/runtime/procedures.ts';

const r = { reason: 'Not part of this test' };
const ping = procedure()
  .noAuth(r)
  .noInput()
  .output(z.string())
  .noAuthz(r)
  .noErrors(r)
  .analytics({ event: 'pinged' })
  .noMcp(r)
  .noCli(r)
  .noAiTool(r)
  .handler(() => 'pong');

type Handle = (c: unknown) => Promise<Response>;

async function call(env: Record<string, unknown>): Promise<void> {
  const routes = new Map<string, Handle>();
  mountProcedures(
    { all: (path: string, handle: Handle) => routes.set(path, handle) } as never,
    [['tools', { ping }]],
    {
      dev: false,
      name: 'test',
      version: '0.0.0',
    },
  );
  const pending: Array<Promise<unknown>> = [];
  const response = await routes.get('/rpc/*')!({
    req: { raw: new Request('https://app.test/rpc/tools.ping', { method: 'POST', body: '{}' }) },
    env,
    executionCtx: { waitUntil: (p: Promise<unknown>) => pending.push(p) },
  });
  expect(response.status).toBe(200);
  await Promise.all(pending);
}

describe('procedure analytics', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends events to Analytics Engine only when POSTHOG_KEY is not set', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const writeDataPoint = vi.fn();
    await call({ ANALYTICS: { writeDataPoint } });
    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('also sends events to PostHog when POSTHOG_KEY is set', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const writeDataPoint = vi.fn();
    await call({
      ANALYTICS: { writeDataPoint },
      POSTHOG_KEY: 'phc_test',
      POSTHOG_HOST: 'https://eu.i.posthog.com',
    });
    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://eu.i.posthog.com/i/v0/e/');
    expect(JSON.parse(String(init.body))).toMatchObject({
      api_key: 'phc_test',
      event: 'pinged',
      distinct_id: 'anonymous',
    });
  });
});
