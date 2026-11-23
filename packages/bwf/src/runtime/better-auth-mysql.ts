import type { BwfAuthMigrationSchema } from '../auth/drizzle.ts';
import { applyMySqlAuthMigrations, mysqlMigrationRunner } from './auth-migrations.ts';
import { createBwfAuthRuntime, resolveConnectionString } from './better-auth-shared.ts';
import type { BwfAuthEnv, BwfAuthRuntimeApi } from './better-auth-shared.ts';

async function applyMigrations(
  env: BwfAuthEnv,
  migrationSchema: BwfAuthMigrationSchema,
): Promise<void> {
  const { createConnection } = await import('mysql2/promise');
  const connection = await createConnection({
    uri: resolveConnectionString(env, 'MySQL'),
    disableEval: true,
  });
  try {
    await applyMySqlAuthMigrations(mysqlMigrationRunner(connection), migrationSchema);
  } finally {
    await connection.end();
  }
}

const runtime = createBwfAuthRuntime('mysql', applyMigrations);

export const resolveBwfAuthState: BwfAuthRuntimeApi['resolveBwfAuthState'] =
  runtime.resolveBwfAuthState;
export const runBwfAuthMiddleware: BwfAuthRuntimeApi['runBwfAuthMiddleware'] =
  runtime.runBwfAuthMiddleware;
export const handleBwfAuthRequest: BwfAuthRuntimeApi['handleBwfAuthRequest'] =
  runtime.handleBwfAuthRequest;
export const runBwfAuthMigrations: BwfAuthRuntimeApi['runBwfAuthMigrations'] =
  runtime.runBwfAuthMigrations;
