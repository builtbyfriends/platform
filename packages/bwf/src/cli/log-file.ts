import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'pathslash';
import { Buffer } from './node-buffer.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';

export type CliLogger = {
  info<TFields extends Record<string, unknown>>(msg: string, fields?: TFields): void;
  warn<TFields extends Record<string, unknown>>(msg: string, fields?: TFields): void;
  error<TFields extends Record<string, unknown>>(
    msg: string,
    err?: unknown,
    fields?: TFields,
  ): void;
  debug<TFields extends Record<string, unknown>>(msg: string, fields?: TFields): void;
  /** path to the file backing this logger, or null if unable to open */
  readonly path: string | null;
  /** Release the file. Every record is already on disk when its call returns. Idempotent. */
  close(): Promise<void>;
};

export type ErrChainNode = {
  name?: string;
  message?: string;
  code?: string | number;
  errno?: string | number;
  cause?: ErrChainNode;
};

/**
 * Flatten a serialized `ErrChainNode` (from `describeErrorChain`, or read back
 * out of a JSONL record) to a single inline string, joining cause levels with
 * ` -> `.
 */
export function formatErrorNodeInline(
  node: ErrChainNode | string | null | undefined,
  depth = 0,
): string {
  // Decision: `typeof null` is `'object'`, so the null check has to come first.
  if (node === null || node === undefined || typeof node !== 'object') {
    return String(node);
  }
  // Decision: A JSONL record is data, not a typed value. Coerce each part instead of trusting the declared
  // shape: a hand-edited log, or an `Error` subclass that assigned a non-string `message`, mustn't
  // make a postmortem aid throw.
  const message = node.message === null || node.message === undefined ? '' : String(node.message);
  if (depth > 5) {
    return message;
  }
  let head = node.name ? `${String(node.name)}: ${message}` : message;
  const tags: Array<string> = [];
  if (node.code !== undefined) {
    tags.push(`code=${node.code}`);
  }
  if (node.errno !== undefined) {
    tags.push(`errno=${node.errno}`);
  }
  if (tags.length > 0) {
    head = `${head} (${tags.join(' ')})`;
  }
  if (node.cause !== null && node.cause !== undefined) {
    return `${head} -> ${formatErrorNodeInline(node.cause, depth + 1)}`;
  }
  return head;
}

function errorProperty(err: Error, key: 'code' | 'errno'): string | number | undefined {
  const value: unknown =
    key === 'code'
      ? 'code' in err
        ? err.code
        : undefined
      : 'errno' in err
        ? err.errno
        : undefined;
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

/**
 * Walk `err.cause` up to 6 levels and return a plain JSON-friendly chain.
 * Skips stack traces deliberately — keeps output line-oriented and readable.
 */
function describeErrorChain(err: unknown, depth = 0): ErrChainNode | string {
  if (depth > 5 || err === null || err === undefined) {
    return String(err);
  }
  if (err instanceof Error) {
    const node: ErrChainNode = {
      name: err.name,
      message: err.message,
    };
    const code = errorProperty(err, 'code');
    if (code !== undefined) {
      node.code = code;
    }
    const errno = errorProperty(err, 'errno');
    if (errno !== undefined) {
      node.errno = errno;
    }
    const cause = err.cause;
    if (cause !== null && cause !== undefined) {
      const sub = describeErrorChain(cause, depth + 1);
      if (typeof sub === 'object') {
        node.cause = sub;
      } else {
        node.cause = { message: sub };
      }
    }
    return node;
  }
  return String(err);
}

function formatStderrLine<TFields extends Record<string, unknown>>(
  level: Level,
  msg: string,
  err: unknown | undefined,
  fields?: TFields,
): string {
  const parts: Array<string> = [level, msg];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) {
        continue;
      }
      let s: string;
      if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') {
        s = String(v);
      } else if (typeof v === 'string') {
        s = v.length > 200 ? `${v.slice(0, 200)}...` : v;
      } else {
        try {
          s = JSON.stringify(v);
        } catch {
          s = String(v);
        }
      }
      parts.push(`${k}=${s}`);
    }
  }
  if (err !== undefined) {
    parts.push(`-> err=${formatErrorNodeInline(describeErrorChain(err))}`);
  }
  return parts.join(' ');
}

export function openDeployLog(opts?: { mirrorToStderr?: boolean }): CliLogger {
  const mirror = opts?.mirrorToStderr === true;
  const startedAt = Date.now();

  let path: string | null = null;
  let fd: number | null = null;
  let broken = false;
  let closed = false;
  // Decision: The CLI exits through process.exit() on many failure paths, and more than one of them may try to
  // record the end of the deploy. Only the first deploy_end counts.
  let ended = false;

  try {
    const dir = join(homedir(), '.bwf', 'logs');
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replaceAll(/[:.]/g, '-');
    // Decision: Deploys started in the same millisecond (parallel deploys from one machine) mustn't share a file,
    // so add the pid and a random suffix and refuse to open a file that already exists.
    const suffix = randomBytes(3).toString('hex');
    const filePath = join(dir, `deploy-${ts}-${process.pid}-${suffix}.jsonl`);
    // Decision: Synchronous writes, so a record survives a process.exit() that follows it: a stream would still
    // hold it in memory. The log can carry account and project details, so only the owner may read it.
    fd = openSync(filePath, 'wx', 0o600);
    path = filePath;
  } catch {
    broken = true;
    path = null;
    fd = null;
  }

  function write<TFields extends Record<string, unknown>>(
    level: Level,
    msg: string,
    err: unknown | undefined,
    fields?: TFields,
  ): void {
    if (msg === 'deploy_end') {
      if (ended) {
        return;
      }
      ended = true;
    }
    if (mirror) {
      try {
        process.stderr.write(`${formatStderrLine(level, msg, err, fields)}\n`);
      } catch {
        // Decision: Stderr write failures aren't actionable.
      }
    }
    if (broken || fd === null || closed) {
      return;
    }
    const now = Date.now();
    const record = new Map<string, unknown>([
      ['ts', now],
      ['elapsedMs', now - startedAt],
      ['lvl', level],
      ['msg', msg],
    ]);
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (
          v !== undefined &&
          k !== 'ts' &&
          k !== 'elapsedMs' &&
          k !== 'lvl' &&
          k !== 'msg' &&
          k !== 'err'
        ) {
          record.set(k, v);
        }
      }
    }
    if (err !== undefined) {
      record.set('err', describeErrorChain(err));
    }
    let line: string;
    try {
      line = `${JSON.stringify(Object.fromEntries(record))}\n`;
    } catch {
      // Decision: Non-serializable fields shouldn't crash the logger; fall back to a minimal record.
      line = `${JSON.stringify({ ts: now, elapsedMs: now - startedAt, lvl: level, msg, err: 'unserializable fields' })}\n`;
    }
    try {
      const bytes = Buffer.from(line);
      let offset = 0;
      while (offset < bytes.length) {
        offset += writeSync(fd, bytes, offset);
      }
    } catch {
      // Decision: A full disk or a closed descriptor mustn't break the deploy; stop logging instead.
      broken = true;
    }
  }

  return {
    get path() {
      return path;
    },
    info(msg, fields) {
      write('info', msg, undefined, fields);
    },
    warn(msg, fields) {
      write('warn', msg, undefined, fields);
    },
    error(msg, err, fields) {
      write('error', msg, err, fields);
    },
    debug(msg, fields) {
      write('debug', msg, undefined, fields);
    },
    close(): Promise<void> {
      if (closed) {
        return Promise.resolve();
      }
      closed = true;
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Decision: Nothing is buffered, so a failed close loses no record.
        }
        fd = null;
      }
      return Promise.resolve();
    },
  };
}
