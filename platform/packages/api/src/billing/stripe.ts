import type { ApiEnv } from '../env.ts';

export type StripeEnv = Pick<
  ApiEnv['Bindings'],
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_WEBHOOK_SECRET'
  | 'STRIPE_PRICE_SOLO'
  | 'STRIPE_PRICE_PRO'
  | 'STRIPE_LIVE_ENABLED'
  | 'STRIPE_AUTOMATIC_TAX'
  | 'STRIPE_PROMOTION_CODES'
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
    /** The payer's Stripe customer, when they already have one. */
    customerId?: string | null;
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
  if (input.customerId) {
    form.set('customer', input.customerId);
  } else if (input.email) {
    form.set('customer_email', input.email);
  }
  // Decision: Codes only show on subscription Checkout. Credits sell close to cost, so a discount on them is a loss.
  if (env.STRIPE_PROMOTION_CODES === 'true') {
    form.set('allow_promotion_codes', 'true');
  }
  return startCheckout(env, form, fetcher);
}

async function startCheckout(env: StripeEnv, form: URLSearchParams, fetcher: typeof fetch) {
  // Decision: Stripe refuses the session until the account's tax settings are filled in, so tax stays off by default.
  if (env.STRIPE_AUTOMATIC_TAX === 'true') {
    form.set('automatic_tax[enabled]', 'true');
    // Decision: An existing customer keeps its saved address unless Checkout may replace it with the one it collects.
    if (form.has('customer')) {
      form.set('customer_update[address]', 'auto');
    }
  }
  const body = await stripePost(env, 'checkout/sessions', form, fetcher);
  if (!body.url) {
    throw new BillingUnavailableError('Stripe refused the checkout.');
  }
  return body.url;
}

/**
 * Starts a one-time Checkout for credits. The buyer's Stripe customer is reused, or Checkout makes one.
 * `saveCard` keeps the card for auto top-up charges made with nobody present.
 */
export async function createCreditCheckoutSession(
  env: StripeEnv,
  input: {
    amountMicros: number;
    metadata: Record<string, string>;
    customerId: string | null;
    email: string | null;
    saveCard: boolean;
    returnUrl: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(input.amountMicros / MICROS_PER_CENT),
    'line_items[0][price_data][product_data][name]': 'Credits',
    success_url: input.returnUrl,
    cancel_url: input.returnUrl,
  });
  for (const [key, value] of Object.entries(input.metadata)) {
    form.set(`metadata[${key}]`, value);
    form.set(`payment_intent_data[metadata][${key}]`, value);
  }
  if (input.customerId) {
    form.set('customer', input.customerId);
  } else {
    form.set('customer_creation', 'always');
    if (input.email) {
      form.set('customer_email', input.email);
    }
  }
  if (input.saveCard) {
    form.set('payment_intent_data[setup_future_usage]', 'off_session');
  }
  return startCheckout(env, form, fetcher);
}

export const MICROS_PER_CENT = 10_000;

export type Charge =
  | { status: 'succeeded' | 'processing'; paymentIntentId: string }
  | { status: 'failed'; reason: string };

/**
 * Charges a saved card with nobody present. The idempotency key makes a retry of the same charge
 * answer the first result instead of charging again.
 */
export async function chargeSavedCard(
  env: StripeEnv,
  input: {
    customerId: string;
    paymentMethodId: string;
    amountMicros: number;
    metadata: Record<string, string>;
    idempotencyKey: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<Charge> {
  const form = new URLSearchParams({
    amount: String(input.amountMicros / MICROS_PER_CENT),
    currency: 'usd',
    customer: input.customerId,
    payment_method: input.paymentMethodId,
    confirm: 'true',
    off_session: 'true',
  });
  for (const [key, value] of Object.entries(input.metadata)) {
    form.set(`metadata[${key}]`, value);
  }
  const response = await fetcher('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${stripeSecretKey(env)}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': input.idempotencyKey,
    },
    body: form,
  });
  const body = (await response.json().catch(() => null)) as {
    id?: string;
    status?: string;
    error?: { type?: string; code?: string; decline_code?: string };
  } | null;
  if (response.ok && body?.id && (body.status === 'succeeded' || body.status === 'processing')) {
    return { status: body.status, paymentIntentId: body.id };
  }
  // Decision: Only an answer about the card turns auto top-up off. Anything else is thrown, and the same key retries it.
  if (body?.error?.type === 'card_error' || (response.ok && body?.status)) {
    return {
      status: 'failed',
      reason:
        body.error?.code === 'authentication_required' || body.status === 'requires_action'
          ? 'authentication_required'
          : 'card_declined',
    };
  }
  throw new BillingUnavailableError('Stripe refused the request.');
}

/** The card a payment was made with, so it can be charged again. */
export async function paymentMethodOf(
  env: StripeEnv,
  paymentIntentId: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const response = await fetcher(
    `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`,
    { headers: { authorization: `Bearer ${stripeSecretKey(env)}` } },
  );
  const body = (await response.json().catch(() => null)) as {
    payment_method?: string | { id?: string } | null;
  } | null;
  if (!response.ok || !body) {
    throw new BillingUnavailableError('Stripe refused the request.');
  }
  const method = body.payment_method;
  return (typeof method === 'string' ? method : method?.id) ?? null;
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

export type StripeSubscription = {
  id: string;
  status: string;
  customerId: string | null;
  priceId: string | null;
  /** The end of the current billing period, as an ISO string, or null when Stripe doesn't give one. */
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

/**
 * Reads a subscription as Stripe has it now. Newer Stripe API versions keep the period on the
 * subscription's items and older ones on the subscription, so this reads both.
 */
export async function fetchSubscription(
  env: StripeEnv,
  subscriptionId: string,
  fetcher: typeof fetch = fetch,
): Promise<StripeSubscription> {
  const response = await fetcher(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { headers: { authorization: `Bearer ${stripeSecretKey(env)}` } },
  );
  const body = (await response.json().catch(() => null)) as {
    id?: string;
    status?: string;
    customer?: string | { id?: string };
    cancel_at_period_end?: boolean;
    current_period_end?: unknown;
    items?: { data?: Array<{ current_period_end?: unknown; price?: { id?: string } }> };
  } | null;
  if (!response.ok || !body?.id || !body.status) {
    throw new BillingUnavailableError('Stripe refused the request.');
  }
  const item = body.items?.data?.[0];
  const end = item?.current_period_end ?? body.current_period_end;
  return {
    id: body.id,
    status: body.status,
    customerId: typeof body.customer === 'string' ? body.customer : (body.customer?.id ?? null),
    priceId: item?.price?.id ?? null,
    currentPeriodEnd:
      typeof end === 'number' && Number.isFinite(end) && end > 0
        ? new Date(end * 1000).toISOString()
        : null,
    cancelAtPeriodEnd: body.cancel_at_period_end === true,
  };
}

/** Ends a subscription now. Used after a card dispute. */
export async function cancelSubscription(
  env: StripeEnv,
  subscriptionId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${stripeSecretKey(env)}` } },
  );
  if (!response.ok) {
    throw new BillingUnavailableError('Stripe refused the request.');
  }
}

/** Deletes a customer and their saved cards. Stripe keeps the invoices and payments. A customer already gone counts as done. */
export async function deleteCustomer(
  env: StripeEnv,
  customerId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(
    `https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${stripeSecretKey(env)}` } },
  );
  if (!response.ok && response.status !== 404) {
    throw new BillingUnavailableError('Stripe refused the request.');
  }
}

/** What a payment took and what refunds gave back so far, in the currency's smallest unit. */
export async function paymentRefundable(
  env: StripeEnv,
  paymentIntentId: string,
  fetcher: typeof fetch = fetch,
): Promise<{ receivedCents: number; refundedCents: number; currency: string }> {
  const response = await fetcher(
    `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge`,
    { headers: { authorization: `Bearer ${stripeSecretKey(env)}` } },
  );
  const body = (await response.json().catch(() => null)) as {
    amount_received?: number;
    currency?: string;
    latest_charge?: { amount_refunded?: number } | string | null;
  } | null;
  if (!response.ok || !body) {
    throw new BillingUnavailableError('Stripe refused the request.');
  }
  const charge = typeof body.latest_charge === 'object' ? body.latest_charge : null;
  return {
    receivedCents: body.amount_received ?? 0,
    refundedCents: charge?.amount_refunded ?? 0,
    currency: body.currency ?? 'usd',
  };
}

/**
 * Refunds part of a payment. The key makes a second click before Stripe's event arrives return the
 * same refund instead of a new one.
 */
export async function createRefund(
  env: StripeEnv,
  refund: { paymentIntentId: string; amountCents: number; metadata: Record<string, string> },
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<{ id: string; status: string }> {
  const form = new URLSearchParams({
    payment_intent: refund.paymentIntentId,
    amount: String(refund.amountCents),
  });
  for (const [key, value] of Object.entries(refund.metadata)) {
    form.set(`metadata[${key}]`, value);
  }
  const response = await fetcher('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${stripeSecretKey(env)}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': idempotencyKey,
    },
    body: form,
  });
  const body = (await response.json().catch(() => null)) as { id?: string; status?: string } | null;
  if (!response.ok || !body?.id) {
    throw new BillingUnavailableError('Stripe refused the refund.');
  }
  return { id: body.id, status: body.status ?? 'pending' };
}

/**
 * The payment intent that paid an invoice. Newer Stripe API versions leave it off the invoice and
 * list it under the invoice's payments, which have to be asked for.
 */
export async function invoicePaymentIntent(
  env: StripeEnv,
  invoiceId: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const response = await fetcher(
    `https://api.stripe.com/v1/invoices/${encodeURIComponent(invoiceId)}?expand[]=payments`,
    { headers: { authorization: `Bearer ${stripeSecretKey(env)}` } },
  );
  const body = (await response.json().catch(() => null)) as {
    payments?: { data?: Array<{ payment?: { payment_intent?: string | { id?: string } } }> };
  } | null;
  if (!response.ok || !body) {
    throw new BillingUnavailableError('Stripe refused the request.');
  }
  for (const entry of body.payments?.data ?? []) {
    const intent = entry.payment?.payment_intent;
    const id = typeof intent === 'string' ? intent : intent?.id;
    if (id) {
      return id;
    }
  }
  return null;
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
  const expected = await hmacHex(secret, `${timestamp}.${body}`);
  return signatures.some((s) => sameText(s, expected));
}

/** HMAC-SHA256 of the text, as hex. Stripe signs its events this way, and Platform signs its own the same way. */
export async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}
