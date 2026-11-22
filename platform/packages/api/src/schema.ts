import type {
  PlatformAccessProtection,
  PlatformAdmissionPolicy,
  PlatformLoginConfiguration,
  PlatformLoginKind,
} from '@builtbyfriends/platform';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { PlatformOidcIdentity, CompanyIdentity } from './auth/identity-types.ts';
import type { OAuthScope, OAuthRequestData, OAuthSession } from './auth/oauth-types.ts';
import type { PlatformWorkerName, PlatformEnv } from './operator/platform-workers.ts';
import type { PlanId } from './tiers.ts';
import type {
  InvitationEmailDeliveryStatus,
  InvitationStatus,
  ProjectAccessEventAction,
  ProjectInvitationStatus,
  ProjectMemberRole,
} from './types.ts';

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull().default('github'),
    provider_id: text('provider_id').notNull().default(''),
    login: text('login').notNull().default(''),
    email: text('email'),
    plan: text('plan').notNull().default('free').$type<PlanId>(),
    role: text('role').notNull().default('user').$type<'user' | 'admin'>(),
    billing_cycle_start: timestamp('billing_cycle_start', { mode: 'string' })
      .notNull()
      .defaultNow(),
    suspended_reason: text('suspended_reason'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_users_provider_id').on(table.provider, table.provider_id),
    index('idx_users_email').on(table.email),
  ],
);

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    provider_id: text('provider_id').notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_oauth_accounts_provider_id').on(table.provider, table.provider_id),
    index('idx_oauth_accounts_user_id').on(table.user_id),
  ],
);

export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  operator: text('operator').notNull(),
  redirect_uris: jsonb('redirect_uris').notNull().$type<Array<string>>(),
  scopes: jsonb('scopes').notNull().$type<Array<OAuthScope>>(),
  secret_hash: text('secret_hash').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  /** The plans this application's people can buy: each one's Stripe price and monthly credits. */
  plans: jsonb('plans').$type<Record<string, { stripePriceId: string; creditMicros: number }>>(),
  /** The one-time credit each person can be given once, set by an operator. Null gives none. */
  starter_credit_micros: bigint('starter_credit_micros', { mode: 'number' }),
  created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** The plan of one person of a connected application, which bills them itself. */
export const appPeople = pgTable(
  'app_people',
  {
    client_id: text('client_id')
      .notNull()
      .references(() => oauthClients.id),
    /** The application's own id for the person. */
    person_id: text('person_id').notNull(),
    plan: text('plan').$type<PlanId>().notNull(),
    stripe_customer_id: text('stripe_customer_id'),
    stripe_subscription_id: text('stripe_subscription_id'),
    /** Whether the plan and Stripe ids came from a live-mode payment. A live installation ignores test rows. */
    livemode: boolean('livemode').notNull().default(false),
    /** The stored subscription's Stripe status, such as active or past_due, as last read from Stripe. */
    subscription_status: text('subscription_status'),
    current_period_end: timestamp('current_period_end', { mode: 'string', withTimezone: true }),
    cancel_at_period_end: boolean('cancel_at_period_end').notNull().default(false),
    /** No longer read: app_payers.out_since took its place. Kept for the previous Worker during a rollout. */
    out_of_credits_period: text('out_of_credits_period'),
    updated_at: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.client_id, table.person_id] })],
);

/** Stripe events already handled, so a resent event changes nothing. */
export const stripeEvents = pgTable('stripe_events', {
  event_id: text('event_id').primaryKey(),
  type: text('type').notNull(),
  livemode: boolean('livemode').notNull(),
  created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** What one person of a connected application used in one calendar month (UTC), as the application reports it. */
export const appUsage = pgTable(
  'app_usage',
  {
    client_id: text('client_id')
      .notNull()
      .references(() => oauthClients.id),
    person_id: text('person_id').notNull(),
    /** First day of the month, `YYYY-MM-01`. */
    period: text('period').notNull(),
    ai_neurons: integer('ai_neurons').notNull().default(0),
    sandbox_seconds: integer('sandbox_seconds').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.client_id, table.person_id, table.period] })],
);

/** The same month's use split by model and by where the application says it came from. */
export const appUsageSources = pgTable(
  'app_usage_sources',
  {
    client_id: text('client_id')
      .notNull()
      .references(() => oauthClients.id),
    person_id: text('person_id').notNull(),
    period: text('period').notNull(),
    model: text('model').notNull().default(''),
    source: text('source').notNull().default(''),
    ai_neurons: integer('ai_neurons').notNull().default(0),
    sandbox_seconds: integer('sandbox_seconds').notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.client_id, table.person_id, table.period, table.model, table.source],
    }),
  ],
);

/**
 * Use by day, meter and project for the person who pays for it. An empty project is use the
 * application reported; the rest is what Platform read for a hosted project.
 */
export const appUsageDaily = pgTable(
  'app_usage_daily',
  {
    client_id: text('client_id')
      .notNull()
      .references(() => oauthClients.id),
    person_id: text('person_id').notNull(),
    project_id: text('project_id').notNull().default(''),
    /** `YYYY-MM-DD` in UTC. */
    day: text('day').notNull(),
    meter: text('meter').notNull(),
    quantity: bigint('quantity', { mode: 'number' }).notNull().default(0),
    /** What this row was charged to the payer's credits, at the prices of the moment. */
    cost_micros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.client_id, table.person_id, table.project_id, table.day, table.meter],
    }),
    index('idx_app_usage_daily_project').on(table.project_id, table.day),
  ],
);

/** Reports already counted, so an application can send one again after a timeout. */
export const appUsageEvents = pgTable(
  'app_usage_events',
  {
    client_id: text('client_id')
      .notNull()
      .references(() => oauthClients.id),
    event_id: text('event_id').notNull(),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.client_id, table.event_id] })],
);

export type CreditSource = 'plan' | 'bought' | 'given' | 'starter';

/**
 * One grant of credits to a payer of a connected application. The balance is what's left on
 * grants that haven't ended, less what the payer owes.
 */
export const appCreditGrants = pgTable(
  'app_credit_grants',
  {
    id: text('id').primaryKey(),
    client_id: text('client_id')
      .notNull()
      .references(() => oauthClients.id),
    /** The application's own id for whoever pays, in the same space as person ids. */
    payer_id: text('payer_id').notNull(),
    source: text('source').$type<CreditSource>().notNull(),
    amount_micros: bigint('amount_micros', { mode: 'number' }).notNull(),
    remaining_micros: bigint('remaining_micros', { mode: 'number' }).notNull(),
    /** What refunds took back so far. */
    taken_micros: bigint('taken_micros', { mode: 'number' }).notNull().default(0),
    /** What a dispute took from what was left, and what it added to the owed amount, so a won dispute gives both back. */
    voided_remaining_micros: bigint('voided_remaining_micros', { mode: 'number' })
      .notNull()
      .default(0),
    voided_owed_micros: bigint('voided_owed_micros', { mode: 'number' }).notNull().default(0),
    giver_id: text('giver_id'),
    stripe_invoice_id: text('stripe_invoice_id'),
    stripe_payment_intent_id: text('stripe_payment_intent_id'),
    livemode: boolean('livemode').notNull().default(false),
    starts_at: timestamp('starts_at', { mode: 'string', withTimezone: true }).notNull(),
    expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }),
    voided_at: timestamp('voided_at', { mode: 'string', withTimezone: true }),
    void_reason: text('void_reason'),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_app_credit_grants_payer').on(table.client_id, table.payer_id),
    uniqueIndex('idx_app_credit_grants_invoice')
      .on(table.client_id, table.stripe_invoice_id)
      .where(sql`${table.stripe_invoice_id} IS NOT NULL`),
    uniqueIndex('idx_app_credit_grants_starter')
      .on(table.client_id, table.payer_id, table.livemode)
      .where(sql`${table.source} = 'starter'`),
    uniqueIndex('idx_app_credit_grants_payment')
      .on(table.client_id, table.stripe_payment_intent_id)
      .where(sql`${table.stripe_payment_intent_id} IS NOT NULL`),
  ],
);

/** What a payer owes past their grants, and since when their balance has been at or below zero. */
export const appPayers = pgTable(
  'app_payers',
  {
    client_id: text('client_id')
      .notNull()
      .references(() => oauthClients.id),
    payer_id: text('payer_id').notNull(),
    owed_micros: bigint('owed_micros', { mode: 'number' }).notNull().default(0),
    out_since: timestamp('out_since', { mode: 'string', withTimezone: true }),
    /** Set by a card dispute. A blocked payer can't buy until an operator clears it. */
    blocked_at: timestamp('blocked_at', { mode: 'string', withTimezone: true }),
    blocked_reason: text('blocked_reason'),
  },
  (table) => [primaryKey({ columns: [table.client_id, table.payer_id] })],
);

export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: text('id').primaryKey(),
    client_id: text('client_id')
      .notNull()
      .references(() => oauthClients.id),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    session: jsonb('session').notNull().$type<OAuthSession>(),
    scopes: jsonb('scopes').notNull().default(['profile']).$type<Array<OAuthScope>>(),
    token_hash: text('token_hash').notNull(),
    expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
    revoked_at: timestamp('revoked_at', { mode: 'string', withTimezone: true }),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('oauth_grants_token').on(table.token_hash),
    index('oauth_grants_user').on(table.user_id),
    index('oauth_grants_expiry').on(table.expires_at),
  ],
);

export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    id: text('id').primaryKey(),
    grant_id: text('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    token_hash: text('token_hash').notNull(),
    // Decision: Set once from the token that started this rotation family and copied forward unchanged on each
    // rotation: an absolute cap that rotation can't extend.
    expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
    // Decision: Null while this generation is the grant's live refresh token. Set when rotated out; a later
    // redemption of a used token is reuse and revokes the whole grant.
    used_at: timestamp('used_at', { mode: 'string', withTimezone: true }),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('oauth_refresh_tokens_token').on(table.token_hash),
    index('oauth_refresh_tokens_grant').on(table.grant_id),
    index('oauth_refresh_tokens_expiry').on(table.expires_at),
  ],
);

export const oauthRequests = pgTable(
  'oauth_requests',
  {
    id: text('id').primaryKey(),
    client_id: text('client_id').references(() => oauthClients.id),
    user_id: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    browser_hash: text('browser_hash').notNull(),
    data: jsonb('data').notNull().$type<OAuthRequestData>(),
    code_hash: text('code_hash'),
    code_expires_at: timestamp('code_expires_at', { mode: 'string', withTimezone: true }),
    approved_at: timestamp('approved_at', { mode: 'string', withTimezone: true }),
    consumed_at: timestamp('consumed_at', { mode: 'string', withTimezone: true }),
    expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('oauth_requests_code').on(table.code_hash),
    index('oauth_requests_expiry').on(table.expires_at),
  ],
);

// Decision: Platform authentication is database-authoritative after its one-time import. Lock the singleton
// before changing connections, admission or administrator reachability.
export const platformAuthSettings = pgTable(
  'platform_auth_settings',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    revision: integer('revision').notNull().default(1),
    admission: jsonb('admission').notNull().$type<PlatformAdmissionPolicy>(),
    protection: jsonb('protection').$type<PlatformAccessProtection>(),
    session_seconds: integer('session_seconds').notNull().default(2592000),
    sessions_required: boolean('sessions_required').notNull().default(false),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('platform_auth_settings_singleton', sql`${table.singleton} = true`),
    check('platform_auth_settings_revision', sql`${table.revision} > 0`),
    check(
      'platform_auth_settings_session_seconds',
      sql`${table.session_seconds} BETWEEN 300 AND 2592000`,
    ),
  ],
);

export const platformLoginConnections = pgTable(
  'platform_login_connections',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull().$type<PlatformLoginKind>(),
    enabled: boolean('enabled').notNull().default(false),
    active_revision: integer('active_revision'),
    revision: integer('revision').notNull().default(1),
    generation: integer('generation').notNull().default(1),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'platform_login_connections_kind',
      sql`${table.kind} IN ('github', 'google', 'oidc', 'cloudflare-access')`,
    ),
    check(
      'platform_login_connections_revision',
      sql`${table.revision} > 0 AND ${table.generation} > 0`,
    ),
    check(
      'platform_login_connections_active_revision',
      sql`${table.active_revision} IS NULL OR ${table.active_revision} BETWEEN 1 AND ${table.revision}`,
    ),
    check(
      'platform_login_connections_enabled',
      sql`NOT ${table.enabled} OR ${table.active_revision} IS NOT NULL`,
    ),
  ],
);

/** Immutable revisions keep a credential edit separate from the working login method. */
export const platformLoginRevisions = pgTable(
  'platform_login_revisions',
  {
    connection_id: text('connection_id')
      .notNull()
      .references(() => platformLoginConnections.id),
    revision: integer('revision').notNull(),
    configuration: jsonb('configuration').notNull().$type<PlatformLoginConfiguration>(),
    secret: jsonb('secret')
      .notNull()
      .$type<{ ciphertext: string; iv: string; keyVersion: string }>(),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.connection_id, table.revision] })],
);

export const platformLoginIdentities = pgTable(
  'platform_login_identities',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connection_id: text('connection_id')
      .notNull()
      .references(() => platformLoginConnections.id),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    last_authenticated_at: timestamp('last_authenticated_at', {
      mode: 'string',
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('platform_login_identity_subject').on(
      table.connection_id,
      table.issuer,
      table.subject,
    ),
    uniqueIndex('platform_login_identity_user').on(table.connection_id, table.user_id),
  ],
);

export const platformHumanSessions = pgTable(
  'platform_human_sessions',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connection_id: text('connection_id')
      .notNull()
      .references(() => platformLoginConnections.id),
    generation: integer('generation').notNull(),
    audience: text('audience').notNull().$type<'api' | 'admin'>(),
    // Decision: When a company gate is required, both identities have to belong to the same person.
    access_issuer: text('access_issuer'),
    access_subject: text('access_subject'),
    expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
    revoked_at: timestamp('revoked_at', { mode: 'string', withTimezone: true }),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('platform_human_sessions_connection').on(table.connection_id),
    index('platform_human_sessions_user').on(table.user_id),
    index('platform_human_sessions_expiry').on(table.expires_at),
    check('platform_human_sessions_audience', sql`${table.audience} IN ('api', 'admin')`),
    check(
      'platform_human_sessions_access_identity',
      sql`(${table.access_issuer} IS NULL) = (${table.access_subject} IS NULL)`,
    ),
  ],
);

export const platformCompanyIdentities = pgTable(
  'platform_company_identities',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.subject] }),
    uniqueIndex('platform_company_identity_user').on(table.issuer, table.user_id),
  ],
);

export const platformLoginTests = pgTable(
  'platform_login_tests',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connection_id: text('connection_id')
      .notNull()
      .references(() => platformLoginConnections.id),
    revision: integer('revision').notNull(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    login: text('login').notNull().default(''),
    expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
  },
  (table) => [index('platform_login_tests_expiry').on(table.expires_at)],
);

export const platformAuthAttempts = pgTable(
  'platform_auth_attempts',
  {
    id: text('id').primaryKey(),
    connection_id: text('connection_id')
      .notNull()
      .references(() => platformLoginConnections.id),
    revision: integer('revision').notNull(),
    generation: integer('generation').notNull(),
    purpose: text('purpose').notNull().$type<'login' | 'admin' | 'test' | 'link' | 'bootstrap'>(),
    browser_hash: text('browser_hash').notNull(),
    // Decision: Holds the upstream PKCE verifier and callback context; consumed atomically.
    context: jsonb('context').notNull().$type<Record<string, unknown>>(),
    expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
  },
  (table) => [index('platform_auth_attempts_expiry').on(table.expires_at)],
);

export const platformAuthBootstrap = pgTable(
  'platform_auth_bootstrap',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    installation_id: text('installation_id').notNull(),
    credential_hash: text('credential_hash').notNull(),
    request_hash: text('request_hash').notNull().default(''),
    claim_hash: text('claim_hash'),
    pending_identity: jsonb('pending_identity').$type<{
      revision: number;
      generation: number;
      identity: PlatformOidcIdentity;
      companyIdentity?: CompanyIdentity;
      expiresAt: string;
    }>(),
    connection_id: text('connection_id')
      .notNull()
      .references(() => platformLoginConnections.id),
    expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
    consumed_at: timestamp('consumed_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [check('platform_auth_bootstrap_singleton', sql`${table.singleton} = true`)],
);

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    slug: text('slug').notNull(),
    preview_client_id: text('preview_client_id').references(() => oauthClients.id),
    preview_workspace_id: text('preview_workspace_id'),
    preview_expires_at: timestamp('preview_expires_at', { mode: 'string', withTimezone: true }),
    // Decision: The connected application's person who pays for this project, when the application named one.
    // Empty means the person it was built for pays (see app-payer.ts).
    payer_person_id: text('payer_person_id'),
    type: text('mode').notNull().default('platform').$type<'platform' | 'spa' | 'static'>(),
    active_deployment_id: text('active_deployment_id'),
    websocket_version: integer('websocket_version').notNull().default(0),
    // Decision: Highest proxy token generation issued for this project. 0 = legacy token.
    proxy_token_gen: integer('proxy_token_gen').notNull().default(0),
    status: text('status').notNull().default('active').$type<'active' | 'deleting'>(),
    // Decision: A second mailbox name on the shared mail domain, set once by the owner. It shares one namespace
    // with slugs; a database trigger keeps them apart.
    email_alias: text('email_alias'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.user_id, table.slug),
    uniqueIndex('idx_projects_slug').on(table.slug),
    uniqueIndex('idx_projects_email_alias')
      .on(table.email_alias)
      .where(sql`${table.email_alias} IS NOT NULL`),
    index('idx_projects_user_id').on(table.user_id),
    uniqueIndex('projects_preview_workspace').on(
      table.preview_client_id,
      table.user_id,
      table.preview_workspace_id,
    ),
    check(
      'projects_preview_identity',
      sql`(${table.preview_client_id} IS NULL AND ${table.preview_workspace_id} IS NULL AND ${table.preview_expires_at} IS NULL) OR (${table.preview_client_id} IS NOT NULL AND ${table.preview_workspace_id} IS NOT NULL AND ${table.preview_expires_at} IS NOT NULL AND ${table.slug} LIKE 'preview-%')`,
    ),
  ],
);

export const projectAiLogging = pgTable(
  'project_ai_logging',
  {
    project_id: text('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull().$type<'off' | 'metadata' | 'full'>(),
  },
  (table) => [check('project_ai_logging_mode', sql`${table.mode} IN ('off', 'metadata', 'full')`)],
);

export const previewTickets = pgTable('preview_tickets', {
  token_hash: text('token_hash').primaryKey(),
  project_id: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  grant_id: text('grant_id')
    .notNull()
    .references(() => oauthGrants.id, { onDelete: 'cascade' }),
  expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
});

// Decision: Revocable project-scoped credentials for headless CI. The bearer value is a signed aud:deploy
// JWT; this row is the authoritative revocation and expiry record, checked on each request. Human
// login-provider lifecycle doesn't revoke these.
export const projectDeployCredentials = pgTable(
  'project_deploy_credentials',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issued_by: text('issued_by')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
    revoked_at: timestamp('revoked_at', { mode: 'string', withTimezone: true }),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('project_deploy_credentials_project').on(table.project_id, table.created_at),
    index('project_deploy_credentials_expiry').on(table.expires_at),
    check('project_deploy_credentials_name', sql`length(${table.name}) BETWEEN 1 AND 80`),
  ],
);

// Decision: Ownership stays authoritative on projects.user_id; owners are deliberately not duplicated in
// project_members.
export const projectMembers = pgTable(
  'project_members',
  {
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<ProjectMemberRole>(),
    // Decision: Durable audit identity. It may name an account deleted later.
    added_by_user_id: text('added_by_user_id'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.user_id] }),
    index('idx_project_members_user_project').on(table.user_id, table.project_id),
    check('project_members_role_check', sql`${table.role} IN ('reader', 'collaborator', 'admin')`),
  ],
);

export const projectInvitations = pgTable(
  'project_invitations',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    target_user_id: text('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    target_email_snapshot: text('target_email_snapshot').notNull(),
    role: text('role').notNull().$type<ProjectMemberRole>(),
    status: text('status').notNull().default('pending').$type<ProjectInvitationStatus>(),
    // Decision: Actor ids are durable audit data and have no user FK on purpose.
    invited_by_user_id: text('invited_by_user_id').notNull(),
    accepted_by_user_id: text('accepted_by_user_id'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    expires_at: timestamp('expires_at', { mode: 'string' }).notNull(),
    accepted_at: timestamp('accepted_at', { mode: 'string' }),
    revoked_at: timestamp('revoked_at', { mode: 'string' }),
    revoked_by_user_id: text('revoked_by_user_id'),
  },
  (table) => [
    index('idx_project_invitations_project_status').on(table.project_id, table.status),
    index('idx_project_invitations_target_status').on(table.target_user_id, table.status),
    uniqueIndex('idx_project_invitations_pending_target')
      .on(table.project_id, table.target_user_id)
      .where(sql`${table.status} = 'pending'`),
    check(
      'project_invitations_role_check',
      sql`${table.role} IN ('reader', 'collaborator', 'admin')`,
    ),
    check(
      'project_invitations_status_check',
      sql`${table.status} IN ('pending', 'accepted', 'declined', 'revoked', 'expired')`,
    ),
  ],
);

export const projectOwnershipPeriods = pgTable(
  'project_ownership_periods',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Decision: Billing and operator actor identities have to survive account deletion, so no user FK.
    owner_user_id: text('owner_user_id').notNull(),
    starts_at: timestamp('starts_at', { mode: 'string' }).notNull(),
    ends_at: timestamp('ends_at', { mode: 'string' }),
    changed_by_user_id: text('changed_by_user_id'),
  },
  (table) => [
    index('idx_project_ownership_periods_owner_time').on(
      table.owner_user_id,
      table.starts_at,
      table.ends_at,
    ),
    index('idx_project_ownership_periods_project_time').on(table.project_id, table.starts_at),
    uniqueIndex('idx_project_ownership_periods_open')
      .on(table.project_id)
      .where(sql`${table.ends_at} IS NULL`),
    check(
      'project_ownership_periods_time_check',
      sql`${table.ends_at} IS NULL OR ${table.ends_at} >= ${table.starts_at}`,
    ),
  ],
);

export const projectAccessEvents = pgTable(
  'project_access_events',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    actor_user_id: text('actor_user_id').notNull(),
    subject_user_id: text('subject_user_id'),
    invitation_email_snapshot: text('invitation_email_snapshot'),
    previous_role: text('previous_role').$type<ProjectMemberRole>(),
    new_role: text('new_role').$type<ProjectMemberRole>(),
    action: text('action').notNull().$type<ProjectAccessEventAction>(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_project_access_events_project_created').on(table.project_id, table.created_at),
    index('idx_project_access_events_subject_created').on(table.subject_user_id, table.created_at),
    check(
      'project_access_events_previous_role_check',
      sql`${table.previous_role} IS NULL OR ${table.previous_role} IN ('reader', 'collaborator', 'admin')`,
    ),
    check(
      'project_access_events_new_role_check',
      sql`${table.new_role} IS NULL OR ${table.new_role} IN ('reader', 'collaborator', 'admin')`,
    ),
    check(
      'project_access_events_action_check',
      sql`${table.action} IN ('invited', 'invitation_resent', 'member_added', 'accepted', 'declined', 'invitation_revoked', 'role_changed', 'member_removed', 'left')`,
    ),
  ],
);

// Decision: Project Cloudflare Access state. The desired/effective split is deliberate: publication spans
// several systems, and dispatch keeps enforcing the last completed state until the Access application
// change is verified. Application ids are durable recovery handles for retries and teardown.
export const projectZeroTrust = pgTable(
  'project_zero_trust',
  {
    project_id: text('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    desired_protected: boolean('desired_protected').notNull().default(false),
    effective_protected: boolean('effective_protected').notNull().default(false),
    // Decision: `ready` means routes and Access applications match the desired protection.
    status: text('status').notNull().default('ready').$type<'ready' | 'reconciling' | 'error'>(),
    bypass_application_id: text('bypass_application_id'),
    bypass_application_name: text('bypass_application_name'),
    protected_application_id: text('protected_application_id'),
    protected_application_name: text('protected_application_name'),
    protected_application_audience: text('protected_application_audience'),
    // Decision: Last custom hostname whose routing protection was cleared. Public projects can have more domains
    // than fit in one reconciliation run.
    routing_cursor: text('routing_cursor'),
    // Decision: Id of the installation operation this row last completed. Public rows complete with their bypass;
    // protected rows only after the wildcard phase.
    reconciled_operation: text('reconciled_operation'),
    last_error: text('last_error'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_project_zero_trust_status').on(table.status, table.updated_at),
    check(
      'project_zero_trust_status_check',
      sql`${table.status} IN ('ready', 'reconciling', 'error')`,
    ),
    check(
      'project_zero_trust_ready_check',
      sql`${table.status} <> 'ready' OR ${table.desired_protected} = ${table.effective_protected}`,
    ),
  ],
);

export const deployments = pgTable(
  'deployments',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<
        | 'pending'
        | 'uploading'
        | 'migrating'
        | 'cutover'
        | 'compensating'
        | 'canceling'
        | 'live'
        | 'failed'
        | 'canceled'
      >(),
    manifest: text('manifest'),
    source: text('source'),
    commit: text('commit'),
    repository_url: text('repository_url'),
    commit_url: text('commit_url'),
    git_ref: text('git_ref'),
    cli_version: text('cli_version'),
    admission_protocol: integer('admission_protocol')
      .notNull()
      .default(0)
      .$default(() => 3),
    error_message: text('error_message'),
    asset_hashes: text('asset_hashes'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
    deployed_at: timestamp('deployed_at', { mode: 'string' }),
    retained: boolean('retained').notNull().default(false),
    applied_migrations: text('applied_migrations'),
    bundle_stored: boolean('bundle_stored').notNull().default(false),
    // Decision: billing_user_id is the project owner at admission time. The actor is recorded separately and has
    // no user FK on purpose, so audit attribution survives account deletion.
    billing_user_id: text('billing_user_id'),
    initiated_by_user_id: text('initiated_by_user_id'),
    // Decision: Proxy token generation this deployment's Worker holds. 0 = legacy token, held by each Worker
    // deployed before generations were stored.
    proxy_token_gen: integer('proxy_token_gen').notNull().default(0),
  },
  (table) => [
    index('idx_deployments_project_id').on(table.project_id, table.created_at),
    index('idx_deployments_project_status').on(table.project_id, table.status),
    index('idx_deployments_created_id').on(table.created_at, table.id),
  ],
);

// Decision: The receipt survives a no-op deployment's placeholder deletion. Execution is claimed once; an
// expired invocation is reconciled, not replayed.
export const deploymentOperations = pgTable(
  'deployment_operations',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    actor_id: text('actor_id').notNull(),
    build_id: text('build_id'),
    original_active_id: text('original_active_id'),
    cli_version: text('cli_version'),
    idempotency_key: text('idempotency_key').notNull(),
    input_digest: text('input_digest').notNull(),
    input_prefix: text('input_prefix').notNull(),
    payload: jsonb('payload')
      .notNull()
      .$type<import('./deployment-operation-types.ts').DeploymentInput>(),
    status: text('status')
      .notNull()
      .default('queued')
      .$type<'queued' | 'running' | 'recovering' | 'terminal'>(),
    owner_id: text('owner_id'),
    lease_expires_at: timestamp('lease_expires_at', { mode: 'string' }),
    next_dispatch_at: timestamp('next_dispatch_at', { mode: 'string' }).notNull().defaultNow(),
    events: jsonb('events')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<Array<import('./deployment-operation-types.ts').DeploymentProgress>>(),
    last_seq: integer('last_seq').notNull().default(0),
    inputs_deleted: boolean('inputs_deleted').notNull().default(false),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_deployment_operations_key').on(
      table.project_id,
      table.actor_id,
      table.idempotency_key,
    ),
    index('idx_deployment_operations_dispatch').on(table.status, table.next_dispatch_at),
  ],
);

// Decision: External project resources can outlive a deleted project when a provider deletion fails. These
// jobs have no project FK on purpose: the project row and its resource handles are removed after the
// jobs are recorded.
export const projectCleanupJobs = pgTable(
  'project_cleanup_jobs',
  {
    target: text('target').primaryKey(),
    project_id: text('project_id').notNull(),
    kind: text('kind')
      .notNull()
      .$type<
        | 'cf-resource'
        | 'worker'
        | 'worker-bundle'
        | 'project-assets'
        | 'routing-key'
        | 'routing-put'
        | 'cron'
        | 'custom-hostname'
        | 'proxy-token-rotation'
      >(),
    payload: jsonb('payload').notNull().$type<Record<string, string>>(),
    attempts: integer('attempts').notNull().default(0),
    last_error: text('last_error'),
    next_attempt_at: timestamp('next_attempt_at', { mode: 'string' }).notNull().defaultNow(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [index('project_cleanup_jobs_due').on(table.next_attempt_at, table.created_at)],
);

export const projectSecrets = pgTable(
  'project_secrets',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    key_version: text('key_version').notNull(),
    managed_reason: text('managed_reason'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.project_id, table.name),
    index('idx_project_secrets_project_id').on(table.project_id),
  ],
);

export const resources = pgTable(
  'resources',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    type: text('type')
      .notNull()
      .$type<'d1' | 'kv' | 'r2' | 'queue' | 'hyperdrive' | 'container' | 'durable-object'>(),
    cf_id: text('cf_id').notNull(),
    binding_name: text('binding_name').notNull(),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.project_id, table.type, table.binding_name)],
);

export type DomainVerificationData = Readonly<{
  ownership_verification?: Readonly<{
    type: 'txt';
    name: string;
    value: string;
  }>;
  ssl_validation_records?: ReadonlyArray<
    Readonly<{
      txt_name?: string;
      txt_value?: string;
      status?: string;
    }>
  >;
}>;

export const domains = pgTable(
  'domains',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    hostname: text('hostname').notNull().unique(),
    cf_hostname_id: text('cf_hostname_id').notNull(),
    status: text('status').notNull().default('pending').$type<'pending' | 'active'>(),
    verification_data: jsonb('verification_data').$type<DomainVerificationData | null>(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [index('idx_domains_project_id').on(table.project_id, table.created_at)],
);

// Decision: Per-project recipient consent for shared-sender email. Cloudflare destination tags are
// account-wide; SQL admission enforces consent for each project separately.
export const emailDestinations = pgTable(
  'email_destinations',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    status: text('status').notNull().default('pending').$type<'pending' | 'verified'>(),
    cf_destination_id: text('cf_destination_id'),
    // Decision: Audit timestamp: set when status first becomes 'verified' and not cleared. Use
    // `status === 'verified'` for the current state, not `verified_at !== null`.
    verified_at: timestamp('verified_at', { mode: 'string' }),
    // Decision: How the row reached `status='verified'`:
    // - 'cf': the Cloudflare Email Routing verification email was clicked. This includes the project
    // owner's own email when CF already had it verified on an earlier project (owner-relaxed reuse).
    // - 'platform': CF had the address verified by a different project. CF's flag can't stand for
    // per-project consent, so we send our own single-use confirmation link and keep the row 'pending'
    // until it's clicked. The source stays 'platform' afterwards for the audit trail.
    verification_source: text('verification_source')
      .notNull()
      .default('cf')
      .$type<'cf' | 'platform'>(),
    // Decision: Audit columns for owner-relaxed CF reuse (Option C in design doc 0078). Set only when
    // `verification_source = 'cf'` and the row came from the owner-relaxed branch (the address matched
    // the owner's `users.email` at insert and CF already had it verified). NULL otherwise.
    // `verified_by_email_snapshot` is the granter's email at insert. If `users.email` changes later,
    // `revokeOwnerVerifiedDestinationsForUserChange` uses it to find inherited-consent rows to revoke.
    verified_by_user_id: text('verified_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    verified_by_email_snapshot: text('verified_by_email_snapshot'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    unique('email_destinations_project_address_uq').on(table.project_id, table.address),
    index('idx_email_destinations_project_id').on(table.project_id),
    index('idx_email_destinations_cf_destination_id').on(table.cf_destination_id),
    index('idx_email_destinations_verified_by_user_id').on(
      table.verified_by_user_id,
      table.verified_by_email_snapshot,
    ),
    // Decision: Declare CHECK constraints here, not only in raw migration SQL. `drizzle-kit generate` diffs
    // against the previous snapshot: an undeclared constraint reads as dropped, and the next migration
    // would silently widen the consent gate.
    check('email_destinations_status_check', sql`${table.status} IN ('pending', 'verified')`),
    check(
      'email_destinations_verification_source_check',
      sql`${table.verification_source} IN ('cf', 'platform')`,
    ),
  ],
);

// Decision: Provider destination deletion outlives the project consent row. The opaque Cloudflare tag is kept
// as a tombstone so stale list responses can't reattach a destination while its deletion is pending
// or after it completes.
export const emailDestinationCleanups = pgTable(
  'email_destination_cleanups',
  {
    cf_destination_id: text('cf_destination_id').primaryKey(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'deleting' | 'completed'>(),
    attempts: integer('attempts').notNull().default(0),
    next_attempt_at: timestamp('next_attempt_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    lease_started_at: timestamp('lease_started_at', { mode: 'string', withTimezone: true }),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_email_destination_cleanups_due').on(
      table.status,
      table.next_attempt_at,
      table.updated_at,
    ),
    check(
      'email_destination_cleanups_status_check',
      sql`${table.status} IN ('pending', 'deleting', 'completed')`,
    ),
    check('email_destination_cleanups_attempts_check', sql`${table.attempts} >= 0`),
  ],
);

// Decision: email_domains stays for generated-schema compatibility with the published platform runtime
// rollback contract. New email routes don't use it.
export type EmailDomainSetupState = Readonly<{
  /** Orchestration step that left the row 'failed' (e.g. 'zone_lookup'). */
  failed_step?: string;
  /** Steps still owed by the human (e.g. the routing-subdomain dashboard form). */
  remaining_steps?: ReadonlyArray<string>;
  /** Historical removal failures. */
  removal_failed_steps?: ReadonlyArray<string>;
}>;

// Decision: Kept for database rollback to published platform runtimes. The current email code uses
// emailDomainRoutes and doesn't read this table.
export const emailDomains = pgTable(
  'email_domains',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    zone_id: text('zone_id'),
    account_id: text('account_id'),
    mode: text('mode').$type<'apex' | 'subdomain'>(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'active' | 'token_revoked' | 'token_expired' | 'failed'>(),
    // Decision: `platform` rows carry no credential of their own: the engine and the lease resolve them to the
    // runtime token (`CF_API_TOKEN`), so their `token_*` triple is null. The CHECK below pins that.
    credential_kind: text('credential_kind')
      .notNull()
      .$type<'oauth_grant' | 'api_token' | 'platform'>(),
    token_ciphertext: text('token_ciphertext'),
    token_iv: text('token_iv'),
    token_key_version: text('token_key_version'),
    // Decision: Who registered the row. An administrator's row runs on the platform's credential; owners may read
    // it but not sync or remove it.
    managed_by: text('managed_by').notNull().default('owner').$type<'owner' | 'admin'>(),
    relay_ciphertext: text('relay_ciphertext').notNull(),
    relay_iv: text('relay_iv').notNull(),
    relay_key_version: text('relay_key_version').notNull(),
    relay_worker_name: text('relay_worker_name'),
    relay_version: integer('relay_version'),
    token_id: text('token_id'),
    token_expires_on: timestamp('token_expires_on', { mode: 'string' }),
    // Decision: The CLI add attempt that last wrote the credential, so a CLI that lost the POST's answer can tell
    // its own committed row from an existing one. Null on rows written by an older CLI.
    attempt_id: text('attempt_id'),
    setup_state: jsonb('setup_state').$type<EmailDomainSetupState | null>(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    // Decision: A domain is globally unique, not per project: the relay secret and the `email-domain:<domain>` KV
    // mirror map to one registered domain of one project (design doc 0078, "Trust").
    unique('email_domains_domain_uq').on(table.domain),
    index('idx_email_domains_project_id').on(table.project_id),
    // Decision: One live row per zone and one relay name per account: the DB backstop for check-then-write
    // windows the engine can't close against the CF API (concurrent adds; design doc 0078). The zone
    // index covers only live statuses so a 'failed' row can still record its zone (the catch-all conflict
    // path needs it); the relay index reserves each deployed name, because the worker exists in the
    // account. A violation means another live row won the race: a 409, not a second active row.
    uniqueIndex('email_domains_zone_uq')
      .on(table.zone_id)
      .where(sql`${table.zone_id} IS NOT NULL AND ${table.status} IN ('active', 'pending')`),
    uniqueIndex('email_domains_relay_uq')
      .on(table.account_id, table.relay_worker_name)
      .where(sql`${table.relay_worker_name} IS NOT NULL`),
    // Decision: The proxy's credential lease (POST /internal/email/domain-credential) looks rows up by domain;
    // the domain unique constraint's index covers that.
    // Declare CHECK constraints here, not only in raw migration SQL: an undeclared constraint reads as
    // dropped to the next `drizzle-kit generate` diff.
    check('email_domains_mode_check', sql`${table.mode} IN ('apex', 'subdomain')`),
    check(
      'email_domains_status_check',
      sql`${table.status} IN ('pending', 'active', 'token_revoked', 'token_expired', 'failed')`,
    ),
    check(
      'email_domains_credential_kind_check',
      sql`${table.credential_kind} IN ('oauth_grant', 'api_token', 'platform')`,
    ),
    check(
      'email_domains_platform_token_check',
      sql`(${table.credential_kind} = 'platform' AND ${table.token_ciphertext} IS NULL AND ${table.token_iv} IS NULL AND ${table.token_key_version} IS NULL) OR (${table.credential_kind} <> 'platform' AND ${table.token_ciphertext} IS NOT NULL AND ${table.token_iv} IS NOT NULL AND ${table.token_key_version} IS NOT NULL)`,
    ),
    check('email_domains_managed_by_check', sql`${table.managed_by} IN ('owner', 'admin')`),
  ],
);

// Decision: Installation-scoped settings an administrator changes at runtime (design doc 0078, "Recipient
// policy"). Authoritative here; hot-path readers get a ROUTING KV mirror written by the setting's
// own writer.
export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});

// Decision: Operator sessions and mutation audit, separate from browser and deployment auth. Audit identities
// survive account deletion on purpose.
export const operatorSessions = pgTable(
  'operator_sessions',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    human_session_id: text('human_session_id').references(() => platformHumanSessions.id, {
      onDelete: 'cascade',
    }),
    expires_at: timestamp('expires_at', { mode: 'string' }).notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [index('idx_operator_sessions_expiry').on(table.expires_at)],
);

export const operatorEvents = pgTable(
  'operator_events',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    login: text('login').notNull(),
    action: text('action').notNull(),
    target: text('target').notNull(),
    status: text('status').notNull().$type<'pending' | 'success' | 'failed'>(),
    http_status: integer('http_status'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [index('idx_operator_events_created').on(table.created_at, table.id)],
);

/** Authoritative, serialized checkpoint for the managed Sandbox shutdown. */
export const sandboxDrainCheckpoints = pgTable('sandbox_drain_checkpoints', {
  singleton: boolean('singleton').primaryKey(),
  admission_protocol: integer('admission_protocol').notNull().default(0),
  generation: text('generation').notNull(),
  state: text('state').notNull().$type<'draining' | 'complete'>(),
  phase: text('phase').notNull().$type<'deployments' | 'resources'>(),
  cursor: jsonb('cursor').$type<Record<string, string> | null>(),
  lease_owner: text('lease_owner'),
  lease_expires_at: timestamp('lease_expires_at', { mode: 'string' }),
  started_at: timestamp('started_at', { mode: 'string' }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  completed_at: timestamp('completed_at', { mode: 'string' }),
});

export const platformEvents = pgTable(
  'platform_events',
  {
    id: text('id').primaryKey(),
    batch_id: text('batch_id'),
    action: text('action').notNull().$type<'rollback' | 'rollback_all'>(),
    worker_name: text('worker_name').notNull().$type<PlatformWorkerName>(),
    environment: text('environment').notNull().$type<PlatformEnv>(),
    version_id: text('version_id').notNull(),
    script_name: text('script_name').notNull(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'success' | 'failed' | 'skipped'>(),
    error_message: text('error_message'),
    admin_user_id: text('admin_user_id').notNull(),
    admin_login: text('admin_login').notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_platform_events_batch_id').on(table.batch_id),
    index('idx_platform_events_env_created').on(table.environment, table.created_at),
  ],
);

// Decision: oauth_nonces: short-lived, single-use tokens for OAuth CSRF and replay protection. They're in
// PostgreSQL, not KV, because login and callback can hit different CF colos and KV's eventual
// consistency would make lookups flaky. Atomic DELETE ... RETURNING gives true single use.
export const oauthNonces = pgTable('oauth_nonces', {
  nonce: text('nonce').primaryKey(),
  expires_at: timestamp('expires_at', { mode: 'string' }).notNull(),
});

// Decision: auth_codes: short-lived, single-use codes for dashboard login. In PostgreSQL for the same reason
// as oauth_nonces, with atomic DELETE ... RETURNING for single use.
export const authCodes = pgTable('auth_codes', {
  code: text('code').primaryKey(),
  jwt: text('jwt').notNull(),
  cli_state: text('cli_state'),
  code_challenge: text('code_challenge'),
  code_challenge_method: text('code_challenge_method'),
  expires_at: timestamp('expires_at', { mode: 'string' }).notNull(),
});

// Decision: migration_renames: audit log of committed `/migrations/rename` pairs, written in the same locked
// transaction as the D1 UPDATE and the pg rewrite, so a row exists only if both committed. It's the
// second source that lets a same-payload retry after a partial-failure heal be recognized as genuine:
// the heal rewrites the active deployment's `applied_migrations`, erasing the other evidence.
export const migrationRenames = pgTable(
  'migration_renames',
  {
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    from_name: text('from_name').notNull(),
    to_name: text('to_name').notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.from_name, table.to_name] }),
    index('idx_migration_renames_project_id').on(table.project_id),
  ],
);

// Decision: project_migrations: the current truth for the project database.
export const projectMigrations = pgTable(
  'project_migrations',
  {
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    applied_at: timestamp('applied_at', { mode: 'string' }).notNull().defaultNow(),
    source_deployment_id: text('source_deployment_id').references(() => deployments.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.name] }),
    index('idx_project_migrations_project_id').on(table.project_id, table.applied_at),
  ],
);

export const projectDatabaseCredentials = pgTable('project_database_credentials', {
  project_id: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  key_version: text('key_version').notNull(),
  created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});

// Decision: project_credentials: third-party tokens the proxy attaches to outbound requests. They aren't
// injected into a worker or returned by any procedure after they're stored.
export const projectCredentials = pgTable(
  'project_credentials',
  {
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    key_version: text('key_version').notNull(),
    /** Repositories (owner/name) the token may reach through the proxy. */
    repositories: text('repositories').array().notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.project_id, table.provider] })],
);

// Decision: project_github_installations: a GitHub App installation an app's own people connected
// for one of the app's spaces (`scope`, the app's id for it, such as a server). The proxy mints that
// installation's token per call, so the app never holds the App key or a long-lived token.
export const projectGitHubInstallations = pgTable(
  'project_github_installations',
  {
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    installation_id: text('installation_id').notNull(),
    account_login: text('account_login').notNull(),
    account_id: text('account_id').notNull(),
    /** The nonce of the signed state the connection was made under, so the app can match it. */
    state_nonce: text('state_nonce').notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.project_id, table.scope] })],
);

/**
 * The same as `project_github_installations`, for a connected application that Platform does
 * not host. The application is the owner, and `scope` is its own id for the space.
 */
export const appGitHubInstallations = pgTable(
  'app_github_installations',
  {
    client_id: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    installation_id: text('installation_id').notNull(),
    account_login: text('account_login').notNull(),
    account_id: text('account_id').notNull(),
    state_nonce: text('state_nonce').notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.client_id, table.scope] })],
);

// Decision: `user_id` is the owner of a personal (account_type='User') installation and is null for
// organization installations, which are reached only through `github_installation_members`. A
// personal installation can be unlinked (install before sign-in) until the GitHub OAuth callback
// backfills it (`linkGitHubInstallationToUser`). `repositories` mirrors the repo selection as a JSON
// array of `{ full_name, id }`.
export type GitHubInstallationRepository = Readonly<{
  full_name: string;
  id: number;
}>;

export const githubInstallations = pgTable(
  'github_installations',
  {
    id: text('id').primaryKey(),
    installation_id: text('installation_id').notNull().unique(),
    // Decision: `set null`, not NO ACTION: deleting a linked user mustn't fail on this FK. The row goes back to
    // user_id=null (the install-before-sign-in state) and can be re-linked.
    user_id: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    account_login: text('account_login').notNull(),
    account_id: text('account_id').notNull(),
    account_type: text('account_type').notNull().$type<'User' | 'Organization'>(),
    repositories: jsonb('repositories')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<ReadonlyArray<GitHubInstallationRepository>>(),
    // Decision: `all` grants every repo in the account (the `repositories` cache is then unused); `selected`
    // limits to the cached set. Default `selected`, so the OIDC lookup needs explicit membership unless a
    // webhook proves an all-repos install. An empty `repositories` array doesn't mean "all".
    repository_selection: text('repository_selection')
      .notNull()
      .default('selected')
      .$type<'all' | 'selected'>(),
    status: text('status').notNull().default('active').$type<'active' | 'suspended' | 'deleted'>(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_github_installations_user_id').on(table.user_id),
    index('idx_github_installations_account_id').on(table.account_id),
  ],
);

// Decision: `project_id` is unique (one connection per project) and cascades on project delete.
// `build_executor` picks the build backend on push: CF Containers (`container`) or GitHub Actions
// (`github_actions`).
export const githubConnections = pgTable(
  'github_connections',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .unique()
      .references(() => projects.id, { onDelete: 'cascade' }),
    installation_id: text('installation_id').notNull(),
    repo_full_name: text('repo_full_name').notNull(),
    // Decision: The repo's immutable numeric GitHub id, as text. A repo can be renamed, deleted or have its name
    // reused, so `repo_full_name` is unsafe as a routing key and could deploy to the wrong project.
    // Webhook (`repository.id`) and OIDC (`claims.repository_id`) resolution match on this id;
    // `repo_full_name` is display and fetch metadata.
    repository_id: text('repository_id').notNull(),
    // Decision: The project owner or administrator who proved repo access at connect. Runtime authorization
    // accepts the row only while this still names the owner or a project administrator. Each path that
    // removes that authority deletes the connection first, so deleting a user who still authorizes a
    // connection fails instead of leaving it behind.
    authorized_by_user_id: text('authorized_by_user_id')
      .notNull()
      .references(() => users.id),
    branch: text('branch').notNull().default('main'),
    build_executor: text('build_executor')
      .notNull()
      .default('container')
      .$type<'container' | 'github_actions'>(),
    // Decision: The `.github/workflows/*.yml` file the GitHub Actions OIDC exchange binds the deploy token to (see
    // `routes/auth-oidc.ts`). Only the authenticated connect and update routes write it, not the webhook
    // or the OIDC path, so it stays a trusted server-side pin.
    workflow_path: text('workflow_path').notNull().default('.github/workflows/bwf-deploy.yml'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_github_connections_installation_id').on(table.installation_id),
    index('idx_github_connections_repo_full_name').on(table.repo_full_name),
    index('idx_github_connections_installation_repo_id').on(
      table.installation_id,
      table.repository_id,
    ),
  ],
);

// Decision: github_installation_members: cached org co-membership for org-shared installs. A row records that
// a Platform user was verified as a member of the GitHub account behind an installation. It's a TTL
// cache with no GitHub token: access is re-verified per repo. `installation_id` is GitHub's numeric
// id as text with no `.references()`, like `github_connections.installation_id`. `user_id` cascades
// on user delete. `github_account_id` is the GitHub account that proved membership; each writer sets
// it, but it stays nullable while the schema-compat CI job runs the deployed runtime's tests, which
// still insert rows without it.
export const githubInstallationMembers = pgTable(
  'github_installation_members',
  {
    id: text('id').primaryKey(),
    installation_id: text('installation_id').notNull(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    github_account_id: text('github_account_id'),
    verified_at: timestamp('verified_at', { mode: 'string' }).notNull().defaultNow(),
    expires_at: timestamp('expires_at', { mode: 'string' }).notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_github_installation_members_install_user').on(
      table.installation_id,
      table.user_id,
    ),
    index('idx_github_installation_members_user_id').on(table.user_id),
  ],
);

// Decision: github_installation_revocations: durable per-(installation, github_account) tombstone. Membership
// rows are a TTL cache that `member_removed` hard-deletes, so alone they can't make revocation
// monotonic: a removed member could replay a pre-minted join_code or connect_grant within its
// 5-minute TTL. `member_removed` upserts `revoked_at = now()`, and the join and connect gates reject
// artifacts with `iat <= revoked_at`; a re-join after re-add has `iat > revoked_at`.
// Key on the GitHub account id, not a Platform user id: it's what the artifacts carry and what the
// webhook payload reliably gives, and a member can pre-mint artifacts with no Platform user at all.
// Both ids are numeric text with no FK, so the tombstone outlives user deletion.
export const githubInstallationRevocations = pgTable(
  'github_installation_revocations',
  {
    id: text('id').primaryKey(),
    installation_id: text('installation_id').notNull(),
    github_account_id: text('github_account_id').notNull(),
    // Decision: `withTimezone` matters here, unlike the tz-naive timestamps elsewhere. This value is read back as
    // an absolute epoch (`extract(epoch from ...) * 1000`) to compare with a JS `iat`. A tz-naive
    // `timestamp` stores `now()` as session-local wall clock, and `extract(epoch ...)` treats it as UTC,
    // so on a non-UTC session (PGlite in tests uses the host tz) the epoch is skewed. Membership TTLs
    // avoid this only because they compare in SQL.
    revoked_at: timestamp('revoked_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_github_installation_revocations_install_account').on(
      table.installation_id,
      table.github_account_id,
    ),
  ],
);

// Decision: github_webhook_redeliveries: ledger of deliveries we asked GitHub to redeliver (design 0074).
// GitHub's delivery log is the truth for what we failed to ack; the hourly replay job lists
// `status=failure` deliveries and re-sends each one not yet retried. The dedup key is GitHub's
// `guid`, stable across an event's delivery and redeliveries, so each failed event is retried at
// most once.
export const githubWebhookRedeliveries = pgTable(
  'github_webhook_redeliveries',
  {
    id: text('id').primaryKey(),
    // Decision: GitHub delivery guid, shared across an event's original delivery and its redeliveries: the dedup
    // key.
    guid: text('guid').notNull(),
    delivery_id: text('delivery_id').notNull(),
    event: text('event'),
    status_code: integer('status_code'),
    redelivered_at: timestamp('redelivered_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    // Decision: The unique index on guid is the onConflictDoNothing target, so concurrent runs can't redeliver
    // the same event twice.
    uniqueIndex('idx_github_webhook_redeliveries_guid').on(table.guid),
  ],
);

// Decision: builds: server-side build runs. A build runs the real `bwf deploy` CLI in a CF Container or a
// GitHub Actions runner and gets a `deployment_id` once the deploy endpoint accepts the manifest.
// `status` tracks the build lifecycle separately from the deployment's status.
export const builds = pgTable(
  'builds',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    executor: text('executor')
      .notNull()
      .default('container')
      .$type<'container' | 'github_actions'>(),
    status: text('status')
      .notNull()
      .default('queued')
      .$type<
        'queued' | 'starting' | 'building' | 'deploying' | 'complete' | 'failed' | 'cancelled'
      >(),
    commit_sha: text('commit_sha'),
    branch: text('branch'),
    deployment_id: text('deployment_id').references(() => deployments.id),
    github_run_id: text('github_run_id'),
    // Decision: A workflow rerun reuses `run_id` with a higher `run_attempt`, so `(github_run_id,
    // github_run_attempt)` identifies one attempt. NULL means a container build. The `workflow_run`
    // completion handler matches on the attempt so a late completion from attempt 1 can't finalize
    // attempt 2's build.
    github_run_attempt: text('github_run_attempt'),
    logs_url: text('logs_url'),
    // Decision: NULL means no check run was created (Actions builds, builds that failed a pre-create recheck,
    // older builds, or a failed best-effort create). Finalizers no-op when it's NULL.
    check_run_id: text('check_run_id'),
    error: text('error'),
    exit_code: integer('exit_code'),
    instance_type: text('instance_type'),
    started_at: timestamp('started_at', { mode: 'string' }),
    completed_at: timestamp('completed_at', { mode: 'string' }),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_builds_project_created').on(table.project_id, table.created_at),
    index('idx_builds_status').on(table.status),
    index('idx_builds_user_status').on(table.user_id, table.status),
    // Decision: A GitHub Actions `run_id` is unique only within a repository, so build identity is scoped to the
    // project. This partial unique index closes the concurrent OIDC exchange race (two active rows for
    // one run) without colliding across projects that share a run_id.
    // It covers active statuses only (`starting`/`building`/`deploying`, like `ACTIVE_BUILD_STATUSES` in
    // db.ts): at most one active build per (project, run_id, run_attempt). The attempt is in the key so
    // two attempts can be briefly active together. Terminal rows aren't covered, so a rerun after a
    // terminal attempt can start fresh. Container builds (NULL run_id) are exempt.
    uniqueIndex('idx_builds_project_github_run_id')
      .on(table.project_id, table.github_run_id, table.github_run_attempt)
      .where(
        sql`${table.github_run_id} IS NOT NULL AND ${table.github_run_attempt} IS NOT NULL AND ${table.status} IN ('starting', 'building', 'deploying')`,
      ),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    status: text('status').notNull().default('pending').$type<InvitationStatus>(),
    // Decision: Null covers invitations created before delivery tracking and interrupted attempts.
    email_delivery_status: text('email_delivery_status').$type<InvitationEmailDeliveryStatus>(),
    // Decision: Invitation actor ids are durable audit data and outlive the user rows on purpose, like
    // operator_events.user_id.
    invited_by: text('invited_by').notNull(),
    accepted_by: text('accepted_by'),
    revoked_at: timestamp('revoked_at', { mode: 'string' }),
    revoked_by: text('revoked_by'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    accepted_at: timestamp('accepted_at', { mode: 'string' }),
  },
  (table) => [
    index('idx_invitations_email').on(table.email),
    index('idx_invitations_status').on(table.status),
    check(
      'invitations_email_delivery_status_check',
      sql`${table.email_delivery_status} IS NULL OR ${table.email_delivery_status} IN ('sent', 'failed', 'unavailable')`,
    ),
  ],
);

export * from './email/connection-schema.ts';

export * from './email/admission-schema.ts';
