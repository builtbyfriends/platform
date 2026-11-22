import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  METERS,
  parseClientPlans,
  parseMeterPrices,
  readMeterPrices,
  writeMeterPrices,
} from '../../app-credits.ts';
import {
  registerOAuthClient,
  publicOAuthClient,
  disableOAuthClient,
  setOAuthPreviewPermission,
  OAuthError,
} from '../../auth/oauth.ts';
import { isDevBypass, type ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { readPlanCatalog } from '../../plans.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { oauthClients } from '../../schema.ts';
import { renderAdminPage } from '../react/server.ts';

const app = new Hono<ApiEnv>();
app.onError((error, context) =>
  renderAdminPage(
    context,
    'connectedApps',
    'Connected apps',
    {
      clients: [],
      error: error instanceof OAuthError ? error.message : 'The operation failed.',
      platformName: getPlatformDisplayName(context.env, context.req.url),
      username: context.get('user').login,
    },
    { status: error instanceof OAuthError ? error.status : 400 },
  ),
);
app.get('/', async (context) =>
  renderAdminPage(context, 'connectedApps', 'Connected apps', {
    clients: (
      await context.get('db').select().from(oauthClients).orderBy(desc(oauthClients.created_at))
    ).map(publicOAuthClient),
    meterPrices: await readMeterPrices(context.get('db')),
    meterUnits: Object.fromEntries(
      Object.entries(METERS).map(([meter, { unit }]) => [meter, unit]),
    ),
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
  }),
);
const json = (value: unknown) => {
  try {
    return JSON.parse(String(value ?? ''));
  } catch {
    return null;
  }
};
app.post('/usage-prices', async (context) => {
  const prices = parseMeterPrices(json((await context.req.parseBody()).prices));
  if (!prices) {
    throw new OAuthError('invalid_request', 'Give each meter a price in dollars, from 0 up.');
  }
  return executeAuditedMutation(
    context,
    operatorAuditIntent('oauth/clients/usage-prices', prices),
    async () => {
      await writeMeterPrices(context.get('db'), prices);
      return { succeeded: true, response: context.redirect('/admin/connected-apps') };
    },
  );
});
app.post('/:id/plans', async (context) => {
  const db = context.get('db');
  const body = await context.req.parseBody();
  const text = String(body.plans ?? '').trim();
  const starterText = String(body.starterCreditMicros ?? '').trim();
  const starter = starterText ? Number(starterText) : null;
  if (starter !== null && (!Number.isSafeInteger(starter) || starter < 0)) {
    throw new OAuthError(
      'invalid_request',
      'Give the starter credit in micros, a whole number from 0 up.',
    );
  }
  const plans = text ? parseClientPlans(json(text)) : null;
  const known = new Set((await readPlanCatalog(db)).plans.map((plan) => plan.id));
  if ((text && !plans) || Object.keys(plans ?? {}).some((id) => !known.has(id))) {
    throw new OAuthError(
      'invalid_request',
      'Give each plan from the plan catalog a stripePriceId and a creditMicros amount.',
    );
  }
  const input = { id: context.req.param('id'), plans, starterCreditMicros: starter || null };
  return executeAuditedMutation(
    context,
    operatorAuditIntent('oauth/clients/plans', input),
    async () => {
      await db
        .update(oauthClients)
        .set({ plans, starter_credit_micros: input.starterCreditMicros })
        .where(eq(oauthClients.id, input.id));
      return { succeeded: true, response: context.redirect('/admin/connected-apps') };
    },
  );
});
app.post('/', async (context) => {
  const body = await context.req.parseBody();
  const input = {
    name: body.name,
    operator: body.operator,
    redirectUris: String(body.redirectUris ?? '')
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
    scopes: [
      'profile',
      ...(body.publish === 'true' ? ['deploy:approve'] : []),
      ...(body.preview === 'true' ? ['preview:deploy'] : []),
    ],
  };
  return executeAuditedMutation(
    context,
    operatorAuditIntent('oauth/clients/register', input),
    async () => {
      const { client, clientSecret } = await registerOAuthClient(
        context.get('db'),
        input,
        isDevBypass(context.env),
      );
      return {
        succeeded: true,
        response: await renderAdminPage(context, 'connectedApps', 'Connected apps', {
          clients: [client],
          credentials: { clientId: client.id, clientSecret },
          platformName: getPlatformDisplayName(context.env, context.req.url),
          username: context.get('user').login,
        }),
      };
    },
  );
});
app.post('/:id/disable', async (context) =>
  executeAuditedMutation(
    context,
    operatorAuditIntent('oauth/clients/disable', { id: context.req.param('id') }),
    async () => {
      await disableOAuthClient(context.get('db'), context.req.param('id'));
      return { succeeded: true, response: context.redirect('/admin/connected-apps') };
    },
  ),
);
app.post('/:id/preview-permission', async (context) => {
  const body = await context.req.parseBody();
  const input = { id: context.req.param('id'), enabled: body.enabled === 'true' };
  return executeAuditedMutation(
    context,
    operatorAuditIntent('oauth/clients/preview-permission', input),
    async () => {
      await setOAuthPreviewPermission(context.get('db'), input.id, input.enabled);
      return { succeeded: true, response: context.redirect('/admin/connected-apps') };
    },
  );
});
export default app;
