#!/usr/bin/env node
// @ts-check
// Decision: Build agent for "Deploy on GitHub".
//
// Runs inside the Cloudflare Container managed by the BuildManager Durable Object
// (packages/api/src/build-manager.ts). It's deliberately thin: it doesn't re-implement deploy
// packaging. It downloads the pushed source, installs the repo's dependencies, and runs the
// real `bwf deploy` CLI, which does all build and upload work using the short-lived scoped
// BWF_TOKEN.
//
// Contract with the DO (env vars the DO injects at start()):
//   BUILD_ID            build row id (logging only)
//   PROJECT_ID          project id (logging only)
//   PROJECT_SLUG        project slug
//   SOURCE_TARBALL_URL  GitHub source tarball (codeload) URL
//   SOURCE_TOKEN        GitHub installation token (Bearer) to fetch the tarball
//   BWF_TOKEN           project-scoped deploy JWT (consumed by `bwf deploy`). Scrubbed from
//                       the install and any untrusted child env, and re-injected only for
//                       the trusted `bwf deploy` spawn.
//   BWF_API_URL         https://platform.buildwithfriends.dev (or staging)
//   PLATFORM_PROXY_URL  explicit platform resource proxy
//   BWF_PROJECT         project slug passed to `bwf deploy --project`
//   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
//                       staging CF Access service token (staging builds only). Like
//                       BWF_TOKEN: scrubbed from untrusted children and re-injected only for
//                       the `bwf deploy` spawn so it can pass CF Access on the staging API.
//   DO_LOG_URL          full URL of the DO's log sink, for example https://manager/logs
//   AGENT_TOKEN         per-build secret presented on this agent's DO control POSTs (/logs,
//                       /status, /cancel). Not forwarded into untrusted repo child
//                       processes (see `sanitizeChildEnv`).
//
// DO endpoints (see build-manager.ts `fetch`):
//   POST /logs    body: Array<{ line, stream, ts, lineEnding? }>
//   POST /status  body: { status }
//   POST /cancel  (DO -> agent; handled by this server)
//   GET  /        (DO -> agent; health check)
//
// Transport: the DO talks to the container over the Container model. The agent talks back by
// POSTing to DO_LOG_URL (resolved via the Container outbound-interception chain). DO writes
// here are best-effort: a transport failure mustn't abort the build. Logs are also kept
// in-process and exposed at `GET /logs?since=<seq>` so the DO can pull them if push transport
// is unavailable.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { argv } from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import bwfPackageJson from '../../../../packages/bwf/package.json' with { type: 'json' };

const PORT = 4000;
// Decision: Overridable only so a test that drives the real `tar` extraction can claim a private
// directory. Vitest runs test files in parallel workers, and two suites wiping one absolute
// path under each other is a race, not a flake. The container doesn't set this: production
// is `/tmp/build/src` (pinned by the `childSpawnOptions` cwd assertion in
// build-manager.test.ts).
const WORK_DIR = process.env.PLATFORM_BUILD_WORK_DIR ?? '/tmp/build/src';
const BWF_PACKAGE = '@builtbyfriends/bwf';
const LOG_FLUSH_MS = 500;
// Decision: Hard timeout on each best-effort DO POST. Without it a hung DO connection would stall the
// single-flight log flush forever (logging would silently stop for the rest of the build);
// with it the flush retries on the next tick. Also bounds how long the final drain at exit can
// block before the container terminates.
const DO_POST_TIMEOUT_MS = 10_000;
// Decision: BuildManager injects BWF_CLI_VERSION. If absent, use the release manifest copied into this
// image, not a mutable npm dist-tag or the untrusted app's manifest.
export const DEFAULT_PLATFORM_CLI_VERSION = bwfPackageJson.version;

// Decision: A degraded tarball stream can deliver short bursts separated by dead minutes and burn the
// whole build budget while looking healthy to the DO's log puller. Node's undici defaults
// don't catch this: `bodyTimeout` resets on each chunk, so any trickle defeats it.
//
// The guard that matters is the stall timer, not a wall-clock cap on the attempt. A healthy
// download streams continuously, so a "no bytes at all for 20s" rule can't fire on it, while
// an absolute per-attempt cap, or a minimum-throughput floor, would fail a large repo on a
// slow but steady link. The phase budget below is the only wall clock, and it bounds all
// attempts together rather than each one separately.

// Decision: No bytes received for this long aborts the in-flight attempt. Reset by each chunk, so it
// measures a dead stream, not a slow one.
export const SOURCE_STALL_TIMEOUT_MS = 20_000;
// Decision: Hard ceiling on the whole download phase, across all attempts. Sized to sit well inside the
// smallest plan budget (free tier = 10 minutes) so a pathological but never-quite-stalled
// trickle still leaves most of the budget for the build.
export const SOURCE_PHASE_BUDGET_MS = 240_000;
// Decision: Attempts per build, including the first.
export const SOURCE_DOWNLOAD_MAX_ATTEMPTS = 3;
export const SOURCE_RETRY_BACKOFF_MS = [2000, 5000];
// Decision: How often the download logs progress, so a stalled download is visible in the live tail and
// the check-run tail. The check run keeps the last 100 lines and the phase is capped at 4
// minutes, so this can add at most about 16 lines.
export const SOURCE_PROGRESS_INTERVAL_MS = 15_000;
// Decision: How long a killed `tar` gets between SIGTERM and SIGKILL. A child that ignores SIGTERM
// mustn't be able to hold the retry loop, and so the phase budget, open.
export const EXTRACT_KILL_GRACE_MS = 5000;

// Decision: uid/gid the untrusted build children (dependency install + `bwf deploy`) run under. The
// agent itself stays root so it can setuid-spawn them. Dropping the children to a non-root
// uid means the kernel denies their `/proc/<ppid>/environ` read of the root agent
// (cross-uid), closing the secret-recovery vector that `delete process.env.*` can't (unsetenv
// leaves the initial-stack env block in /proc intact). Has to match the `builder` user
// created in the Dockerfile.
export const BUILDER_UID = 1000;
export const BUILDER_GID = 1000;
export const BUILDER_HOME = '/home/builder';

/**
 * Cache/HOME overrides for the non-root builder. corepack, npm, yarn, and bun
 * all write under $HOME / $XDG_CACHE_HOME; the image's default env points some of
 * these at root-owned paths (e.g. BUN_INSTALL=/usr/local), so an unprivileged
 * install would EPERM without these. Merged into every untrusted child's env;
 * the Dockerfile pre-creates + chowns the matching dirs.
 * @returns {Record<string, string>}
 */
export function builderCacheEnv() {
  return {
    HOME: BUILDER_HOME,
    XDG_CACHE_HOME: `${BUILDER_HOME}/.cache`,
    npm_config_cache: `${BUILDER_HOME}/.npm`,
    COREPACK_HOME: `${BUILDER_HOME}/.cache/node/corepack`,
    YARN_CACHE_FOLDER: `${BUILDER_HOME}/.cache/yarn`,
    BUN_INSTALL: `${BUILDER_HOME}/.bun`,
  };
}

/**
 * Env that tells every build child it is running unattended, so interactive
 * CLIs take their CI-safe rendering path. Merged into both untrusted children.
 *
 * A build container IS a CI environment, but nothing here set `CI`, so
 * `bwf deploy` took its interactive branch: `@clack/prompts`' spinner redraws
 * one line in place with `ESC[1G ESC[J` (cursor-to-column-1 + erase) and NO
 * newline. `chunkToLines` splits on CR/LF only, so every frame the spinner ever
 * drew arrived glued into a SINGLE captured line — unreadable in the live tail
 * and in the completed check run's `output.text`.
 *
 * The framework already guards this: `createSpinner()` in the void CLI swaps in
 * plain `log.step` output when `isCI()`. But that gate is `@clack/prompts`'
 * `isCI`, which compares `process.env.CI` to the EXACT string `'true'` — `'1'`
 * or `'yes'` will NOT do. The `github_actions` executor gets `CI=true` for free
 * from the runner, which is why only container builds rendered broken.
 * @returns {Record<string, string>}
 */
export function nonInteractiveEnv() {
  return { CI: 'true' };
}

/**
 * spawn() options for an untrusted build child: run in WORK_DIR, pipe stdio, and
 * drop to the non-root BUILDER_UID/GID. Pure + exported so the uid drop is
 * unit-testable without spawning (the real setuid only works as root, in the
 * container). spawn() throws EPERM if a non-root process passes `uid`, which is
 * the intended fail-closed posture: untrusted code must not run as the agent's
 * uid, so a misconfigured non-root agent fails rather than silently co-locating.
 * @returns {{ cwd: string, stdio: Array<'ignore' | 'pipe' | 'inherit'>, uid: number, gid: number }}
 */
export function childSpawnOptions() {
  return {
    cwd: WORK_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    uid: BUILDER_UID,
    gid: BUILDER_GID,
  };
}

/**
 * Pinned fallback version used when the repo has no local `bwf` to run via npx.
 * Reads BWF_CLI_VERSION (injected by BuildManager) at call time, falling back
 * to the baked-in default. Never `latest` — a moving dist-tag must not change
 * deploy behavior with no repo diff.
 * @returns {string}
 */
function bwfFallbackVersion() {
  return process.env.BWF_CLI_VERSION || DEFAULT_PLATFORM_CLI_VERSION;
}

/**
 * The currently-running untrusted build child (dependency install OR `void
 * deploy`). At most one runs at a time — install is awaited and the BUILDER_UID
 * sweep runs before the deploy child spawns — so a single slot is unambiguous.
 * Held so a cancel (POST /cancel or a PID-1 SIGTERM) interrupts whichever phase
 * is in flight, the install INCLUDED: a cancel during install must not let it
 * run to completion and burn the container slot.
 * @type {import('node:child_process').ChildProcess | null}
 */
let activeChild = null;
let cancelled = false;

/**
 * Monotonic, in-memory ring of recent log lines. `seq` is the 1-based index of
 * the line; `GET /logs?since=N` returns lines with seq > N. Kept so a PULL-mode
 * DO can drain logs even if push (POST to DO_LOG_URL) is unavailable. BOUNDED by
 * MAX_BUFFERED_LOG_LINES (see below).
 * `bytes` is the entry's serialized size, attached non-enumerably by
 * `measureEntry` so it never reaches the wire.
 * @type {Array<{ seq: number, line: string, stream: 'stdout' | 'stderr', ts: number, lineEnding?: 'cr' | 'lf' | 'crlf' | 'none', bytes: number }>}
 */
const logBuffer = [];
let logSeq = 0;
// Decision: Running serialized size of `logBuffer`; see MAX_BUFFERED_LOG_BYTES.
let bufferedBytes = 0;

// Decision: Hard cap on the retained PULL history. A very verbose build (huge package-manager or
// compiler output) would otherwise grow `logBuffer` without bound and OOM the agent on the
// memory-constrained standard-1 container, failing a valid build only because it logged too
// much. `record()` evicts the oldest lines in a chunk once over this cap. The /logs pull is a
// best-effort tail, so a far-behind puller misses the very start; `seq` stays monotonic, so
// `since` queries over retained lines are still exact.
export const MAX_BUFFERED_LOG_LINES = 10_000;

// Decision: Companion byte cap on the same ring. The line cap bounds the count, not the size: at
// MAX_PARTIAL_LINE_CHARS each, 10000 retained lines is about 1.22 GiB of live strings, and a
// puller draining MAX_LOG_PULL_PAGES x MAX_LOG_RESPONSE_BYTES per callback would need about 19
// callbacks to clear it. Measured in serialized bytes (see `measureEntry`), the same unit the
// page cap uses, so the comparison is exact: counting UTF-16 code units would let a nominal
// 16 MiB ring hold about 96 MiB on the wire, past the 64 MiB one drain can fetch. Capping bytes
// keeps the retained ring smaller than a single drain, so the DO can't fall a callback behind
// on backlog size, only on wall clock. Well above any real build, so this only trims output
// far past what the 60000-byte check-run tail can show.
export const MAX_BUFFERED_LOG_BYTES = 16 * 1024 * 1024;

// Decision: Hard cap on the unflushed PUSH batch. `pendingLines` is drained each LOG_FLUSH_MS, but a
// flood can outrun the flush within a single synchronous `data` handler: `pipeStream` scans a
// whole chunk in one turn, so a chunk carrying millions of delimiters (a bare-`\r` progress
// flood, or a `\n`-only blast) makes millions of `record()` calls, and the flush timer can't
// fire until that turn yields. That balloons the batch and OOMs the standard-1 container. The
// per-line byte cap (MAX_PARTIAL_LINE_CHARS) bounds one line's size but not the count of short
// lines, so this bounds the count too. `record()` evicts the oldest entries once over the cap,
// keeping the most recent output; the retained PULL history is bounded separately.
export const MAX_PENDING_LOG_LINES = 10_000;

// Decision: Per-response bounds on `GET /logs?since=N`.
//
// Without paging, a puller that fell behind a verbose build could be handed
// MAX_BUFFERED_LOG_LINES entries of MAX_PARTIAL_LINE_CHARS each, well over a gigabyte in one
// body. The DO aborts that read at LOG_PULL_TIMEOUT_MS and only advances `logCursor` after a
// successful parse, so an oversized body is a livelock: each retry asks for the same backlog,
// is aborted at the same point, and the cursor doesn't move. Natural exit then burns the drain
// idle timeout waiting for an ack that can't arrive, and the tail is lost.
//
// Paging avoids this because `lastSeq` reports the last line actually included, so each
// successful batch advances the cursor. One line is returned even if it alone exceeds the byte
// cap, or a single oversized line would bring back the same stall.
export const MAX_LOG_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_LOG_RESPONSE_LINES = 2000;

/**
 * Pending lines not yet flushed to the DO. Drained every LOG_FLUSH_MS. Bounded
 * by MAX_PENDING_LOG_LINES (see above) so a log flood can't OOM the agent.
 * @type {Array<{ line: string, stream: 'stdout' | 'stderr', ts: number, lineEnding?: 'cr' | 'lf' | 'crlf' | 'none' }>}
 */
let pendingLines = [];

// Decision: Backpressure latch for the stderr mirror in `record()`. The in-memory buffers are capped,
// but `process.stderr.write` also queues in Node's Writable buffer when the sink can't keep
// up, so a flood with a slow consumer would grow that buffer without bound. Set when
// `write()` returns false, cleared on the next 'drain'; while set, the mirror is skipped. The
// mirror is best-effort and the lines stay in logBuffer (PULL) and pendingLines (PUSH), so
// skipping it loses nothing primary.
let stderrSaturated = false;

const DO_LOG_URL = process.env.DO_LOG_URL ?? '';
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '';

// Decision: Drop these control-plane secrets from the parent process's heap env once captured into the
// module-level consts above. `postToDo` reads the consts (and DO_STATUS_URL, derived from
// DO_LOG_URL), not process.env, so this doesn't affect the build. It's defense in depth for
// the spawn-inheritance path only; `sanitizeChildEnv` is the real control there.
//
// `delete process.env.X` calls `unsetenv()`, which changes only the in-heap `environ` array;
// `/proc/<pid>/environ` still shows the original secret. That vector is closed at the uid
// boundary: untrusted children run as the non-root BUILDER_UID (childSpawnOptions), so the
// kernel denies their cross-uid read of the root agent's /proc.
delete process.env.AGENT_TOKEN;
delete process.env.DO_LOG_URL;

function doEndpoint(pathname) {
  if (!DO_LOG_URL) {
    return '';
  }
  try {
    const u = new URL(DO_LOG_URL);
    u.pathname = pathname;
    u.search = '';
    return u.toString();
  } catch {
    return '';
  }
}

const DO_STATUS_URL = doEndpoint('/status');

/**
 * POST JSON to a DO endpoint. Best-effort: any failure (transport, non-2xx,
 * missing URL) is swallowed so a log/status hiccup never aborts the build.
 * @param {string} url
 * @param {unknown} body
 */
async function postToDo(url, body) {
  if (!url) {
    return;
  }
  try {
    /** @type {Record<string, string>} */
    const headers = { 'content-type': 'application/json' };
    // Decision: The DO authenticates control POSTs with the per-build secret. The agent (parent process)
    // holds AGENT_TOKEN; untrusted repo child processes don't see it (scrubbed by
    // `sanitizeChildEnv`), so they can't authenticate.
    if (AGENT_TOKEN) {
      headers.authorization = `Bearer ${AGENT_TOKEN}`;
    }
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // Decision: Bound a slow or hung DO so the caller (the single-flight log flush) can't stall
      // indefinitely; see DO_POST_TIMEOUT_MS. AbortError lands in catch.
      signal: AbortSignal.timeout(DO_POST_TIMEOUT_MS),
    });
  } catch {
    // Decision: Best-effort: don't throw into the build path.
  }
}

async function reportStatus(status) {
  await postToDo(DO_STATUS_URL, { status });
}

/**
 * Serialized size of one retained entry, in the SAME unit `GET /logs` budgets a
 * page with — bytes on the wire, including JSON escaping (a control character
 * costs six) and the seq/stream/ts envelope. Both the retained-ring cap and the
 * page cap have to speak this unit or the ring's guarantee is only nominal: 16
 * MiB of UTF-16 code units is up to ~96 MiB serialized, which no longer fits the
 * MAX_LOG_PULL_PAGES x MAX_LOG_RESPONSE_BYTES a teardown drain can fetch. Stored
 * on the entry NON-ENUMERABLY, so it is measured once and never reaches the
 * response body.
 * @param {{ seq: number, line: string, stream: string, ts: number }} entry
 */
function measureEntry(entry) {
  const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1; /* Decision: +1 for the separator. */
  Object.defineProperty(entry, 'bytes', { value: bytes, enumerable: false });
  return bytes;
}

/**
 * Record a line: append to the in-memory ring (for PULL) and the pending batch
 * (for PUSH).
 * @param {string} line
 * @param {'stdout' | 'stderr'} stream
 * @param {'cr' | 'lf' | 'crlf' | 'none'} [lineEnding]
 */
export function record(line, stream, lineEnding) {
  const ts = Date.now();
  logSeq += 1;
  const entry = { seq: logSeq, line, stream, ts, ...(lineEnding ? { lineEnding } : {}) };
  logBuffer.push(entry);
  bufferedBytes += measureEntry(entry);
  // Decision: Bound the retained history (see MAX_BUFFERED_LOG_LINES): once over the cap, drop the oldest
  // fifth in one splice so eviction is amortized O(1) per line. A per-line front-shift would be
  // O(n^2) over a long, verbose build.
  if (logBuffer.length > MAX_BUFFERED_LOG_LINES) {
    for (const evicted of logBuffer.splice(0, Math.ceil(MAX_BUFFERED_LOG_LINES / 5))) {
      bufferedBytes -= evicted.bytes;
    }
  }
  // Decision: Also bound by serialized size (see MAX_BUFFERED_LOG_BYTES): the line cap bounds the count
  // only. Trims to a low-water mark, not to the cap exactly, for the same reason the eviction
  // above drops a fifth at a time: landing on the cap means the next big line evicts again, so
  // the cost stops being amortized. One splice, since a repeated shift() is O(n) each. Keeps the
  // newest line, even when it alone exceeds the cap.
  if (bufferedBytes > MAX_BUFFERED_LOG_BYTES) {
    const target = Math.floor(MAX_BUFFERED_LOG_BYTES * 0.8);
    let drop = 0;
    let freed = 0;
    while (drop < logBuffer.length - 1 && bufferedBytes - freed > target) {
      freed += logBuffer[drop].bytes;
      drop += 1;
    }
    logBuffer.splice(0, drop);
    bufferedBytes -= freed;
  }
  pendingLines.push({ line, stream, ts, ...(lineEnding ? { lineEnding } : {}) });
  // Decision: Bound the unflushed PUSH batch the same way as logBuffer (see MAX_PENDING_LOG_LINES): a
  // flood can fill it faster than LOG_FLUSH_MS drains, so evict the oldest fifth in one splice
  // once over the cap, keeping the most recent output.
  if (pendingLines.length > MAX_PENDING_LOG_LINES) {
    pendingLines.splice(0, Math.ceil(MAX_PENDING_LOG_LINES / 5));
  }
  // Decision: Also mirror to the container's own stderr. This is the last-resort log path: if DO push
  // transport is unavailable and the DO doesn't pull, the build output is still in the
  // container's runtime logs. Respect backpressure (see stderrSaturated) so a flood with a slow
  // consumer can't grow the Writable's internal buffer without bound.
  if (!stderrSaturated && !process.stderr.write(`${line}\n`)) {
    stderrSaturated = true;
    process.stderr.once('drain', () => {
      stderrSaturated = false;
    });
  }
}

function agentLog(line) {
  record(`[build-agent] ${line}`, 'stdout', 'crlf');
}

// Decision: Test-only: drop the retained PULL buffer. `logBuffer` is module state shared by each test in
// the file, and the byte cap trims from the front, so a test that fills the ring shifts the
// indices a later `getBufferedLogLines().slice(before)` depends on. Call this after any test
// that deliberately saturates it.
export function clearBufferedLogLines() {
  logBuffer.length = 0;
  bufferedBytes = 0;
}

export function getBufferedLogLines() {
  return logBuffer.slice();
}

export function getPendingLogLineCount() {
  return pendingLines.length;
}

let flushInFlight = null;

/**
 * Flush pending lines to the DO. Best-effort and SINGLE-FLIGHT: the flush runs on
 * a fire-and-forget interval, so a fire-and-forget `await postToDo()` against a
 * slow/hung DO would let every 500ms tick start ANOTHER POST, each retaining its
 * (bounded) batch + JSON body in an unresolved promise — accumulating those bodies
 * without bound and moving the OOM into the network layer. Instead, concurrent
 * callers (the interval and the final drain at exit) JOIN the in-flight promise
 * rather than starting a parallel POST, and the loop drains every line that
 * arrived during each await before resolving. So at most ONE POST is ever in
 * flight, and `await flushLogs()` at exit waits for a complete drain.
 * @returns {Promise<void>}
 */
export function flushLogs() {
  if (flushInFlight) {
    return flushInFlight;
  }
  flushInFlight = (async () => {
    try {
      while (pendingLines.length > 0) {
        const batch = pendingLines;
        pendingLines = [];
        await postToDo(DO_LOG_URL, batch);
      }
    } finally {
      flushInFlight = null;
    }
  })();
  return flushInFlight;
}

// Decision: Per-line character cap for `pipeStream`. A producer that writes a very long run with no
// line terminator (an LF-free blob, or a pure-CR progress stream) would otherwise grow the
// partial-line buffer until it OOMs the standard-1 container on a valid build. A line over
// this length is recorded truncated (and the rest of that line is dropped until its
// terminator), so a single terminator-free run yields one bounded record.
export const MAX_PARTIAL_LINE_CHARS = 128 * 1024;

const LINE_TRUNCATION_MARKER = ' …[line truncated]';

/**
 * Turn a readable stream of bytes into line-delimited `record()` calls. Splits
 * on CR, LF, or CRLF so carriage-return progress frames (install/build spinners
 * that rewrite a line with bare `\r` and no `\n`) flush as lines live, instead
 * of being held until the process exits.
 *
 * Two cross-chunk concerns drive the hand-rolled scan rather than a `split()`:
 *   - Torn CRLF: a CR may be the last byte of one chunk and the LF the first of
 *     the next. That one bounded row waits for one byte of lookahead (or EOF),
 *     which is the only way to distinguish CR from CRLF without a correction
 *     event. Same-chunk bare-CR frames still flush immediately.
 *   - Unbounded line: once a line exceeds MAX_PARTIAL_LINE_CHARS, `dropping`
 *     retains only its bounded prefix + marker and discards the remainder until
 *     the delimiter. The one truncated record is emitted with that exact ending
 *     (or `none` at EOF), so a terminator-free flood never grows unbounded.
 * @param {NodeJS.ReadableStream} source
 * @param {'stdout' | 'stderr'} stream
 */
export function pipeStream(source, stream) {
  let tail = ''; /* Decision: Current unterminated line; never holds a trailing CR. */
  let pendingCr = false; /* Decision: A CR at the prior chunk seam; classification needs one-byte lookahead. */
  let dropping = false; /* Decision: Truncated an over-cap line: drop bytes until its terminator. */

  const recordLine = (line, lineEnding) => {
    record(
      line.length > MAX_PARTIAL_LINE_CHARS
        ? line.slice(0, MAX_PARTIAL_LINE_CHARS) + LINE_TRUNCATION_MARKER
        : line,
      stream,
      lineEnding,
    );
  };

  const finishLine = (lineEnding) => {
    recordLine(tail, lineEnding);
    tail = '';
    dropping = false;
  };

  const appendToTail = (text) => {
    if (dropping) {
      return;
    }
    tail += text;
    if (tail.length > MAX_PARTIAL_LINE_CHARS) {
      tail = tail.slice(0, MAX_PARTIAL_LINE_CHARS) + LINE_TRUNCATION_MARKER;
      dropping = true;
    }
  };

  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    const n = chunk.length;
    let i = 0;
    // Decision: A CR at a chunk seam is the one ambiguous case: wait for the next byte so a torn CRLF isn't
    // misreported as a bare-CR rewrite. Same-chunk CR frames still flush synchronously.
    if (pendingCr && n > 0) {
      pendingCr = false;
      if (chunk[0] === '\n') {
        finishLine('crlf');
        i = 1;
      } else {
        finishLine('cr');
      }
    }
    while (i < n) {
      let j = i;
      while (j < n && chunk[j] !== '\n' && chunk[j] !== '\r') {
        j += 1;
      }
      if (j < n) {
        appendToTail(chunk.slice(i, j));
        if (chunk[j] === '\n') {
          finishLine('lf');
          i = j + 1;
        } else if (j + 1 === n) {
          pendingCr = true;
          i = n;
        } else if (chunk[j + 1] === '\n') {
          finishLine('crlf');
          i = j + 2;
        } else {
          finishLine('cr');
          i = j + 1;
        }
      } else {
        appendToTail(chunk.slice(i, n));
        i = n;
      }
    }
  });
  source.on('end', () => {
    if (pendingCr) {
      finishLine('cr');
      pendingCr = false;
    } else if (tail.length > 0 || dropping) {
      finishLine('none');
    }
    tail = '';
  });
}

// Decision: Highest `lastSeq` this agent has actually served on `GET /logs`. Diagnostic only: it says
// the bytes left this process, not that the DO stored them, so the exit barrier mustn't trust
// it. See `ackedLogSeq`.
let servedLogSeq = 0;

export function getServedLogSeq() {
  return servedLogSeq;
}

// Decision: Highest `since` cursor the DO has sent us. It's the only sound acknowledgement available,
// and it's what the exit barrier waits on.
//
// The DO advances its `logCursor` only after a successful `res.json()` and `ingestLines()`
// (`build-manager.ts` `runLogPull`), and each pull URL is built from that cursor. So a request
// carrying `since=N` proves each line up to N is already stored in the DO's `logs` table. Any
// failure on the DO side leaves the cursor where it was, so the next request repeats the old
// `since` and the lines get re-delivered instead of dying with the container.
//
// `servedLogSeq` can't do this job: `res.end`'s completion callback means "this process
// finished writing the message", not "the peer received it". Measured on Node 24, a client
// that hangs up without reading a byte still fires that callback with no error, for bodies
// from a few bytes to 8MB.
//
// No off-by-one: the agent serves `lastSeq = logSeq` and lines with `seq > since`, and the DO
// stores `logCursor = max(cursor, lastSeq)` verbatim, so after ingesting through N the next
// request is `since=N`, and `acked >= recorded` is the exact release condition.
let ackedLogSeq = 0;

export function getAckedLogSeq() {
  return ackedLogSeq;
}

/**
 * @param {number} [port] listening port; defaults to the container's fixed PORT.
 *   Exported (with an override) so a unit test can bind an ephemeral port and
 *   exercise the real `GET /logs` handler — including the `servedLogSeq`
 *   bookkeeping the exit-time drain barrier depends on.
 * @returns {Promise<import('node:http').Server>}
 */
export function startControlServer(port = PORT) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/logs') {
      const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0;
      // Decision: Snapshot the cursor once so the body, the ack clamp and the served high-water mark can't
      // disagree. They're read in the same synchronous turn, but a single read makes that invariant
      // explicit.
      const lastSeq = logSeq;
      // Decision: The ack, stamped synchronously at receipt: this cursor exists only because the DO already
      // ingested everything below it (see `ackedLogSeq`). Monotonic, so an out-of-order or replayed
      // request can't walk it backwards.
      //
      // Clamped to lines actually recorded. This server is unauthenticated and binds all interfaces
      // on a fixed port, and the untrusted build children run in the same network namespace, so
      // `since` is attacker-reachable. Unclamped, one forged `?since=2**53` would mark each future
      // line acked and release the exit barrier permanently. For the real DO this is a no-op: its
      // cursor is a previously served `lastSeq` and `logSeq` only grows. The clamp forces a forger
      // to hold a request loop open through exit instead of firing one request. Closing that loop
      // needs the pull authenticated (the DO already mints a per-build `AGENT_TOKEN`); left out on
      // purpose, since the forger is the build's own code, it can only suppress its own log tail,
      // and the build outcome comes from the container exit code, not the logs.
      ackedLogSeq = Math.max(ackedLogSeq, Math.min(since, lastSeq));
      // Decision: Paged; see MAX_LOG_RESPONSE_BYTES. `servedSeq` is the last line actually included, not the
      // global high-water mark, so the puller's cursor advances exactly as far as this body carries
      // it and the rest arrives next tick.
      const lines = [];
      let responseBytes = 0;
      for (const entry of logBuffer) {
        if (entry.seq <= since) {
          continue;
        }
        // Decision: Budget the serialized entry, not `entry.line.length`. That length is UTF-16 code units of
        // the raw string, which isn't what goes on the wire: JSON escaping turns one control character
        // into six bytes, a BMP CJK code unit is three UTF-8 bytes, and each entry carries about 61
        // bytes of `seq`/`stream`/`ts` envelope. Counting code units under-counted the body by up to
        // 6x. That matters because the DO advances `logCursor` only after a successful parse, so a
        // body too large to read inside LOG_PULL_TIMEOUT_MS is a livelock: each retry asks for the
        // same backlog and the cursor doesn't move.
        const entryBytes = entry.bytes;
        if (
          lines.length > 0 &&
          (lines.length >= MAX_LOG_RESPONSE_LINES ||
            responseBytes + entryBytes > MAX_LOG_RESPONSE_BYTES)
        ) {
          break;
        }
        lines.push(entry);
        responseBytes += entryBytes;
      }
      const servedSeq = lines.length > 0 ? lines.at(-1).seq : lastSeq;
      // Decision: Explicit, because the puller can't infer it: it doesn't know our caps, and a page that
      // lands exactly on one looks like the last page. Without it the puller waits a full tick per
      // page, and the exit barrier's idle deadline resets only when the acknowledged cursor
      // advances, so `hasMore` lets productive pagination continue across scheduled callbacks
      // without turning a dead peer into an unbounded wait.
      const hasMore = logBuffer.some((entry) => entry.seq > servedSeq);
      res.writeHead(200, { 'content-type': 'application/json' });
      // Decision: Stamped from `end`'s completion callback so it at least reflects a message this process
      // finished writing rather than one merely queued. Diagnostic only: the callback doesn't prove
      // the response reached the DO, which is why the exit barrier waits on `ackedLogSeq` instead.
      res.end(JSON.stringify({ lines, lastSeq: servedSeq, hasMore }), () => {
        servedLogSeq = Math.max(servedLogSeq, servedSeq);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/cancel') {
      cancelled = true;
      agentLog('cancel requested');
      if (activeChild && activeChild.exitCode === null) {
        try {
          activeChild.kill('SIGTERM');
        } catch {
          // Decision: The child already exited.
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

// Decision: Exit-time drain barrier: how long the agent holds the container open waiting for the DO's
// pull-loop to catch up, and how often it re-checks.
//
// The DO polls `GET /logs` about once a second and one paginated callback may spend its full
// 4s wall-clock budget. A callback that expires with `hasMore` has to re-arm before it can
// fetch the unread page and acknowledge it, and a deep ring can need several callbacks. So
// reset the 8s idle deadline only when the acknowledged cursor advances, while a 120s absolute
// cap bounds even a peer that keeps making partial progress.
//
// It has to stay bounded: a dead, wedged or already-terminal DO won't acknowledge anything,
// and an unbounded wait would pin one of the fleet's global container slots on each such
// build. One path runs to the idle deadline: `onError` writes a terminal status without
// force-stopping, so `pollLogs` takes its non-re-arming terminal branch and the last tail it
// pulled is never acked. That costs a slot for `idleTimeoutMs` on a container that's already
// failing, which is the right side of the trade against losing its logs.
export const LOG_DRAIN_IDLE_TIMEOUT_MS = 8000;
export const LOG_DRAIN_ABSOLUTE_TIMEOUT_MS = 120_000;
export const LOG_DRAIN_POLL_MS = 100;

/** @param {number} ms */
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hold the process open until the DO's pull-loop has fetched every recorded line.
 *
 * The DO→container pull (`build-manager.ts` `pollLogs`) is the ONLY transport
 * that reaches the DO's log sink — the agent's `POST /logs` push has no route
 * back. That pull runs on a ~1s cadence and, once the container exits, cannot run
 * at all: `logBuffer` and this HTTP server die with the process, and the DO's own
 * `container.running` guard early-outs before it ever fetches. So EVERY line
 * produced between the last successful poll and container exit was lost —
 * including `bwf deploy exited with code N` and, worse, the compiler/deploy error
 * that immediately preceded a failure. The DO cannot fix this alone; the agent has
 * to keep the door open until the puller has caught up.
 *
 * Waits on the DO's ACKNOWLEDGED cursor (`ackedLogSeq`), not on what this process
 * managed to write (`servedLogSeq`). Serving a response proves nothing about the
 * far side: if the DO's `res.json()` or `ingestLines()` throws it leaves its cursor
 * unadvanced and retries, but a barrier released by the write would already have
 * let the container die — recreating this exact bug on a single transient failure,
 * with no retry possible because the agent is gone. Waiting on the ack turns that
 * into "delivered on the next tick".
 *
 * Bounded by an idle deadline (reset only by acknowledged-cursor progress) and
 * a non-resettable absolute deadline, so an absent, dead, or malicious DO can
 * never hang the container. Every dependency is injectable so the barrier is
 * unit-testable without real timers.
 *
 * @param {{
 *   timeoutMs?: number,
 *   idleTimeoutMs?: number,
 *   pollMs?: number,
 *   served?: () => number,
 *   recorded?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} [options]
 * @returns {Promise<boolean>} true if the puller caught up, false on deadline.
 */
export async function waitForLogDrain(options = {}) {
  const {
    timeoutMs = LOG_DRAIN_ABSOLUTE_TIMEOUT_MS,
    idleTimeoutMs = Math.min(LOG_DRAIN_IDLE_TIMEOUT_MS, timeoutMs),
    pollMs = LOG_DRAIN_POLL_MS,
    // Decision: Named `served` for the injection sites; the default is deliberately the acked cursor.
    // Anything wired to the served mark would certify the wrong side of the transport.
    served = getAckedLogSeq,
    recorded = () => logSeq,
    sleep = sleepMs,
    now = () => Date.now(),
  } = options;
  const startedAt = now();
  const absoluteDeadline = startedAt + timeoutMs;
  let idleDeadline = startedAt + idleTimeoutMs;
  let acknowledged = served();
  while (acknowledged < recorded()) {
    const currentAcknowledged = served();
    const currentTime = now();
    if (currentAcknowledged > acknowledged) {
      acknowledged = currentAcknowledged;
      idleDeadline = Math.min(absoluteDeadline, currentTime + idleTimeoutMs);
    }
    if (acknowledged >= recorded()) {
      return true;
    }
    const nextDeadline = Math.min(absoluteDeadline, idleDeadline);
    if (currentTime >= nextDeadline) {
      return false;
    }
    await sleep(Math.min(pollMs, nextDeadline - currentTime));
  }
  return true;
}

/**
 * Close the HTTP control server so its open listening socket can't keep the
 * Node event loop alive after the build resolves. Best-effort + idempotent: a
 * null server or an already-closed server resolves without throwing. Exported
 * so the lifecycle invariant (server closed on every exit path) is unit-testable.
 * @param {import('node:http').Server | null | undefined} server
 * @returns {Promise<void>}
 */
export function closeControlServer(server) {
  if (!server) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * The container's exit path, extracted from `main()`'s `finally` so its ORDERING
 * is unit-testable — two separate review findings on this path were ordering bugs,
 * and `main()` is not exported.
 *
 * Deliberately does NOT call `flushLogs()`. The agent's `POST /logs` push has no
 * route to the DO's log sink: `BuildManager` registers no `outboundByHost` /
 * `outbound` handler and the api worker exports no `ContainerProxy`, so
 * `@cloudflare/containers` never installs outbound interception — the POST leaves
 * for the public internet, where the single-label `DO_LOG_URL` host is
 * unresolvable. (Even if it arrived, the DO's `fetch` routes only the WS upgrade,
 * `GET /logs`, `POST /status` and `POST /cancel`; a `POST /logs` falls through to
 * `super.fetch`, which forwards it back INTO the container for a 404 — and would
 * auto-start a stopped one, the resurrection the pull-loop avoids on purpose.
 * `ingestLines`' doc says the same: the pull-loop is the sole producer.)
 *
 * So awaiting it here bought nothing and could only spend the DO's
 * LOG_DRAIN_GRACE_SECONDS window, which `enforceTimeout` is armed against. Up to
 * 2 x DO_POST_TIMEOUT_MS of it, because the exit call JOINS an in-flight interval
 * flush and then drains one more batch — and a grace miss inside the barrier
 * overwrites an already-live, successful deploy with 'build timed out'. The
 * periodic `flushTimer` is left alone: equally routeless today, but it does not
 * sit in front of a deadline.
 *
 * @param {import('node:http').Server | null | undefined} server
 * @param {Parameters<typeof waitForLogDrain>[0]} [drainOptions]
 * @returns {Promise<void>}
 */
export async function finishBuildLogging(server, drainOptions) {
  // Decision: Drain barrier before the server closes: the DO pulls logs from this server about once a
  // second and can't reach it once the container is gone, so everything recorded since its last
  // poll (the failing build's actual error output and the final `bwf deploy exited with code N`)
  // would be lost. Bounded by idle and absolute deadlines so an absent or dead DO can't pin the
  // slot.
  await waitForLogDrain(drainOptions);
  // Decision: Close the control server unconditionally: its open listening socket would otherwise keep
  // the Node event loop alive after the build resolves, so the container would never reach
  // `process.exit` and would leak a build slot until the DO's `sleepAfter` ceiling (or, for
  // unlimited plans with no timeout alarm, far longer).
  await closeControlServer(server);
}

/**
 * Tag an error with whether another attempt could plausibly succeed. The retry
 * loop reads `retryable === true` only, so anything unmarked fails fast rather
 * than spending the phase budget three times over.
 * @param {string} message
 * @param {boolean} retryable
 * @returns {Error & { retryable: boolean }}
 */
function sourceError(message, retryable, retryAfterMs = null) {
  const err = /** @type {Error & { retryable: boolean, retryAfterMs: number | null }} */ (
    new Error(message)
  );
  err.retryable = retryable;
  // Decision: A server-directed delay (GitHub's `retry-after` / `x-ratelimit-reset`). Null means "use
  // the caller's fixed backoff".
  err.retryAfterMs = retryAfterMs;
  return err;
}

/**
 * How long the server asked us to wait, in ms, or null. Handles `retry-after` in
 * both of its documented forms (delta-seconds and an HTTP-date) and GitHub's
 * `x-ratelimit-reset` (epoch SECONDS). Clamped at zero: a reset time already in
 * the past means "retry now", not a negative sleep.
 * @param {{ get(name: string): string | null } | undefined | null} headers
 * @param {number} now
 */
// Decision: GitHub's secondary-limit wording. Matched against a bounded prefix of the error body, not
// the whole response.
export const SECONDARY_RATE_LIMIT_PATTERN = /secondary rate limit|abuse detection/i;

// Decision: Bytes of a 403 body read to look for that wording. Error bodies are tiny JSON.
export const ERROR_BODY_SNIFF_BYTES = 2048;

// Decision: Fallback wait for a rate limit that names no delay (GitHub advises >= 60s).
export const SECONDARY_RATE_LIMIT_DELAY_MS = 60_000;

export function parseRetryAfterMs(headers, now = Date.now()) {
  if (!headers || typeof headers.get !== 'function') {
    return null;
  }
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, Math.round(seconds * 1000));
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) {
      return Math.max(0, at - now);
    }
  }
  // Decision: Only when the quota is actually spent. GitHub returns `x-ratelimit-reset` on each response,
  // so honoring it unconditionally turns an ordinary retryable 500 into a fatal one: the routine
  // reset can be an hour out, and a backoff that long doesn't fit the phase budget, so the loop
  // breaks instead of retrying.
  if (headers.get('x-ratelimit-remaining') !== '0') {
    return null;
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - now);
  }
  return null;
}

/**
 * Is this response worth another attempt?
 *
 * Status alone is not enough for 403. GitHub returns 403 for BOTH a permission
 * failure and a rate limit — primary (`x-ratelimit-remaining: 0`) and secondary
 * (`retry-after`) — and a rate limit is the most retryable thing there is. Only a
 * 403 with no rate-limit signal is the settled "this token may not read this
 * repo" answer. 401 and 404/410 stay terminal: they do not change in a minute.
 *
 * @param {number} status
 * @param {{ get(name: string): string | null } | undefined | null} headers
 */
export function isRetryableSourceStatus(status, headers = null, body = '') {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return true;
  }
  if (status !== 403) {
    return false;
  }
  if (headers && typeof headers.get === 'function') {
    if (headers.get('retry-after') !== null || headers.get('x-ratelimit-remaining') === '0') {
      return true;
    }
  }
  // Decision: A secondary rate limit can arrive with neither header: GitHub documents it as a 403 (or
  // 429) whose body names the limit. Without this, a burst of concurrent builds against one
  // installation fails outright on the first try.
  return SECONDARY_RATE_LIMIT_PATTERN.test(body);
}

// Decision: `headers.get`, tolerant of the plain objects the unit tests hand in.
function headerValue(headers, name) {
  return headers && typeof headers.get === 'function' ? headers.get(name) : null;
}

/**
 * Cancel a response body we are about to discard. `readErrorSnippet` already
 * cancels the ones it reads, so this is a no-op for those (the stream is locked).
 * @param {{ body?: unknown }} res
 */
async function discardBody(res) {
  const body = /** @type {ReadableStream<Uint8Array> | null | undefined} */ (res.body);
  if (!body || typeof body.cancel !== 'function' || body.locked) {
    return;
  }
  try {
    await body.cancel();
  } catch {
    // Decision: Already errored or closed; nothing to release.
  }
}

/**
 * Read at most `ERROR_BODY_SNIFF_BYTES` of an error response. Never throws and
 * never waits on the whole body: this runs on the failure path, where the point
 * is to classify quickly, not to collect the payload.
 * @param {{ body?: unknown }} res
 */
async function readErrorSnippet(res) {
  const body = /** @type {ReadableStream<Uint8Array> | null | undefined} */ (res.body);
  if (!body || typeof body.getReader !== 'function') {
    return '';
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let bytes = 0;
  try {
    while (bytes < ERROR_BODY_SNIFF_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // Decision: Slice before decoding. Bounding the loop on the accumulated result isn't the same as
      // bounding the work: one chunk can be arbitrarily large, and decoding it whole would
      // materialize the whole body before the next length check runs.
      const take = value.subarray(0, ERROR_BODY_SNIFF_BYTES - bytes);
      bytes += take.length;
      out += decoder.decode(take, { stream: true });
    }
  } catch {
    // Decision: A truncated or broken error body tells us nothing; treat it as empty.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Decision: Already closed.
    }
  }
  return out;
}

// Decision: Wipe and recreate WORK_DIR. A retry has to start from an empty tree: a stalled attempt
// leaves a partially extracted archive behind, and `tar` would extract the second attempt's
// copy on top of it, leaving a mix of both.
//
// Scoped to WORK_DIR (`/tmp/build/src`) and nothing else.
async function resetWorkDirTree() {
  // Decision: Async, not `rmSync`. This agent is PID 1: a synchronous recursive delete of a large partial
  // tree blocks the stall watchdog, the HTTP control server (so /cancel and the DO's log pull
  // both stop answering) and the event loop itself for as long as it runs. It also sits on the
  // timed path, so it mustn't be able to push the phase budget past its ceiling unobserved.
  await rm(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

// Decision: Sub-second values stay in milliseconds: rounding them to seconds prints "0s", which reads
// as a bug in the very message that's supposed to explain a failure.
function formatDuration(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1000)}s`;
}

function formatRate(bytes, elapsedMs) {
  return `${formatBytes((bytes * 1000) / Math.max(1, elapsedMs))}/s`;
}

/**
 * Stream a fetch body through `tar` into WORK_DIR, stripping the top-level
 * `<repo>-<sha>/` directory. Streams straight into the child to avoid buffering
 * the whole archive in memory.
 *
 * `onBytes` is called with each chunk's length. That is what feeds both the stall
 * watchdog and the progress log in `downloadSource`; the metering runs as a
 * pipeline STAGE rather than a `data` listener, which would put the source into
 * flowing mode and race `pipeline` for the chunks.
 *
 * Exported so the retry loop above it is unit-testable without spawning `tar`.
 *
 * @param {unknown} body web ReadableStream from `fetch`
 * @param {{ onBytes?: (length: number) => void, signal?: AbortSignal }} [options]
 * @returns {Promise<void>}
 */
export function extractTarball(body, options = {}) {
  const {
    onBytes = () => {},
    signal,
    // Decision: Seams for the child-lifecycle test. A real `tar` reacts to SIGTERM too promptly to prove
    // that this promise waits for 'close' rather than settling on the pipeline's rejection, so the
    // test supplies a child that deliberately stays alive. Production uses the real spawn and
    // grace.
    spawnImpl = spawn,
    killGraceMs = EXTRACT_KILL_GRACE_MS,
  } = options;
  return new Promise((resolve, reject) => {
    const tar = spawnImpl('tar', ['xz', '--strip-components=1', '-C', WORK_DIR], {
      stdio: ['pipe', 'inherit', 'pipe'],
    });
    // Decision: Track the extraction child as the cancel target, mirroring runChild, so a /cancel (or PID-1
    // SIGTERM) stops a large download promptly: killing tar closes its stdin, so the `pipeline`
    // below rejects and destroys the source web stream, which also aborts the in-flight fetch
    // body pull.
    activeChild = tar;

    // Decision: First failure seen. The promise still settles from 'close', not before.
    let settleError = null;
    /** @type {NodeJS.Timeout | undefined} */
    let killTimer;

    // Decision: SIGTERM, then SIGKILL if the child ignores it. Without the escalation a wedged `tar` would
    // hold this promise, and so the retry loop and the phase budget, open indefinitely.
    const stopTar = () => {
      if (tar.exitCode !== null || tar.signalCode !== null) {
        return;
      }
      try {
        tar.kill('SIGTERM');
      } catch {
        // Decision: The child already exited.
      }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          try {
            tar.kill('SIGKILL');
          } catch {
            // Decision: The child already exited.
          }
        }, killGraceMs);
        killTimer.unref?.();
      }
    };

    const fail = (err) => {
      if (!settleError) {
        settleError = err instanceof Error ? err : new Error(String(err));
      }
      stopTar();
    };

    // Decision: Aborting the fetch errors the body stream, which `pipeline` turns into a rejection, but
    // only once the stream notices. Killing `tar` directly makes the stall guard authoritative
    // instead of dependent on how promptly a half-dead socket reports itself, and it releases the
    // child either way.
    signal?.addEventListener('abort', () => fail(sourceError('extraction aborted', true)), {
      once: true,
    });
    if (cancelled) {
      // Decision: Cancel raced the spawn: terminate immediately.
      stopTar();
    }
    pipeStream(/** @type {NodeJS.ReadableStream} */ (tar.stderr), 'stderr');
    tar.on('error', (err) => {
      if (tar.pid === undefined) {
        // Decision: The child never spawned, so 'close' isn't guaranteed to arrive. This is the one path
        // allowed to settle without it.
        if (activeChild === tar) {
          activeChild = null;
        }
        clearTimeout(killTimer);
        reject(sourceError(err instanceof Error ? err.message : String(err), true));
        return;
      }
      fail(err);
    });
    tar.on('close', (code) => {
      clearTimeout(killTimer);
      // Decision: Clear the cancel target only when it's still ours. A superseded attempt's late 'close'
      // mustn't erase the current attempt's child, or a later /cancel or PID-1 SIGTERM would be a
      // silent no-op for a live extraction.
      if (activeChild === tar) {
        activeChild = null;
      }
      if (settleError) {
        reject(settleError);
        return;
      }
      if (code === 0) {
        resolve(undefined);
        return;
      }
      // Decision: Retryable: the likeliest cause is a truncated stream, which is what an aborted or dropped
      // download produces. A truly corrupt archive costs the remaining attempts, and the phase
      // budget bounds that.
      reject(sourceError(`tar exited with code ${code}`, true));
    });
    // Decision: Use `pipeline` (not a bare `.pipe()`): the source web stream can abort mid-download, and a
    // bare pipe would emit 'error' on the Readable with no listener, an uncaughtException that
    // crashes the process without the structured fatal log and final flushLogs.
    //
    // A pipeline failure records the error and kills the child; it doesn't settle. Settling here
    // resolved the promise while `tar` was still writing, so the retry loop could `rm -rf`
    // WORK_DIR under a running extraction, and the old child's later 'close' would clear
    // `activeChild` out from under the new attempt. Waiting for 'close' makes "attempt finished"
    // mean the child is actually reaped.
    pipeline(
      Readable.fromWeb(/** @type {any} */ (body)),
      async function* meter(source) {
        for await (const chunk of source) {
          onBytes(chunk.length);
          yield chunk;
        }
      },
      tar.stdin,
    ).catch(fail);
  });
}

/**
 * Download the GitHub source tarball (authenticated) and extract it into
 * WORK_DIR.
 *
 * Uses Node's built-in fetch (so the SOURCE_TOKEN is never placed on a shell
 * command line). Equivalent curl form, documented as a fallback:
 *   curl -fsSL -H "Authorization: Bearer $SOURCE_TOKEN" "$SOURCE_TARBALL_URL" \
 *     | tar xz --strip-components=1 -C "$WORK_DIR"
 *
 * Bounded on three axes, in order of which one actually fires:
 *
 *   1. STALL — no bytes for `stallTimeoutMs` aborts the attempt. This is the real
 *      guard. A healthy download streams continuously, so it cannot fire on one;
 *      a dead stream trips it in 20s instead of holding the build until the DO's
 *      `enforceTimeout`.
 *   2. RETRY — a transient failure starts over from an empty WORK_DIR. Degraded
 *      streams often recover briefly, so a fresh connection is a real chance
 *      rather than a formality.
 *   3. PHASE BUDGET — one wall clock across ALL attempts. Catches the case no
 *      stall timer can see: a steady trickle that never pauses long enough to
 *      look dead.
 *
 * Deliberately NOT bounded by a per-attempt wall clock or a throughput floor.
 * Either would fail a large repo on a slow but honest link.
 *
 * Every dependency is injectable so the retry policy is unit-testable without a
 * network or a `tar` child. Timers are real — pass small millisecond values.
 *
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   extract?: (
 *     body: unknown,
 *     options?: { onBytes?: (length: number) => void, signal?: AbortSignal },
 *   ) => Promise<void>,
 *   resetWorkDir?: () => void | Promise<void>,
 *   sleep?: (ms: number) => Promise<void>,
 *   isCancelled?: () => boolean,
 *   stallTimeoutMs?: number,
 *   phaseBudgetMs?: number,
 *   maxAttempts?: number,
 *   backoffMs?: ReadonlyArray<number>,
 *   progressIntervalMs?: number,
 * }} [options]
 * @returns {Promise<void>}
 */
export async function downloadSource(options = {}) {
  const {
    fetchImpl = fetch,
    extract = extractTarball,
    resetWorkDir = resetWorkDirTree,
    sleep = sleepMs,
    isCancelled = () => cancelled,
    stallTimeoutMs = SOURCE_STALL_TIMEOUT_MS,
    phaseBudgetMs = SOURCE_PHASE_BUDGET_MS,
    maxAttempts = SOURCE_DOWNLOAD_MAX_ATTEMPTS,
    backoffMs = SOURCE_RETRY_BACKOFF_MS,
    progressIntervalMs = SOURCE_PROGRESS_INTERVAL_MS,
  } = options;

  const tarballUrl = requireEnv('SOURCE_TARBALL_URL');
  const sourceToken = requireEnv('SOURCE_TOKEN');
  const phaseDeadline = Date.now() + phaseBudgetMs;

  agentLog(`downloading source from ${redactUrl(tarballUrl)}`);

  let lastError = sourceError('source download made no attempt', false);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isCancelled()) {
      throw new Error('build cancelled');
    }
    if (Date.now() >= phaseDeadline) {
      lastError = sourceError(
        `source download exceeded its ${formatDuration(phaseBudgetMs)} budget`,
        false,
      );
      break;
    }

    // Decision: Start from an empty tree; see resetWorkDirTree. Awaited: the reset is real I/O on the timed
    // path, so the deadline is re-checked after it. Without the recheck a slow cleanup could hand
    // the next attempt a budget that's already spent, and the phase would quietly overrun its
    // ceiling.
    await resetWorkDir();
    if (Date.now() >= phaseDeadline) {
      lastError = sourceError(
        `source download exceeded its ${formatDuration(phaseBudgetMs)} budget`,
        false,
      );
      break;
    }

    try {
      await downloadSourceAttempt({
        tarballUrl,
        sourceToken,
        fetchImpl,
        extract,
        isCancelled,
        stallTimeoutMs,
        phaseDeadline,
        progressIntervalMs,
      });
      return;
    } catch (error) {
      lastError = /** @type {Error & { retryable?: boolean }} */ (
        error instanceof Error ? error : new Error(String(error))
      );
      // Decision: A cancel isn't a download failure and mustn't be retried.
      if (isCancelled()) {
        throw new Error('build cancelled', { cause: error });
      }
      if (lastError.retryable !== true || attempt >= maxAttempts) {
        break;
      }
      // Decision: A rate-limited server told us when to come back; retrying sooner just deepens the limit.
      // Anything else uses the fixed backoff.
      const backoff =
        typeof lastError.retryAfterMs === 'number' && lastError.retryAfterMs >= 0
          ? lastError.retryAfterMs
          : (backoffMs[attempt - 1] ?? backoffMs.at(-1) ?? 0);
      // Decision: Don't sleep into the deadline just to be refused at the top of the loop. This also keeps a
      // long `retry-after` from parking the whole build: a delay that doesn't fit the phase budget
      // ends the download now.
      if (Date.now() + backoff >= phaseDeadline) {
        break;
      }
      agentLog(
        `source download attempt ${attempt} failed (${lastError.message}); retrying in ${formatDuration(backoff)}`,
      );
      await sleep(backoff);
    }
  }

  throw lastError;
}

/**
 * One download attempt: fetch, meter, extract. Resolves on success; every failure
 * path throws an error carrying `retryable`.
 * @param {{
 *   tarballUrl: string,
 *   sourceToken: string,
 *   fetchImpl: typeof fetch,
 *   extract: (
 *     body: unknown,
 *     options?: { onBytes?: (length: number) => void, signal?: AbortSignal },
 *   ) => Promise<void>,
 *   isCancelled: () => boolean,
 *   stallTimeoutMs: number,
 *   phaseDeadline: number,
 *   progressIntervalMs: number,
 * }} args
 */
async function downloadSourceAttempt(args) {
  const {
    tarballUrl,
    sourceToken,
    fetchImpl,
    extract,
    isCancelled,
    stallTimeoutMs,
    phaseDeadline,
    progressIntervalMs,
  } = args;

  const controller = new AbortController();
  const startedAt = Date.now();
  let bytes = 0;
  let lastByteAt = startedAt;
  let lastProgressAt = startedAt;
  // Decision: Set by whichever watchdog aborted, so the throw below can name the cause.
  let abortReason = null;
  let abortRetryable = true;

  // Decision: One repeating watchdog rather than a timer re-armed per chunk: a 20 MB archive is hundreds
  // of chunks, and this also covers the case where the first byte never arrives (lastByteAt
  // starts at the attempt's start).
  const tick = Math.max(1, Math.min(1000, Math.floor(stallTimeoutMs / 4)));
  const watchdog = setInterval(() => {
    const nowMs = Date.now();
    if (nowMs - lastByteAt >= stallTimeoutMs) {
      abortReason = `no data for ${formatDuration(stallTimeoutMs)}`;
      abortRetryable = true;
      controller.abort();
      return;
    }
    if (nowMs >= phaseDeadline) {
      abortReason = 'download budget exhausted';
      abortRetryable = false;
      controller.abort();
    }
  }, tick);
  if (typeof watchdog.unref === 'function') {
    watchdog.unref();
  }

  try {
    const res = await fetchImpl(tarballUrl, {
      headers: {
        authorization: `Bearer ${sourceToken}`,
        // Decision: GitHub codeload follows a redirect from api.github.com; the UA keeps it happy.
        'user-agent': 'platform-build-agent',
        accept: 'application/vnd.github+json',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) {
      // Decision: Classify from the status line and headers first, before touching the body. A 429, or a 403
      // that already carries `retry-after` / `x-ratelimit-remaining: 0`, is a rate limit on the
      // evidence we hold, and reading its body could only lose that: a response whose body stalls
      // trips the stall watchdog, and the abort would replace a known `retry-after` with a generic
      // retryable error.
      const headerRateLimited =
        res.status === 429 ||
        (res.status === 403 &&
          (headerValue(res.headers, 'retry-after') !== null ||
            headerValue(res.headers, 'x-ratelimit-remaining') === '0'));
      // Decision: Only an otherwise-ambiguous 403 is worth a body read: it's the one case where
      // retryability can't be decided from status plus headers.
      const snippet = res.status === 403 && !headerRateLimited ? await readErrorSnippet(res) : '';
      // Decision: Release the connection. Nothing downstream reads an error body, and undici holds the socket
      // open for one that's neither consumed nor cancelled, so on the retry path the abandoned
      // attempt competes with its own retry for the pool.
      await discardBody(res);
      const retryable = isRetryableSourceStatus(res.status, res.headers, snippet);
      const rateLimited =
        headerRateLimited || (res.status === 403 && SECONDARY_RATE_LIMIT_PATTERN.test(snippet));
      throw sourceError(
        `source download failed: HTTP ${res.status}`,
        retryable,
        parseRetryAfterMs(res.headers) ?? (rateLimited ? SECONDARY_RATE_LIMIT_DELAY_MS : null),
      );
    }
    if (!res.body) {
      throw sourceError('source download failed: empty response body', true);
    }
    if (isCancelled()) {
      // Decision: Cancel landed during the fetch await: don't start extraction at all.
      throw new Error('build cancelled');
    }

    await extract(res.body, {
      signal: controller.signal,
      onBytes: (length) => {
        bytes += length;
        const nowMs = Date.now();
        lastByteAt = nowMs;
        if (nowMs - lastProgressAt >= progressIntervalMs) {
          lastProgressAt = nowMs;
          const elapsed = nowMs - startedAt;
          agentLog(
            `downloading source: ${formatBytes(bytes)} in ${formatDuration(elapsed)} (${formatRate(bytes, elapsed)})`,
          );
        }
      },
    });

    const elapsed = Date.now() - startedAt;
    agentLog(
      `source extracted (${formatBytes(bytes)} in ${formatDuration(elapsed)}, ${formatRate(bytes, elapsed)})`,
    );
  } catch (error) {
    // Decision: An abort surfaces as a generic AbortError from fetch or the pipeline, so the watchdog's
    // reason is the only thing that says which bound was hit.
    if (abortReason) {
      throw sourceError(`source download aborted: ${abortReason}`, abortRetryable);
    }
    // Decision: A cancel isn't a transport failure and mustn't be retried; the loop's own `isCancelled()`
    // check owns it. Pass it through untouched.
    if (cancelled) {
      throw error;
    }
    // Decision: Anything already classified (an HTTP status, a non-zero `tar`) keeps its verdict.
    if (error instanceof Error && typeof (/** @type {any} */ (error).retryable) === 'boolean') {
      throw error;
    }
    // Decision: Everything else reaching here came off the wire: `fetch` rejecting with `TypeError: fetch
    // failed`, or the body stream erroring mid-transfer so `pipeline` rejects. Those are the most
    // ordinary transient failures, so retry them; `maxAttempts` and the phase budget bound it.
    throw sourceError(error instanceof Error ? error.message : String(error), true);
  } finally {
    clearInterval(watchdog);
  }
}

/**
 * Read the repo's `package.json#packageManager` pin (e.g. "pnpm@9.1.0"). Returns
 * the raw string, or '' if the file is missing/unreadable/has no pin. Wrapped in
 * try/catch so a malformed package.json can't crash install resolution.
 * @returns {string}
 */
function readPackageManagerPin() {
  try {
    const pkg = JSON.parse(readFileSync(`${WORK_DIR}/package.json`, 'utf8'));
    return typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
  } catch {
    return '';
  }
}

/**
 * Sniffs `WORK_DIR/yarn.lock` to tell Yarn Classic (v1) from Berry (v2+) when no
 * `packageManager` pin disambiguates. Yarn 1 locks carry a `# yarn lockfile v1`
 * header; Berry locks carry a `__metadata:` block. Returns 'classic' | 'berry' |
 * 'unknown' (missing/unreadable/empty). Wrapped in try/catch like
 * readPackageManagerPin so a read error can't crash install resolution.
 * @returns {'classic' | 'berry' | 'unknown'}
 */
function readYarnLockKind() {
  try {
    const head = readFileSync(`${WORK_DIR}/yarn.lock`, 'utf8').slice(0, 200);
    if (head.includes('# yarn lockfile v1')) {
      return 'classic';
    }
    if (head.includes('__metadata:')) {
      return 'berry';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Detect a Berry `yarnPath` in `WORK_DIR/.yarnrc.yml`. When present, the
 * corepack-default Yarn Classic (1.22) re-execs that bundled Berry release (the
 * `yarnPath` re-exec is honored by Yarn 1.x), so a Berry repo builds correctly
 * even with no `packageManager` pin. Substring sniff (like readYarnLockKind),
 * try/catch so a missing/unreadable file can't crash install resolution.
 * @returns {boolean}
 */
function hasYarnrcYarnPath() {
  try {
    return /^\s*yarnPath\s*:/m.test(readFileSync(`${WORK_DIR}/.yarnrc.yml`, 'utf8'));
  } catch {
    return false;
  }
}

// Decision: corepack runs pnpm and yarn so the repo's `packageManager` pin is honored; bun and npm run
// directly.
function resolveInstall() {
  if (existsSync(`${WORK_DIR}/pnpm-lock.yaml`)) {
    return { manager: 'pnpm', cmd: 'corepack', args: ['pnpm', 'install', '--frozen-lockfile'] };
  }
  if (existsSync(`${WORK_DIR}/bun.lock`) || existsSync(`${WORK_DIR}/bun.lockb`)) {
    return { manager: 'bun', cmd: 'bun', args: ['install', '--frozen-lockfile'] };
  }
  if (existsSync(`${WORK_DIR}/yarn.lock`)) {
    // Decision: Yarn Classic (1.x) doesn't recognize Berry's `--immutable` and would silently run a mutable
    // install, losing the frozen-lockfile guarantee. Choose the flag by the Yarn version that will
    // actually run:
    // - pin `yarn@1.x`: `--frozen-lockfile` (Classic)
    // - pin `yarn@2+`: `--immutable` (Berry)
    // - no pin, `.yarnrc.yml` yarnPath present: Yarn 1.22 re-execs the bundled Berry release, so
    //   `--immutable` (Berry), whatever the lock header.
    // - no pin, no yarnPath, Berry `__metadata` lock: corepack's default Yarn 1.22 would run, but
    //   it ignores `--immutable` and can't parse a Berry lock. There's no resolvable Yarn version,
    //   so fail fast with actionable guidance instead of a confusing mid-install error.
    // - no pin otherwise (Classic `# yarn lockfile v1` header or unknown lock): `--frozen-lockfile`.
    const pin = readPackageManagerPin();
    let flag;
    if (/^yarn@1\./.test(pin)) {
      flag = '--frozen-lockfile';
    } else if (/^yarn@/.test(pin)) {
      flag = '--immutable';
    } else if (hasYarnrcYarnPath()) {
      flag = '--immutable';
    } else if (readYarnLockKind() === 'berry') {
      throw new Error(
        'Yarn Berry (v2+) lockfile detected but no Yarn version is resolvable. Add a ' +
          '"packageManager" field (e.g. "yarn@4.x") to package.json, or commit a .yarnrc.yml ' +
          'with a yarnPath, so the build runs the correct Yarn.',
      );
    } else {
      flag = '--frozen-lockfile';
    }
    return { manager: 'yarn', cmd: 'corepack', args: ['yarn', 'install', flag] };
  }
  if (existsSync(`${WORK_DIR}/package-lock.json`)) {
    return { manager: 'npm', cmd: 'npm', args: ['ci'] };
  }
  // Decision: No lockfile. Before defaulting to `npm install` (which would break a pnpm `workspace:*` repo
  // or install a different graph), honor a `packageManager` pin if present. No lockfile means no
  // frozen flag.
  const pin = readPackageManagerPin();
  if (pin.startsWith('pnpm@')) {
    return { manager: 'pnpm', cmd: 'corepack', args: ['pnpm', 'install'] };
  }
  if (pin.startsWith('yarn@')) {
    // Decision: `--no-immutable` is required here, and only here. Yarn Berry >= 3.0.0 defaults
    // `enableImmutableInstalls` to true when it detects CI, and `nonInteractiveEnv()` sets
    // `CI=true` for each child, so this branch, whose purpose is to create the missing lockfile,
    // would abort with `YN0028: The lockfile would have been created by this install, which is
    // explicitly forbidden`. Measured on Berry 3.0.0 / 3.6.4 / 4.14.1 / 4.18.0; 2.4.3 predates the
    // default, and Yarn Classic ignores the flag, which matters because a `yarn@1.x` pin lands here
    // too. pnpm needs nothing: it drops its implicit CI frozen-lockfile when the lockfile is absent.
    //
    // Scope matters. Don't hoist this into `nonInteractiveEnv()`: that env is shared with the
    // deploy child, where a repo's own `yarn install --immutable` has to stay immutable. And don't
    // relax the lockfile plans above, or a build could mutate a committed lockfile and deploy
    // resolutions the repo never pinned.
    return { manager: 'yarn', cmd: 'corepack', args: ['yarn', 'install', '--no-immutable'] };
  }
  if (pin.startsWith('bun@')) {
    return { manager: 'bun', cmd: 'bun', args: ['install'] };
  }
  return { manager: 'npm', cmd: 'npm', args: ['install'] };
}

/**
 * Spawn a child in WORK_DIR, stream its stdout/stderr into the log pipeline,
 * and resolve with its exit code. Honors the cancel flag (SIGTERM).
 *
 * `opts.env` MUST be supplied for any step that runs untrusted repo code (the
 * package-manager install and `bwf deploy`, whose lifecycle scripts the repo
 * controls). Use `sanitizeChildEnv(...)` to strip the control-plane + credential
 * secrets (DO_LOG_URL, SOURCE_TOKEN, AGENT_TOKEN, BWF_TOKEN) so a malicious
 * postinstall can't reach/authenticate to the DO endpoints or steal the deploy
 * token. The deploy step re-injects BWF_TOKEN via the `extra` overrides.
 * @param {string} cmd
 * @param {Array<string>} args
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<number>}
 */
function runChild(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    agentLog(`$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      ...childSpawnOptions(),
      env: opts.env ?? process.env,
    });
    // Decision: Track each child as the active cancel target. Only one untrusted child runs at a time
    // (install is awaited before the deploy child spawns), so a cancel that arrives mid-install
    // interrupts the install instead of letting it run to completion and burn the container slot.
    activeChild = child;
    if (cancelled) {
      // Decision: Cancel raced the spawn: terminate immediately.
      try {
        child.kill('SIGTERM');
      } catch {}
    }
    pipeStream(/** @type {NodeJS.ReadableStream} */ (child.stdout), 'stdout');
    pipeStream(/** @type {NodeJS.ReadableStream} */ (child.stderr), 'stderr');
    child.on('error', reject);
    child.on('close', (code, signal) => {
      activeChild = null;
      // Decision: Signal-terminated (for example cancel) reports as non-zero so the DO fails it.
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

/**
 * Hand the just-extracted source tree to the non-root builder uid. `tar` runs as
 * the root agent, so WORK_DIR's contents are root-owned, but the install/deploy
 * children run as BUILDER_UID (childSpawnOptions) and must write node_modules /
 * build output into it. Only root can chown to another uid, so this is a no-op
 * when the agent is NOT root — i.e. off-container unit tests, where the real
 * install/deploy is injected away anyway.
 * @returns {Promise<void>}
 */
function chownWorkDirToBuilder() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const child = spawn('chown', ['-R', `${BUILDER_UID}:${BUILDER_GID}`, WORK_DIR], {
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`chown exited with code ${code}`));
      }
    });
  });
}

/**
 * Parse the real uid out of a `/proc/<pid>/status` blob (the first field of the
 * `Uid:\t<real>\t<effective>\t<saved>\t<fs>` line). Returns null when the line
 * is absent (kernel-thread races, truncated read). Exported so the parse is
 * unit-testable without a real `/proc`.
 * @param {string} statusText
 * @returns {number | null}
 */
export function parseProcStatusUid(statusText) {
  const match = /^Uid:\s+(\d+)/m.exec(statusText);
  return match ? Number(match[1]) : null;
}

/**
 * SIGKILL every process owned by BUILDER_UID. Run AFTER the install child has
 * closed and BEFORE the deploy child spawns: a dependency lifecycle script
 * (postinstall etc.) that daemonizes during install survives the install child's
 * close by reparenting to the pid-1 agent, and runs as the SAME BUILDER_UID as
 * the upcoming deploy child. Same-uid `/proc/<pid>/environ` reads are permitted
 * by the kernel, so such a leftover could read the deploy child's environ — which
 * carries the re-injected `BWF_TOKEN` and the staging CF Access pair. The
 * existing root-vs-builder uid boundary only denies a child reading the ROOT
 * agent's `/proc`; it does NOT cover this sibling-to-sibling vector.
 *
 * This is best-effort defense-in-depth, NOT a complete close. It is a single
 * `/proc` sweep: it SIGKILLs processes alive at the instant of the scan, so it
 * reaps the straightforward "daemonize during install" case. It does NOT seal the
 * vector — a process that double-forks a new child after this scan's `readdir`
 * (its pid never enumerated), or re-spawns faster than one sweep, survives into
 * the deploy window. The kernel-enforced complete fix is per-phase UID separation
 * (a distinct uid for the deploy child), deferred because deploy and install
 * share one `node_modules`/work-tree. Crucially the residual is bounded by — and
 * dominated by — the already-accepted trust-split limitation: `bwf deploy` runs
 * the project's own (untrusted) build in-process, so that code holds BWF_TOKEN
 * directly regardless of this sweep. The reap narrows the surface; it does not,
 * and cannot here, eliminate it.
 *
 * Root-gated like {@link chownWorkDirToBuilder} (only root can signal another
 * uid's processes; off-container unit tests aren't root and inject the real
 * install/deploy away anyway). The slim node base image ships no `pkill`/procps,
 * so this scans `/proc` directly. Killing all BUILDER_UID processes is safe at
 * this point: the install child is already awaited closed and the deploy child is
 * not yet spawned, so nothing legitimate runs as BUILDER_UID.
 * @returns {Promise<void>}
 */
function killBuilderProcesses() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return Promise.resolve();
  }
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return Promise.resolve();
  }
  let killed = 0;
  for (const entry of entries) {
    const pid = Number(entry);
    // Decision: Skip non-pid entries and pid 1 (the root agent: killing it would tear down the build
    // itself).
    if (!Number.isInteger(pid) || pid <= 1) {
      continue;
    }
    let uid;
    try {
      uid = parseProcStatusUid(readFileSync(`/proc/${pid}/status`, 'utf8'));
    } catch {
      // Decision: Process exited between readdir and read: nothing to kill.
      continue;
    }
    if (uid !== BUILDER_UID) {
      continue;
    }
    try {
      process.kill(pid, 'SIGKILL');
      killed++;
    } catch {
      // Decision: Already gone or unsignalable; best effort.
    }
  }
  if (killed > 0) {
    agentLog(`reaped ${killed} leftover builder process(es) before deploy`);
  }
  return Promise.resolve();
}

/**
 * Control-plane + credential env vars that must NEVER reach untrusted repo
 * child processes by default. `DO_LOG_URL` is the DO endpoint origin;
 * `SOURCE_TOKEN` is the GitHub installation token; `AGENT_TOKEN` authenticates
 * control POSTs; `BWF_TOKEN` is the live project-scoped deploy JWT. A repo's
 * lifecycle scripts (postinstall etc.) running with these in `process.env`
 * could forge build status, scrape the source token, hit the DO directly, or
 * exfiltrate the deploy token / publish artifacts to the scoped project within
 * the token TTL. `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` are the shared
 * staging CF Access service token (present only on staging builds) — a leaked
 * pair would let untrusted code reach every Access-gated staging host, so they
 * are scrubbed too. `BWF_TOKEN` and the CF Access pair are the secrets the
 * trusted `bwf deploy` invocation legitimately needs, so the deploy spawn
 * re-injects them via the `extra` overrides — the install (and every other
 * untrusted) child never sees them.
 * @type {ReadonlyArray<string>}
 */
export const SCRUBBED_ENV_VARS = [
  'DO_LOG_URL',
  'SOURCE_TOKEN',
  'AGENT_TOKEN',
  'BWF_TOKEN',
  'CF_ACCESS_CLIENT_ID',
  'CF_ACCESS_CLIENT_SECRET',
  'PLATFORM_ACCESS_CREDENTIALS',
];

/**
 * Build the env for a child process that runs untrusted repo code. Starts from
 * the current `process.env`, drops every control-plane secret in
 * `SCRUBBED_ENV_VARS`, and applies any `extra` overrides. Pure + exported so it
 * can be unit-tested without spawning anything.
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {Record<string, string | undefined>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function sanitizeChildEnv(baseEnv, extra = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...baseEnv };
  for (const key of SCRUBBED_ENV_VARS) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

// Decision: Strip query and userinfo from a URL for logging (codeload URLs are tokenless, but be
// defensive about anything sensitive in the query string).
function redactUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<source tarball>';
  }
}

export function resolveSourceBwfCli(root = WORK_DIR) {
  const packageRoot = `${root}/packages/bwf`;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(`${packageRoot}/package.json`, 'utf8'));
  } catch {
    return null;
  }
  if (manifest.name !== '@builtbyfriends/bwf' || typeof manifest.bin?.bwf !== 'string') {
    return null;
  }
  const cli = `${packageRoot}/${manifest.bin.bwf}`;
  if (!existsSync(cli)) {
    throw new Error(
      'The workspace bwf CLI is not built. Run build:core during dependency installation.',
    );
  }
  return cli;
}

/**
 * Run the build pipeline and resolve to the process exit code (0 = success,
 * non-zero = failure). This function NEVER calls `process.exit` and NEVER
 * leaves via an early `return` that bypasses an exit decision: every phase
 * resolves to a code that the single top-level driver (`main`) hands to
 * `process.exit`. The container must always terminate, so a failed install /
 * download / deploy returns a non-zero code rather than dropping out of the
 * driver and letting the still-open control server keep the process alive.
 *
 * Step functions are injectable so the lifecycle invariant (install failure ->
 * non-zero exit code, no hang) is unit-testable without spawning anything.
 * @param {{
 *   downloadSource?: () => Promise<void>,
 *   resolveInstall?: () => { manager: string, cmd: string, args: Array<string> },
 *   runChild?: (cmd: string, args: Array<string>, opts?: { env?: NodeJS.ProcessEnv }) => Promise<number>,
 *   reportStatus?: (status: string) => Promise<void>,
 *   hasLocalBwf?: () => boolean,
 *   resolveSourceBwfCli?: () => string | null,
 *   chownWorkDir?: () => Promise<void>,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function runBuild(deps = {}) {
  const download = deps.downloadSource ?? downloadSource;
  const install = deps.resolveInstall ?? resolveInstall;
  const run = deps.runChild ?? runChild;
  const chownWorkDir = deps.chownWorkDir ?? chownWorkDirToBuilder;
  const killBuilders = deps.killBuilderProcesses ?? killBuilderProcesses;
  const status = deps.reportStatus ?? reportStatus;
  // Decision: A present `.pnp.cjs` means the repo uses Yarn Berry Plug'n'Play: there's no `node_modules`
  // tree, so the deploy has to run through the package manager (`corepack yarn ...`) to activate
  // the PnP runtime rather than bare npx. `pnpPresent` only selects the runner below. It isn't
  // the same as "bwf is locally resolvable": a PnP repo that doesn't declare
  // `@builtbyfriends/bwf` still needs the `yarn dlx bwf@<ver>` fallback, so the local signal is
  // an actual dependency check.
  //
  // Assigned after the install step: a Yarn Berry PnP repo may not commit `.pnp.cjs` and instead
  // generate it during `yarn install`, so a pre-install check would read `false` and route it
  // down the bare-`npx` path (which can't resolve PnP-managed deps during `bwf deploy`).
  let pnpPresent = false;
  // Decision: Whether the repo declares `@builtbyfriends/bwf` as a dependency: the accurate "is bwf
  // locally resolvable" signal under PnP, where `node_modules/.bin/bwf` doesn't exist. Falls back
  // to `false` on any read or parse error (so the CLI is fetched).
  const repoDeclaresBwf = () => {
    try {
      const pkg = JSON.parse(readFileSync(`${WORK_DIR}/package.json`, 'utf8'));
      return Boolean(pkg.dependencies?.[BWF_PACKAGE] || pkg.devDependencies?.[BWF_PACKAGE]);
    } catch {
      return false;
    }
  };
  const hasLocalBwf =
    deps.hasLocalBwf ??
    (() => existsSync(`${WORK_DIR}/node_modules/.bin/bwf`) || (pnpPresent && repoDeclaresBwf()));

  try {
    // Decision: Capture the deploy token into a local, then drop it from the parent's heap env. Only the
    // trusted `bwf deploy` child needs it, and it's re-injected there via the `extra` overrides
    // below. Deleting it from `process.env` is defense in depth for the spawn-inheritance path
    // only: `sanitizeChildEnv` already strips it from each untrusted child's copy.
    //
    // This delete doesn't scrub `/proc/self/environ` (`unsetenv()` changes only the heap
    // `environ`), but the install child runs as the non-root BUILDER_UID, so its cross-uid read of
    // the root agent's `/proc/<ppid>/environ` is denied. BWF_TOKEN is re-injected into the deploy
    // child's own env, so the untrusted `vite build` inside `bwf deploy` can still read it from
    // its own `/proc/self/environ`: that's the separate CLI trust-split issue, not covered by the
    // uid boundary.
    const bwfToken = requireEnv('BWF_TOKEN');
    delete process.env.BWF_TOKEN;
    // Decision: Staging CF Access service token (set only on staging builds). Capture and drop from the
    // parent heap like BWF_TOKEN; re-injected only into the trusted deploy child below so
    // `bwf deploy` can authenticate past CF Access on the staging API host. Absent on production
    // and dev builds.
    const cfAccessClientId = process.env.CF_ACCESS_CLIENT_ID;
    const cfAccessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    delete process.env.CF_ACCESS_CLIENT_ID;
    delete process.env.CF_ACCESS_CLIENT_SECRET;
    const apiUrl = requireEnv('BWF_API_URL');
    const proxyUrl = process.env.PLATFORM_PROXY_URL;
    const project = requireEnv('BWF_PROJECT');

    if (cancelled) {
      throw new Error('build cancelled before start');
    }

    // Decision: The source token is last needed for the authenticated tarball fetch inside `download()`, so
    // drop it from the parent's heap env as soon as the download completes, before the untrusted
    // install and build children spawn. Defense in depth for the spawn-inheritance path only:
    // `sanitizeChildEnv` already strips it from each untrusted child's copy, and the children run
    // as the non-root BUILDER_UID, so the kernel denies their read of the root agent's
    // `/proc/<ppid>/environ`. The token is also repo-scoped and read-only (BuildManager mints it
    // with `{ contents: 'read' }` for this one repo).
    await download();
    delete process.env.SOURCE_TOKEN;
    // Decision: Hand the root-extracted tree to the non-root builder so the install and deploy children
    // (spawned as BUILDER_UID) can write into it. No-op off-container.
    await chownWorkDir();
    if (cancelled) {
      throw new Error('build cancelled');
    }

    // Decision: Repo lifecycle scripts (postinstall and so on) run here with a scrubbed env, with no
    // DO_LOG_URL, SOURCE_TOKEN, AGENT_TOKEN or BWF_TOKEN, so they can't forge build status,
    // exfiltrate the source token, or steal the deploy token.
    const installPlan = install();
    agentLog(`detected package manager: ${installPlan.manager}`);
    const installCode = await run(installPlan.cmd, installPlan.args, {
      env: sanitizeChildEnv(process.env, { ...nonInteractiveEnv(), ...builderCacheEnv() }),
    });
    if (installCode !== 0) {
      // Decision: Fall through to the single exit decision with the failing code. Don't bail out of the
      // driver, or the open control server would keep the container alive past install failure
      // (leaking a build slot).
      agentLog(`dependency install failed (exit ${installCode})`);
      return installCode;
    }
    if (cancelled) {
      throw new Error('build cancelled');
    }

    // Decision: Install is done and its children have closed. Before spawning the trusted deploy child,
    // which carries the re-injected BWF_TOKEN and CF Access pair, reap any BUILDER_UID process a
    // dependency lifecycle script daemonized during install. Left alive it would be a same-uid
    // sibling of the deploy child and could read its /proc/<pid>/environ (the uid boundary only
    // blocks reading the root agent's env). This narrows the surface but doesn't seal it; see
    // killBuilderProcesses.
    await killBuilders();

    // Decision: Detect Yarn PnP now that install has run: a Berry PnP repo may generate `.pnp.cjs` during
    // `yarn install` rather than committing it. This drives the deploy runner selection
    // (`corepack yarn ...` vs bare `npx`) and the PnP branch of hasLocalBwf below.
    pnpPresent = existsSync(`${WORK_DIR}/.pnp.cjs`);

    await status('deploying');

    // Decision: Run the real deploy via the built CLI in Platform source checkouts or the repo-local CLI in
    // consumer projects. `npx` resolves the version pinned in the repo's package.json; if the repo
    // has no local CLI, npx fetches the pinned fallback, which is why there's no --no-install
    // guard. The deploy child is the one trusted step that needs the deploy token, so BWF_TOKEN is
    // re-injected here on top of the scrubbed base env. The staging CF Access pair is re-injected
    // the same way (undefined off staging, so sanitizeChildEnv drops it). BWF_API_URL and
    // BWF_PROJECT aren't secrets. DO_LOG_URL, SOURCE_TOKEN and AGENT_TOKEN stay scrubbed:
    // `bwf deploy` runs repo build code and has no business reaching the DO control plane.
    //
    // Exposure of the re-injected secrets: the CLI deletes CF_ACCESS_CLIENT_ID/SECRET from its own
    // process.env after its API client captures the Access headers and before it spawns the repo's
    // `vite build`, so untrusted build code doesn't inherit the pair. What's left is the same-uid
    // /proc/<deploy-pid>/environ residue plus BWF_TOKEN itself, which the CLI's build child still
    // inherits. Both come from the CLI trust split (build and upload share one process) and can't
    // be fixed from this agent.
    const sourceCli = (deps.resolveSourceBwfCli ?? resolveSourceBwfCli)();
    const localBwf = hasLocalBwf();
    const fallbackVersion = bwfFallbackVersion();
    // Decision: Yarn Berry PnP repos have no `node_modules`, so a bare `npx bwf deploy` would run the CLI
    // outside the PnP runtime and the build children it spawns (vite build and so on) couldn't
    // resolve the repo's deps. Run the deploy through the package manager (`corepack yarn ...`) so
    // PnP is active and the children inherit it: `yarn bwf deploy` when bwf resolves in the PnP
    // graph, else `yarn dlx bwf@<ver> deploy`. The non-PnP path uses bare npx.
    /** @type {string} */
    let deployCmd;
    /** @type {Array<string>} */
    let deployArgs;
    if (sourceCli) {
      deployCmd = process.execPath;
      deployArgs = [sourceCli, 'deploy', '--project', project];
      agentLog('using the built workspace bwf CLI');
    } else if (pnpPresent) {
      deployCmd = 'corepack';
      deployArgs = localBwf
        ? ['yarn', 'bwf', 'deploy', '--project', project]
        : ['yarn', 'dlx', `${BWF_PACKAGE}@${fallbackVersion}`, 'deploy', '--project', project];
      if (!localBwf) {
        agentLog(`PnP repo; falling back to yarn dlx bwf@${fallbackVersion}`);
      }
    } else {
      deployCmd = 'npx';
      deployArgs = localBwf
        ? ['--yes', 'bwf', 'deploy', '--project', project]
        : ['--yes', `${BWF_PACKAGE}@${fallbackVersion}`, 'deploy', '--project', project];
      if (!localBwf) {
        agentLog(`no local void CLI found; falling back to npx bwf@${fallbackVersion}`);
      }
    }
    // Decision: Register the explicitly selected platform in this fresh build environment.
    const connectArgs = [
      ...deployArgs.slice(0, deployArgs.indexOf('deploy')),
      'connect',
      apiUrl,
      '--no-login',
    ];
    const connectCode = await run(deployCmd, connectArgs, {
      env: sanitizeChildEnv(process.env, {
        ...nonInteractiveEnv(),
        ...builderCacheEnv(),
        CF_ACCESS_CLIENT_ID: cfAccessClientId,
        CF_ACCESS_CLIENT_SECRET: cfAccessClientSecret,
        PLATFORM_ACCESS_ORIGIN: apiUrl,
      }),
    });
    if (connectCode !== 0) {
      agentLog(`bwf connect exited with code ${connectCode}`);
      return connectCode;
    }
    // Decision: The API and resource proxy are independently protected origins. Scope the
    // platform-provided pair explicitly; don't infer a proxy hostname.
    const accessCredentials =
      cfAccessClientId && cfAccessClientSecret
        ? JSON.stringify(
            Object.fromEntries(
              [apiUrl, proxyUrl].filter(Boolean).map((url) => [
                new URL(url).origin,
                {
                  CF_ACCESS_CLIENT_ID: cfAccessClientId,
                  CF_ACCESS_CLIENT_SECRET: cfAccessClientSecret,
                },
              ]),
            ),
          )
        : undefined;
    const deployCode = await run(deployCmd, deployArgs, {
      env: sanitizeChildEnv(process.env, {
        ...nonInteractiveEnv(),
        ...builderCacheEnv(),
        BWF_TOKEN: bwfToken,
        PLATFORM_ACCESS_ORIGIN: apiUrl,
        PLATFORM_ACCESS_CREDENTIALS: accessCredentials,
        // Decision: Re-inject the staging CF Access service token (undefined off staging, which
        // sanitizeChildEnv drops) so `bwf deploy` can pass CF Access.
        CF_ACCESS_CLIENT_ID: cfAccessClientId,
        CF_ACCESS_CLIENT_SECRET: cfAccessClientSecret,
      }),
    });
    agentLog(`bwf deploy exited with code ${deployCode}`);
    return deployCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(`[build-agent] fatal: ${message}`, 'stderr');
    return 1;
  }
}

/**
 * Termination handler for the agent process. The agent is PID 1 in the build
 * container (`CMD ["node", "/build-agent.mjs"]`, no init shim). Linux delivers a
 * signal to PID 1 ONLY when a handler is installed for it — an unhandled SIGTERM
 * to PID 1 is silently dropped. The BuildManager DO tears a build down with
 * `stop()`, which sends a bare SIGTERM and never escalates to SIGKILL on its own;
 * without this handler that SIGTERM is ignored, the container keeps running, and
 * it pins one of the fleet's global instance slots indefinitely. Installing the
 * handler is therefore what makes `stop()` work at all.
 *
 * Mirrors POST /cancel: flag the build cancelled and SIGTERM the active build
 * child (a cooperative child exits and the container terminates), then exit so the DO's
 * onStop fires and the slot is reclaimed. A child that ignores its own SIGTERM is
 * the DO's `destroy()` (SIGKILL) backstop, not ours.
 * @param {NodeJS.Signals} signal
 */
function onShutdownSignal(signal) {
  agentLog(`received ${signal}; cancelling build and shutting down`);
  cancelled = true;
  if (activeChild && activeChild.exitCode === null) {
    try {
      activeChild.kill('SIGTERM');
    } catch {
      // Decision: The child already exited.
    }
  }
  process.exit(1);
}

// Decision: Module import alone registers nothing; `main()` calls this once (the entrypoint guard keeps
// `main()` from running under test). Exported so a test can assert the listeners are
// installed.
export function installShutdownHandlers() {
  process.on('SIGTERM', onShutdownSignal);
  process.on('SIGINT', onShutdownSignal);
}

async function main() {
  // Decision: PID-1 signal handlers first: without them the kernel drops the DO's SIGTERM and a
  // torn-down build would keep running, leaking a global container slot.
  installShutdownHandlers();

  // Decision: Health and control server first so the DO's readiness probe and /cancel work throughout
  // the build.
  const server = await startControlServer();

  const flushTimer = setInterval(() => {
    void flushLogs();
  }, LOG_FLUSH_MS);
  flushTimer.unref?.();

  let exitCode = 1;
  try {
    exitCode = await runBuild();
  } finally {
    clearInterval(flushTimer);
    await finishBuildLogging(server);
  }

  // Decision: The DO's onStop maps exit 0 to complete and non-zero to failed. Run on each path (install,
  // download or deploy failure and success alike) so the container terminates.
  process.exit(exitCode);
}

// Decision: Only auto-run when executed as the container entrypoint. When imported (for example by unit
// tests of `sanitizeChildEnv` or `runBuild`), the module exposes its helpers without starting
// the control server or spawning build steps.
const isEntrypoint = argv[1] && import.meta.url === pathToFileURL(argv[1]).href;
if (isEntrypoint) {
  main().catch((error) => {
    // Decision: Last-resort guard: main() already wraps its body, but don't let an unhandled rejection
    // leave the container hanging without an exit code.
    console.error(error);
    process.exit(1);
  });
}
