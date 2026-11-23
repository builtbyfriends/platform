import type { ApiEnv } from './env.ts';

type PlatformIdentityEnv = Pick<
  ApiEnv['Bindings'],
  'AUTH_REDIRECT_URI' | 'PLATFORM_DISPLAY_NAME' | 'PLATFORM_INSTALLATION_ID' | 'PLATFORM_ENV'
>;

export function getPlatformDisplayName(
  env: PlatformIdentityEnv | undefined,
  _requestUrl?: string,
): string {
  return env?.PLATFORM_DISPLAY_NAME?.trim() || 'Platform';
}

export function formatPlatformPageTitle(page: string, platformName: string): string {
  return `${page} · ${platformName}${/\bplatform\b/i.test(platformName) ? '' : ' · Platform'}`;
}

/** Use configured deployment identity or the actual request URL, never forwarded headers. */
export function getPlatformApiUrl(env: PlatformIdentityEnv, requestUrl?: string): string {
  const configuredUrl = env.AUTH_REDIRECT_URI || requestUrl;
  if (!configuredUrl && env.PLATFORM_INSTALLATION_ID) {
    throw new Error(
      'Set AUTH_REDIRECT_URI to the platform API OAuth callback URL before sending email.',
    );
  }
  const url = new URL(
    configuredUrl ||
      (env.PLATFORM_ENV === 'staging'
        ? 'https://api.staging.void.cloud'
        : 'https://platform.buildwithfriends.dev'),
  );
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('The platform API URL must be an HTTP(S) URL without credentials.');
  }
  return url.origin;
}

export function platformConnectCommand(apiUrl: string): string {
  const url = new URL(apiUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // Decision: Keep an explicit protocol when it differs from the CLI's hostname default.
  const address = url.protocol === (local ? 'http:' : 'https:') ? url.host : url.origin;
  // Decision: Quote even unusual but valid URL hostnames so the command is safe to paste into a shell.
  return `bwf connect '${address.replaceAll("'", String.raw`'\''`)}'`;
}
