import { readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { getPackageDir } from './agents.ts';
import { getApiUrl } from './auth.ts';
import { ensurePlatformAccessToken, isCloudflareAccessChallenge } from './cf-access.ts';
import type { CliLogger } from './log-file.ts';
import { readPlatformDiscoveryResponse } from './platform-discovery.ts';
import { formatPlatformApiError, parsePlatformErrorBody } from './platform-errors.ts';
import type { ProjectPermission } from './platform-errors.ts';
import { normalizePlatformApiUrl } from './platform-registry.ts';
import type {
  DeployAssetUploadRequest,
  DeployEvent,
  DeployUploadPayload,
  DeployWorkerModule,
  DeployWorkerUploadResponse,
} from './types.ts';

// Decision: Null omits `X-Platform-CLI-Version`: the platform answers an unparseable version with 426.
function readCliVersion(): string | null {
  try {
    const pkgPath = join(getPackageDir(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

const BWF_CLI_VERSION = readCliVersion();

/** The oldest bwf platform release this CLI supports. */
export const MIN_PLATFORM_VERSION = '1.9.0';

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * Discovery probes keyed by platform base URL. Every outcome (pass,
 * inconclusive, or too old) is kept for the rest of the process, so polling
 * commands probe discovery once.
 */
const platformVersionProbes = new Map<string, Promise<PlatformVersionProbe>>();

/**
 * What public discovery says about the platform version:
 * - `version`: the reported `platformVersion`, and whether the platform
 *   accepts Worker modules uploaded straight to R2
 * - `missing`: discovery answered 404, so the platform predates discovery
 * - `unknown`: no usable answer (network error, timeout, disabled platform,
 *   Access login page, or an invalid document)
 */
type PlatformVersionProbe =
  | { kind: 'version'; version: string; directWorkerUpload: boolean }
  | { kind: 'missing' }
  | { kind: 'unknown' };

/**
 * Returns whether `version` is older than the release `minimumVersion`, or null
 * when it is not a release version. A prerelease sorts before its release.
 */
export function isOlderPlatformVersion(version: string, minimumVersion: string): boolean | null {
  const actual = RELEASE_VERSION.exec(version);
  const minimum = RELEASE_VERSION.exec(minimumVersion)!;
  if (!actual) {
    return null;
  }
  for (const part of [1, 2, 3]) {
    const difference = Number(actual[part]) - Number(minimum[part]);
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return actual[4] !== undefined && minimum[4] === undefined;
}

const UPGRADE_PLATFORM_ACTION =
  'Ask its administrator to upgrade the platform runtime with `bwf platform upgrade`.';

function assertSupportedPlatform(apiUrl: string, probe: PlatformVersionProbe): void {
  if (probe.kind === 'unknown') {
    // Decision: Let the real request run and report its own error.
    return;
  }
  if (probe.kind === 'missing') {
    // Decision: Each bwf platform release serves discovery, so a 404 there means a platform that predates it, and
    // so predates the minimum.
    throw new Error(
      `The bwf platform at ${apiUrl} does not report its version, but this CLI requires ${MIN_PLATFORM_VERSION} or later. ${UPGRADE_PLATFORM_ACTION}`,
    );
  }
  const { version } = probe;
  // Decision: Installed and hosted platforms report their release version. "hosted" comes from a hosted
  // deployment that doesn't set PLATFORM_VERSION yet. Any other value that isn't a release version
  // comes from a custom or development build and can't be ordered. Both pass.
  if (version === 'hosted' || isOlderPlatformVersion(version, MIN_PLATFORM_VERSION) !== true) {
    return;
  }
  throw new Error(
    `The bwf platform at ${apiUrl} runs version ${version}, but this CLI requires ${MIN_PLATFORM_VERSION} or later. ${UPGRADE_PLATFORM_ACTION}`,
  );
}

export { parsePlatformErrorBody } from './platform-errors.ts';

/**
 * Detects the `cli_outdated` 426 response shape emitted by the platform's
 * `cliVersionGate` middleware. When present, callers should surface the
 * server's `message` field verbatim — it already includes upgrade
 * instructions — rather than the default `<action>: <status> <body>`
 * which would dump raw JSON at the user.
 */
export function isCliOutdatedError(err: unknown): err is PlatformApiError {
  if (!(err instanceof PlatformApiError)) {
    return false;
  }
  if (err.status !== 426) {
    return false;
  }
  return parsePlatformErrorBody(err.body)?.error === 'cli_outdated';
}

export class PlatformApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly code?: string;

  constructor(action: string, status: number, body: string, permission?: ProjectPermission) {
    const parsed = parsePlatformErrorBody(body);
    super(formatPlatformApiError(action, status, body, permission));
    this.name = 'PlatformApiError';
    this.status = status;
    this.body = body;
    this.code = parsed?.error ?? parsed?.message;
  }
}

async function throwPlatformApiError(
  action: string,
  res: Response,
  permission?: ProjectPermission,
): Promise<never> {
  throw new PlatformApiError(
    action,
    res.status,
    await res.text(),
    isCloudflareAccessChallenge(res) ? undefined : permission,
  );
}

export function isExpiredTokenError(error: unknown): boolean {
  if (error instanceof PlatformApiError) {
    return error.status === 401 && error.code === 'invalid or expired token';
  }
  return false;
}

/**
 * True when `fetch` gave up waiting for response headers (undici's
 * `HeadersTimeoutError`, 300 seconds by default). The request reached the
 * server, which is still working on it.
 */
export function isHeadersTimeoutError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === 'object'; depth++) {
    const { code, name } = current as { code?: unknown; name?: unknown };
    if (code === 'UND_ERR_HEADERS_TIMEOUT' || name === 'HeadersTimeoutError') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isPreflightRejection(error: unknown): boolean {
  return (
    error instanceof PlatformApiError &&
    (([401, 403].includes(error.status) && !!parsePlatformErrorBody(error.body)?.error) ||
      isCliOutdatedError(error))
  );
}

export type ProjectResponse = {
  url?: string;
  id: string;
  user_id: string;
  slug: string;
  type: string;
  created_at: string;
  custom_domain: string | null;
  role: ProjectRole;
  owner?: {
    id: string;
    login?: string;
  };
};

export type ProjectRole = 'reader' | 'collaborator' | 'admin' | 'owner';

export type ProjectMemberResponse = {
  role: ProjectRole;
  created_at: string;
  user: {
    id: string;
    login: string | null;
  };
};

export type ProjectMemberListResponse = {
  members: Array<ProjectMemberResponse>;
  warnings?: Array<string>;
};

export type ProjectInvitationResponse = {
  id: string;
  target_email?: string;
  role: Exclude<ProjectRole, 'owner'>;
  status?: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  created_at: string;
  expires_at: string;
  accepted_at?: string | null;
  revoked_at?: string | null;
  project?: {
    id: string;
    slug: string;
    owner?: {
      id: string;
      login: string | null;
    };
  };
  target?: {
    id: string;
    login: string | null;
    email: string | null;
  };
  invited_by?: {
    id: string;
    login: string | null;
  };
};

type ProjectInvitationDelivery = {
  status: 'sent' | 'not_configured' | 'rate_limited' | 'failed';
};

export type ProjectDeployCredentialResponse = {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

type ProjectZeroTrustState = {
  project_id: string;
  desired_protected: boolean;
  effective_protected: boolean;
  state: 'public' | 'protected' | 'reconciling' | 'error';
  last_error: string | null;
  updated_at: string;
};

/** `GET /projects/:id/zero-trust`. */
export type ProjectZeroTrustResponse = {
  /** Whether a project owner or admin can change protection now. */
  available: boolean;
  platformStatus:
    | 'not_configured'
    | 'invalid_configuration'
    | 'configuring'
    | 'ready'
    | 'disabling'
    | 'error';
  protectNewProjects: boolean;
  project: ProjectZeroTrustState | null;
};

/** `PUT /projects/:id/zero-trust` and `POST /projects/:id/zero-trust/reconcile`. */
export type ProjectZeroTrustUpdateResponse = {
  ok: true;
  project: ProjectZeroTrustState;
};

export type IssuedProjectDeployCredentialResponse = ProjectDeployCredentialResponse & {
  token: string;
};

export type CreateProjectResponse = {
  url?: string;
  id: string;
  slug: string;
  warnings?: Array<string>;
  zero_trust?: ProjectZeroTrustState;
  /**
   * Set when the platform scheduled the owner's address as an email destination.
   * Registration runs after the response, so this says nothing about its outcome.
   */
  owner_email_destination?: {
    address: string;
  };
};

export type DeleteProjectResponse = {
  ok: boolean;
  id: string;
  slug: string;
  warnings?: Array<string>;
};

export type DeploymentResponse = {
  id: string;
  status: string;
  source: string | null;
  commit: string | null;
  manifest: string | null;
  error_message: string | null;
  retained: boolean;
  applied_migrations: string | null;
  created_at: string;
  deployed_at: string | null;
};

export type DeploymentListResponse = {
  deployments: Array<DeploymentResponse>;
  activeDeploymentId: string | null;
  warnings?: Array<string>;
};

export type SecretResponse = {
  ok: boolean;
  name: string;
};

export type LogEntry = {
  timestamp: number;
  outcome: string;
  logs: Array<{
    level: string;
    message: Array<unknown>;
    timestamp: number;
    errorInfo?: Array<{ name: string; message: string; stack?: string } | null>;
  }>;
  exceptions: Array<{ name: string; message: string; timestamp: number; stack?: string }>;
  url: string;
  method: string;
  status: string;
};

export type LogsResult = {
  entries: Array<LogEntry>;
  /** Set when the platform keeps messages and URLs out of its logs. */
  runtimeLogs?: 'minimal';
};

export type RequestEntry = {
  timestamp: string;
  type: string;
  method: string;
  status: string;
  bytes: number;
  durationMs: number;
};

export type BuildSummary = {
  id: string;
  status: string;
  executor: 'container' | 'github_actions';
  commit_sha: string | null;
  branch: string | null;
  exit_code: number | null;
  error: string | null;
  logs_url: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type BuildLogRow = {
  seq: number;
  line: string;
  stream: 'stdout' | 'stderr';
  ts: number;
};

export type BuildLogsResponse = {
  lines: Array<BuildLogRow>;
  lastSeq: number;
  status: string;
  terminal: boolean;
  logsComplete: boolean | null;
  external: string | null;
};

export type EmailUsageResponse = {
  month: string;
  attempts: number;
  received: number;
  limit: number;
  remaining: number;
  suspended: boolean;
};

type EmailLogEntry = {
  timestamp: number;
  direction: 'sent' | 'received';
  operationId: string;
  receiptId: string | null;
  recipient: string | null;
  status: string;
  transport: string;
  providerReference: string | null;
  errorCode: string | null;
  policyVersion: number | null;
};

export type EmailLogsResponse = {
  logs: Array<EmailLogEntry>;
};

export type EmailDestinationResponse = {
  id: string;
  address: string;
  status: 'pending' | 'verified' | 'failed';
  verified_at: string | null;
  created_at: string;
  /** Set when the platform, not Cloudflare, mailed the confirmation link; a repeat add re-sends it. */
  platformVerificationPending?: boolean;
  /** `false` when this call mailed nothing because an earlier Cloudflare link is still pending. */
  verificationSent?: boolean;
};

/** GET /projects/:id/email/settings — installation settings the CLI reads before acting. */
export type EmailSettingsResponse = {
  domains: {
    /** `admin`: administrators register email domains; `bwf email domain add` prints their command. */
    management: 'self-serve' | 'admin';
    projectSlug?: string;
  };
  recipientPolicy?: { mode: 'verified' | 'domains' | 'any'; domains: Array<string> };
  /** A second, permanent name on the shared mail domain; the slug keeps working. */
  emailAlias?: string | null;
  /** The platform's shared mail domain, or null when it has none. */
  sharedDomain?: string | null;
  sharedInbound?: EmailSharedInbound | null;
};

export type EmailSharedInbound = {
  recipient: string;
  status: string;
  reason: string | null;
  observedAt: string | null;
};

export type EmailAliasResponse = {
  emailAlias: string;
  address: string;
  sharedInbound: EmailSharedInbound | null;
};

export type EmailDomainResponse = {
  id: string;
  domain: string;
  projectId: string;
  managed_by: 'owner' | 'admin';
  /** `none` sends only; the domain's MX provider keeps inbound mail. */
  inboundMode?: 'managed' | 'none';
  status: EmailReadiness['inbound']['status'];
  connectionId: string;
  account_id: string;
  zone_id: string;
  relay_worker_name: string;
  relay_version: number | null;
  operationId: string | null;
  operationStatus?: EmailOperationResponse['status'] | null;
  attemptId?: string | null;
  readiness: EmailReadiness;
  error?: string | null;
};

type EmailReadiness = {
  inbound: {
    status: 'pending' | 'ready' | 'disabled' | 'drifted';
    reason?: string | null;
    observedAt?: string | null;
  };
  outbound: {
    status: 'pending' | 'verified_only' | 'ready' | 'blocked';
    reason?: string | null;
    observedAt?: string | null;
  };
  management: {
    status: 'healthy' | 'expired' | 'revoked' | 'refresh_unknown' | 'probe_failed';
    reason?: string | null;
    observedAt?: string | null;
  };
};

export type EmailOperationResponse = {
  operationId: string;
  attemptId: string;
  status: 'pending' | 'running' | 'blocked' | 'unknown' | 'completed';
  domain: string;
  readiness: EmailReadiness;
  failedStep?: string;
  error?: string;
};

export type RemoveEmailDomainResponse = {
  operationId: string;
  operationStatus?: EmailOperationResponse['status'];
  error?: string | null;
  ok: boolean;
  removed: boolean;
};

export type DomainResponse = {
  id: string;
  project_id: string;
  hostname: string;
  cf_hostname_id: string;
  status: string;
  created_at: string;
  cname_target?: string;
  ownership_verification?: {
    type: 'txt';
    name: string;
    value: string;
  };
  ssl_validation_records?: Array<{
    txt_name?: string;
    txt_value?: string;
    status?: string;
  }>;
};

export type DomainStatusResponse = DomainResponse & {
  cname_target: string;
  ssl_status: string;
  verification_errors?: Array<string>;
  cf_status?: string;
  awaiting_deployment?: boolean;
};

export type GithubInstallation = {
  id: string;
  installation_id: string;
  account_login: string;
  account_id: string;
  account_type: 'User' | 'Organization';
  repositories: Array<{ full_name: string; id: number }>;
  repository_selection: 'all' | 'selected';
  status: 'active' | 'suspended' | 'deleted';
  created_at: string;
  updated_at: string;
};

export type GithubConnection = {
  id: string;
  project_id: string;
  installation_id: string;
  repo_full_name: string;
  branch: string;
  build_executor: 'container' | 'github_actions';
  workflow_path: string;
  created_at: string;
  updated_at: string;
};

export type ManifestOnlyDeployPayload = DeployUploadPayload;

// Decision: Only fetch rejections (TypeError, including a headers timeout) are retried; any HTTP response is
// final. All attempts send the same idempotency key, so the platform answers a replay with the
// earlier deployment's receipt or a 409.
const DEPLOY_POST_MAX_RETRIES = 3;
const DEPLOY_POST_BACKOFF_MS = [1000, 5000, 10_000];
/**
 * Every transport failure is retried, so a `TypeError` thrown by the deploy
 * POST always comes after this many attempts.
 */
export const DEPLOY_POST_ATTEMPTS: number = DEPLOY_POST_MAX_RETRIES + 1;
const DEPLOY_OBSERVATION_TIMEOUT_MS = 30_000;
const DEPLOY_OBSERVATION_DEADLINE_MS = 30 * 60_000;
const DEPLOY_OBSERVATION_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

// Decision: Heartbeats carry no `seq`. Pipeline streams can omit `status`; observation pages omit `heartbeat`
// when paging through a completed operation's events. `recoveryAt` is sent only while an execution
// lease exists.
type SequencedDeployEvent = DeployEvent & { seq?: number };
class DeploymentProtocolError extends Error {}
class DeploymentObservationTimeoutError extends Error {
  constructor(deploymentId: string) {
    super(`Timed out observing deployment ${deploymentId}. Inspect with \`bwf project status\`.`);
  }
}

function parseDeployEvent(value: unknown): SequencedDeployEvent {
  if (
    !value ||
    typeof value !== 'object' ||
    !('event' in value) ||
    typeof value.event !== 'string'
  ) {
    throw new DeploymentProtocolError('Invalid deployment event from platform.');
  }
  const event = value as SequencedDeployEvent;
  if (event.seq !== undefined && (!Number.isSafeInteger(event.seq) || event.seq < 1)) {
    throw new DeploymentProtocolError('Invalid deployment event sequence from platform.');
  }
  if (
    (event.event === 'start' && typeof event.deploymentId !== 'string') ||
    (event.event === 'heartbeat' &&
      (typeof event.step !== 'string' ||
        (event.status !== undefined &&
          !['queued', 'running', 'recovering'].includes(event.status)) ||
        (event.recoveryAt !== undefined &&
          (typeof event.recoveryAt !== 'string' ||
            !Number.isFinite(Date.parse(event.recoveryAt)))))) ||
    (event.event === 'done' &&
      (typeof event.deployment !== 'string' ||
        typeof event.url !== 'string' ||
        !Array.isArray(event.urls) ||
        !event.urls.every((url) => typeof url === 'string') ||
        !Number.isSafeInteger(event.assets) ||
        event.assets < 0 ||
        !Number.isSafeInteger(event.workers) ||
        event.workers < 0 ||
        (event.published !== undefined && typeof event.published !== 'boolean'))) ||
    (event.event === 'error' &&
      (typeof event.message !== 'string' || typeof event.step !== 'string'))
  ) {
    throw new DeploymentProtocolError('Invalid deployment result from platform.');
  }
  return event;
}

export class PlatformClient {
  private readonly baseUrl: string;
  private readonly authHeaders: Record<string, string>;
  private readonly accessHeaders: Record<string, string>;
  private readonly cliLog?: CliLogger;
  private readonly checkPlatformVersion: boolean;
  readonly apiUrl: string;

  /**
   * `checkPlatformVersion: false` skips the minimum platform version check.
   * Only login uses it, so users can still sign in to an older platform.
   */
  constructor(
    token: string,
    options?: {
      apiUrl?: string;
      root?: string;
      cliLog?: CliLogger;
      checkPlatformVersion?: boolean;
    },
  ) {
    this.baseUrl = normalizePlatformApiUrl(options?.apiUrl ?? getApiUrl(options?.root));
    this.cliLog = options?.cliLog;
    this.checkPlatformVersion = options?.checkPlatformVersion !== false;
    this.apiUrl = this.baseUrl;
    ensurePlatformAccessToken(this.baseUrl);
    this.accessHeaders = cfAccessHeaders(process.env, this.baseUrl);
    this.authHeaders = {
      Authorization: `Bearer ${token}`,
      ...(BWF_CLI_VERSION !== null && { 'X-Platform-CLI-Version': BWF_CLI_VERSION }),
    };
  }

  private async request(url: string | URL, options: RequestInit = {}): Promise<Response> {
    if (new URL(url).origin !== this.baseUrl) {
      throw new Error('Platform credentials cannot be sent to another origin.');
    }
    if (this.checkPlatformVersion) {
      await this.ensureSupportedPlatform();
    }
    return this.send(url, options);
  }

  /**
   * Checks the platform version once per process and base URL. Concurrent
   * first requests share one probe, and its outcome is kept for later requests.
   */
  private async ensureSupportedPlatform(): Promise<void> {
    assertSupportedPlatform(this.baseUrl, await this.platformProbe());
  }

  private platformProbe(): Promise<PlatformVersionProbe> {
    const cached = platformVersionProbes.get(this.baseUrl);
    if (cached) {
      return cached;
    }
    const probe = this.probePlatformVersion();
    platformVersionProbes.set(this.baseUrl, probe);
    return probe;
  }

  /**
   * Whether discovery says the platform accepts Worker modules uploaded to R2.
   * False when discovery omits the field or gave no usable answer.
   */
  async supportsDirectWorkerUpload(): Promise<boolean> {
    let probe = await this.platformProbe();
    if (probe.kind === 'unknown') {
      // Decision: One failed probe mustn't send a large Worker inline. Ask again, without replacing the outcome the
      // version check keeps.
      probe = await this.probePlatformVersion();
    }
    return probe.kind === 'version' && probe.directWorkerUpload;
  }

  /** Older servers otherwise ignore the execution mode and apply SQL anyway. */
  async requireMigrationSkipSupport(): Promise<void> {
    const response = await this.request(`${this.baseUrl}/capabilities`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok && response.status !== 404) {
      await throwPlatformApiError('Failed to check migration capabilities', response, 'deploy');
    }
    const capabilities = response.ok
      ? ((await response.json()) as { skipMigrations?: unknown })
      : null;
    if (capabilities?.skipMigrations !== true) {
      throw new Error(
        'deploy: This bwf platform does not support --skip-migrations. Ask its administrator to upgrade with `bwf platform upgrade`.',
      );
    }
  }

  /** Platforms that predate the flag ignore the setting and keep replication on. */
  async requireD1ReadReplicationSupport(): Promise<void> {
    const response = await this.request(`${this.baseUrl}/capabilities`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok && response.status !== 404) {
      await throwPlatformApiError(
        'Failed to check D1 read replication support',
        response,
        'deploy',
      );
    }
    const capabilities = response.ok
      ? ((await response.json()) as { d1ReadReplication?: unknown })
      : null;
    if (capabilities?.d1ReadReplication !== true) {
      throw new Error(
        'deploy: This bwf platform cannot apply `database.readReplication` from bwf.config.ts. Ask its administrator to upgrade with `bwf platform upgrade`.',
      );
    }
  }

  /** Reads the platform version from public discovery, without credentials. */
  private async probePlatformVersion(): Promise<PlatformVersionProbe> {
    let response: Response;
    try {
      response = await this.send(`${this.baseUrl}/.well-known/platform`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Decision: A network error or timeout says nothing about the version. The real request reports its own
      // error if the platform is unreachable.
      return { kind: 'unknown' };
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return { kind: 'missing' };
    }
    try {
      const discovery = await readPlatformDiscoveryResponse(this.baseUrl, response);
      return {
        kind: 'version',
        version: discovery.platformVersion,
        directWorkerUpload: discovery.directWorkerUpload === true,
      };
    } catch {
      return { kind: 'unknown' };
    }
  }

  private async send(url: string | URL, options: RequestInit): Promise<Response> {
    // Decision: A service-token pair is long-lived and was captured before managed deploy scrubs the parent
    // environment. User tokens can be renewed in the browser, so keep checking for a newer environment
    // value when no service pair was captured, and let current credentials override the fallback below.
    if (!this.accessHeaders['CF-Access-Client-Id']) {
      ensurePlatformAccessToken(this.baseUrl);
    }
    const send = () => {
      const currentAccessHeaders = cfAccessHeaders(process.env, this.baseUrl);
      const accessHeaders = this.accessHeaders['CF-Access-Client-Id']
        ? this.accessHeaders
        : Object.keys(currentAccessHeaders).length > 0
          ? currentAccessHeaders
          : this.accessHeaders;
      return {
        accessHeaders,
        response: fetch(url, {
          ...options,
          headers: {
            ...(options.headers as Record<string, string>),
            ...accessHeaders,
          },
          redirect: 'manual',
        }),
      };
    };

    const first = send();
    const response = await first.response;
    if (!isCloudflareAccessChallenge(response)) {
      return response;
    }

    // Decision: A service-token rejection is an operator or CI configuration error. Don't replace a scoped machine
    // credential with an interactive human session.
    if (first.accessHeaders['CF-Access-Client-Id']) {
      return response;
    }

    await response.body?.cancel();
    ensurePlatformAccessToken(this.baseUrl, true, false, first.accessHeaders['cf-access-token']);
    // Decision: One retry only, at the exact original endpoint. `redirect: 'manual'` above means credentials
    // aren't forwarded to the challenge Location.
    return send().response;
  }

  /** Sends an authenticated request and throws `PlatformApiError` unless it succeeds. */
  private async call(
    url: string | URL,
    action: string,
    options: { method?: string; body?: unknown; permission?: ProjectPermission } = {},
  ): Promise<Response> {
    const { method, body, permission } = options;
    const res = await this.request(url, {
      ...(method !== undefined && { method }),
      headers:
        body === undefined
          ? { ...this.authHeaders }
          : { 'Content-Type': 'application/json', ...this.authHeaders },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      await throwPlatformApiError(action, res, permission);
    }
    return res;
  }

  /**
   * Calls a platform procedure (`POST /rpc/<name>`). A failure throws `PlatformApiError`
   * with the procedure's error code in `error`, so callers handle it like any platform error.
   */
  private async rpc<T>(
    name: string,
    action: string,
    input?: unknown,
    { permission, signal }: { permission?: ProjectPermission; signal?: AbortSignal } = {},
  ): Promise<T> {
    const res = await this.request(`${this.baseUrl}/rpc/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-realtime-surface': 'cli',
        ...this.authHeaders,
      },
      body: input === undefined ? '' : JSON.stringify(input),
      ...(signal && { signal }),
    });
    const text = await res.text();
    if (res.ok) {
      return (JSON.parse(text) as { data: T }).data;
    }
    let body = text;
    try {
      const { error } = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (error?.code) {
        body = JSON.stringify({ error: error.code.toLowerCase(), message: error.message });
      }
    } catch {
      // Decision: Not an RPC error body (an Access login page, for example): report it as received.
    }
    throw new PlatformApiError(
      action,
      res.status,
      body,
      isCloudflareAccessChallenge(res) ? undefined : permission,
    );
  }

  private async json<T>(
    url: string | URL,
    action: string,
    options?: { method?: string; body?: unknown; permission?: ProjectPermission },
  ): Promise<T> {
    return (await this.call(url, action, options)).json() as Promise<T>;
  }

  async startIdentityLink(
    connectionId: string,
  ): Promise<{ id: string; url: string; expiresAt: string }> {
    const result = await this.json<{ id: string; url: string; expiresAt: string }>(
      `${this.baseUrl}/auth/link`,
      'Failed to link login method',
      { method: 'POST', body: { connectionId } },
    );
    const url = new URL(result.url);
    if (
      url.origin !== this.baseUrl ||
      url.pathname !== '/auth/link' ||
      url.username ||
      url.password
    ) {
      throw new Error('auth: Invalid account-link URL from platform.');
    }
    return result;
  }

  async whoami(): Promise<{ id: string; login: string; plan: string }> {
    return this.rpc('me.get', 'Failed to fetch user info');
  }

  async listProjects(): Promise<Array<ProjectResponse>> {
    return this.rpc('projects.list', 'Failed to list projects');
  }

  /** A lightweight project list for interactive linking. */
  async listProjectChoices(): Promise<Array<ProjectResponse>> {
    return this.rpc('projects.choices', 'Failed to list project choices');
  }

  /** Resolve one known project without loading account-wide deployment and traffic summaries. */
  async getProject(projectId: string): Promise<ProjectResponse | null> {
    try {
      return await this.rpc('projects.get', 'Failed to get project', { projectId });
    } catch (error) {
      // Decision: A project the caller can't read is, to them, a project that doesn't exist.
      if (error instanceof PlatformApiError && error.status === 403) {
        return null;
      }
      throw error;
    }
  }

  /** Resolve a slug through the current platform contract. */
  async findProjectBySlug(slug: string): Promise<ProjectResponse | null> {
    const body = await this.rpc<{ project: ProjectResponse | null }>(
      'projects.resolve',
      'Failed to resolve project',
      { slug },
    );
    return body.project;
  }

  async listProjectTokens(projectId: string): Promise<Array<ProjectDeployCredentialResponse>> {
    return this.rpc(
      'tokens.list',
      'Failed to list project tokens',
      { projectId },
      { permission: 'owner' },
    );
  }

  async getProjectZeroTrust(projectId: string): Promise<ProjectZeroTrustResponse> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/zero-trust`,
      'Failed to inspect project Zero Trust',
      { permission: 'read' },
    );
  }

  async setProjectZeroTrust(
    projectId: string,
    protectedProject: boolean,
  ): Promise<ProjectZeroTrustUpdateResponse> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/zero-trust`,
      'Failed to update project Zero Trust',
      { method: 'PUT', body: { protected: protectedProject }, permission: 'settings' },
    );
  }

  async reconcileProjectZeroTrust(projectId: string): Promise<ProjectZeroTrustUpdateResponse> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/zero-trust/reconcile`,
      'Failed to reconcile project Zero Trust',
      { method: 'POST', permission: 'settings' },
    );
  }

  async createProjectToken(
    projectId: string,
    input: { name?: string; expiresInDays?: number },
  ): Promise<IssuedProjectDeployCredentialResponse> {
    return this.rpc(
      'tokens.create',
      'Failed to create project token',
      { projectId, ...input },
      { permission: 'owner' },
    );
  }

  async listProjectMembers(projectId: string): Promise<ProjectMemberListResponse> {
    const body = await this.rpc<ProjectMemberListResponse>(
      'team.members',
      'Failed to list project members',
      { projectId },
      { permission: 'read' },
    );
    return { members: body.members, ...(!!body.warnings && { warnings: body.warnings }) };
  }

  async listProjectInvitations(projectId: string): Promise<Array<ProjectInvitationResponse>> {
    const body = await this.rpc<{ invitations: Array<ProjectInvitationResponse> }>(
      'team.invitations',
      'Failed to list project invitations',
      { projectId },
      { permission: 'members' },
    );
    return body.invitations;
  }

  async inviteProjectMember(
    projectId: string,
    email: string,
    role: Exclude<ProjectRole, 'owner'>,
  ): Promise<{
    invitation: ProjectInvitationResponse;
    refreshed: boolean;
    delivery: ProjectInvitationDelivery;
  }> {
    return this.rpc(
      'team.invite',
      'Failed to invite project member',
      { projectId, email, role },
      { permission: 'members' },
    );
  }

  async renewProjectToken(
    projectId: string,
    credentialId: string,
    expiresInDays?: number,
  ): Promise<IssuedProjectDeployCredentialResponse> {
    return this.rpc(
      'tokens.renew',
      'Failed to renew project token',
      { projectId, credentialId, ...(!!expiresInDays && { expiresInDays }) },
      { permission: 'owner' },
    );
  }

  async updateProjectMemberRole(
    projectId: string,
    userId: string,
    role: Exclude<ProjectRole, 'owner'>,
  ): Promise<{ member: ProjectMemberResponse }> {
    return this.rpc(
      'team.setRole',
      'Failed to change project member role',
      { projectId, userId, role },
      { permission: 'members' },
    );
  }

  async revokeProjectToken(projectId: string, credentialId: string): Promise<{ ok: boolean }> {
    return this.rpc(
      'tokens.revoke',
      'Failed to revoke project token',
      { projectId, credentialId },
      { permission: 'owner' },
    );
  }

  async removeProjectMember(projectId: string, userId: string): Promise<void> {
    await this.rpc(
      'team.remove',
      'Failed to remove project member',
      { projectId, userId },
      { permission: 'members' },
    );
  }

  async revokeProjectInvitation(projectId: string, invitationId: string): Promise<void> {
    await this.rpc(
      'team.revokeInvitation',
      'Failed to revoke project invitation',
      { projectId, invitationId },
      { permission: 'members' },
    );
  }

  async leaveProject(projectId: string): Promise<void> {
    await this.rpc('team.leave', 'Failed to leave project', { projectId });
  }

  async listPendingProjectInvitations(): Promise<Array<ProjectInvitationResponse>> {
    const body = await this.rpc<{ invitations: Array<ProjectInvitationResponse> }>(
      'team.myInvitations',
      'Failed to list pending project invitations',
    );
    return body.invitations;
  }

  async respondToProjectInvitation(
    invitationId: string,
    action: 'accept' | 'decline',
  ): Promise<void> {
    await this.rpc('team.respond', `Failed to ${action} project invitation`, {
      invitationId,
      response: action,
    });
  }

  async listDeployments(projectId: string): Promise<DeploymentListResponse> {
    return this.rpc(
      'deployments.list',
      'Failed to list deployments',
      { projectId },
      {
        permission: 'read',
      },
    );
  }

  async rollback(
    projectId: string,
    deploymentId: string,
    options?: { allowDestructive?: Array<string> },
  ): Promise<{
    ok: boolean;
    deploymentId?: string;
    migrationDiff?: Array<string>;
    error?: string;
  }> {
    const body: { deploymentId: string; allowDestructive?: Array<string> } = {
      deploymentId,
    };
    if (options?.allowDestructive && options.allowDestructive.length > 0) {
      body.allowDestructive = options.allowDestructive;
    }
    return this.json(`${this.baseUrl}/projects/${projectId}/rollback`, 'Rollback failed', {
      method: 'POST',
      body,
      permission: 'deploy',
    });
  }

  async cancelDeployment(
    projectId: string,
    deploymentId: string,
  ): Promise<{ ok: boolean; deploymentId: string; status: string }> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/deployments/${deploymentId}/cancel`,
      'Cancel deployment failed',
      { method: 'POST', permission: 'deploy' },
    );
  }

  async createProject(slug: string): Promise<CreateProjectResponse> {
    return this.rpc('projects.create', 'Failed to create project', { slug });
  }

  async preflight(
    projectId: string,
    assetManifest: Record<string, { hash: string; size: number }>,
    hasWorker?: boolean,
  ): Promise<{ needed: Array<string>; total: number; skipped: number }> {
    const total = Object.keys(assetManifest).length;
    try {
      return await this.rpc(
        'deploy.preflight',
        'Preflight failed',
        { projectId, assetManifest, ...(hasWorker && { hasWorker }) },
        { permission: 'deploy' },
      );
    } catch (error) {
      if (isPreflightRejection(error)) {
        throw error;
      }
      // Decision: On a network error, fall back to uploading everything.
      return { needed: Object.keys(assetManifest), total, skipped: 0 };
    }
  }

  async requestUploadUrls(
    projectId: string,
    assets: Array<DeployAssetUploadRequest>,
  ): Promise<Record<string, { url: string; headers: Record<string, string> }>> {
    this.cliLog?.info('upload_urls_post', { assetCount: assets.length });
    const { urls } = await this.rpc<{
      urls: Record<string, { url: string; headers: Record<string, string> }>;
    }>(
      'deploy.uploadUrls',
      'Failed to request upload URLs',
      { projectId, assets },
      {
        permission: 'deploy',
      },
    );
    return urls;
  }

  /**
   * Requests one presigned R2 PUT per Worker module, in `modules` order. The
   * platform refuses a Worker over Cloudflare's size limit here (413
   * `worker_too_large`), before any bytes are uploaded.
   */
  async requestWorkerUploadUrls(
    projectId: string,
    modules: Array<DeployWorkerModule>,
  ): Promise<DeployWorkerUploadResponse> {
    this.cliLog?.info('worker_upload_urls_post', { moduleCount: modules.length });
    const json = await this.rpc<Partial<DeployWorkerUploadResponse> | null>(
      'deploy.workerUploadUrls',
      'Failed to request worker upload URLs',
      { projectId, modules },
      { permission: 'deploy' },
    );

    // Decision: Module i uploads to urls[i], so a short or malformed list mustn't start.
    if (
      typeof json?.id !== 'string' ||
      !json.id ||
      !Array.isArray(json.urls) ||
      json.urls.length !== modules.length ||
      !json.urls.every(
        (entry) =>
          typeof entry?.url === 'string' && typeof entry.headers === 'object' && !!entry.headers,
      )
    ) {
      throw new Error('Invalid worker upload URLs from platform.');
    }
    return { id: json.id, urls: json.urls };
  }

  async *finalizeDeploy(
    projectId: string,
    payload: ManifestOnlyDeployPayload,
  ): AsyncGenerator<DeployEvent> {
    const cliLog = this.cliLog;
    // Decision: One key for all attempts: a retry after a lost response returns the same deployment.
    const idempotencyKey = crypto.randomUUID();
    cliLog?.info('deploy_post', { projectId });

    let deploymentId: string | undefined;
    let inline: Array<unknown> | undefined;
    let attempt = 0;
    while (true) {
      try {
        ({ deploymentId, events: inline } = await this.rpc<{
          deploymentId?: string;
          events?: Array<unknown>;
        }>(
          'deploy.finalize',
          'Deploy failed',
          { projectId, body: payload, idempotencyKey },
          { permission: 'deploy' },
        ));
        break;
      } catch (error) {
        if (error instanceof PlatformApiError) {
          const parsed = error.status === 409 ? parsePlatformErrorBody(error.body) : null;
          const inFlight = /deployment ([A-Za-z0-9_-]{1,128})$/.exec(parsed?.message ?? '')?.[1];
          if (parsed?.error === 'deploy_in_progress' && inFlight) {
            // Decision: A deployment is in flight: possibly an earlier attempt of this deploy.
            cliLog?.warn('deploy_conflict', { projectId, deploymentId: inFlight });
            yield {
              event: 'error',
              step: 'finalize',
              message:
                `${parsed.message} — it may be an earlier attempt of this deploy or a concurrent one; ` +
                'inspect with `bwf project status` before redeploying',
            };
            return;
          }
          throw error;
        }
        if (!(error instanceof TypeError) || attempt >= DEPLOY_POST_MAX_RETRIES) {
          cliLog?.error('deploy_fetch_rejected', error, { projectId, attempts: attempt + 1 });
          throw error;
        }
        cliLog?.warn('deploy_fetch_retry', {
          projectId,
          attempt: attempt + 1,
          delayMs: DEPLOY_POST_BACKOFF_MS[attempt],
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(DEPLOY_POST_BACKOFF_MS[attempt]);
        attempt++;
      }
    }

    if (deploymentId === undefined) {
      // Decision: An inline deploy refused before it had an ID: its events end in the reason.
      const failure = (inline ?? []).map(parseDeployEvent).find((event) => event.event === 'error');
      if (failure) {
        yield failure;
        return;
      }
      throw new Error('Platform returned no deployment receipt.');
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(deploymentId)) {
      throw new Error('Invalid deployment receipt from platform.');
    }
    // Decision: The platform owns execution independently of this observer.
    yield { event: 'start', deploymentId };
    let cursor = 0;
    // Decision: Without the Queue the platform ran the deploy inside the request and sent its events back.
    for (const raw of inline ?? []) {
      const event = parseDeployEvent(raw);
      if (event.seq !== undefined) {
        if (event.seq <= cursor) {
          continue;
        }
        cursor = event.seq;
      }
      if (event.event === 'start') {
        continue;
      }
      yield event;
      if (event.event === 'done' || event.event === 'error') {
        return;
      }
    }
    yield* this.followDeploymentEvents(
      projectId,
      deploymentId,
      cursor,
      Date.now() + DEPLOY_OBSERVATION_DEADLINE_MS,
    );
  }

  private async *followDeploymentEvents(
    projectId: string,
    deploymentId: string,
    since: number,
    deadline: number,
  ): AsyncGenerator<DeployEvent> {
    let cursor = since;
    let failures = 0;
    while (Date.now() < deadline) {
      let page: {
        deploymentId: string;
        events: Array<{ seq: number; event: unknown }>;
        lastSeq: number;
        terminal: boolean;
        heartbeat?: unknown;
      };
      try {
        page = await this.rpc<typeof page>(
          'deployments.events',
          'Failed to observe deployment',
          { projectId, deploymentId, since: cursor },
          {
            permission: 'read',
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(DEPLOY_OBSERVATION_TIMEOUT_MS, deadline - Date.now())),
            ),
          },
        );
        if (Date.now() >= deadline) {
          throw new DeploymentObservationTimeoutError(deploymentId);
        }
      } catch (error) {
        const transient =
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === 'TimeoutError') ||
          (error instanceof PlatformApiError && (error.status === 429 || error.status >= 500));
        if (!transient || failures >= DEPLOY_OBSERVATION_BACKOFF_MS.length) {
          throw error;
        }
        const delayMs = DEPLOY_OBSERVATION_BACKOFF_MS[failures++];
        this.cliLog?.warn('deploy_observation_retry', { deploymentId, cursor, delayMs });
        await sleep(Math.min(delayMs, Math.max(0, deadline - Date.now())));
        continue;
      }
      failures = 0;
      if (
        !page ||
        page.deploymentId !== deploymentId ||
        !Array.isArray(page.events) ||
        page.events.length > 1000 ||
        !Number.isSafeInteger(page.lastSeq) ||
        page.lastSeq < cursor ||
        typeof page.terminal !== 'boolean'
      ) {
        throw new Error('Invalid deployment observation response from platform.');
      }
      let previousSeq = 0;
      for (const row of page.events) {
        if (
          !row ||
          !Number.isSafeInteger(row.seq) ||
          row.seq <= previousSeq ||
          row.seq > page.lastSeq
        ) {
          throw new Error('Invalid deployment observation sequence from platform.');
        }
        previousSeq = row.seq;
        const event = parseDeployEvent(row.event);
        if (row.seq <= cursor) {
          continue;
        }
        cursor = row.seq;
        if (event.event !== 'start') {
          yield event;
        }
        if (event.event === 'done' || event.event === 'error') {
          return;
        }
      }
      // Decision: Don't skip a missing event just because the server advertises a later high-water mark. Only
      // consumed events advance the cursor.
      if (page.terminal) {
        throw new Error('Platform finished deployment without a terminal result.');
      }
      if (page.heartbeat !== undefined) {
        const heartbeat = parseDeployEvent(page.heartbeat);
        if (
          heartbeat.event !== 'heartbeat' ||
          (heartbeat.deploymentId !== undefined && heartbeat.deploymentId !== deploymentId)
        ) {
          throw new DeploymentProtocolError('Invalid deployment observation heartbeat.');
        }
        yield heartbeat;
      }
      await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
    }
    throw new DeploymentObservationTimeoutError(deploymentId);
  }

  async listSecrets(projectId: string): Promise<Array<{ name: string }>> {
    return this.rpc(
      'secrets.list',
      'Failed to list secrets',
      { projectId },
      { permission: 'configure' },
    );
  }

  async setSecret(projectId: string, name: string, value: string): Promise<SecretResponse> {
    return this.rpc(
      'secrets.set',
      'Failed to set secret',
      { projectId, name, value },
      { permission: 'configure' },
    );
  }

  async deleteProject(projectId: string): Promise<DeleteProjectResponse> {
    return this.json(`${this.baseUrl}/projects/${projectId}`, 'Failed to delete project', {
      method: 'DELETE',
      permission: 'owner',
    });
  }

  async getMigrationStatus(
    projectId: string,
    dialect?: 'sqlite' | 'postgresql' | 'mysql',
  ): Promise<{ applied: Array<{ name: string; applied_at: string }> }> {
    const url = new URL(`${this.baseUrl}/projects/${projectId}/migrations`);
    if (dialect) {
      url.searchParams.set('dialect', dialect);
    }
    return this.json(url, 'Failed to get migration status', { permission: 'read' });
  }

  async applyRemoteMigrations(
    projectId: string,
    migrations: Array<{ name: string; sql: string }>,
  ): Promise<{
    ok: boolean;
    applied: Array<string>;
    skipped: Array<string>;
    error?: string;
  }> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/migrations/apply`,
      'Failed to apply remote migrations',
      { method: 'POST', body: { migrations }, permission: 'configure' },
    );
  }

  async renameMigrations(
    projectId: string,
    renames: Array<{ from: string; to: string }>,
  ): Promise<{ ok: boolean }> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/migrations/rename`,
      'Failed to rename remote migrations',
      { method: 'POST', body: { renames }, permission: 'configure' },
    );
  }

  async addDomain(projectId: string, hostname: string): Promise<DomainResponse> {
    return this.rpc(
      'domains.add',
      'Failed to add domain',
      { projectId, hostname },
      { permission: 'settings' },
    );
  }

  async listDomains(projectId: string): Promise<Array<DomainResponse>> {
    return this.rpc(
      'domains.list',
      'Failed to list domains',
      { projectId },
      { permission: 'read' },
    );
  }

  async getDomainStatus(projectId: string, domainId: string): Promise<DomainStatusResponse> {
    return this.rpc(
      'domains.status',
      'Failed to get domain status',
      { projectId, domainId },
      { permission: 'read' },
    );
  }

  async removeDomain(projectId: string, domainId: string): Promise<{ ok: boolean }> {
    return this.rpc(
      'domains.remove',
      'Failed to remove domain',
      { projectId, domainId },
      { permission: 'settings' },
    );
  }

  async deleteSecret(projectId: string, name: string): Promise<SecretResponse> {
    return this.rpc(
      'secrets.delete',
      'Failed to delete secret',
      { projectId, name },
      { permission: 'configure' },
    );
  }

  async getResources(projectId: string): Promise<Array<{ type: string; binding_name: string }>> {
    return this.rpc(
      'projects.resources',
      'Failed to get resources',
      { projectId },
      { permission: 'read' },
    );
  }

  async provisionDatabase(projectId: string, connectionString: string): Promise<{ ok: boolean }> {
    return this.rpc(
      'database.provision',
      'Failed to provision database',
      { projectId, connectionString },
      { permission: 'configure' },
    );
  }

  async setDatabaseUrl(projectId: string, connectionString: string): Promise<{ ok: boolean }> {
    return this.rpc(
      'database.setUrl',
      'Failed to update database URL',
      { projectId, connectionString },
      { permission: 'configure' },
    );
  }

  async getDatabaseUrl(projectId: string): Promise<{ url: string }> {
    return this.rpc(
      'database.getUrl',
      'Failed to fetch database URL',
      { projectId },
      { permission: 'owner' },
    );
  }

  async getLogs(
    projectId: string,
    since: string,
    limit = 200,
    deploymentId?: string,
    level?: string,
  ): Promise<LogsResult> {
    const params = new URLSearchParams({
      since,
      limit: String(limit),
    });
    if (deploymentId) {
      params.set('deploymentId', deploymentId);
    }
    if (level && level !== 'all') {
      params.set('level', level);
    }
    const json = await this.json<{ data: Array<LogEntry>; runtimeLogs?: unknown }>(
      `${this.baseUrl}/projects/${projectId}/logs?${params}`,
      'Failed to fetch logs',
      { permission: 'read' },
    );
    return {
      entries: json.data,
      ...(json.runtimeLogs === 'minimal' && { runtimeLogs: 'minimal' as const }),
    };
  }

  async getRequests(
    projectId: string,
    since: string,
    limit = 200,
    status?: string,
  ): Promise<Array<RequestEntry>> {
    const params = new URLSearchParams({
      since,
      limit: String(limit),
    });
    if (status && status !== 'all') {
      params.set('status', status);
    }
    const json = await this.json<{ data: Array<RequestEntry> }>(
      `${this.baseUrl}/projects/${projectId}/requests?${params}`,
      'Failed to fetch requests',
      { permission: 'read' },
    );
    return json.data;
  }

  async listBuilds(projectId: string, limit = 20): Promise<Array<BuildSummary>> {
    const params = new URLSearchParams({ limit: String(limit) });
    const json = await this.json<{ builds: Array<BuildSummary> }>(
      `${this.baseUrl}/projects/${projectId}/builds?${params}`,
      'Failed to list builds',
      { permission: 'read' },
    );
    return json.builds;
  }

  async getBuildLogs(projectId: string, buildId: string, since = 0): Promise<BuildLogsResponse> {
    const params = new URLSearchParams({ since: String(since) });
    return this.json(
      `${this.baseUrl}/projects/${projectId}/builds/${buildId}/logs?${params}`,
      'Failed to fetch build logs',
      { permission: 'read' },
    );
  }

  async getGithubInstallUrl(): Promise<{ url: string }> {
    return this.json(`${this.baseUrl}/github/install-url`, 'Failed to get GitHub install URL');
  }

  async listGithubInstallations(): Promise<Array<GithubInstallation>> {
    return this.json(`${this.baseUrl}/github/installations`, 'Failed to list GitHub installations');
  }

  async connectGithub(
    projectId: string,
    body: {
      installationId: string;
      repoFullName: string;
      branch?: string;
      buildExecutor?: 'container' | 'github_actions';
      workflowPath?: string;
      connectGrant?: string;
      codeVerifier?: string;
    },
  ): Promise<GithubConnection> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/github`,
      'Failed to connect GitHub repository',
      { method: 'POST', body, permission: 'settings' },
    );
  }

  /**
   * Start the per-repo connect authorization for a non-owner org member. The
   * callback carries `?connect_grant=<signed>` or `?error=repo_not_accessible`.
   */
  async getGithubConnectAuthorizeUrl(
    redirect: string,
    codeChallenge: string,
    installationId: string,
    repoFullName: string,
  ): Promise<{ url: string }> {
    const params = new URLSearchParams({
      redirect,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      installationId,
      repoFullName,
    });
    return this.json(
      `${this.baseUrl}/github/connect-authorize-url?${params}`,
      'Failed to start GitHub connect authorization',
    );
  }

  async getGithubConnection(projectId: string): Promise<GithubConnection> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/github`,
      'Failed to get GitHub connection',
      { permission: 'read' },
    );
  }

  async updateGithubConnection(
    projectId: string,
    body: {
      branch?: string;
      buildExecutor?: 'container' | 'github_actions';
      workflowPath?: string;
    },
  ): Promise<GithubConnection> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/github`,
      'Failed to update GitHub connection',
      { method: 'PATCH', body, permission: 'settings' },
    );
  }

  async deleteGithubConnection(projectId: string): Promise<{ ok: boolean }> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/github`,
      'Failed to disconnect GitHub repository',
      { method: 'DELETE', permission: 'settings' },
    );
  }

  async getGithubLinkUrl(redirect: string, codeChallenge: string): Promise<{ url: string }> {
    const params = new URLSearchParams({
      redirect,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return this.json(`${this.baseUrl}/github/link-url?${params}`, 'Failed to start GitHub link');
  }

  async completeGithubLink(
    linkCode: string,
    codeVerifier: string,
  ): Promise<{ status: 'linked' | 'already_linked' }> {
    return this.json(`${this.baseUrl}/github/link/complete`, 'Failed to complete GitHub link', {
      method: 'POST',
      body: { link_code: linkCode, code_verifier: codeVerifier },
    });
  }

  async getGithubJoinUrl(redirect: string, codeChallenge: string): Promise<{ url: string }> {
    const params = new URLSearchParams({
      redirect,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return this.json(`${this.baseUrl}/github/join-url?${params}`, 'Failed to start GitHub join');
  }

  async completeGithubJoin(
    joinCode: string,
    codeVerifier: string,
  ): Promise<{ status: 'joined'; count: number }> {
    return this.json(`${this.baseUrl}/github/join/complete`, 'Failed to complete GitHub join', {
      method: 'POST',
      body: { join_code: joinCode, code_verifier: codeVerifier },
    });
  }

  async getEmailUsage(projectId: string): Promise<EmailUsageResponse> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/email/usage`,
      'Failed to fetch email usage',
      { permission: 'read' },
    );
  }

  async getEmailLogs(projectId: string, limit?: number): Promise<EmailLogsResponse> {
    const url = new URL(`${this.baseUrl}/projects/${projectId}/email/logs`);
    if (limit !== undefined) {
      url.searchParams.set('limit', String(limit));
    }
    return this.json(url, 'Failed to fetch email logs', { permission: 'read' });
  }

  async getEmailOperation(projectId: string, operationId: string): Promise<EmailOperationResponse> {
    return this.json(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/email/operations/${encodeURIComponent(operationId)}`,
      'Failed to fetch email operation',
      { permission: 'read' },
    );
  }

  async listEmailDestinations(projectId: string): Promise<Array<EmailDestinationResponse>> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/email/destinations`,
      'Failed to list email destinations',
      { permission: 'read' },
    );
  }

  async addEmailDestination(
    projectId: string,
    address: string,
  ): Promise<EmailDestinationResponse & { created: boolean }> {
    const res = await this.call(
      `${this.baseUrl}/projects/${projectId}/email/destinations`,
      'Failed to add email destination',
      { method: 'POST', body: { address }, permission: 'settings' },
    );
    // Decision: 201 means the address was registered now; 200 means it was already listed. Whether a link went
    // out is the body's `verificationSent`, not the status.
    const body = (await res.json()) as EmailDestinationResponse;
    return { ...body, created: res.status === 201 };
  }

  async removeEmailDestination(projectId: string, destinationId: string): Promise<{ ok: boolean }> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/email/destinations/${destinationId}`,
      'Failed to remove email destination',
      { method: 'DELETE', permission: 'settings' },
    );
  }

  /** Installation email settings the CLI reads before starting a credential flow. */
  async getEmailSettings(projectId: string): Promise<EmailSettingsResponse> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/email/settings`,
      'Failed to read email settings',
      { permission: 'read' },
    );
  }

  async setEmailAlias(projectId: string, alias: string): Promise<EmailAliasResponse> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/email/alias`,
      'Failed to set the email alias',
      { method: 'PUT', body: { alias }, permission: 'settings' },
    );
  }

  async listEmailDomains(projectId: string): Promise<Array<EmailDomainResponse>> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/email/domains`,
      'Failed to list email domains',
      { permission: 'read' },
    );
  }

  /** Submit a scoped token once; later operations address the domain without it. */
  async addEmailDomain(
    projectId: string,
    input: { domain: string; apiToken?: string; attemptId?: string },
  ): Promise<EmailDomainResponse> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/email/domains`,
      'Failed to add email domain',
      {
        method: 'POST',
        body: {
          domain: input.domain,
          ...(input.apiToken !== undefined && { apiToken: input.apiToken }),
          ...(input.attemptId !== undefined && { attemptId: input.attemptId }),
        },
        permission: 'settings',
      },
    );
  }

  async getEmailDomain(projectId: string, domain: string): Promise<EmailDomainResponse> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/email/domains/${encodeURIComponent(domain)}`,
      'Failed to fetch email domain status',
      { permission: 'read' },
    );
  }

  async rotateEmailDomainSecret(
    projectId: string,
    domain: string,
    attemptId: string,
  ): Promise<EmailDomainResponse> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/email/domains/${encodeURIComponent(domain)}/rotate-secret`,
      'Failed to rotate email connection secret',
      { method: 'POST', body: { attemptId }, permission: 'settings' },
    );
  }

  async syncEmailDomain(projectId: string, domain: string): Promise<EmailDomainResponse> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/email/domains/${encodeURIComponent(domain)}/sync`,
      'Failed to sync email domain',
      { method: 'POST', permission: 'settings' },
    );
  }

  async removeEmailDomain(projectId: string, domain: string): Promise<RemoveEmailDomainResponse> {
    return this.json(
      `${this.baseUrl}/projects/${projectId}/email/domains/${encodeURIComponent(domain)}`,
      'Failed to remove email domain',
      { method: 'DELETE', permission: 'settings' },
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
