import type { BwfAuthMigrationSchema } from '../auth/drizzle.ts';
import { applySqliteAuthMigrations } from './auth-migrations.ts';
import { createBwfAuthRuntime } from './better-auth-shared.ts';
import type { BwfAuthEnv, BwfAuthRuntimeApi } from './better-auth-shared.ts';

async function applyMigrations(
  env: BwfAuthEnv,
  migrationSchema: BwfAuthMigrationSchema,
): Promise<void> {
  const database = env.DB;
  if (!database) {
    throw new Error('auth: Better Auth requires the "DB" D1 binding for sqlite apps.');
  }

  await applySqliteAuthMigrations(
    {
      async all<T extends Record<string, unknown>>(sql: string) {
        const result = await database.prepare(sql).all();
        return (result.results ?? []) as Array<T>;
      },
      async run(sql: string) {
        await database.prepare(sql).run();
      },
    },
    migrationSchema,
  );
}

const runtime = createBwfAuthRuntime('sqlite', applyMigrations);

export const resolveBwfAuthOptions: BwfAuthRuntimeApi['resolveBwfAuthOptions'] =
  runtime.resolveBwfAuthOptions;
export const resolveBwfAuthState: BwfAuthRuntimeApi['resolveBwfAuthState'] =
  runtime.resolveBwfAuthState;
export const runBwfAuthMiddleware: BwfAuthRuntimeApi['runBwfAuthMiddleware'] =
  runtime.runBwfAuthMiddleware;
export const handleBwfAuthRequest: BwfAuthRuntimeApi['handleBwfAuthRequest'] =
  runtime.handleBwfAuthRequest;
export const runBwfAuthMigrations: BwfAuthRuntimeApi['runBwfAuthMigrations'] =
  runtime.runBwfAuthMigrations;
