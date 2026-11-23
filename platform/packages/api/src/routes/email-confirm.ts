/**
 * Token-authenticated endpoint for the platform-side destination verification
 * link. The HMAC-signed token IS the auth — it
 * embeds (project_id, destination_id, address, exp) and is validated
 * against EMAIL_SIGNING_SECRET. Opening the link (GET) only shows a Confirm
 * button and never writes, because mail security scanners fetch every link
 * in a message. The button's POST flips the destination row to
 * 'verified'; single use is enforced by DB state, so a second POST finds an
 * already-verified row and returns idempotent success.
 *
 * The email gateway exposes the public URL and relays this exact route through
 * its API service binding. Access middleware recognizes only this token-auth
 * route; project and operator routes remain protected.
 *
 * See the email design's recipient-consent section for the trust boundary.
 */

import { browserPageLead, browserPageStatus } from '@builtbyfriends/platform/browser-page';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { verifyConfirmToken } from '../auth/confirm-token.ts';
import { platformBrowserPage } from '../browser-page.ts';
import { getEmailDestinationById, getProject, updateEmailDestinationStatus } from '../db.ts';
import { escapeHtml } from '../email.ts';
import type { ApiEnv } from '../env.ts';
import type { EmailDestination } from '../types.ts';

const app = new Hono<ApiEnv>();

// Decision: Keep the single-use confirmation token from leaking through shared caches or `Referer` to pages the
// success page links to. Until it's consumed, a cache or Referer could let a later visitor flip the
// row.
app.use('/destinations/confirm', async (context, next) => {
  await next();
  context.res.headers.set('cache-control', 'no-store');
  context.res.headers.set('referrer-policy', 'no-referrer');
});

type ConfirmTarget = Readonly<{
  row: EmailDestination;
  slug: string;
  token: string;
}>;

/** Validates the token and loads the destination row it names. */
async function loadConfirmTarget(context: Context<ApiEnv>): Promise<ConfirmTarget | Response> {
  const token = context.req.query('token');
  if (!token) {
    return platformBrowserPage(
      context,
      'Confirmation failed',
      errorPage('Missing confirmation token.'),
      400,
    );
  }

  const payload = await verifyConfirmToken(token, context.env.EMAIL_SIGNING_SECRET);
  if (!payload) {
    // Decision: Don't tell bad signature, expired and malformed apart on the page; they're all "this link no longer
    // works". Tail logs still show the distinct outcomes.
    return platformBrowserPage(
      context,
      'Confirmation failed',
      errorPage(
        'This link is invalid or has expired. Ask the project to resend the confirmation email.',
      ),
      400,
    );
  }

  const row = await getEmailDestinationById(context.get('db'), payload.did);
  if (!row || row.project_id !== payload.pid || row.address !== payload.addr) {
    // Decision: The token's claims don't match a real destination row: deleted between issue and click, tampered,
    // or a replay with a mismatched project or address. All of these get 404.
    return platformBrowserPage(
      context,
      'Confirmation failed',
      errorPage('Destination not found.'),
      404,
    );
  }

  const project = await getProject(context.get('db'), row.project_id);
  return { row, slug: project?.slug ?? row.project_id, token };
}

// Decision: Mail security scanners open each link in a message, so opening the link only shows the Confirm
// button; consent is the POST that button sends.
app.get('/destinations/confirm', async (context) => {
  const target = await loadConfirmTarget(context);
  if (target instanceof Response) {
    return target;
  }
  if (target.row.status === 'verified') {
    return platformBrowserPage(
      context,
      'Email confirmed',
      successPage(target.slug, target.row.address, true),
    );
  }
  return platformBrowserPage(
    context,
    'Confirm email permission',
    consentPage(target.slug, target.row.address, target.token),
  );
});

app.post('/destinations/confirm', async (context) => {
  const target = await loadConfirmTarget(context);
  if (target instanceof Response) {
    return target;
  }
  const { row, slug } = target;

  if (row.status === 'verified') {
    return platformBrowserPage(context, 'Email confirmed', successPage(slug, row.address, true));
  }

  const updated = await updateEmailDestinationStatus(
    context.get('db'),
    row.id,
    'verified',
    row.cf_destination_id ?? null,
    new Date().toISOString(),
    // Decision: Keep verification_source='platform' on the row: the audit trail says the recipient clicked the
    // platform link, not that CF verified it. Pass undefined so the existing source stays.
    undefined,
  );
  if (!updated) {
    return platformBrowserPage(
      context,
      'Confirmation failed',
      errorPage('Destination not found.'),
      404,
    );
  }

  return platformBrowserPage(context, 'Email confirmed', successPage(slug, row.address, false));
});

function consentPage(slug: string, address: string, token: string): string {
  return `<div class="platform-auth-lead"><h1 id="platform-auth-title">Allow ${escapeHtml(slug)} to email ${escapeHtml(address)}?</h1>
<p>The Platform project <strong>${escapeHtml(slug)}</strong> wants permission to send email to <strong>${escapeHtml(address)}</strong>.</p></div>
<form method="post" action="?token=${escapeHtml(token)}"><button class="platform-auth-button platform-auth-button-primary" type="submit">Confirm</button></form>
<p class="platform-auth-note">If you didn't expect this, close this page. No permission is granted until you select Confirm.</p>`;
}

function successPage(slug: string, address: string, alreadyVerified: boolean): string {
  const heading = alreadyVerified ? 'Already confirmed' : 'Email confirmed';
  const lead = alreadyVerified
    ? `<strong>${escapeHtml(slug)}</strong> is already authorized to send email to <strong>${escapeHtml(address)}</strong>.`
    : `You've authorized <strong>${escapeHtml(slug)}</strong> to send email to <strong>${escapeHtml(address)}</strong>.`;
  return (
    browserPageStatus('success') +
    `<div class="platform-auth-lead"><h1 id="platform-auth-title">${heading}</h1>
<p>${lead}</p></div>
<p class="platform-auth-note">If you didn't expect this, ignore future emails from this project — no further permission will be granted without your action.</p>`
  );
}

function errorPage(message: string): string {
  return browserPageStatus('error') + browserPageLead('Confirmation failed', message);
}

export default app;
