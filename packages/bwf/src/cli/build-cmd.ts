import { appendFileSync, writeFileSync } from 'node:fs';
import { log, outro } from '@voidzero-dev/vite-plus-prompts';
import { getToken } from './auth.ts';
import type { BuildArgs } from './build-args.ts';
import { PlatformApiError, PlatformClient } from './client.ts';
import type { BuildLogsResponse } from './client.ts';
import { dim, pc, printSuccess } from './output.ts';
import { readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, resolveProjectBySlug } from './resolve-project.ts';

const POLL_MS = 1000;
const BUILD_LOG_DRAIN_TIMEOUT_MS = 2 * 60_000;

function isBuildLogComplete(page: BuildLogsResponse): boolean {
  if (!page.terminal) {
    return false;
  }
  // Decision: `null` means the server can't prove completion.
  if (page.logsComplete === null) {
    throw new Error(
      'This platform cannot confirm that the final build logs were captured. Ask its administrator to upgrade the platform runtime, or read the retained logs without --follow.',
    );
  }
  return page.logsComplete === true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Classifies a `getBuildLogs` failure during a follow/first-page fetch as fatal
 * (surface + exit) vs transient (retry). A client error (4xx) is permanent —
 * the build is gone, access was revoked, or the CLI is too old (426
 * `cli_outdated`) — so retrying can't fix it; it is fatal, matching how the rest
 * of the CLI surfaces 426 (see `deploy-errors.ts`, `github-cmd.ts`). The sole
 * exception is 429 (rate limit), which IS transient. Everything else
 * (5xx/timeout/DO-read blip) is transient and retried through.
 */
export function isFatalFollowError(err: unknown): boolean {
  return (
    err instanceof PlatformApiError && err.status >= 400 && err.status < 500 && err.status !== 429
  );
}

/**
 * Pure follow-loop: repeatedly fetch pages since a cursor, write each new
 * line, and stop when the terminal build confirms its final logs were captured. `fetchPage`,
 * `write`, and `sleep` are injected so this is unit-testable. Returns the
 * final status + terminal flag.
 *
 * A transient `fetchPage` failure (502/timeout/DO-read blip) must NOT kill the
 * live tail: on catch we consult the injected `isFatal` — a fatal error
 * (e.g. 401/403/404) rethrows, otherwise we call `onRetry` and retry from the
 * SAME cursor on the next tick (no cursor advance, no write), so the tail
 * survives blips instead of exiting the CLI.
 */
export async function followBuildLogs(opts: {
  fetchPage: (since: number) => Promise<BuildLogsResponse>;
  write: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  since: number;
  status: string;
  pollMs?: number;
  isFatal?: (err: unknown) => boolean;
  onRetry?: (err: unknown) => void;
}): Promise<{ status: string; terminal: boolean }> {
  let cursor = opts.since;
  let status: string;
  let terminalSince: number | null = null;
  const pollMs = opts.pollMs ?? POLL_MS;
  for (;;) {
    await opts.sleep(pollMs);
    let pageResult: BuildLogsResponse;
    try {
      pageResult = await opts.fetchPage(cursor);
    } catch (error) {
      if (opts.isFatal?.(error)) {
        throw error;
      }
      opts.onRetry?.(error);
      continue;
    }
    for (const l of pageResult.lines) {
      opts.write(l.line);
    }
    cursor = pageResult.lastSeq;
    status = pageResult.status;
    if (isBuildLogComplete(pageResult)) {
      return { status, terminal: true };
    }
    if (pageResult.terminal) {
      const now = Date.now();
      terminalSince ??= now;
      if (now - terminalSince >= BUILD_LOG_DRAIN_TIMEOUT_MS) {
        throw new Error(
          'Build finished, but its log producer did not confirm completion. Retry the command to recover the final log tail.',
        );
      }
    } else {
      terminalSince = null;
    }
  }
}

export async function runBuildCommand(root: string, args: BuildArgs): Promise<void> {
  if (args.subcommand === 'logs') {
    return runBuildLogsCommand(root, args);
  }
}

function onBuildLogsRetry(err: unknown): void {
  log.warn(
    `build: transient error while following (${err instanceof Error ? err.message : String(err)}); retrying…`,
  );
}

async function runBuildLogsCommand(
  root: string,
  args: Extract<BuildArgs, { subcommand: 'logs' }>,
): Promise<void> {
  console.log();

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `bwf account login` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });

  let projectId: string;
  const requestedSlug = getRequestedProjectSlug({ projectSlug: args.projectName });
  if (requestedSlug) {
    const projects = await client.listProjects();
    const resolved = resolveProjectBySlug(projects, requestedSlug);
    if (!resolved) {
      log.error(`build: No project found with slug '${requestedSlug}'.`);
      process.exit(1);
    }
    projectId = resolved.projectId;
  } else {
    const linked = readProjectConfig(root);
    if (!linked) {
      log.error(
        'build: No project specified. Pass a project with --project <slug>, set BWF_PROJECT, or link one with `bwf project link`.',
      );
      process.exit(1);
    }
    projectId = linked.projectId;
  }

  let buildId = args.buildId;
  if (!buildId) {
    const builds = await client.listBuilds(projectId, 1);
    if (builds.length === 0) {
      outro('No builds found. Push to your connected branch to trigger one.');
      return;
    }
    buildId = builds[0].id;
  }

  const write = args.output
    ? (line: string): void => appendFileSync(args.output!, `${line}\n`)
    : (line: string): void => console.log(line);

  // Decision: A transient failure on the first poll mustn't kill `--follow` either. On a fatal error we exit
  // with a friendly message. On a non-fatal error we exit at once only for the one-shot command;
  // under --follow we call onRetry, sleep and request since=0 again.
  let first: BuildLogsResponse;
  for (;;) {
    try {
      first = await client.getBuildLogs(projectId, buildId, 0);
      break;
    } catch (error) {
      if (isFatalFollowError(error)) {
        if (error instanceof PlatformApiError && error.status === 404) {
          log.error(`build: Build '${buildId}' not found for this project.`);
        } else {
          log.error(error instanceof Error ? error.message : String(error));
        }
        process.exit(1);
      }
      if (!args.follow) {
        log.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      onBuildLogsRetry(error);
      await sleep(POLL_MS);
    }
  }

  // Decision: github_actions builds keep their logs on GitHub.
  if (first.external) {
    log.message(`This build ran on GitHub Actions. View logs:\n${pc.blue(first.external)}`);
    return;
  }

  // Decision: Truncate or create the output file once before the first line. The `write` writer appends, so
  // follow mode works, but the first dump mustn't add onto a stale file from a previous run. It's
  // after the external early return so an external build doesn't create an empty file.
  if (args.output) {
    writeFileSync(args.output, '');
  }

  for (const l of first.lines) {
    write(l.line);
  }

  let status = first.status;
  let terminal = first.terminal;

  if (args.follow && !isBuildLogComplete(first)) {
    ({ status, terminal } = await followBuildLogs({
      fetchPage: (since) => client.getBuildLogs(projectId, buildId, since),
      write,
      sleep,
      since: first.lastSeq,
      status,
      isFatal: isFatalFollowError,
      onRetry: onBuildLogsRetry,
    }));
  }

  if (!terminal) {
    outro(dim('Build still running — pass -f to follow.'));
    return;
  }

  if (status === 'complete') {
    printSuccess('Build succeeded.');
  } else {
    outro(dim(`Build ${status}.`));
  }
}
