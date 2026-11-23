import type { SubcommandDef } from './subcommand-prompt.ts';

export const cloudflareSubcommands: Array<SubcommandDef> = [
  { name: 'login', description: 'Sign in or switch Cloudflare users securely' },
  { name: 'status', description: 'Show Cloudflare identity and the pinned deployment account' },
  { name: 'logout', description: 'Remove the local Cloudflare browser session' },
];

export type CloudflareArgs = { subcommand: 'login' | 'status' | 'logout' };

export function parseCloudflareArgs(args: Array<string>): CloudflareArgs {
  const [subcommand, extra] = args;
  switch (subcommand) {
    case 'login':
    case 'status':
    case 'logout': {
      if (extra) {
        throw new Error(`cloudflare: Unexpected argument '${extra}'.`);
      }
      return { subcommand };
    }
    default:
      throw new Error('cloudflare: Usage: bwf cloudflare <login|status|logout>.');
  }
}
