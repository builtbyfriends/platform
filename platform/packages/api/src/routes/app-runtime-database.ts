import { isRecord } from '@builtbyfriends/deploy-core';
import type { ApiEnv } from '../env.ts';
import { OperatorError } from '../operator/common.ts';
import type { Project, Resource } from '../types.ts';
import { proxyRead } from './app-runtime-storage-read.ts';

export type DatabaseFilter = {
  column: string;
  operator: 'equals' | 'contains' | 'is-null';
  value?: string;
};
export type DatabaseSort = { column: string; direction: 'asc' | 'desc' };
type Column = {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: number;
  redacted: boolean;
};
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const secretColumn =
  /password|secret|token|credential|private.?key|verification.?code|api[_-]?key|access[_-]?key/i;
const managedTables = new Set([
  '_void_migrations',
  '_void_migration_attempts',
  '_void_migration_fences',
  '_void_migration_lock',
  '_migrations',
  '__drizzle_migrations',
]);
const customerTable = (name: string) => !managedTables.has(name.toLowerCase());
export const databaseBrowseCapabilities = {
  filterOperators: ['equals', 'contains', 'is-null'],
  sort: true,
} satisfies { filterOperators: Array<DatabaseFilter['operator']>; sort: boolean };
export function validDatabaseFilter(value: unknown): value is DatabaseFilter {
  return (
    isRecord(value) &&
    text(value.column) &&
    Object.keys(value).every((key) => ['column', 'operator', 'value'].includes(key)) &&
    (value.operator === 'is-null'
      ? value.value === undefined
      : (value.operator === 'equals' || value.operator === 'contains') &&
        typeof value.value === 'string' &&
        value.value.length <= 1000)
  );
}
export function validDatabaseSort(value: unknown): value is DatabaseSort {
  return (
    isRecord(value) &&
    text(value.column) &&
    (value.direction === 'asc' || value.direction === 'desc') &&
    Object.keys(value).every((key) => ['column', 'direction'].includes(key))
  );
}
const databaseQuery =
  (env: ApiEnv['Bindings'], project: Project, resource: Resource) =>
  (sql: string, params: Array<string | number> = []) =>
    proxyRead(env, project, resource, '/d1/query', { sql, params, method: 'all' });
type Query = ReturnType<typeof databaseQuery>;
async function tables(query: Query) {
  const result = await query(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name LIMIT 200",
  );
  if (!Array.isArray(result.results)) {
    throw Error('Invalid database response.');
  }
  return result.results
    .map((row: unknown) => {
      if (!isRecord(row) || !text(row.name)) {
        throw Error('Invalid table metadata.');
      }
      return row.name;
    })
    .filter(customerTable);
}
async function columns(query: Query, table: string) {
  if (!customerTable(table) || !(await tables(query)).includes(table)) {
    throw new OperatorError(400, 'Choose a table from this database.');
  }
  const result = await query(`PRAGMA table_xinfo(${quote(table)})`);
  if (!Array.isArray(result.results) || result.results.length > 100) {
    throw Error('This table has too many columns to inspect.');
  }
  const values: Array<Column> = [];
  for (const row of result.results) {
    if (
      !isRecord(row) ||
      !text(row.name) ||
      typeof row.type !== 'string' ||
      row.type.length > 200 ||
      (row.notnull !== 0 && row.notnull !== 1) ||
      !Number.isSafeInteger(row.pk) ||
      Number(row.pk) < 0 ||
      Number(row.pk) > 100 ||
      typeof row.hidden !== 'number' ||
      ![0, 1, 2, 3].includes(row.hidden)
    ) {
      throw Error('Invalid column metadata.');
    }
    if (row.hidden === 1) {
      continue;
    }
    values.push({
      name: row.name,
      type: row.type,
      notNull: row.notnull === 1,
      primaryKey: Number(row.pk),
      redacted: secretColumn.test(row.name),
    });
  }
  if (!values.length) {
    throw Error('No columns are available for this table.');
  }
  return values;
}
export async function databaseSchema(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  table: string,
) {
  return {
    kind: 'table-schema' as const,
    table,
    columns: await columns(databaseQuery(env, project, resource), table),
  };
}
export async function databaseIndexes(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  table: string,
) {
  const query = databaseQuery(env, project, resource);
  const schema = await columns(query, table);
  const listing = await query('PRAGMA table_list');
  if (
    !Array.isArray(listing.results) ||
    !listing.results.some(
      (row: unknown) =>
        isRecord(row) && row.schema === 'main' && row.name === table && row.type === 'table',
    )
  ) {
    throw new OperatorError(400, 'Choose a customer table from this database.');
  }
  // Decision: Table-valued PRAGMAs keep metadata reads bounded without one network request per index; no definition SQL or expression text is selected.
  const result = await query(
    `SELECT l.name, l."unique", l.origin, l.partial,
      (SELECT json_group_array(json_object('name', k.name, 'cid', k.cid, 'desc', k.desc))
       FROM (SELECT name, cid, desc FROM pragma_index_xinfo(l.name) WHERE key = 1 ORDER BY seqno LIMIT 101) AS k) AS keys
     FROM pragma_index_list(?) AS l ORDER BY l.name LIMIT 101`,
    [table],
  );
  if (!Array.isArray(result.results) || result.results.length > 101) {
    throw Error('Invalid index metadata.');
  }
  let truncated = result.results.length > 100;
  const rows: Array<{ id: string; cells: Array<string | boolean> }> = [];
  for (const row of result.results.slice(0, 100)) {
    if (
      !isRecord(row) ||
      !text(row.name) ||
      (row.unique !== 0 && row.unique !== 1) ||
      (row.partial !== 0 && row.partial !== 1) ||
      !['c', 'u', 'pk'].includes(String(row.origin)) ||
      typeof row.keys !== 'string' ||
      row.keys.length > 65_536
    ) {
      throw Error('Invalid index metadata.');
    }
    if (secretColumn.test(row.name)) {
      truncated = true;
      continue;
    }
    const keys: unknown = JSON.parse(row.keys);
    if (!Array.isArray(keys) || !keys.length || keys.length > 101) {
      throw Error('Invalid index columns.');
    }
    if (keys.length > 100) {
      truncated = true;
    }
    const names = keys.slice(0, 100).map((key: unknown) => {
      if (
        !isRecord(key) ||
        !Number.isSafeInteger(key.cid) ||
        Number(key.cid) < -2 ||
        (key.desc !== 0 && key.desc !== 1)
      ) {
        throw Error('Invalid index column.');
      }
      if (key.cid === -2 && key.name === null) {
        return 'Expression (not shown)';
      }
      if (key.cid === -1 && key.name === null) {
        return 'Row ID';
      }
      if (Number(key.cid) < 0) {
        throw Error('Invalid index column.');
      }
      const column = schema.find((entry) => entry.name === key.name);
      if (!column) {
        throw Error('Index column is not in this table.');
      }
      return column.redacted ? '[protected]' : `${column.name}${key.desc === 1 ? ' DESC' : ''}`;
    });
    const joined = names.join(', ');
    if (joined.length > 4096) {
      truncated = true;
    }
    rows.push({
      id: row.name,
      cells: [
        row.name,
        row.unique === 1,
        joined.length > 4096 ? `${joined.slice(0, 4095)}…` : joined,
        row.origin === 'c'
          ? 'Created index'
          : row.origin === 'u'
            ? 'Unique constraint'
            : 'Primary key',
        row.partial === 1 ? 'Partial (condition not shown)' : 'Full table',
      ],
    });
  }
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw Error('Duplicate index metadata.');
  }
  return {
    kind: 'records' as const,
    table,
    checkedAt: Date.now(),
    columns: [
      { id: 'name', label: 'Index' },
      { id: 'unique', label: 'Unique' },
      { id: 'columns', label: 'Columns' },
      { id: 'origin', label: 'Created by' },
      { id: 'coverage', label: 'Coverage' },
    ],
    rows,
    truncated,
  };
}
async function stableOrder(query: Query, table: string, schema: Array<Column>) {
  const result = await query('PRAGMA table_list');
  if (!Array.isArray(result.results)) {
    throw Error('Invalid table metadata.');
  }
  const entry: unknown = result.results.find(
    (row: unknown) => isRecord(row) && row.name === table && row.schema === 'main',
  );
  if (!isRecord(entry) || entry.type !== 'table' || (entry.wr !== 0 && entry.wr !== 1)) {
    return null;
  }
  const primary = schema
    .filter((column) => column.primaryKey > 0)
    .sort((a, b) => a.primaryKey - b.primaryKey);
  const safePrimary = primary.filter((column) => !column.redacted);
  if (entry.wr === 1) {
    return primary.length > 0 && safePrimary.length === primary.length
      ? safePrimary.map((column) => quote(column.name))
      : null;
  }
  // Decision: Nullable primary keys can repeat NULL; an unshadowed rowid breaks ties without sorting secret values.
  const alias = ['rowid', '_rowid_', 'oid'].find(
    (name) => !schema.some((column) => column.name.toLowerCase() === name),
  );
  if (alias) {
    return [...safePrimary.map((column) => quote(column.name)), quote(alias)];
  }
  return primary.length > 0 &&
    safePrimary.length === primary.length &&
    primary.every((column) => column.notNull)
    ? safePrimary.map((column) => quote(column.name))
    : null;
}
export async function databaseInspect(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  input: { table?: string; offset?: number; filter?: DatabaseFilter; sort?: DatabaseSort },
) {
  const query = databaseQuery(env, project, resource);
  if (input.table === undefined) {
    if (input.filter || input.sort) {
      throw new OperatorError(400, 'Choose a table before filtering or sorting.');
    }
    return { kind: 'tables' as const, tables: await tables(query) };
  }
  const schema = await columns(query, input.table);
  for (const choice of [input.filter, input.sort]) {
    if (choice && !schema.some((column) => column.name === choice.column && !column.redacted)) {
      throw new OperatorError(400, 'Choose a visible column for filtering or sorting.');
    }
  }
  const params: Array<string | number> = [];
  let where = '',
    order = '';
  if (input.filter) {
    const column = quote(input.filter.column);
    if (input.filter.operator === 'is-null') {
      where = ` WHERE ${column} IS NULL`;
    } else {
      if (input.filter.value === undefined) {
        throw new OperatorError(400, 'Enter a filter value.');
      }
      params.push(input.filter.value);
      where =
        input.filter.operator === 'equals'
          ? ` WHERE ${column} = ?`
          : ` WHERE instr(CAST(${column} AS TEXT), ?) > 0`;
    }
  }
  if (input.filter || input.sort) {
    const tie = await stableOrder(query, input.table, schema);
    if (!tie) {
      return {
        kind: 'unavailable' as const,
        reason: 'This table has no safe unique row order for filtered or sorted pages.',
      };
    }
    order = ` ORDER BY ${[...(input.sort ? [`${quote(input.sort.column)} ${input.sort.direction === 'asc' ? 'ASC' : 'DESC'}`] : []), ...tie].join(', ')}`;
  }
  const selection = schema
    .map((column) =>
      column.redacted
        ? `'[redacted]' AS ${quote(column.name)}`
        : `CASE WHEN typeof(${quote(column.name)}) = 'blob' THEN '[binary]' WHEN typeof(${quote(column.name)}) = 'text' THEN substr(${quote(column.name)}, 1, 1000) ELSE ${quote(column.name)} END AS ${quote(column.name)}`,
    )
    .join(', ');
  const offset = input.offset ?? 0;
  const pageSize = offset < 10_000 ? Math.min(50, 10_000 - offset) : 50;
  const result = await query(
    `SELECT ${selection} FROM ${quote(input.table)}${where}${order} LIMIT ? OFFSET ?`,
    [...params, pageSize + 1, offset],
  );
  if (!Array.isArray(result.results)) {
    throw Error('Invalid database rows.');
  }
  const rows = result.results.slice(0, pageSize).map((row: unknown) => {
    if (!isRecord(row)) {
      throw Error('Invalid database row.');
    }
    return schema.map((column) => {
      if (column.redacted) {
        return '[redacted]';
      }
      const cell = row[column.name];
      return typeof cell === 'string'
        ? cell.slice(0, 1000)
        : (typeof cell === 'number' && Number.isFinite(cell)) || typeof cell === 'boolean'
          ? cell
          : null;
    });
  });
  return {
    kind: 'rows' as const,
    table: input.table,
    columns: schema.map((column) => column.name),
    rows,
    query: { filter: input.filter, sort: input.sort },
    limitReached: result.results.length > pageSize && offset === 10_000,
    nextOffset: result.results.length > pageSize && offset < 10_000 ? offset + pageSize : null,
  };
}
