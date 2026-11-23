import type { SubcommandDef } from './subcommand-prompt.ts';

export const authSubcommands: Array<SubcommandDef> = [
  { name: 'login', description: 'Sign in to the selected deployment destination' },
  { name: 'status', description: 'Show the selected destination’s signed-in identity' },
  { name: 'logout', description: 'Sign out of the selected deployment destination' },
];

export type AuthArgs = {
  subcommand: 'login' | 'logout' | 'status';
  platform?: 'cloudflare' | 'platform';
};

export function parseAuthArgs(args: Array<string>): AuthArgs {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'login' && subcommand !== 'logout' && subcommand !== 'status') {
    throw new Error(
      'auth: Usage: bwf auth <login|status|logout> [--platform cloudflare|platform].',
    );
  }
  let platform: AuthArgs['platform'];
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index];
    if (value === '--platform') {
      const target = rest[++index];
      if (target !== 'cloudflare' && target !== 'platform') {
        throw new Error('auth: --platform must be cloudflare or bwf.');
      }
      if (platform) {
        throw new Error('auth: --platform may be supplied only once.');
      }
      platform = target;
    } else {
      throw new Error(`auth: Unexpected argument '${value}'.`);
    }
  }
  return {
    subcommand,
    ...(!!platform && { platform }),
  };
}
