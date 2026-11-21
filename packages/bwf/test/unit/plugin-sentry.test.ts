import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { sentry, sentryWorkerConfig } from '../../src/plugin-sentry.ts';

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('sentry', () => {
  it('adds nothing when the app does not install @sentry/cloudflare', () => {
    const root = mkdtempSync(join(tmpdir(), 'bwf-sentry-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{}');
    expect(sentry(root).plugins).toEqual([]);
  });

  it('lists the Durable Objects from every config layer once, with the bwf entry as main', () => {
    expect(
      sentryWorkerConfig([
        {
          name: 'app',
          compatibility_date: '2026-11-01',
          durable_objects: { bindings: [{ name: 'BOT', class_name: 'BotDurableObject' }] },
        },
        undefined,
        {
          durable_objects: {
            bindings: [
              { name: 'BOT', class_name: 'BotDurableObject' },
              { name: 'LIVE', class_name: 'LiveDurableObject' },
            ],
          },
        },
      ]),
    ).toEqual({
      name: 'app',
      main: '.bwf/entry.ts',
      compatibility_date: '2026-11-01',
      durable_objects: {
        bindings: [
          { name: 'BOT', class_name: 'BotDurableObject' },
          { name: 'LIVE', class_name: 'LiveDurableObject' },
        ],
      },
      workflows: [],
      services: [],
    });
  });
});
