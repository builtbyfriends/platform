import { matchLiteralPattern, redirectToHttps } from '@builtbyfriends/edge';
import type { ProjectZeroTrustRouting } from '@builtbyfriends/edge';
import {
  PLATFORM_HEALTH_HOSTNAME_LABEL,
  platformHealthHostname,
  readPlatformApplication,
  resolvePlatformApplicationEnvironment,
} from '@builtbyfriends/platform';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { projectAccessVerifier } from './access.ts';
import type { Env } from './env.ts';
import { createErrorResponse, createMaintenanceResponse } from './error-page.ts';
import { applyHeaderRules } from './headers.ts';
import type { HeaderRule } from './headers.ts';
import { createLimitResponse } from './limit-response.ts';
import { recordPlatformLog, recordRequest, sendUsageEvent } from './metering.ts';
import type { FailureKind, RequestType } from './metering.ts';
import { PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE } from './platform-lifecycle.ts';
import { applicationEdgeCache, resolveProjectHostname } from './project-hostname.ts';
import { classifyDynamicRequestType, hasExtension, isApiPath } from './request-type.ts';
import { applyRoutingRules, mergeQueryIntoLocation } from './routing-rules.ts';
import type { RedirectRule } from './routing-rules.ts';
import {
  bypassesSharedCache,
  clientRevalidateResponse,
  hasCurrentSharedCachePolicy,
  hasSharedCacheOptOut,
  isEventStreamResponse,
  markSharedCachePolicy,
  SHARED_CACHE_POLICY_HEADER,
} from './shared-cache.ts';
import { dropParentDomainCookies } from './shared-domain-cookies.ts';
import { resolveStaticPath, resolveAssetContentType, safeDecodePathname } from './static.ts';
import type { AssetConfig } from './static.ts';
import {
  DispatchTimeoutError,
  resolveTimeoutMs,
  withDelayedHedge,
  withTimeout,
} from './with-timeout.ts';

type RoutingEntry = Readonly<{
  workerName: string;
  projectId: string;
  userId?: string;
  type?: 'platform' | 'spa' | 'static';
  ssr?: boolean;
  version?: string;
  limits?: Record<string, number>;
  suspended?: string;
  hashedAssetsPrefix?: string;
  headerRules?: ReadonlyArray<HeaderRule>;
  // Decision: `redirectRules` run before assets and `fallbackRules` after them. Which list a rule is in sets
  // when it runs.
  redirectRules?: ReadonlyArray<RedirectRule>;
  alwaysUseHttps?: boolean;
  fallbackRules?: ReadonlyArray<RedirectRule>;
  staticDeploymentId?: string;
  assetManifestId?: string;
  assetConfig?: AssetConfig;
  zeroTrust?: ProjectZeroTrustRouting;
  privatePreview?: boolean;
}>;

// Decision: The API writes this key (projectSuspensionKey in suspension.ts) while an administrator has
// suspended the project or its owner.
async function isProjectSuspended(env: Env, projectId: string): Promise<boolean> {
  try {
    return (await env.ROUTING.get(`project-suspended:${projectId}`, { cacheTtl: 60 })) !== null;
  } catch (error) {
    console.error(`[queue-relay] suspension check failed project="${projectId}"; relaying`, error);
    return false;
  }
}

type QueueRoutingEntry = Readonly<{
  workerName: string;
  projectId: string;
  queueName: string;
  // Decision: HMAC-signed proxy token that matches the user worker's __PLATFORM_PROXY_TOKEN. The generated
  // /__platform/queue handler returns 401 for relays without a matching `x-platform-internal`
  // header. Entries written by older API versions don't have it.
  proxyToken?: string;
}>;

const STATIC_ASSET_HEDGE_DELAY_MS = 1000;
const PLATFORM_QUEUE_RETRY_DELAY_SECONDS = 300;
// Decision: Batches of a project whose owner is suspended wait here. Each retry uses one of the queue's
// max_retries (3 unless the app sets maxRetries), so a message lasts about an hour per retry, and a
// queue with maxRetries 0 drops it on the first suspended delivery.
const SUSPENDED_PROJECT_QUEUE_RETRY_DELAY_SECONDS = 3600;
// Decision: A relay rejected for its token is retried after the routing entry (read with cacheTtl 60) has
// caught up with a token rotation, so a rotation costs about one attempt per message, not all of
// them.
const QUEUE_TOKEN_REJECTED_RETRY_DELAY_SECONDS = 120;
const PLATFORM_STATIC_ASSET_TIMEOUT: FailureKind = 'platform-static-asset-timeout';
const PLATFORM_STATIC_ASSET_ERROR: FailureKind = 'platform-static-asset-error';
const PLATFORM_STATIC_ASSET_MISSING: FailureKind = 'platform-static-asset-missing';

/**
 * Whether Cloudflare Access may treat this path as part of the `/health`
 * exception on the platform health hostname. Access covers the subpaths of a
 * destination path. It may see the URL as sent or after the zone's URL
 * normalization, and its handling of case and of prefixes such as `/healthz`
 * is undocumented, so this matches the broadest reading of each.
 */
function platformHealthExceptionPath(request: Request, url: URL): boolean {
  const rawPath = request.url
    .replace(/^[a-z][a-z\d+.-]*:\/\/[^/\\?#]*/i, '')
    .replace(/[?#].*$/s, '');
  return [rawPath, url.pathname].some((path) => {
    let decoded = path;
    try {
      decoded = decodeURIComponent(path);
    } catch {}
    return decoded
      .replaceAll(/[\\/]+/g, '/')
      .toLowerCase()
      .startsWith('/health');
  });
}

function timeoutResponse(status: number, label: string): Response {
  return new Response(null, {
    status,
    headers: {
      'X-Platform-Timeout': label,
      ...(status === 503 ? { 'Retry-After': '5' } : {}),
    },
  });
}

function staticAssetFailureResponse(kind: FailureKind): Response {
  if (kind === PLATFORM_STATIC_ASSET_TIMEOUT) {
    return timeoutResponse(503, 'static-asset');
  }
  return new Response(null, {
    status: 503,
    headers: {
      'X-Platform-Storage-Error':
        kind === PLATFORM_STATIC_ASSET_MISSING ? 'static-asset-missing' : 'static-asset-read',
      'Retry-After': '5',
    },
  });
}

async function applyWorkerFallbackRules(opts: {
  response: Response;
  worker: { fetch(request: Request): Promise<Response> };
  dispatchReq: Request;
  routing: RoutingEntry;
  pathname: string;
  url: URL;
  originalRequestUrl: string;
  originalUrlHeader?: string;
  deadline?: Readonly<{ startedAt: number; timeoutMs: number }>;
}): Promise<{
  response: Response;
  pathname: string;
  applied: boolean;
}> {
  const unchanged = {
    response: opts.response,
    pathname: opts.pathname,
    applied: false,
  };
  if (opts.response.status !== 404 || !opts.routing.fallbackRules?.length) {
    return unchanged;
  }
  if (
    opts.routing.type === 'platform' &&
    opts.response.headers.get('X-Platform-No-Match') !== '1'
  ) {
    return unchanged;
  }

  const fallback = applyRoutingRules(opts.pathname, opts.routing.fallbackRules, opts.url.hostname);
  if (fallback?.type !== 'rewrite') {
    return unchanged;
  }

  const fallbackHeader = opts.originalUrlHeader ?? opts.originalRequestUrl;
  const fallbackUrl = new URL(opts.url.toString());
  fallbackUrl.pathname = fallback.destination;
  const fallbackRequest = rebuildRequest(opts.dispatchReq, fallbackUrl.toString(), (headers) =>
    headers.set('X-Platform-Original-URL', fallbackHeader),
  );

  return {
    response:
      opts.deadline === undefined
        ? await opts.worker.fetch(fallbackRequest)
        : await withTimeout(
            opts.worker.fetch(fallbackRequest),
            remainingTimeoutBudget(opts.deadline.startedAt, opts.deadline.timeoutMs, 'dispatch'),
            'dispatch',
          ),
    pathname: fallback.destination,
    applied: true,
  };
}

function resolveCachedWfpFallbackPathname(
  pathname: string,
  routing: RoutingEntry,
  requestHost: string,
): string | undefined {
  const fallback = applyRoutingRules(pathname, routing.fallbackRules, requestHost);
  return fallback?.type === 'rewrite' ? fallback.destination : undefined;
}

// Decision: Cloudflare's error text for WC-4511 asset dedupe poisoning. It isn't guaranteed stable, so watch
// the fallback telemetry if Cloudflare's worker runtime changes.
const CF_ASSETS_STUB_MARKER = 'Assets have not yet been deployed to this script';

function isLikelyCfAssetStub(response: Response): boolean {
  if (response.status !== 200) {
    return false;
  }
  const contentType = response.headers.get('content-type')?.toLowerCase();
  if (!contentType?.startsWith('text/plain')) {
    return false;
  }
  const contentLengthRaw = response.headers.get('content-length');
  if (!contentLengthRaw) {
    return false;
  }
  const contentLength = Number.parseInt(contentLengthRaw, 10);
  return contentLength > 0 && contentLength < 200;
}

function remainingTimeoutBudget(
  startedAt: number,
  timeoutMs: number,
  label = 'static-asset',
): number {
  if (!(timeoutMs > 0 && Number.isFinite(timeoutMs))) {
    return timeoutMs;
  }
  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) {
    throw new DispatchTimeoutError(label);
  }
  return remainingMs;
}

function staticAssetHedgeDelayMs(timeoutMs: number): number {
  return timeoutMs > 0 && Number.isFinite(timeoutMs)
    ? Math.min(STATIC_ASSET_HEDGE_DELAY_MS, timeoutMs / 2)
    : 0;
}

async function fetchAssetManifest(
  env: Env,
  deploymentId: string,
  projectId: string,
  timeoutMs: number,
): Promise<Record<string, string> | null> {
  const hedgeDelayMs = staticAssetHedgeDelayMs(timeoutMs);
  try {
    const raw = await withDelayedHedge(
      () => env.ROUTING.get(`manifest:${deploymentId}`, { cacheTtl: 86_400 }),
      {
        delayMs: hedgeDelayMs,
        timeoutMs,
        label: 'static-asset',
        onHedge: () => {
          console.warn(
            JSON.stringify({
              event: 'wfp-asset-manifest-read-hedge',
              projectId,
              deploymentId,
              delayMs: hedgeDelayMs,
              ts: Date.now(),
            }),
          );
        },
      },
    );
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as Record<string, string>;
  } catch (error) {
    console.error(
      JSON.stringify({
        event:
          error instanceof DispatchTimeoutError
            ? 'wfp-asset-manifest-timeout'
            : 'wfp-asset-manifest-read-error',
        projectId,
        deploymentId,
        error:
          error instanceof DispatchTimeoutError
            ? undefined
            : error instanceof Error
              ? error.message
              : String(error),
        ts: Date.now(),
      }),
    );
    if (error instanceof DispatchTimeoutError) {
      throw error;
    }
    throw new StaticAssetReadError(error);
  }
}

// Decision: Serves the asset from platform R2/KV using the mirror written on deploy. It returns null when the
// entry has no manifest or the path can't be resolved; the caller turns that confirmed poison-stub
// miss into an attributed platform 503, so no successful cache entry gets written.
async function serveWfpAssetFallback(
  env: Env,
  routing: RoutingEntry,
  pathname: string,
  timeoutMs = 10_000,
  fallbackPathname?: string,
): Promise<{ response: Response; pathname: string } | null> {
  if (!routing.assetManifestId) {
    return null;
  }
  const startedAt = Date.now();
  const assetManifest = await fetchAssetManifest(
    env,
    routing.assetManifestId,
    routing.projectId,
    remainingTimeoutBudget(startedAt, timeoutMs),
  );
  if (!assetManifest) {
    return null;
  }
  const assetConfig: AssetConfig = routing.assetConfig ?? { not_found_handling: 'none' };
  let resolvedPathname = pathname;
  let resolved = resolveStaticPath(pathname, assetManifest, assetConfig);
  if ((!resolved || resolved.notFound) && fallbackPathname && fallbackPathname !== pathname) {
    const fallbackResolved = resolveStaticPath(fallbackPathname, assetManifest, assetConfig);
    if (fallbackResolved && !fallbackResolved.notFound) {
      resolved = fallbackResolved;
      resolvedPathname = fallbackPathname;
    }
  }
  if (!resolved) {
    return null;
  }
  if (resolved.redirect) {
    return {
      response: new Response(null, {
        status: 308,
        headers: { Location: resolved.redirect },
      }),
      pathname: resolvedPathname,
    };
  }
  const assetResponse = await fetchStaticAsset(
    env,
    resolved.hash,
    resolved.path,
    routing.projectId,
    routing.assetManifestId,
    remainingTimeoutBudget(startedAt, timeoutMs),
  );
  if (!assetResponse) {
    return null;
  }
  return {
    response: new Response(assetResponse.body, {
      status: resolved.notFound ? 404 : 200,
      headers: assetResponse.headers,
    }),
    pathname: resolvedPathname,
  };
}

function logWfpAssetFallback(
  routing: RoutingEntry,
  pathname: string,
  userAgent: string | null,
): void {
  console.log(
    JSON.stringify({
      event: 'wfp-asset-fallback',
      projectId: routing.projectId,
      deploymentId: routing.assetManifestId,
      pathname,
      userAgent,
      ts: Date.now(),
    }),
  );
}

async function maybeServeWfpAssetFallback(opts: {
  env: Env;
  routing: RoutingEntry;
  pathname: string;
  response: Response;
  userAgent: string | null;
  timeoutMs?: number;
  deadline?: Readonly<{ startedAt: number; timeoutMs: number }>;
  fallbackPathname?: string;
}): Promise<{ response: Response; failureKind?: FailureKind; pathname: string }> {
  const startedAt = opts.deadline?.startedAt ?? Date.now();
  const timeoutMs = opts.deadline?.timeoutMs ?? opts.timeoutMs ?? 10_000;
  if (isEventStreamResponse(opts.response)) {
    return { response: opts.response, pathname: opts.pathname };
  }
  if (!isLikelyCfAssetStub(opts.response)) {
    return { response: opts.response, pathname: opts.pathname };
  }
  let stubConfirmed = false;
  let fallback: { response: Response; pathname: string } | null;
  try {
    const body = await withTimeout(
      opts.response.clone().text(),
      remainingTimeoutBudget(startedAt, timeoutMs),
      'static-asset',
    );
    if (!body.includes(CF_ASSETS_STUB_MARKER)) {
      return { response: opts.response, pathname: opts.pathname };
    }
    stubConfirmed = true;
    fallback = await serveWfpAssetFallback(
      opts.env,
      opts.routing,
      opts.pathname,
      remainingTimeoutBudget(startedAt, timeoutMs),
      opts.fallbackPathname,
    );
  } catch (error) {
    // Decision: Once the poison stub is confirmed, its HTTP 200 mustn't pass through: callers may cache
    // successful responses. An attributed 503 keeps the failure retryable without poisoning caches.
    if (error instanceof DispatchTimeoutError) {
      if (!stubConfirmed) {
        return {
          response: timeoutResponse(503, 'dispatch'),
          pathname: opts.pathname,
        };
      }
      return {
        response: staticAssetFailureResponse(PLATFORM_STATIC_ASSET_TIMEOUT),
        failureKind: PLATFORM_STATIC_ASSET_TIMEOUT,
        pathname: opts.pathname,
      };
    }
    if (error instanceof StaticAssetReadError) {
      return {
        response: staticAssetFailureResponse(PLATFORM_STATIC_ASSET_ERROR),
        failureKind: PLATFORM_STATIC_ASSET_ERROR,
        pathname: opts.pathname,
      };
    }
    throw error;
  }
  if (!fallback) {
    console.error(
      JSON.stringify({
        event: 'wfp-asset-fallback-missing',
        projectId: opts.routing.projectId,
        deploymentId: opts.routing.assetManifestId,
        pathname: opts.pathname,
        ts: Date.now(),
      }),
    );
    return {
      response: staticAssetFailureResponse(PLATFORM_STATIC_ASSET_MISSING),
      failureKind: PLATFORM_STATIC_ASSET_MISSING,
      pathname: opts.pathname,
    };
  }
  logWfpAssetFallback(opts.routing, fallback.pathname, opts.userAgent);
  return fallback;
}

/**
 * Rebuild a `Request` with mutated headers, optionally under a new URL.
 * Handles the body-preservation cases we hit at three points in the fetch
 * handler (ingress header-strip, rewrite URL swap, fallback dispatch):
 *
 * - Body already consumed/locked: drop body and any stale framing headers
 *   (`content-length` / `transfer-encoding`) — some runtimes reject bodiless
 *   frames that still advertise a framing size.
 * - GET / HEAD: no body to forward; skip the body + duplex dance.
 * - Everything else: forward the streaming body with `duplex: 'half'`.
 */
export function rebuildRequest(
  request: Request,
  url: string,
  mutateHeaders: (headers: Headers) => void,
): Request {
  const headers = new Headers(request.headers);
  mutateHeaders(headers);
  // Decision: `cf` (country, colo, botManagement, tlsClientAuth and so on) is set by the edge and read by user
  // workers. `new Request(url, init)` doesn't carry it over, so it's passed through init.cf.
  const cfProperties = request.cf;
  if (request.bodyUsed || request.body?.locked) {
    headers.delete('content-length');
    headers.delete('transfer-encoding');
    return new Request(url, { method: request.method, headers, cf: cfProperties });
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    return new Request(url, { method: request.method, headers, cf: cfProperties });
  }
  return new Request(url, {
    method: request.method,
    headers,
    body: request.body,
    cf: cfProperties,
    // @ts-expect-error -- duplex required for streaming bodies in CF Workers
    duplex: 'half',
  });
}

const dispatcher = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    privatePreview = false,
  ): Promise<Response> {
    env = await resolvePlatformApplicationEnvironment(env);
    const url = new URL(request.url);
    if (
      !env.PLATFORM_INSTALLATION_ID &&
      url.pathname === '/health' &&
      request.headers.get('X-Health-Check') === 'platform-admin'
    ) {
      return Response.json({ ok: true });
    }
    // Decision: The installer proves the full cutover while the public routing gate is still closed. This
    // endpoint exposes no app data and is reserved for the installer's exact health-check header.
    if (
      env.PLATFORM_HEALTH_PROBE_TOKEN &&
      url.pathname === '/health' &&
      request.headers.get('X-Platform-Probe') === env.PLATFORM_HEALTH_PROBE_TOKEN
    ) {
      return Response.json({
        ok: true,
        ...(env.PLATFORM_APPLICATION ? { installationId: env.PLATFORM_INSTALLATION_ID } : {}),
      });
    }
    // Decision: Project Zero Trust leaves `/health` on this hostname outside Cloudflare Access for the probe
    // above. Nothing else on that path may reach a project; other paths stay behind Access.
    if (
      url.hostname.startsWith(`${PLATFORM_HEALTH_HOSTNAME_LABEL}.`) &&
      url.hostname === platformHealthHostname(readPlatformApplication(env)) &&
      platformHealthExceptionPath(request, url)
    ) {
      return createErrorResponse(request, 404, 'Not Found', { 'Cache-Control': 'no-store' });
    }
    if (
      env.PLATFORM_TRAFFIC_STATE === 'staging' ||
      env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain' ||
      (env.PLATFORM_INSTALLATION_ID &&
        (await env.ROUTING.get(PLATFORM_DISABLED_KEY)) === PLATFORM_DISABLED_VALUE)
    ) {
      return createMaintenanceResponse(request);
    }
    const startTime = Date.now();
    // Decision: Platform storage and background work stay bounded. Foreground user workers follow the client's
    // lifetime unless the operator sets a deadline: returning early can cancel a mutation after its
    // external side effect.
    const timeoutMs = resolveTimeoutMs(env.DISPATCH_TIMEOUT_MS);
    const workerTimeoutMs = resolveTimeoutMs(env.DISPATCH_TIMEOUT_MS, 0);

    // Decision: Only /__platform/* is reserved by the platform. Other __ prefixes (/__nuxt_content,
    // /__og-image__) are user or framework assets.
    if (
      url.pathname.startsWith('/__platform/') ||
      url.pathname === '/__scheduled' ||
      url.pathname === '/__queue'
    ) {
      return createErrorResponse(request, 404, 'Not Found');
    }

    const selected = await resolveProjectHostname(url.hostname, env);
    const slug = selected.slug;
    if (selected.workersDev && !selected.projectId) {
      return createErrorResponse(request, 404, 'Not Found');
    }
    const routingKey = slug ?? `domain:${url.hostname}`;

    let routingRaw = await env.ROUTING.get(privatePreview ? 'preview:' + routingKey : routingKey, {
      cacheTtl: 60,
    });
    let previewRoute = privatePreview;
    if (!routingRaw && !privatePreview && slug?.startsWith('preview-')) {
      routingRaw = await env.ROUTING.get('preview:' + routingKey, { cacheTtl: 60 });
      previewRoute = true;
    }
    if (!routingRaw) {
      return createErrorResponse(request, 404, 'Not Found', {
        'Cache-Control': 'public, max-age=30',
      });
    }

    const routing: RoutingEntry = JSON.parse(routingRaw);
    if (selected.projectId && selected.projectId !== routing.projectId) {
      return createErrorResponse(request, 404, 'Not Found');
    }
    // Decision: Omission stays distinct from false, so a future platform default can change without overriding
    // an app's explicit opt-out.
    if (routing.alwaysUseHttps ?? false) {
      const redirect = redirectToHttps(request);
      if (redirect) {
        return redirect;
      }
    }
    if (!privatePreview && (routing.privatePreview || previewRoute)) {
      if (!routing.privatePreview || !env.PREVIEW_API) {
        return createErrorResponse(request, 404, 'Not Found', { 'Cache-Control': 'no-store' });
      }
      const headers = new Headers(request.headers);
      headers.set('X-Platform-Preview-URL', request.url);
      headers.delete('Authorization');
      return env.PREVIEW_API.fetch(
        new Request('https://preview.invalid/oauth/preview-serve/' + routing.projectId, {
          method: request.method,
          headers,
          body: request.body,
          redirect: 'manual',
        }),
      );
    }
    if (Boolean(routing.privatePreview) !== privatePreview) {
      return createErrorResponse(request, 404, 'Not Found', { 'Cache-Control': 'no-store' });
    }

    // Decision: Access normally rejects unauthenticated traffic before dispatch. This separate assertion check
    // makes a deleted or drifted Access application fail closed instead of publishing the project.
    if (
      routing.zeroTrust &&
      !(await projectAccessVerifier.verify(
        url.hostname,
        request.headers.get('Cf-Access-Jwt-Assertion'),
        routing.zeroTrust,
      ))
    ) {
      return createErrorResponse(request, 403, 'Cloudflare Access authentication required', {
        'Cache-Control': 'no-store',
      });
    }

    const limitResponse = (resource: 'requests' | 'execution') =>
      createLimitResponse(
        request,
        {
          code: 'usage_limit',
          resource,
          reason: resource === 'requests' ? 'monthly_quota' : 'cpu',
          message:
            resource === 'requests'
              ? 'This app has reached its usage allowance. Please contact the app owner or try again later.'
              : 'This request exceeded its execution limit. Please try again.',
        },
        async () => {
          const deploymentId = routing.staticDeploymentId ?? routing.assetManifestId;
          if (!deploymentId) {
            return null;
          }
          const path = resource === 'requests' ? '/usage-limit.html' : '/execution-limit.html';
          const manifest = await fetchAssetManifest(env, deploymentId, routing.projectId, 2000);
          const hash = manifest?.[path];
          return hash
            ? fetchStaticAsset(env, hash, path, routing.projectId, deploymentId, 2000)
            : null;
        },
      );

    if (routing.suspended === 'requests_exceeded') {
      return limitResponse('requests');
    }
    if (routing.suspended === 'credits_paused') {
      return createErrorResponse(request, 503, 'This app is paused', {
        'Cache-Control': 'public, s-maxage=30, max-age=0',
      });
    }
    if (routing.suspended === 'credits_grace') {
      const allowed = await env.CREDITS_GRACE_LIMITER?.limit({ key: routing.projectId }).then(
        (outcome) => outcome.success,
        () => true,
      );
      if (allowed === false) {
        return createLimitResponse(request, {
          code: 'usage_limit',
          resource: 'requests',
          reason: 'rate_limit',
          message: 'This app is busy. Please try again in a minute.',
          retryAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
    }
    if (routing.suspended === 'operator_takedown') {
      return createErrorResponse(request, 403, "This app isn't available", {
        'Cache-Control': 'public, s-maxage=30, max-age=0',
      });
    }
    if (routing.suspended && routing.suspended !== 'credits_grace') {
      return Response.json(
        { error: 'usage limit exceeded', reason: routing.suspended },
        { status: 429, headers: { 'Cache-Control': 'public, s-maxage=30, max-age=0' } },
      );
    }

    // Decision: Dispatch owns X-Platform-Original-URL: only a dispatch-side rewrite sets it. A client value
    // passed through would let callers spoof the original URL that user workers trust.
    if (request.headers.has('X-Platform-Original-URL')) {
      request = rebuildRequest(request, request.url, (headers) =>
        headers.delete('X-Platform-Original-URL'),
      );
    }
    let pathname = url.pathname;
    let requestType: RequestType =
      request.headers.get('upgrade')?.toLowerCase() === 'websocket' ? 'websocket' : 'static';

    const meter = (response: Response, failureKind?: FailureKind) => {
      const responseBytes = isEventStreamResponse(response)
        ? 0
        : Number(response.headers.get('content-length') ?? 0);
      recordRequest(env, {
        projectId: routing.projectId,
        type: requestType,
        method: request.method,
        status: response.status,
        responseBytes,
        durationMs: Date.now() - startTime,
        slug: slug ?? url.hostname,
        ...(failureKind && { failureKind }),
      });
      if (routing.userId) {
        ctx.waitUntil(
          sendUsageEvent(env, {
            projectId: routing.projectId,
            userId: routing.userId,
            slug: slug ?? url.hostname,
            requests: 1,
            responseBytes,
            ...(response.status >= 500 && { status: response.status }),
            ...(failureKind && { failureKind }),
          }).catch((error: unknown) => {
            console.error(`[usage] dropped a usage event for project ${routing.projectId}:`, error);
          }),
        );
      }
      const res = new Response(response.body, response);
      res.headers.delete('X-Platform-No-Match');
      // Decision: Cache API and upstream responses have immutable headers, so the internal cache marker is only
      // stripped from this writable client response.
      res.headers.delete(SHARED_CACHE_POLICY_HEADER);
      if (slug) {
        dropParentDomainCookies(res.headers, url.hostname);
      }
      res.headers.set('X-Hosted-By', 'void.cloud');
      return res;
    };
    const meterStaticAssetFailure = (kind: FailureKind) =>
      meter(staticAssetFailureResponse(kind), kind);

    // Decision: The user's worker went past the dispatch budget. It returned nothing, so it logged nothing, and
    // its tail event only says `canceled`, which a client hang-up also produces. Only dispatch knows it
    // hung up, so it says so in the project's log stream. Metering doesn't change.
    const meterWorkerTimeout = () => {
      recordPlatformLog(env, {
        workerName: routing.workerName,
        method: request.method,
        url: request.url,
        status: 503,
        timeoutMs: workerTimeoutMs,
      });
      return meter(timeoutResponse(503, 'dispatch'));
    };

    let originalUrlHeader: string | undefined;
    if (routing.redirectRules?.length) {
      const result = applyRoutingRules(pathname, routing.redirectRules, url.hostname);
      if (result?.type === 'redirect') {
        const location = mergeQueryIntoLocation(result.destination, url.search);
        return meter(
          new Response(null, { status: result.status, headers: { Location: location } }),
        );
      }
      if (result?.type === 'rewrite') {
        // Decision: Destination shape (path-absolute, no `//`, no `?`) is enforced by the framework validator and
        // checked again by the API on manifest ingest (packages/api/src/routes/deploy.ts), so dispatch
        // doesn't validate it again.
        originalUrlHeader = request.url;
        pathname = result.destination;
        url.pathname = pathname;
      }
    }

    let workerRequest = request;
    if (originalUrlHeader) {
      workerRequest = rebuildRequest(request, url.toString(), (headers) =>
        headers.set('X-Platform-Original-URL', originalUrlHeader),
      );
    }

    // Decision: Shared asset caches mustn't skip middleware on worker-first paths, even when an older
    // deployment or an allowed request already filled them.
    const workerFirst = workerRunsBeforeAssets(routing, pathname);
    if (!workerFirst && routing.hashedAssetsPrefix && isSharedStaticCacheRequestEligible(request)) {
      const prefix = '/' + routing.hashedAssetsPrefix + '/';
      if (pathname.startsWith(prefix)) {
        // Decision: The cache key uses the post-rewrite (hash-bearing) URL. Hashed entries get a 1-year immutable
        // Cache-Control, so caching under a stable path like /logo would keep serving stale content after
        // a deploy points it at a new hash. The query is dropped: hashed names are content-addressed.
        const cacheUrl = new URL(url.toString());
        cacheUrl.search = '';
        // Decision: A host can move to another project, and immutable entries mustn't carry over.
        cacheUrl.searchParams.set('_p', routing.projectId);
        const cacheKey = new Request(cacheUrl.toString());

        // Decision: routing.headerRules apply on the way out, on cache hit and miss, not baked into the cached body.
        // That lets a cross-origin isolated app add COOP/COEP/CORP to hashed worker/wasm assets fetched
        // over GET, and lets a later header-rule change apply when the content hash is unchanged.
        //
        // Tenant rules can only add headers. The headers below are restored from the pre-rule response,
        // because forging them corrupts the asset or breaks the immutable-cache or metering contract:
        //   cache-control      immutable contract; the cache-hit check keys on it
        //   content-type       a wrong MIME breaks ES module and WebAssembly loading
        //   content-encoding   a false `gzip` makes the browser mis-decode the bytes
        //   content-length     meter() bills from it; clients frame the body by it
        //   content-range,
        //   accept-ranges      forged range semantics truncate or misread the body
        //   transfer-encoding  hop-by-hop framing; never from a tenant rule
        // Cosmetic metadata (Vary, ETag) stays overridable. The static-asset paths do the same by forcing
        // their own Cache-Control after applyHeaderRules (clientRevalidateResponse).
        const MANAGED_ASSET_HEADERS = [
          'cache-control',
          'content-type',
          'content-encoding',
          'content-length',
          'content-range',
          'accept-ranges',
          'transfer-encoding',
        ] as const;
        const finalizeAsset = (assetResponse: Response, failureKind?: FailureKind): Response => {
          const ruled = applyHeaderRules(assetResponse, pathname, routing.headerRules);
          if (ruled !== assetResponse) {
            for (const name of MANAGED_ASSET_HEADERS) {
              const managed = assetResponse.headers.get(name);
              if (managed === null) {
                ruled.headers.delete(name);
              } else {
                ruled.headers.set(name, managed);
              }
            }
          }
          return meter(ruled, failureKind);
        };

        const cache = applicationEdgeCache;
        const cached = await cache.match(cacheKey);
        if (
          cached?.headers.get('Cache-Control')?.includes('immutable') &&
          isCurrentStaticCacheResponse(cached)
        ) {
          if (!routing.staticDeploymentId) {
            const repairResult = await maybeServeWfpAssetFallback({
              env,
              routing,
              pathname,
              response: cached,
              userAgent: request.headers.get('user-agent'),
              timeoutMs,
            });
            if (repairResult.response !== cached) {
              if (isStaticCacheResponseEligible(repairResult.response)) {
                const repaired = new Response(repairResult.response.body, repairResult.response);
                repaired.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
                markSharedCachePolicy(repaired.headers);
                const repairedForCache = repaired.clone();
                ctx.waitUntil(
                  cache.delete(cacheKey).then(() => cache.put(cacheKey, repairedForCache)),
                );
                return finalizeAsset(repaired, repairResult.failureKind);
              }
              ctx.waitUntil(cache.delete(cacheKey));
              return finalizeAsset(repairResult.response, repairResult.failureKind);
            }
          }
          return finalizeAsset(cached);
        }
        if (cached) {
          await cache.delete(cacheKey);
        }
        if (routing.staticDeploymentId) {
          const staticAssetStartedAt = Date.now();
          let assetManifest: Record<string, string> | null;
          try {
            assetManifest = await fetchAssetManifest(
              env,
              routing.staticDeploymentId,
              routing.projectId,
              remainingTimeoutBudget(staticAssetStartedAt, timeoutMs),
            );
          } catch (error) {
            if (error instanceof DispatchTimeoutError) {
              return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_TIMEOUT);
            }
            if (error instanceof StaticAssetReadError) {
              return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_ERROR);
            }
            throw error;
          }
          if (!assetManifest) {
            return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_MISSING);
          }
          // Decision: Manifest keys are decoded on-disk paths, but `pathname` stays percent-encoded. The raw key is
          // tried first, then the decoded one (`oxc masthead.riv` requested as `oxc%20masthead.riv`).
          let assetPath = pathname;
          let hash = assetManifest[pathname];
          if (!hash) {
            const decoded = safeDecodePathname(pathname);
            if (decoded !== pathname && assetManifest[decoded]) {
              assetPath = decoded;
              hash = assetManifest[decoded];
            }
          }
          let response: Response;
          if (hash) {
            try {
              const assetResponse = await fetchStaticAsset(
                env,
                hash,
                assetPath,
                routing.projectId,
                routing.staticDeploymentId,
                remainingTimeoutBudget(staticAssetStartedAt, timeoutMs),
              );
              if (!assetResponse) {
                logStaticAssetMissing(routing, assetPath, hash);
                return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_MISSING);
              }
              response = assetResponse;
            } catch (error) {
              // Decision: This hashed-asset branch has no `resolved.notFound`: a storage failure is a real asset read, so
              // it returns a fast 503.
              if (error instanceof DispatchTimeoutError) {
                return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_TIMEOUT);
              }
              if (error instanceof StaticAssetReadError) {
                return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_ERROR);
              }
              throw error;
            }
          } else {
            response = createErrorResponse(request, 404, 'Not Found');
          }
          if (isStaticCacheResponseEligible(response)) {
            const res = new Response(response.body, response);
            res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
            markSharedCachePolicy(res.headers);
            ctx.waitUntil(cache.put(cacheKey, res.clone()));
            return finalizeAsset(res);
          }
          return finalizeAsset(response);
        }
        try {
          const worker = getWorker(env, routing);
          const wfpAssetStartedAt = Date.now();
          let response = await withTimeout(
            worker.fetch(workerRequest),
            remainingTimeoutBudget(wfpAssetStartedAt, timeoutMs),
            'static-asset',
          );
          // Decision: Safety net for Cloudflare asset dedupe poisoning (WC-4511, meta/design-docs/0066). It only
          // triggers on the stub's fingerprint; other responses stream through.
          const fallbackResult = await maybeServeWfpAssetFallback({
            env,
            routing,
            pathname,
            response,
            userAgent: request.headers.get('user-agent'),
            deadline: { startedAt: wfpAssetStartedAt, timeoutMs },
          });
          response = fallbackResult.response;
          const failureKind = fallbackResult.failureKind;
          if (isStaticCacheResponseEligible(response)) {
            const res = new Response(response.body, response);
            res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
            markSharedCachePolicy(res.headers);
            ctx.waitUntil(cache.put(cacheKey, res.clone()));
            return finalizeAsset(res, failureKind);
          }
          return finalizeAsset(response, failureKind);
        } catch (error) {
          if (error instanceof DispatchTimeoutError) {
            return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_TIMEOUT);
          }
          if (error instanceof Error && error.message.includes('Worker exceeded')) {
            return meter(await limitResponse('execution'));
          }
          throw error;
        }
      }
    }

    // Decision: Non-hashed static assets use deploy-versioned cache keys, with one request gate for cache reads
    // and writes. Credentialed and Range requests have to reach the worker, not a shared copy. For SSR
    // deployments, a dotted path is a candidate only when the asset manifest names it.
    const staticCachePathname = pathname;
    // Decision: `false` only when this SSR deploy's asset manifest was read and no asset answers the path.
    // Metering reuses it to label app routes.
    const knownStaticAsset = isStaticCacheRequestEligible(request, staticCachePathname, routing)
      ? await isKnownStaticAssetPath(env, staticCachePathname, routing, timeoutMs)
      : undefined;
    const isStaticCandidate = knownStaticAsset === true && !workerFirst;

    let staticCacheKey: Request | undefined;
    if (isStaticCandidate) {
      // Decision: A deployed file's body doesn't depend on the query, so the key uses the path.
      const cacheUrl = new URL(request.url);
      cacheUrl.search = '';
      cacheUrl.searchParams.set('_v', String(routing.version));
      const candidateCacheKey = new Request(cacheUrl.toString());
      staticCacheKey = candidateCacheKey;
      const staticCache = applicationEdgeCache;
      const cached = await staticCache.match(candidateCacheKey);
      if (cached && isCurrentStaticCacheResponse(cached)) {
        requestType = 'static';
        if (!routing.staticDeploymentId) {
          const repairResult = await maybeServeWfpAssetFallback({
            env,
            routing,
            pathname,
            response: cached,
            userAgent: request.headers.get('user-agent'),
            timeoutMs,
            fallbackPathname: resolveCachedWfpFallbackPathname(pathname, routing, url.hostname),
          });
          if (repairResult.response !== cached) {
            if (isStaticCacheResponseEligible(repairResult.response)) {
              const finalRes = applyHeaderRules(
                repairResult.response,
                repairResult.pathname,
                routing.headerRules,
              );
              const repaired = new Response(finalRes.clone().body, finalRes);
              repaired.headers.set(
                'Cache-Control',
                'public, s-maxage=31536000, max-age=0, must-revalidate',
              );
              markSharedCachePolicy(repaired.headers);
              const repairedForCache = repaired.clone();
              ctx.waitUntil(
                staticCache
                  .delete(candidateCacheKey)
                  .then(() => staticCache.put(candidateCacheKey, repairedForCache)),
              );
              return meter(clientRevalidateResponse(finalRes));
            }
            ctx.waitUntil(staticCache.delete(candidateCacheKey));
            return meter(repairResult.response, repairResult.failureKind);
          }
        }
        return meter(clientRevalidateResponse(cached));
      }
      if (cached) {
        // Decision: Entries written by older dispatch versions may hold an unverified dynamic response, so they
        // aren't served and are removed when found.
        await staticCache.delete(candidateCacheKey);
      }
    }

    if (routing.staticDeploymentId) {
      const staticAssetStartedAt = Date.now();
      let assetManifest: Record<string, string> | null;
      try {
        assetManifest = await fetchAssetManifest(
          env,
          routing.staticDeploymentId,
          routing.projectId,
          remainingTimeoutBudget(staticAssetStartedAt, timeoutMs),
        );
      } catch (error) {
        if (error instanceof DispatchTimeoutError) {
          return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_TIMEOUT);
        }
        if (error instanceof StaticAssetReadError) {
          return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_ERROR);
        }
        throw error;
      }
      if (!assetManifest) {
        return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_MISSING);
      }
      const assetConfig: AssetConfig = routing.assetConfig ?? {};

      // Decision: The pathname is captured before the fallback rewrite. The edge cache is keyed on the path the
      // client asked for (after pre-asset rewrites), not the rewrite target, or later requests miss.
      const fallbackOriginPathname = pathname;
      let resolved = resolveStaticPath(pathname, assetManifest, assetConfig);

      // Decision: Fallback rules run on an asset miss, before a custom 404 page, in a single pass. They're
      // status-200-only (enforced at API ingest), so applyRoutingRules only yields `rewrite` here.
      if ((!resolved || resolved.notFound) && routing.fallbackRules?.length) {
        const fallback = applyRoutingRules(pathname, routing.fallbackRules, url.hostname);
        if (fallback?.type === 'rewrite') {
          pathname = fallback.destination;
          url.pathname = pathname;
          resolved = resolveStaticPath(pathname, assetManifest, assetConfig);
        }
      }

      if (!resolved) {
        return meter(createErrorResponse(request, 404, 'Not Found'));
      }

      if (resolved.redirect) {
        return meter(
          new Response(null, {
            status: 308,
            headers: { Location: resolved.redirect },
          }),
        );
      }

      let assetResponse: Response | null;
      try {
        assetResponse = await fetchStaticAsset(
          env,
          resolved.hash,
          resolved.path,
          routing.projectId,
          routing.staticDeploymentId,
          remainingTimeoutBudget(staticAssetStartedAt, timeoutMs),
        );
      } catch (error) {
        // Decision: A stalled read of the not-found asset would have been a 404 anyway, so it returns a fast 404
        // (which mustn't trip the 5xx alert). A real asset read that stalled returns a fast 503.
        if (error instanceof DispatchTimeoutError) {
          return meter(
            timeoutResponse(resolved.notFound ? 404 : 503, 'static-asset'),
            resolved.notFound ? undefined : PLATFORM_STATIC_ASSET_TIMEOUT,
          );
        }
        if (error instanceof StaticAssetReadError) {
          return meter(
            resolved.notFound
              ? createErrorResponse(request, 404, 'Not Found')
              : staticAssetFailureResponse(PLATFORM_STATIC_ASSET_ERROR),
            resolved.notFound ? undefined : PLATFORM_STATIC_ASSET_ERROR,
          );
        }
        throw error;
      }
      if (!assetResponse) {
        if (resolved.notFound) {
          return meter(createErrorResponse(request, 404, 'Not Found'));
        }
        logStaticAssetMissing(routing, resolved.path, resolved.hash);
        return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_MISSING);
      }

      const status = resolved.notFound ? 404 : 200;
      const response = new Response(assetResponse.body, {
        status,
        headers: assetResponse.headers,
      });
      const finalRes = applyHeaderRules(response, pathname, routing.headerRules);

      // Decision: The edge cache is keyed on the original pathname the client asked for, not the post-fallback
      // rewrite target, or later requests to that path miss.
      const edgeCacheKey =
        staticCacheKey ??
        (isSharedStaticCacheRequestEligible(request)
          ? new Request(`${url.origin}${fallbackOriginPathname}?_v=${routing.staticDeploymentId}`)
          : undefined);
      if (edgeCacheKey && isStaticCacheResponseEligible(finalRes)) {
        const cached = new Response(finalRes.clone().body, finalRes);
        cached.headers.set(
          'Cache-Control',
          'public, s-maxage=31536000, max-age=0, must-revalidate',
        );
        markSharedCachePolicy(cached.headers);
        ctx.waitUntil(applicationEdgeCache.put(edgeCacheKey, cached.clone()));
      }

      return meter(clientRevalidateResponse(finalRes));
    }

    const worker = getWorker(env, routing);
    try {
      let dispatchReq = workerRequest;
      if (dispatchReq.bodyUsed) {
        dispatchReq = rebuildRequest(dispatchReq, dispatchReq.url, () => {});
      }
      // Decision: A worker-backed fallbackRule on a 404 needs the original body for its re-dispatch, but
      // worker.fetch consumes the stream and rebuildRequest drops the body of a `bodyUsed` request. So
      // it's cloned here (clone() tees the stream on Workers), only when there are fallback rules and the
      // method has a body.
      const hasBodyMethod = dispatchReq.method !== 'GET' && dispatchReq.method !== 'HEAD';
      const dispatchReqForFallback =
        hasBodyMethod && routing.fallbackRules?.length ? dispatchReq.clone() : dispatchReq;
      const workerDispatchStartedAt = Date.now();
      const workerDeadline =
        env.DISPATCH_TIMEOUT_MS === undefined
          ? undefined
          : { startedAt: workerDispatchStartedAt, timeoutMs: workerTimeoutMs };
      let response = await withTimeout(
        worker.fetch(dispatchReq),
        remainingTimeoutBudget(workerDispatchStartedAt, workerTimeoutMs, 'dispatch'),
        'dispatch',
      );
      let isEventStream = isEventStreamResponse(response);
      let responseFailureKind: FailureKind | undefined;

      if (!isEventStream) {
        const assetFallbackResult = await maybeServeWfpAssetFallback({
          env,
          routing,
          pathname,
          response,
          userAgent: request.headers.get('user-agent'),
          deadline: workerDeadline,
        });
        response = assetFallbackResult.response;
        responseFailureKind = assetFallbackResult.failureKind;
        isEventStream = isEventStreamResponse(response);
      }

      // Decision: For static deployments fallbackRules run after assets. Here the user worker resolves paths, so a
      // 404 stands in for a static-asset miss. Single pass: the rewrite target's response is returned as
      // is, even if it's also a 404.
      let writebackFallbackApplied = false;
      if (!isEventStream) {
        const fallbackResult = await applyWorkerFallbackRules({
          response,
          worker,
          dispatchReq: dispatchReqForFallback,
          routing,
          pathname,
          url,
          originalRequestUrl: request.url,
          originalUrlHeader,
          deadline: workerDeadline,
        });
        if (fallbackResult.applied) {
          writebackFallbackApplied = true;
          pathname = fallbackResult.pathname;
          url.pathname = pathname;
          response = fallbackResult.response;
          isEventStream = isEventStreamResponse(response);
          if (!isEventStream) {
            const assetFallbackResult = await maybeServeWfpAssetFallback({
              env,
              routing,
              pathname,
              response,
              userAgent: request.headers.get('user-agent'),
              deadline: workerDeadline,
            });
            response = assetFallbackResult.response;
            responseFailureKind = assetFallbackResult.failureKind;
            isEventStream = isEventStreamResponse(response);
          }
        }
      }

      // Decision: Requires exactly 200: `.ok` admits 206 Partial Content, which would poison the shared
      // `<path>?_v=` key with a partial body served to later full requests.
      if (staticCacheKey && !writebackFallbackApplied && isStaticCacheResponseEligible(response)) {
        const res = new Response(response.body, response);
        const finalRes = applyHeaderRules(res, pathname, routing.headerRules);
        const cacheRes = new Response(finalRes.clone().body, finalRes);
        cacheRes.headers.set(
          'Cache-Control',
          'public, s-maxage=31536000, max-age=0, must-revalidate',
        );
        markSharedCachePolicy(cacheRes.headers);
        ctx.waitUntil(applicationEdgeCache.put(staticCacheKey, cacheRes.clone()));
        return meter(clientRevalidateResponse(finalRes), responseFailureKind);
      }

      // Decision: A path with a file extension counts as the app's only when the worker (not the asset layer)
      // answered it, and either the manifest says it isn't a deployed file or the response is a server
      // error. Platform asset failures carry a failure kind and keep the default.
      const listedAsset = pathname === staticCachePathname ? knownStaticAsset : undefined;
      const handledByApp =
        !responseFailureKind &&
        workerAnsweredPath(routing, listedAsset) &&
        (listedAsset === false || response.status >= 500);
      const dynamicType = classifyDynamicRequestType(pathname, routing.ssr, handledByApp);
      if (dynamicType) {
        requestType = dynamicType;
      }

      return meter(applyHeaderRules(response, pathname, routing.headerRules), responseFailureKind);
    } catch (error) {
      if (error instanceof DispatchTimeoutError) {
        if (error.label === 'static-asset') {
          return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_TIMEOUT);
        }
        // Decision: The request was still running when the budget ran out. It counts as the app's when the worker,
        // not the asset layer, owns the path.
        const dynamicType = classifyDynamicRequestType(
          pathname,
          routing.ssr,
          workerAnsweredPath(
            routing,
            pathname === staticCachePathname ? knownStaticAsset : undefined,
          ),
        );
        if (dynamicType) {
          requestType = dynamicType;
        }
        return meterWorkerTimeout();
      }
      if (error instanceof StaticAssetReadError) {
        return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_ERROR);
      }
      if (error instanceof Error && error.message.includes('Worker exceeded')) {
        return meter(await limitResponse('execution'));
      }
      throw error;
    }
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    if (
      env.PLATFORM_TRAFFIC_STATE === 'staging' ||
      env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain'
    ) {
      console.warn(
        `[queue-relay] platform traffic is staging; retrying queue="${batch.queue}" in ${PLATFORM_QUEUE_RETRY_DELAY_SECONDS}s`,
      );
      batch.retryAll({ delaySeconds: PLATFORM_QUEUE_RETRY_DELAY_SECONDS });
      return;
    }
    if (env.PLATFORM_INSTALLATION_ID) {
      let disabled: string | null;
      try {
        disabled = await env.ROUTING.get(PLATFORM_DISABLED_KEY);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[queue-relay] platform traffic gate read failed; retrying queue="${batch.queue}" in ${PLATFORM_QUEUE_RETRY_DELAY_SECONDS}s error=${JSON.stringify(message)}`,
        );
        batch.retryAll({ delaySeconds: PLATFORM_QUEUE_RETRY_DELAY_SECONDS });
        return;
      }
      if (disabled === PLATFORM_DISABLED_VALUE) {
        console.warn(
          `[queue-relay] platform traffic is disabled; retrying queue="${batch.queue}" in ${PLATFORM_QUEUE_RETRY_DELAY_SECONDS}s`,
        );
        batch.retryAll({ delaySeconds: PLATFORM_QUEUE_RETRY_DELAY_SECONDS });
        return;
      }
    }

    const routingRaw = await env.ROUTING.get(`queue:${batch.queue}`, { cacheTtl: 60 });
    if (!routingRaw) {
      console.error(
        `[queue-relay] missing routing entry for queue="${batch.queue}"; retrying all messages`,
      );
      batch.retryAll();
      return;
    }
    const { workerName, projectId, queueName, proxyToken } = JSON.parse(
      routingRaw,
    ) as QueueRoutingEntry;
    if (projectId && (await isProjectSuspended(env, projectId))) {
      console.warn(
        `[queue-relay] project suspended; retrying queue="${batch.queue}" in ${SUSPENDED_PROJECT_QUEUE_RETRY_DELAY_SECONDS}s`,
      );
      batch.retryAll({ delaySeconds: SUSPENDED_PROJECT_QUEUE_RETRY_DELAY_SECONDS });
      return;
    }

    const messages = Array.from(batch.messages, (message) => ({
      id: message.id,
      timestamp: message.timestamp.toISOString(),
      body: message.body,
      attempts: message.attempts,
    }));

    const worker = env.DISPATCH.get(workerName);
    try {
      const body = JSON.stringify({ queue: queueName, messages });
      const queueHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (proxyToken) {
        queueHeaders['x-platform-internal'] = proxyToken;
      }
      let res = await worker.fetch(
        new Request('https://internal/__platform/queue', {
          method: 'POST',
          headers: queueHeaders,
          body,
        }),
      );
      if (res.status === 404) {
        res = await worker.fetch(
          new Request('https://internal/__queue', {
            method: 'POST',
            headers: queueHeaders,
            body,
          }),
        );
      }

      if (!res.ok) {
        // Decision: Dispatch tail ingests this under the __platform-dispatch project key, so operators can see who
        // rejects relays and why.
        let snippet = '';
        try {
          snippet = (await res.clone().text()).slice(0, 200);
        } catch {}
        console.error(
          `[queue-relay] relay failed queue="${queueName}" worker="${workerName}" status=${res.status} body=${JSON.stringify(snippet)}`,
        );
        // Decision: The batch isn't relayed again with another token, because the Worker's own middleware already
        // ran for this request. A later delivery runs it again, as any queue retry does.
        if (res.status === 401 || res.status === 403) {
          batch.retryAll({ delaySeconds: QUEUE_TOKEN_REJECTED_RETRY_DELAY_SECONDS });
        } else {
          batch.retryAll();
        }
        return;
      }

      let result: {
        ok?: boolean;
        decisions?: Record<string, { action: string; delaySeconds?: number }>;
      };
      try {
        result = await res.json();
      } catch {
        // Decision: A non-JSON 2xx comes from a legacy framework and counts as success.
        batch.ackAll();
        return;
      }

      if (!result.decisions) {
        // Decision: No decisions means the legacy protocol, so the whole batch is acked or retried.
        if (result.ok !== false) {
          batch.ackAll();
        } else {
          batch.retryAll();
        }
        return;
      }

      const messageMap = new Map(batch.messages.map((message) => [message.id, message]));
      for (const [id, decision] of Object.entries(result.decisions)) {
        const cfMessage = messageMap.get(id);
        if (!cfMessage) {
          continue;
        }
        if (decision.action === 'ack') {
          cfMessage.ack();
        } else if (decision.action === 'retry') {
          cfMessage.retry(
            decision.delaySeconds != null ? { delaySeconds: decision.delaySeconds } : undefined,
          );
        }
      }

      // Decision: When the handler failed, undecided messages are retried; per-message decisions still hold on
      // Cloudflare.
      if (result.ok === false) {
        batch.retryAll();
      }
      // Decision: When ok is true, undecided messages are acked implicitly (Cloudflare's default when the consumer
      // returns successfully).
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        `[queue-relay] relay threw queue="${queueName}" worker="${workerName}" error=${JSON.stringify(msg)}`,
      );
      batch.retryAll();
    }
  },
} satisfies ExportedHandler<Env>;

export default dispatcher;

/** Only the platform API is bound to this entrypoint; public HTTP uses dispatcher. */
export class PreviewDispatcher extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> {
    return dispatcher.fetch(request, this.env, this.ctx, true);
  }
}

class StaticAssetReadError extends Error {
  constructor(cause: unknown) {
    super('Static asset storage read failed', { cause });
    this.name = 'StaticAssetReadError';
  }
}

function logStaticAssetMissing(routing: RoutingEntry, pathname: string, hash: string): void {
  console.error(
    JSON.stringify({
      event: 'static-asset-missing',
      store: hash.startsWith('!') ? 'r2' : 'kv',
      projectId: routing.projectId,
      deploymentId: routing.staticDeploymentId ?? routing.assetManifestId,
      pathname,
      ts: Date.now(),
    }),
  );
}

/**
 * Fetch a static asset from KV (legacy small files) or R2 (`!`-prefixed modern
 * direct uploads and legacy large files).
 *
 * The complete scoped→legacy sequence gets one delayed hedge and one absolute
 * timeout. Hedging the sequence (rather than each binding result) means a KV
 * `{ value: null }` miss has the same semantics as an R2 `null` miss.
 *
 * Each sequence tries the project-scoped key first
 * (`assets/{projectId}/{hash}`), then the legacy shared key (`assets/{hash}`)
 * for backward compatibility with deployments created before asset key
 * scoping.
 * Returns null if the asset is not found.
 */
async function fetchStaticAsset(
  env: Env,
  hash: string,
  path: string,
  projectId?: string,
  deploymentId?: string,
  timeoutMs = 10_000,
): Promise<Response | null> {
  const hedgeDelayMs = staticAssetHedgeDelayMs(timeoutMs);
  const startedAt = Date.now();
  let hedged = false;

  try {
    const result = await withDelayedHedge(() => fetchStaticAssetOnce(env, hash, path, projectId), {
      delayMs: hedgeDelayMs,
      timeoutMs,
      label: 'static-asset',
      discard: async (late) => {
        await late.body?.cancel();
      },
      onHedge: () => {
        hedged = true;
        console.warn(
          JSON.stringify({
            event: 'static-asset-read-hedge',
            store: hash.startsWith('!') ? 'r2' : 'kv',
            projectId,
            deploymentId,
            pathname: path,
            delayMs: hedgeDelayMs,
            ts: Date.now(),
          }),
        );
      },
    });

    if (hedged) {
      console.warn(
        JSON.stringify({
          event: 'static-asset-read-hedge-result',
          store: hash.startsWith('!') ? 'r2' : 'kv',
          projectId,
          deploymentId,
          pathname: path,
          outcome: result === null ? 'miss' : 'hit',
          elapsedMs: Date.now() - startedAt,
          ts: Date.now(),
        }),
      );
    }
    return result;
  } catch (error) {
    console.error(
      JSON.stringify({
        event:
          error instanceof DispatchTimeoutError
            ? 'static-asset-timeout'
            : 'static-asset-read-error',
        store: hash.startsWith('!') ? 'r2' : 'kv',
        projectId,
        deploymentId,
        pathname: path,
        hedged,
        elapsedMs: Date.now() - startedAt,
        error:
          error instanceof DispatchTimeoutError
            ? undefined
            : error instanceof Error
              ? error.message
              : String(error),
        ts: Date.now(),
      }),
    );
    if (error instanceof DispatchTimeoutError) {
      throw error;
    }
    throw new StaticAssetReadError(error);
  }
}

async function fetchStaticAssetOnce(
  env: Env,
  hash: string,
  path: string,
  projectId?: string,
): Promise<Response | null> {
  const isLarge = hash.startsWith('!');
  const cleanHash = isLarge ? hash.slice(1) : hash;
  const scopedKey = projectId ? `assets/${projectId}/${cleanHash}` : null;
  const legacyKey = `assets/${cleanHash}`;

  if (isLarge) {
    const obj = scopedKey
      ? ((await env.STATIC_ASSETS_R2.get(scopedKey)) ?? (await env.STATIC_ASSETS_R2.get(legacyKey)))
      : await env.STATIC_ASSETS_R2.get(legacyKey);
    if (!obj) {
      return null;
    }
    const contentType = resolveAssetContentType(obj.httpMetadata?.contentType, path);
    const headers: HeadersInit = {
      ETag: obj.httpEtag,
      ...(obj.size ? { 'Content-Length': String(obj.size) } : {}),
    };
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    return new Response(obj.body, { headers });
  }

  const readKvAsset = async (key: string): Promise<Response | null> => {
    const { value, metadata } = await env.STATIC_ASSETS.getWithMetadata<{ ct: string }>(key, {
      type: 'arrayBuffer',
      cacheTtl: 86_400,
    });
    if (!value) {
      return null;
    }
    const contentType = resolveAssetContentType(metadata?.ct, path);
    const headers: HeadersInit = {
      'Content-Length': String(value.byteLength),
    };
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    return new Response(value, { headers });
  };

  return (scopedKey ? await readKvAsset(scopedKey) : null) ?? readKvAsset(legacyKey);
}

function getWorker(env: Env, routing: RoutingEntry): Fetcher {
  if (routing.limits) {
    return env.DISPATCH.get(routing.workerName, {}, { limits: routing.limits });
  }
  return env.DISPATCH.get(routing.workerName);
}

/** Match Cloudflare's glob-only rules, with asset exclusions taking precedence. */
function workerRunsBeforeAssets(routing: RoutingEntry, pathname: string): boolean {
  if (routing.staticDeploymentId) {
    return false;
  }
  const rules = routing.assetConfig?.run_worker_first;
  if (typeof rules === 'boolean') {
    return rules;
  }
  let workerFirst = false;
  for (const rule of rules ?? []) {
    const excluded = rule.startsWith('!');
    if (matchLiteralPattern(excluded ? rule.slice(1) : rule, pathname)) {
      if (excluded) {
        return false;
      }
      workerFirst = true;
    }
  }
  return workerFirst;
}

/**
 * Every static cache shares one representation across callers, so credentials,
 * EventSource semantics, and partial requests bypass it.
 */
function isSharedStaticCacheRequestEligible(request: Request): boolean {
  return Boolean(
    request.method === 'GET' && !request.headers.has('Range') && !bypassesSharedCache(request),
  );
}

function isStaticCacheRequestEligible(
  request: Request,
  pathname: string,
  routing: RoutingEntry,
): boolean {
  return Boolean(
    isSharedStaticCacheRequestEligible(request) &&
    routing.version &&
    !isApiPath(pathname) &&
    (hasExtension(pathname) || !routing.ssr),
  );
}

/**
 * Whether `pathname` may use the deploy-versioned static cache.
 *
 * - `true`: a static deploy, a non-SSR deploy, or a path the SSR deploy's asset
 *   manifest lists.
 * - `false`: the SSR deploy's asset manifest was read, does not list the path,
 *   and lists no HTML file Cloudflare's `html_handling` would answer it from.
 * - `undefined`: there is no manifest to consult, it could not be read, or
 *   `html_handling` would answer the path from a listed HTML file.
 *
 * Only `true` makes a request a static-cache candidate.
 */
async function isKnownStaticAssetPath(
  env: Env,
  pathname: string,
  routing: RoutingEntry,
  timeoutMs: number,
): Promise<boolean | undefined> {
  if (routing.staticDeploymentId) {
    return true;
  }
  if (!routing.ssr) {
    return true;
  }
  if (!routing.assetManifestId) {
    return undefined;
  }
  try {
    const manifest = await fetchAssetManifest(
      env,
      routing.assetManifestId,
      routing.projectId,
      Math.min(timeoutMs, STATIC_ASSET_HEDGE_DELAY_MS),
    );
    if (!manifest) {
      return undefined;
    }
    if (Object.hasOwn(manifest, pathname)) {
      return true;
    }
    const decoded = safeDecodePathname(pathname);
    if (decoded !== pathname && Object.hasOwn(manifest, decoded)) {
      return true;
    }
    // Decision: Not a listed file, but Cloudflare's asset layer may still serve or redirect it from an HTML file,
    // so it isn't known to be the worker's.
    const htmlHandling = routing.assetConfig?.html_handling ?? 'auto-trailing-slash';
    if (
      htmlHandling !== 'none' &&
      (hasHtmlHandlingSource(manifest, pathname) || hasHtmlHandlingSource(manifest, decoded))
    ) {
      return undefined;
    }
    return false;
  } catch {
    // Decision: Asset identity only gates an optimization. With no manifest, the request is dispatched live
    // instead of guessing from the URL or response.
    return undefined;
  }
}

/**
 * Whether the manifest lists an HTML file that Cloudflare's `html_handling`
 * serves or redirects to for `pathname`: `/x` from `/x.html` or
 * `/x/index.html`, `/x.html` from `/x/index.html`, and `/x/index.html` from
 * `/x.html`. Every mode except `none` reads these same files.
 */
function hasHtmlHandlingSource(manifest: Record<string, string>, pathname: string): boolean {
  const sources = [`${pathname}.html`, `${pathname}/index.html`];
  if (pathname.endsWith('.html')) {
    const base = pathname.slice(0, -'.html'.length);
    sources.push(`${base}/index.html`);
    if (base.endsWith('/index')) {
      sources.push(`${base.slice(0, -'/index'.length)}.html`);
    }
  }
  return sources.some((source) => Object.hasOwn(manifest, source));
}

/**
 * Whether the user worker, not Cloudflare's asset layer, answers `pathname`.
 * `listed` is the asset manifest's answer for the path (see
 * `isKnownStaticAssetPath`).
 *
 * A worker deploy published since asset manifests were introduced has no
 * manifest only when it uploaded no files, so the worker answers everything.
 * So does a deploy whose `run_worker_first` covers every path. Older live
 * deploys may still have an asset layer without a manifest, so callers use a
 * `true` here for a successful response only when the manifest also marks the
 * path unlisted. Otherwise the asset layer serves listed files itself, and an
 * unlisted path reaches the worker only with `not_found_handling: 'none'`
 * (Cloudflare's default); the SPA shell and the 404 page come from the asset
 * layer. When `listed` is `undefined` (no readable manifest, or an HTML file the
 * asset layer answers the path from), the path is not known to be the worker's.
 */
function workerAnsweredPath(routing: RoutingEntry, listed: boolean | undefined): boolean {
  if (!routing.assetManifestId) {
    return true;
  }
  const runWorkerFirst = routing.assetConfig?.run_worker_first;
  if (
    runWorkerFirst === true ||
    (Array.isArray(runWorkerFirst) && runWorkerFirst.includes('/**'))
  ) {
    return true;
  }
  return listed === false && (routing.assetConfig?.not_found_handling ?? 'none') === 'none';
}

/** Apply the same origin/cached response policy to static reads and writes. */
function isStaticCacheResponseEligible(response: Response): boolean {
  return (
    response.status === 200 && !isEventStreamResponse(response) && !hasSharedCacheOptOut(response)
  );
}

/** Only entries written under the current shared-cache policy are safe to serve. */
function isCurrentStaticCacheResponse(response: Response): boolean {
  return hasCurrentSharedCachePolicy(response) && isStaticCacheResponseEligible(response);
}
