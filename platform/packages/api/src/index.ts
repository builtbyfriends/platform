import {
  createPlatformDiscoveryDocument,
  readPlatformApplication,
  resolvePlatformApplicationEnvironment,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
} from '@builtbyfriends/platform';
import { eq, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { adminFateHandler } from './admin/fate/server.ts';
import { adminAuthMiddleware } from './admin/middleware/auth.ts';
import { adminCsrfMiddleware } from './admin/middleware/csrf.ts';
import adminAuthConfig from './admin/routes/auth-config.tsx';
import adminBuilds from './admin/routes/builds.tsx';
import connectedApps from './admin/routes/connected-apps.ts';
import adminDeployments from './admin/routes/deployments.tsx';
import adminEmail from './admin/routes/email.tsx';
import adminInvitations from './admin/routes/invitations.tsx';
import adminLogin from './admin/routes/login.ts';
import adminPlans from './admin/routes/plans.ts';
import adminProjects from './admin/routes/projects.tsx';
import adminSignupControl from './admin/routes/signup-control.tsx';
import { dashboardHandler, adminSystem } from './admin/routes/system.tsx';
import adminUsers from './admin/routes/users.tsx';
import adminZeroTrust from './admin/routes/zero-trust.tsx';
import { sweepAiLogging } from './ai-logging-sweep.ts';
import { pendingAuthenticationSetup } from './auth/bootstrap.ts';
import { readAuthSettings, readEnabledLoginConnections } from './auth/configuration.ts';
import { purgeExpiredOAuthRequests } from './auth/oauth.ts';
import { BuildManager, BuildManagerLarge } from './build-manager.ts';
import { BuildScheduler } from './build-scheduler.ts';
import { capabilityMiddleware, getPlatformCapabilities } from './capabilities.ts';
import { CronScheduler } from './cron-scheduler.ts';
import {
  createDb,
  getUsersWithProjectsBatch,
  unsuspendUserIfReason,
  getDomainsByProjectIds,
  getPendingDomainsOlderThan,
  getPendingDomains,
  getPendingDomainsNewerThan,
  deleteDomain,
  purgeExpiredOAuthNonces,
  purgeExpiredAuthCodes,
  failStaleDeployments,
  failStaleActiveContainerBuilds,
  failStaleActiveGithubActionsBuilds,
  hasQueuedContainerBuilds,
  getProject,
  getDomain,
  getOpenProjectOwnershipPeriodsByProjectIds,
  getProjectsByIds,
  getUsersByIds,
  type Db,
} from './db.ts';
import {
  deploymentExecutionStatus,
  dispatchPendingDeployments,
  sweepStaleDeploymentInputs,
} from './deployment-execution.ts';
import { pruneEmailActionHistory } from './email/admission.ts';
import { emailDomainRoutes, emailOperations } from './email/connection-schema.ts';
import {
  ensureSharedEmailConnection,
  reconcilePendingEmailOperations,
  runEmailOperation,
  flushEmailCacheOutbox,
} from './email/connection-service.ts';
import { isValidEmailDomain, MAX_DOMAIN_LENGTH } from './email/domain-name.ts';
import emailIngressResolution from './email/ingress-resolution.ts';
import { repairEmailRecipientPolicyMirror } from './email/settings.ts';
import { reconcileSharedEmailRecipients } from './email/shared-recipient-service.ts';
import { isDevBypass, type ApiEnv } from './env.ts';
import { ErrorAlertMonitor } from './error-alert-monitor.ts';
import { cancelContainerBuildDos } from './github/cancel-builds.ts';
import { withCurrentRequestNames } from './legacy-request-names.ts';
import { authMiddleware } from './middleware/auth.ts';
import { platformAccessProtection } from './middleware/platform-access.ts';
import {
  isMaintenanceReadRequest,
  isMaintenanceLoginCallback,
  isAdministratorCallback,
} from './middleware/platform-maintenance.ts';
import {
  platformWelcomePage,
  platformInvitationPage,
  platformRestrictedSignupPage,
} from './onboarding-pages.ts';
import { operatorApi } from './operator/index.ts';
import { sandboxDrainStatus } from './operator/sandbox-operations.ts';
import { initialPlanDefaultFor } from './plans.ts';
import { platformAppAccess, platformAppAccessTurnOff } from './platform-app-access.ts';
import { platformDomainActivation } from './platform-domain-activation.ts';
import { platformDomainPreflight } from './platform-domain-preflight.ts';
import { getPlatformApiUrl, getPlatformDisplayName } from './platform-identity.ts';
import { processPlatformQueue } from './platform-queue.ts';
import { tryActivateDomain } from './provisioning/activate-domain.ts';
import { reconcileProjectCleanupJobs, reapExpiredPreviews } from './provisioning/cleanup.ts';
import {
  CloudflareApiError,
  deleteCustomHostname,
  getCustomHostname,
} from './provisioning/cloudflare-api.ts';
import { reconcileEmailDestinationCleanups } from './provisioning/email-destination-cleanup.ts';
import { retrySandboxControllerCleanup } from './provisioning/sandbox-controller.ts';
import { reconcileProxyTokenRotations } from './proxy-token-rotation.ts';
import { appBillingRoutes } from './routes/app-billing.ts';
import { appGitHubRoutes } from './routes/app-github.ts';
import { oidcRoutes } from './routes/auth-oidc.ts';
import auth from './routes/auth.ts';
import deleteRoute from './routes/delete.ts';
import emailConfirm from './routes/email-confirm.ts';
import emailRoutes from './routes/email.ts';
import { githubAppRoutes } from './routes/github-app.ts';
import { githubProjectRoutes, githubRoutes } from './routes/github.ts';
import internalAiLogging from './routes/internal-ai-logging.ts';
import internalCredential from './routes/internal-credential.ts';
import internalEmailActions from './routes/internal-email-actions.ts';
import internalEmailDomainCredential from './routes/internal-email.ts';
import internalGitHubApp from './routes/internal-github-app.ts';
import internalGitHubWebhook from './routes/internal-github-webhook.ts';
import internalResolveResource from './routes/internal-resolve-resource.ts';
import internalResolveWorker from './routes/internal-resolve-worker.ts';
import internalVerifyOwner from './routes/internal-verify-owner.ts';
import oauth, { oauthMetadata } from './routes/oauth.ts';
import platformBootstrapRoutes from './routes/platform-bootstrap.ts';
import projectZeroTrustRoutes from './routes/project-zero-trust.ts';
import projects from './routes/projects.ts';
import { stripeWebhookRoutes } from './routes/stripe-webhook.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { setProjectsRoutingSuspension } from './routing.ts';
import { appRpcRoutes } from './rpc/app-route.ts';
import { mcpRoutes, rpcRoutes } from './rpc/route.ts';
import { SandboxConcurrencyCounter } from './sandbox-concurrency-counter.ts';
import { SandboxControl } from './sandbox-control.ts';
import {
  operatorSessions,
  platformAuthAttempts,
  platformLoginTests,
  platformHumanSessions,
} from './schema.ts';
import { isAdminSuspended, REASON_REQUESTS_EXCEEDED } from './suspension.ts';
import { getCurrentBillingPeriodStart } from './tiers.ts';
import type { Domain } from './types.ts';
import { ensureUsageSigningKey, USAGE_PROTOCOL_VERSION } from './usage-auth.ts';
import { UsageCounter } from './usage-counter.ts';
import { replayFailedWebhookDeliveries } from './webhook-replay.ts';
import { resumePlatformZeroTrustOperation } from './zero-trust/installation.ts';
import { lockZeroTrustConfiguration } from './zero-trust/lock.ts';
import { reconcilePendingProjectZeroTrust } from './zero-trust/maintenance.ts';
import { reconcileProjectZeroTrustDomains } from './zero-trust/project.ts';
import {
  resolveProjectZeroTrustRoutingForPublication,
  withProjectZeroTrustRouting,
} from './zero-trust/routing.ts';
import { markProjectCustomDomainsChanged } from './zero-trust/state.ts';

function sharedEmailBootstrapFailureDetail(
  domain: string | null,
  detail: string | null,
): string | null {
  // Decision: Provider errors may contain arbitrary response content. Only show the installer readiness reasons
  // that our own route inspector generated.
  if (!domain || domain.length > MAX_DOMAIN_LENGTH || !isValidEmailDomain(domain)) {
    return null;
  }
  const safeReasons = [
    `MX records for ${domain} do not route mail to Cloudflare Email Routing`,
    'zone catch-all does not point to this ingress',
    `enabled explicit Cloudflare email rules conflict with ${domain}`,
    'another enabled catch-all owns this zone',
  ];
  return detail !== null && safeReasons.includes(detail) ? detail : null;
}

function isSandboxDrainMaintenanceRequest(request: Request): boolean {
  const path = new URL(request.url).pathname;
  const method = request.method;
  return (
    (path === '/operator/v1/system/sandbox-drain' && method === 'POST') ||
    (path === '/operator/v1/session' && (method === 'GET' || method === 'POST')) ||
    (path === '/operator/v1/session/logout' && method === 'POST') ||
    (path === '/auth/login' && method === 'GET') ||
    (path === '/auth/callback' && method === 'GET') ||
    (path === '/auth/exchange' && method === 'POST') ||
    (path === '/auth/cli/token' && method === 'POST')
  );
}

const app = new Hono<ApiEnv>()
  // Decision: No platform page is meant to be framed. Tenant apps can share a site with the API (on workers.dev,
  // for example), so a framing page would get the admin cookie.
  .use('*', async (context, next) => {
    await next();
    if (
      !/^\/oauth\/preview-serve\/proj_[a-z0-9]+$/.test(context.req.path) &&
      context.res.headers.get('Content-Type')?.startsWith('text/html')
    ) {
      context.header('X-Frame-Options', 'DENY');
      context.header('Content-Security-Policy', "frame-ancestors 'none'");
    }
  })
  .use('*', async (context, next) => {
    context.env = await resolvePlatformApplicationEnvironment(context.env);
    await next();
  })

  // Decision: Catch-all error handler. Without it Hono returns a plain-text `Internal Server Error` that the CLI
  // and dashboard can't read. Routes handle known cases inline; this is the safety net. The body is a
  // generic string on purpose: raw `err.message` would leak DB constraint names, library internals
  // or connection-string fragments. The full error is logged.
  .onError((err, context) => {
    console.error('[api] unhandled error:', err);
    return context.json({ error: 'Internal Server Error' }, 500);
  })

  // Decision: Lifecycle disablement lives in installation-owned KV, so it also gates workers.dev without
  // changing a reusable Worker script name.
  .use('*', async (context, next) => {
    const healthProbeToken = context.env.PLATFORM_HEALTH_PROBE_TOKEN;
    const installerProbe =
      healthProbeToken !== undefined &&
      healthProbeToken !== '' &&
      context.req.header('X-Platform-Probe') === healthProbeToken &&
      (context.req.path === '/health' ||
        context.req.path === '/.well-known/platform' ||
        context.req.path === '/internal/platform/sandbox-drain' ||
        context.req.path === '/__platform/platform/deployment-execution' ||
        (context.req.path === '/internal/platform/email-bootstrap' &&
          context.req.method === 'POST') ||
        (context.req.path === '/internal/platform/app-access' && context.req.method === 'POST') ||
        (context.req.path === '/internal/platform/app-access/turn-off' &&
          context.req.method === 'POST') ||
        (context.req.path === '/internal/platform/domain-preflight' &&
          context.req.method === 'POST') ||
        (context.req.path === '/internal/platform/domain-activate' &&
          context.req.method === 'POST'));
    const maintenanceSandboxDrain =
      context.env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain' &&
      isSandboxDrainMaintenanceRequest(context.req.raw);
    const authenticationSetup =
      context.env.PLATFORM_AUTH_SETUP_TOKEN &&
      context.req.header('X-Platform-Auth-Setup') &&
      context.req.method === 'POST' &&
      context.req.path === '/internal/platform/auth-initialize';
    // Decision: An upgrade or repair pauses traffic until it commits.
    const maintenance =
      context.env.PLATFORM_TRAFFIC_STATE === 'staging' ||
      context.env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain';
    const trafficPaused =
      maintenance ||
      !!(
        !authenticationSetup &&
        !installerProbe &&
        !maintenanceSandboxDrain &&
        context.env.PLATFORM_INSTALLATION_ID &&
        (await context.env.ROUTING.get(PLATFORM_DISABLED_KEY)) === PLATFORM_DISABLED_VALUE
      );
    context.set('platformTrafficPaused', trafficPaused);
    if (context.req.path === '/admin/status' || context.req.path === '/admin/status.json') {
      context.header('Cache-Control', 'private, no-store');
    }
    if (
      !authenticationSetup &&
      !installerProbe &&
      !maintenanceSandboxDrain &&
      !isMaintenanceReadRequest(context) &&
      !isMaintenanceLoginCallback(context) &&
      trafficPaused
    ) {
      if (
        context.req.method === 'GET' &&
        (context.req.path === '/admin' || context.req.path.startsWith('/admin/')) &&
        (context.req.header('Accept')?.includes('text/html') ||
          context.req.header('X-PlatformPages') === 'true')
      ) {
        context.header('Cache-Control', 'private, no-store');
        return context.redirect('/admin/status', 302);
      }
      context.header('Cache-Control', 'no-store');
      context.header('Retry-After', '30');
      return context.json(
        maintenance
          ? { error: 'Platform disabled', reason: 'maintenance' }
          : { error: 'Platform disabled' },
        503,
      );
    }
    await next();
  })

  .use('*', async (context, next) => {
    context.set('db', createDb(context.env.HYPERDRIVE.connectionString));
    await next();
  })

  .use('*', platformAccessProtection)

  .use('*', async (context, next) => {
    if (
      context.get('platformTrafficPaused') &&
      isMaintenanceLoginCallback(context) &&
      !(
        context.env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain' &&
        isSandboxDrainMaintenanceRequest(context.req.raw)
      ) &&
      !(await isAdministratorCallback(context))
    ) {
      context.header('Cache-Control', 'no-store');
      return context.json({ error: 'Platform disabled' }, 503);
    }
    await next();
  })

  .get('/health', async (context) => {
    try {
      // Decision: Provision the trusted queue key before an installer enables traffic. Dispatch gets only this
      // purpose-separated derivative through ROUTING; tenant Workers get neither the key nor a ROUTING
      // binding.
      await ensureUsageSigningKey(context.env.ROUTING, context.env.JWT_SECRET);
      const installationId = context.env.PLATFORM_INSTALLATION_ID;
      if (installationId) {
        const result = await context.get('db').execute<{
          installation_id: string;
          users_table: string | null;
        }>(sql`
          SELECT
            "installation_id",
            to_regclass('"users"')::text AS "users_table"
          FROM "__void_platform_installation"
          WHERE "singleton" = true
        `);
        const claim = result.rows[0];
        if (claim?.installation_id !== installationId || claim.users_table !== 'users') {
          throw new Error('The database does not match the deployed platform installation.');
        }
      } else {
        // Decision: Platform doesn't use the self-hosted installation claim. Still touch the configured database and a
        // required schema relation so this endpoint can't report healthy from Worker startup alone.
        await context.get('db').execute(sql`SELECT 1 FROM "users" LIMIT 1`);
      }
      return context.json({ status: 'ok' });
    } catch (error) {
      console.error('[api] health check failed:', error);
      return context.json({ status: 'unhealthy' }, 503);
    }
  })
  .get('/.well-known/platform', async (context) => {
    context.header('Cache-Control', 'no-store');
    const settings = await readAuthSettings(context.get('db'));
    const setupPending = settings && !!(await pendingAuthenticationSetup(context.get('db')));
    const methods = settings
      ? (await readEnabledLoginConnections(context.get('db'))).map(({ configuration }) => ({
          id: configuration.id,
          kind: configuration.kind,
          label: configuration.label,
        }))
      : undefined;
    const capabilities = {
      ...getPlatformCapabilities(context.env),
      ...(methods
        ? {
            githubOAuth: methods.some((method) => method.kind === 'github'),
            googleOAuth: methods.some((method) => method.kind === 'google'),
          }
        : {}),
    };
    return context.json(
      createPlatformDiscoveryDocument({
        apiUrl: new URL(context.req.url).origin,
        applicationDomain: context.env.SITE_DOMAIN ?? 'buildwf.dev',
        ...(context.env.PLATFORM_APPLICATION
          ? { applicationRouting: readPlatformApplication(context.env) }
          : {}),
        authenticationProviders: methods?.map((method) => method.id) ?? [
          ...(capabilities.githubOAuth ? (['github'] as const) : []),
          ...(capabilities.googleOAuth ? (['google'] as const) : []),
        ],
        ...(methods
          ? {
              authentication: {
                methods,
                protectedByAccess: !!settings?.protection,
                ...(setupPending ? { setupPending: true } : {}),
              },
            }
          : {}),
        capabilities,
        displayName: context.env.PLATFORM_DISPLAY_NAME ?? 'Platform',
        ...(context.env.DASHBOARD_URL ? { dashboardUrl: context.env.DASHBOARD_URL } : {}),
        installationId: context.env.PLATFORM_INSTALLATION_ID ?? null,
        platformVersion: context.env.PLATFORM_VERSION ?? 'hosted',
        proxyUrl:
          context.env.PROXY_URL ??
          (context.env.PLATFORM_ENV === 'staging'
            ? 'https://proxy.staging.void.cloud'
            : 'https://void-platform-proxy.buildwithfriends.workers.dev'),
        usageProtocolVersion: USAGE_PROTOCOL_VERSION,
      }),
    );
  })
  .post('/internal/platform/app-access', platformAppAccess)
  .post('/internal/platform/app-access/turn-off', platformAppAccessTurnOff)
  .post('/internal/platform/domain-preflight', platformDomainPreflight)
  .post('/internal/platform/domain-activate', platformDomainActivation)
  .post('/internal/platform/email-bootstrap', async (context) => {
    const healthProbeToken = context.env.PLATFORM_HEALTH_PROBE_TOKEN;
    if (
      !healthProbeToken ||
      context.req.header('X-Platform-Probe') !== healthProbeToken ||
      !context.env.PLATFORM_INSTALLATION_ID ||
      !getPlatformCapabilities(context.env).email
    ) {
      return context.json({ error: 'not found' }, 404);
    }
    let operationId: string | null = null;
    try {
      const db = context.get('db');
      operationId = await ensureSharedEmailConnection(db, context.env);
      if (!operationId) {
        return context.json({ version: 1, state: 'unconfigured' }, 503);
      }
      await runEmailOperation(db, context.env, operationId);
      const operation = (
        await db
          .select({
            currentStep: emailOperations.current_step,
            failureCode: emailOperations.failure_code,
            failureDetail: emailOperations.failure_detail,
            routeId: emailOperations.route_id,
            status: emailOperations.status,
          })
          .from(emailOperations)
          .where(eq(emailOperations.id, operationId))
          .limit(1)
      )[0];
      const route = operation?.routeId
        ? (
            await db
              .select({
                desiredState: emailDomainRoutes.desired_state,
                domain: emailDomainRoutes.domain,
                inboundStatus: emailDomainRoutes.inbound_status,
              })
              .from(emailDomainRoutes)
              .where(eq(emailDomainRoutes.id, operation.routeId))
              .limit(1)
          )[0]
        : null;
      if (
        operation?.status !== 'completed' ||
        route?.desiredState !== 'active' ||
        route.inboundStatus !== 'ready'
      ) {
        return context.json(
          {
            version: 1,
            state: 'incomplete',
            operationId,
            operationStatus: operation?.status ?? 'missing',
            currentStep: operation?.currentStep ?? null,
            failureCode: operation?.failureCode ?? null,
            failureDetail: sharedEmailBootstrapFailureDetail(
              route?.domain ?? null,
              operation?.failureDetail ?? null,
            ),
            domain: route?.domain ?? null,
            inboundStatus: route?.inboundStatus ?? null,
          },
          503,
        );
      }
      return context.json({ version: 1, state: 'ready', operationId });
    } catch (error) {
      console.error('[api] shared email installer bootstrap failed', error);
      return context.json(
        {
          version: 1,
          state: 'failed',
          ...(operationId ? { operationId, operationStatus: 'failed' } : {}),
        },
        503,
      );
    }
  })
  .get('/internal/platform/sandbox-drain', async (context) => {
    const healthProbeToken = context.env.PLATFORM_HEALTH_PROBE_TOKEN;
    if (!healthProbeToken || context.req.header('X-Platform-Probe') !== healthProbeToken) {
      return context.json({ error: 'not found' }, 404);
    }
    try {
      return context.json(await sandboxDrainStatus(context.get('db')));
    } catch (error) {
      console.error('[api] sandbox drain status failed', error);
      return context.json(
        {
          version: 1,
          state: 'invalid',
          complete: false,
          checkpoint: 'sandbox_drain_checkpoints',
        },
        503,
      );
    }
  })
  .get('/__platform/platform/deployment-execution', async (context) => {
    const token = context.env.PLATFORM_HEALTH_PROBE_TOKEN;
    if (!token || context.req.header('X-Platform-Probe') !== token) {
      return context.json({ error: 'not found' }, 404);
    }
    return context.json(
      await deploymentExecutionStatus(context.get('db'), context.env.PLATFORM_INSTALLATION_ID),
    );
  })
  .get('/capabilities', (context) =>
    context.json({
      acceptsExecutionPlans: true,
      skipMigrations: true,
      d1ReadReplication: true,
      migrationProtocolVersion: 2,
      supportedClassifierVersions: [1],
    }),
  )
  .get('/', (context) => {
    context.header('Cache-Control', 'no-store');
    return context.html(
      platformWelcomePage(
        getPlatformDisplayName(context.env, context.req.url),
        getPlatformApiUrl(context.env, context.req.url),
      ),
    );
  })
  .get('/signup-restricted', (context) =>
    context.html(
      platformRestrictedSignupPage(getPlatformDisplayName(context.env, context.req.url)),
    ),
  )
  .get('/invite', (context) => {
    const invitationIdParam = context.req.query('project-invitation')?.trim();
    const invitationId =
      invitationIdParam && /^pinv_[0-9a-z]{12}$/.test(invitationIdParam) ? invitationIdParam : null;
    return context.html(
      platformInvitationPage(
        getPlatformDisplayName(context.env, context.req.url),
        getPlatformApiUrl(context.env, context.req.url),
        invitationId,
      ),
    );
  })
  .route('/', platformBootstrapRoutes)
  .route('/auth', auth)
  .get('/.well-known/oauth-authorization-server', oauthMetadata)
  .route('/oauth', oauth)
  .route('/app-rpc', appRpcRoutes)
  .route('/app-billing', appBillingRoutes)
  .route('/auth', oidcRoutes)
  .use('/internal/email/*', capabilityMiddleware('email'))
  .route('/internal/email/domain-credential', internalEmailDomainCredential)
  .route('/internal/email/actions', internalEmailActions)
  .route('/internal/email', emailIngressResolution)
  .use('/internal/github-webhook', capabilityMiddleware('managedBuilds'))
  .route('/internal/github-webhook', internalGitHubWebhook)
  .route('/internal/resolve-resource', internalResolveResource)
  .route('/internal/credential', internalCredential)
  .route('/internal/github-app', internalGitHubApp)
  .route('/internal/ai-logging', internalAiLogging)
  .route('/internal/resolve-worker', internalResolveWorker)
  .route('/internal/verify-owner', internalVerifyOwner)
  .route('/billing/stripe', stripeWebhookRoutes)
  .use('/webhooks/*', capabilityMiddleware('managedBuilds'))
  .route('/webhooks', webhookRoutes)
  .route('/github-app', githubAppRoutes)
  .route('/app-github', appGitHubRoutes)
  .use('/github/*', capabilityMiddleware('managedBuilds'))
  .route('/github', githubRoutes)
  // Decision: The gateway relays this exact route through its API service binding. The HMAC-signed token is the
  // credential, so recipients need no Platform or Access session. A platform without email issued no
  // token and returns the standard capability response.
  .use('/email/*', capabilityMiddleware('email'))
  .route('/email', emailConfirm)
  .use('/rpc/*', authMiddleware)
  .route('/rpc', rpcRoutes)
  .use('/mcp/*', authMiddleware)
  .route('/mcp', mcpRoutes)
  .use('/projects/*', authMiddleware)
  .route('/projects', projects)
  .route('/projects', projectZeroTrustRoutes)
  .route('/projects', deleteRoute)
  .route('/projects', emailRoutes)
  .route('/projects', githubProjectRoutes);

// Decision: Versioned, bearer-authenticated operator API. It has no browser cookie bypass.
app.route('/operator/v1', operatorApi);

app.route('/admin', adminLogin);
app.get('/admin', (context) => context.redirect(`/admin/${new URL(context.req.url).search}`, 308));
app.use('/admin/*', adminAuthMiddleware);
app.use('/admin/*', adminCsrfMiddleware);
app.post('/admin/fate', adminFateHandler);
app.get('/admin/', dashboardHandler);
app.route('/admin/users', adminUsers);
app.route('/admin/projects', adminProjects);
app.route('/admin/email', adminEmail);
app.route('/admin/zero-trust', adminZeroTrust);
app.route('/admin/builds', adminBuilds);
app.route('/admin/deployments', adminDeployments);
app.route('/admin/signup-control', adminSignupControl);
app.route('/admin/config/auth', adminAuthConfig);
app.route('/admin/connected-apps', connectedApps);
app.route('/admin/config/plans', adminPlans);
app.route('/admin/invitations', adminInvitations);
app.route('/admin', adminSystem);

const BATCH_SIZE = 50;

const PENDING_DOMAIN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Decision: Pending custom domains created within this window are reconciled on the 2-minute fast tier; older
// ones fall back to the hourly tier.
const RECENT_PENDING_WINDOW_MS = 30 * 60 * 1000;

// Decision: Cron expression for the fast reconciliation tier. Exported so the scheduled() branch and the tests
// share the same literal.
export const FAST_CRON = '*/2 * * * *';

const MAX_PENDING_RECONCILE_PER_RUN = 200;

// Decision: Max age before an active GitHub Actions build is force-failed by the hourly reaper. The supported
// build timeout is at most 60 minutes; the 15-minute margin leaves admitted builds and their token
// grace period alone, catching only builds whose `workflow_run` completion was missed (or whose
// connection was removed mid-run) and that would otherwise hold a concurrency slot forever.
const STALE_ACTIONS_BUILD_MAX_AGE_MINUTES = 75;

// Decision: Max age (from `started_at`) before an active container build is force-failed by the hourly reaper.
// The hard-max build timeout is 60 minutes, so 75 leaves a 15-minute margin: this only catches rows
// whose BuildManager DO timeout fired (or whose DO died) but whose terminal-status write failed.
const STALE_CONTAINER_BUILD_MAX_AGE_MINUTES = 75;

async function scheduled(
  controller: ScheduledController,
  env: ApiEnv['Bindings'],
  _ctx: ExecutionContext,
): Promise<void> {
  env = await resolvePlatformApplicationEnvironment(env);
  const deploymentDb = env.DEPLOYMENTS_QUEUE ? createDb(env.HYPERDRIVE.connectionString) : null;
  // Decision: Durable jobs admitted before maintenance must still run and settle.
  if (deploymentDb) {
    await dispatchPendingDeployments(env, deploymentDb).catch((error) =>
      console.error('[scheduled] deployment outbox failed', error),
    );
  }
  if (
    env.PLATFORM_TRAFFIC_STATE === 'staging' ||
    env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain' ||
    (env.PLATFORM_INSTALLATION_ID &&
      (await env.ROUTING.get(PLATFORM_DISABLED_KEY)) === PLATFORM_DISABLED_VALUE)
  ) {
    return;
  }
  const db = deploymentDb ?? createDb(env.HYPERDRIVE.connectionString);
  const capabilities = getPlatformCapabilities(env);
  // Decision: Without the deployment Queue the outbox above doesn't run, and deploys run inside their request.
  // Worker uploads that never became a deployment are still removed here.
  if (!deploymentDb) {
    await sweepStaleDeploymentInputs(env, db).catch((error) =>
      console.error('[scheduled] deployment input sweep failed', error),
    );
  }

  await reconcileProjectCleanupJobs(db, env).catch((error) =>
    console.error('[scheduled] project cleanup retry failed:', error),
  );

  // Decision: Fast tier: a resumable Zero Trust batch owns the rest of this invocation so it stays inside the
  // per-invocation subrequest budget. A failed batch doesn't, so the pending-domain and email work
  // below still runs. An operation already in error waits for the hourly tier or an explicit reconcile.
  if (controller.cron === FAST_CRON) {
    const zeroTrustProgressed = await resumePlatformZeroTrustOperation(env, db).catch((error) => {
      console.error('[scheduled] Zero Trust operation resume failed:', error);
      return false;
    });
    if (zeroTrustProgressed) {
      return;
    }
  }

  // Decision: Proxy token rotations are bounded per tick so deploys keep their share of the Cloudflare API rate
  // limit.
  if (!isDevBypass(env) && env.CF_API_TOKEN) {
    await reconcileProxyTokenRotations(db, env, { maxCfCalls: 100, maxMs: 25_000 }).catch((error) =>
      console.error('[scheduled] proxy token rotation failed:', error),
    );
  }

  if (capabilities.email) {
    await reconcileEmailDestinationCleanups(db, {
      accountId: env.CF_ACCOUNT_ID,
      apiToken: env.CF_API_TOKEN,
    }).catch((error) => console.error('[scheduled] email destination cleanup failed:', error));
    await (async () => {
      const operationId = await ensureSharedEmailConnection(db, env);
      if (operationId) {
        await runEmailOperation(db, env, operationId);
      }
    })().catch((error) => console.error('[scheduled] shared email setup failed:', error));
    await reconcilePendingEmailOperations(db, env).catch((error) =>
      console.error('[scheduled] email operation reconciliation failed:', error),
    );
    await reconcileSharedEmailRecipients(db, env).catch((error) =>
      console.error('[scheduled] shared email recipient reconciliation failed:', error),
    );
    await flushEmailCacheOutbox(db, env.ROUTING).catch((error) =>
      console.error('[scheduled] email display publication failed:', error),
    );
    if (controller.cron !== FAST_CRON) {
      await pruneEmailActionHistory(db).catch((error) =>
        console.error('[scheduled] email history cleanup failed:', error),
      );
      await repairEmailRecipientPolicyMirror(db, env.ROUTING);
    }
  }

  // Decision: Fast tier: if no Zero Trust batch used this invocation, reconcile pending domains created in the
  // last 30 minutes. The heavier hourly maintenance doesn't run on this tick.
  if (controller.cron === FAST_CRON) {
    if (!capabilities.customDomains) {
      return;
    }
    const cutoff = new Date(controller.scheduledTime - RECENT_PENDING_WINDOW_MS).toISOString();
    const young = await getPendingDomainsNewerThan(db, cutoff, MAX_PENDING_RECONCILE_PER_RUN);
    if (young.length === MAX_PENDING_RECONCILE_PER_RUN) {
      console.warn(
        `[scheduled] fast pending-domain reconcile hit the per-run cap (${MAX_PENDING_RECONCILE_PER_RUN}); remaining pending domains will be processed on the next run`,
      );
    }
    // Decision: The fast tier doesn't re-trigger HTTP DCV through PATCH; only the hourly tier does (see the hourly
    // call below and tryActivateDomain).
    await reconcilePendingDomains(env, db, young, false).catch((err) =>
      console.error('[scheduled] fast pending-domain reconcile failed:', err),
    );
    return;
  }

  if (capabilities.sandbox) {
    await retrySandboxControllerCleanup(db, env).catch((error) =>
      console.error('[scheduled] Sandbox controller cleanup failed:', error),
    );
  }

  await reconcilePendingProjectZeroTrust(env, db).catch((error) =>
    console.error('[scheduled] Zero Trust reconciliation failed:', error),
  );

  await sweepAiLogging(db, env.ROUTING, initialPlanDefaultFor(env)).catch((error) =>
    console.error('[scheduled] AI logging sweep failed:', error),
  );

  await failStaleDeployments(db)
    .then((n) => {
      if (n > 0) {
        console.log(`[scheduled] auto-failed ${n} stale deployment(s)`);
      }
    })
    .catch((err) => console.error('[scheduled] failed to clean up stale deployments:', err));

  if (capabilities.managedBuilds) {
    await failStaleActiveGithubActionsBuilds(db, STALE_ACTIONS_BUILD_MAX_AGE_MINUTES)
      .then((n) => {
        if (n > 0) {
          console.log(`[scheduled] auto-failed ${n} stale github_actions build(s)`);
        }
      })
      .catch((err) =>
        console.error('[scheduled] failed to clean up stale github_actions builds:', err),
      );
  }

  // Decision: Two phases, in this order on purpose. (1) The DB terminalize is authoritative: it frees the
  // concurrency slot and revokes the bound deploy token even if the DO is unreachable, so it runs
  // first and stands alone. (2) The age check doesn't prove the container is gone (an evicted DO or a
  // lost timeout alarm can leave it running), so each reaped build also gets a best-effort
  // `cancelBuild`. That's harmless on a terminal row: its CAS skips the DB write. A DO RPC failure
  // must not break the handler.
  if (capabilities.managedBuilds) {
    await failStaleActiveContainerBuilds(db, STALE_CONTAINER_BUILD_MAX_AGE_MINUTES)
      .then(async (staleBuilds) => {
        if (staleBuilds.length > 0) {
          console.log(`[scheduled] auto-failed ${staleBuilds.length} stale container build(s)`);
          await cancelContainerBuildDos(
            env,
            // Decision: The reaper handles only container builds. Carry each build's instance_type so the cancel addresses
            // the size namespace the scheduler started it on; a paid build cancelled against the base namespace
            // would miss its live container.
            staleBuilds.map((b) => ({ ...b, executor: 'container' as const })),
            'stale build reaper',
          );
        }
      })
      .catch((err) => console.error('[scheduled] failed to clean up stale container builds:', err));
  }

  // Decision: Re-arm the build scheduler if container builds are still queued. The push handler pokes
  // BUILD_SCHEDULER best-effort after inserting a build, and the DO lets its alarm lapse on an empty
  // queue. If that poke failed, the row would sit `queued` with no alarm to drain it. This cron safety
  // net picks up an orphaned queued build within one tick.
  if (capabilities.managedBuilds) {
    await hasQueuedContainerBuilds(db)
      .then(async (hasQueued) => {
        if (hasQueued) {
          const scheduler = env.BUILD_SCHEDULER.get(env.BUILD_SCHEDULER.idFromName('global'));
          await scheduler.fetch('https://scheduler/poke', { method: 'POST' });
        }
      })
      .catch((err) => console.error('[scheduled] failed to re-arm build scheduler:', err));
  }

  await purgeExpiredOAuthRequests(db).catch((err) =>
    console.error('[scheduled] failed to purge expired connected-app grants:', err),
  );
  await reapExpiredPreviews(db, env).catch((err) =>
    console.error('[scheduled] preview teardown failed:', err),
  );
  await purgeExpiredOAuthNonces(db).catch((err) =>
    console.error('[scheduled] failed to purge expired OAuth nonces:', err),
  );
  await purgeExpiredAuthCodes(db).catch((err) =>
    console.error('[scheduled] failed to purge expired auth codes:', err),
  );
  await db
    .delete(operatorSessions)
    .where(lt(operatorSessions.expires_at, new Date().toISOString()))
    .catch((err) => console.error('[scheduled] failed to purge expired operator sessions:', err));
  for (const table of [platformAuthAttempts, platformLoginTests, platformHumanSessions]) {
    await db
      .delete(table)
      .where(lt(table.expires_at, new Date().toISOString()))
      .catch((err) =>
        console.error('[scheduled] failed to purge expired authentication state:', err),
      );
  }

  // Decision: Catch up on missed GitHub webhooks (design doc 0074): list GitHub's own `status=failure` delivery
  // log and redeliver failed events we haven't redelivered yet. Redelivered events re-enter the
  // idempotent webhook handler, so this is safe.
  if (capabilities.managedBuilds) {
    try {
      const r = await replayFailedWebhookDeliveries(env, db);
      if (r.redelivered > 0) {
        console.log(
          `[scheduled] webhook-replay redelivered ${r.redelivered}/${r.scanned} failed deliveries`,
        );
      }
    } catch (err) {
      console.warn('[scheduled] webhook-replay failed', err);
    }
  }

  // Decision: Reconcile all pending domains before the stale-cleanup janitor, so a domain that just finished
  // validating (even one near the 7-day cutoff) is activated instead of collected.
  if (capabilities.customDomains) {
    const allPending = await getPendingDomains(db, MAX_PENDING_RECONCILE_PER_RUN);
    if (allPending.length === MAX_PENDING_RECONCILE_PER_RUN) {
      console.warn(
        `[scheduled] hourly pending-domain reconcile hit the per-run cap (${MAX_PENDING_RECONCILE_PER_RUN}); remaining pending domains will be processed on the next run`,
      );
    }
    // Decision: Only the hourly tier re-triggers HTTP DCV through PATCH. That bounds the per-account CF
    // custom-hostname API load (the 2-minute tier would multiply PATCH volume under a burst of young
    // domains and could 429 other tenants' hostname calls), while still re-triggering the long tail
    // and resetting CF's decaying 7-day validation backoff once an hour.
    await reconcilePendingDomains(env, db, allPending, true).catch((err) =>
      console.error('[scheduled] hourly pending-domain reconcile failed:', err),
    );

    // Decision: Cleanup janitor: custom hostnames pending for more than 7 days never finished ownership or cert
    // validation. Their CF cert order is still open (CT-log noise), and under a wildcard-CNAME hijack
    // attempt CF's own "Moved, then Deleted after 7 days" sweep may not fire. Delete the CF hostname
    // (revoking the cert order) and drop the DB row. Only `status === 'pending'` rows qualify.
    await cleanupStalePendingDomains(env, db, controller.scheduledTime).catch((err) =>
      console.error('[scheduled] failed to clean up stale pending domains:', err),
    );
  }

  let offset = 0;
  while (true) {
    let batch;
    try {
      batch = await getUsersWithProjectsBatch(db, BATCH_SIZE, offset);
    } catch (err) {
      console.error('[scheduled] failed to fetch user batch at offset', offset, err);
      break;
    }
    if (batch.length === 0) {
      break;
    }

    await Promise.allSettled(
      batch.map(({ user, projects, needsUsageReconciliation }) =>
        processUserRollover(env, db, user, projects, needsUsageReconciliation),
      ),
    );

    offset += BATCH_SIZE;
  }
}

// Decision: Re-run the shared activation gate (tryActivateDomain) for each pending domain and activate it when
// CF finished ownership and cert validation and the project has live slug routing, so a domain comes
// online after DNS is set without another `bwf domain status`. Per-domain failures are isolated.
// `retriggerDcv` gates the HTTP-DCV re-trigger PATCH; only the hourly tier passes `true`.
async function reconcilePendingDomains(
  env: ApiEnv['Bindings'],
  db: Db,
  pending: ReadonlyArray<Domain>,
  retriggerDcv: boolean,
): Promise<void> {
  if (pending.length === 0) {
    return;
  }

  const projectIds = [...new Set(pending.map((d) => d.project_id))];
  const projectRows = await getProjectsByIds(db, projectIds);
  const projectMap = new Map(projectRows.map((project) => [project.id, project]));

  // Decision: Skip domains whose owner is admin-suspended. The authenticated `bwf domain status` route is behind
  // authMiddleware, which 403s admin-suspended owners, and the cron must not advance a domain that path
  // would refuse. Usage-suspended owners keep access, so their domains still reconcile.
  const ownerIds = [...new Set(projectRows.map((p) => p.user_id))];
  const owners = await getUsersByIds(db, ownerIds);
  const suspendedOwnerIds = new Set(
    owners.filter((u) => isAdminSuspended(u.suspended_reason)).map((u) => u.id),
  );

  let activated = 0;
  for (const domain of pending) {
    const project = projectMap.get(domain.project_id);
    if (!project) {
      console.error(
        `[scheduled] reconcile: project ${domain.project_id} not found for domain ${domain.hostname} — skipping`,
      );
      continue;
    }
    if (suspendedOwnerIds.has(project.user_id)) {
      // Decision: Expected, not an error: the owner is admin-suspended, so the cron doesn't activate their domain
      // (matching the authed status route's 403).
      continue;
    }
    try {
      const result = await tryActivateDomain(env, db, domain, project, { retriggerDcv });
      if (result.activated) {
        activated += 1;
      }
    } catch (err) {
      console.error('[scheduled] failed to reconcile pending domain ' + domain.hostname + ':', err);
    }
  }

  if (activated > 0) {
    console.log(
      '[scheduled] auto-activated ' + activated + '/' + pending.length + ' pending domain(s)',
    );
  }
}

async function cleanupPendingDomainUnderProjectFence(
  env: ApiEnv['Bindings'],
  db: Db,
  domain: Domain,
  beforeDelete?: () => Promise<void>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${domain.project_id} FOR UPDATE`);
    // Decision: Like domain removal: refuse during uninstall before any cleanup, and record the change for Zero
    // Trust retry with the deletion, because the project's custom domain application may already list
    // this hostname.
    await lockZeroTrustConfiguration(tx, 'shared');
    const current = await getDomain(tx, domain.id);
    if (current?.status !== 'pending') {
      return false;
    }
    await beforeDelete?.();
    await env.ROUTING.delete(`domain:${domain.hostname}`).catch(() => {});
    await markProjectCustomDomainsChanged(tx, domain.project_id);
    await deleteDomain(tx, domain.id);
    return true;
  });
}

// Decision: Exported so tests can run the janitor without the reconcile pass `scheduled()` runs first, which
// would activate any gate-passing pending domain before the janitor sees it.
export async function cleanupStalePendingDomains(
  env: ApiEnv['Bindings'],
  db: Db,
  nowMs: number,
): Promise<void> {
  const cutoff = new Date(nowMs - PENDING_DOMAIN_MAX_AGE_MS).toISOString();
  const stale = await getPendingDomainsOlderThan(db, cutoff, MAX_PENDING_RECONCILE_PER_RUN);
  if (stale.length === MAX_PENDING_RECONCILE_PER_RUN) {
    console.warn(
      `[scheduled] stale pending-domain cleanup hit the per-run cap (${MAX_PENDING_RECONCILE_PER_RUN}); remaining stale domains will be processed on the next run`,
    );
  }
  if (stale.length === 0) {
    return;
  }

  let cleaned = 0;
  for (const domain of stale) {
    // Decision: The `stale` snapshot can be racy: a user may finish DNS on day 8, or a concurrent
    // `bwf domain status` poll may activate the domain in between. Re-check CF live before tearing
    // anything down so a hostname that has since verified isn't deleted.
    let live;
    try {
      live = await getCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, domain.cf_hostname_id);
    } catch (err) {
      // Decision: CF already removed the hostname (for example its own 7-day validation cleanup). Nothing to revoke;
      // drop the orphaned DB row and any stray KV so the customer can add the hostname again.
      if (err instanceof CloudflareApiError && err.status === 404) {
        if (!(await cleanupPendingDomainUnderProjectFence(env, db, domain))) {
          continue;
        }
        cleaned += 1;
        await reconcileProjectZeroTrustDomains(env, db, domain.project_id).catch((error) =>
          console.error(
            `[scheduled] failed to reconcile Zero Trust after deleting ${domain.hostname}:`,
            error,
          ),
        );
        continue;
      }
      console.error(`[scheduled] failed to read stale CF hostname for ${domain.hostname}:`, err);
      continue;
    }

    // Decision: Ownership completed since the snapshot, so don't delete a verified host. Don't just skip it
    // either: under a sustained backlog above MAX_PENDING_RECONCILE_PER_RUN, the oldest-first reconcile
    // cap can starve a verified-but-pending domain past 7 days into this janitor, leaving it unrouted.
    // Run the shared activation gate so it comes online, keeping reconcile's admin-suspended-owner skip.
    if (live.status === 'active') {
      const project = await getProject(db, domain.project_id);
      if (!project) {
        // Decision: Orphaned domain row with no project. Don't delete a verified host; leave the row for manual
        // cleanup.
        continue;
      }
      const [owner] = await getUsersByIds(db, [project.user_id]);
      if (owner && isAdminSuspended(owner.suspended_reason)) {
        // Decision: The owner is admin-suspended, matching reconcile and the authed route's 403. Don't activate, and
        // don't delete a verified host.
        continue;
      }
      try {
        await tryActivateDomain(env, db, domain, project);
      } catch (err) {
        console.error(
          `[scheduled] failed to activate verified stale domain ${domain.hostname}:`,
          err,
        );
      }
      continue;
    }

    // Decision: Keep the row visible until provider and routing cleanup finish so a concurrent add can't publish a
    // replacement that this run then removes.
    const claimed = await cleanupPendingDomainUnderProjectFence(env, db, domain, async () => {
      try {
        await deleteCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, domain.cf_hostname_id);
      } catch (err) {
        if (!(err instanceof CloudflareApiError && err.status === 404)) {
          try {
            await deleteCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, domain.cf_hostname_id);
          } catch (retryErr) {
            if (!(retryErr instanceof CloudflareApiError && retryErr.status === 404)) {
              console.error(
                `[scheduled] failed to delete stale CF hostname for ${domain.hostname} after retry — CF hostname ${domain.cf_hostname_id} is ORPHANED:`,
                retryErr,
              );
            }
          }
        }
      }
    });
    if (!claimed) {
      continue;
    }
    await reconcileProjectZeroTrustDomains(env, db, domain.project_id).catch((error) =>
      console.error(
        `[scheduled] failed to reconcile Zero Trust after deleting ${domain.hostname}:`,
        error,
      ),
    );
    cleaned += 1;
  }

  if (cleaned > 0) {
    console.log(`[scheduled] cleaned up ${cleaned} stale pending domain(s)`);
  }
}

async function processUserRollover(
  env: ApiEnv['Bindings'],
  db: Db,
  user: { id: string; plan: string; billing_cycle_start: string; suspended_reason: string | null },
  userProjects: ReadonlyArray<{ id: string; slug: string; created_at: string }>,
  needsUsageReconciliation: boolean,
): Promise<void> {
  // Decision: Backfill userId into old KV routing entries (all plans, before the early return). The try/catch
  // keeps a malformed KV entry from blocking rollover or unsuspension.
  try {
    for (const project of userProjects) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`);
        const current = await getProject(tx, project.id);
        if (!current || current.user_id !== user.id || current.status === 'deleting') {
          return;
        }

        // Decision: Resolve both route keys and values behind the same fence as deploy, protection changes, domain
        // activation, transfer and deletion.
        const domainMap = await getDomainsByProjectIds(tx, [current.id]);
        const protection = await resolveProjectZeroTrustRoutingForPublication(tx, current.id);
        const keys = [
          current.slug,
          ...(domainMap.get(current.id) ?? [])
            .filter((domain) => domain.status === 'active')
            .map((domain) => `domain:${domain.hostname}`),
        ];
        for (const key of keys) {
          const raw = await env.ROUTING.get(key);
          if (!raw) {
            continue;
          }
          const routing = JSON.parse(raw);
          if (!routing.userId) {
            routing.userId = current.user_id;
            await env.ROUTING.put(
              key,
              withProjectZeroTrustRouting(JSON.stringify(routing), protection, current.id),
            );
          }
        }
      });
    }
  } catch (err) {
    console.error(`[backfill] userId backfill failed for user ${user.id}:`, err);
  }

  if (!needsUsageReconciliation) {
    return;
  }

  const billingPeriodStart = getCurrentBillingPeriodStart(user.billing_cycle_start).toISOString();
  const projectSlugs: Record<string, string> = {};
  const projectOwnershipStarts: Record<string, string> = {};
  const ownershipPeriods = await getOpenProjectOwnershipPeriodsByProjectIds(
    db,
    userProjects.map((project) => project.id),
  );
  const ownershipStarts = new Map(
    ownershipPeriods.map((period) => [period.project_id, period.starts_at]),
  );
  for (const p of userProjects) {
    projectSlugs[p.id] = p.slug;
    projectOwnershipStarts[p.id] = ownershipStarts.get(p.id) ?? p.created_at;
  }

  const doId = env.USAGE_COUNTER.idFromName(user.id);
  const stub = env.USAGE_COUNTER.get(doId);

  // Decision: The rollover check (the DO resets only if the period changed). The DO does the sandbox-block KV
  // delete and the sandbox_runtime DB unsuspend inline because it owns that state; request-suspension
  // cleanup stays here because the DO doesn't know which project slugs were marked suspended.
  const rolloverRes = await stub.fetch(
    new Request('https://do/rollover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ billingPeriodStart, plan: user.plan, userId: user.id }),
    }),
  );

  if (rolloverRes.ok) {
    const result = await rolloverRes.json<{
      rolled: boolean;
      unsuspendRequests?: boolean;
      unsuspendAi?: boolean;
      requestsSuspended?: boolean;
    }>();

    if (result.rolled && result.unsuspendRequests) {
      // Decision: DB side of the request-cap unsuspend. It's match-guarded, so it's a no-op if a later sandbox
      // suspension overwrote `suspended_reason` (the DO latch, not the DB reason, is the authority for the
      // KV reconcile below).
      await unsuspendUserIfReason(db, user.id, REASON_REQUESTS_EXCEEDED);
    }

    // Decision: KV side, on each pass: reconcile the `suspended` marker on slug and active `domain:<host>` routes
    // against the DO's request latch. When the user isn't request-suspended, clear any lingering
    // `requests_exceeded` marker (reason-scoped, so it doesn't lift an admin suspension). The DO resets
    // its latch on rollover but can't clear KV (it lacks the project and domain list). Running each pass
    // makes this self-healing: a partial KV-write failure is retried next run instead of leaving routes
    // at 429 until the next deploy. `undefined` from an old DO during a deploy is skipped and fixed on
    // the next pass.
    if (result.requestsSuspended === false) {
      await setProjectsRoutingSuspension(
        env.ROUTING,
        db,
        userProjects.map((project) => ({ ...project, user_id: user.id })),
        {
          op: 'unsuspend',
          matchReason: REASON_REQUESTS_EXCEEDED,
        },
      );
    }
  }

  await stub.fetch(
    new Request('https://do/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: user.plan,
        billingPeriodStart,
        projectSlugs,
        projectOwnershipStarts,
        userId: user.id,
      }),
    }),
  );
}

export {
  UsageCounter,
  CronScheduler,
  ErrorAlertMonitor,
  SandboxConcurrencyCounter,
  SandboxControl,
  BuildScheduler,
  BuildManager,
  BuildManagerLarge,
};
export { app, scheduled };

export default {
  fetch: ((request, ...rest) =>
    app.fetch(withCurrentRequestNames(request), ...rest)) as typeof app.fetch,
  scheduled,
  async queue(batch: MessageBatch<unknown>, env: ApiEnv['Bindings']): Promise<void> {
    env = await resolvePlatformApplicationEnvironment(env);
    await processPlatformQueue(batch, env);
  },
} satisfies ExportedHandler<ApiEnv['Bindings']>;
