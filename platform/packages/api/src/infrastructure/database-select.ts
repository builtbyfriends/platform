import { isRecord } from '@builtbyfriends/deploy-core';
import parse from 'sqlite-parser/dist/sqlite-parser.js';

export class DatabaseQueryError extends Error {}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const name = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('\0');
const fail = (): never => {
  throw new DatabaseQueryError(
    'Use one SELECT from an app table, with public columns, filters, aggregates, sorting and LIMIT.',
  );
};
// Decision: Compile a positive AST subset; neither original SQL nor a general SQL serializer reaches the database.
export function parseDatabaseSelect(sql: string) {
  if (new TextEncoder().encode(sql).length > 8192) {
    fail();
  }
  let parsed: unknown;
  try {
    parsed = parse(sql);
  } catch {
    return fail();
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.statement) || parsed.statement.length !== 1) {
    return fail();
  }
  const statement: unknown = parsed.statement[0];
  if (!isRecord(statement) || statement.type !== 'statement' || statement.variant !== 'select') {
    return fail();
  }
  if (
    Object.keys(statement).some(
      (key) =>
        ![
          'type',
          'variant',
          'result',
          'from',
          'where',
          'group',
          'having',
          'order',
          'limit',
          'distinct',
        ].includes(key),
    )
  ) {
    return fail();
  }
  const source = statement.from;
  if (
    !isRecord(source) ||
    source.type !== 'identifier' ||
    source.variant !== 'table' ||
    !name(source.name) ||
    source.name.includes('.') ||
    (source.alias != null && !name(source.alias)) ||
    Object.keys(source).some((key) => !['type', 'variant', 'name', 'alias'].includes(key))
  ) {
    return fail();
  }
  return {
    statement,
    table: source.name,
    alias: typeof source.alias === 'string' ? source.alias : null,
  };
}
export type QueryColumn = { name: string; redacted: boolean; generated?: boolean };
const operators = new Set([
  '=',
  '!=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  'and',
  'or',
  '+',
  '-',
  '*',
  '/',
  '%',
  '||',
  'like',
  'not like',
  'is',
  'is not',
]);
const aggregates = new Set(['count', 'sum', 'avg', 'min', 'max', 'total']);
const functions = new Set([
  'lower',
  'upper',
  'length',
  'abs',
  'round',
  'coalesce',
  'ifnull',
  'nullif',
]);

export function compileDatabaseSelect(
  parsed: ReturnType<typeof parseDatabaseSelect>,
  schema: Array<QueryColumn>,
) {
  const publicColumns = schema.filter((column) => !column.redacted && !column.generated);
  if (!publicColumns.length || schema.length > 100) {
    return fail();
  }
  const columns = new Map(publicColumns.map((column) => [column.name.toLowerCase(), column.name]));
  const params: Array<string | number> = [];
  let nodes = 0;
  const columnName = (value: string) => {
    for (const prefix of [parsed.table, parsed.alias]) {
      if (prefix && value.startsWith(prefix + '.')) {
        return value.slice(prefix.length + 1);
      }
    }
    return value;
  };
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate each AST expression before compiling its supported fields.
  const expression = (value: unknown, depth = 0): string => {
    if (!isRecord(value) || depth > 12 || ++nodes > 300) {
      return fail();
    }
    const recurse = (child: unknown) => expression(child, depth + 1);
    if (value.type === 'identifier' && value.variant === 'column' && name(value.name)) {
      const column = columns.get(columnName(value.name).toLowerCase());
      return column ? quote(column) : fail();
    }
    if (value.type === 'literal') {
      if (value.variant === 'null') {
        return 'NULL';
      }
      if (
        value.variant === 'text' &&
        typeof value.value === 'string' &&
        value.value.length <= 4096
      ) {
        params.push(value.value);
        return '?';
      }
      if (
        value.variant === 'decimal' &&
        typeof value.value === 'string' &&
        Number.isFinite(Number(value.value))
      ) {
        params.push(Number(value.value));
        return '?';
      }
      return fail();
    }
    if (value.type === 'expression' && value.variant === 'operation') {
      if (
        value.format === 'binary' &&
        typeof value.operation === 'string' &&
        operators.has(value.operation)
      ) {
        return `(${recurse(value.left)} ${value.operation.toUpperCase()} ${recurse(value.right)})`;
      }
      if (value.format === 'unary' && (value.operator === '+' || value.operator === '-')) {
        return `(${value.operator} ${recurse(value.expression)})`;
      }
      return fail();
    }
    if (
      value.type === 'function' &&
      isRecord(value.name) &&
      typeof value.name.name === 'string' &&
      isRecord(value.args)
    ) {
      const called = value.name.name.toLowerCase();
      if (!aggregates.has(called) && !functions.has(called)) {
        return fail();
      }
      if (value.args.variant === 'star' && value.args.name === '*' && called === 'count') {
        return 'COUNT(*)';
      }
      if (
        value.args.variant !== 'list' ||
        !Array.isArray(value.args.expression) ||
        !value.args.expression.length ||
        value.args.expression.length > 8 ||
        (value.args.filter != null && (value.args.filter !== 'distinct' || !aggregates.has(called)))
      ) {
        return fail();
      }
      return `${called.toUpperCase()}(${value.args.filter ? 'DISTINCT ' : ''}${value.args.expression.map(recurse).join(', ')})`;
    }
    return fail();
  };
  const { statement } = parsed;
  if (
    !Array.isArray(statement.result) ||
    !statement.result.length ||
    statement.result.length > 100
  ) {
    return fail();
  }
  const labels = new Set<string>();
  const selected = statement.result.flatMap((value: unknown, index: number) => {
    if (!isRecord(value) || (value.alias != null && !name(value.alias))) {
      return fail();
    }
    if (value.type === 'identifier' && value.variant === 'star' && typeof value.name === 'string') {
      if (value.alias != null || columnName(value.name) !== '*') {
        return fail();
      }
      return publicColumns.map((column) => ({ label: column.name, sql: quote(column.name) }));
    }
    const label =
      typeof value.alias === 'string'
        ? value.alias
        : value.type === 'identifier' && typeof value.name === 'string'
          ? columnName(value.name)
          : `Result ${index + 1}`;
    return [{ label, sql: expression(value) }];
  });
  if (selected.length > 100) {
    return fail();
  }
  for (const column of selected) {
    if (labels.has(column.label.toLowerCase())) {
      throw new DatabaseQueryError('Give result columns unique names with AS.');
    }
    labels.add(column.label.toLowerCase());
  }
  if (statement.distinct != null && statement.distinct !== true) {
    return fail();
  }
  let sql = `SELECT ${statement.distinct ? 'DISTINCT ' : ''}${selected.map((column) => `${column.sql} AS ${quote(column.label)}`).join(', ')} FROM ${quote(parsed.table)}`;
  if (statement.where != null) {
    if (!Array.isArray(statement.where) || statement.where.length !== 1) {
      return fail();
    }
    sql += ` WHERE ${expression(statement.where[0])}`;
  }
  if (statement.group != null) {
    const group = statement.group;
    if (
      !isRecord(group) ||
      !Array.isArray(group.expression) ||
      !group.expression.length ||
      group.expression.length > 20
    ) {
      return fail();
    }
    sql += ` GROUP BY ${group.expression.map((value: unknown) => expression(value)).join(', ')}`;
  }
  if (statement.having != null) {
    sql += ` HAVING ${expression(statement.having)}`;
  }
  if (statement.order != null) {
    if (!Array.isArray(statement.order) || statement.order.length > 10) {
      return fail();
    }
    sql += ` ORDER BY ${statement.order
      .map((value: unknown) => {
        if (
          !isRecord(value) ||
          (value.direction != null && value.direction !== 'asc' && value.direction !== 'desc')
        ) {
          return fail();
        }
        const ref = value.expression;
        const alias =
          isRecord(ref) &&
          ref.type === 'identifier' &&
          typeof ref.name === 'string' &&
          labels.has(ref.name.toLowerCase());
        return `${alias ? quote(String(ref.name)) : expression(ref)} ${value.direction === 'desc' ? 'DESC' : 'ASC'}`;
      })
      .join(', ')}`;
  }
  let limit = 100;
  if (statement.limit != null) {
    const value = statement.limit;
    if (
      !isRecord(value) ||
      value.offset != null ||
      !isRecord(value.start) ||
      value.start.variant !== 'decimal' ||
      typeof value.start.value !== 'string'
    ) {
      return fail();
    }
    const requested = Number(value.start.value);
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > 10000) {
      return fail();
    }
    limit = Math.min(200, requested);
  }
  sql += ' LIMIT ?';
  params.push(limit + 1);
  if (params.length > 100) {
    return fail();
  }
  return { sql, params, columns: selected.map((column) => column.label), limit };
}
