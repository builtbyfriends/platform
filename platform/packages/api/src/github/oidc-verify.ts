import { createRemoteJWKSet, jwtVerify } from 'jose';

const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const OIDC_JWKS_URL = `${OIDC_ISSUER}/.well-known/jwks`;

/**
 * Claims carried by a GitHub Actions OIDC token. GitHub mints these per
 * workflow run; we trust `repository`/`ref`/`sha`/`run_id` only after the
 * signature and issuer are verified against GitHub's JWKS.
 */
export type GithubOidcClaims = Readonly<{
  repository: string;
  repository_owner: string;
  // Decision: The owning account's immutable numeric id (as a string), on each Actions OIDC token. The exchange
  // binds it to the installation's `account_id` so a repo transferred to a new owner (same
  // `repository_id`) can't mint a deploy token for the old owner's project.
  repository_owner_id: string;
  // Decision: The repository's immutable numeric id (as a string). The exchange keys connection lookup on it so
  // a repo rename or name reuse can't redirect a deploy to the wrong project.
  repository_id: string;
  ref: string;
  sha: string;
  run_id: string;
  // Decision: The run's attempt number (as a string), incremented on each rerun of the same `run_id`. The
  // exchange persists it so the `workflow_run` completion handler can match a redelivered completion
  // to the right attempt's build.
  run_attempt: string;
  workflow: string;
  // Decision: `workflow_ref` names the entry workflow file for the run (`OWNER/REPO/.github/workflows/FILE@REF`).
  // `job_workflow_ref` names the file that defines the running job (it differs only for a reusable
  // workflow). The exchange binds the deploy token to the scaffolded `bwf-deploy.yml` through these,
  // so another workflow in the repo can't act as a deploy oracle.
  workflow_ref: string;
  job_workflow_ref: string;
  // Decision: The workflow trigger event (`push`, `workflow_dispatch`, `pull_request`, ...). The exchange
  // allowlists trusted, write-access-gated events so a PR-family trigger can't mint a deploy token.
  event_name: string;
  sub: string;
  [k: string]: unknown;
}>;

// Decision: Created lazily and cached per module so the remote JWKS is fetched at most once per isolate (jose
// also caches and rotates internally with a cooldown).
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(OIDC_JWKS_URL));
  }
  return jwks;
}

/**
 * Verify a GitHub Actions OIDC JWT against GitHub's remote JWKS and issuer.
 * Optionally enforces an expected `audience`. Returns the claims on success,
 * or null on any verification failure (bad signature, wrong issuer/audience,
 * expired, malformed).
 */
export async function verifyGithubOidcToken(
  token: string,
  opts?: { audience?: string | Array<string> },
): Promise<GithubOidcClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: OIDC_ISSUER,
      ...(opts?.audience ? { audience: opts.audience } : {}),
    });
    return payload as GithubOidcClaims;
  } catch {
    return null;
  }
}
