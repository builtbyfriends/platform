import { PLATFORM_LOGIN_KINDS, parsePlatformLoginId } from '@builtbyfriends/platform';

const PLATFORM_AUTH_ACTIONS = [
  'list',
  'show',
  'initialize',
  'add',
  'configure',
  'test',
  'enable',
  'disable',
  'link',
  'admission',
  'protection',
  'recover',
] as const;
type PlatformAuthAction = (typeof PLATFORM_AUTH_ACTIONS)[number];
export type PlatformConfigArgs = Readonly<{
  subcommand: 'config';
  action: PlatformAuthAction | '';
  target: string;
  connection: string;
  installation: string;
  id: string;
  file: string;
  clientSecretEnv: string;
  testId: string;
  json: boolean;
  plan: boolean;
  yes: boolean;
}>;

export function parsePlatformConfigArgs(args: ReadonlyArray<string>): PlatformConfigArgs {
  if (args.length && args[0] !== 'auth') {
    throw new Error(
      'platform: Usage: bwf platform config <auth|plans|billing> [command] [options].',
    );
  }
  const { positional, flags, values } = parseConfigFlags(args, 'auth', [
    'connection',
    'installation',
    'id',
    'file',
    'client-secret-env',
    'test-id',
  ]);
  const [action = '', target = '', ...extra] = positional;
  if (extra.length || (action && !PLATFORM_AUTH_ACTIONS.includes(action as PlatformAuthAction))) {
    throw new Error(
      `platform: Usage: bwf platform config auth <${PLATFORM_AUTH_ACTIONS.join('|')}>.`,
    );
  }
  const needsTarget =
    action && action !== 'list' && action !== 'initialize' && action !== 'admission';
  if ((needsTarget && !target) || (!needsTarget && target)) {
    throw new Error(
      `platform: ${action || 'config auth'} ${needsTarget ? 'requires a method' : 'does not accept a method'}.`,
    );
  }
  if (action === 'add') {
    if (!PLATFORM_LOGIN_KINDS.includes(target as (typeof PLATFORM_LOGIN_KINDS)[number])) {
      throw new Error(`platform: Login kind must be ${PLATFORM_LOGIN_KINDS.join(', ')}.`);
    }
  } else if (action === 'protection') {
    if (!['enable', 'disable', 'show'].includes(target)) {
      throw new Error(
        'platform: Usage: bwf platform config auth protection <enable|disable|show>.',
      );
    }
  } else if (target) {
    parsePlatformLoginId(target);
  }
  if (flags.has('plan') && flags.has('yes')) {
    throw new Error('platform: --plan and --yes cannot be combined.');
  }
  if (
    (!action || action === 'list' || action === 'show') &&
    (flags.has('plan') || flags.has('yes'))
  ) {
    throw new Error('platform: Select a configuration change before using --plan or --yes.');
  }
  if (values.has('id') && action !== 'add') {
    throw new Error('platform: --id is only valid when adding a login method.');
  }
  if (values.has('installation') && action !== 'recover' && action !== 'protection') {
    throw new Error('platform: --installation is only valid for recovery or platform protection.');
  }
  if (
    (values.has('file') &&
      !['add', 'configure', 'admission', 'recover', 'protection'].includes(action)) ||
    (values.has('client-secret-env') && !['add', 'configure', 'recover'].includes(action))
  ) {
    throw new Error(
      'platform: --file is valid for add, configure, admission, recover, or protection; --client-secret-env is valid for add, configure, or recover.',
    );
  }
  if (values.has('test-id') && action !== 'enable' && action !== 'link') {
    throw new Error('platform: --test-id is only valid for enable or link.');
  }
  const secretEnv = values.get('client-secret-env') ?? '';
  if (secretEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretEnv)) {
    throw new Error('platform: --client-secret-env requires an environment-variable name.');
  }
  if (values.has('id')) {
    parsePlatformLoginId(values.get('id'));
  }
  return {
    subcommand: 'config',
    action: action as PlatformAuthAction | '',
    target,
    connection: values.get('connection') ?? '',
    installation: values.get('installation') ?? '',
    id: values.get('id') ?? '',
    file: values.get('file') ?? '',
    clientSecretEnv: secretEnv,
    testId: values.get('test-id') ?? '',
    json: flags.has('json'),
    plan: flags.has('plan'),
    yes: flags.has('yes'),
  };
}

export type PlatformBillingArgs = Readonly<{
  subcommand: 'config';
  configGroup: 'billing';
  action: 'set' | 'show';
  installation: string;
  stdin: boolean;
  plan: false;
  yes: false;
}>;

/**
 * `bwf platform config billing [set|show] [--installation <id>] [--stdin]`.
 * Values come from STRIPE_* environment variables or stdin, never from arguments.
 */
export function parsePlatformBillingArgs(args: ReadonlyArray<string>): PlatformBillingArgs {
  let action: 'set' | 'show' | '' = '';
  let installation = '';
  let stdin = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--stdin' && !stdin) {
      stdin = true;
    } else if (arg === '--installation' && !installation) {
      const value = args[++index];
      if (!value || value.startsWith('-')) {
        throw new Error('platform: --installation requires a value.');
      }
      installation = value;
    } else if ((arg === 'set' || arg === 'show') && !action) {
      action = arg;
    } else if (/^STRIPE_[A-Z_]*=/.test(arg)) {
      // Decision: Keep the value out of the message: it can be a secret.
      throw new Error(
        'platform: Pass billing values through environment variables or --stdin, not as arguments.',
      );
    } else {
      throw new Error(
        'platform: Usage: bwf platform config billing [set|show] [--installation <id>] [--stdin].',
      );
    }
  }
  if (action === 'show' && stdin) {
    throw new Error('platform: --stdin is only valid for set.');
  }
  return {
    subcommand: 'config',
    configGroup: 'billing',
    action: action || 'set',
    installation,
    stdin,
    plan: false,
    yes: false,
  };
}

/** Parses `config <group>` flags: --json, --plan, --yes, and the given value flags. */
export function parseConfigFlags(
  args: ReadonlyArray<string>,
  group: 'auth' | 'plans',
  valueFlags: ReadonlyArray<string>,
): { positional: Array<string>; flags: Set<string>; values: Map<string, string> } {
  const positional: Array<string> = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (
      !arg.startsWith('--') ||
      (!['json', 'plan', 'yes'].includes(name) && !valueFlags.includes(name))
    ) {
      throw new Error(`platform: Unknown config ${group} flag ${arg}.`);
    }
    if (flags.has(name) || values.has(name)) {
      throw new Error(`platform: Duplicate flag ${arg}.`);
    }
    if (!valueFlags.includes(name)) {
      flags.add(name);
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('-')) {
      throw new Error(`platform: ${arg} requires a value.`);
    }
    values.set(name, value);
  }
  return { positional, flags, values };
}
