import { execSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@voidzero-dev/vite-plus-prompts';

const __dirname = import.meta.dirname;
const platformDir = resolve(__dirname, '..');
const seedSql = resolve(__dirname, 'seed.sql');
const drizzleDir = resolve(__dirname, '../drizzle');
const localDbUrl = 'postgresql://void_dev:void_dev@localhost:5432/void_api_dev';

const force = process.argv.includes('--force');
const adminEmailArgIndex = process.argv.indexOf('--admin-email');
const adminEmailArg =
  adminEmailArgIndex === -1 ? undefined : process.argv[adminEmailArgIndex + 1]?.trim();

function run(cmd: string, cwd: string, input?: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', input }).toString();
}

function pgReady(): boolean {
  try {
    run('pg_isready', platformDir);
    return true;
  } catch {
    return false;
  }
}

function adminUserExists(): boolean {
  try {
    const out = run(
      `psql "${localDbUrl}" -tAc "SELECT id FROM users WHERE id = 'user_admin'" 2>/dev/null`,
      platformDir,
    );
    return out.trim() === 'user_admin';
  } catch {
    return false;
  }
}

function getAdminEmail(): string | null {
  try {
    const out = run(
      `psql "${localDbUrl}" -tAc "SELECT COALESCE(NULLIF(email, ''), NULLIF(login, ''), NULL) FROM users WHERE id = 'user_admin'" 2>/dev/null`,
      platformDir,
    );
    const value = out.trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function validateEmail(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') {
    return 'Email is required.';
  }
  if (!trimmed.includes('@')) {
    return 'Enter an email address.';
  }
  return undefined;
}

async function resolveAdminEmail(): Promise<string> {
  const existingEmail = getAdminEmail() ?? 'admin@localhost';

  if (adminEmailArg !== undefined) {
    const error = validateEmail(adminEmailArg);
    if (error) {
      p.log.error(`Invalid --admin-email value: ${error}`);
      process.exit(1);
    }
    return adminEmailArg;
  }

  const answer = await p.text({
    message: 'Local admin email',
    placeholder: 'you@example.com',
    defaultValue: existingEmail,
    validate: validateEmail,
  });

  if (p.isCancel(answer)) {
    p.cancel('Aborting.');
    process.exit(0);
  }

  return answer.trim();
}

function upsertLocalAdmin(email: string): void {
  const safeEmail = escapeSqlLiteral(email.trim());
  run(
    `psql "${localDbUrl}" -c "INSERT INTO users (id, provider, provider_id, login, email, plan, billing_cycle_start, role, created_at) VALUES ('user_admin', 'google', 'local-admin', '${safeEmail}', '${safeEmail}', 'free', now(), 'admin', now()) ON CONFLICT (id) DO UPDATE SET provider = 'google', login = EXCLUDED.login, email = EXCLUDED.email, role = 'admin'"`,
    platformDir,
  );
}

function upsertLocalEnvFile(
  filePath: string,
  entries: Record<string, string>,
  omitKeys: ReadonlyArray<string> = [],
): void {
  const omitted = new Set(omitKeys);
  const lines = existsSync(filePath)
    ? readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((line) => !omitted.has(/^([A-Z0-9_]+)=/.exec(line)?.[1] ?? ''))
    : [];
  const nextLines = [...lines];
  const seen = new Set<string>();

  for (let i = 0; i < nextLines.length; i++) {
    const line = nextLines[i];
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    if (!(key in entries)) {
      continue;
    }
    nextLines[i] = `${key}=${entries[key]}`;
    seen.add(key);
  }

  for (const [key, value] of Object.entries(entries)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${value}`);
    }
  }

  const normalized = nextLines.filter((line, index, arr) => index < arr.length - 1 || line !== '');
  writeFileSync(filePath, normalized.join('\n') + '\n');
}

function ensureLocalDevVars(): void {
  const apiDevVars = {
    DEV_AUTH_BYPASS: 'true',
    PLATFORM_ENV: 'staging',
    JWT_SECRET: 'dev',
    EMAIL_SIGNING_SECRET: 'dev-email-signing-key-not-for-production',
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: localDbUrl,
  };
  const apiDevVarsPath = resolve(platformDir, '.dev.vars');
  const apiDevVarsExisted = existsSync(apiDevVarsPath);
  upsertLocalEnvFile(apiDevVarsPath, apiDevVars);
  p.log.success(`${apiDevVarsExisted ? 'Updated' : 'Created'} ${apiDevVarsPath}`);

  const dashboardDir = resolve(platformDir, '../dashboard');
  const dashboardEnvPath = resolve(dashboardDir, '.env');
  const legacyDashboardDevVarsPath = resolve(dashboardDir, '.dev.vars');
  if (existsSync(legacyDashboardDevVarsPath)) {
    if (existsSync(dashboardEnvPath)) {
      throw new Error(
        `Both ${dashboardEnvPath} and ${legacyDashboardDevVarsPath} exist. Merge them into .env and remove .dev.vars before setup.`,
      );
    }
    renameSync(legacyDashboardDevVarsPath, dashboardEnvPath);
    p.log.info(`Moved ${legacyDashboardDevVarsPath} to ${dashboardEnvPath}`);
  }
  const dashboardEnvExisted = existsSync(dashboardEnvPath);
  upsertLocalEnvFile(
    dashboardEnvPath,
    {
      API_URL: 'http://localhost:8787',
      SITE_DOMAIN: 'apps.example.com',
    },
    Object.keys(apiDevVars),
  );
  chmodSync(dashboardEnvPath, 0o600);
  p.log.success(`${dashboardEnvExisted ? 'Updated' : 'Created'} ${dashboardEnvPath}`);
}

function showNextSteps(): void {
  p.note(
    [
      'From the repository root:',
      '  1. vp run --filter @platform-service/api dev:admin',
      '  2. Open http://localhost:8787/admin/',
      '  3. For the separate user dashboard: vp run --filter @platform-service/dashboard dev',
    ].join('\n'),
    'Next steps',
  );
}

async function main(): Promise<void> {
  p.intro('Platform local dev setup');

  if (!pgReady()) {
    p.log.error('PostgreSQL is not running. Start it first:');
    p.log.info('  brew services start postgresql@17   # macOS (Homebrew)');
    p.log.info('  sudo systemctl start postgresql     # Linux');
    p.log.info('  docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17');
    p.outro('Aborting.');
    return;
  }

  ensureLocalDevVars();
  const adminEmail = await resolveAdminEmail();

  if (!force && adminUserExists()) {
    upsertLocalAdmin(adminEmail);
    p.log.success(`Configured local admin user: ${adminEmail}`);
    p.log.info('Local dev already set up (admin user exists). Use --force to re-setup.');
    showNextSteps();
    p.outro('Nothing to do.');
    return;
  }

  const s = p.spinner();

  s.start('Creating local database platform_api_dev');
  try {
    run(
      `psql -d postgres -c "CREATE ROLE platform_dev WITH LOGIN PASSWORD 'platform_dev'" 2>/dev/null`,
      platformDir,
    );
  } catch {
    // Decision: The role already exists.
  }
  try {
    run('createdb -O platform_dev platform_api_dev 2>/dev/null', platformDir);
  } catch {
    // Decision: The database already exists.
  }
  // Decision: Ensure platform_dev owns the database even if it was created before the role.
  try {
    run(`psql -d postgres -c "ALTER DATABASE platform_api_dev OWNER TO platform_dev"`, platformDir);
  } catch {}

  try {
    run(`psql "${localDbUrl}" -c "ALTER SCHEMA public OWNER TO platform_dev"`, platformDir);
  } catch {}
  s.stop('Database platform_api_dev ready');

  s.start('Applying migrations');
  const journalPath = resolve(drizzleDir, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  for (const entry of journal.entries) {
    const sqlFile = resolve(drizzleDir, `${entry.tag}.sql`);
    const sql = readFileSync(sqlFile, 'utf8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((stmt: string) => stmt.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      try {
        run(`psql "${localDbUrl}"`, platformDir, stmt);
      } catch {
        // Decision: The table or index already exists.
      }
    }
  }
  run(
    `psql "${localDbUrl}" -c "GRANT USAGE, CREATE ON SCHEMA public TO platform_dev; GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO platform_dev; GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO platform_dev; GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO platform_dev; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO platform_dev; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO platform_dev; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON FUNCTIONS TO platform_dev;"`,
    platformDir,
  );
  s.stop('Applied migrations');

  s.start('Seeding fake data');
  run(`psql "${localDbUrl}" -f "${seedSql}"`, platformDir);
  s.stop('Seeded 5 users, 6 projects, 13 deployments, 7 resources');

  s.start('Creating local admin user');
  upsertLocalAdmin(adminEmail);
  s.stop('Created local admin user');

  p.log.success(`Configured local admin user: ${adminEmail}`);

  showNextSteps();

  p.outro('Done!');
}

void main();
