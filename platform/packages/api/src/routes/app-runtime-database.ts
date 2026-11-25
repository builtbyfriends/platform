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
  generated: boolean;
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
      generated: row.hidden === 2 || row.hidden === 3,
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
    columns: (await columns(databaseQuery(env, project, resource), table)).map(
      ({ generated: _generated, ...column }) => column,
    ),
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
  const offset = input.offset ?? 0;
  const pageSize = offset < 10_000 ? Math.min(50, 10_000 - offset) : 50;
  const primary = schema
    .filter((column) => column.primaryKey > 0)
    .sort((a, b) => a.primaryKey - b.primaryKey);
  const safePrimary = primary.length > 0 && primary.every((column) => !column.redacted);
  const keySize = primary
    .map((column) => `length(CAST(${quote(column.name)} AS BLOB))`)
    .join(' + ');
  const keys = safePrimary
    ? `CASE WHEN ${primary.map((column) => `typeof(${quote(column.name)}) IN ('text', 'integer')`).join(' AND ')} AND (${keySize}) <= 1024 THEN json_array(${primary.map((column) => `json_array(typeof(${quote(column.name)}), hex(CAST(${quote(column.name)} AS BLOB)))`).join(', ')}) ELSE NULL END`
    : 'NULL';
  // Decision: Reserve transport space for type/size metadata and bounded keys before selecting byte prefixes for a whole page.
  const previewBytes = Math.min(1000, Math.floor(98_304 / ((pageSize + 1) * schema.length)));
  const result = await query(
    `SELECT ${cellSelection(schema, previewBytes)} AS cells, ${keys} AS row_key FROM ${quote(input.table)}${where}${order} LIMIT ? OFFSET ?`,
    [...params, pageSize + 1, offset],
  );
  if (!Array.isArray(result.results) || result.results.length > pageSize + 1) {
    throw Error('Invalid database rows.');
  }
  const rows: Array<Array<string | number | null>> = [];
  const cellMetadata: Array<Array<CellMetadata>> = [];
  const rowTokens: Array<string | null> = [];
  const fingerprint = await schemaHash(schema);
  for (const row of result.results.slice(0, pageSize)) {
    if (!isRecord(row) || typeof row.cells !== 'string') {
      throw Error('Invalid database row.');
    }
    const cells = parseCells(row.cells, schema.length);
    rows.push(
      cells.map((cell) =>
        cell.type === 'protected'
          ? '[redacted]'
          : cell.type === 'binary'
            ? '[binary]'
            : cell.type === 'number'
              ? Number(cell.text)
              : cell.text,
      ),
    );
    cellMetadata.push(
      cells.map(({ type, totalBytes, truncated }) => ({ type, totalBytes, truncated })),
    );
    let token: string | null = null;
    if (safePrimary && typeof row.row_key === 'string') {
      const key = parseKey(JSON.parse(row.row_key), primary.length);
      if (key) {
        const payload = JSON.stringify({
          table: input.table,
          schema: fingerprint,
          key,
          expires: Date.now() + 900_000,
        });
        const encoded = encode(new TextEncoder().encode(payload));
        token = encoded + '.' + encode(await signRow(env, project, resource, encoded));
        if (token.length > 8192) {
          token = null;
        }
      }
    }
    rowTokens.push(token);
  }
  return {
    kind: 'rows' as const,
    table: input.table,
    columns: schema.map((column) => column.name),
    rows,
    cellMetadata,
    rowTokens,
    query: { filter: input.filter, sort: input.sort },
    limitReached: result.results.length > pageSize && offset === 10_000,
    nextOffset: result.results.length > pageSize && offset < 10_000 ? offset + pageSize : null,
  };
}

type CellMetadata = {
  type: 'text' | 'number' | 'null' | 'binary' | 'protected';
  totalBytes: number | null;
  truncated: boolean;
};
const encode = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
    char.charCodeAt(0),
  );
async function schemaHash(schema: Array<Column>) {
  return encode(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(schema))),
    ),
  );
}
async function signRow(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  payload: string,
) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(
        JSON.stringify([
          'database-row-v1',
          project.id,
          project.user_id,
          project.proxy_token_gen,
          project.active_deployment_id,
          resource.id,
          resource.cf_id,
          resource.binding_name,
          payload,
        ]),
      ),
    ),
  );
}
function cellSelection(schema: Array<Column>, limit: number) {
  return `json_array(${schema
    .map((column) => {
      if (column.redacted) {
        return "json_array('protected', NULL, '')";
      }
      const value = quote(column.name);
      const bytes = `CASE WHEN typeof(${value}) = 'real' THEN printf('%!.17g', ${value}) ELSE CAST(${value} AS BLOB) END`;
      return `json_array(typeof(${value}), CASE WHEN ${value} IS NULL THEN 0 ELSE length(${bytes}) END, CASE WHEN typeof(${value}) IN ('text', 'integer', 'real') THEN hex(substr(${bytes}, 1, CASE WHEN typeof(${value}) = 'text' THEN ${limit} ELSE 64 END)) ELSE '' END)`;
    })
    .join(', ')})`;
}
function parseCells(value: string, count: number, full = false) {
  const cells: unknown = JSON.parse(value);
  if (!Array.isArray(cells) || cells.length !== count) {
    throw Error('Invalid database cells.');
  }
  return cells.map((cell: unknown): CellMetadata & { text: string | null } => {
    if (!Array.isArray(cell) || cell.length !== 3) {
      throw Error('Invalid database cell.');
    }
    const kind: unknown = cell[0];
    const totalBytes: unknown = cell[1];
    const hex: unknown = cell[2];
    if (typeof kind !== 'string' || typeof hex !== 'string' || !/^(?:[0-9A-F]{2})*$/.test(hex)) {
      throw Error('Invalid database cell.');
    }
    if (kind === 'protected' && totalBytes === null && hex === '') {
      return { type: 'protected', totalBytes: null, truncated: false, text: null };
    }
    if (typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes) || totalBytes < 0) {
      throw Error('Invalid database cell size.');
    }
    if (kind === 'null' && totalBytes === 0 && hex === '') {
      return { type: 'null', totalBytes, truncated: false, text: null };
    }
    if (kind === 'blob' && hex === '') {
      return { type: 'binary', totalBytes, truncated: false, text: null };
    }
    if (!['text', 'integer', 'real'].includes(kind) || hex.length / 2 > totalBytes) {
      throw Error('Invalid database cell type.');
    }
    const bytes = Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, {
      stream: bytes.length < totalBytes,
    });
    if (kind !== 'text') {
      if (!Number.isFinite(Number(decoded))) {
        throw Error('Invalid database number.');
      }
      const unsafeInteger = kind === 'integer' && !Number.isSafeInteger(Number(decoded));
      const text = unsafeInteger ? decoded : String(Number(decoded));
      return {
        type: unsafeInteger && !full ? 'text' : 'number',
        totalBytes: new TextEncoder().encode(text).length,
        truncated: false,
        text,
      };
    }
    return {
      type: 'text',
      totalBytes,
      truncated: new TextEncoder().encode(decoded).length < totalBytes,
      text: decoded,
    };
  });
}
type RowKey = Array<[string, string]>;
function parseKey(value: unknown, count: number): RowKey | null {
  if (!Array.isArray(value) || value.length !== count || count === 0) {
    return null;
  }
  const result: RowKey = [];
  let bytes = 0;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return null;
    }
    const kind: unknown = entry[0];
    const hex: unknown = entry[1];
    if (
      (kind !== 'text' && kind !== 'integer') ||
      typeof hex !== 'string' ||
      !/^(?:[0-9A-F]{2})*$/.test(hex)
    ) {
      return null;
    }
    bytes += hex.length / 2;
    if (bytes > 1024) {
      return null;
    }
    result.push([kind, hex]);
  }
  return result;
}
const unavailableCell = () => ({
  kind: 'unavailable' as const,
  reason:
    'This row or table changed, or its reference expired. Refresh the table and open the value again.',
});
async function cellContext(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  input: { table: string; column: string; rowToken: string },
) {
  const parts = input.rowToken.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
    return null;
  }
  const signature = decode(parts[1]);
  const expected = await signRow(env, project, resource, parts[0]);
  if (
    encode(signature) !== parts[1] ||
    signature.length !== expected.length ||
    signature.reduce((difference, byte, index) => difference | (byte ^ expected[index]), 0) !== 0
  ) {
    return null;
  }
  const payload: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decode(parts[0])),
  );
  if (
    !isRecord(payload) ||
    payload.table !== input.table ||
    typeof payload.schema !== 'string' ||
    typeof payload.expires !== 'number' ||
    payload.expires < Date.now() ||
    payload.expires > Date.now() + 900_000
  ) {
    return null;
  }
  const query = databaseQuery(env, project, resource);
  const schema = await columns(query, input.table);
  const column = schema.find((entry) => entry.name === input.column && !entry.redacted);
  const primary = schema
    .filter((entry) => entry.primaryKey > 0)
    .sort((a, b) => a.primaryKey - b.primaryKey);
  const key = parseKey(payload.key, primary.length);
  if (
    !column ||
    !key ||
    primary.some((entry) => entry.redacted) ||
    payload.schema !== (await schemaHash(schema))
  ) {
    return null;
  }
  const params = key.flatMap(([kind, hex]) => [kind, hex]);
  const where = primary
    .map(
      (entry) => `typeof(${quote(entry.name)}) = ? AND hex(CAST(${quote(entry.name)} AS BLOB)) = ?`,
    )
    .join(' AND ');
  const rowId = encode(
    await signRow(
      env,
      project,
      resource,
      JSON.stringify(['row-id', input.table, payload.schema, key]),
    ),
  );
  return { query, schema, column, params, where, rowId, fingerprint: payload.schema };
}
export async function databaseCell(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  input: { table: string; column: string; rowToken: string },
) {
  const context = await cellContext(env, project, resource, input);
  if (!context) {
    return unavailableCell();
  }
  const { query, schema, column, params, where, rowId, fingerprint } = context;
  const result = await query(
    `SELECT ${cellSelection([column], 65_536)} AS cells FROM ${quote(input.table)} WHERE ${where} LIMIT 2`,
    params,
  );
  if (
    !Array.isArray(result.results) ||
    result.results.length !== 1 ||
    !isRecord(result.results[0]) ||
    typeof result.results[0].cells !== 'string'
  ) {
    return unavailableCell();
  }
  const cell = parseCells(result.results[0].cells, 1, true)[0];
  if (cell.type === 'protected' || cell.totalBytes === null) {
    return unavailableCell();
  }
  if ((await schemaHash(await columns(query, input.table))) !== fingerprint) {
    return unavailableCell();
  }
  const safety =
    cell.type === 'text' && !cell.truncated
      ? await cellWriteSafety(query, input.table, column, schema).catch(() =>
          readonlyCell('Editing is unavailable for this table.'),
        )
      : { reason: 'Only complete text values can be edited here.' };
  return {
    kind: 'cell' as const,
    rowId,
    editable: 'revision' in safety,
    ...('reason' in safety && { reason: safety.reason }),
    table: input.table,
    column: input.column,
    rowToken: input.rowToken,
    valueType: cell.type,
    text: cell.text,
    totalBytes: cell.totalBytes,
    truncated: cell.truncated,
    checkedAt: Date.now(),
  };
}

export function validCellText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 65_536 &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) &&
    new TextEncoder().encode(value).length <= 65_536
  );
}
const readonlyCell = (reason: string) => ({ reason });
// Decision: D1 forbids schema_version; an exact catalog snapshot fences table, index, trigger and relationship changes inside the write.
const schemaRevision = `(SELECT CASE WHEN count(*) <= 256 AND coalesce(sum(length(CAST(coalesce(sql, '') AS BLOB)) + length(CAST(name AS BLOB)) + length(CAST(tbl_name AS BLOB))), 0) <= 131072
  THEN (SELECT json_group_array(json_array(type, name, tbl_name, sql)) FROM (SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name LIMIT 257))
  ELSE NULL END FROM (SELECT name, tbl_name, sql FROM sqlite_schema LIMIT 257))`;
async function cellWriteSafety(query: Query, table: string, column: Column, schema: Array<Column>) {
  if (column.primaryKey || column.redacted || column.generated) {
    return readonlyCell('Primary keys, protected fields and calculated fields are read-only.');
  }
  if (
    /INT/i.test(column.type) ||
    (column.type !== '' && !/CHAR|CLOB|TEXT|BLOB/i.test(column.type))
  ) {
    return readonlyCell('This field can convert text into numbers. Edit it through your app.');
  }
  const snapshot = await query(
    `SELECT
      ${schemaRevision} AS revision,
      (SELECT type FROM pragma_table_list WHERE schema = 'main' AND name = ?1 COLLATE BINARY) AS kind,
      (SELECT count(*) FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?1 COLLATE NOCASE) AS triggers,
      (SELECT json_group_array(json_object('name', name, 'type', type, 'notNull', "notnull", 'pk', pk, 'hidden', hidden)) FROM pragma_table_xinfo(?1)) AS columns,
      (SELECT json_group_array(json_object('partial', l.partial, 'keys', json((SELECT json_group_array(json_object('name', name, 'cid', cid)) FROM (SELECT name, cid FROM pragma_index_xinfo(l.name) WHERE key = 1 LIMIT 101))))) FROM (SELECT name, partial FROM pragma_index_list(?1) WHERE "unique" = 1 LIMIT 101) AS l) AS indexes,
      (SELECT json_group_array(json_object('from', f."from")) FROM (SELECT "from" FROM pragma_foreign_key_list(?1) LIMIT 101) AS f) AS outgoing,
      (SELECT json_group_array(json_object('to', f."to")) FROM (SELECT fk."to" FROM sqlite_schema AS s JOIN pragma_foreign_key_list(s.name) AS fk WHERE s.type = 'table' AND fk."table" = ?1 COLLATE NOCASE LIMIT 101) AS f) AS incoming`,
    [table],
  );
  if (
    !Array.isArray(snapshot.results) ||
    snapshot.results.length !== 1 ||
    !isRecord(snapshot.results[0])
  ) {
    throw Error('Invalid database safety metadata.');
  }
  const row = snapshot.results[0];
  if (
    typeof row.revision !== 'string' ||
    new TextEncoder().encode(row.revision).length > 200_000 ||
    row.kind !== 'table' ||
    !Number.isSafeInteger(row.triggers) ||
    Number(row.triggers) < 0
  ) {
    return readonlyCell('This table cannot be edited here.');
  }
  if (row.triggers !== 0) {
    return readonlyCell('This table has automatic actions. Edit it through your app.');
  }
  const metadata = (name: string): Array<unknown> => {
    const value = row[name];
    if (typeof value !== 'string' || value.length > 200_000) {
      throw Error('Invalid database safety metadata.');
    }
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 100) {
      throw Error('Database safety metadata exceeds this view.');
    }
    return parsed;
  };
  const current = metadata('columns');
  if (
    current.length !== schema.length ||
    !current.every((value, index) => {
      const entry = schema[index];
      return (
        isRecord(value) &&
        value.name === entry.name &&
        value.type === entry.type &&
        value.notNull === Number(entry.notNull) &&
        value.pk === entry.primaryKey &&
        (entry.generated ? value.hidden === 2 || value.hidden === 3 : value.hidden === 0)
      );
    })
  ) {
    return readonlyCell('The table structure changed. Refresh before editing.');
  }
  for (const index of metadata('indexes')) {
    if (
      !isRecord(index) ||
      (index.partial !== 0 && index.partial !== 1) ||
      !Array.isArray(index.keys) ||
      index.keys.length === 0 ||
      index.keys.length > 100
    ) {
      throw Error('Invalid unique-key metadata.');
    }
    if (index.partial) {
      return readonlyCell('This table has a conditional unique key. Edit it through your app.');
    }
    for (const key of index.keys) {
      if (!isRecord(key) || !Number.isSafeInteger(key.cid)) {
        throw Error('Invalid unique-key metadata.');
      }
      const member = schema.find((entry) => entry.name === key.name);
      if (Number(key.cid) < 0 || !member || member.generated) {
        return readonlyCell('This table has a calculated unique key. Edit it through your app.');
      }
      if (member.name === column.name) {
        return readonlyCell('This field is part of a unique key. Edit it through your app.');
      }
    }
  }
  for (const foreign of metadata('outgoing')) {
    if (!isRecord(foreign) || typeof foreign.from !== 'string') {
      throw Error('Invalid relationship metadata.');
    }
    if (foreign.from.toLowerCase() === column.name.toLowerCase()) {
      return readonlyCell('This field links records. Edit it through your app.');
    }
  }
  for (const foreign of metadata('incoming')) {
    if (!isRecord(foreign) || (foreign.to !== null && typeof foreign.to !== 'string')) {
      throw Error('Invalid relationship metadata.');
    }
    if (typeof foreign.to === 'string') {
      const referencedName = foreign.to.toLowerCase();
      const member = schema.find((entry) => entry.name.toLowerCase() === referencedName);
      if (!member || member.generated || member.name === column.name) {
        return readonlyCell('Other records depend on this field. Edit it through your app.');
      }
    }
  }
  return { revision: String(row.revision) };
}
export async function databaseCellSave(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  input: { table: string; column: string; rowToken: string; expectedText: string; text: string },
  stillAuthorized: () => Promise<boolean>,
) {
  const unavailable = (reason: string) => ({ kind: 'unavailable' as const, reason });
  if (!validCellText(input.text) || !validCellText(input.expectedText)) {
    return unavailable('Use valid text of up to 64 KB.');
  }
  const context = await cellContext(env, project, resource, input);
  if (!context) {
    return unavailableCell();
  }
  const { query, schema, column, params, where, rowId } = context;
  const safety = await cellWriteSafety(query, input.table, column, schema);
  if ('reason' in safety) {
    return unavailable(safety.reason);
  }
  if (!(await stillAuthorized())) {
    return unavailable('This resource changed. Refresh before editing.');
  }
  // Decision: One statement fences schema changes and compares exact text bytes; unique/FK/trigger eligibility prevents indirect row changes.
  try {
    const result = await query(
      `UPDATE ${quote(input.table)} SET ${quote(input.column)} = ? WHERE ${where}
       AND typeof(${quote(input.column)}) = 'text' AND CAST(${quote(input.column)} AS BLOB) = CAST(? AS BLOB)
       AND CAST(${schemaRevision} AS BLOB) = CAST(? AS BLOB)
       AND NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE)
       RETURNING ${cellSelection([column], 65_536)} AS cells`,
      [input.text, ...params, input.expectedText, safety.revision, input.table],
    );
    if (!Array.isArray(result.results)) {
      throw Error('Invalid save result.');
    }
    if (result.results.length === 0) {
      return {
        kind: 'conflict' as const,
        reason: 'The value or table changed. Read the latest value before saving again.',
      };
    }
    if (
      result.results.length !== 1 ||
      !isRecord(result.results[0]) ||
      typeof result.results[0].cells !== 'string'
    ) {
      throw Error('Invalid save result.');
    }
    const cell = parseCells(result.results[0].cells, 1, true)[0];
    if (cell.type !== 'text' || cell.truncated || cell.text !== input.text) {
      throw Error('Unexpected saved value.');
    }
    return {
      kind: 'cell-saved' as const,
      table: input.table,
      column: input.column,
      rowToken: input.rowToken,
      rowId,
      text: cell.text,
      checkedAt: Date.now(),
    };
  } catch {
    return {
      kind: 'unknown' as const,
      reason:
        'The save could not be confirmed. Read the latest value before making another change.',
    };
  }
}
