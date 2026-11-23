/**
 * Email on the developer's own Cloudflare account, shared by `bwf deploy --platform cloudflare`
 * and `bwf email setup|status --platform cloudflare`. Every Cloudflare call is injected:
 * `deriveAddresses` maps handlers to `addresses`, `preflightEmail` reads state without writing,
 * `renderEmailChecklist` shows it, and `applyEmailSetup` runs only the rows not ready.
 */
import type {
  CloudflareOperation,
  CloudflareCommandResult,
} from '@builtbyfriends/deploy-cloudflare';
import { isRecord } from '@builtbyfriends/deploy-core';
import type { EmailHandlersScan } from '../router/email.ts';
import { errorCode } from './error-code.ts';
import { isJsonArray, isJsonObject } from './json-value.ts';
import type { JsonObject } from './json-value.ts';
import { findBindingNameOwner } from './wrangler.ts';

/** The `send_email` binding name bwf provisions and the runtime reads. */
export const SEND_EMAIL_BINDING = 'SEND_EMAIL';

/** The root-config `vars` key carrying `bwf.config.ts` `email.from` into the worker. */
export const EMAIL_FROM_VAR = '__PLATFORM_EMAIL_FROM';

const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';

/** OAuth scopes the session needs (`whoami` `tokenPermissions`). */
const SENDING_SCOPES = ['email_sending:write'];
const INBOUND_SCOPES = ['email_routing:write', ...SENDING_SCOPES];

/** Cloudflare Email API error codes with a known meaning; others are reported verbatim. */
const CF_EMAIL_ERROR_CODES = new Map<number, string>([
  [2062, 'Email Routing is not enabled on this zone'],
  [2040, 'already onboarded for Email Sending'],
  [2036, 'account is not entitled to Email Sending'],
  [10_105, 'account is not entitled to Email Sending'],
]);

/** The one-time dashboard step printed when the subdomain routing call cannot be made. */
export function subdomainDashboardFallback(apex: string, domain: string): string {
  return `Cloudflare dashboard → ${apex} → Email → Settings → Subdomains → add ${domain}, then redeploy`;
}

/** The Workers Free hint printed when Email Sending onboarding fails. */
export const SENDING_FREE_PLAN_HINT =
  'Workers Paid needed for arbitrary recipients. Inbound works; sendEmail() to verified destinations only.';

const CLOUDFLARE_WORKERS_PAID_URL = 'https://dash.cloudflare.com/?to=/:account/workers/plans';

/**
 * Why a sending-only app (no `email/` handlers) has no working sender: it sends only through
 * Email Sending, which Workers Free does not offer. Names the plan, its link and the token
 * permissions a sending-only setup needs.
 */
export function formatSendingOnlyPaidHint(domain: string): Array<string> {
  return [
    `Email Sending is not onboarded on ${domain}. Apps without email/ handlers send through Cloudflare Email Sending, which requires the Workers Paid plan.`,
    `Enable Workers Paid: ${CLOUDFLARE_WORKERS_PAID_URL}`,
    'After upgrading, run `bwf email setup --platform cloudflare`. An API token needs Zone Read + Email Sending Edit.',
  ];
}

/**
 * A sending-only app whose saved setup (the committed binding) still waits for Email Sending
 * onboarding, with nothing else in the way. Preflight cannot tell Workers Free from a domain
 * never onboarded, so deploys leave the retry to `bwf email setup` instead of asking again.
 */
export function isAwaitingSendingOnboarding(pre: EmailPreflight): boolean {
  return (
    !pre.ready &&
    pre.usage.handlers.length === 0 &&
    pre.binding.state === 'present' &&
    pre.sendingRetryable &&
    !pre.blockers.some((b) => b.scope === 'all')
  );
}

/** Provider results are structured at the subprocess boundary. */
export type EmailWranglerRunResult = CloudflareCommandResult;

export type EmailWranglerRun = (
  operation: CloudflareOperation,
  opts: { capture: boolean },
) => EmailWranglerRunResult | Promise<EmailWranglerRunResult>;

/** Public-DNS probes. Empty arrays mean "no record"; a throw means "could not read". */
export interface EmailDns {
  resolveMx(name: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(name: string): Promise<Array<Array<string>>>;
}

export type EmailFetch = typeof fetch;

/**
 * Inputs for `preflightEmail` / `applyEmailSetup`. `getSessionBearer` resolves `null` when
 * the session cannot be borrowed.
 */
export interface EmailCloudflareInputs {
  handlers: EmailHandlersScan;
  /** `bwf.config.ts` `email.from` — the only domain input. */
  from: string;
  /** The worker name `wrangler deploy` uploads as (rules are matched to it). */
  workerName: string;
  /** The reconciled effective account id the deploy is pinned to. */
  accountId: string;
  /** Existing root-config `send_email` array (verbatim), if any. */
  existingSendEmail?: Array<{ name?: unknown }>;
  /** Existing root-config top-level `addresses` array (verbatim), if any. */
  existingAddresses?: unknown;
  /** Existing root-config `vars` object (verbatim) — `__PLATFORM_EMAIL_FROM` is compared to `from`. */
  existingVars?: JsonObject;
  /** Writer refusals (`findEmailConfigConflicts`); each blocks before the account changes. */
  configConflicts?: Array<string>;
  /** The pinned project config used for provider operations. */
  configPath?: string;
  apiBaseUrl?: string;
  runWrangler: EmailWranglerRun;
  getSessionBearer: () => Promise<string | null>;
  fetchImpl: EmailFetch;
  dns: EmailDns;
}

/**
 * Config shapes the writer would refuse for `SEND_EMAIL` and `__PLATFORM_EMAIL_FROM`, checked
 * before anything is asked. The writer keeps the same guard, since the file can change first.
 */
export function findEmailConfigConflicts<T extends Record<string, unknown>>(
  config: T,
): Array<string> {
  // Decision: A Set: one malformed field is reported by both lookups (the owner scan reads all fields).
  const conflicts = new Set<string>();
  const check = (field: string, name: string): void => {
    let owner: string | undefined;
    try {
      owner = findBindingNameOwner(config, field, name);
    } catch (error) {
      conflicts.add(`Cloudflare config: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (owner !== undefined) {
      conflicts.add(
        `Cloudflare config already uses ${name} as a ${owner} binding; rename it in bwf.config.ts (bwf writes ${name} into ${field})`,
      );
    }
  };
  check('send_email', SEND_EMAIL_BINDING);
  check('vars', EMAIL_FROM_VAR);
  return [...conflicts];
}

function isSendEmailList(value: unknown): value is Array<{ name?: unknown }> {
  return Array.isArray(value);
}

/** The `EmailCloudflareInputs` fields read from the parsed root config. */
export function emailConfigInputs<T extends Record<string, unknown>>(
  rootConfig: T,
): Pick<
  EmailCloudflareInputs,
  'existingSendEmail' | 'existingAddresses' | 'existingVars' | 'configConflicts'
> {
  return {
    existingSendEmail: isSendEmailList(rootConfig.send_email) ? rootConfig.send_email : undefined,
    existingAddresses: rootConfig.addresses,
    existingVars: isJsonObject(rootConfig.vars) ? rootConfig.vars : undefined,
    configConflicts: findEmailConfigConflicts(rootConfig),
  };
}

export type EmailDomainMode = 'apex' | 'subdomain';

export interface DerivedEmailAddresses {
  /** Deduplicated, literal addresses first, `*@<apex>` last. */
  addresses: Array<string>;
  /** Handlers that get NO route in this mode, with the message shown to the developer. */
  refused: Array<{ handler: string; reason: string }>;
  /** `address → handler file` for the post-deploy map (catch-all listed as `*@…`). */
  routes: Array<{ address: string; handler: string }>;
}

/**
 * Host part of `email.from`, lowercased; `null` when it is not `local@host`. `bwf.config.ts`
 * also accepts the display-name form (`Acme <noreply@mail.acme.com>`, see `config.ts`),
 * so the address inside `<…>` is read when present.
 *
 * Validated per label, so an empty label or one that starts with `-` never reaches a
 * Cloudflare command argument.
 */
export function emailFromDomain(from: string): string | null {
  const bracketed = /<([^<>]*)>\s*$/.exec(from.trim());
  const address = bracketed ? bracketed[1] : from;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) {
    return null;
  }
  const host = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) {
    return null;
  }
  return host;
}

/**
 * `email/<literal>.ts` and `email/<literal>+[tag].ts` → `<literal>@<domain>`.
 * `email/_default.ts` and any dynamic local part (`[name].ts`, `[name]+[tag].ts`)
 * need a catch-all, which Cloudflare offers only on a zone apex: `*@<apex>` on the apex
 * path, refused with a message on a subdomain.
 *
 * Reuses the scanner's compiled pattern kinds rather than re-parsing filenames — the
 * grammar lives in `router/email.ts` and this must never disagree with the dispatcher.
 */
export function deriveAddresses(
  handlers: EmailHandlersScan,
  domain: string,
  mode: EmailDomainMode,
): DerivedEmailAddresses {
  const literals: Array<string> = [];
  const routes: Array<{ address: string; handler: string }> = [];
  const refused: Array<{ handler: string; reason: string }> = [];
  let needsCatchAll = false;
  const catchAllHandlers: Array<string> = [];

  for (const def of handlers.addresses) {
    const handler = `email/${def.filePath}`;
    if (def.pattern.kind === 'static' || def.pattern.kind === 'static-tag') {
      // Decision: `address` is the lowercased basename; the literal is everything before the `+`.
      const literal = def.address.split('+')[0] ?? def.address;
      const address = `${literal}@${domain}`;
      if (!literals.includes(address)) {
        literals.push(address);
      }
      routes.push({ address, handler });
      continue;
    }
    if (mode === 'subdomain') {
      refused.push({
        handler,
        reason: `a dynamic local part needs a catch-all, and a catch-all exists only on a zone apex; nothing at @${domain} reaches it`,
      });
      continue;
    }
    needsCatchAll = true;
    catchAllHandlers.push(handler);
  }

  if (handlers.defaultHandler) {
    const handler = `email/${handlers.defaultHandler}`;
    if (mode === 'subdomain') {
      refused.push({
        handler,
        reason: `a catch-all exists only on an apex; other @${domain} mail bounces`,
      });
    } else {
      needsCatchAll = true;
      catchAllHandlers.push(handler);
    }
  }

  const addresses = [...literals];
  if (needsCatchAll) {
    const catchAll = `*@${domain}`;
    addresses.push(catchAll);
    for (const handler of catchAllHandlers) {
      routes.push({ address: catchAll, handler });
    }
  }
  return { addresses, refused, routes };
}

/** The session fields read from the `auth.whoami` operation. */
export interface WhoamiJson {
  loggedIn: boolean;
  /** `OAuth Token` | `API Token` | `Global API Key`. */
  authType?: string;
  email?: string;
  accounts?: Array<{ id: string; name: string }>;
  /** Session scopes; checked only for an OAuth session. */
  tokenPermissions?: Array<string>;
}

function isWhoamiJson(data: unknown): data is WhoamiJson {
  if (!isRecord(data) || typeof data.loggedIn !== 'boolean') {
    return false;
  }
  if (
    data.tokenPermissions !== undefined &&
    (!Array.isArray(data.tokenPermissions) ||
      data.tokenPermissions.some((scope) => typeof scope !== 'string'))
  ) {
    return false;
  }
  if (
    data.accounts !== undefined &&
    (!Array.isArray(data.accounts) ||
      data.accounts.some(
        (account) =>
          !isRecord(account) || typeof account.id !== 'string' || typeof account.name !== 'string',
      ))
  ) {
    return false;
  }
  return true;
}

export function parseWhoamiJson(data: unknown): WhoamiJson | null {
  return isWhoamiJson(data) ? data : null;
}

export interface RoutingSettings {
  name: string;
  enabled: boolean;
  status: string;
  tag: string;
}

interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  to: Array<string>;
  actions: Array<string>;
}

export interface RoutingRules {
  rules: Array<RoutingRule>;
  catchAll: { enabled: boolean; actions: Array<string> } | null;
}

export interface SendingSettings {
  name: string;
  enabled: boolean;
  tag: string;
}

export function readRoutingSettings(data: unknown): RoutingSettings | null {
  return isRecord(data) &&
    typeof data.name === 'string' &&
    data.name.length > 0 &&
    typeof data.enabled === 'boolean' &&
    typeof data.status === 'string' &&
    data.status.length > 0 &&
    typeof data.tag === 'string' &&
    /^[0-9a-f]{32}$/.test(data.tag)
    ? { name: data.name, enabled: data.enabled, status: data.status, tag: data.tag }
    : null;
}

export function readRoutingRules(data: unknown): RoutingRules | null {
  if (!Array.isArray(data)) {
    return null;
  }
  const rules: Array<RoutingRule> = [];
  let catchAll: RoutingRules['catchAll'] = null;
  for (const entry of data) {
    if (
      !isRecord(entry) ||
      typeof entry.enabled !== 'boolean' ||
      !Array.isArray(entry.actions) ||
      entry.actions.length === 0 ||
      !Array.isArray(entry.matchers) ||
      entry.matchers.length === 0
    ) {
      return null;
    }
    const actions: Array<string> = [];
    for (const action of entry.actions) {
      if (!isRecord(action) || typeof action.type !== 'string') {
        return null;
      }
      if (action.type === 'drop') {
        actions.push('drop');
      } else if (action.type === 'worker' || action.type === 'forward') {
        const values = typeof action.value === 'string' ? [action.value] : action.value;
        if (
          !Array.isArray(values) ||
          values.length === 0 ||
          !values.every((value) => typeof value === 'string' && value.length > 0)
        ) {
          return null;
        }
        if (action.type === 'worker') {
          actions.push('worker:' + values.join(','));
        } else {
          actions.push('forward:' + values.join(','));
        }
      } else {
        // Decision: Unknown actions can't prove ownership or authorize taking over a rule.
        return null;
      }
    }
    const to: Array<string> = [];
    let all = false;
    for (const matcher of entry.matchers) {
      if (!isRecord(matcher)) {
        return null;
      }
      if (matcher.type === 'all') {
        all = true;
      } else if ((matcher.type === 'literal' && matcher.field === 'to') || matcher.type === 'to') {
        if (typeof matcher.value !== 'string' || matcher.value.length === 0) {
          return null;
        }
        to.push(matcher.value.toLowerCase());
      } else {
        return null;
      }
    }
    if (all) {
      if (catchAll || entry.matchers.length !== 1) {
        return null;
      }
      catchAll = { enabled: entry.enabled, actions };
    } else {
      if (
        typeof entry.id !== 'string' ||
        entry.id.length === 0 ||
        (entry.name !== undefined && typeof entry.name !== 'string')
      ) {
        return null;
      }
      rules.push({ id: entry.id, name: entry.name ?? '', enabled: entry.enabled, to, actions });
    }
  }
  return { rules, catchAll };
}

export function readSendingSettings(data: unknown): SendingSettings | null {
  if (!isRecord(data)) {
    return null;
  }
  const tag = data.tag ?? data.id;
  return typeof data.name === 'string' &&
    data.name.length > 0 &&
    typeof data.enabled === 'boolean' &&
    typeof tag === 'string' &&
    /^[0-9a-f]{32}$/.test(tag)
    ? { name: data.name, enabled: data.enabled, tag }
    : null;
}

/**
 * The `email.sending.settings` result for `domain`, built from a bearer read of
 * `GET /zones/{z}/email/sending/subdomains`: the matching row, `data: null` when the domain
 * is not listed (not onboarded), or a failure when the list could not be read.
 */
function sendingSettingsFromList(
  response: SessionBearerResponse | null,
  domain: string,
): EmailWranglerRunResult {
  if (!response?.ok || !Array.isArray(response.result)) {
    const first = response?.errors[0];
    const failure: EmailWranglerRunResult = { status: 1, stdout: '', stderr: first?.message ?? '' };
    if (first?.code) {
      failure.errorCode = first.code;
    }
    return failure;
  }
  const row = (response.result as Array<unknown>).find(
    (item) => isRecord(item) && typeof item.name === 'string' && item.name.toLowerCase() === domain,
  );
  return { status: 0, stdout: '', stderr: '', data: row ?? null };
}

function providerErrorCode(result: EmailWranglerRunResult): number | null {
  return result.errorCode ?? result.errors?.find((error) => error.code !== undefined)?.code ?? null;
}

function isHardFailure(result: EmailWranglerRunResult): boolean {
  return Boolean(result.signal) || Boolean(result.error);
}

type ReadyState = 'ready' | 'pending' | 'unknown';

interface EmailPreflightBlocker {
  /** `all` stops the whole email step; `sending` skips only Email Sending onboarding. */
  scope: 'all' | 'sending';
  message: string;
}

export interface EmailPreflight {
  from: string;
  domain: string;
  /** The zone the domain belongs to, once resolved (`domain` itself on the apex path). */
  apex: string | null;
  mode: EmailDomainMode | null;
  workerName: string;
  accountId: string;
  usage: { handlers: Array<string> };
  session: {
    state: 'ok' | 'not-logged-in' | 'missing-scopes' | 'api-key' | 'unknown';
    /** `whoami --json` `authType`; an API token's permissions are not enumerable. */
    authType?: string;
    email?: string;
    accountName?: string;
    missingScopes: Array<string>;
  };
  zone: {
    state: 'found' | 'not-found' | 'other-account' | 'partial' | 'unknown';
    zoneId?: string;
    /** `full` | `partial` | `secondary` from `GET /zones?name=`; unset without the bearer. */
    type?: string;
  };
  /** MX on the zone apex; `foreign` when a non-Cloudflare exchange answers. */
  apexMx: { state: 'empty' | 'cloudflare' | 'foreign' | 'unknown'; exchanges: Array<string> };
  /** MX on the mail domain itself (same as `apexMx` on the apex path). */
  domainMx: { state: 'empty' | 'cloudflare' | 'foreign' | 'unknown'; exchanges: Array<string> };
  routing: { state: ReadyState; status?: string; enabled?: boolean };
  /** Readable only through the bearer (`GET /zones/{z}/email/routing`); `unknown` without it. */
  subaddressing: { state: 'on' | 'off' | 'unknown' };
  sending: { state: ReadyState; dnsConflicts: Array<string> };
  rules: {
    state: ReadyState;
    mine: Array<string>;
    foreign: Array<{ address: string; owner: string }>;
    absent: Array<string>;
  };
  binding: { state: 'present' | 'absent' | 'foreign'; foreignName?: string };
  /** Root-config `vars.__PLATFORM_EMAIL_FROM` against `from` — a config row, not an account row. */
  sender: { state: 'ready' | 'stale' | 'absent' };
  addressesOwnership: { state: 'absent' | 'mine' | 'foreign'; foreign: Array<string> };
  /**
   * True when the root `addresses` array (absent, or bwf's own) is not the pruned set
   * below — a local, prompt-free rewrite, never account work, so it does not gate `ready`.
   * A stale entry left in place reaches wrangler's plan as a `conflict`.
   */
  addressesStale: boolean;
  derived: DerivedEmailAddresses;
  /** `derived.addresses` minus the foreign-routed ones — what `addresses` will hold. */
  addresses: Array<string>;
  /** Derived addresses in `addresses` with no rule yet — `wrangler deploy` creates them. */
  rulesPending: Array<string>;
  blockers: Array<EmailPreflightBlocker>;
  /**
   * True when apply would make its `sending enable` call: the row is pending and no
   * sending blocker applies. With the binding committed the row is settled, so
   * `bwf email setup` offers this retry as its own prompt.
   */
  sendingRetryable: boolean;
  /**
   * True when the app's capabilities are configured. Inbound apps may keep verified-destination
   * sending without onboarding. Sending-only apps require an onboarded sending domain.
   * Routing rules and stale sender/address config are reconciled during deployment.
   */
  ready: boolean;
}

function mxState(exchanges: Array<string>): 'empty' | 'cloudflare' | 'foreign' {
  if (exchanges.length === 0) {
    return 'empty';
  }
  return exchanges.every((x) => /\.mx\.cloudflare\.net\.?$/i.test(x)) ? 'cloudflare' : 'foreign';
}

export async function probeMx(
  dns: Pick<EmailDns, 'resolveMx'>,
  name: string,
): Promise<{ state: 'empty' | 'cloudflare' | 'foreign' | 'unknown'; exchanges: Array<string> }> {
  try {
    const records = await dns.resolveMx(name);
    const exchanges = records
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange.toLowerCase());
    return { state: mxState(exchanges), exchanges };
  } catch (error) {
    if (isNoRecord(error)) {
      return { state: 'empty', exchanges: [] };
    }
    return { state: 'unknown', exchanges: [] };
  }
}

async function probeTxt(dns: EmailDns, name: string): Promise<'present' | 'absent' | 'unknown'> {
  try {
    const records = await dns.resolveTxt(name);
    return records.length > 0 ? 'present' : 'absent';
  } catch (error) {
    return isNoRecord(error) ? 'absent' : 'unknown';
  }
}

function isNoRecord(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'ENODATA' || code === 'ENOTFOUND';
}

function describeFailure(response: SessionBearerResponse | null): string {
  if (!response) {
    // Decision: `auth token --json` failed, so no bearer could be borrowed.
    return 'could not borrow the Cloudflare session (session-bearer step failed)';
  }
  const first = response.errors[0];
  const code = first?.code ? ` [code: ${first.code}]` : '';
  const known = first?.code ? CF_EMAIL_ERROR_CODES.get(first.code) : undefined;
  return `Cloudflare answered ${response.status}${code}${known ? ` — ${known}` : first?.message ? ` — ${first.message}` : ''}`;
}

/** Candidate zone names for `mail.acme.com`: `mail.acme.com`, `acme.com`. */
function zoneCandidates(domain: string): Array<string> {
  const labels = domain.split('.');
  const out: Array<string> = [];
  for (let i = 0; i <= labels.length - 2; i += 1) {
    out.push(labels.slice(i).join('.'));
  }
  return out;
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

/**
 * Read-only preflight: session, zone, public DNS, the provider reads and, when the bearer
 * can be borrowed, the two REST reads that have no command. Nothing here writes.
 */
export async function preflightEmail(inputs: EmailCloudflareInputs): Promise<EmailPreflight> {
  const domain = emailFromDomain(inputs.from);
  if (!domain) {
    throw new Error(
      `email.from must be an address like you@mail.example.com (got ${JSON.stringify(inputs.from)})`,
    );
  }
  const apiBaseUrl = inputs.apiBaseUrl ?? CLOUDFLARE_API_BASE_URL;
  const run = async (operation: CloudflareOperation): Promise<EmailWranglerRunResult> =>
    inputs.runWrangler(
      inputs.configPath ? { ...operation, configPath: inputs.configPath } : operation,
      { capture: true },
    );

  const usageHandlers = [
    ...inputs.handlers.addresses.map((d) => `email/${d.filePath}`),
    ...(inputs.handlers.defaultHandler ? [`email/${inputs.handlers.defaultHandler}`] : []),
  ];

  const receivesEmail = usageHandlers.length > 0;
  const permissions = receivesEmail
    ? 'Email Routing Edit + Email Sending Edit'
    : 'Zone Read + Email Sending Edit';

  const pre: EmailPreflight = {
    from: inputs.from,
    domain,
    apex: null,
    mode: null,
    workerName: inputs.workerName,
    accountId: inputs.accountId,
    usage: { handlers: usageHandlers },
    session: { state: 'unknown', missingScopes: [] },
    zone: { state: 'unknown' },
    apexMx: { state: 'unknown', exchanges: [] },
    domainMx: { state: 'unknown', exchanges: [] },
    routing: { state: 'unknown' },
    subaddressing: { state: 'unknown' },
    sending: { state: 'unknown', dnsConflicts: [] },
    rules: { state: 'unknown', mine: [], foreign: [], absent: [] },
    binding: { state: 'absent' },
    sender: { state: 'absent' },
    addressesOwnership: { state: 'absent', foreign: [] },
    addressesStale: false,
    derived: { addresses: [], refused: [], routes: [] },
    addresses: [],
    rulesPending: [],
    blockers: [],
    sendingRetryable: false,
    ready: false,
  };
  const block = (scope: 'all' | 'sending', message: string): void => {
    pre.blockers.push({ scope, message });
  };
  // Decision: All writer refusals the caller precomputed land here, before anything is asked.
  for (const conflict of inputs.configConflicts ?? []) {
    block('all', conflict);
  }

  // Decision: 1. Session. Require only the email scopes this app uses. An API token's permissions can't be
  // listed, so the reads below gate it and fail closed. A Global API Key has no bearer to borrow, so
  // it's refused by name. `bwf cloudflare login` reuses a readable session, so an insufficient one is
  // told what to clear first.
  const whoami = await run({ type: 'auth.whoami' });
  const who = isHardFailure(whoami) || whoami.status !== 0 ? null : parseWhoamiJson(whoami.data);
  if (!who) {
    pre.session.state = 'unknown';
    block('all', 'could not read the Cloudflare session — run `bwf cloudflare login`');
  } else if (!who.loggedIn) {
    pre.session.state = 'not-logged-in';
    block('all', 'not logged in to Cloudflare — run `bwf cloudflare login`');
  } else {
    pre.session.authType = who.authType;
    pre.session.email = who.email;
    pre.session.accountName = who.accounts?.find((a) => a.id === inputs.accountId)?.name;
    if (who.authType === 'Global API Key') {
      pre.session.state = 'api-key';
      block(
        'all',
        `the Cloudflare session is a Global API Key (CLOUDFLARE_API_KEY), which has no bearer to borrow for ${receivesEmail ? 'the subaddressing calls' : 'zone verification'} — unset CLOUDFLARE_API_KEY, then run \`bwf cloudflare login\` or set CLOUDFLARE_API_TOKEN to a token with ${permissions}`,
      );
    } else if (who.authType === undefined || who.authType === 'OAuth Token') {
      // Decision: A missing `authType` is an older payload shape: keep the scope gate (fail closed).
      const scopes = new Set(who.tokenPermissions ?? []);
      pre.session.missingScopes = (receivesEmail ? INBOUND_SCOPES : SENDING_SCOPES).filter(
        (s) => !scopes.has(s),
      );
      if (pre.session.missingScopes.length > 0) {
        pre.session.state = 'missing-scopes';
        block(
          'all',
          `the Cloudflare session lacks ${pre.session.missingScopes.join(' + ')} — run \`bwf cloudflare logout\`, then \`bwf cloudflare login\` (one browser Allow)`,
        );
      } else {
        pre.session.state = 'ok';
      }
    } else {
      pre.session.state = 'ok';
    }
  }
  const tokenSession = pre.session.state === 'ok' && pre.session.authType !== 'OAuth Token';
  // Decision: Appended to a row an API-token session couldn't read: the likeliest cause is scope.
  const tokenHint = tokenSession
    ? ` (an API token needs ${permissions} on the zone and account)`
    : '';

  // Decision: 2. Inbound routing settings also identify the zone. Sending-only apps resolve the zone through
  // the bearer read below, without needing access to Email Routing.
  let settings: RoutingSettings | null = null;
  let settingsMiss = false;
  if (receivesEmail && pre.session.state === 'ok') {
    for (const candidate of zoneCandidates(domain)) {
      const result = await run({ type: 'email.routing.settings', domain: candidate });
      if (isHardFailure(result)) {
        settingsMiss = true;
        break;
      }
      if (result.status === 0 && result.data === null) {
        continue;
      }
      if (result.status !== 0) {
        settingsMiss = true;
        break;
      }
      settings = readRoutingSettings(result.data);
      if (!settings) {
        settingsMiss = true;
      }
      break;
    }
  }
  if (settings) {
    pre.apex = settings.name.toLowerCase();
    pre.mode = pre.apex === domain ? 'apex' : 'subdomain';
    pre.zone = { state: 'found', zoneId: settings.tag };
  } else if (settingsMiss) {
    block(
      'all',
      `could not read Email Routing settings — unknown — run \`bwf email setup --platform cloudflare\`${tokenHint}`,
    );
  } else if (receivesEmail && pre.session.state === 'ok') {
    pre.zone.state = 'not-found';
  }

  // Decision: 3. Public DNS. Foreign MX on the mail domain is the one thing bwf doesn't route over.
  if (receivesEmail) {
    pre.domainMx = await probeMx(inputs.dns, domain);
    pre.apexMx =
      pre.apex && pre.apex !== domain ? await probeMx(inputs.dns, pre.apex) : pre.domainMx;
  }
  const dmarc = await probeTxt(inputs.dns, `_dmarc.${domain}`);
  const bounce = await probeTxt(inputs.dns, `cf-bounce.${domain}`);
  if (dmarc === 'present') {
    pre.sending.dnsConflicts.push(`_dmarc.${domain}`);
  }
  if (bounce === 'present') {
    pre.sending.dnsConflicts.push(`cf-bounce.${domain}`);
  }
  if (dmarc === 'unknown' || bounce === 'unknown') {
    pre.sending.dnsConflicts.push(`(DNS lookup failed for _dmarc.${domain} / cf-bounce.${domain})`);
  }

  // Decision: 4. The bearer, borrowed once for the reads keyed on the resolved zone: `GET /zones?name=`
  // (without `account.id`, so a zone in another account is told apart from a missing one, and `type`
  // refuses partial or secondary zones), then `GET /zones/{z}/email/routing` (`support_subaddress`)
  // for inbound apps, or `GET /zones/{z}/email/sending/subdomains` for sending-only apps. The
  // provider's sending read first resolves the zone through Email Routing settings (Zone Settings
  // Read), which a sending-only token lacks. A `null` bearer leaves these rows `unknown`.
  let sendingRead: SessionBearerResponse | null = null;
  const bearer =
    pre.session.state === 'ok' ? await inputs.getSessionBearer().catch(() => null) : null;
  if (bearer) {
    if (!receivesEmail) {
      pre.zone.state = 'not-found';
    }
    const candidates = pre.apex ? [pre.apex] : zoneCandidates(domain);
    for (const candidate of candidates) {
      const zones = await fetchWithSessionBearer(
        inputs.fetchImpl,
        bearer,
        'GET',
        `/zones?name=${encodeURIComponent(candidate)}`,
        undefined,
        apiBaseUrl,
      );
      if (!zones.ok) {
        if (!receivesEmail) {
          pre.zone.state = 'unknown';
        }
        break;
      }
      if (!receivesEmail && !Array.isArray(zones.result)) {
        pre.zone.state = 'unknown';
        break;
      }
      const first: unknown = isJsonArray(zones.result) ? zones.result[0] : undefined;
      if (!first) {
        continue;
      }
      const zone = readZoneRecord(first);
      if (
        !receivesEmail &&
        (zone.id === undefined ||
          zone.name !== candidate ||
          zone.type === undefined ||
          zone.accountId === undefined)
      ) {
        pre.zone.state = 'unknown';
        break;
      }
      pre.zone.type = zone.type;
      if (zone.accountId && zone.accountId !== inputs.accountId) {
        pre.zone = { state: 'other-account', zoneId: zone.id, type: zone.type };
      } else if (zone.type && zone.type !== 'full') {
        pre.zone = { state: 'partial', zoneId: zone.id, type: zone.type };
      } else {
        pre.zone = { state: 'found', zoneId: zone.id, type: zone.type };
        if (!pre.apex && zone.name !== undefined) {
          pre.apex = zone.name.toLowerCase();
          pre.mode = pre.apex === domain ? 'apex' : 'subdomain';
        }
      }
      break;
    }
    if (receivesEmail && pre.zone.state === 'found' && pre.zone.zoneId) {
      const routing = await fetchWithSessionBearer(
        inputs.fetchImpl,
        bearer,
        'GET',
        `/zones/${pre.zone.zoneId}/email/routing`,
        undefined,
        apiBaseUrl,
      );
      const flag = isJsonObject(routing.result) ? routing.result.support_subaddress : undefined;
      if (routing.ok && typeof flag === 'boolean') {
        pre.subaddressing.state = flag ? 'on' : 'off';
      }
    }
    if (!receivesEmail && pre.zone.state === 'found' && pre.zone.zoneId) {
      sendingRead = await fetchWithSessionBearer(
        inputs.fetchImpl,
        bearer,
        'GET',
        `/zones/${pre.zone.zoneId}/email/sending/subdomains`,
        undefined,
        apiBaseUrl,
      );
    }
  }
  if (!receivesEmail && pre.session.state === 'ok' && pre.zone.state === 'unknown') {
    block(
      'all',
      `could not verify the sending domain's Cloudflare zone${tokenHint}; check zone access, then retry \`bwf email status --platform cloudflare\``,
    );
  }

  switch (pre.zone.state) {
    case 'not-found':
      block(
        'all',
        `no zone for ${domain} in Cloudflare account ${inputs.accountId} — add the domain to this account first`,
      );
      break;
    case 'other-account':
      block(
        'all',
        `${pre.apex ?? domain} is a zone in a different Cloudflare account than ${inputs.accountId}`,
      );
      break;
    case 'partial':
      block(
        'all',
        `${pre.apex ?? domain} is a ${pre.zone.type} zone; ${receivesEmail ? 'Email Routing' : 'Email Sending'} needs a full zone on Cloudflare DNS`,
      );
      break;
    default:
      break;
  }

  if (!pre.apex || !pre.mode) {
    pre.ready = false;
    return pre;
  }
  const apex = pre.apex;
  const mode = pre.mode;

  // Decision: 5. Routing status. On the apex, `ready` is the only good state. `unlocked` and `misconfigured*`
  // mean its locked records changed: print, don't re-lock.
  if (settings) {
    if (mode === 'apex') {
      pre.routing = {
        state: settings.enabled && settings.status === 'ready' ? 'ready' : 'pending',
        status: settings.status,
        enabled: settings.enabled,
      };
      if (/^(unlocked|misconfigured)/.test(settings.status)) {
        block(
          'all',
          `Email Routing on ${apex} is ${settings.status} — fix it in the Cloudflare dashboard; bwf never re-locks records you unlocked`,
        );
      }
    } else {
      // Decision: No command reads a subdomain's routing state (`GET …/routing/dns?subdomain=` is deprecated), so
      // the subdomain's MX is the readiness signal: Cloudflare's own exchanges mean enabled. A zone with
      // routing configured only on subdomains reports the apex as `misconfigured` because the apex has no
      // routing MX; that says nothing about this domain. Keep only `unlocked` as an explicit signal that
      // the developer took control of Cloudflare-managed apex records.
      pre.routing = {
        state:
          pre.domainMx.state === 'cloudflare'
            ? 'ready'
            : pre.domainMx.state === 'unknown'
              ? 'unknown'
              : 'pending',
        status: settings.status,
        enabled: settings.enabled,
      };
      if (settings.status === 'unlocked') {
        block(
          'all',
          `Email Routing on ${apex} is ${settings.status} — fix it in the Cloudflare dashboard; bwf never re-locks records you unlocked`,
        );
      }
    }
  }
  if (receivesEmail && pre.routing.state !== 'ready') {
    if (pre.domainMx.state === 'foreign') {
      block(
        'all',
        `${domain} already receives mail (${pre.domainMx.exchanges.join(', ')}). bwf never enables routing over live mail.${
          mode === 'apex' ? ` Use something@mail.${apex}.` : ''
        }`,
      );
    } else if (pre.domainMx.state === 'unknown') {
      block(
        'all',
        `could not read the MX records of ${domain} — unknown — run \`bwf email setup --platform cloudflare\``,
      );
    }
  }

  // Decision: 6. Derivation, then rules: mine, foreign or absent per derived address.
  pre.derived = deriveAddresses(inputs.handlers, domain, mode);
  if (receivesEmail) {
    const rulesResult = await run({ type: 'email.routing.rules.list', domain: apex });
    const rules =
      isHardFailure(rulesResult) || rulesResult.status !== 0
        ? null
        : readRoutingRules(rulesResult.data);
    if (!rules) {
      pre.rules.state = 'unknown';
      block(
        'all',
        `could not read Email Routing rules — unknown — run \`bwf email setup --platform cloudflare\`${tokenHint}`,
      );
    } else {
      const workerToken = `worker:${inputs.workerName}`;
      for (const address of pre.derived.addresses) {
        if (address.startsWith('*@')) {
          if (
            !rules.catchAll ||
            !rules.catchAll.enabled ||
            rules.catchAll.actions.includes('drop')
          ) {
            pre.rules.absent.push(address);
          } else if (rules.catchAll.actions.includes(workerToken)) {
            pre.rules.mine.push(address);
          } else {
            pre.rules.foreign.push({ address, owner: rules.catchAll.actions.join(', ') });
          }
          continue;
        }
        // Decision: An enabled rule decides the row. A disabled one routes nothing: our disabled rule reads `absent`,
        // like the disabled catch-all above. The address stays in `addresses`, and wrangler's plan (which
        // writes all rules `enabled: true`) turns it back on at the next deploy. A disabled foreign rule
        // stays `foreign`: the matcher is still somebody else's, and taking it over is the same conflict the
        // enabled case prunes the address to avoid.
        const rule =
          rules.rules.find((r) => r.enabled && r.to.includes(address)) ??
          rules.rules.find((r) => r.to.includes(address));
        if (!rule) {
          pre.rules.absent.push(address);
        } else if (rule.actions.includes(workerToken)) {
          if (rule.enabled) {
            pre.rules.mine.push(address);
          } else {
            pre.rules.absent.push(address);
          }
        } else {
          pre.rules.foreign.push({ address, owner: rule.actions.join(', ') });
        }
      }
      pre.rules.state = pre.rules.absent.length === 0 ? 'ready' : 'pending';
    }
  }
  const foreign = new Set(pre.rules.foreign.map((f) => f.address));
  pre.addresses = pre.derived.addresses.filter((a) => !foreign.has(a));

  // Decision: 7. Sending. Not-found is a clean "not onboarded"; anything else unparsable is unknown.
  // Sending-only apps reach this point only after the bearer resolved the zone above.
  const sendingResult: EmailWranglerRunResult = receivesEmail
    ? await run({ type: 'email.sending.settings', domain })
    : sendingSettingsFromList(sendingRead, domain);
  if (isHardFailure(sendingResult)) {
    pre.sending.state = 'unknown';
  } else if (sendingResult.status === 0 && sendingResult.data === null) {
    pre.sending.state = 'pending';
  } else if (sendingResult.status === 0) {
    const parsed = readSendingSettings(sendingResult.data);
    pre.sending.state = parsed ? (parsed.enabled ? 'ready' : 'pending') : 'unknown';
  } else {
    pre.sending.state = 'unknown';
  }
  if (pre.sending.state === 'unknown') {
    block(
      'sending',
      `could not read Email Sending settings — unknown — run \`bwf email setup --platform cloudflare\`${tokenHint}`,
    );
  } else if (pre.sending.state === 'pending' && pre.sending.dnsConflicts.length > 0) {
    block(
      'sending',
      `${pre.sending.dnsConflicts.join(', ')} already exists; onboarding writes its own _dmarc (p=reject) and DKIM records and would conflict — remove them or keep sending off`,
    );
  }

  // Decision: 8. The config rows: `send_email` binding and `addresses` ownership.
  const existingSendEmail = inputs.existingSendEmail ?? [];
  const names = existingSendEmail.map((e) => (typeof e?.name === 'string' ? e.name : ''));
  if (names.includes(SEND_EMAIL_BINDING)) {
    pre.binding = { state: 'present' };
  } else if (names.length > 0) {
    pre.binding = { state: 'foreign', foreignName: names[0] };
    block(
      'all',
      `Cloudflare config already has a send_email binding named ${JSON.stringify(names[0])}; rename it to ${SEND_EMAIL_BINDING} in bwf.config.ts (a second binding would be silent)`,
    );
  }
  if (inputs.existingAddresses !== undefined && inputs.existingAddresses !== null) {
    const existing = Array.isArray(inputs.existingAddresses)
      ? inputs.existingAddresses.map((a) => (typeof a === 'string' ? a.toLowerCase() : String(a)))
      : ['(not an array)'];
    // Decision: bwf records no provenance for entries it wrote earlier, so a leftover from a deleted handler reads
    // like a hand-written entry: the step is skipped and the array left alone.
    const candidates = new Set(pre.derived.addresses);
    const unknown = existing.filter((a) => !candidates.has(a));
    if (unknown.length > 0) {
      pre.addressesOwnership = { state: 'foreign', foreign: unknown };
      block(
        'all',
        `Cloudflare addresses holds entries bwf did not derive (${unknown.join(', ')}); remove ${unknown.map((a) => JSON.stringify(a)).join(', ')} from cloudflare.addresses in bwf.config.ts, or manage addresses by hand and unset email.from — skipping email setup this deploy`,
      );
    } else {
      pre.addressesOwnership = { state: 'mine', foreign: [] };
      // Decision: bwf's own array, but not the pruned set: a foreign-routed entry left in place (or a worker
      // rename, which makes all rules foreign) reaches wrangler's plan as a `conflict`, and `[]` would
      // plan the deletion of all owned rules.
      const pruned = new Set(pre.addresses);
      pre.addressesStale =
        existing.length !== pre.addresses.length || existing.some((a) => !pruned.has(a));
    }
  } else {
    pre.addressesStale = pre.addresses.length > 0;
  }
  const senderVar = inputs.existingVars?.[EMAIL_FROM_VAR];
  pre.sender.state =
    senderVar === inputs.from ? 'ready' : senderVar === undefined ? 'absent' : 'stale';
  pre.rulesPending = pre.rules.absent.filter((a) => pre.addresses.includes(a));

  // Decision: Inbound apps can keep their routing-backed, verified-destination sending when onboarding is
  // blocked or was refused before. That doesn't establish sending-only readiness.
  const sendingBlocked = pre.blockers.some((b) => b.scope === 'sending');
  pre.sendingRetryable = pre.sending.state === 'pending' && !sendingBlocked;
  const sendingSettled =
    pre.sending.state === 'ready' ||
    sendingBlocked ||
    (pre.sending.state === 'pending' && pre.binding.state === 'present');
  pre.ready =
    !pre.blockers.some((b) => b.scope === 'all') &&
    (receivesEmail
      ? pre.routing.state === 'ready' && pre.subaddressing.state === 'on' && sendingSettled
      : pre.sending.state === 'ready') &&
    pre.binding.state === 'present';
  return pre;
}

type ZoneRecord = { id?: string; name?: string; type?: string; accountId?: string };

function readZoneRecord(value: unknown): ZoneRecord {
  if (!isJsonObject(value)) {
    return {};
  }
  const account = value.account;
  return {
    id: typeof value.id === 'string' ? value.id : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    type: typeof value.type === 'string' ? value.type : undefined,
    accountId: isJsonObject(account) && typeof account.id === 'string' ? account.id : undefined,
  };
}

/** Column padding for the checklist; an overflowing cell gets three spaces. */
function pad(text: string, width: number): string {
  return text.length >= width ? `${text}   ` : text.padEnd(width);
}

/**
 * The block shown before the confirmation: status rows, then the `+`/`!` change list.
 * Blockers render as `✘` rows at the end so the developer sees why nothing will be asked.
 */
export function renderEmailChecklist(pre: EmailPreflight): string {
  const apex = pre.apex ?? '?';
  const receivesEmail = pre.usage.handlers.length > 0;
  const lines: Array<string> = [];
  const inUse =
    pre.usage.handlers.length > 0
      ? pre.usage.handlers.join(' · ')
      : 'sending only (no email/ handlers)';
  lines.push(`  Email in use   ${inUse}`);
  const row = (label: string, value: string, note = ''): void => {
    lines.push(`    ${pad(label, 10)}${note ? `${pad(value, 23)}${note}` : value}`);
  };
  row('domain', pre.domain, '(bwf.config.ts email.from)');
  const session = [
    pre.session.accountName
      ? `account ${pre.session.accountName} (${shortId(pre.accountId)})`
      : `account ${shortId(pre.accountId)}`,
    // Decision: An API token's permissions can't be listed; a refused read shows up as its row.
    pre.session.authType && pre.session.authType !== 'OAuth Token'
      ? `session ${pre.session.email ? `${pre.session.email} ` : ''}(${pre.session.authType})`
      : pre.session.email
        ? `session ${pre.session.email}`
        : null,
  ]
    .filter(Boolean)
    .join(' · ');
  row('zone', pre.zone.state === 'found' ? apex : `${apex} ${pre.zone.state}`, session);
  if (receivesEmail) {
    if (pre.mode === 'subdomain') {
      row(
        'apex MX',
        pre.apexMx.exchanges[0] ?? (pre.apexMx.state === 'unknown' ? 'unknown' : 'none'),
        'left alone — mail lives on the subdomain',
      );
    } else {
      row(
        'apex MX',
        pre.apexMx.exchanges[0] ?? (pre.apexMx.state === 'unknown' ? 'unknown' : 'none'),
        pre.apexMx.state === 'cloudflare'
          ? 'Cloudflare Email Routing'
          : pre.apexMx.state === 'empty'
            ? 'empty — the apex can take routing'
            : '',
      );
    }
    const routingWord =
      pre.routing.state === 'ready'
        ? 'enabled'
        : pre.routing.state === 'unknown'
          ? 'unknown — run bwf email setup --platform cloudflare'
          : `not enabled${pre.mode === 'apex' && pre.routing.status && pre.routing.status !== 'unconfigured' ? ` (${pre.routing.status})` : ''}`;
    const subWord =
      pre.subaddressing.state === 'on'
        ? 'subaddressing on'
        : pre.subaddressing.state === 'off'
          ? 'subaddressing off'
          : 'subaddressing unknown';
    row('routing', `${pre.domain}  ${routingWord} · ${subWord}`);
  } else {
    row('inbound', 'not required');
  }
  // Decision: A pending row the committed binding remembers as refused (see `preflightEmail`) reads settled, so
  // it says what still works and where the retry lives; a sending-scoped blocker keeps the bare word,
  // and its ✘ row at the end carries the reason.
  const sendingWord =
    pre.sending.state === 'ready'
      ? 'onboarded'
      : pre.sending.state === 'unknown'
        ? 'unknown — could not verify; retry bwf email status --platform cloudflare'
        : pre.sendingRetryable && pre.binding.state === 'present'
          ? receivesEmail
            ? 'not onboarded — verified destinations only; after upgrading to Workers Paid run bwf email setup --platform cloudflare'
            : 'not onboarded — needs Workers Paid; after upgrading run bwf email setup --platform cloudflare'
          : 'not onboarded';
  row('sending', `${pre.domain}  ${sendingWord}`);
  if (receivesEmail && pre.derived.addresses.length === 0) {
    row('rules', '(none — no email/ handlers)');
  }
  for (const address of pre.derived.addresses) {
    const foreignRule = pre.rules.foreign.find((f) => f.address === address);
    const status = pre.rules.mine.includes(address)
      ? 'ready'
      : foreignRule
        ? `owned elsewhere: ${foreignRule.owner} — pruned`
        : pre.rules.state === 'unknown'
          ? 'unknown'
          : 'absent';
    row('rules', `${address} → ${pre.workerName}`, `(${status})`);
  }
  row(
    'binding',
    SEND_EMAIL_BINDING,
    `(${pre.binding.state === 'present' ? 'present' : pre.binding.state === 'foreign' ? `found ${pre.binding.foreignName} instead` : 'absent'})`,
  );
  row('sender', pre.from, `(vars.${EMAIL_FROM_VAR} ${pre.sender.state})`);
  lines.push('');

  const changes: Array<string> = [];
  const change = (what: string, why: string): void => {
    changes.push(`    + ${pad(what, 44)}${why}`);
  };
  const warn = (what: string, why: string): void => {
    changes.push(`    ! ${pad(what, 44)}${why}`);
  };
  // Decision: A subdomain is added to a zone that already routes. When the apex doesn't, the apply step makes no
  // call (see `applyEmailSetup`) and the dashboard step is the row instead.
  const subdomainNeedsApex = pre.mode === 'subdomain' && pre.routing.enabled !== true;
  if (receivesEmail && pre.routing.state !== 'ready' && subdomainNeedsApex) {
    warn(
      `enable Email Routing on ${pre.domain}`,
      `Email Routing is not enabled on ${apex}; bwf never enables it on the apex from the subdomain path — ${subdomainDashboardFallback(apex, pre.domain)}`,
    );
  } else if (receivesEmail && pre.routing.state !== 'ready') {
    change(
      `enable Email Routing on ${pre.domain}`,
      `Cloudflare writes and locks 3 MX + 1 SPF record ${pre.mode === 'subdomain' ? 'there' : 'on the apex'}`,
    );
  }
  if (receivesEmail && pre.subaddressing.state !== 'on') {
    change(`turn on subaddressing for ${apex}`, 'support+anything@ reaches support@');
  }
  if (pre.sending.state === 'pending' && !pre.blockers.some((b) => b.scope === 'sending')) {
    change(
      `onboard ${pre.domain} for Email Sending`,
      `MX/SPF/DKIM on cf-bounce.${pre.domain}, _dmarc.${pre.domain} (p=reject)`,
    );
  }
  // Decision: The config write, listed by the members that actually change (a config-only row, `addresses` or
  // the sender var, is rewritten without a prompt on the deploy path).
  const parts: Array<string> = [];
  if (pre.binding.state !== 'present') {
    parts.push(`send_email: [{ name: "${SEND_EMAIL_BINDING}" }]`);
  }
  if (pre.addressesStale) {
    parts.push(
      pre.addresses.length > 0
        ? `addresses: ${JSON.stringify(pre.addresses)}`
        : 'addresses: (removed)',
    );
  }
  if (pre.sender.state !== 'ready') {
    parts.push(`vars.${EMAIL_FROM_VAR}: ${JSON.stringify(pre.from)}`);
  }
  if (parts.length > 0) {
    change('Cloudflare config', parts.join(', '));
  }
  for (const address of pre.rules.absent) {
    change('routing rule (created on deploy)', `${address} → ${pre.workerName}`);
  }
  for (const foreign of pre.rules.foreign) {
    warn(foreign.address, `already routed to ${foreign.owner}; left alone, not in addresses`);
  }
  for (const refused of pre.derived.refused) {
    warn(refused.handler, refused.reason);
  }
  for (const blocker of pre.blockers) {
    changes.push(`    ✘ ${blocker.message}`);
  }
  if (changes.length === 0) {
    lines.push(
      receivesEmail
        ? '  Nothing to change — email is set up.'
        : '  Nothing to change — email sending is configured.',
    );
  } else {
    lines.push(
      `  This changes YOUR Cloudflare account.${pre.mode === 'subdomain' && !subdomainNeedsApex ? ` ${apex} itself is not touched.` : ''}`,
      ...changes,
    );
  }
  return lines.join('\n');
}

export interface SessionBearerResponse {
  ok: boolean;
  status: number;
  result: unknown;
  errors: Array<{ code: number; message: string }>;
}

/**
 * The ONLY function that receives the session bearer. It puts the token in the
 * `Authorization` header and nowhere else: not in the URL, not in a log line, not in
 * the returned object, not in an error. A transport failure is returned as
 * `{ ok: false, status: 0 }` with the underlying message (which names the URL at
 * most) — never thrown, so a caller can never leak the token through a stack trace.
 */
export async function fetchWithSessionBearer(
  fetchImpl: EmailFetch,
  bearer: string,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  apiBaseUrl: string = CLOUDFLARE_API_BASE_URL,
): Promise<SessionBearerResponse> {
  const jsonHeaders = body === undefined ? undefined : { 'Content-Type': 'application/json' };
  const headers = { Authorization: `Bearer ${bearer}`, ...jsonHeaders };
  // Decision: Nothing this function returns may carry the token: a transport error message or an API error
  // message that echoed the header is scrubbed before it leaves this closure.
  const scrub = (text: string): string => text.split(bearer).join('[redacted]');
  let response: Response;
  try {
    response = await fetchImpl(`${apiBaseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      result: null,
      errors: [{ code: 0, message: scrub(error instanceof Error ? error.message : String(error)) }],
    };
  }
  let payload: JsonObject;
  try {
    const parsed: unknown = await response.json();
    payload = isJsonObject(parsed) ? parsed : {};
  } catch {
    payload = {};
  }
  const errors = (isJsonArray(payload.errors) ? payload.errors : []).map((e) => ({
    code: isJsonObject(e) && typeof e.code === 'number' ? e.code : 0,
    message: isJsonObject(e) && typeof e.message === 'string' ? scrub(e.message) : '',
  }));
  return {
    ok: response.ok && payload.success !== false,
    status: response.status,
    result: payload.result ?? null,
    errors,
  };
}

/**
 * The config patch email setup writes; a subset of `ProvisionedWranglerPatch`.
 * `addresses: null` deletes the key (never `[]`, which deletes every owned rule);
 * `undefined` leaves it untouched.
 */
interface EmailWranglerPatch {
  sendEmail?: { name: string };
  addresses?: Array<string> | null;
  vars?: Record<string, string>;
}

export interface EmailApplyResult {
  patch: EmailWranglerPatch;
  /** Human lines, in order — ✔ rows, hint lines, the dashboard fallback. */
  lines: Array<string>;
  routingReady: boolean;
  subaddressingReady: boolean;
  sendingReady: boolean;
  /**
   * Routing ready, subaddressing on, and `addresses` written for an app with inbound handlers.
   */
  inboundReady: boolean;
  /** The capabilities used by the app are configured, including its send binding. */
  ready: boolean;
}

/**
 * Run only the rows preflight found not ready:
 *
 *   routing   apex → `email routing enable <apex>`
 *             subdomain → bearer POST /zones/{z}/email/routing/dns { name }
 *   subaddr   bearer PATCH /zones/{z}/email/routing { support_subaddress: true }
 *   sending   inbound → `email sending enable <domain>`
 *             sending-only → bearer POST /zones/{z}/email/sending/subdomains { name }
 *             code 2040 (already onboarded) is ok; any other failure prints a hint and
 *             continues without sending
 *
 * A failed bearer call prints the dashboard fallback and withholds `addresses` this run;
 * it never fails the deploy. An `all` blocker applies nothing and returns an empty patch.
 */
export async function applyEmailSetup(
  pre: EmailPreflight,
  inputs: EmailCloudflareInputs,
): Promise<EmailApplyResult> {
  const receivesEmail = pre.usage.handlers.length > 0;
  const lines: Array<string> = [];
  const result: EmailApplyResult = {
    patch: {},
    lines,
    routingReady: pre.routing.state === 'ready',
    subaddressingReady: pre.subaddressing.state === 'on',
    sendingReady: pre.sending.state === 'ready',
    inboundReady: false,
    ready: false,
  };
  const blocked = pre.blockers.filter((b) => b.scope === 'all');
  if (blocked.length > 0 || !pre.apex || !pre.mode) {
    for (const b of blocked) {
      lines.push(`  ✘ ${b.message}`);
    }
    if (blocked.length === 0) {
      lines.push(
        '  ✘ email: the zone could not be resolved — unknown — run `bwf email setup --platform cloudflare`',
      );
    }
    return result;
  }
  const apex = pre.apex;
  const apiBaseUrl = inputs.apiBaseUrl ?? CLOUDFLARE_API_BASE_URL;
  const run = async (operation: CloudflareOperation): Promise<EmailWranglerRunResult> =>
    inputs.runWrangler(
      inputs.configPath ? { ...operation, configPath: inputs.configPath } : operation,
      { capture: true },
    );

  // Decision: The bearer is borrowed lazily, once, and dropped at the end of this function.
  let bearer: string | null | undefined;
  let bearerFailed = false;
  let bearerObtained = false;
  const borrow = async (): Promise<string | null> => {
    if (bearer === undefined) {
      bearer = await inputs.getSessionBearer().catch(() => null);
      if (bearer) {
        bearerObtained = true;
      } else {
        bearerFailed = true;
      }
    }
    return bearer;
  };
  const withBearer = async (
    method: 'POST' | 'PATCH',
    path: string,
    body: unknown,
  ): Promise<SessionBearerResponse | null> => {
    const token = await borrow();
    if (!token) {
      return null;
    }
    const response = await fetchWithSessionBearer(
      inputs.fetchImpl,
      token,
      method,
      path,
      body,
      apiBaseUrl,
    );
    if (!response.ok) {
      bearerFailed = true;
    }
    return response;
  };

  const apexRoutingOff = pre.mode === 'subdomain' && pre.routing.enabled !== true;
  if (receivesEmail && !result.routingReady) {
    if (pre.mode === 'apex') {
      const enable = await run({ type: 'email.routing.enable', domain: apex });
      if (!isHardFailure(enable) && enable.status === 0) {
        result.routingReady = true;
        lines.push(`  ✔ routing   ${apex} enabled`);
      } else {
        const code = providerErrorCode(enable);
        lines.push(
          `  ✘ routing   could not enable Email Routing on ${apex}${code ? ` [code: ${code}]${CF_EMAIL_ERROR_CODES.has(code) ? ` — ${CF_EMAIL_ERROR_CODES.get(code)}` : ''}` : ''}`,
        );
      }
    } else if (apexRoutingOff) {
      // Decision: A subdomain can only be added to a zone that already routes. Calling here could enable the zone
      // itself and lock MX over the apex's live mail, so no call is made.
      lines.push(
        `  ✘ routing   ${pre.domain}: Email Routing is not enabled on ${apex} — a subdomain can only be added to a zone that already routes; bwf never enables routing on the apex from the subdomain path`,
        `    ${subdomainDashboardFallback(apex, pre.domain)}`,
      );
    } else {
      // Decision: Per the OpenAPI spec, POST …/email/routing/dns { name } enables routing on a subdomain; the
      // `email.routing.enable` operation is apex-only.
      const response = await withBearer('POST', `/zones/${pre.zone.zoneId}/email/routing/dns`, {
        name: pre.domain,
      });
      if (response?.ok) {
        result.routingReady = true;
        lines.push(`  ✔ routing   ${pre.domain} enabled`);
      } else {
        lines.push(
          `  ✘ routing   ${pre.domain}: ${describeFailure(response)}`,
          `    ${subdomainDashboardFallback(apex, pre.domain)}`,
        );
      }
    }
  }

  // Decision: 2. Subaddressing: per zone, off by default, and reachable only through the REST API.
  if (receivesEmail && !result.subaddressingReady && !bearerFailed && !apexRoutingOff) {
    const response = await withBearer('PATCH', `/zones/${pre.zone.zoneId}/email/routing`, {
      support_subaddress: true,
    });
    if (response?.ok) {
      result.subaddressingReady = true;
      lines.push(`  ✔ routing   subaddressing on for ${apex}`);
    } else {
      lines.push(
        `  ✘ routing   subaddressing on ${apex}: ${describeFailure(response)}`,
        `    turn it on in the Cloudflare dashboard → ${apex} → Email → Settings → Subaddressing`,
      );
    }
  } else if (receivesEmail && !result.subaddressingReady) {
    // Decision: Skipped because an earlier bearer step failed: name the actual reason.
    lines.push(
      `  ✘ routing   subaddressing on ${apex}: skipped (${
        apexRoutingOff
          ? `Email Routing is not enabled on ${apex}`
          : bearerObtained
            ? 'the subdomain routing call failed'
            : 'session bearer unavailable'
      })`,
    );
  }

  // Decision: 3. Sending. 2040 means already onboarded. Anything else: hint, and continue without it.
  // Sending-only apps onboard through the bearer on the zone preflight resolved, since the provider
  // command first reads Email Routing settings (Zone Settings Read).
  const enableSending = async (): Promise<{
    ok: boolean;
    code: number | null;
    noBearer?: boolean;
  }> => {
    if (receivesEmail) {
      const enable = await run({ type: 'email.sending.enable', domain: pre.domain });
      const code = isHardFailure(enable) ? null : providerErrorCode(enable);
      return { ok: !isHardFailure(enable) && (enable.status === 0 || code === 2040), code };
    }
    const token = await borrow();
    if (!token) {
      return { ok: false, code: null, noBearer: true };
    }
    const response = await fetchWithSessionBearer(
      inputs.fetchImpl,
      token,
      'POST',
      `/zones/${pre.zone.zoneId}/email/sending/subdomains`,
      { name: pre.domain },
      apiBaseUrl,
    );
    const code = response.errors.find((error) => error.code !== 0)?.code ?? null;
    return { ok: response.ok || code === 2040, code };
  };
  const sendingBlocked = pre.blockers.filter((b) => b.scope === 'sending');
  if (!result.sendingReady && sendingBlocked.length > 0) {
    for (const b of sendingBlocked) {
      lines.push(`  ! sending   ${b.message}`);
    }
  } else if (!result.sendingReady) {
    const { ok, code, noBearer } = await enableSending();
    if (ok) {
      result.sendingReady = true;
      lines.push(`  ✔ sending   ${pre.domain} onboarded`);
    } else if (noBearer) {
      // Decision: Nothing reached Cloudflare, so the plan isn't the reason.
      lines.push(
        `  ! sending   ${pre.domain} not onboarded (session bearer unavailable); rerun bwf email setup --platform cloudflare`,
      );
    } else {
      const known = code ? CF_EMAIL_ERROR_CODES.get(code) : undefined;
      lines.push(
        `  ! sending   ${pre.domain} not onboarded${code ? ` [code: ${code}]` : ''}${known ? ` — ${known}` : ''}`,
      );
      for (const hint of receivesEmail
        ? [SENDING_FREE_PLAN_HINT]
        : formatSendingOnlyPaidHint(pre.domain)) {
        lines.push(`    ${hint}`);
      }
    }
  }
  bearer = null;

  // Decision: 4. The patch. The binding is written only when routing is ready or sending is onboarded (a bare
  // account doesn't carry it). `addresses` is written only when routing is ready and no bearer call
  // failed this run; otherwise the key is deleted.
  if (result.routingReady || result.sendingReady) {
    result.patch.sendEmail = { name: SEND_EMAIL_BINDING };
    result.patch.vars = { [EMAIL_FROM_VAR]: pre.from };
  }
  const addressesWithheld = bearerFailed || !result.routingReady;
  if (!addressesWithheld && pre.addresses.length > 0) {
    result.patch.addresses = pre.addresses;
  } else {
    result.patch.addresses = null;
    if (addressesWithheld && pre.addresses.length > 0) {
      lines.push(
        `  ! config    addresses withheld this run (${bearerFailed ? 'session-bearer step failed' : 'routing not ready'}); no routing rule is created for ${pre.addresses.join(', ')}`,
      );
    }
  }
  lines.push('  ✔ config    bwf.lock.json updated');
  result.inboundReady =
    receivesEmail && result.routingReady && result.subaddressingReady && !addressesWithheld;
  result.ready =
    (receivesEmail ? result.inboundReady : result.sendingReady) &&
    (result.patch.sendEmail !== undefined || pre.binding.state === 'present');
  return result;
}

/**
 * The post-deploy block:
 *
 *     inbound   support@mail.acme.com  →  email/support+[ticket].ts
 *     outbound  sendEmail() from support@mail.acme.com
 */
export function renderAddressMap(map: {
  from: string;
  routes: Array<{ address: string; handler: string }>;
  /** Addresses actually written to `addresses` — routes outside it are marked pending. */
  addresses: Array<string>;
  sendingReady: boolean;
  /** The pending marker; `bwf email status` passes one that does not name a deploy. */
  pendingLabel?: string;
  /**
   * An app without `email/` handlers. bwf never enables Email Routing for it, so before
   * onboarding the map cannot promise the verified-destination fallback.
   */
  sendingOnly?: boolean;
  /** Written addresses whose rule does not exist yet — `wrangler deploy` creates it. */
  creating?: Array<string>;
}): string {
  const lines: Array<string> = [];
  const width = Math.max(0, ...map.routes.map((r) => r.address.length));
  const pending = map.pendingLabel ?? '(no rule this deploy)';
  for (const route of map.routes) {
    const live = map.addresses.includes(route.address);
    const marker = !live
      ? `   ${pending}`
      : map.creating?.includes(route.address)
        ? '   (rule created by this deploy)'
        : '';
    lines.push(`    inbound   ${pad(route.address, width + 2)}→  ${route.handler}${marker}`);
  }
  lines.push(
    `    outbound  sendEmail() from ${map.from}${map.sendingReady ? '' : map.sendingOnly ? '   (Email Sending not onboarded)' : '   (verified destinations only)'}`,
  );
  return lines.join('\n');
}

/** The production `EmailDns`: `node:dns/promises` against the system resolver. */
export async function createNodeEmailDns(): Promise<EmailDns> {
  const dns = await import('node:dns/promises');
  return {
    resolveMx: (name) => dns.resolveMx(name),
    resolveTxt: (name) => dns.resolveTxt(name),
  };
}
