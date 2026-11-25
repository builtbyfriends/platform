import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  setInstallationEndpoints,
} from '@builtbyfriends/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@voidzero-dev/vite-plus-prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voidzero-dev/vite-plus-prompts')>()),
  log: { info: vi.fn(), message: vi.fn(), step: vi.fn(), warn: vi.fn() },
  outro: vi.fn(),
}));

const { log, outro } = await import('@voidzero-dev/vite-plus-prompts');
const { runPlatformBillingConfig } = await import('../../src/cli/platform-billing-config.ts');
const { parsePlatformArgs } = await import('../../src/cli/platform-args.ts');
const { readPlatformApiWorkerBillingVariables } =
  await import('../../src/cli/platform-installer-outside-changes.ts');
const {
  createPlatformInstallationSecrets,
  platformWorkerSecretPayload,
  readPlatformBillingInput,
  secretCheckpoint,
} = await import('../../src/cli/platform-installer-secrets.ts');
const {
  readInstallationRecoverySecrets,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} = await import('../../src/cli/platform-registry.ts');
type PlatformInstallPlan = import('../../src/cli/platform-plan.ts').PlatformInstallPlan;

const SECRET_KEY = 'sk_test_51abcdefghijklmnop';
const WEBHOOK_SECRET = 'whsec_abcdefghijklmnop';
const roots: Array<string> = [];

beforeEach(() => {
  process.env.PLATFORM_RECOVERY_KEY = Buffer.alloc(32, 7).toString('base64');
});

afterEach(() => {
  delete process.env.PLATFORM_RECOVERY_KEY;
  vi.clearAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function registryWithInstallation() {
  const directory = mkdtempSync(join(tmpdir(), 'platform-billing-'));
  roots.push(directory);
  const manifest = setInstallationEndpoints(
    createPlatformInstallationManifest({
      account: { id: 'account_123', name: 'Example account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: createPlatformDeploymentManifest({
        application: { baseDomain: 'example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      }),
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '0.10.13',
    }),
    { apiUrl: 'https://api.example.com', dashboardUrl: null, proxyUrl: null },
    '2026-09-14T00:00:00.000Z',
  );
  writeInstallationManifest(manifest, directory);
  return { directory, manifest };
}

function upgradeSecrets(checkpoint: Record<string, string>) {
  return createPlatformInstallationSecrets({
    bootstrapGitHubId: '',
    bootstrapGitHubLogin: '',
    checkpoint: {
      databaseUrl: 'postgres://user:pass@db.example.com/platform',
      jwtSecret: 'j'.repeat(32),
      projectSecretKey: Buffer.alloc(32, 1).toString('base64'),
      ...checkpoint,
    },
    cloudflareApiToken: '',
    databaseUrl: '',
    existingInstallation: true,
    githubClientId: '',
    githubClientSecret: '',
    r2AccessKeyId: '',
    r2SecretAccessKey: '',
    updateExistingWorkers: true,
  });
}

describe('bwf platform config billing', () => {
  it('parses the command and refuses values in arguments without printing them', () => {
    expect(parsePlatformArgs(['config', 'billing'])).toMatchObject({
      configGroup: 'billing',
      action: 'set',
      stdin: false,
    });
    expect(
      parsePlatformArgs(['config', 'billing', 'show', '--installation', 'example']),
    ).toMatchObject({ action: 'show', installation: 'example' });
    expect(parsePlatformArgs(['config', 'billing', '--stdin'])).toMatchObject({ stdin: true });
    const error = (() => {
      try {
        parsePlatformArgs(['config', 'billing', `STRIPE_SECRET_KEY=${SECRET_KEY}`]);
      } catch (error_) {
        return error_ as Error;
      }
      return null;
    })();
    expect(error?.message).toContain('not as arguments');
    expect(error?.message).not.toContain(SECRET_KEY);
  });

  it('reads values from the environment and stdin lines, stdin first', () => {
    expect(
      readPlatformBillingInput(
        { STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_PRICE_PRO: 'price_env', UNRELATED: 'x' },
        `# billing\nSTRIPE_PRICE_PRO="price_stdin"\nexport STRIPE_WEBHOOK_SECRET=${WEBHOOK_SECRET}\n`,
      ),
    ).toEqual({
      STRIPE_PRICE_PRO: 'price_stdin',
      STRIPE_SECRET_KEY: SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    expect(() => readPlatformBillingInput({}, 'OTHER=value')).toThrow('is not a billing value');
    expect(() => readPlatformBillingInput({}, `${SECRET_KEY}`)).toThrow(
      /^platform: Line 1 of stdin is not NAME=value\.$/,
    );
    expect(
      readPlatformBillingInput(
        { STRIPE_AUTOMATIC_TAX: 'true', STRIPE_PROMOTION_CODES: 'false' },
        null,
      ),
    ).toEqual({ STRIPE_AUTOMATIC_TAX: 'true', STRIPE_PROMOTION_CODES: 'false' });
    expect(() => readPlatformBillingInput({ STRIPE_AUTOMATIC_TAX: 'yes' }, null)).toThrow(
      'STRIPE_AUTOMATIC_TAX must be true or false',
    );
    expect(() => readPlatformBillingInput({ STRIPE_PRICE_SOLO: 'prod_1' }, null)).toThrow(
      'STRIPE_PRICE_SOLO must be a Stripe price ID',
    );
  });

  it('saves the values encrypted, marks them for the next run and prints only names', async () => {
    const { directory, manifest } = registryWithInstallation();
    writePendingInstallationSecrets(manifest, { databaseUrl: 'postgres://db' }, directory);

    await runPlatformBillingConfig(parsePlatformArgs(['config', 'billing', '--stdin']) as never, {
      env: { STRIPE_SECRET_KEY: SECRET_KEY },
      readStdin: async () =>
        `STRIPE_WEBHOOK_SECRET=${WEBHOOK_SECRET}\nSTRIPE_PRICE_SOLO=price_solo`,
      registryDirectory: directory,
    });

    const recovery = readInstallationRecoverySecrets(manifest, directory)!;
    expect(recovery.databaseUrl).toBe('postgres://db');
    expect(recovery.billingPending).toBe('true');
    expect(JSON.parse(recovery.billingJson)).toEqual({
      STRIPE_PRICE_SOLO: 'price_solo',
      STRIPE_SECRET_KEY: SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    const printed = JSON.stringify([
      vi.mocked(outro).mock.calls,
      vi.mocked(log.message).mock.calls,
    ]);
    expect(printed).toContain('STRIPE_SECRET_KEY');
    expect(printed).not.toContain(SECRET_KEY);
    expect(printed).not.toContain(WEBHOOK_SECRET);

    await runPlatformBillingConfig(parsePlatformArgs(['config', 'billing']) as never, {
      env: { STRIPE_PRICE_PRO: 'price_pro' },
      registryDirectory: directory,
    });
    expect(
      Object.keys(
        JSON.parse(readInstallationRecoverySecrets(manifest, directory)!.billingJson),
      ).sort(),
    ).toEqual([
      'STRIPE_PRICE_PRO',
      'STRIPE_PRICE_SOLO',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
    ]);

    await runPlatformBillingConfig(parsePlatformArgs(['config', 'billing', 'show']) as never, {
      registryDirectory: directory,
    });
    expect(log.message).toHaveBeenCalledWith('STRIPE_SECRET_KEY: saved');
    expect(log.message).toHaveBeenCalledWith('STRIPE_LIVE_ENABLED: not set');
  });

  it('fails clearly when no value is given', async () => {
    const { directory } = registryWithInstallation();
    await expect(
      runPlatformBillingConfig(parsePlatformArgs(['config', 'billing']) as never, {
        env: {},
        registryDirectory: directory,
      }),
    ).rejects.toThrow('No billing values found');
  });
});

describe('billing values in the installer secrets', () => {
  const billingJson = JSON.stringify({
    STRIPE_SECRET_KEY: SECRET_KEY,
    STRIPE_PRICE_SOLO: 'price_solo',
  });

  it('sends saved values to the API Worker once, then keeps them without the marker', () => {
    const secrets = upgradeSecrets({ billingJson, billingPending: 'true' });

    expect(secrets.workerSecretUpdates).toMatchObject({
      STRIPE_SECRET_KEY: SECRET_KEY,
      STRIPE_PRICE_SOLO: 'price_solo',
    });
    expect(platformWorkerSecretPayload('api', secrets, 'account', 'zone', true)).toEqual({
      STRIPE_PRICE_SOLO: 'price_solo',
      STRIPE_SECRET_KEY: SECRET_KEY,
    });
    expect(platformWorkerSecretPayload('proxy', secrets, 'account', 'zone', true)).toBeNull();
    const checkpoint = secretCheckpoint(secrets);
    expect(checkpoint.billingJson).toBe(JSON.stringify(secrets.billing));
    expect(checkpoint).not.toHaveProperty('billingPending');
  });

  it('keeps the live secrets on a run without a billing change', () => {
    const secrets = upgradeSecrets({ billingJson });

    expect(secrets.workerSecretUpdates).toEqual({});
    expect(platformWorkerSecretPayload('api', secrets, 'account', 'zone', true)).toBeNull();
    expect(secretCheckpoint(secrets).billingJson).toBe(billingJson);
  });

  it('sets saved values on a new API Worker', () => {
    const secrets = upgradeSecrets({ billingJson });

    expect(platformWorkerSecretPayload('api', secrets, 'account', 'zone', false)).toMatchObject({
      STRIPE_SECRET_KEY: SECRET_KEY,
      STRIPE_PRICE_SOLO: 'price_solo',
    });
  });
});

describe('billing variables on the live API Worker', () => {
  const plan = {
    account: { id: 'account' },
    actions: [{ key: 'api-worker', kind: 'worker', action: 'update', name: 'example-api' }],
  } as unknown as PlatformInstallPlan;

  it('reads plain-text billing values from the active version and leaves secrets', async () => {
    const request = vi.fn(async (path: string) =>
      path.endsWith('/deployments')
        ? { deployments: [{ versions: [{ version_id: 'v1', percentage: 100 }] }] }
        : {
            resources: {
              bindings: [
                { name: 'STRIPE_PRICE_SOLO', type: 'plain_text', text: 'price_solo' },
                { name: 'STRIPE_SECRET_KEY', type: 'secret_text' },
                { name: 'EMAIL_FROM', type: 'plain_text', text: 'hi@example.com' },
              ],
            },
          },
    );

    await expect(
      readPlatformApiWorkerBillingVariables({ request } as never, plan),
    ).resolves.toEqual({ STRIPE_PRICE_SOLO: 'price_solo' });
    expect(request).toHaveBeenLastCalledWith(
      '/accounts/account/workers/scripts/example-api/versions/v1',
    );
  });

  it('reads nothing for a new API Worker', async () => {
    const request = vi.fn();
    await expect(
      readPlatformApiWorkerBillingVariables(
        { request } as never,
        {
          ...plan,
          actions: [{ key: 'api-worker', kind: 'worker', action: 'create', name: 'example-api' }],
        } as unknown as PlatformInstallPlan,
      ),
    ).resolves.toEqual({});
    expect(request).not.toHaveBeenCalled();
  });
});
