import type { CloudflareOperation } from '@builtbyfriends/deploy-cloudflare';
import { describe, expect, it } from 'vite-plus/test';
import type { CloudflareOperationContext } from '../../src/cli/cloudflare-operations.ts';
import {
  missingFromBaseMessage,
  previewBaseFailureMessage,
  readPreviewBase,
} from '../../src/cli/preview-secrets.ts';

function contextWith(options: {
  live: Array<string>;
  base: Array<string>;
  logsTurnedOn?: boolean;
}) {
  const calls: Array<CloudflareOperation> = [];

  const context: CloudflareOperationContext = {
    accountId: 'account',
    apiBaseUrl: 'https://api.example.test',
    configPath: '/app/wrangler.json',
    workerName: 'my-worker',
    runWrangler: (operation) => {
      calls.push(operation);

      if (operation.type === 'preview.base') {
        const data = { secrets: options.base, logsTurnedOn: options.logsTurnedOn ?? false };

        return { stdout: '', stderr: '', status: 0, data };
      }

      const data = options.live.map((name) => ({ name, type: 'secret_text' }));

      return { stdout: '', stderr: '', status: 0, data };
    },
  };

  return { context, calls };
}

describe('readPreviewBase', () => {
  it('names the live secrets the Base lacks, and asks for logs in the Base', async () => {
    const { context, calls } = contextWith({
      live: ['KEPT', 'LACKING', 'ALSO_LACKING'],
      base: ['KEPT', 'ONLY_IN_BASE'],
      logsTurnedOn: true,
    });

    const state = await readPreviewBase(context);

    expect(state.missingFromBase).toEqual(['ALSO_LACKING', 'LACKING']);
    expect(state.base.logsTurnedOn).toBe(true);
    expect(calls.find((call) => call.type === 'preview.base')).toMatchObject({ ensureLogs: true });
  });

  it('finds nothing missing when the Base holds each live secret', async () => {
    const { context } = contextWith({ live: ['ONE', 'TWO'], base: ['TWO', 'ONE'] });

    await expect(readPreviewBase(context)).resolves.toMatchObject({ missingFromBase: [] });
  });
});

describe('the missing from Base message', () => {
  it('names the secret and the command, and says how a preview picks it up', () => {
    const message = missingFromBaseMessage(['OPENAI_KEY']);

    expect(message).toContain('OPENAI_KEY');
    expect(message).toContain('bwf secret put OPENAI_KEY --preview');
    expect(message).toContain('remove it and deploy it again');
  });

  it('uses the plural for several secrets', () => {
    const message = missingFromBaseMessage(['A_KEY', 'B_KEY']);

    expect(message).toContain('secrets that the preview Base lacks');
    expect(message).toContain('A_KEY, B_KEY');
    expect(message).toContain('Set each one once');
  });
});

describe('previewBaseFailureMessage', () => {
  it('tells an app without a deployed Worker to deploy first', () => {
    const message = previewBaseFailureMessage(new Error('[10007] This Worker does not exist.'));

    expect(message).toContain('no deployed Worker yet');
    expect(message).toContain('bwf deploy --platform cloudflare');
    expect(message).toContain('Nothing was deployed');
  });

  it('keeps the reason for any other failure', () => {
    expect(previewBaseFailureMessage(new Error('socket hang up'))).toBe(
      "deploy: could not read the app's preview settings: socket hang up",
    );
  });
});
