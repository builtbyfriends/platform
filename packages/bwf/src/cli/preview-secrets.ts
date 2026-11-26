import { listCloudflareSecrets, setCloudflarePreviewSecrets } from './cloudflare-operations.ts';
import type { CloudflareOperationContext } from './cloudflare-operations.ts';
import { parseDotenvFile } from './secret.ts';

export type PreviewSecretValues = {
  names: Array<string>;
  values: Record<string, string>;
  missing: Array<string>;
};

/**
 * Pair each secret the live Worker holds with a value. Cloudflare never returns a secret's value, so
 * the value comes from an environment variable of the same name, or from the dotenv file
 * `--secrets-file` names. A name with neither is `missing`.
 */
export async function collectPreviewSecrets(
  context: CloudflareOperationContext,
  options: { secretsFile?: string; env: NodeJS.ProcessEnv },
): Promise<PreviewSecretValues> {
  const names = await listCloudflareSecrets(context);

  const fromFile = new Map(
    options.secretsFile === undefined
      ? []
      : parseDotenvFile(options.secretsFile).map(({ name, value }) => [name, value]),
  );

  const values: Record<string, string> = {};
  const missing: Array<string> = [];

  for (const name of names) {
    const value = options.env[name] ?? fromFile.get(name);

    if (value === undefined || value === '') {
      missing.push(name);
    } else {
      values[name] = value;
    }
  }

  return { names, values, missing };
}

export function missingPreviewSecretsMessage(missing: ReadonlyArray<string>): string {
  return [
    `deploy: the live app has ${missing.length === 1 ? 'a secret' : 'secrets'} that bwf has no value for, so a preview would start without ${missing.length === 1 ? 'it' : 'them'}: ${missing.join(', ')}.`,
    'Cloudflare never returns a secret value. Set each one as an environment variable of the same name, or put them in a dotenv file and pass it with --secrets-file <file>, then run the preview again. Nothing was deployed.',
  ].join('\n');
}

export async function applyPreviewSecrets(
  context: CloudflareOperationContext,
  preview: string,
  secrets: PreviewSecretValues,
): Promise<void> {
  if (secrets.names.length === 0) {
    return;
  }

  await setCloudflarePreviewSecrets(context, preview, secrets.values);
}
