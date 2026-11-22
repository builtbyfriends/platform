import type { ApiEnv } from '../env.ts';

type StripeEnv = Pick<
  ApiEnv['Bindings'],
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_WEBHOOK_SECRET'
  | 'STRIPE_PRICE_SOLO'
  | 'STRIPE_PRICE_PRO'
  | 'STRIPE_LIVE_ENABLED'
>;

/** The paid plans a person can buy, and the env value that holds each one's Stripe price id. */
export const PAID_PLANS = { solo: 'STRIPE_PRICE_SOLO', pro: 'STRIPE_PRICE_PRO' } as const;
export type PaidPlan = keyof typeof PAID_PLANS;

export class BillingUnavailableError extends Error {}

/**
 * Billing runs in Stripe test mode until someone sets STRIPE_LIVE_ENABLED to "true".
 * A live key without that flag is refused, so a real charge needs a deliberate step.
 */
export function stripeSecretKey(env: StripeEnv): string {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new BillingUnavailableError('Billing is not set up.');
  }
  if (
    !key.startsWith('sk_test_') &&
    !key.startsWith('rk_test_') &&
    env.STRIPE_LIVE_ENABLED !== 'true'
  ) {
    throw new BillingUnavailableError('Live billing is switched off.');
  }
  return key;
}

/** True when the installation's Stripe key is a live key. Without a key it counts as test mode. */
export function stripeLiveMode(env: Pick<StripeEnv, 'STRIPE_SECRET_KEY'>): boolean {
  const key = env.STRIPE_SECRET_KEY;
  return Boolean(key) && !key!.startsWith('sk_test_') && !key!.startsWith('rk_test_');
}

function priceFor(env: StripeEnv, plan: string): string {
  const price = Object.hasOwn(PAID_PLANS, plan) ? env[PAID_PLANS[plan as PaidPlan]] : undefined;
  if (!price) {
    throw new BillingUnavailableError(`No Stripe price is set for the ${plan} plan.`);
  }
  return price;
}

/**
 * Starts a subscription Checkout for a plan. `metadata` rides along on the session and the
 * subscription, so the webhook knows whose plan to change.
 */
export async function createCheckoutSession(
  env: StripeEnv,
  input: {
    reference: string;
    metadata: Record<string, string>;
    email: string | null;
    plan: string;
    /** The Stripe price to charge. Without it, the plan's price from the environment. */
    priceId?: string;
    returnUrl: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const form = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': input.priceId || priceFor(env, input.plan),
    'line_items[0][quantity]': '1',
    client_reference_id: input.reference,
    success_url: input.returnUrl,
    cancel_url: input.returnUrl,
  });
  for (const [key, value] of Object.entries({ ...input.metadata, plan: input.plan })) {
    form.set(`metadata[${key}]`, value);
    form.set(`subscription_data[metadata][${key}]`, value);
  }
  if (input.email) {
    form.set('customer_email', input.email);
  }
  const body = await stripePost(env, 'checkout/sessions', form, fetcher);
  if (!body.url) {
    throw new BillingUnavailableError('Stripe refused the checkout.');
  }
  return body.url;
}

/** A link to Stripe's customer portal, where a person changes or cancels their subscription. */
export async function createPortalSession(
  env: StripeEnv,
  input: { customerId: string; returnUrl: string },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const body = await stripePost(
    env,
    'billing_portal/sessions',
    new URLSearchParams({ customer: input.customerId, return_url: input.returnUrl }),
    fetcher,
  );
  if (!body.url) {
    throw new BillingUnavailableError('Stripe refused the portal link.');
  }
  return body.url;
}

/**
 * When a subscription renews: the end of its current billing period, as an ISO string, or null
 * when Stripe doesn't give one. Newer Stripe API versions keep the period on the subscription's
 * items and older ones on the subscription, so this reads both.
 */
export async function subscriptionRenewsAt(
  env: StripeEnv,
  subscriptionId: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const response = await fetcher(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { headers: { authorization: `Bearer ${stripeSecretKey(env)}` } },
  );
  const body = (await response.json().catch(() => null)) as {
    current_period_end?: unknown;
    items?: { data?: Array<{ current_period_end?: unknown }> };
  } | null;
  if (!response.ok || !body) {
    throw new BillingUnavailableError('Stripe refused the request.');
  }
  const end = body.items?.data?.[0]?.current_period_end ?? body.current_period_end;
  return typeof end === 'number' && Number.isFinite(end) && end > 0
    ? new Date(end * 1000).toISOString()
    : null;
}

async function stripePost(
  env: StripeEnv,
  path: string,
  form: URLSearchParams,
  fetcher: typeof fetch,
): Promise<{ url?: string }> {
  const response = await fetcher(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${stripeSecretKey(env)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  const body = (await response.json().catch(() => null)) as { url?: string } | null;
  if (!response.ok || !body) {
    throw new BillingUnavailableError('Stripe refused the request.');
  }
  return body;
}

const TOLERANCE_SECONDS = 300;

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Checks the `Stripe-Signature` header against the raw body, and that it's recent. */
export async function verifyStripeSignature(
  body: string,
  header: string | null,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (!header) {
    return false;
  }
  const parts = header.split(',').map((p) => p.trim().split('='));
  const timestamp = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
    return false;
  }
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = hex(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)),
  );
  return signatures.some((s) => sameText(s, expected));
}
