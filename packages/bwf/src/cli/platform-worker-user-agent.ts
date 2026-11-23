import { isRecord } from '@builtbyfriends/deploy-core';
import { parsePlatformResourceOwnershipMarker } from '@builtbyfriends/platform';

/** Attribute infrastructure uploads using the installer's existing ownership proof. */
export function platformWorkerUploadAttribution(
  config: Readonly<{ account_id?: unknown; name?: unknown; vars?: unknown }>,
): string | undefined {
  const vars = config.vars;
  if (!isRecord(vars) || typeof vars.PLATFORM_OWNERSHIP_MARKER !== 'string') {
    return undefined;
  }
  try {
    const marker = parsePlatformResourceOwnershipMarker(JSON.parse(vars.PLATFORM_OWNERSHIP_MARKER));
    if (
      marker.resourceKind !== 'worker' ||
      marker.accountId !== config.account_id ||
      marker.resourceName !== config.name ||
      ![
        'api-worker',
        'proxy-worker',
        'dispatch-worker',
        'tail-worker',
        'email-gateway-worker',
      ].includes(marker.resourceKey)
    ) {
      return undefined;
    }
    const version = typeof vars.PLATFORM_VERSION === 'string' ? vars.PLATFORM_VERSION : 'unknown';
    // Decision: Keep each field one token. Never include the ownership nonce in request headers.
    return `platform-install/${encodeURIComponent(version)} platform-role/${marker.resourceKey} platform-installation/${encodeURIComponent(marker.installationId)}`;
  } catch {
    // Decision: Attribution cannot make an otherwise valid upload fail.
    return undefined;
  }
}
