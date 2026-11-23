import type { BwfAuthMigrationSchema } from '../auth/drizzle.ts';
import { applyPgAuthMigrations, pgMigrationRunner } from './auth-migrations.ts';
import { createBwfAuthRuntime, resolveConnectionString } from './better-auth-shared.ts';
import type { BwfAuthEnv, BwfAuthRuntimeApi } from './better-auth-shared.ts';
import { disablePgPassFallback } from './pg.ts';

async function applyMigrations(
  env: BwfAuthEnv,
  migrationSchema: BwfAuthMigrationSchema,
): Promise<void> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: resolveConnectionString(env, 'PostgreSQL') });
  disablePgPassFallback(client);
  await client.connect();
  try {
    await applyPgAuthMigrations(pgMigrationRunner(client), migrationSchema);
  } finally {
    await client.end();
  }
}

const runtime = createBwfAuthRuntime('postgresql', applyMigrations);

export const resolveBwfAuthState: BwfAuthRuntimeApi['resolveBwfAuthState'] =
  runtime.resolveBwfAuthState;
export const runBwfAuthMiddleware: BwfAuthRuntimeApi['runBwfAuthMiddleware'] =
  runtime.runBwfAuthMiddleware;
export const handleBwfAuthRequest: BwfAuthRuntimeApi['handleBwfAuthRequest'] =
  runtime.handleBwfAuthRequest;
export const runBwfAuthMigrations: BwfAuthRuntimeApi['runBwfAuthMigrations'] =
  runtime.runBwfAuthMigrations;
