import { desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
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
import { newEventsSecret } from '../../billing-events.ts';
import { parseCreditPurchase } from '../../credit-purchase.ts';
import { isGraceDays, readGraceDays, writeGraceDays } from '../../credits-pause.ts';
import { isDevBypass, type ApiEnv } from '../../env.ts';
import {
  getAppPerson,
  grantAppPerson,
  listAppPeople,
  refundAppPerson,
  unblockAppPerson,
} from '../../operator/app-people.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError, pagination } from '../../operator/common.ts';
import { readPlanCatalog } from '../../plans.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { oauthClients } from '../../schema.ts';
import { renderAdminPage } from '../react/server.ts';
import type { PersonPreview } from '../react/views/AppPeoplePage.tsx';

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
    graceDays: await readGraceDays(context.get('db')),
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
app.post('/grace-days', async (context) => {
  const days = Number((await context.req.parseBody()).days);
  if (!isGraceDays(days)) {
    throw new OAuthError('invalid_request', 'Give the grace days as a number from 0 to 365.');
  }
  return executeAuditedMutation(
    context,
    operatorAuditIntent('oauth/clients/grace-days', { days }),
    async () => {
      await writeGraceDays(context.get('db'), days);
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
  const purchaseText = String(body.creditPurchase ?? '').trim();
  const creditPurchase = purchaseText ? parseCreditPurchase(json(purchaseText)) : null;
  if (purchaseText && !creditPurchase) {
    throw new OAuthError(
      'invalid_request',
      'Give credit sales a minMicros and stepMicros in whole cents, and lifeDays, each above 0. buyForOthers is true or false, and buyerDailyMicros and walletDailyMicros are above 0.',
    );
  }
  const input = {
    id: context.req.param('id'),
    plans,
    starterCreditMicros: starter || null,
    creditPurchase,
  };
  return executeAuditedMutation(
    context,
    operatorAuditIntent('oauth/clients/plans', input),
    async () => {
      await db
        .update(oauthClients)
        .set({
          plans,
          starter_credit_micros: input.starterCreditMicros,
          credit_purchase: input.creditPurchase,
        })
        .where(eq(oauthClients.id, input.id));
      return { succeeded: true, response: context.redirect('/admin/connected-apps') };
    },
  );
});
app.post('/:id/events', async (context) => {
  const db = context.get('db');
  const body = await context.req.parseBody();
  const url = String(body.eventsUrl ?? '').trim();
  const lowText = String(body.lowBalanceMicros ?? '').trim();
  const low = lowText ? Number(lowText) : 0;
  if (url && (!URL.canParse(url) || new URL(url).protocol !== 'https:')) {
    throw new OAuthError('invalid_request', 'Give an HTTPS address for billing events.');
  }
  if (!Number.isSafeInteger(low) || low < 0) {
    throw new OAuthError(
      'invalid_request',
      'Give the low mark in micros, a whole number from 0 up.',
    );
  }
  const input = {
    id: context.req.param('id'),
    eventsUrl: url || null,
    lowBalanceMicros: low,
    newSecret: body.newSecret === 'true',
  };
  return executeAuditedMutation(
    context,
    operatorAuditIntent('oauth/clients/events', input),
    async () => {
      const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, input.id));
      if (!client) {
        throw new OAuthError('invalid_client', 'Application not found.', 404);
      }
      // Decision: The secret is shown once, when it's made: for a first address, or when the operator asks for a new one.
      const secret =
        input.eventsUrl && (input.newSecret || !client.events_secret) ? newEventsSecret() : null;
      const [saved] = await db
        .update(oauthClients)
        .set({
          events_url: input.eventsUrl,
          low_balance_micros: input.lowBalanceMicros,
          ...(secret ? { events_secret: secret } : {}),
        })
        .where(eq(oauthClients.id, input.id))
        .returning();
      if (!secret) {
        return { succeeded: true, response: context.redirect('/admin/connected-apps') };
      }
      return {
        succeeded: true,
        response: await renderAdminPage(context, 'connectedApps', 'Connected apps', {
          clients: [publicOAuthClient(saved!)],
          eventsSecret: { clientId: input.id, secret },
          platformName: getPlatformDisplayName(context.env, context.req.url),
          username: context.get('user').login,
        }),
      };
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
const page = (context: Context<ApiEnv>) => ({
  platformName: getPlatformDisplayName(context.env, context.req.url),
  username: context.get('user').login,
});
app.get('/:id/people', async (context) => {
  const search = context.req.query('search')?.trim() ?? '';
  const result = await listAppPeople(
    context,
    context.req.param('id'),
    pagination(context),
    search || undefined,
  );
  return renderAdminPage(context, 'appPeople', `${result.client.name} people`, {
    result,
    search,
    ...page(context),
  });
});

type Kind = PersonPreview['kind'];
const money = (micros: number) => `${(micros / 1e6).toFixed(2)}`;

async function personPage(
  context: Context<ApiEnv>,
  extra: { previewed?: PersonPreview; notice?: string; error?: string } = {},
  status?: number,
) {
  const result = await getAppPerson(
    context,
    context.req.param('id')!,
    context.req.param('person')!,
  );
  return renderAdminPage(
    context,
    'appPerson',
    result.person,
    { result, ...extra, ...page(context) },
    status ? { status } : {},
  );
}

/** Runs one person change as a preview or for real, so both read the same form. */
async function personChange(context: Context<ApiEnv>, kind: Kind, isDryRun: boolean) {
  const clientId = context.req.param('id')!;
  const person = context.req.param('person')!;
  const form = await context.req.parseBody();
  const fields = Object.fromEntries(
    ['dollars', 'expires', 'note', 'grant']
      .filter((name) => typeof form[name] === 'string' && form[name] !== '')
      .map((name) => [name, String(form[name])]),
  );
  if (kind === 'grants') {
    return { fields, result: await grantAppPerson(context, clientId, person, fields, isDryRun) };
  }
  if (kind === 'refunds') {
    return { fields, result: await refundAppPerson(context, clientId, person, fields, isDryRun) };
  }
  return { fields, result: await unblockAppPerson(context, clientId, person, isDryRun) };
}

function previewLines(kind: Kind, result: Record<string, unknown>): Array<[string, string]> {
  if (kind === 'grants') {
    return [
      ['Give', money(Number(result.amountMicros))],
      ['Ends', String(result.expiresAt ?? 'never')],
      ['Note', String(result.note ?? '-')],
      ['Balance now', money(Number(result.balanceMicros))],
      ['Balance after', money(Number(result.balanceAfterMicros))],
    ];
  }
  if (kind === 'refunds') {
    const cents = (value: unknown) =>
      `${(Number(value) / 100).toFixed(2)} ${String(result.currency)}`;
    return [
      ['Payment', String(result.paymentIntent)],
      ['Paid', cents(result.receivedCents)],
      ['Refunded before', cents(result.refundedCents)],
      ['Unspent share', cents(result.unspentCents)],
      ['Refund', cents(result.amountCents)],
      ['Then', String(result.effect)],
    ];
  }
  return [
    ['Clear the block from', `${String(result.blockedReason)} on ${String(result.blockedAt)}`],
  ];
}

const NOTICES: Record<Kind, string> = {
  grants: 'Credits given.',
  refunds: "Refund sent. It's pending here until Stripe's refund event takes the credits off.",
  unblock: 'Block cleared.',
};

for (const kind of ['grants', 'refunds', 'unblock'] as const) {
  app.post(`/:id/people/:person/${kind}/preview`, async (context) => {
    try {
      const { fields, result } = await personChange(context, kind, true);
      return personPage(context, {
        previewed: { kind, fields, lines: previewLines(kind, result as Record<string, unknown>) },
      });
    } catch (error) {
      if (error instanceof OperatorError) {
        return personPage(context, { error: error.message }, error.status);
      }
      throw error;
    }
  });
  app.post(`/:id/people/:person/${kind}`, async (context) => {
    const clientId = context.req.param('id');
    const person = context.req.param('person');
    const form = await context.req.parseBody();
    try {
      return await executeAuditedMutation(
        context,
        operatorAuditIntent(
          `oauth/clients/${clientId}/people/${encodeURIComponent(person)}/${kind}`,
          form as Record<string, unknown>,
        ),
        async () => {
          await personChange(context, kind, false);
          return {
            succeeded: true,
            response: await personPage(context, { notice: NOTICES[kind] }),
          };
        },
      );
    } catch (error) {
      if (error instanceof OperatorError) {
        return personPage(context, { error: error.message }, error.status);
      }
      throw error;
    }
  });
}
app.get('/:id/people/:person', async (context) => personPage(context));
export default app;
