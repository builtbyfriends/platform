import { parseArgs } from 'node:util';
import type { RunDeployOptions } from './deploy-types.ts';
import { isPreviewName } from './preview-name.ts';

export function parseDeployArgs(
  args: Array<string>,
): Omit<RunDeployOptions, 'reuseExistingWorker'> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: {
        project: { type: 'string' },
        dir: { type: 'string' },
        spa: { type: 'boolean' },
        'skip-build': { type: 'boolean' },
        'skip-migrations': { type: 'boolean' },
        debug: { type: 'boolean' },
        platform: { type: 'string' },
        provision: { type: 'boolean' },
        'require-email': { type: 'boolean' },
        atomic: { type: 'boolean' },
        preview: { type: 'string' },
        'remove-preview': { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('argument missing') || message.includes('argument is ambiguous')) {
      const optionMatch = message.match(/Option '(--[a-z-]+)/);
      if (optionMatch?.[1] === '--platform') {
        throw new Error("deploy: --platform requires a value ('cloudflare' or 'platform').", {
          cause: error,
        });
      }
      if (optionMatch?.[1] === '--preview' || optionMatch?.[1] === '--remove-preview') {
        throw new Error(`deploy: ${optionMatch[1]} requires a name.`, { cause: error });
      }
      throw new Error('deploy: --project requires a slug.', { cause: error });
    }

    const unknownOptionMatch = message.match(/Unknown option '([^']+)'/);
    if (unknownOptionMatch) {
      throw new Error(`deploy: Unknown option '${unknownOptionMatch[1]}'.`, { cause: error });
    }

    throw new Error(`deploy: ${message}.`, { cause: error });
  }

  const tokens = parsed.tokens ?? [];
  const projectTokens = tokens.filter(
    (token) => token.kind === 'option' && token.name === 'project',
  );
  if (projectTokens.length > 1) {
    throw new Error('deploy: --project can only be specified once.');
  }

  const platformTokens = tokens.filter(
    (token) => token.kind === 'option' && token.name === 'platform',
  );
  if (platformTokens.length > 1) {
    throw new Error('deploy: --platform can only be specified once.');
  }

  if (parsed.positionals.length > 0) {
    throw new Error(`deploy: Unexpected argument '${parsed.positionals[0]}'.`);
  }

  const projectValue = parsed.values.project;
  const projectSlug = typeof projectValue === 'string' ? projectValue : undefined;
  if (typeof projectSlug === 'string' && projectSlug.startsWith('-')) {
    throw new Error('deploy: --project requires a slug.');
  }

  const dir = typeof parsed.values.dir === 'string' ? parsed.values.dir : undefined;
  const spa = parsed.values.spa === true ? true : undefined;
  const skipBuild = parsed.values['skip-build'] === true ? true : undefined;
  const debug = parsed.values.debug === true ? true : undefined;

  const platformValue =
    typeof parsed.values.platform === 'string' ? parsed.values.platform : undefined;
  if (
    platformValue !== undefined &&
    platformValue !== 'cloudflare' &&
    platformValue !== 'platform'
  ) {
    throw new Error("deploy: --platform must be 'cloudflare' or 'platform'.");
  }
  const platform = platformValue;

  const provision = parsed.values.provision === true ? true : undefined;
  if (provision && platform !== 'cloudflare') {
    throw new Error('deploy: --provision requires --platform cloudflare.');
  }

  // Decision: Native Cloudflare email: fail the deploy, before any upload, instead of continuing without email
  // when the domain isn't set up and nobody can press Enter (CI or non-TTY). Only the Cloudflare
  // backend runs the email step.
  const requireEmail = parsed.values['require-email'] === true ? true : undefined;
  const atomic = parsed.values.atomic === true ? true : undefined;
  if (requireEmail && platform !== 'cloudflare') {
    throw new Error('deploy: --require-email requires --platform cloudflare.');
  }

  // Decision: A preview is a Cloudflare Worker Preview of the app's own Worker, so only the Cloudflare backend has one.
  const preview = typeof parsed.values.preview === 'string' ? parsed.values.preview : undefined;
  const removePreview =
    typeof parsed.values['remove-preview'] === 'string'
      ? parsed.values['remove-preview']
      : undefined;
  if ((preview !== undefined || removePreview !== undefined) && platform !== 'cloudflare') {
    throw new Error('deploy: --preview and --remove-preview require --platform cloudflare.');
  }
  if (preview !== undefined && removePreview !== undefined) {
    throw new Error('deploy: use --preview or --remove-preview, not both.');
  }
  for (const name of [preview, removePreview]) {
    if (name !== undefined && !isPreviewName(name)) {
      throw new Error(
        'deploy: a preview name is lowercase letters, digits and hyphens, up to 32 characters, and starts and ends with a letter or digit.',
      );
    }
  }

  // Decision: The Cloudflare backend deploys to the user's own account, so it doesn't resolve a bwf project.
  // Static flags are target-neutral: both backends honor `--dir` and `--spa` through their own static
  // deployment adapters.
  if (platform === 'cloudflare') {
    if (projectSlug !== undefined) {
      throw new Error(
        'deploy: --project is not supported with --platform cloudflare — this platform deploys ' +
          'to your own Cloudflare account and no bwf project is involved.',
      );
    }
  }

  return {
    projectSlug,
    dir,
    spa,
    skipBuild,
    skipMigrations: parsed.values['skip-migrations'] === true ? true : undefined,
    debug,
    platform,
    provision,
    requireEmail,
    atomic,
    preview,
    removePreview,
  };
}
