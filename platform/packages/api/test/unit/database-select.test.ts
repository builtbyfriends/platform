import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vite-plus/test';
import {
  compileDatabaseSelect,
  parseDatabaseSelect,
} from '../../src/infrastructure/database-select.ts';

const schema = [
  { name: 'title', redacted: false },
  { name: 'category', redacted: false },
  { name: 'score', redacted: false },
  { name: 'password', redacted: true },
  { name: 'password_copy', redacted: false, generated: true },
];
const compile = (sql: string) => compileDatabaseSelect(parseDatabaseSelect(sql), schema);

describe('read-only SELECT compiler', () => {
  it('runs grouped, filtered, sorted app queries with bound values and a capped page', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(
        "CREATE TABLE notes(title TEXT, category TEXT, score INTEGER, password TEXT); INSERT INTO notes VALUES ('first','bug',1,'hidden'),('second','bug',3,'hidden'),('third','idea',4,'hidden')",
      );
      const query = compile(
        'SELECT category, COUNT(*) AS total, SUM(score) AS score FROM notes WHERE score >= 1 GROUP BY category ORDER BY total DESC LIMIT 10',
      );
      expect(query.params).toEqual([1, 11]);
      expect(database.prepare(query.sql).all(...query.params)).toEqual([
        { category: 'bug', total: 2, score: 4 },
        { category: 'idea', total: 1, score: 4 },
      ]);
      expect(compile('SELECT title FROM notes LIMIT 10000')).toMatchObject({
        limit: 200,
        params: [201],
      });
    } finally {
      database.close();
    }
  });

  it('expands stars from current public columns and supports safe functions and aliases', () => {
    const query = compile('SELECT n.* FROM notes n');
    expect(query.columns).toEqual(['title', 'category', 'score']);
    expect(query.sql).not.toMatch(/password|\*/);
    expect(
      compile('SELECT UPPER(title) AS name, COUNT(DISTINCT category) AS total FROM notes').sql,
    ).toContain('UPPER("title") AS "name"');
    expect(compile('SELECT -score FROM notes WHERE score IS NOT NULL').sql).toContain('IS NOT');
  });

  it('keeps comment and statement-shaped literal contents in parameters', () => {
    const text = "'); DROP TABLE notes; --";
    const query = compile(
      "/* DELETE FROM notes; */ SELECT title FROM notes WHERE title = '''); DROP TABLE notes; --';",
    );
    expect(query.params[0]).toBe(text);
    expect(query.sql).not.toMatch(/DROP|DELETE|--/);
    expect(compile('SELECT title FROM notes -- DELETE FROM notes').sql).not.toContain('DELETE');
  });

  it.each([
    'DELETE FROM notes',
    'UPDATE notes SET title = 1 RETURNING title',
    'SELECT title FROM notes; DELETE FROM notes',
    'SELECT title FROM notes; SELECT title FROM notes',
    'WITH x AS (SELECT title FROM notes) SELECT * FROM x',
    'SELECT title FROM notes UNION SELECT password FROM notes',
    'SELECT (SELECT password FROM notes) FROM notes',
    'SELECT title FROM notes WHERE EXISTS (SELECT password FROM notes)',
    'SELECT * FROM notes JOIN other ON notes.title = other.title',
    "SELECT * FROM pragma_table_info('notes')",
    'PRAGMA writable_schema = ON',
    "ATTACH DATABASE 'other' AS other",
    "SELECT load_extension('x') FROM notes",
    "SELECT readfile('/etc/passwd') FROM notes",
    'SELECT randomblob(1000000000) FROM notes',
    'SELECT password AS title FROM notes',
    'SELECT length(password) AS title FROM notes',
    "SELECT title FROM notes WHERE password = 'guess'",
    'SELECT title FROM notes ORDER BY password',
    'SELECT title FROM notes GROUP BY password',
    'SELECT title FROM notes HAVING MAX(password) > 0',
    'SELECT password_copy FROM notes',
    'SELECT rowid FROM notes',
    'SELECT title FROM main.notes',
    'SELECT title FROM notes LIMIT -1',
    'SELECT title FROM notes LIMIT 1 OFFSET 10001',
  ])('rejects unsupported or protected query: %s', (sql) => {
    expect(() => compile(sql)).toThrow();
  });

  it('rejects ambiguous result names and bounded oversized input', () => {
    expect(() => compile('SELECT title AS x, score AS X FROM notes')).toThrow(/unique/);
    expect(() => compile('SELECT title FROM notes ' + ' '.repeat(8192))).toThrow();
    expect(() =>
      compile("SELECT title FROM notes WHERE title = '" + '€'.repeat(3000) + "'"),
    ).toThrow();
  });

  it('preserves SQLite string escapes and quoted identifier semantics', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('CREATE TABLE notes(title TEXT, category TEXT, score INTEGER)');
      database.prepare('INSERT INTO notes VALUES (?, ?, ?)').run("a'b", 'a\\nb', 3);
      for (const sql of [
        'SELECT "title" FROM "notes"',
        'SELECT [title] FROM [notes]',
        "SELECT 'a''b' AS value FROM notes",
        "SELECT 'a\\nb' AS value FROM notes",
        "SELECT title FROM notes WHERE title = 'a''b'",
      ]) {
        const query = compile(sql);
        expect(database.prepare(query.sql).all(...query.params)).toEqual(
          database.prepare(sql).all(),
        );
      }
    } finally {
      database.close();
    }
  });
});
