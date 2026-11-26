import { parseArgs } from 'node:util';
import type { SubcommandDef } from './subcommand-prompt.ts';

export const secretSubcommands: Array<SubcommandDef> = [
  { name: 'list', description: 'List project secrets' },
  { name: 'put', arg: '<name>', description: 'Set a project secret' },
  { name: 'delete', arg: '<name>', description: 'Delete a project secret' },
  { name: 'sync', arg: '<file>', description: 'Sync secrets from a dotenv file' },
];

export type SecretArgs =
  | { action: 'list'; projectName?: string; preview?: boolean }
  | { action: 'put'; name: string; value?: string; projectName?: string; preview?: boolean }
  | { action: 'delete'; name: string; projectName?: string; preview?: boolean }
  | { action: 'sync'; file: string; projectName?: string; yes?: boolean; preview?: boolean };

export function parseSecretArgs(args: Array<string>): SecretArgs {
  const parsed = parseArgs({
    args,
    options: {
      project: { type: 'string' },
      yes: { type: 'boolean' },
      preview: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
    tokens: true,
  });

  const tokens = parsed.tokens ?? [];
  const projectTokens = tokens.filter((t) => t.kind === 'option' && t.name === 'project');
  if (projectTokens.length > 1) {
    throw new Error('secret: --project can only be specified once.');
  }
  const yesTokens = tokens.filter((t) => t.kind === 'option' && t.name === 'yes');
  if (yesTokens.length > 1) {
    throw new Error('secret: --yes can only be specified once.');
  }

  const previewTokens = tokens.filter((t) => t.kind === 'option' && t.name === 'preview');
  if (previewTokens.length > 1) {
    throw new Error('secret: --preview can only be specified once.');
  }
  const preview = parsed.values.preview === true;
  if (preview && parsed.values.project !== undefined) {
    throw new Error(
      'secret: --preview changes the preview Base of a Cloudflare Worker, so it takes no --project.',
    );
  }

  const projectValue = parsed.values.project;
  const projectName = typeof projectValue === 'string' ? projectValue : undefined;
  if (projectName?.startsWith('-')) {
    throw new Error('secret: --project requires a name.');
  }

  const [action, name, value, extra] = parsed.positionals;
  if (parsed.values.yes && action !== 'sync') {
    throw new Error(`secret: \`bwf secret ${action}\` does not support --yes.`);
  }
  if (extra) {
    throw new Error(`secret: Unexpected argument '${extra}'.`);
  }

  if (action === 'list') {
    if (name) {
      throw new Error('secret: Usage: bwf secret list [--project <name>].');
    }
    return { action, projectName, ...(preview && { preview }) };
  }

  if (action === 'put') {
    if (!name) {
      throw new Error('secret: Usage: bwf secret put <name> [--project <name>].');
    }
    if (value) {
      throw new Error('secret: Usage: bwf secret put <name> [--project <name>].');
    }
    const eqIndex = name.indexOf('=');
    if (eqIndex === -1) {
      return { action, name, projectName, ...(preview && { preview }) };
    }

    const key = name.slice(0, eqIndex);
    const inlineValue = name.slice(eqIndex + 1);
    if (!key || !inlineValue) {
      throw new Error('secret: Usage: bwf secret put <name> [--project <name>].');
    }
    return { action, name: key, value: inlineValue, projectName, ...(preview && { preview }) };
  }

  if (action === 'delete') {
    if (!name) {
      throw new Error('secret: Usage: bwf secret delete <name> [--project <name>].');
    }
    if (value) {
      throw new Error('secret: Usage: bwf secret delete <name> [--project <name>].');
    }
    return { action, name, projectName, ...(preview && { preview }) };
  }

  if (action === 'sync') {
    if (!name) {
      throw new Error('secret: Usage: bwf secret sync <file> [--project <name>] [--yes].');
    }
    if (value) {
      throw new Error('secret: Usage: bwf secret sync <file> [--project <name>] [--yes].');
    }
    return { action, file: name, projectName, yes: parsed.values.yes, ...(preview && { preview }) };
  }

  throw new Error('secret: Usage: bwf secret <list|put|delete|sync> ...');
}
