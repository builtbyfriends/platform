import type { DatabaseSync } from 'node:sqlite';

export class SqliteMigrationError extends Error {
  constructor(name: string, cause: unknown) {
    super(
      `Migration ${name} could not be applied to a fresh SQLite database: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'SqliteMigrationError';
  }
}

/** Replay migration history without touching an application's database. Caller owns the result. */
export async function openMigrationValidationDatabase(
  migrations: Array<{ name: string; sql: string }>,
): Promise<DatabaseSync> {
  const { DatabaseSync } = await import('node:sqlite');
  // Decision: Reject double-quoted missing columns rather than silently copying string literals.
  const db = new DatabaseSync(':memory:', { enableDoubleQuotedStringLiterals: false });
  try {
    for (const migration of migrations) {
      try {
        db.exec(migration.sql);
      } catch (error) {
        throw new SqliteMigrationError(migration.name, error);
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
