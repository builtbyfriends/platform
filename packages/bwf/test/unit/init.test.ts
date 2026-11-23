import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  detectProjectState,
  ensureBwfWorkerCompatibilityDate,
  ensureBwfPlatformConnection,
  extractPnpmWorkspacePackages,
  generateStarterMigration,
  getWorkflowYaml,
  isScaffoldableEmptyProject,
  isBwfResolvableFrom,
  parseInitArgs,
  runInitCommand,
} from '../../src/cli/init.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import { readDeploymentPlatform } from '../../src/cli/project.ts';
import { SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES } from '../../src/cli/template.ts';
import { LATEST_KNOWN_COMPAT_DATE } from '../../src/cli/wrangler.ts';
import { buildDrizzleKitSpawnEnv } from '../../src/cli/yarn-pnp.ts';
import { readConfig } from '../../src/config.ts';

const mockSpawnSync = vi.fn();
const mockSelect = vi.fn();
const mockConfirm = vi.fn();
const mockText = vi.fn();
const mockNote = vi.fn();
const mockOutro = vi.fn();
const mockLogWarn = vi.fn();
const mockLogInfo = vi.fn();
const mockLogStep = vi.fn();
const mockGetToken = vi.fn();
const mockGetApiUrl = vi.fn();
const mockRunLogin = vi.fn();
const mockSaveToken = vi.fn();
const mockListProjects = vi.fn();
const mockCreateProject = vi.fn();
const mockDiscoverPlatform = vi.fn();
let platformRegistryDirectory: string;

it('pins compatibility date in the lock without rewriting authored TypeScript', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-init-authored-config-'));
  const source =
    "import { defineConfig } from '@builtbyfriends/bwf/config';\nexport default defineConfig({ remote: process.env.REMOTE === '1' });\n";
  try {
    writeFileSync(join(root, 'bwf.config.ts'), source);
    ensureBwfWorkerCompatibilityDate(root);
    expect(readFileSync(join(root, 'bwf.config.ts'), 'utf8')).toBe(source);
    const lock = JSON.parse(readFileSync(join(root, 'bwf.lock.json'), 'utf8'));
    expect(lock.resolved.compatibility_date).toBe(LATEST_KNOWN_COMPAT_DATE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps an existing typed Astro adapter with dynamic options during targeted init', async () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-init-typed-astro-'));
  const adapter =
    'import cloudflare from "@astrojs/cloudflare"; const options = { configPath: "./.bwf-wrangler.jsonc" }; export default { adapter: cloudflare(options) };\n';
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { astro: '*' } }));
    writeFileSync(join(root, 'bwf.config.ts'), 'export default { cloudflare: { name: "app" } };\n');
    writeFileSync(join(root, 'astro.config.ts'), adapter);

    await runInitCommand(root, { tsconfig: true, github: false });
    expect(readFileSync(join(root, 'astro.config.ts'), 'utf8')).toBe(adapter);
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('init Git arguments', () => {
  it('keeps Git optional and honors the last positive or negative flag', () => {
    expect(parseInitArgs([]).git).toBeUndefined();
    expect(parseInitArgs(['--git']).git).toBe(true);
    expect(parseInitArgs(['--no-git']).git).toBe(false);
    expect(parseInitArgs(['--git', '--no-git']).git).toBe(false);
    expect(parseInitArgs(['--no-git', '--git']).git).toBe(true);
    expect(parseInitArgs(['--tsconfig', '--git'])).toMatchObject({ tsconfig: true, git: true });
    expect(() => parseInitArgs(['--agents'])).toThrow('Unknown option');
  });

  it.each(['--git', '--no-git'])('keeps the full starter flow with %s', async (flag) => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-git-flow-'));
    try {
      mockSelect
        .mockResolvedValueOnce('vite')
        .mockResolvedValueOnce('spa')
        .mockResolvedValueOnce('none');
      await runInitCommand(root, parseInitArgs([flag]));
      expect(existsSync(join(root, 'src', 'App.tsx'))).toBe(true);
      expect(existsSync(join(root, '.gitignore'))).toBe(true);
      const gitCalls = mockSpawnSync.mock.calls.filter(([command]) => command === 'git');
      expect(gitCalls).toHaveLength(flag === '--git' ? 1 : 0);
      if (flag === '--git') {
        expect(gitCalls[0][1]).toEqual(['init']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['--git', '--no-git'])(
    'rejects %s in a workspace member before modifying it',
    async (flag) => {
      const root = mkdtempSync(join(tmpdir(), 'platform-init-git-workspace-'));
      try {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
        const child = join(root, 'apps', 'web');
        mkdirSync(child, { recursive: true });
        await expect(runInitCommand(child, parseInitArgs(['--tsconfig', flag]))).rejects.toThrow(
          'The --git/--no-git options are not available when adding a package to an existing monorepo',
        );
        expect(readdirSync(child)).toEqual([]);
        expect(mockSpawnSync).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('init scaffold arguments', () => {
  it('parses scaffold choices and rejects unknown values', () => {
    expect(
      parseInitArgs([
        '--toolchain',
        'vite',
        '--framework=react',
        '--starter',
        'spa',
        '--deploy',
        'none',
      ]),
    ).toMatchObject({ toolchain: 'vite', framework: 'react', starter: 'spa', deploy: 'none' });
    expect(parseInitArgs([])).toMatchObject({
      toolchain: undefined,
      framework: undefined,
      starter: undefined,
      deploy: undefined,
    });
    expect(() => parseInitArgs(['--framework', 'angular'])).toThrow(
      'init: --framework must be one of react.',
    );
  });

  it('scaffolds from flags without prompting when stdin is not a terminal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-flags-'));
    try {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => false });
      await runInitCommand(
        root,
        parseInitArgs([
          '--toolchain',
          'vite',
          '--framework',
          'react',
          '--starter',
          'spa',
          '--deploy',
          'none',
        ]),
      );
      expect(mockSelect).not.toHaveBeenCalled();
      expect(existsSync(join(root, 'src', 'App.tsx'))).toBe(true);
      expect(readDeploymentPlatform(root)).toBe('none');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails with the missing flag instead of prompting when stdin is not a terminal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-flags-missing-'));
    try {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => false });
      await expect(runInitCommand(root, parseInitArgs(['--toolchain', 'vite']))).rejects.toThrow(
        'init: Pass --starter (sqlite, postgresql, mysql, spa) when running without an interactive terminal.',
      );
      expect(mockSelect).not.toHaveBeenCalled();
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a missing deployment choice retryable without a terminal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-flags-retry-'));
    const flags = ['--toolchain', 'vite', '--framework', 'react', '--starter', 'spa'];
    try {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => false });
      await expect(runInitCommand(root, parseInitArgs(flags))).rejects.toThrow(
        'init: Pass --deploy (cloudflare, platform, none) when running without an interactive terminal.',
      );
      expect(readdirSync(root)).toEqual([]);
      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(mockSelect).not.toHaveBeenCalled();

      await runInitCommand(root, parseInitArgs([...flags, '--deploy', 'none']));
      expect(mockSelect).not.toHaveBeenCalled();
      expect(existsSync(join(root, 'src', 'App.tsx'))).toBe(true);
      expect(readDeploymentPlatform(root)).toBe('none');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('init question order', () => {
  const DEPLOY_PROMPT = 'Where should this project deploy?';
  const answers: Record<string, unknown> = {
    'Choose a scaffold toolchain:': 'vite',
    'Choose a starter:': 'spa',
    'Choose a database setup for this project:': 'none',
    [DEPLOY_PROMPT]: 'none',
  };

  it('asks where a new starter deploys before writing its files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-order-'));
    let entriesAtDeployPrompt: Array<string> | undefined;
    try {
      mockSelect.mockImplementation((options: { message: string }) => {
        if (options.message === DEPLOY_PROMPT) {
          entriesAtDeployPrompt = readdirSync(root);
        }
        return answers[options.message];
      });

      await runInitCommand(root);

      expect(entriesAtDeployPrompt).toEqual([]);
      expect(existsSync(join(root, 'src', 'App.tsx'))).toBe(true);
      expect(readDeploymentPlatform(root)).toBe('none');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves the folder empty when the deployment question is cancelled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-order-cancel-'));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Cancelled');
    });
    try {
      mockSelect.mockImplementation((options: { message: string }) =>
        options.message === DEPLOY_PROMPT ? Symbol.for('cancel') : answers[options.message],
      );

      await expect(runInitCommand(root)).rejects.toThrow('Cancelled');

      expect(exit).toHaveBeenCalledWith(0);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      exit.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['an empty folder', 'Empty project detected. Creating a React starter.', false],
    ['an existing app', 'Existing project detected. Configuring bwf.', true],
  ])('says what it does in %s before asking about Git', async (_name, message, existing) => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-order-git-'));
    delete process.env.CI;
    try {
      if (existing) {
        writeExistingViteApp(root, { bwf: '^0.0.1' });
      }
      mockSelect.mockImplementation((options: { message: string }) => answers[options.message]);
      mockConfirm.mockResolvedValue(false);

      await runInitCommand(root);

      const infoIndex = mockLogInfo.mock.calls.findIndex(([text]) => text === message);
      const gitIndex = mockConfirm.mock.calls.findIndex(
        ([options]) => options?.message === 'Initialize a git repository?',
      );
      expect(infoIndex).not.toBe(-1);
      expect(gitIndex).not.toBe(-1);
      expect(mockLogInfo.mock.invocationCallOrder[infoIndex]).toBeLessThan(
        mockConfirm.mock.invocationCallOrder[gitIndex]!,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('GitHub Actions deployment workflows', () => {
  it('requires a selected URL for a bwf deployment workflow', () => {
    expect(() => getWorkflowYaml('/project', 'npm', 'my-app', 'platform')).toThrow('bwf connect');
  });
  it('scaffolds the direct Cloudflare deployment path with a scoped API token', () => {
    const yaml = getWorkflowYaml('/project', 'npm', null, 'cloudflare');
    expect(yaml).toContain('name: Deploy to Cloudflare');
    expect(yaml).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(yaml).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(yaml).toContain(
      'CLOUDFLARE_WORKERS_SUBDOMAIN: ${{ vars.CLOUDFLARE_WORKERS_SUBDOMAIN }}',
    );
    expect(yaml).toContain('CF_ACCESS_CLIENT_ID: ${{ secrets.CF_ACCESS_CLIENT_ID }}');
    expect(yaml).toContain('CF_ACCESS_CLIENT_SECRET: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}');
    expect(yaml).toContain('npx bwf deploy --platform cloudflare');
    expect(yaml).toContain('contents: read');
    expect(yaml).not.toContain('id-token: write');
    expect(yaml).not.toContain('BWF_TOKEN');
  });

  it('sets up a supported Node before bunx runs the CLI in Bun workflows', () => {
    // Decision: bunx runs the CLI with the `node` on PATH, which is the runner's default Node.
    const yaml = getWorkflowYaml('/project', 'bun', null, 'cloudflare');
    expect(yaml).toContain(
      '      - uses: oven-sh/setup-bun@v2\n' +
        '      - uses: actions/setup-node@v6\n' +
        '        with:\n' +
        '          node-version: lts/*\n' +
        '          check-latest: true\n' +
        '      - run: bun install --frozen-lockfile\n',
    );
    expect(yaml.indexOf('actions/setup-node@v6')).toBeLessThan(
      yaml.indexOf('bunx bwf deploy --platform cloudflare'),
    );

    const managed = getWorkflowYaml(
      '/project',
      'bun',
      'my-app',
      'platform',
      'https://api.company.example',
    );
    expect(managed.indexOf('actions/setup-node@v6')).toBeGreaterThan(-1);
    expect(managed.indexOf('actions/setup-node@v6')).toBeLessThan(
      managed.indexOf('bunx bwf connect'),
    );
  });

  it.each(['24.22.1', '24'])(
    'uses .node-version %s for the Bun workflow Node without a stale cached release',
    (pin) => {
      const root = mkdtempSync(join(tmpdir(), 'platform-init-bun-node-'));
      try {
        writeFileSync(join(root, '.node-version'), `${pin}\n`);
        const yaml = getWorkflowYaml(root, 'bun', null, 'cloudflare');
        expect(yaml).toContain(
          '      - uses: actions/setup-node@v6\n' +
            '        with:\n' +
            '          node-version-file: .node-version\n' +
            '          check-latest: true\n' +
            '      - run: bun install --frozen-lockfile\n',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('asks setup-node for the latest LTS release instead of a cached one', () => {
    const yaml = getWorkflowYaml('/project', 'pnpm', null, 'cloudflare');
    expect(yaml).toContain(
      '        with:\n' +
        '          node-version: lts/*\n' +
        '          check-latest: true\n' +
        '          cache: pnpm\n',
    );
  });

  it('retains the GitHub OIDC workflow for managed deployments', () => {
    const yaml = getWorkflowYaml(
      '/project',
      'npm',
      'my-app',
      'platform',
      'https://api.company.example',
    );
    expect(yaml).toContain('name: Deploy to bwf');
    expect(yaml).toContain('id-token: write');
    expect(yaml).toContain("BWF_API_URL: ${{ vars.BWF_API_URL || 'https://api.company.example' }}");
    expect(yaml).toContain('npx bwf connect "$BWF_API_URL" --no-login');
    expect(yaml.indexOf('npx bwf connect')).toBeLessThan(yaml.indexOf('npx bwf deploy'));
    expect(yaml).toContain('npx bwf deploy --platform bwf --project "$BWF_PROJECT"');
  });
});

function expectPnpmAllowBuilds(root: string): void {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  expect(yaml.match(/^allowBuilds:\n(?: {2}.*\n)*/m)?.[0]).toBe(
    'allowBuilds:\n  better-sqlite3: false\n  core-js-pure: false\n  esbuild: true\n  sharp: true\n  workerd: true\n',
  );
  expect(yaml).not.toContain('onlyBuiltDependencies:');
}

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  settings: { accessible: false },
  intro: vi.fn(),
  outro: (...args: Array<unknown>) => mockOutro(...args),
  note: (...args: Array<unknown>) => mockNote(...args),
  log: {
    success: vi.fn(),
    warn: (...args: Array<unknown>) => mockLogWarn(...args),
    error: vi.fn(),
    info: (...args: Array<unknown>) => mockLogInfo(...args),
    step: (...args: Array<unknown>) => mockLogStep(...args),
  },
  confirm: (...args: Array<unknown>) => mockConfirm(...args),
  select: (...args: Array<unknown>) => mockSelect(...args),
  text: (...args: Array<unknown>) => mockText(...args),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  isCI: () => false,
  isCancel: (value: unknown) => value === Symbol.for('cancel'),
  cancel: vi.fn(),
}));

vi.mock('../../src/cli/auth', () => ({
  getApiUrl: (...args: Array<unknown>) => mockGetApiUrl(...args),
  getToken: (...args: Array<unknown>) => mockGetToken(...args),
  runPlatformLogin: (...args: Array<unknown>) => mockRunLogin(...args),
  savePlatformToken: (...args: Array<unknown>) => mockSaveToken(...args),
  getSiteDomain: () => 'void.app',
}));

vi.mock('../../src/cli/platform-cmd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/platform-cmd.ts')>()),
  discoverPlatform: (...args: Array<unknown>) => mockDiscoverPlatform(...args),
}));

vi.mock('../../src/cli/client', () => ({
  PlatformApiError: class PlatformApiError extends Error {
    readonly status = 500;
    readonly code = undefined;
    readonly body = undefined;
  },
  PlatformClient: class {
    readonly apiUrl: string;

    constructor(_token: string, options?: string | { apiUrl?: string }) {
      this.apiUrl =
        (typeof options === 'string' ? options : options?.apiUrl) ??
        mockGetApiUrl() ??
        'https://api.example.com';
    }

    listProjects(...args: Array<unknown>) {
      return mockListProjects(...args);
    }

    createProject(...args: Array<unknown>) {
      return mockCreateProject(...args);
    }
  },
}));

vi.mock('node:child_process', () => ({
  spawnSync: (...args: Array<unknown>) => mockSpawnSync(...args),
}));

function withTempDir(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeMockGeneratedMigration(root: string): void {
  const schema = readFileSync(join(root, 'db', 'schema.ts'), 'utf8');
  const isPostgres = schema.includes('from "@builtbyfriends/bwf/schema-pg"');
  const migrationsDir = join(root, 'db', 'migrations');
  const metaDir = join(migrationsDir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  writeFileSync(
    join(migrationsDir, '0000_generated.sql'),
    isPostgres
      ? `CREATE TABLE "messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
`
      : `CREATE TABLE \`messages\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`text\` text NOT NULL,
  \`created_at\` text DEFAULT (datetime('now')) NOT NULL
);
`,
  );
  writeFileSync(
    join(metaDir, '_journal.json'),
    JSON.stringify(
      {
        version: '7',
        dialect: isPostgres ? 'postgresql' : 'sqlite',
        entries: [{ idx: 0, version: '6', when: 0, tag: '0000_generated', breakpoints: true }],
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(metaDir, '0000_snapshot.json'),
    JSON.stringify({ version: '6', dialect: isPostgres ? 'postgresql' : 'sqlite' }, null, 2) + '\n',
  );
}

function listMigrationSqlFiles(root: string): Array<string> {
  const migrationsDir = join(root, 'db', 'migrations');
  if (!existsSync(migrationsDir)) {
    return [];
  }
  return readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort();
}

function drizzleGenerateCwd(command: unknown, args: unknown, options: unknown): string | undefined {
  if (command !== process.execPath || !Array.isArray(args) || args[1] !== 'generate') {
    return undefined;
  }
  const cwd = (options as { cwd?: unknown } | null | undefined)?.cwd;
  return typeof cwd === 'string' ? cwd : undefined;
}

function mockSpawnSuccess(onYarnInstall?: (cwd: string) => void): void {
  mockSpawnSync.mockImplementation((command, args, options) => {
    const cwd = (options as { cwd?: unknown } | null | undefined)?.cwd;
    if (
      onYarnInstall &&
      command === 'yarn' &&
      Array.isArray(args) &&
      args[0] === 'install' &&
      typeof cwd === 'string'
    ) {
      onYarnInstall(cwd);
    }
    const generateCwd = drizzleGenerateCwd(command, args, options);
    if (generateCwd) {
      writeMockGeneratedMigration(generateCwd);
    }
    return { status: 0, stdout: '', stderr: '' };
  });
}

// Decision: With vite-plus resolvable from the project, init runs its bin through node, so the install is
// `node <vp> install ...`; otherwise it's `vp install ...` or `<pm> install`.
function installCalls() {
  return mockSpawnSync.mock.calls.filter(
    (call) => Array.isArray(call[1]) && call[1].slice(0, 2).includes('install'),
  );
}

function installerOf(call: Array<unknown>): unknown {
  const args = call[1] as Array<string>;
  return call[0] === process.execPath && /[\\/]vp$/.test(args[0]!) ? 'vp' : call[0];
}

function expectVpInstall(cwd: string) {
  const call = installCalls().find((candidate) => installerOf(candidate) === 'vp');
  expect(call?.[1]).toEqual(expect.arrayContaining(['install', '--no-frozen-lockfile']));
  expect(call?.[2]).toMatchObject({ cwd, stdio: 'inherit' });
}

function drizzleGenerateCalls() {
  return mockSpawnSync.mock.calls.filter(
    (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
  );
}

function workspaceNotes() {
  return mockNote.mock.calls.filter((call) => call[1] === 'Workspace subpackage');
}

function writeInstalledBwf(dir: string): void {
  mkdirSync(join(dir, 'node_modules', '@builtbyfriends', 'bwf'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', '@builtbyfriends', 'bwf', 'package.json'),
    JSON.stringify({ name: '@builtbyfriends/bwf', version: '0.0.0' }, null, 2) + '\n',
  );
}

function writeExistingViteApp(
  root: string,
  options: { bwf?: string; packageManager?: string } = {},
): void {
  mkdirSync(root, { recursive: true });
  const devDependencies: Record<string, string> = { vite: '^8.0.0' };
  if (options.bwf !== undefined) {
    devDependencies['@builtbyfriends/bwf'] = options.bwf;
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'app',
        private: true,
        type: 'module',
        packageManager: options.packageManager,
        devDependencies,
      },
      null,
      2,
    ) + '\n',
  );
}

async function runInitWithDemo(root: string): Promise<void> {
  mockSelect.mockResolvedValueOnce('none');
  mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await runInitCommand(root);
}

function expectBwfDeclared(root: string): void {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const bwfSpec =
    pkg.devDependencies?.['@builtbyfriends/bwf'] ??
    pkg.dependencies?.['@builtbyfriends/bwf'] ??
    pkg.peerDependencies?.['@builtbyfriends/bwf'];
  expect(typeof bwfSpec).toBe('string');
  expect(bwfSpec.length).toBeGreaterThan(0);
}

function writeExistingReactRouterProject(root: string): void {
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'existing-react-router-app',
        private: true,
        dependencies: { '@react-router/dev': '^7.0.0' },
      },
      null,
      2,
    ) + '\n',
  );
}

function selectCloudflareDuringInit(accountId?: string): void {
  mockSelect.mockImplementation((options: { message?: string }) => {
    switch (options.message) {
      case 'Choose a database setup for this project:':
        return 'none';
      case 'Where should this project deploy?':
        return 'cloudflare';
      case 'Choose a Cloudflare account:':
        return accountId;
      default:
        return undefined;
    }
  });
}

function wranglerWhoamiResult(accounts: Array<{ id: string; name: string }>): {
  status: number;
  stdout: string;
  stderr: string;
} {
  return {
    status: 0,
    stdout: JSON.stringify({ operationResult: 1, data: { loggedIn: true, accounts, scopes: [] } }),
    stderr: '',
  };
}

function cloudflareOperationType(args: unknown): string | undefined {
  if (!Array.isArray(args)) {
    return undefined;
  }
  try {
    return JSON.parse(args.at(-1)).type;
  } catch {
    return undefined;
  }
}

// Decision: Prompts are mocked, so give init a terminal to prompt in. CI stays set, as in CI runs, so Git
// and AGENTS.md setup keep skipping their prompts.
const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
let previousCI: string | undefined;

function restoreInteractiveTerminal(): void {
  if (previousCI === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = previousCI;
  }
  if (stdinTtyDescriptor) {
    Object.defineProperty(process.stdin, 'isTTY', stdinTtyDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY');
  }
}

afterEach(() => {
  restoreInteractiveTerminal();
  delete process.env.PLATFORM_REGISTRY_DIR;
  rmSync(platformRegistryDirectory, { recursive: true, force: true });
  mockSpawnSync.mockReset();
  mockSelect.mockReset();
  mockConfirm.mockReset();
  mockText.mockReset();
  mockNote.mockReset();
  mockOutro.mockReset();
  mockLogWarn.mockReset();
  mockLogInfo.mockReset();
  mockLogStep.mockReset();
  mockGetToken.mockReset();
  mockGetApiUrl.mockReset();
  mockRunLogin.mockReset();
  mockSaveToken.mockReset();
  mockListProjects.mockReset();
  mockCreateProject.mockReset();
  mockDiscoverPlatform.mockReset();
});

beforeEach(() => {
  previousCI = process.env.CI;
  process.env.CI = 'true';
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => true });
  platformRegistryDirectory = mkdtempSync(join(tmpdir(), 'platform-init-platform-registry-'));
  process.env.PLATFORM_REGISTRY_DIR = platformRegistryDirectory;
  savePlatformConnection({
    accountId: null,
    apiUrl: 'https://platform.buildwithfriends.dev',
    applicationDomain: 'void.app',
    displayName: 'bwf Cloud',
    installationId: null,
    kind: 'connected',
    proxyUrl: 'https://proxy.void.cloud',
  });
  mockSelect.mockImplementation((options: { message?: string }) =>
    options.message === 'Where should this project deploy?' ? 'platform' : undefined,
  );
  mockSpawnSuccess();
  mockGetToken.mockReturnValue(null);
  mockGetApiUrl.mockReturnValue('https://platform.buildwithfriends.dev');
  mockRunLogin.mockResolvedValue('token_123');
  mockListProjects.mockResolvedValue([]);
  mockCreateProject.mockResolvedValue({ id: 'proj_123', slug: 'my-app' });
  mockDiscoverPlatform.mockResolvedValue({
    apiUrl: 'https://platform.buildwithfriends.dev',
    applicationDomain: 'void.app',
    authenticationProviders: ['github', 'google'],
    capabilities: {
      ai: true,
      customDomains: true,
      email: true,
      githubActions: true,
      githubOAuth: true,
      googleOAuth: true,
      managedBuilds: true,
      sandbox: true,
    },
    displayName: 'bwf Cloud',
    installationId: null,
    platformVersion: '0.10.14',
    proxyUrl: 'https://proxy.void.cloud',
    schemaVersion: 1,
  });
});

describe('bwf platform deployment setup', () => {
  it('connects a genuinely new user before attempting platform login', async () => {
    rmSync(platformRegistryDirectory, { force: true, recursive: true });
    mockGetApiUrl.mockImplementation(() => {
      throw new Error('No bwf platform connected');
    });
    mockText.mockResolvedValue('https://platform.example.test');
    mockDiscoverPlatform.mockResolvedValueOnce({
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      authenticationProviders: ['github'],
      capabilities: {
        ai: true,
        customDomains: true,
        email: false,
        githubActions: false,
        githubOAuth: true,
        googleOAuth: false,
        managedBuilds: false,
        sandbox: false,
      },
      displayName: 'Company bwf',
      installationId: 'company-a1b2c3d4',
      platformVersion: '0.10.14',
      proxyUrl: 'https://proxy.example.test',
      schemaVersion: 1,
    });

    await ensureBwfPlatformConnection('/project');

    expect(mockDiscoverPlatform).toHaveBeenCalledWith('https://platform.example.test');
    const { getActivePlatformConnection } = await import('../../src/cli/platform-registry.ts');
    expect(getActivePlatformConnection()).toMatchObject({
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      proxyUrl: 'https://proxy.example.test',
    });
  });

  it('refuses to scaffold unsupported platform GitHub Actions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-no-github-actions-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );
      mockDiscoverPlatform.mockResolvedValueOnce({
        apiUrl: 'https://platform.example.test',
        applicationDomain: 'apps.example.test',
        authenticationProviders: ['github'],
        capabilities: {
          ai: true,
          customDomains: true,
          email: false,
          githubActions: false,
          githubOAuth: true,
          googleOAuth: false,
          managedBuilds: false,
          sandbox: false,
        },
        displayName: 'Company bwf',
        installationId: 'company-a1b2c3d4',
        platformVersion: '0.10.14',
        proxyUrl: 'https://proxy.example.test',
        schemaVersion: 1,
      });

      await expect(runInitCommand(root, { github: true, tsconfig: false })).rejects.toThrow(
        'Company bwf does not support GitHub Actions deployments',
      );
      expect(existsSync(join(root, '.github', 'workflows', 'bwf-deploy.yml'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('extractPnpmWorkspacePackages', () => {
  it('parses block-style packages list with mixed quoting', () => {
    const yaml = ['packages:', "  - 'packages/*'", '  - "apps/*"', '  - docs', ''].join('\n');
    expect(extractPnpmWorkspacePackages(yaml)).toEqual(['packages/*', 'apps/*', 'docs']);
  });

  it('parses inline flow-style list with a single quoted element', () => {
    expect(extractPnpmWorkspacePackages("packages: ['packages/*']\n")).toEqual(['packages/*']);
  });

  it('parses inline flow-style list with multiple quoted elements', () => {
    expect(extractPnpmWorkspacePackages("packages: ['packages/*', 'apps/*']\n")).toEqual([
      'packages/*',
      'apps/*',
    ]);
  });

  it('parses inline flow-style list with unquoted elements', () => {
    expect(extractPnpmWorkspacePackages('packages: [packages/*]\n')).toEqual(['packages/*']);
  });

  it('parses inline flow-style list with surrounding whitespace', () => {
    expect(extractPnpmWorkspacePackages("packages: [ 'packages/*' ,  'apps/*' ]\n")).toEqual([
      'packages/*',
      'apps/*',
    ]);
  });

  it('parses inline flow-style list mixing quoted and unquoted elements', () => {
    expect(extractPnpmWorkspacePackages('packages: ["packages/*", apps/*]\n')).toEqual([
      'packages/*',
      'apps/*',
    ]);
  });

  it('returns [] when packages key is absent', () => {
    expect(extractPnpmWorkspacePackages('catalog:\n  vite: ^8.0.0\n')).toEqual([]);
  });

  it('preserves `#` inside a double-quoted workspace pattern', () => {
    const yaml = ['packages:', '  - "path #hash/*"', ''].join('\n');
    expect(extractPnpmWorkspacePackages(yaml)).toEqual(['path #hash/*']);
  });

  it('preserves `#` inside a single-quoted workspace pattern', () => {
    const yaml = ['packages:', "  - 'apps/#one/*'", ''].join('\n');
    expect(extractPnpmWorkspacePackages(yaml)).toEqual(['apps/#one/*']);
  });

  it('strips a trailing comment from a quoted pattern without touching the value', () => {
    const yaml = ['packages:', '  - "apps/*" # top-level apps', '  - docs', ''].join('\n');
    expect(extractPnpmWorkspacePackages(yaml)).toEqual(['apps/*', 'docs']);
  });

  it('preserves `#` inside a quoted flow-style pattern', () => {
    expect(extractPnpmWorkspacePackages('packages: ["a/#b/*", "c/*"]\n')).toEqual([
      'a/#b/*',
      'c/*',
    ]);
  });
});

describe('isBwfResolvableFrom', () => {
  function probeCalls(kind: 'cjs' | 'esm'): number {
    const argv =
      kind === 'cjs'
        ? ['-e', "require.resolve('@builtbyfriends/bwf')"]
        : ['--input-type=module', '-e', "import.meta.resolve('@builtbyfriends/bwf')"];
    return mockSpawnSync.mock.calls.filter((call) => {
      const args: unknown = call[1];
      return Array.isArray(args) && argv.every((arg, index) => args[index] === arg);
    }).length;
  }

  it('returns true when a PnP runtime sits at an ancestor directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-pnp-'));
    try {
      const subApp = join(root, 'packages', 'app');
      mkdirSync(subApp, { recursive: true });
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      expect(isBwfResolvableFrom(subApp)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Decision: Before `yarn install`, a committed `.pnp.cjs` points at archives that aren't fetched yet.
  it('returns false when .pnp.cjs exists but .yarn/install-state.gz is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-pnp-fresh-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      expect(isBwfResolvableFrom(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Decision: Zero-install repos commit `.yarn/cache` and often have no install-state.gz.
  it('returns true when .pnp.cjs exists with a populated .yarn/cache (zero-install)', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-pnp-zero-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn', 'cache'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'cache', 'pkg-npm-1.0.0-abcd.zip'), '');
      expect(isBwfResolvableFrom(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when .pnp.cjs exists but .yarn/cache is empty and install-state.gz is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-pnp-empty-cache-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn', 'cache'), { recursive: true });
      expect(isBwfResolvableFrom(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when .yarn/install-state.gz is at a DIFFERENT ancestor than .pnp.cjs', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-pnp-mismatch-'));
    try {
      const subApp = join(root, 'app');
      mkdirSync(subApp, { recursive: true });
      writeFileSync(join(subApp, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      expect(isBwfResolvableFrom(subApp)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false for a bare directory with no node_modules and no PnP runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-bare-'));
    try {
      expect(isBwfResolvableFrom(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true when `node_modules/@builtbyfriends/bwf/package.json` exists at `start` (unchanged legacy shape)', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-nm-'));
    try {
      writeInstalledBwf(root);
      expect(isBwfResolvableFrom(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true when `node_modules/@builtbyfriends/bwf/package.json` exists at an ancestor (hoisted monorepo shape)', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-hoist-'));
    try {
      writeInstalledBwf(root);
      const subApp = join(root, 'packages', 'app');
      mkdirSync(subApp, { recursive: true });
      expect(isBwfResolvableFrom(subApp)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Decision: Installed PnP data can be stale (for example after the package was removed on another
  // branch).
  it('returns false when the PnP probe for `require.resolve("@builtbyfriends/bwf")` fails (stale .pnp.cjs)', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-pnp-stale-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: '' });

      expect(isBwfResolvableFrom(root)).toBe(false);
      expect(probeCalls('cjs')).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true when the PnP probe for `require.resolve("@builtbyfriends/bwf")` succeeds', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-pnp-ok-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

      expect(isBwfResolvableFrom(root)).toBe(true);
      expect(probeCalls('cjs')).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Decision: A loader-only runtime gets no `--require`, so a CJS probe can't see it.
  it('uses an ESM probe when only `.pnp.loader.mjs` is present (loader-only PnP)', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-pnp-loader-only-'));
    try {
      writeFileSync(join(root, '.pnp.loader.mjs'), '// pnp loader\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

      expect(isBwfResolvableFrom(root)).toBe(true);
      expect(probeCalls('esm')).toBe(1);
      expect(probeCalls('cjs')).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when the loader-only ESM probe fails (stale `.pnp.loader.mjs`)', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-pnp-loader-stale-'));
    try {
      writeFileSync(join(root, '.pnp.loader.mjs'), '// pnp loader\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: '' });

      expect(isBwfResolvableFrom(root)).toBe(false);
      expect(probeCalls('esm')).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still uses the CJS probe when both `.pnp.cjs` and `.pnp.loader.mjs` are present', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-pnp-both-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      writeFileSync(join(root, '.pnp.loader.mjs'), '// pnp loader\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

      expect(isBwfResolvableFrom(root)).toBe(true);
      expect(probeCalls('cjs')).toBe(1);
      expect(probeCalls('esm')).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not spawn the PnP probe when node_modules/@builtbyfriends/bwf exists at start (even with PnP markers)', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-pnp-nm-'));
    try {
      writeInstalledBwf(root);
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');

      const probesBefore = probeCalls('cjs');
      expect(isBwfResolvableFrom(root)).toBe(true);
      expect(probeCalls('cjs')).toBe(probesBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Decision: A nested project with its own lockfile must not inherit an outer PnP graph.
  it('does not walk past a leaf-managed lockfile into an ancestor Yarn PnP monorepo', () => {
    const outer = mkdtempSync(join(tmpdir(), 'platform-init-pnp-leaf-lock-'));
    try {
      writeFileSync(join(outer, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(outer, '.yarn'), { recursive: true });
      writeFileSync(join(outer, '.yarn', 'install-state.gz'), '');
      const leaf = join(outer, 'scratch', 'my-app');
      mkdirSync(leaf, { recursive: true });
      writeFileSync(join(leaf, 'package.json'), '{"name":"my-app"}\n');
      writeFileSync(join(leaf, 'package-lock.json'), '{}\n');

      const probesBefore = mockSpawnSync.mock.calls.length;
      expect(isBwfResolvableFrom(leaf)).toBe(false);
      expect(mockSpawnSync.mock.calls.length).toBe(probesBefore);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  // Decision: Yarn workspace members may carry their own Corepack pin and still use the root `.pnp.cjs`.
  it('still walks to an ancestor `.pnp.cjs` when a subpackage has only a `packageManager` pin (no lockfile)', () => {
    const outer = mkdtempSync(join(tmpdir(), 'platform-init-pnp-pkgmgr-ws-'));
    try {
      writeFileSync(join(outer, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(outer, '.yarn'), { recursive: true });
      writeFileSync(join(outer, '.yarn', 'install-state.gz'), '');
      const sub = join(outer, 'packages', 'app');
      mkdirSync(sub, { recursive: true });
      writeFileSync(
        join(sub, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.5.3' }, null, 2) + '\n',
      );
      mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

      expect(isBwfResolvableFrom(sub)).toBe(true);
      expect(probeCalls('cjs')).toBe(1);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

// Decision: An outer `.pnp.cjs` in NODE_OPTIONS would resolve a leaf project's deps through the wrong
// graph.
describe('buildDrizzleKitSpawnEnv leaf-managed gate', () => {
  it('does not inject NODE_OPTIONS for a leaf project with a local lockfile inside a Yarn PnP monorepo', () => {
    const outer = mkdtempSync(join(tmpdir(), 'platform-init-env-leaf-lock-'));
    const savedNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
    try {
      writeFileSync(join(outer, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(outer, '.yarn'), { recursive: true });
      writeFileSync(join(outer, '.yarn', 'install-state.gz'), '');
      const leaf = join(outer, 'scratch', 'my-app');
      mkdirSync(leaf, { recursive: true });
      writeFileSync(join(leaf, 'package.json'), '{"name":"my-app"}\n');
      writeFileSync(join(leaf, 'package-lock.json'), '{}\n');

      const env = buildDrizzleKitSpawnEnv(leaf);
      expect(env.NODE_OPTIONS).toBeUndefined();
    } finally {
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('still injects NODE_OPTIONS for a workspace subpackage that only has a `packageManager` pin', () => {
    const outer = mkdtempSync(join(tmpdir(), 'platform-init-env-pkgmgr-ws-'));
    const savedNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
    try {
      writeFileSync(join(outer, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(outer, '.yarn'), { recursive: true });
      writeFileSync(join(outer, '.yarn', 'install-state.gz'), '');
      const sub = join(outer, 'packages', 'app');
      mkdirSync(sub, { recursive: true });
      writeFileSync(
        join(sub, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.5.3' }, null, 2) + '\n',
      );

      const env = buildDrizzleKitSpawnEnv(sub);
      expect(env.NODE_OPTIONS).toBeDefined();
      expect(env.NODE_OPTIONS).toContain(JSON.stringify(toSlash(join(outer, '.pnp.cjs'))));
    } finally {
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('still injects NODE_OPTIONS when local PnP files exist alongside a lockfile (local PnP precedence)', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-env-local-pnp-'));
    const savedNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');

      const env = buildDrizzleKitSpawnEnv(root);
      expect(env.NODE_OPTIONS).toBeDefined();
      expect(env.NODE_OPTIONS).toContain('--require');
      expect(env.NODE_OPTIONS).toContain(JSON.stringify(toSlash(join(root, '.pnp.cjs'))));
    } finally {
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('isScaffoldableEmptyProject', () => {
  it('returns true for an empty directory', () => {
    withTempDir((root) => {
      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it('returns true for npm install -D void shape', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            devDependencies: {
              '@builtbyfriends/bwf': '^0.0.1',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'package-lock.json'), '{}\n');

      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it('returns true for pnpm add -D void shape with generated pnpm-workspace.yaml', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            devDependencies: {
              '@builtbyfriends/bwf': '^0.8.9',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(
        join(root, 'pnpm-workspace.yaml'),
        [
          'allowBuilds:',
          '  better-sqlite3: set this to true or false',
          '  esbuild: set this to true or false',
          '  sharp: set this to true or false',
          '  workerd: set this to true or false',
          'minimumReleaseAgeExclude:',
          '  - platform@0.8.9',
          '',
        ].join('\n'),
      );
      mkdirSync(join(root, 'node_modules', '@builtbyfriends', 'bwf'), { recursive: true });
      writeFileSync(
        join(root, 'node_modules', '@builtbyfriends', 'bwf', 'package.json'),
        '{"name":"platform"}\n',
      );

      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it('returns true when only void and the React plugin are installed', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            devDependencies: {
              '@builtbyfriends/bwf': '^0.2.3',
              '@vitejs/plugin-react': '^6.3.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it('returns false when pnpm-workspace.yaml declares workspace packages', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            devDependencies: {
              '@builtbyfriends/bwf': '^0.8.9',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      expect(isScaffoldableEmptyProject(root)).toBe(false);
    });
  });

  it('returns true for a deleted starter that only has manifest and generated state left', () => {
    withTempDir((root) => {
      mkdirSync(join(root, '.bwf'), { recursive: true });
      mkdirSync(join(root, '.wrangler'), { recursive: true });
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({}) + '\n');
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'deleted-starter',
            private: true,
            type: 'module',
            scripts: {
              dev: 'vp dev',
              build: 'vp build',
              preview: 'vp preview',
              postinstall: 'bwf prepare',
            },
            dependencies: {
              hono: '^4.11.9',
              react: '^19.2.4',
            },
            devDependencies: {
              '@builtbyfriends/bwf': '^0.2.3',
              '@vitejs/plugin-react': '^6.3.0',
              vite: '^8.0.10',
              'vite-plus': '^0.1.21',
              typescript: '^7.0.2',
            },
          },
          null,
          2,
        ) + '\n',
      );

      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it('replaces stale vp starter scripts when plain Vite is selected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'stale-vp-starter',
            scripts: {
              dev: 'vp dev',
              build: 'vp build',
              preview: 'vp preview',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('vite').mockResolvedValueOnce('spa');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.scripts).toMatchObject({
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview',
      });
      expect(pkg.devDependencies.vite).toBe('^8.0.10');
      expect(pkg.devDependencies['vite-plus']).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when app files already exist', () => {
    withTempDir((root) => {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'main.ts'), "console.log('x');\n");
      expect(isScaffoldableEmptyProject(root)).toBe(false);
    });
  });

  it('returns false when package has non-starter dependencies', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            devDependencies: {
              '@builtbyfriends/bwf': '^0.0.1',
              express: '^4.18.0',
            },
          },
          null,
          2,
        ) + '\n',
      );

      expect(isScaffoldableEmptyProject(root)).toBe(false);
    });
  });

  it('scaffolds a React SPA starter with D1 in an empty directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.dependencies.react).toBeDefined();
      expect(pkg.dependencies['react-dom']).toBeDefined();
      expect(pkg.dependencies.hono).toBeDefined();
      expect(pkg.devDependencies.vite).toBe(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite);
      expect(pkg.devDependencies['vite-plus']).toBe(
        SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus'],
      );
      expect(pkg.devDependencies['@builtbyfriends/bwf']).toBeDefined();
      expect(pkg.devDependencies.typescript).toBeDefined();
      expect(pkg.devDependencies['@vitejs/plugin-react']).toBeDefined();
      expect(pkg.devDependencies['@types/react']).toBeDefined();
      expect(pkg.devDependencies['@types/react-dom']).toBeDefined();
      expect(pkg.scripts.dev).toBe('vp dev');
      expect(pkg.scripts.build).toBe('vp build');
      expect(pkg.scripts.preview).toBe('vp preview');
      expect(pkg.scripts.postinstall).toBe('bwf prepare');

      const reactViteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
      expect(reactViteConfig).toContain('from "@vitejs/plugin-react"');
      expect(reactViteConfig).toContain('plugins: [react(), bwfPlugin()]');
      expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('src="/src/main.tsx"');
      expect(readFileSync(join(root, 'src', 'main.tsx'), 'utf8')).toContain('import "./style.css"');
      const page = readFileSync(join(root, 'src', 'App.tsx'), 'utf8');
      expect(page).toContain('Welcome to bwf');
      expect(page).toContain('The list below is loaded from');
      expect(page).toContain('href="/api/hello"');
      expect(page).toContain('src="/react.svg"');
      expect(page).toContain('fetch("/api/messages")');
      expect(readFileSync(join(root, 'src', 'style.css'), 'utf8')).toContain(
        'prefers-color-scheme: dark',
      );
      expect(readFileSync(join(root, 'src', 'vite-env.d.ts'), 'utf8')).toContain(
        'reference types="vite/client"',
      );
      expect(readFileSync(join(root, 'public', 'bwf.svg'), 'utf8')).toContain('<svg');
      expect(readFileSync(join(root, 'public', 'react.svg'), 'utf8')).toContain('<svg');
      expect(readFileSync(join(root, 'public', 'stack.svg'), 'utf8')).toContain('<svg');
      expect(page).toContain('src="/stack.svg"');
      expect(readFileSync(join(root, 'public', 'icons.svg'), 'utf8')).toContain(
        'id="documentation-icon"',
      );
      expect(readFileSync(join(root, 'routes', 'api', 'messages.ts'), 'utf8')).toContain(
        'import { messages } from "@schema";',
      );
      expect(readFileSync(join(root, 'routes', 'api', 'hello.ts'), 'utf8')).toContain(
        'export const GET = defineHandler',
      );
      expect(readFileSync(join(root, 'db', 'schema.ts'), 'utf8')).toContain(
        'from "@builtbyfriends/bwf/schema-d1"',
      );
      expect(readFileSync(join(root, 'db', 'seed.ts'), 'utf8')).toContain('defineSeed');
      expect(listMigrationSqlFiles(root)).toEqual(['0000_generated.sql']);
      expect(readFileSync(join(root, 'db', 'migrations', '0000_generated.sql'), 'utf8')).toContain(
        'CREATE TABLE',
      );
      expect(
        readFileSync(join(root, 'db', 'migrations', 'meta', '_journal.json'), 'utf8'),
      ).toContain('"entries"');

      expect(() => readFileSync(join(root, 'routes', 'api', 'hello.get.ts'), 'utf8')).toThrow(
        /ENOENT/,
      );
      expect(readConfig(root)).toEqual({
        routing: { typedRoutes: true },
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        },
      });
      expect(() =>
        readFileSync(join(root, 'db', 'migrations', '0000_initial.sql'), 'utf8'),
      ).toThrow(/ENOENT/);

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
      expect(tsconfig.compilerOptions.jsx).toBe('react-jsx');
      expect(tsconfig.include).toContain('src');
      expect(tsconfig.include).toContain('db');

      expect(mockLogInfo).toHaveBeenCalledWith('Empty project detected. Creating a React starter.');
      expect(mockLogInfo).not.toHaveBeenCalledWith('Using default D1 (SQLite) configuration');
      expect(mockLogInfo).not.toHaveBeenCalledWith(expect.stringContaining('skipping demo'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scaffolds an SPA-only starter without database files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('spa');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.dependencies.react).toBeDefined();
      expect(pkg.dependencies['react-dom']).toBeDefined();
      expect(pkg.dependencies.hono).toBeDefined();
      expect(pkg.devDependencies['@builtbyfriends/bwf']).toBeDefined();
      expect(pkg.devDependencies['@vitejs/plugin-react']).toBeDefined();
      expect(pkg.devDependencies['vite-plus']).toBe(
        SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus'],
      );
      expect(pkg.devDependencies.vite).toBe(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite);
      expect(pkg.packageManager).toBeUndefined();
      expectPnpmAllowBuilds(root);
      expect(detectProjectState(root).packageManager).toBe('pnpm');
      expect(installerOf(installCalls()[0]!)).toBe('vp');
      expect(pkg.scripts.dev).toBe('vp dev');

      const page = readFileSync(join(root, 'src', 'App.tsx'), 'utf8');
      expect(page).toContain('Welcome to bwf');
      expect(page).toContain('This starter is a React single-page app with no backend yet.');
      expect(page).toContain('features.');
      expect(page).not.toContain('href="/api/hello"');
      expect(page).not.toContain('@builtbyfriends/bwf/client');

      expect(() => readFileSync(join(root, 'routes', 'api', 'messages.ts'), 'utf8')).toThrow();
      expect(() => readFileSync(join(root, 'routes', 'api', 'hello.ts'), 'utf8')).toThrow();
      expect(() => readFileSync(join(root, 'db', 'schema.ts'), 'utf8')).toThrow();
      expect(() => readFileSync(join(root, 'db', 'seed.ts'), 'utf8')).toThrow();
      expect(() =>
        readFileSync(join(root, 'db', 'migrations', '0000_generated.sql'), 'utf8'),
      ).toThrow();
      expect(readConfig(root)).toEqual({
        routing: { typedRoutes: true },
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['npm@11.20.0', 'pnpm@10.34.4', 'yarn@4.5.3', 'bun@1.1.42'])(
    'preserves %s when scaffolding with Vite+',
    async (packageManager) => {
      const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
      try {
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify({ private: true, packageManager }),
        );
        mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('spa');
        mockConfirm.mockResolvedValueOnce(false);

        await runInitCommand(root);

        expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager).toBe(
          packageManager,
        );
        expect(detectProjectState(root).packageManager).toBe(packageManager.split('@')[0]);
        expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(
          packageManager.startsWith('pnpm@'),
        );
        expect(installerOf(installCalls()[0]!)).toBe('vp');
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        expect(pkg.devDependencies.vite).toBe(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite);
        if (packageManager.startsWith('npm@')) {
          expect(pkg.overrides.vite).toBe('$vite');
        } else if (packageManager.startsWith('bun@')) {
          expect(pkg.overrides.vite).toBe(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite);
        } else if (packageManager.startsWith('yarn@')) {
          expect(pkg.resolutions.vite).toBe(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['package-lock.json', 'yarn.lock', 'bun.lock'])(
    'preserves %s without switching a Vite+ starter to pnpm',
    async (lockfile) => {
      const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
      try {
        writeFileSync(join(root, lockfile), '');
        mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('spa');
        mockConfirm.mockResolvedValueOnce(false);

        await runInitCommand(root);

        expect(
          JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager,
        ).toBeUndefined();
        expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(false);
        expect(installerOf(installCalls()[0]!)).toBe('vp');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('prompts for the scaffold toolchain after pnpm add -D void creates pnpm-workspace.yaml', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            devDependencies: {
              '@builtbyfriends/bwf': '^0.8.9',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(
        join(root, 'pnpm-workspace.yaml'),
        [
          'allowBuilds:',
          '  better-sqlite3: set this to true or false',
          '  esbuild: set this to true or false',
          '  sharp: set this to true or false',
          '  workerd: set this to true or false',
          'minimumReleaseAgeExclude:',
          '  - platform@0.8.9',
          '',
        ].join('\n'),
      );
      mkdirSync(join(root, 'node_modules', '@builtbyfriends', 'bwf'), { recursive: true });
      writeFileSync(
        join(root, 'node_modules', '@builtbyfriends', 'bwf', 'package.json'),
        '{"name":"platform"}\n',
      );

      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('spa');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.scripts.dev).toBe('vp dev');
      expect(pkg.devDependencies['vite-plus']).toBe(
        SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus'],
      );
      expect(pkg.devDependencies['@builtbyfriends/bwf']).toBe('^0.8.9');
      expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toContain(
        'plugins: [react(), bwfPlugin()]',
      );
      expectPnpmAllowBuilds(root);

      expect(mockSelect.mock.calls[0]?.[0].message).toBe('Choose a scaffold toolchain:');
      expect(mockSelect.mock.calls[0]?.[0].initialValue).toBe('vite-plus');
      expect(mockSelect.mock.calls[1]?.[0].message).toBe('Choose a starter:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('offers to scaffold in a subfolder from a non-project parent directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      mkdirSync(join(root, 'existing-project'));
      mockSelect
        .mockResolvedValueOnce('subfolder')
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('spa');
      mockText.mockResolvedValueOnce('my-new-app');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(existsSync(join(root, 'package.json'))).toBe(false);
      expect(existsSync(join(root, 'vite.config.ts'))).toBe(false);

      const appRoot = join(root, 'my-new-app');
      const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
      expect(pkg.devDependencies['vite-plus']).toBe(
        SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus'],
      );
      expect(pkg.scripts.dev).toBe('vp dev');
      expect(readFileSync(join(appRoot, 'src', 'App.tsx'), 'utf8')).toContain('Welcome to bwf');

      const locationPrompt = mockSelect.mock.calls[0]?.[0];
      expect(locationPrompt.message).toBe('This folder is not empty. Where should bwf initialize?');
      expect(locationPrompt.initialValue).toBe('subfolder');
      expect(mockText).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'New project folder name:',
          placeholder: 'my-platform-app',
          defaultValue: 'my-platform-app',
        }),
      );
      const folderPrompt = mockText.mock.calls[0]![0];
      expect(folderPrompt).not.toHaveProperty('initialValue');
      expect(folderPrompt.validate('')).toBeUndefined();
      expect(folderPrompt.validate(' ')).toBe('Enter a folder name.');
      mkdirSync(join(root, 'my-platform-app'));
      expect(folderPrompt.validate('')).toBe('That folder already exists.');
      expect(folderPrompt.validate('another-app')).toBeUndefined();
      expectVpInstall(toSlash(appRoot));
      expect(String(mockOutro.mock.calls.at(-1)?.[0])).toContain(
        'Run `cd my-new-app && vp dev` to start developing.',
      );
    } finally {
      cwd.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can continue configuring a non-project parent directory when requested', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      mkdirSync(join(root, 'existing-project'));
      mockSelect.mockResolvedValueOnce('current').mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.type).toBe('module');
      expect(pkg.devDependencies['@builtbyfriends/bwf']).toBeDefined();
      expect(pkg.scripts.dev).toBe('vite');
      expect(existsSync(join(root, 'vite.config.ts'))).toBe(true);
      expect(mockText).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('configures an existing package without forcing it to ESM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.type).toBeUndefined();
      expect(pkg.scripts.dev).toBe('vite');
      expect(pkg.scripts.build).toBe('vite build');
      expect(pkg.devDependencies['@builtbyfriends/bwf']).toBeDefined();
      expect(pkg.devDependencies.vite).toBe('^8.0.10');

      expect(existsSync(join(root, 'vite.config.ts'))).toBe(false);
      const viteConfig = readFileSync(join(root, 'vite.config.mts'), 'utf8');
      expect(viteConfig).toContain('import { bwfPlugin } from "@builtbyfriends/bwf";');
      expect(viteConfig).toContain('plugins: [bwfPlugin()]');
      expect(mockConfirm).toHaveBeenCalledWith({
        message: 'Create .github/workflows/bwf-deploy.yml to deploy on pushes to main?',
      });
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'npm',
        ['install'],
        expect.objectContaining({
          cwd: root,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scaffolds an OIDC deploy workflow with a BWF_PROJECT placeholder when no project is linked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );

      await runInitCommand(root, { github: true, tsconfig: false });

      const yaml = readFileSync(join(root, '.github', 'workflows', 'bwf-deploy.yml'), 'utf8');
      expect(yaml).not.toContain('secrets.BWF_TOKEN');
      expect(yaml).toContain('id-token: write');
      expect(yaml).toContain('contents: read');
      expect(yaml).toContain('BWF_PROJECT: ${{ vars.BWF_PROJECT }}');
      expect(yaml).toContain(
        "BWF_API_URL: ${{ vars.BWF_API_URL || 'https://platform.buildwithfriends.dev' }}",
      );
      expect(yaml).toContain('npx bwf deploy --platform bwf --project "$BWF_PROJECT"');
      expect(yaml.match(/deploy --platform bwf --project "\$BWF_PROJECT"/g)).toHaveLength(1);
      expect(yaml).toContain('concurrency:');
      expect(yaml).toContain('group: platform-deploy-${{ github.repository }}-${{ github.ref }}');
      expect(yaml).toContain('cancel-in-progress: true');
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Set a BWF_PROJECT repository variable'),
        'GitHub Actions OIDC deploy',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bakes the linked project slug into the OIDC deploy workflow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );
      mkdirSync(join(root, '.bwf'), { recursive: true });
      writeFileSync(
        join(root, '.bwf', 'project.json'),
        JSON.stringify({ projectId: 'prj_123', slug: 'my-app' }, null, 2) + '\n',
      );

      await runInitCommand(root, { github: true, tsconfig: false });

      const yaml = readFileSync(join(root, '.github', 'workflows', 'bwf-deploy.yml'), 'utf8');
      expect(yaml).toContain('BWF_PROJECT: my-app');
      expect(yaml).not.toContain('vars.BWF_PROJECT');
      expect(yaml).toContain('concurrency:');
      expect(yaml).toContain('group: platform-deploy-${{ github.repository }}-${{ github.ref }}');
      expect(yaml).toContain('cancel-in-progress: true');
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('"my-app"'),
        'GitHub Actions OIDC deploy',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bakes the slug into bwf-deploy.yml when a project is linked during the same interactive init', async () => {
    // Decision: The workflow is written before the project link, so the slug is patched in afterwards.
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'existing-vite-app',
            private: true,
            devDependencies: { vite: '^8.0.0' },
          },
          null,
          2,
        ) + '\n',
      );
      mockGetToken.mockReturnValue('existing_token');
      mockListProjects.mockResolvedValueOnce([
        {
          id: 'proj_789',
          user_id: 'user_1',
          slug: 'linked-app',
          type: 'worker',
          created_at: '2026-03-27T00:00:00.000Z',
          custom_domain: null,
        },
      ]);
      mockSelect
        .mockResolvedValueOnce('none')
        .mockResolvedValueOnce('platform')
        .mockResolvedValueOnce('proj_789');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      await runInitCommand(root);

      expect(JSON.parse(readFileSync(join(root, '.bwf', 'project.json'), 'utf8'))).toEqual({
        applicationDomain: 'void.app',
        platform: 'platform',
        platformUrl: 'https://platform.buildwithfriends.dev',
        proxyUrl: 'https://proxy.void.cloud',
        projectId: 'proj_789',
        slug: 'linked-app',
      });
      const yaml = readFileSync(join(root, '.github', 'workflows', 'bwf-deploy.yml'), 'utf8');
      expect(yaml).toContain('BWF_PROJECT: linked-app');
      expect(yaml).not.toContain('vars.BWF_PROJECT');
      expect(yaml).not.toContain('Set a BWF_PROJECT repository variable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes bwf-deploy.yml and never touches an existing deploy.yml (no migration)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      const existingPath = join(root, '.github', 'workflows', 'deploy.yml');
      const existing = `name: CI
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test
`;
      writeFileSync(existingPath, existing);

      await runInitCommand(root, { github: true, tsconfig: false });

      expect(existsSync(existingPath)).toBe(true);
      expect(readFileSync(existingPath, 'utf8')).toBe(existing);
      const workflows = readdirSync(join(root, '.github', 'workflows')).sort();
      expect(workflows).toEqual(['bwf-deploy.yml', 'deploy.yml']);
      const oidc = readFileSync(join(root, '.github', 'workflows', 'bwf-deploy.yml'), 'utf8');
      expect(oidc).toContain('name: Deploy to bwf');
      expect(oidc).toContain('npx bwf deploy --platform bwf --project "$BWF_PROJECT"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds bwfPlugin to an existing Vite plugins array without replacing scripts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'vite-app',
            scripts: {
              dev: 'custom-dev',
              test: 'vitest',
            },
            devDependencies: {
              vite: '^8.0.10',
              '@builtbyfriends/bwf': '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
  ],
});
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.type).toBeUndefined();
      expect(pkg.scripts.dev).toBe('custom-dev');
      expect(pkg.scripts.build).toBe('vite build');
      expect(pkg.scripts.test).toBe('vitest');

      const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
      expect(viteConfig).toContain('import { bwfPlugin } from "@builtbyfriends/bwf";');
      expect(viteConfig).toContain(`plugins: [
    bwfPlugin(),
    react(),`);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'npm',
        ['install'],
        expect.objectContaining({
          cwd: root,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('patches only the top-level Vite plugins array', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'nested-vite-plugins-app',
            devDependencies: {
              vite: '^8.0.10',
              '@builtbyfriends/bwf': '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

export default defineConfig({
  build: {
    rollupOptions: {
      plugins: [legacy()],
    },
  },
  plugins: [
    react(),
  ],
});
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
      expect(viteConfig).toContain(`rollupOptions: {
      plugins: [legacy()],
    },`);
      expect(viteConfig).toContain(`plugins: [
    bwfPlugin(),
    react(),`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds a top-level Vite plugins property instead of patching nested plugin options', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'nested-vite-no-top-level-plugins-app',
            devDependencies: {
              vite: '^8.0.10',
              '@builtbyfriends/bwf': '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `import { defineConfig } from "vite";
import legacy from "@vitejs/plugin-legacy";

export default defineConfig({
  build: {
    rollupOptions: {
      plugins: [legacy()],
    },
  },
});
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
      expect(viteConfig).toContain(`export default defineConfig({
  plugins: [bwfPlugin()],
  build: {`);
      expect(viteConfig).toContain(`rollupOptions: {
      plugins: [legacy()],
    },`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints a manual Vite config step when an existing config is too dynamic to patch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'dynamic-vite-app',
            devDependencies: {
              vite: '^8.0.10',
              '@builtbyfriends/bwf': '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `const config = buildConfig();

export default config;
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toBe(`const config = buildConfig();

export default config;
`);
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Could not safely update vite.config.ts automatically'),
        'Manual Vite config step',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not patch nested plugin arrays when the top-level Vite config object is dynamic', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'dynamic-nested-vite-app',
            devDependencies: {
              vite: '^8.0.10',
              '@builtbyfriends/bwf': '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `const config = {
  build: {
    rollupOptions: {
      plugins: [legacy()],
    },
  },
};

export default config;
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toBe(`const config = {
  build: {
    rollupOptions: {
      plugins: [legacy()],
    },
  },
};

export default config;
`);
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Add `bwfPlugin()` to the top-level Vite plugins array'),
        'Manual Vite config step',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not run existing-project setup for targeted init flags', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'targeted-app' }, null, 2) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.scripts).toBeUndefined();
      expect(pkg.devDependencies).toBeUndefined();
      expect(existsSync(join(root, 'vite.config.ts'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('coding agent setup', () => {
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    let previousCI: string | undefined;

    beforeEach(() => {
      previousCI = process.env.CI;
      delete process.env.CI;
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => true });
    });

    afterEach(() => {
      if (previousCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCI;
      }
      if (ttyDescriptor) {
        Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      } else {
        Reflect.deleteProperty(process.stdin, 'isTTY');
      }
    });

    it('creates minimal AGENTS.md for a new project without prompting or agent detection', async () => {
      const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
      try {
        await runInitCommand(root, { tsconfig: true, github: false });

        const instructions = readFileSync(join(root, 'AGENTS.md'), 'utf8');
        expect(instructions).toContain('## bwf');
        expect(instructions).toContain('node_modules/@builtbyfriends/bwf/docs/');
        expect(instructions.match(/^- /gm)).toHaveLength(2);
        expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
        expect(mockSelect).not.toHaveBeenCalled();
        expect(mockConfirm).not.toHaveBeenCalled();

        await runInitCommand(root, { tsconfig: true, github: false });
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(instructions);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it.each([false, true])(
      'writes AGENTS.md and preserves CLAUDE.md when Claude is detected (existing AGENTS.md: %s)',
      async (hasAgentsFile) => {
        // Decision: Resolve macOS's /var alias so relative skill symlinks use the fixture's real path.
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'platform-init-')));
        try {
          const claudeInstructions = '# Claude instructions\n\nKeep these instructions.\n';
          const projectInstructions = '# Project instructions\n\nKeep this guidance.\n';
          writeFileSync(join(root, 'CLAUDE.md'), claudeInstructions);
          mkdirSync(join(root, '.claude'));
          mkdirSync(join(root, 'src'));
          if (hasAgentsFile) {
            writeFileSync(join(root, 'AGENTS.md'), projectInstructions);
          }
          mockConfirm.mockResolvedValueOnce(true);

          await runInitCommand(root, { tsconfig: true, github: false });

          const instructions = readFileSync(join(root, 'AGENTS.md'), 'utf8');
          expect(instructions).toContain('## bwf');
          if (hasAgentsFile) {
            expect(instructions.startsWith(projectInstructions)).toBe(true);
          }
          expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(claudeInstructions);
          expect(existsSync(join(root, '.claude/skills/bwf/SKILL.md'))).toBe(true);
          expect(mockSelect).not.toHaveBeenCalled();
          expect(mockConfirm).toHaveBeenCalledExactlyOnceWith({
            message: hasAgentsFile
              ? 'Append bwf instructions to AGENTS.md?'
              : 'Create AGENTS.md with bwf instructions?',
            initialValue: true,
          });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it.each(['prerelease', 'current'])(
      'updates %s agent instructions only after approval',
      async (versionKind) => {
        const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
        try {
          const currentVersion = JSON.parse(
            readFileSync(join(process.cwd(), 'packages/bwf/package.json'), 'utf8'),
          ).version;
          const before = '# Project guidance\n\nKeep this user-authored introduction.\n\n';
          const after = '\n\nKeep this user-authored footer.\n';
          const oldVersion = versionKind === 'current' ? currentVersion : '1.2.3-beta.2+build.7';
          writeFileSync(
            join(root, 'AGENTS.md'),
            `${before}<!--injected-by-platform-v${oldVersion}-->\nStale managed instructions.\n<!--/injected-by-platform-->${after}`,
          );
          mockConfirm.mockResolvedValueOnce(true);

          await runInitCommand(root, { tsconfig: true, github: false });

          const updated = readFileSync(join(root, 'AGENTS.md'), 'utf8');
          expect(updated.startsWith(before)).toBe(true);
          expect(updated.endsWith(after)).toBe(true);
          expect(updated).toContain(`<!--injected-by-platform-v${currentVersion}-->`);
          expect(updated).not.toContain('1.2.3-beta.2+build.7');
          expect(updated).not.toContain('Stale managed instructions.');
          expect(updated).toContain('node_modules/@builtbyfriends/bwf/docs/');
          expect(updated.match(/<!--injected-by-platform-v/g)).toHaveLength(1);
          expect(updated.match(/<!--\/injected-by-platform-->/g)).toHaveLength(1);
          expect(mockConfirm).toHaveBeenCalledExactlyOnceWith({
            message: 'Update bwf instructions in AGENTS.md?',
            initialValue: true,
          });
          await runInitCommand(root, { tsconfig: true, github: false });
          expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(updated);
          expect(mockConfirm).toHaveBeenCalledTimes(1);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it.each([false, true])(
      'preserves existing project instructions when declined (AGENTS.md: %s)',
      async (hasInstructions) => {
        const root = mkdtempSync(join(tmpdir(), 'platform-init-agents-decline-'));
        const original = '# My project\n\nKeep this unchanged.\n';
        try {
          mkdirSync(join(root, 'src'));
          if (hasInstructions) {
            writeFileSync(join(root, 'AGENTS.md'), original);
          }
          mockConfirm.mockResolvedValueOnce(false);
          await runInitCommand(root, { tsconfig: true, github: false });
          expect(mockConfirm).toHaveBeenCalledTimes(1);
          if (hasInstructions) {
            expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(original);
          } else {
            expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it.each(['CI', 'non-TTY'])('does not change existing AGENTS.md in %s', async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'platform-init-agents-headless-'));
      const original = '# Keep my instructions\n';
      try {
        writeFileSync(join(root, 'AGENTS.md'), original);
        if (mode === 'CI') {
          process.env.CI = 'true';
        } else {
          Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => false });
        }
        await runInitCommand(root, { tsconfig: true, github: false });
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(original);
        expect(mockConfirm).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('cancels before appending instructions', async () => {
      const root = mkdtempSync(join(tmpdir(), 'platform-init-agents-cancel-'));
      const original = '# Keep my instructions\n';
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('Cancelled');
      });
      try {
        writeFileSync(join(root, 'AGENTS.md'), original);
        mockConfirm.mockResolvedValueOnce(Symbol.for('cancel'));
        await expect(runInitCommand(root, { tsconfig: true, github: false })).rejects.toThrow(
          'Cancelled',
        );
        expect(exit).toHaveBeenCalledWith(0);
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(original);
      } finally {
        exit.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('creates .gitignore with bwf defaults during targeted setup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      await runInitCommand(root, { tsconfig: true, github: false });

      const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
      expect(gitignore).toContain('node_modules');
      expect(gitignore).toContain('.bwf');
      expect(gitignore).toContain('.wrangler');
      expect(gitignore).toContain('.env');
      expect(gitignore.split('\n')).toContain('.env.*');
      expect(gitignore.split('\n')).not.toContain('!.env.example');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends missing bwf defaults to an existing .gitignore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(join(root, '.gitignore'), 'node_modules\ncustom-cache\n');

      await runInitCommand(root, { tsconfig: true, github: false });

      const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
      expect(gitignore).toContain('custom-cache');
      expect(gitignore).toContain('.bwf');
      expect(gitignore).toContain('.wrangler');
      expect(gitignore).toContain('.env');
      expect(gitignore.match(/^node_modules$/gm)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses tsconfig.json with JSONC comments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'tsconfig.json'),
        `{
  // This is a comment
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true
  }
}\n`,
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
      expect(tsconfig.extends).toBeDefined();
      expect(tsconfig.compilerOptions.types).toContain('@builtbyfriends/bwf/env');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('merges bwf type files and path aliases into root-level tsconfig fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      mkdirSync(join(root, 'routes'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'main.ts'), 'export {};\n');
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(
          {
            extends: './tsconfig.base.json',
            compilerOptions: {
              paths: {
                '@/*': ['src/*'],
              },
            },
            files: ['src/main.ts'],
            include: ['src', 'routes'],
          },
          null,
          2,
        ) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
      expect(tsconfig.extends).toEqual(['./tsconfig.base.json', './.bwf/tsconfig.json']);
      expect(tsconfig.files).toEqual(['./src/main.ts', './.bwf/routes.d.ts']);
      expect(tsconfig.compilerOptions.paths).toEqual({
        '@/*': ['./src/*'],
        '@builtbyfriends/bwf/routes': ['./.bwf/routes.d.ts'],
      });
      expect(tsconfig.compilerOptions.types).toContain('@builtbyfriends/bwf/env');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves directly extended tsconfig files and paths when adding bwf config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      mkdirSync(join(root, 'routes'), { recursive: true });
      writeFileSync(join(root, 'base.d.ts'), 'declare const baseValue: string;\n');
      writeFileSync(
        join(root, 'tsconfig.base.json'),
        JSON.stringify(
          {
            compilerOptions: {
              paths: {
                '~/*': ['./src/*'],
              },
            },
            files: ['base.d.ts'],
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(
          {
            extends: ['./tsconfig.base.json'],
            include: ['src', 'routes'],
          },
          null,
          2,
        ) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
      expect(tsconfig.extends).toEqual(['./tsconfig.base.json', './.bwf/tsconfig.json']);
      expect(tsconfig.files).toEqual(['./base.d.ts', './.bwf/routes.d.ts']);
      expect(tsconfig.compilerOptions.paths).toEqual({
        '~/*': ['./src/*'],
        '@builtbyfriends/bwf/routes': ['./.bwf/routes.d.ts'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes bwf path aliases relative to an inherited baseUrl', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      const root = join(workspaceRoot, 'packages', 'app');
      mkdirSync(join(root, 'routes'), { recursive: true });
      writeFileSync(
        join(workspaceRoot, 'tsconfig.base.json'),
        JSON.stringify(
          {
            compilerOptions: {
              baseUrl: '.',
              paths: {
                '@shared/*': ['shared/*'],
              },
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(
          {
            extends: '../../tsconfig.base.json',
            include: ['src', 'routes'],
          },
          null,
          2,
        ) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
      expect(tsconfig.extends).toEqual(['../../tsconfig.base.json', './.bwf/tsconfig.json']);
      expect(tsconfig.compilerOptions.paths).toEqual({
        '@shared/*': ['./shared/*'],
        '@builtbyfriends/bwf/routes': ['./packages/app/.bwf/routes.d.ts'],
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('merges bwf type files and paths into explicit empty tsconfig override fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      mkdirSync(join(root, 'routes'), { recursive: true });
      writeFileSync(join(root, 'base.d.ts'), 'declare const baseValue: string;\n');
      writeFileSync(
        join(root, 'tsconfig.base.json'),
        JSON.stringify(
          {
            compilerOptions: {
              paths: {
                '~/*': ['./src/*'],
              },
            },
            files: ['base.d.ts'],
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(
          {
            extends: './tsconfig.base.json',
            compilerOptions: {
              paths: {},
            },
            files: [],
            include: ['src', 'routes'],
          },
          null,
          2,
        ) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
      expect(tsconfig.extends).toEqual(['./tsconfig.base.json', './.bwf/tsconfig.json']);
      expect(tsconfig.files).toEqual(['./.bwf/routes.d.ts']);
      expect(tsconfig.compilerOptions.paths).toEqual({
        '@builtbyfriends/bwf/routes': ['./.bwf/routes.d.ts'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the preinstalled adapter to scaffold an empty project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            private: true,
            devDependencies: {
              '@builtbyfriends/bwf': '^0.2.3',
              '@vitejs/plugin-react': '^6.3.0',
              vite: '^8.0.10',
              'vite-plus': '^0.1.21',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.scripts.dev).toBe('vp dev');
      expect(pkg.devDependencies['vite-plus']).toBe(
        SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus'],
      );
      expect(pkg.devDependencies.vite).toBe(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite);
      expect(pkg.devDependencies['@builtbyfriends/bwf']).toBe('^0.2.3');
      expectPnpmAllowBuilds(root);

      expect(mockSelect.mock.calls[0]?.[0].message).toBe('Choose a scaffold toolchain:');
      expect(mockSelect.mock.calls[0]?.[0].initialValue).toBe('vite-plus');
      expect(mockSelect.mock.calls[1]?.[0].message).toBe('Choose a starter:');
      expect(mockSelect).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Choose a framework to scaffold:' }),
      );
      expectVpInstall(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves other bwf.json fields when switching from pg to sqlite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'bwf.json'),
        JSON.stringify(
          {
            database: 'pg',
            routing: {
              prerender: ['/'],
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('sqlite');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readConfig(root)).toEqual({
        routing: {
          prerender: ['/'],
        },
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('keeps database.casing when switching from pg to sqlite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'bwf.json'),
        JSON.stringify({ database: { dialect: 'pg', casing: 'snake_case' } }, null, 2) + '\n',
      );
      mockSelect.mockResolvedValueOnce('sqlite');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readConfig(root)).toEqual({
        database: { casing: 'snake_case' },
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a pg database object with casing when choosing pg', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'bwf.json'),
        JSON.stringify({ database: { dialect: 'pg', casing: 'snake_case' } }, null, 2) + '\n',
      );
      mockSelect.mockResolvedValueOnce('postgresql');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(mockLogInfo).toHaveBeenCalledWith('PostgreSQL already configured in bwf.config.ts');
      expect(readConfig(root).database).toEqual({ dialect: 'pg', casing: 'snake_case' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes the pg config when choosing no database yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(join(root, 'bwf.json'), JSON.stringify({ database: 'pg' }, null, 2) + '\n');
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readConfig(root)).toEqual({
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes a casing-only database config when choosing no database yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'bwf.json'),
        JSON.stringify({ database: { casing: 'snake_case' } }, null, 2) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readConfig(root)).toEqual({
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can log in and create a project during init', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('platform')
        .mockResolvedValueOnce('github');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      mockText.mockResolvedValueOnce('my-live-app');
      mockCreateProject.mockResolvedValueOnce({ id: 'proj_live', slug: 'my-live-app' });

      await runInitCommand(root);

      expect(mockConfirm.mock.calls[1]?.[0]).toMatchObject({
        message: 'Log in now and link or create a bwf project?',
      });
      expect(mockRunLogin).toHaveBeenCalledWith(
        'https://platform.buildwithfriends.dev',
        'github',
        expect.any(Function),
      );
      expect(mockSaveToken).toHaveBeenCalledWith(
        'token_123',
        'https://platform.buildwithfriends.dev',
      );
      expect(mockListProjects).toHaveBeenCalledOnce();
      expect(mockCreateProject).toHaveBeenCalledWith('my-live-app');
      expect(JSON.parse(readFileSync(join(root, '.bwf', 'project.json'), 'utf8'))).toEqual({
        applicationDomain: 'void.app',
        platform: 'platform',
        platformUrl: 'https://platform.buildwithfriends.dev',
        proxyUrl: 'https://proxy.void.cloud',
        projectId: 'proj_live',
        slug: 'my-live-app',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('installs starter dependencies before optional project creation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('platform')
        .mockResolvedValueOnce('github');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      mockText.mockResolvedValueOnce('my-live-app');
      mockCreateProject.mockRejectedValueOnce(new Error('project create failed'));

      await expect(runInitCommand(root)).rejects.toThrow('project create failed');

      expect(installCalls().length).toBeGreaterThan(0);

      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can link an existing project during init without re-authenticating', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      mockGetToken.mockReturnValue('existing_token');
      mockListProjects.mockResolvedValueOnce([
        {
          id: 'proj_456',
          user_id: 'user_1',
          slug: 'existing-app',
          type: 'worker',
          created_at: '2026-03-27T00:00:00.000Z',
          custom_domain: null,
        },
      ]);
      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('platform')
        .mockResolvedValueOnce('proj_456');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      await runInitCommand(root);

      expect(mockConfirm.mock.calls[1]?.[0]).toMatchObject({
        message: 'Link your bwf project now?',
      });
      expect(mockConfirm.mock.calls[2]?.[0]).toMatchObject({
        message:
          'Linking to an existing project. Running `bwf deploy` will overwrite the current deployment of existing-app.void.app. Continue?',
      });
      expect(mockRunLogin).not.toHaveBeenCalled();
      expect(mockSaveToken).not.toHaveBeenCalled();
      expect(mockCreateProject).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(join(root, '.bwf', 'project.json'), 'utf8'))).toEqual({
        applicationDomain: 'void.app',
        platform: 'platform',
        platformUrl: 'https://platform.buildwithfriends.dev',
        proxyUrl: 'https://proxy.void.cloud',
        projectId: 'proj_456',
        slug: 'existing-app',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists skipped deployment setup without prompting for bwf setup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          { name: 'existing-astro-app', private: true, dependencies: { astro: '^5.0.0' } },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('none');

      await runInitCommand(root);

      expect(JSON.parse(readFileSync(join(root, '.bwf', 'project.json'), 'utf8'))).toEqual({
        platform: 'none',
      });
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(mockListProjects).not.toHaveBeenCalled();
      expect(existsSync(join(root, '.github', 'workflows', 'bwf-deploy.yml'))).toBe(false);
      expect(
        mockSpawnSync.mock.calls.some(([, args]) =>
          ['auth.whoami', 'auth.login'].includes(cloudflareOperationType(args) ?? ''),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults the database prompt to D1 when no database is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            devDependencies: {
              '@builtbyfriends/bwf': '^0.0.1',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const databasePrompt = mockSelect.mock.calls[0]?.[0];
      expect(databasePrompt.message).toBe('Choose a database setup for this project:');
      expect(databasePrompt.initialValue).toBe('sqlite');
      expect(databasePrompt.options).toEqual([
        {
          value: 'sqlite',
          label: 'D1 (SQLite)',
          hint: 'Zero-config and fully managed by bwf; best for prototyping and read-heavy apps.',
        },
        {
          value: 'postgresql',
          label: 'PostgreSQL',
          hint: 'Bring your own Postgres via Hyperdrive; best for write-heavy apps, complex queries, or existing infra.',
        },
        {
          value: 'mysql',
          label: 'MySQL',
          hint: 'Bring your own MySQL via Hyperdrive; ideal for existing MySQL infrastructure and compatible providers.',
        },
        {
          value: 'none',
          label: 'No Database Yet',
          hint: 'Skip database setup for now. You can add D1, PostgreSQL, or MySQL later as your app grows.',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips install after demo scaffold when node_modules/@builtbyfriends/bwf is already populated (workspace subpackage)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      // Decision: Without a lockfile init falls back to npm, which rejects `workspace:` specs.
      writeExistingViteApp(root, { bwf: 'workspace:../packages/bwf' });
      writeInstalledBwf(root);

      await runInitWithDemo(root);

      expect(installCalls()).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips install after demo scaffold when void is hoisted at the workspace root (ancestor node_modules)', async () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeInstalledBwf(wsroot);
      const subpkgRoot = join(wsroot, 'subpkg');
      writeExistingViteApp(subpkgRoot, { bwf: 'workspace:../packages/bwf' });

      await runInitWithDemo(subpkgRoot);

      expect(installCalls()).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('runs install after demo scaffold when void resolves from an ancestor but the child package.json was mutated', async () => {
    // Decision: The parent isn't a workspace root, so the child's own lockfile has to pick up the dependency
    // that init adds.
    const parentRoot = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeInstalledBwf(parentRoot);
      const childRoot = join(parentRoot, 'subpkg');
      writeExistingViteApp(childRoot);
      writeFileSync(join(childRoot, 'package-lock.json'), '{}\n');

      await runInitWithDemo(childRoot);

      expectBwfDeclared(childRoot);
      expect(installCalls().length).toBeGreaterThan(0);
      expect(workspaceNotes()).toHaveLength(0);
    } finally {
      rmSync(parentRoot, { recursive: true, force: true });
    }
  });

  it('skips install and starter migration in a fresh workspace subpackage', async () => {
    // Decision: Before the first workspace install, a leaf install rejects `workspace:` specs and drizzle-kit
    // can't resolve `@builtbyfriends/bwf/schema-d1`.
    const wsroot = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      const subpkgRoot = join(wsroot, 'packages', 'app');
      writeExistingViteApp(subpkgRoot, { bwf: 'workspace:*' });

      await runInitWithDemo(subpkgRoot);

      expect(installCalls()).toHaveLength(0);
      expect(drizzleGenerateCalls()).toHaveLength(0);
      expectBwfDeclared(subpkgRoot);
      const notes = workspaceNotes();
      expect(notes.length).toBeGreaterThan(0);
      const body = String(
        notes.find((call) => String(call[0]).includes('Scaffolded the starter demo'))?.[0] ?? '',
      );
      expect(body).toMatch(/Scaffolded the starter demo/);
      expect(body).toMatch(/bwf db generate/);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it.each([
    { marker: 'npm', pattern: 'packages/*', subPath: 'packages/app', member: true },
    { marker: 'pnpm', pattern: './packages/*', subPath: 'packages/app', member: true },
    { marker: 'pnpm', pattern: 'packages/*-app', subPath: 'packages/my-app', member: true },
    { marker: 'pnpm', pattern: '{apps,packages}/*', subPath: 'packages/my-app', member: true },
    { marker: 'pnpm', pattern: '{apps,packages}/*', subPath: 'apps/my-app', member: true },
    { marker: 'npm', pattern: '{apps,packages}/*', subPath: 'apps/web', member: true },
    { marker: 'pnpm', pattern: 'packages/*', subPath: 'scratch/my-app', member: false },
    { marker: 'npm', pattern: 'packages/*', subPath: 'scratch/my-app', member: false },
    { marker: 'pnpm', pattern: 'packages/*-app', subPath: 'packages/other', member: false },
    { marker: 'pnpm', pattern: '{apps,packages}/*', subPath: 'other/my-app', member: false },
  ] as const)(
    'defers install and starter migration only for members ($marker `$pattern`, $subPath)',
    async ({ marker, pattern, subPath, member }) => {
      const wsroot = mkdtempSync(join(tmpdir(), 'platform-init-'));
      try {
        if (marker === 'pnpm') {
          writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), `packages:\n  - '${pattern}'\n`);
        } else {
          writeFileSync(
            join(wsroot, 'package.json'),
            JSON.stringify({ name: 'ws-root', private: true, workspaces: [pattern] }, null, 2) +
              '\n',
          );
        }
        const appRoot = join(wsroot, ...subPath.split('/'));
        writeExistingViteApp(appRoot, { bwf: member ? 'workspace:*' : '^0.0.1' });
        if (!member) {
          writeFileSync(join(appRoot, 'package-lock.json'), '{}\n');
        }

        await runInitWithDemo(appRoot);

        expect(installCalls().length > 0).toBe(!member);
        expect(drizzleGenerateCalls().length > 0).toBe(!member);
        expect(workspaceNotes().length > 0).toBe(member);
      } finally {
        rmSync(wsroot, { recursive: true, force: true });
      }
    },
  );

  it('emits a lockfile-sync note when init adds void to a workspace subpackage with void hoisted', async () => {
    // Decision: The workspace lockfile has to pick up the new entry before the next frozen install.
    const wsroot = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      writeInstalledBwf(wsroot);
      const subpkgRoot = join(wsroot, 'packages', 'my-app');
      writeExistingViteApp(subpkgRoot);

      await runInitWithDemo(subpkgRoot);

      expectBwfDeclared(subpkgRoot);
      expect(installCalls()).toHaveLength(0);
      expect(drizzleGenerateCalls()).toHaveLength(0);
      const notes = workspaceNotes();
      expect(notes.length).toBeGreaterThan(0);
      const body = String(notes[0][0]);
      expect(body).toMatch(/lockfile/);
      expect(body).toMatch(/bwf db generate/);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('runs install after demo scaffold when node_modules/@builtbyfriends/bwf is missing (fresh clone)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeExistingViteApp(root, { bwf: '^0.0.1' });
      writeFileSync(join(root, 'package-lock.json'), '{}\n');

      await runInitWithDemo(root);

      const installs = installCalls();
      expect(installs.length).toBeGreaterThan(0);
      expect(installs[0][0]).toBe('npm');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['postgresql', 'pg', '@builtbyfriends/bwf/schema-pg'],
    ['mysql', 'mysql', '@builtbyfriends/bwf/schema-mysql'],
  ] as const)(
    'scaffolds the demo for the chosen %s database',
    async (dialect, configValue, schemaModule) => {
      const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
      try {
        writeExistingViteApp(root, { bwf: '^0.0.1' });
        mockSelect.mockResolvedValueOnce(dialect);
        mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

        await runInitCommand(root);

        expect(readConfig(root).database).toBe(configValue);
        const schema = readFileSync(join(root, 'db', 'schema.ts'), 'utf8');
        expect(schema).toContain(`from "${schemaModule}"`);
        expect(schema).not.toContain('@builtbyfriends/bwf/schema-d1');
        expect(drizzleGenerateCalls()).toHaveLength(1);
        const drizzleConfig = JSON.parse(
          readFileSync(join(root, '.bwf', 'drizzle.config.json'), 'utf8'),
        );
        expect(drizzleConfig.dialect).toBe(dialect);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['db/schema.ts', 'Project already has a database schema, skipping demo'],
    ['src/demo.ts', 'Project already has src/demo.ts, skipping demo'],
  ])('keeps an existing %s and skips the whole demo', async (existingFile, message) => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeExistingViteApp(root, { bwf: '^0.0.1' });
      const authored = 'export const authored = "keep me";\n';
      mkdirSync(join(root, existingFile, '..'), { recursive: true });
      writeFileSync(join(root, existingFile), authored);
      mockConfirm.mockImplementation((options: { message?: string }) =>
        String(options.message).startsWith('Scaffold demo code?'),
      );

      await runInitCommand(root);

      expect(readFileSync(join(root, existingFile), 'utf8')).toBe(authored);
      expect(mockLogInfo).toHaveBeenCalledWith(message);
      const prompts = mockConfirm.mock.calls.map(([options]) => String(options?.message));
      expect(prompts.some((prompt) => prompt.startsWith('Scaffold demo code?'))).toBe(false);
      for (const demoFile of ['db/schema.ts', 'routes/api/posts.ts', 'src/demo.ts']) {
        if (demoFile !== existingFile) {
          expect(existsSync(join(root, demoFile))).toBe(false);
        }
      }
      expect(drizzleGenerateCalls()).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scaffolds every demo file in a project without a schema', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeExistingViteApp(root, { bwf: '^0.0.1' });

      await runInitWithDemo(root);

      for (const demoFile of ['db/schema.ts', 'routes/api/posts.ts', 'src/demo.ts']) {
        expect(existsSync(join(root, demoFile))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs starter migration with injected PnP NODE_OPTIONS in a Yarn Berry PnP project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeExistingViteApp(root, { bwf: '^0.0.1', packageManager: 'yarn@4.5.3' });
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');

      const savedNodeOptions = process.env.NODE_OPTIONS;
      delete process.env.NODE_OPTIONS;

      mockSpawnSuccess((cwd) => {
        writeFileSync(join(cwd, '.pnp.cjs'), '// pnp stub\n');
        mkdirSync(join(cwd, '.yarn'), { recursive: true });
        writeFileSync(join(cwd, '.yarn', 'install-state.gz'), '');
      });

      try {
        await runInitWithDemo(root);
      } finally {
        if (savedNodeOptions === undefined) {
          delete process.env.NODE_OPTIONS;
        } else {
          process.env.NODE_OPTIONS = savedNodeOptions;
        }
      }

      expect(existsSync(join(root, 'db', 'schema.ts'))).toBe(true);
      const installs = installCalls();
      expect(installs.length).toBeGreaterThan(0);
      expect(installs[0][0]).toBe('yarn');
      expect(existsSync(join(root, '.pnp.cjs'))).toBe(true);

      const drizzleCalls = drizzleGenerateCalls();
      expect(drizzleCalls.length).toBeGreaterThan(0);
      const spawnOptions = drizzleCalls[0][2] as { env?: NodeJS.ProcessEnv };
      expect(spawnOptions.env).toBeDefined();
      expect(typeof spawnOptions.env!.NODE_OPTIONS).toBe('string');
      expect(spawnOptions.env!.NODE_OPTIONS).toContain('--require');
      expect(spawnOptions.env!.NODE_OPTIONS).toContain(
        JSON.stringify(toSlash(join(root, '.pnp.cjs'))),
      );
      expect(existsSync(join(root, 'db', 'migrations', '0000_generated.sql'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs starter migration in a Yarn 4 project with `.yarnrc.yml` but `nodeLinker: node-modules`', async () => {
    // Decision: `.yarnrc.yml` isn't a PnP marker; only `.pnp.cjs` and `.pnp.loader.mjs` are.
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeExistingViteApp(root, { bwf: '^0.0.1', packageManager: 'yarn@4.5.3' });
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      writeFileSync(join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
      mockSpawnSuccess((cwd) => writeInstalledBwf(cwd));

      await runInitWithDemo(root);

      const installs = installCalls();
      expect(installs.length).toBeGreaterThan(0);
      expect(installs[0][0]).toBe('yarn');
      expect(existsSync(join(root, '.pnp.cjs'))).toBe(false);
      expect(drizzleGenerateCalls().length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bwf init in an empty pnpm workspace subpackage skips leaf install and starter migration', async () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      const subpkgRoot = join(wsroot, 'packages', 'my-new-app');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf8'));
      expect(pkg.devDependencies['@builtbyfriends/bwf']).toBeDefined();
      expect(pkg.devDependencies['@vitejs/plugin-react']).toBeDefined();
      expect(installCalls()).toHaveLength(0);
      expect(drizzleGenerateCalls()).toHaveLength(0);
      const notes = workspaceNotes();
      expect(notes.length).toBeGreaterThan(0);
      const body = String(notes[0][0]);
      expect(body).toMatch(/Scaffolded the starter/);
      expect(body).toMatch(/bwf db generate/);
      expect(body).toContain(toSlash(wsroot));
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('omits the `bwf db generate` follow-up in the workspace skip note AND outro for static starter mode', async () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'static-starter');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('spa');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const notes = workspaceNotes();
      expect(notes.length).toBeGreaterThan(0);
      const body = String(notes[0][0]);
      expect(body).not.toMatch(/bwf db generate/);
      expect(body).toMatch(/Run your workspace install/);

      const outroCalls = mockOutro.mock.calls;
      expect(outroCalls.length).toBeGreaterThan(0);
      const outroText = String(outroCalls.at(-1)[0]);
      expect(outroText).not.toMatch(/bwf db generate/);
      expect(outroText).toMatch(/Run your workspace install/);

      expect(drizzleGenerateCalls()).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  // Decision: GitHub reads workflows only from the repository root, even when a member manages its own
  // install.
  it.each(['member', 'local-lockfile', 'local-corepack-pin'] as const)(
    'skips GitHub Actions setup for `bwf init --github` in a workspace subpackage (%s)',
    async (shape) => {
      const wsroot = mkdtempSync(join(tmpdir(), 'platform-init-'));
      try {
        writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

        const subpkgRoot = join(wsroot, 'packages', `leaf-${shape}`);
        mkdirSync(subpkgRoot, { recursive: true });
        const pkgBody: Record<string, unknown> = {
          name: `leaf-${shape}-sub`,
          private: true,
          type: 'module',
        };
        if (shape === 'local-corepack-pin') {
          pkgBody.packageManager = 'bun@1.1.42';
        }
        writeFileSync(join(subpkgRoot, 'package.json'), JSON.stringify(pkgBody, null, 2) + '\n');
        if (shape === 'local-lockfile') {
          writeFileSync(join(subpkgRoot, 'bun.lock'), '');
        }

        await runInitCommand(subpkgRoot, { github: true, tsconfig: false });

        const deployYmlPath = join(subpkgRoot, '.github', 'workflows', 'bwf-deploy.yml');
        expect(existsSync(deployYmlPath)).toBe(false);
      } finally {
        rmSync(wsroot, { recursive: true, force: true });
      }
    },
  );

  it('runs install (does NOT take the workspace skip path) for a starter init when the subpackage has a local `packageManager: bun@…` Corepack pin', async () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'leaf-bun');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'leaf-bun-sub',
            private: true,
            type: 'module',
            packageManager: 'bun@1.1.42',
          },
          null,
          2,
        ) + '\n',
      );

      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const installs = installCalls();
      expect(installs.length).toBeGreaterThan(0);
      expect(installerOf(installs[0]!)).toBe('vp');
      expect(
        JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf8')).packageManager,
      ).toBe('bun@1.1.42');
      expect(workspaceNotes()).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('honors a local `package-lock.json` veto for a yarn-leaf nested under a pnpm workspace', async () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'leaf-managed');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(join(subpkgRoot, 'package-lock.json'), '{}\n');

      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      expect(installCalls().length).toBeGreaterThan(0);
      expect(workspaceNotes()).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('skips GitHub Actions setup when the workspace-subpackage skip path fires', async () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'gha-skip');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await runInitCommand(subpkgRoot);

      const deployYmlPath = join(subpkgRoot, '.github', 'workflows', 'bwf-deploy.yml');
      expect(existsSync(deployYmlPath)).toBe(false);
      expect(workspaceNotes().length).toBeGreaterThan(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('bwf init in an empty STANDALONE app (not a workspace subpackage) still runs install and starter migration', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      const appRoot = join(parent, 'my-app');
      mkdirSync(appRoot, { recursive: true });

      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(appRoot);

      expect(installCalls().length).toBeGreaterThan(0);
      expect(drizzleGenerateCalls().length).toBeGreaterThan(0);
      expect(workspaceNotes()).toHaveLength(0);
      expect(listMigrationSqlFiles(appRoot)).toEqual(['0000_generated.sql']);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('keeps the pnpm build policy and Corepack pin at the root of a pnpm workspace', async () => {
    // Decision: The member has no lockfile or pin, so `detectProjectState` reports npm; pnpm still installs
    // it from the workspace root.
    const wsroot = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      writeFileSync(
        join(wsroot, 'package.json'),
        JSON.stringify(
          { name: 'workspace-root', private: true, packageManager: 'pnpm@^12.4.1' },
          null,
          2,
        ) + '\n',
      );

      const subpkgRoot = join(wsroot, 'packages', 'my-new-app');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf8'));
      expectPnpmAllowBuilds(wsroot);
      expect(pkg.pnpm).toBeUndefined();
      expect(pkg.packageManager).toBeUndefined();
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('writes pnpm allowBuilds without adding a packageManager pin in a standalone pnpm project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expectPnpmAllowBuilds(root);
      expect(pkg.packageManager).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the existing pnpm build approvals when adding the bwf defaults', async () => {
    const roots: Array<string> = [];
    const initWithWorkspaceYaml = async (yaml: string): Promise<string> => {
      const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
      roots.push(root);
      writeExistingViteApp(root);
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(join(root, 'pnpm-workspace.yaml'), yaml);
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
      await runInitCommand(root);
      return readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
    };
    try {
      expect(
        await initWithWorkspaceYaml(
          'allowBuilds:\n  "@parcel/watcher": true\n  better-sqlite3: true\nonlyBuiltDependencies:\n  - bcrypt\n',
        ),
      ).toBe(
        'allowBuilds:\n  "@parcel/watcher": true\n  better-sqlite3: true\n  bcrypt: true\n  core-js-pure: false\n  esbuild: true\n  sharp: true\n  workerd: true\n',
      );
      expect(await initWithWorkspaceYaml('onlyBuiltDependencies:\n- bcrypt\n')).toBe(
        'allowBuilds:\n  bcrypt: true\n  better-sqlite3: false\n  core-js-pure: false\n  esbuild: true\n  sharp: true\n  workerd: true\n',
      );

      const flow = 'allowBuilds: {"@parcel/watcher": true}\n';
      expect(await initWithWorkspaceYaml(flow)).toBe(flow);
      expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining('esbuild: true'));
    } finally {
      for (const root of roots) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('continues without an account when Cloudflare sign-in fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeExistingReactRouterProject(root);
      selectCloudflareDuringInit();
      mockSpawnSync.mockImplementation((_command, args) =>
        cloudflareOperationType(args) === 'auth.login'
          ? { status: 1, stdout: '', stderr: 'Login failed' }
          : cloudflareOperationType(args) === 'auth.whoami'
            ? { status: 1, stdout: '', stderr: 'Not authenticated' }
            : { status: 0, stdout: '', stderr: '' },
      );

      await runInitCommand(root);

      expect(JSON.parse(readFileSync(join(root, '.bwf-wrangler.jsonc'), 'utf8'))).toEqual({});
      expect(
        mockSpawnSync.mock.calls.filter(
          ([, args]) => cloudflareOperationType(args) === 'auth.whoami',
        ),
      ).toHaveLength(1);
      expect(mockLogWarn).toHaveBeenCalledWith(
        'Cloudflare browser sign-in did not complete. Run `bwf cloudflare login` to try again.',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults deployment setup to Cloudflare, opens login, and offers its GitHub workflow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeExistingReactRouterProject(root);
      selectCloudflareDuringInit();
      mockSpawnSync.mockImplementation((_command, args) =>
        cloudflareOperationType(args) === 'auth.whoami'
          ? { status: 1, stdout: '', stderr: 'Not authenticated' }
          : { status: 0, stdout: '', stderr: '' },
      );
      mockConfirm.mockImplementation((options: { message?: string }) => {
        if (
          options.message === 'Create .github/workflows/bwf-deploy.yml to deploy on pushes to main?'
        ) {
          return true;
        }
        return undefined;
      });

      await runInitCommand(root);

      const platformPrompt = mockSelect.mock.calls.find(
        ([options]) => options.message === 'Where should this project deploy?',
      )?.[0];
      expect(platformPrompt).toMatchObject({ initialValue: 'cloudflare' });
      expect(JSON.parse(readFileSync(join(root, '.bwf', 'project.json'), 'utf8'))).toEqual({
        platform: 'cloudflare',
      });
      expect(JSON.parse(readFileSync(join(root, '.bwf-wrangler.jsonc'), 'utf8'))).toEqual({});
      expect(mockSpawnSync).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([
          JSON.stringify({
            type: 'auth.whoami',
            configPath: toSlash(join(root, '.bwf-wrangler.jsonc')),
          }),
        ]),
        expect.objectContaining({ cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }),
      );
      expect(mockSpawnSync).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([JSON.stringify({ type: 'auth.login' })]),
        expect.objectContaining({ cwd: root, stdio: ['inherit', 'inherit', 'inherit'] }),
      );
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Run `bwf connect --platform cloudflare`'),
        'Cloudflare deployment',
      );
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(mockListProjects).not.toHaveBeenCalled();
      expect(readFileSync(join(root, '.github', 'workflows', 'bwf-deploy.yml'), 'utf8')).toContain(
        'bwf deploy --platform cloudflare',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an existing valid Cloudflare account without asking again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeExistingReactRouterProject(root);
      writeFileSync(
        join(root, 'wrangler.jsonc'),
        JSON.stringify(
          { compatibility_date: '2026-01-02', account_id: 'account-2', name: 'my-worker' },
          null,
          2,
        ) + '\n',
      );
      selectCloudflareDuringInit('account-1');
      mockSpawnSync.mockImplementation((_command, args) =>
        cloudflareOperationType(args) === 'auth.whoami'
          ? wranglerWhoamiResult([
              { id: 'account-1', name: 'First account' },
              { id: 'account-2', name: 'Second account' },
            ])
          : { status: 0, stdout: '', stderr: '' },
      );

      await runInitCommand(root);

      expect(mockSelect).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Choose a Cloudflare account:' }),
      );
      expect(JSON.parse(readFileSync(join(root, '.bwf-wrangler.jsonc'), 'utf8'))).toEqual({
        compatibility_date: '2026-01-02',
        account_id: 'account-2',
        name: 'my-worker',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('opens Cloudflare browser login, rereads accounts, and stores the selected account', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeExistingReactRouterProject(root);
      selectCloudflareDuringInit('account-2');
      let whoamiCalls = 0;
      mockSpawnSync.mockImplementation((_command, args) => {
        if (cloudflareOperationType(args) === 'auth.whoami') {
          whoamiCalls++;
          return whoamiCalls === 1
            ? { status: 1, stdout: '', stderr: 'Not authenticated' }
            : wranglerWhoamiResult([
                { id: 'account-1', name: 'First account' },
                { id: 'account-2', name: 'Second account' },
              ]);
        }
        return { status: 0, stdout: '', stderr: '' };
      });

      await runInitCommand(root);

      expect(whoamiCalls).toBe(2);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([JSON.stringify({ type: 'auth.login' })]),
        expect.objectContaining({ cwd: root, stdio: ['inherit', 'inherit', 'inherit'] }),
      );
      const accountPrompt = mockSelect.mock.calls.find(
        ([options]) => options.message === 'Choose a Cloudflare account:',
      )?.[0];
      expect(accountPrompt).toMatchObject({ initialValue: 'account-1' });
      expect(accountPrompt.options).toEqual([
        { value: 'account-1', label: 'First account', hint: 'account-1' },
        { value: 'account-2', label: 'Second account', hint: 'account-2' },
      ]);
      expect(readFileSync(join(root, '.bwf-wrangler.jsonc'), 'utf8')).toContain(
        '"account_id": "account-2"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stores the only authenticated Cloudflare account and preserves Wrangler JSONC', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-init-'));
    try {
      writeExistingReactRouterProject(root);
      writeFileSync(
        join(root, 'wrangler.jsonc'),
        '{\n  // Keep this comment.\n  "name": "existing-worker",\n  "vars": { "EXAMPLE": "yes" }\n}\n',
      );
      selectCloudflareDuringInit();
      mockSpawnSync.mockImplementation((_command, args) =>
        cloudflareOperationType(args) === 'auth.whoami'
          ? wranglerWhoamiResult([{ id: 'account-1', name: 'My account' }])
          : { status: 0, stdout: '', stderr: '' },
      );

      await runInitCommand(root);

      const wrangler = readFileSync(join(root, '.bwf-wrangler.jsonc'), 'utf8');
      expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
      expect(readConfig(root).cloudflare?.name).toBe('existing-worker');
      expect(wrangler).toContain('// Keep this comment.');
      expect(wrangler).toContain('"name": "existing-worker"');
      expect(wrangler).toContain('"EXAMPLE": "yes"');
      expect(wrangler).toContain('"compatibility_date":');
      expect(wrangler).toContain('"account_id": "account-1"');
      expect(mockSpawnSync).not.toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([JSON.stringify({ type: 'auth.login' })]),
        expect.anything(),
      );
      expect(mockSelect).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Choose a Cloudflare account:' }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('detectProjectState', () => {
  // Decision: Without a lockfile, an npm fallback would reject `workspace:` specs or write the wrong
  // lockfile.
  it('prefers package.json#packageManager when no lockfile is present (pnpm)', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'pnpm@10.2.3' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('pnpm');
    });
  });

  it('prefers package.json#packageManager when no lockfile is present (yarn berry pin)', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.0.0' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('yarn');
    });
  });

  it('prefers package.json#packageManager when no lockfile is present (yarn classic pin)', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@1.22.22' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('yarn');
    });
  });

  it('prefers a committed yarn.lock over a Corepack yarn field', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.0.0' }, null, 2) + '\n',
      );
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      expect(detectProjectState(root).packageManager).toBe('yarn');
    });
  });

  it('prefers package.json#packageManager when no lockfile is present (bun)', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'bun@1.1.0' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('bun');
    });
  });

  it('honors the Corepack integrity suffix on the packageManager field', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'pnpm@10.2.3+sha512.abcdef' }, null, 2) +
          '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('pnpm');
    });
  });

  it('prefers a committed lockfile over the packageManager field', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.0.0' }, null, 2) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      expect(detectProjectState(root).packageManager).toBe('pnpm');
    });
  });

  it('falls back to npm when neither lockfile nor packageManager field is present', () => {
    withTempDir((root) => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }, null, 2) + '\n');
      expect(detectProjectState(root).packageManager).toBe('npm');
    });
  });

  it('ignores unrecognized packageManager names', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'cnpm@1.0.0' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('npm');
    });
  });

  it('treats pnpm-workspace.yaml as a pnpm signal when no lockfile is present', () => {
    withTempDir((root) => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }, null, 2) + '\n');
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      expect(detectProjectState(root).packageManager).toBe('pnpm');
    });
  });

  it('prefers a committed yarn.lock over pnpm-workspace.yaml', () => {
    withTempDir((root) => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }, null, 2) + '\n');
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      expect(detectProjectState(root).packageManager).toBe('yarn');
    });
  });
});

describe('generateStarterMigration', () => {
  // Decision: Partial drizzle-kit output would make the next journal coherence check refuse.
  function seedStarterSchema(root: string): void {
    mkdirSync(join(root, 'db'), { recursive: true });
    writeFileSync(
      join(root, 'db', 'schema.ts'),
      'import { sqliteTable } from "@builtbyfriends/bwf/schema-d1";\nexport const messages = sqliteTable("messages", {});\n',
    );
  }

  it('rolls back partial artifacts when drizzle-kit fails and migrations/ did not exist before', () => {
    withTempDir((root) => {
      seedStarterSchema(root);
      mockSpawnSync.mockImplementationOnce((command, args, options) => {
        const cwd = drizzleGenerateCwd(command, args, options);
        if (cwd) {
          const migrationsDir = join(cwd, 'db', 'migrations');
          const metaDir = join(migrationsDir, 'meta');
          mkdirSync(metaDir, { recursive: true });
          writeFileSync(
            join(metaDir, '_journal.json'),
            '{"version":"7","dialect":"sqlite","entries":[',
          );
          writeFileSync(join(metaDir, '0000_snapshot.json'), '{"partial":true');
          writeFileSync(join(migrationsDir, '0000_generated.sql'), '-- partially written sql\n');
        }
        return {
          status: 1,
          stdout: '',
          stderr: 'drizzle-kit: simulated crash',
        };
      });

      expect(() => generateStarterMigration(root, 'sqlite')).toThrow(
        /Failed to generate the starter database migration/,
      );

      expect(existsSync(join(root, 'db', 'migrations', 'meta', '_journal.json'))).toBe(false);
      expect(existsSync(join(root, 'db', 'migrations', 'meta', '0000_snapshot.json'))).toBe(false);
      if (existsSync(join(root, 'db', 'migrations', 'meta'))) {
        expect(readdirSync(join(root, 'db', 'migrations', 'meta'))).toEqual([]);
      }
      const sqlFiles = existsSync(join(root, 'db', 'migrations'))
        ? readdirSync(join(root, 'db', 'migrations')).filter((f) => f.endsWith('.sql'))
        : [];
      expect(sqlFiles).toEqual([]);
    });
  });

  it('restores the journal and keeps prior entries when drizzle-kit fails and a journal existed before', () => {
    withTempDir((root) => {
      seedStarterSchema(root);
      const migrationsDir = join(root, 'db', 'migrations');
      const metaDir = join(migrationsDir, 'meta');
      mkdirSync(metaDir, { recursive: true });

      const originalJournal =
        JSON.stringify(
          {
            version: '7',
            dialect: 'sqlite',
            entries: [{ idx: 0, version: '6', when: 0, tag: '0000_prev', breakpoints: true }],
          },
          null,
          2,
        ) + '\n';
      writeFileSync(join(metaDir, '_journal.json'), originalJournal);
      writeFileSync(
        join(metaDir, '0000_snapshot.json'),
        JSON.stringify({ version: '6', dialect: 'sqlite' }, null, 2) + '\n',
      );
      writeFileSync(
        join(migrationsDir, '0000_prev.sql'),
        'CREATE TABLE existing (id INTEGER PRIMARY KEY);\n',
      );

      mockSpawnSync.mockImplementationOnce((command, args, options) => {
        const cwd = drizzleGenerateCwd(command, args, options);
        if (cwd) {
          const cwdMigrationsDir = join(cwd, 'db', 'migrations');
          const cwdMetaDir = join(cwdMigrationsDir, 'meta');
          writeFileSync(join(cwdMetaDir, '_journal.json'), '{"truncated":true');
          writeFileSync(join(cwdMetaDir, '0001_snapshot.json'), '{"new":"partial"');
          writeFileSync(join(cwdMigrationsDir, '0001_new.sql'), '-- half-written new migration\n');
        }
        return {
          status: 1,
          stdout: '',
          stderr: 'drizzle-kit: simulated crash',
        };
      });

      expect(() => generateStarterMigration(root, 'sqlite')).toThrow(
        /Failed to generate the starter database migration/,
      );

      expect(readFileSync(join(metaDir, '_journal.json'), 'utf8')).toBe(originalJournal);
      expect(existsSync(join(metaDir, '0000_snapshot.json'))).toBe(true);
      expect(existsSync(join(migrationsDir, '0000_prev.sql'))).toBe(true);
      expect(existsSync(join(metaDir, '0001_snapshot.json'))).toBe(false);
      expect(existsSync(join(migrationsDir, '0001_new.sql'))).toBe(false);
    });
  });

  // Decision: cmd.exe would split `C:\Program Files
  // odejs
  // ode.exe` and paths with spaces.
  it('runs drizzle-kit and the Yarn PnP probe without a shell on Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      withTempDir((root) => {
        seedStarterSchema(root);
        writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
        mkdirSync(join(root, '.yarn'), { recursive: true });
        writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
        mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

        generateStarterMigration(root, 'sqlite');
        expect(isBwfResolvableFrom(root)).toBe(true);

        const nodeSpawns = mockSpawnSync.mock.calls.filter(
          ([command]) => command === process.execPath,
        );
        expect(nodeSpawns.map(([, , options]) => Boolean(options.shell))).toEqual([false, false]);
      });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
