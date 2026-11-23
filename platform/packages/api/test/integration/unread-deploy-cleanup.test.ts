import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { getUser } from '../../src/db.ts';
import { handleManifestOnlyDeploy } from '../../src/deploy/execute.ts';
import type { ApiEnv } from '../../src/env.ts';
import { deployments } from '../../src/schema.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  mockCfApi,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { setGetProjectOverride } from './setup.ts';

// Decision: A JSON deploy keeps running after its response is returned, until the NDJSON body is read. On
// PostgreSQL the deploy locks the project row and then the deployment row, while clearTables
// deletes deployments before projects, so the two deadlock. PGlite has one connection, so only real
// PostgreSQL shows this.
//
// deploy.finalize reads the inline stream to the end before it answers, so it can't leave one
// unread. The test calls the admission handler the procedure wraps, as a caller that stops at the
// status would.
const postgres = it.runIf(Boolean(process.env.BWF_TEST_DATABASE_URL));
const HASH = (n: number) => n.toString(16).padStart(32, '0');

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  setGetProjectOverride(null);
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
});

async function lockWaitOrTimeout(limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const { rows } = (await env.db.execute(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    )) as unknown as { rows: Array<{ n: number }> };
    if (rows[0].n > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('fixture cleanup after an unread deploy stream', () => {
  postgres('leaves a JSON deploy unread while it holds the project row lock', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'unread-deploy');
    mockCfApi();
    const bytes = new TextEncoder().encode('<h1>hi</h1>');
    await env.STATIC_ASSETS_R2.put(`assets/${project.id}/${HASH(1)}`, bytes.buffer);

    let reached!: () => void;
    const locked = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    setGetProjectOverride(async ({ original, argsList }) => {
      const [db, id] = argsList;
      if (db !== env.db) {
        // Decision: A saved placeholder row means this is the manifest transaction, which already holds
        // `SELECT ... FROM projects ... FOR UPDATE`.
        const { rows } = (await env.db.execute(
          sql`select count(*)::int as n from deployments where project_id = ${id}`,
        )) as unknown as { rows: Array<{ n: number }> };
        if (rows[0].n > 0) {
          setGetProjectOverride(null);
          reached();
          await gate;
        }
      }
      return original(...argsList);
    });

    const actor = await getUser(env.db, user.id);
    const deployApp = new Hono<ApiEnv>()
      .use('*', async (context, next) => {
        context.set('db', env.db);
        context.set('user', actor!);
        await next();
      })
      .post('/:id/deploy', handleManifestOnlyDeploy);
    const res = await deployApp.fetch(
      new Request(`http://localhost/${project.id}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: {
            version: 3,
            assetManifestVersion: 2,
            bindings: {},
            type: 'spa',
            assetConfig: { not_found_handling: 'single-page-application' },
          },
          assetManifest: {
            '/index.html': { blake3: HASH(1), md5: HASH(2), size: bytes.byteLength },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await locked;
    // Decision: Let the deploy continue once the next cleanup waits on its lock, or after a short bound when the
    // harness finishes the deploy before cleanup.
    void lockWaitOrTimeout(1000).then(release);
  });

  postgres('starts the next test only after that deploy finished', async () => {
    // Decision: The harness drains the unread deploy before beforeEach(clearTables), which would otherwise
    // deadlock with it (40P01).
    expect(await env.db.select().from(deployments)).toEqual([]);
  });
});
