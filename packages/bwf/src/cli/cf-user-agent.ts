import { readFileSync } from 'node:fs';
import { isRecord } from '@builtbyfriends/deploy-core';
import { getOwnVersion } from './agents.ts';

let bwfUserAgent: string | undefined;
let cfCliVersion: string | undefined;

export function getBwfUserAgent(): string {
  if (bwfUserAgent === undefined) {
    bwfUserAgent = `bwf/${getOwnVersion()}`;
  }
  return bwfUserAgent;
}

/** cf prepends `cf-cli/` to CLI_VERSION for both API requests and uploads. */
export function getCfCliVersion(attribution?: string): string {
  // Decision: Scope this override to cf's child environment and leave bwf's process.env alone.
  // Resolve the installed dependency instead of inheriting a caller's test override.
  if (cfCliVersion === undefined) {
    const pkg: unknown = JSON.parse(
      readFileSync(new URL(import.meta.resolve('cf/package.json')), 'utf8'),
    );
    const version = isRecord(pkg) ? pkg.version : undefined;
    cfCliVersion = `${typeof version === 'string' ? version : String(version)} ${getBwfUserAgent()}`;
  }
  return attribution ? `${cfCliVersion} ${attribution}` : cfCliVersion;
}
