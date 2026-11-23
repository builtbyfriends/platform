const GITHUB_API_ORIGIN = 'https://api.github.com';

const REPO_PATH = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/|$)/;

/**
 * The GitHub API URL for a `/repos/owner/name/...` path a caller sent, with the repository it
 * names, or null for a path that isn't one or that could reach another host or path.
 */
export function githubRepoApiTarget(path: unknown): { url: string; repository: string } | null {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/repos/') ||
    path.includes('\\') ||
    path.includes('//') ||
    /[\s#]/.test(path)
  ) {
    return null;
  }
  // Decision: fetch resolves dot segments, encoded ones (%2e%2e) too, so a check on the raw text isn't
  // enough to keep a request inside its repository. Take only a path the URL parser leaves as it is.
  const url = new URL(path, GITHUB_API_ORIGIN);
  if (url.origin !== GITHUB_API_ORIGIN || `${url.pathname}${url.search}` !== path) {
    return null;
  }
  const match = REPO_PATH.exec(url.pathname);
  return match ? { url: url.href, repository: `${match[1]}/${match[2]}`.toLowerCase() } : null;
}
