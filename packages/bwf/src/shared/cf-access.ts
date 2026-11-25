/**
 * Resolve Cloudflare Access headers from an env-like object.
 *
 * Priority:
 *   1. Service token pair (`CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET`) — CI path
 *   2. User JWT (`CF_ACCESS_TOKEN`) — dev path, typically populated via `cloudflared access token`
 *   3. No headers — prod, or unprotected hostnames
 */
type AccessEnv = {
  CF_ACCESS_CLIENT_ID?: unknown;
  CF_ACCESS_CLIENT_SECRET?: unknown;
  CF_ACCESS_TOKEN?: unknown;
  PLATFORM_ACCESS_CREDENTIALS?: unknown;
  __PLATFORM_ACCESS_CREDENTIALS?: unknown;
  PLATFORM_ACCESS_ORIGIN?: unknown;
};

type AccessHeaders =
  | { 'CF-Access-Client-Id': string; 'CF-Access-Client-Secret': string }
  | { 'cf-access-token': string }
  | Record<string, never>;

function isAccessEnv(value: unknown): value is AccessEnv {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function accessHeaders(env: AccessEnv): AccessHeaders {
  const id = env.CF_ACCESS_CLIENT_ID;
  const secret = env.CF_ACCESS_CLIENT_SECRET;
  if (typeof id === 'string' && typeof secret === 'string' && id.length > 0 && secret.length > 0) {
    return {
      'CF-Access-Client-Id': id,
      'CF-Access-Client-Secret': secret,
    };
  }
  const token = env.CF_ACCESS_TOKEN;
  if (typeof token === 'string' && token.length > 0) {
    return { 'cf-access-token': token };
  }
  return {};
}

/** Attach Access credentials only to their explicitly scoped origin. */
export function cfAccessHeaders(env: AccessEnv, targetUrl: string): Record<string, string> {
  let origin: string;
  try {
    const target = new URL(targetUrl);
    if (target.protocol !== 'https:' || target.username || target.password) {
      return {};
    }
    origin = target.origin;
  } catch {
    return {};
  }
  const encoded = env.PLATFORM_ACCESS_CREDENTIALS ?? env.__PLATFORM_ACCESS_CREDENTIALS;
  if (typeof encoded === 'string' && encoded) {
    try {
      const records: unknown = JSON.parse(encoded);
      if (!isAccessEnv(records)) {
        return {};
      }
      if (Object.hasOwn(records, origin)) {
        const entry: unknown = Object.getOwnPropertyDescriptor(records, origin)?.value;
        return isAccessEnv(entry) ? accessHeaders(entry) : {};
      }
    } catch {
      // Decision: Invalid explicit configuration never falls back to credentials for another recipient.
      return {};
    }
  }
  if (typeof env.PLATFORM_ACCESS_ORIGIN === 'string' && env.PLATFORM_ACCESS_ORIGIN) {
    try {
      const selected = new URL(env.PLATFORM_ACCESS_ORIGIN);
      return selected.protocol === 'https:' &&
        !selected.username &&
        !selected.password &&
        selected.pathname === '/' &&
        !selected.search &&
        !selected.hash &&
        selected.origin === origin
        ? accessHeaders(env)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Capture credentials for a Cloudflare Worker readiness request whose target
 * is resolved and constrained by the direct-deploy adapter rather than a
 * user-connected bwf platform URL.
 */
export function trustedCloudflareWorkerAccessHeaders(env: AccessEnv): Record<string, string> {
  return accessHeaders(env);
}

/** Keep only this recipient's credentials when crossing into a local Worker runtime. */
export function scopedAccessCredentials(env: AccessEnv, targetUrl: string): string | undefined {
  const headers = cfAccessHeaders(env, targetUrl);
  if (Object.keys(headers).length === 0) {
    return undefined;
  }
  return JSON.stringify({
    [new URL(targetUrl).origin]: headers['CF-Access-Client-Id']
      ? {
          CF_ACCESS_CLIENT_ID: headers['CF-Access-Client-Id'],
          CF_ACCESS_CLIENT_SECRET: headers['CF-Access-Client-Secret'],
        }
      : { CF_ACCESS_TOKEN: headers['cf-access-token'] },
  });
}
