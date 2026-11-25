import type { PlatformDeploymentManifest } from '@builtbyfriends/platform';

export function assertPlatformVectorizeSupported(
  deployment: PlatformDeploymentManifest,
  runtime: Readonly<{ vectorize?: 1 }>,
): void {
  if (deployment.capabilities.vectorize && runtime.vectorize !== 1) {
    throw new Error(
      'platform: This installation enables Vectorize. Use a runtime with Vectorize protocol 1; downgrading would remove support for its indexes.',
    );
  }
}
