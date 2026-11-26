import { listCloudflareSecrets, readCloudflarePreviewBase } from './cloudflare-operations.ts';
import type { CloudflareOperationContext, PreviewBase } from './cloudflare-operations.ts';

export type PreviewBaseState = {
  base: PreviewBase;
  liveSecrets: Array<string>;
  missingFromBase: Array<string>;
};

/**
 * Read the Worker's preview Base and the secrets the live Worker holds. Cloudflare gives each new preview the
 * Base's secrets, so a live secret the Base lacks is one a new preview starts without. Logs are turned on
 * in the Base when the app has set no observability there.
 */
export async function readPreviewBase(
  context: CloudflareOperationContext,
): Promise<PreviewBaseState> {
  const liveSecrets = await listCloudflareSecrets(context);
  const base = await readCloudflarePreviewBase(context, { ensureLogs: true });
  const inBase = new Set(base.secrets);

  return {
    base,
    liveSecrets,
    missingFromBase: liveSecrets.filter((name) => !inBase.has(name)),
  };
}

/** The message for a failed read of the live app's settings. A Worker that isn't deployed yet gets the next step. */
export function previewBaseFailureMessage(error: Error): string {
  if (/\b10007\b/.test(error.message)) {
    return 'deploy: the app has no deployed Worker yet, so a preview has nothing to preview against. Run `bwf deploy --platform cloudflare` once, then run the preview again. Nothing was deployed.';
  }

  return `deploy: could not read the app's preview settings: ${error.message}`;
}

export function missingFromBaseMessage(missing: ReadonlyArray<string>): string {
  const first = missing[0] ?? 'NAME';

  return [
    `deploy: the live app has ${missing.length === 1 ? 'a secret' : 'secrets'} that the preview Base lacks, so a new preview starts without ${missing.length === 1 ? 'it' : 'them'}: ${missing.join(', ')}.`,
    `Set ${missing.length === 1 ? 'it' : 'each one'} once with \`bwf secret put ${first} --preview\`. Cloudflare copies the Base into each new preview. A preview that exists already keeps what it has, so remove it and deploy it again to pick up the Base.`,
  ].join('\n');
}
