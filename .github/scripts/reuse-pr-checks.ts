import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type PullRequest = {
  number: number;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { sha: string };
};
type CheckRun = { name: string; status: string; conclusion: string | null };

const PASSING = new Set(['success', 'skipped', 'neutral']);

export function reuseDecision(input: {
  sha: string;
  tree: string;
  pullRequests: ReadonlyArray<PullRequest>;
  treeOf: (commit: string) => string;
  checkRunsOf: (commit: string) => ReadonlyArray<CheckRun>;
}): { reuse: boolean; why: string } {
  const merged = input.pullRequests.filter(
    (pr) => pr.merged_at !== null && pr.merge_commit_sha === input.sha,
  );
  if (merged.length !== 1) {
    return {
      reuse: false,
      why: 'No single merged pull request made this commit, so the full checks run.',
    };
  }
  const { number, head } = merged[0];
  if (input.treeOf(head.sha) !== input.tree) {
    return {
      reuse: false,
      why: `Pull request #${number} was checked at ${head.sha.slice(0, 7)}, and main holds different files, so the full checks run.`,
    };
  }
  const runs = input.checkRunsOf(head.sha);
  const notPassing = runs.filter(
    (run) => run.status !== 'completed' || !PASSING.has(run.conclusion ?? ''),
  );
  if (
    runs.length === 0 ||
    notPassing.length > 0 ||
    !runs.some((run) => run.name === 'done' && run.conclusion === 'success')
  ) {
    const names = notPassing.map((run) => run.name).join(', ') || 'no finished "done" check';
    return {
      reuse: false,
      why: `Pull request #${number} has checks that haven't passed (${names}), so the full checks run.`,
    };
  }
  return {
    reuse: true,
    why: `Pull request #${number} passed all ${runs.length} checks on files identical to this commit.`,
  };
}

function gh(path: string): unknown {
  return JSON.parse(
    execFileSync('gh', ['api', '--paginate', '--slurp', path], { encoding: 'utf8' }),
  );
}

function treeOf(commit: string): string {
  return execFileSync('git', ['rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }).trim();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { GITHUB_REPOSITORY: repo = '', GITHUB_SHA: sha = '' } = process.env;
  const pullRequests = (
    gh(`repos/${repo}/commits/${sha}/pulls`) as Array<Array<PullRequest>>
  ).flat();
  const merged = pullRequests.find((pr) => pr.merged_at !== null && pr.merge_commit_sha === sha);
  if (merged) {
    execFileSync('git', ['fetch', '--no-tags', 'origin', merged.head.sha], { stdio: 'inherit' });
  }
  const result = reuseDecision({
    sha,
    tree: treeOf(sha),
    pullRequests,
    treeOf,
    checkRunsOf: (commit) =>
      (
        gh(`repos/${repo}/commits/${commit}/check-runs?per_page=100`) as Array<{
          check_runs: Array<CheckRun>;
        }>
      ).flatMap((page) => page.check_runs),
  });
  console.log(result.why);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${result.reuse}\n`);
  }
}
