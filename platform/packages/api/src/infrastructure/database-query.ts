import { isRecord } from '@builtbyfriends/deploy-core';
import type { ApiEnv } from '../env.ts';
import { databaseSelectSchema } from '../routes/app-runtime-database.ts';
import { proxyRead } from '../routes/app-runtime-storage-read.ts';
import {
  compileDatabaseSelect,
  DatabaseQueryError,
  parseDatabaseSelect,
} from './database-select.ts';
import type { ResourceCaller } from './resource-operations.ts';

async function tableDefinition(
  env: ApiEnv['Bindings'],
  caller: ResourceCaller,
  table: string,
  signal: AbortSignal,
) {
  const result = await proxyRead(
    env,
    caller.project,
    caller.resource,
    '/d1/query',
    {
      sql: "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1",
      params: [table],
      method: 'all',
    },
    signal,
  );
  const row: unknown = Array.isArray(result.results) ? result.results[0] : null;
  if (!isRecord(row) || typeof row.sql !== 'string' || row.sql.length > 65_536) {
    throw Error('Could not verify the database schema.');
  }
  return row.sql;
}

export async function queryDatabase(env: ApiEnv['Bindings'], caller: ResourceCaller, sql: string) {
  const started = Date.now();
  const signal = AbortSignal.timeout(10_000);
  const parsed = parseDatabaseSelect(sql);
  const definition = await tableDefinition(env, caller, parsed.table, signal);
  const schema = await databaseSelectSchema(
    env,
    caller.project,
    caller.resource,
    parsed.table,
    signal,
  );
  const compiled = compileDatabaseSelect(parsed, schema);
  if (!(await caller.stillAuthorized())) {
    throw Error('This resource changed. Refresh before querying.');
  }
  const result = await proxyRead(
    env,
    caller.project,
    caller.resource,
    '/d1/query',
    {
      sql: compiled.sql,
      params: compiled.params,
      method: 'all',
    },
    signal,
  );
  if ((await tableDefinition(env, caller, parsed.table, signal)) !== definition) {
    throw new DatabaseQueryError('The database schema changed. Run the query again.');
  }
  if (!Array.isArray(result.results) || result.results.length > compiled.limit + 1) {
    throw Error('Invalid query response.');
  }
  let cellsTruncated = false;
  const rows = result.results.slice(0, compiled.limit).map((row: unknown) => {
    if (!isRecord(row)) {
      throw Error('Invalid query response.');
    }
    return compiled.columns.map((column) => {
      const value = row[column];
      if (
        value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      ) {
        return value;
      }
      if (typeof value !== 'string') {
        throw Error('Query results include unsupported binary values.');
      }
      if (value.length <= 4096) {
        return value;
      }
      cellsTruncated = true;
      return value.slice(0, 4096);
    });
  });
  return {
    appId: caller.project.id,
    resourceId: caller.resource.id,
    action: 'database.query',
    kind: 'query-rows' as const,
    columns: compiled.columns,
    rows,
    truncated: result.results.length > compiled.limit,
    cellsTruncated,
    limit: compiled.limit,
    durationMs: Date.now() - started,
  };
}
