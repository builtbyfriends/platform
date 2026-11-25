import { isRecord } from '@builtbyfriends/deploy-core';
import { usageLimitResponse } from '@builtbyfriends/edge';
import { verifyEmailReceipt } from '@builtbyfriends/platform/email-protocol';
import { isProjectId } from '@platform-service/api/id';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ai } from './ai.ts';
import { asString } from './body.ts';
import { proxyCapabilityEnabled } from './capabilities.ts';
import { d1 } from './d1.ts';
import { email } from './email.ts';
import { github } from './github.ts';
import { guardHumanStream } from './human-stream.ts';
import { kv } from './kv.ts';
import { PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE } from './platform-lifecycle.ts';
import { verifyTenantProxyToken } from './proxy-token.ts';
import { r2 } from './r2.ts';
import { readRequestJson, requestBodyMaxBytes, RequestBodyError } from './request-body.ts';
import { verifyProjectDeployAccess } from './resolve.ts';
import type { JwtPayload, ProxyBody, ProxyEnv } from './types.ts';

const app = new Hono<ProxyEnv>();

app.use('/*', async (context, next) => {
  const healthProbeToken = context.env.PLATFORM_HEALTH_PROBE_TOKEN;
  const installerProbe =
    healthProbeToken !== undefined &&
    healthProbeToken !== '' &&
    context.req.path === '/health' &&
    context.req.header('X-Platform-Probe') === healthProbeToken;
  if (
    !installerProbe &&
    (context.env.PLATFORM_TRAFFIC_STATE === 'staging' ||
      context.env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain' ||
      (context.env.PLATFORM_INSTALLATION_ID &&
        (await context.env.ROUTING.get(PLATFORM_DISABLED_KEY)) === PLATFORM_DISABLED_VALUE))
  ) {
    return context.json({ error: 'Platform disabled' }, 503);
  }
  await next();
});

app.use(
  '/*',
  cors({
    origin: '*',
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['content-type', 'authorization'],
  }),
);

app.get('/health', (context) =>
  context.json({
    ok: true,
    bindings: {
      ai: !!context.env.AI,
      kv: !!context.env.ROUTING,
      jwt: !!context.env.JWT_SECRET,
      api: !!context.env.API,
      sendEmail: !!context.env.SEND_EMAIL,
      emailDomain: !!context.env.EMAIL_SENDER_DOMAIN,
    },
  }),
);

app.all('/*', async (context, next) => {
  if (context.req.method !== 'POST') {
    return context.json({ error: 'method not allowed' }, 405);
  }
  await next();
});

// Decision: The tenant calls this over its internal service binding. EMAIL_SIGNING_SECRET never enters the
// tenant, so a project token can't mint a gateway receipt.
app.post('/email/verify-receipt', async (context) => {
  let body: unknown;
  try {
    body = await readRequestJson(context.req.raw, 2 * 1024);
  } catch {
    return context.json({ valid: false }, 400);
  }
  if (!body || typeof body !== 'object') {
    return context.json({ valid: false }, 400);
  }
  const input = body as Record<string, unknown>;
  if (
    typeof input.projectId !== 'string' ||
    input.projectId.length > 128 ||
    typeof input.deploymentId !== 'string' ||
    input.deploymentId.length > 128 ||
    typeof input.recipient !== 'string' ||
    input.recipient.length > 320 ||
    typeof input.receipt !== 'string' ||
    input.receipt.length > 1536
  ) {
    return context.json({ valid: false }, 400);
  }
  if (!isProjectId(input.projectId)) {
    return context.json({ valid: false }, 403);
  }
  const tokenCheck = await verifyTenantProxyToken(
    context.env,
    input.projectId,
    context.req.header('x-platform-internal') ?? '',
  );
  if (tokenCheck !== 'ok') {
    return context.json({ valid: false }, tokenCheck === 'unavailable' ? 503 : 403);
  }
  if (!context.env.EMAIL_SIGNING_SECRET) {
    return context.json({ valid: false }, 503);
  }
  const claims = await verifyEmailReceipt(input.receipt, context.env.EMAIL_SIGNING_SECRET, {
    projectId: input.projectId,
    deploymentId: input.deploymentId,
    recipient: input.recipient,
  });
  return context.json({ valid: claims !== null, receiptId: claims?.receiptId });
});

// Decision: The old relay endpoint is gone. It's rejected before the JSON auth middleware, so an untrusted
// MIME stream is never parsed or buffered here.
app.post('/email/relay', (context) => context.json({ error: 'not found' }, 404));

app.post('/*', async (context, next) => {
  const url = new URL(context.req.url);
  const path = url.pathname;

  // Decision: Credentials are checked before buffering up to 8 MiB of JSON. Body tokens come only from
  // deployed Workers over the __PLATFORM_PROXY service binding, which calls bare hosts
  // (https://ai-proxy, https://proxy, https://email-proxy). Public hostnames contain a dot, so a
  // public request without a header is refused unread.
  const authHeader = context.req.header('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const payload = token ? await verifyJwt(token, context.env.JWT_SECRET) : null;
  if (authHeader !== undefined && !payload) {
    return context.json(
      {
        error: 'invalid or expired token',
        message:
          'This proxy credential is invalid or expired. Sign in to the connected platform again for remote development.',
      },
      401,
    );
  }
  if (authHeader === undefined && url.hostname.includes('.')) {
    return context.json(
      {
        error: 'authorization required',
        message: 'Send a Platform token in the Authorization header.',
      },
      401,
    );
  }

  let body: ProxyBody;
  try {
    // Decision: Five MiB of MIME expands to about seven MiB of base64, plus JSON metadata.
    const maxBytes =
      path === '/email' || path.startsWith('/email/') ? 8 * 1024 * 1024 : requestBodyMaxBytes(path);
    const json = await readRequestJson(context.req.raw, maxBytes);
    if (!isRecord(json)) {
      return context.json({ error: 'invalid JSON body' }, 400);
    }
    body = json;
  } catch (error) {
    if (path !== '/email' && !path.startsWith('/email/') && error instanceof RequestBodyError) {
      return context.json({ error: error.message }, error.status);
    }
    return context.json({ error: 'invalid JSON body' }, 400);
  }
  context.set('body', body);

  let revalidateHuman: (() => Promise<boolean>) | undefined;
  if (payload) {
    const projectId = asString(body.projectId);
    if (!projectId) {
      return context.json({ error: 'projectId required' }, 400);
    }
    const checkOwner = () =>
      verifyProjectDeployAccess(
        context.env.API,
        context.env.JWT_SECRET,
        projectId,
        payload.sub,
        token,
        context.req.header('Cf-Access-Jwt-Assertion'),
        new URL(context.req.url).origin,
      );
    revalidateHuman = async () => payload.exp > Date.now() / 1000 && (await checkOwner());
    if (!(await revalidateHuman())) {
      return context.json(
        {
          error: 'forbidden',
          message:
            'Remote access could not be authorized. Check the selected platform and project, then ask a project admin or owner to confirm your access. If your access is correct, retry shortly.',
        },
        403,
      );
    }
    context.set('projectId', projectId);
  } else {
    const projectId = asString(body.projectId);
    const aiToken = asString(body.aiToken);
    if (!projectId || !aiToken) {
      return context.json({ error: 'projectId and aiToken required' }, 400);
    }
    if (!isProjectId(projectId)) {
      return context.json({ error: 'invalid project token' }, 403);
    }
    const tokenCheck = await verifyTenantProxyToken(context.env, projectId, aiToken);
    if (tokenCheck === 'unavailable') {
      return context.json({ error: 'project token state unavailable' }, 503);
    }
    if (tokenCheck === 'invalid') {
      return context.json({ error: 'invalid project token' }, 403);
    }
    context.set('projectId', projectId);
  }

  await next();
  if (
    revalidateHuman &&
    context.res.body &&
    (context.res.headers.get('content-type')?.includes('text/event-stream') ||
      path.startsWith('/ai/') ||
      path === '/r2/get')
  ) {
    context.res = new Response(
      guardHumanStream(context.res.body, revalidateHuman, context.req.raw.signal),
      context.res,
    );
  }
});

// Decision: The installation capability is checked before spending quota or calling AI.
app.post('/ai/*', async (context, next) => {
  if (!proxyCapabilityEnabled(context.env.PLATFORM_CAPABILITIES, 'ai')) {
    return context.json(
      {
        error: 'platform capability unavailable',
        capability: 'ai',
        message: 'This Platform does not enable AI.',
      },
      501,
    );
  }
  const projectId = context.get('projectId');
  const [suspended, aiBlocked] = await Promise.all([
    context.env.ROUTING.get(`project-suspended:${projectId}`, { cacheTtl: 60 }),
    context.env.ROUTING.get(`ai-block:${projectId}`, { cacheTtl: 60 }),
  ]);
  if (suspended) {
    return context.json({ error: 'app unavailable', message: "This app isn't available." }, 403);
  }
  if (aiBlocked) {
    return usageLimitResponse({
      code: 'usage_limit',
      resource: 'ai',
      reason: 'monthly_quota',
      message: 'AI usage limit exceeded',
    });
  }
  await next();
});

// Decision: A deployed worker on a platform without the email module still holds __PLATFORM_PROXY and a
// valid token, so `sendEmail()` with an explicit `from` reaches /email/send. Without this gate it
// would hit configuration errors, or send if the bindings were left in place.
app.post('/email/*', async (context, next) => {
  if (!proxyCapabilityEnabled(context.env.PLATFORM_CAPABILITIES, 'email')) {
    return context.json(
      {
        error: 'platform capability unavailable',
        capability: 'email',
        message: 'This Platform does not enable email.',
      },
      501,
    );
  }
  await next();
});

app.route('/ai', ai);
app.route('/d1', d1);
app.route('/kv', kv);
app.route('/r2', r2);
app.route('/email', email);
app.route('/github', github);

export default { fetch: app.fetch };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedVerifyKey: CryptoKey | undefined;
let cachedKeySecret: string | undefined;

async function getVerifyKey(secret: string): Promise<CryptoKey> {
  if (cachedVerifyKey && cachedKeySecret === secret) {
    return cachedVerifyKey;
  }
  cachedVerifyKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  cachedKeySecret = secret;
  return cachedVerifyKey;
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded);
  return Uint8Array.from(binary, (context) => context.charCodeAt(0));
}

async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [header, body, signature] = parts;

  try {
    const key = await getVerifyKey(secret);
    const sigBytes = base64urlDecode(signature);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes.buffer as ArrayBuffer,
      encoder.encode(`${header}.${body}`),
    );
    if (!valid) {
      return null;
    }

    const payload = JSON.parse(decoder.decode(base64urlDecode(body))) as JwtPayload;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) {
      return null;
    }

    if (payload.aud !== 'api') {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
