import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getRedeliveredGuids, recordWebhookRedelivery } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import type { FailedWebhookDelivery } from '../../src/github/webhook-deliveries.ts';
import { replayFailedWebhookDeliveries } from '../../src/webhook-replay.ts';
import { clearTables, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

// Decision: The factory closures read this module-level state at call time (like `compareStatus` in
// api-webhooks.test.ts), so no `vi.hoisted` or TDZ workaround is needed.
let failedDeliveries: Array<FailedWebhookDelivery> = [];
let redeliverResults: Record<string, boolean> = {};
const listCalls: Array<{ opts?: { maxPages?: number; perPage?: number } }> = [];
const redeliverCalls: Array<string> = [];

vi.mock('../../src/github/webhook-deliveries.ts', () => ({
  listFailedWebhookDeliveries: async (
    _env: unknown,
    opts?: { maxPages?: number; perPage?: number },
  ) => {
    listCalls.push({ opts });
    return failedDeliveries;
  },
  redeliverWebhookDelivery: async (_env: unknown, deliveryId: string) => {
    redeliverCalls.push(deliveryId);
    return redeliverResults[deliveryId] ?? true;
  },
}));

let env: TestEnv;

// Decision: The mocked deliveries client doesn't read the App secrets, so any non-empty values open the gate.
function envWithApp(): ApiEnv['Bindings'] {
  return {
    ...env,
    GITHUB_APP_ID: 'app-id',
    GITHUB_APP_PRIVATE_KEY: 'app-key',
  } as unknown as ApiEnv['Bindings'];
}

function envWithoutApp(): ApiEnv['Bindings'] {
  return {
    ...env,
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
  } as unknown as ApiEnv['Bindings'];
}

function delivery(
  overrides: Partial<FailedWebhookDelivery> & { id: string },
): FailedWebhookDelivery {
  return {
    guid: `guid-${overrides.id}`,
    event: 'push',
    statusCode: 500,
    deliveredAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
  failedDeliveries = [];
  redeliverResults = {};
  listCalls.length = 0;
  redeliverCalls.length = 0;
});

describe('replayFailedWebhookDeliveries()', () => {
  it('redelivers each failed guid once, records it, and returns correct counts', async () => {
    failedDeliveries = [
      delivery({ id: 'del-1', guid: 'g1' }),
      delivery({ id: 'del-2', guid: 'g2' }),
      delivery({ id: 'del-3', guid: 'g3' }),
    ];

    const result = await replayFailedWebhookDeliveries(envWithApp(), env.db);

    expect(result).toEqual({ scanned: 3, redelivered: 3 });
    // Decision: Redeliver POSTs the numeric delivery id, not the guid.
    expect(redeliverCalls).toEqual(['del-1', 'del-2', 'del-3']);
    const seen = await getRedeliveredGuids(env.db, ['g1', 'g2', 'g3']);
    expect(seen).toEqual(new Set(['g1', 'g2', 'g3']));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].opts?.maxPages).toBe(5);
  });

  it('skips a guid already recorded in the ledger', async () => {
    await recordWebhookRedelivery(env.db, {
      guid: 'g-known',
      deliveryId: 'del-old',
      event: 'push',
      statusCode: 500,
    });

    failedDeliveries = [
      delivery({ id: 'del-known', guid: 'g-known' }),
      delivery({ id: 'del-new', guid: 'g-new' }),
    ];

    const result = await replayFailedWebhookDeliveries(envWithApp(), env.db);

    expect(result).toEqual({ scanned: 2, redelivered: 1 });
    expect(redeliverCalls).toEqual(['del-new']);
  });

  it('attempts a duplicate guid within the batch only once', async () => {
    // Decision: GitHub returns the original and an earlier redelivery of the same event. Both share the guid, so
    // the in-batch dedupe Set collapses them to one attempt.
    failedDeliveries = [
      delivery({ id: 'del-a1', guid: 'g-dup' }),
      delivery({ id: 'del-a2', guid: 'g-dup' }),
    ];

    const result = await replayFailedWebhookDeliveries(envWithApp(), env.db);

    expect(result).toEqual({ scanned: 2, redelivered: 1 });
    expect(redeliverCalls).toEqual(['del-a1']);
  });

  it('respects the maxRedeliveries cap', async () => {
    failedDeliveries = [
      delivery({ id: 'del-1', guid: 'g1' }),
      delivery({ id: 'del-2', guid: 'g2' }),
      delivery({ id: 'del-3', guid: 'g3' }),
    ];

    const result = await replayFailedWebhookDeliveries(envWithApp(), env.db, {
      maxRedeliveries: 2,
    });

    expect(result).toEqual({ scanned: 3, redelivered: 2 });
    expect(redeliverCalls).toEqual(['del-1', 'del-2']);
    const seen = await getRedeliveredGuids(env.db, ['g1', 'g2', 'g3']);
    expect(seen).toEqual(new Set(['g1', 'g2']));
  });

  it('does NOT record a guid when redeliver returns false (so a later run can retry)', async () => {
    failedDeliveries = [delivery({ id: 'del-fail', guid: 'g-fail' })];
    redeliverResults = { 'del-fail': false };

    const result = await replayFailedWebhookDeliveries(envWithApp(), env.db);

    expect(result).toEqual({ scanned: 1, redelivered: 0 });
    expect(redeliverCalls).toEqual(['del-fail']);
    const seen = await getRedeliveredGuids(env.db, ['g-fail']);
    expect(seen.size).toBe(0);
  });

  it('no-ops with no client calls when the App secrets are absent', async () => {
    failedDeliveries = [delivery({ id: 'del-1', guid: 'g1' })];

    const result = await replayFailedWebhookDeliveries(envWithoutApp(), env.db);

    expect(result).toEqual({ scanned: 0, redelivered: 0 });
    expect(listCalls).toHaveLength(0);
    expect(redeliverCalls).toHaveLength(0);
  });
});
