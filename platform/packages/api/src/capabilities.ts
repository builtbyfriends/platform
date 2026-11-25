import { isRecord } from '@builtbyfriends/deploy-core';
import type { PlatformCapabilities } from '@builtbyfriends/platform';
import type { MiddlewareHandler } from 'hono';
import type { ApiEnv } from './env.ts';

const HOSTED_CAPABILITIES: PlatformCapabilities = {
  ai: true,
  customDomains: true,
  email: true,
  githubActions: true,
  githubOAuth: true,
  googleOAuth: true,
  managedBuilds: true,
  sandbox: true,
  vectorize: false,
};

const CAPABILITY_NAMES = [
  'ai',
  'customDomains',
  'email',
  'githubActions',
  'githubOAuth',
  'googleOAuth',
  'managedBuilds',
  'sandbox',
  'vectorize',
] as const satisfies ReadonlyArray<keyof PlatformCapabilities>;

export function getPlatformCapabilities(
  env: Pick<ApiEnv['Bindings'], 'PLATFORM_CAPABILITIES'>,
): PlatformCapabilities {
  if (!env.PLATFORM_CAPABILITIES) {
    return HOSTED_CAPABILITIES;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.PLATFORM_CAPABILITIES) as unknown;
  } catch {
    throw new Error('PLATFORM_CAPABILITIES must be valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new Error('PLATFORM_CAPABILITIES must be an object.');
  }
  const record = parsed;
  for (const name of CAPABILITY_NAMES) {
    if (name === 'vectorize' && record[name] === undefined) {
      continue;
    }
    if (typeof record[name] !== 'boolean') {
      throw new Error(`PLATFORM_CAPABILITIES.${name} must be a boolean.`);
    }
  }
  const capabilities = { ...HOSTED_CAPABILITIES };
  for (const name of CAPABILITY_NAMES) {
    const value = record[name];
    if (typeof value === 'boolean') {
      capabilities[name] = value;
    }
  }
  return capabilities;
}

export function capabilityMiddleware(
  capability: keyof PlatformCapabilities,
): MiddlewareHandler<ApiEnv> {
  return async (context, next) => {
    if (!getPlatformCapabilities(context.env)[capability]) {
      return context.json(
        {
          error: 'platform capability unavailable',
          capability,
          message: `This Platform does not enable ${capability}.`,
        },
        501,
      );
    }
    await next();
  };
}
