import { createDeployArtifact } from '@builtbyfriends/deploy-core';
import { eq } from 'drizzle-orm';
import { calculatePKCECodeChallenge } from 'oauth4webapi';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vite-plus/test';
import { registerOAuthClient, setOAuthPreviewPermission } from '../../src/auth/oauth.ts';
import rawApp from '../../src/index.ts';
import { APP_PERSON_GRANT } from '../../src/routes/oauth-app-person.ts';
import { oauthGrants, oauthRequests, projects, users } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createMockExecutionContext,
  type TestEnv,
  rpcData,
  withLegacyDeploy,
} from './helpers.ts';

const app = withLegacyDeploy(rawApp);
const origin = 'https://platform.example.com';
const redirect = 'https://chat.example.com/platform/callback';
const ctx = createMockExecutionContext();
const artifact = createDeployArtifact({
  manifest: { version: 3, assetManifestVersion: 2, bindings: {} },
  assetManifest: {},
  workerFiles: { 'index.js': btoa("export default { fetch() { return new Response('ok') } }") },
});

let env: TestEnv;
let registration: Awaited<ReturnType<typeof registerOAuthClient>>;
const basic = () => 'Basic ' + btoa(registration.client.id + ':' + registration.clientSecret);
const request = (path: string, init?: RequestInit) =>
  app.fetch(new Request(origin + path, init), env, ctx);
const token = (form: Record<string, string>, authorization = basic()) =>
  request('/oauth/token', {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: APP_PERSON_GRANT, ...form }),
  });
const call = (name: string, bearer: string, body: unknown) =>
  request('/app-rpc/' + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  env.AUTH_REDIRECT_URI = origin + '/auth/callback';
  delete env.DEV_AUTH_BYPASS;
  registration = await registerOAuthClient(env.db, {
    name: 'Chat',
    operator: 'App operator',
    redirectUris: [redirect],
    scopes: ['profile', 'deploy:approve'],
  });
  await setOAuthPreviewPermission(env.db, registration.client.id, true);
  (env as unknown as Record<string, string>).PLATFORM_APP_PERSON_CLIENTS =
    'other-client, ' + registration.client.id;
});

describe('app-person grant', () => {
  it('refuses clients the operator has not listed', async () => {
    (env as unknown as Record<string, string>).PLATFORM_APP_PERSON_CLIENTS = 'other-client';
    const refused = await token({ person: 'p1' });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('unauthorized_client');
    expect(await env.db.select().from(users)).toHaveLength(0);
  });

  it('refuses a wrong client secret', async () => {
    const wrong = 'Basic ' + btoa(registration.client.id + ':nope');
    expect((await token({ person: 'p1' }, wrong)).status).toBe(401);
  });

  it('makes one user per person and previews with no Platform login', async () => {
    const first = await token({ person: 'p1', login: 'samr', email: 'sam@example.com' });
    expect(first.status).toBe(200);
    const issued = (await first.json()) as { access_token: string; scope: string };
    expect(issued.scope).toBe('profile preview:deploy');
    expect(issued).not.toHaveProperty('refresh_token');

    const second = (await (await token({ person: 'p1' })).json()) as { access_token: string };
    const people = await env.db.select().from(users);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      provider: 'app:' + registration.client.id,
      provider_id: 'p1',
      login: 'samr',
      email: 'sam@example.com',
    });
    expect((await call('previews.create', issued.access_token, { workspace: 'w1' })).status).toBe(
      200,
    );
    const created = await call('previews.create', second.access_token, { workspace: 'w1' });
    expect(created.status).toBe(200);
    const preview = rpcData(await created.json()) as { project_id: string };
    const [row] = await env.db.select().from(projects).where(eq(projects.id, preview.project_id));
    expect(row.user_id).toBe(people[0].id);

    await token({ person: 'p2' });
    expect(await env.db.select().from(users)).toHaveLength(2);
  });

  it("drops a person's expired grants as it makes new ones", async () => {
    await token({ person: 'p1' });
    await env.db.update(oauthGrants).set({ expires_at: new Date(Date.now() - 1000).toISOString() });
    await token({ person: 'p1' });
    const grants = await env.db.select().from(oauthGrants);
    expect(grants).toHaveLength(1);
    expect(Date.parse(grants[0].expires_at)).toBeGreaterThan(Date.now());
  });

  it('does not grant more than the client has', async () => {
    expect((await token({ person: 'p1', scope: 'profile deploy:approve' })).status).toBe(400);
    await setOAuthPreviewPermission(env.db, registration.client.id, false);
    const issued = (await (await token({ person: 'p1' })).json()) as { scope: string };
    expect(issued.scope).toBe('profile');
  });

  it('turns a publish the person approved in the app into a one-build deploy credential', async () => {
    const publish = async (payer?: string) => {
      const { access_token } = (await (await token({ person: 'p1' })).json()) as {
        access_token: string;
      };
      const response = await call('publish.request', access_token, {
        redirect_uri: redirect,
        state: 's'.repeat(32),
        code_challenge: await calculatePKCECodeChallenge('v'.repeat(64)),
        code_challenge_method: 'S256',
        slug: 'my-app',
        checkpoint: 'checkpoint-1',
        artifact,
        ...(payer ? { payer } : {}),
      });
      expect(response.status).toBe(200);
      return (rpcData(await response.json()) as { request_id: string }).request_id;
    };
    const id = await publish();

    expect((await token({ person: 'p2', publish_request: id })).status).toBe(400);

    const approved = await token({ person: 'p1', publish_request: id });
    expect(approved.status).toBe(200);
    const credential = (await approved.json()) as {
      scope: string;
      project_id: string;
      approval_id: string;
    };
    expect(credential.scope).toBe('deploy:approve');
    expect(credential).not.toHaveProperty('url');
    expect(credential.approval_id).toBe(id);
    const [project] = await env.db
      .select()
      .from(projects)
      .where(eq(projects.id, credential.project_id));
    expect(project.slug).toBe('my-app');
    expect(project.payer_person_id).toBeNull();
    const [record] = await env.db.select().from(oauthRequests).where(eq(oauthRequests.id, id));
    expect(record.approved_at).not.toBeNull();
    expect(record.consumed_at).not.toBeNull();

    expect((await token({ person: 'p1', publish_request: id })).status).toBe(400);
    const next = (await (
      await token({ person: 'p1', publish_request: await publish('p2') })
    ).json()) as {
      project_id: string;
    };
    expect(next.project_id).toBe(credential.project_id);
    const [paid] = await env.db.select().from(projects).where(eq(projects.id, next.project_id));
    expect(paid.payer_person_id).toBe('p2');
  });
});
