import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudflareOperation } from '@builtbyfriends/deploy-cloudflare';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { CloudflareOperationContext } from '../../src/cli/cloudflare-operations.ts';
import {
  applyPreviewSecrets,
  collectPreviewSecrets,
  liveSecretsFailureMessage,
  missingPreviewSecretsMessage,
} from '../../src/cli/preview-secrets.ts';

type Call = { operation: CloudflareOperation; input: string | undefined };

function contextWith(liveSecrets: Array<string>) {
  const calls: Array<Call> = [];

  const context: CloudflareOperationContext = {
    accountId: 'account',
    apiBaseUrl: 'https://api.example.test',
    configPath: '/app/wrangler.json',
    workerName: 'my-worker',
    runWrangler: (operation, options) => {
      calls.push({ operation, input: options.input });
      const data = liveSecrets.map((name) => ({ name, type: 'secret_text' }));

      return { stdout: '', stderr: '', status: 0, data };
    },
  };

  return { context, calls };
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bwf-preview-secrets-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('collectPreviewSecrets', () => {
  it('takes each live secret from the environment, then from the file', async () => {
    const file = join(directory, 'secrets.env');
    writeFileSync(file, 'FROM_FILE=file-value\nBOTH=file-both\n');
    const { context } = contextWith(['BOTH', 'FROM_ENV', 'FROM_FILE']);

    const collected = await collectPreviewSecrets(context, {
      secretsFile: file,
      env: { BOTH: 'env-both', FROM_ENV: 'env-value' },
    });

    expect(collected.missing).toEqual([]);
    expect(collected.values).toEqual({
      BOTH: 'env-both',
      FROM_ENV: 'env-value',
      FROM_FILE: 'file-value',
    });
  });

  it('names every live secret it has no value for, and skips values for secrets the live app lacks', async () => {
    const { context } = contextWith(['HAVE', 'NO_VALUE', 'EMPTY']);

    const collected = await collectPreviewSecrets(context, {
      env: { HAVE: 'a-value', EMPTY: '', NOT_LIVE: 'ignored' },
    });

    expect(collected.missing).toEqual(['EMPTY', 'NO_VALUE']);
    expect(collected.values).toEqual({ HAVE: 'a-value' });
  });
});

describe('the missing secrets message', () => {
  it('names the secrets and what to do, and holds no value', async () => {
    const { context } = contextWith(['NO_VALUE', 'HAVE']);
    const collected = await collectPreviewSecrets(context, { env: { HAVE: 'hidden-value' } });
    const message = missingPreviewSecretsMessage(collected.missing);

    expect(message).toContain('NO_VALUE');
    expect(message).toContain('--secrets-file');
    expect(message).toContain('Nothing was deployed');
    expect(message).not.toContain('hidden-value');
  });
});

describe('applyPreviewSecrets', () => {
  it('sends the values on stdin, never in the operation', async () => {
    const { context, calls } = contextWith(['ONE']);
    const secrets = await collectPreviewSecrets(context, { env: { ONE: 'secret-one' } });
    calls.length = 0;

    await applyPreviewSecrets(context, 'pr-3', secrets);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.operation).toMatchObject({ type: 'preview.secrets', preview: 'pr-3' });
    expect(JSON.stringify(calls[0]?.operation)).not.toContain('secret-one');
    expect(JSON.parse(calls[0]?.input ?? '{}')).toEqual({ ONE: 'secret-one' });
  });

  it('makes no call when the live app has no secrets', async () => {
    const { context, calls } = contextWith([]);
    const secrets = await collectPreviewSecrets(context, { env: {} });
    calls.length = 0;

    await applyPreviewSecrets(context, 'pr-3', secrets);

    expect(calls).toEqual([]);
  });
});

describe('liveSecretsFailureMessage', () => {
  it('tells an app without a deployed Worker to deploy first', async () => {
    const context: CloudflareOperationContext = {
      accountId: 'account',
      apiBaseUrl: 'https://api.example.test',
      configPath: '/app/wrangler.json',
      workerName: 'my-worker',
      runWrangler: () => ({
        stdout: '',
        stderr: '[10007] This Worker does not exist on your account.',
        status: 1,
      }),
    };

    const failure = await collectPreviewSecrets(context, { env: {} }).then(
      () => undefined,
      (error: unknown) => error,
    );

    if (!(failure instanceof Error)) {
      throw new Error('Expected the secret list to fail.');
    }

    const message = liveSecretsFailureMessage(failure);
    expect(message).toContain('no deployed Worker yet');
    expect(message).toContain('bwf deploy --platform cloudflare');
    expect(message).toContain('Nothing was deployed');
  });

  it('does not send a person to deploy for a failure without code 10007', () => {
    const message = liveSecretsFailureMessage(new Error('This account does not exist'));

    expect(message).toContain("could not read the live app's secrets");
    expect(message).not.toContain('no deployed Worker');
  });

  it('keeps the reason for any other failure', () => {
    expect(liveSecretsFailureMessage(new Error('socket hang up'))).toBe(
      "deploy: could not read the live app's secrets: socket hang up",
    );
  });
});
