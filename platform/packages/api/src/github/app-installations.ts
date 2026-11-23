import { hmacSignState, hmacVerifyState } from '../auth/hmac.ts';
import type { GitHubInstallationOwner } from '../db/credentials.ts';
import type { ApiEnv } from '../env.ts';
import { createAppJwt } from './app-jwt.ts';
import { GITHUB_API_BASE, GITHUB_API_VERSION } from './installation-token.ts';

/**
 * The state an app's install link carries through GitHub and back to
 * `/github-app/callback`. It's signed with `JWT_SECRET`, and `purpose` keeps it
 * apart from the other GitHub flows that sign states with the same secret.
 */
export type AppInstallState = Readonly<{
  purpose: 'github-app';
  scope: string;
  returnUrl: string;
  nonce: string;
  exp: number;
}> &
  GitHubInstallationOwner;

/** The state's owner, and nothing else from it. */
export function stateOwner(state: AppInstallState): GitHubInstallationOwner {
  return state.projectId !== undefined
    ? { projectId: state.projectId }
    : { clientId: state.clientId };
}

export function sameOwner(a: GitHubInstallationOwner, b: GitHubInstallationOwner): boolean {
  return a.projectId === b.projectId && a.clientId === b.clientId;
}

export const APP_INSTALL_STATE_TTL_MS = 30 * 60 * 1000;

export const SCOPE_PATTERN = /^[A-Za-z0-9_:.-]{1,128}$/;

export function isReturnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    // Decision: The state that carries this URL is base64 of its JSON, and btoa takes Latin-1 only.
    if (url.username || url.password || value.length > 1000 || !/^[\x21-\x7e]+$/.test(value)) {
      return false;
    }
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
    );
  } catch {
    return false;
  }
}

export async function signAppInstallState(state: AppInstallState, secret: string): Promise<string> {
  const encoded = btoa(JSON.stringify(state));
  return `${encoded}.${await hmacSignState(encoded, secret)}`;
}

/** The state when it's ours, signed, and not expired. Null for anything else. */
export async function verifyAppInstallState(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<AppInstallState | null> {
  const dot = token.lastIndexOf('.');
  if (dot === -1) {
    return null;
  }
  const encoded = token.slice(0, dot);
  if (!(await hmacVerifyState(encoded, token.slice(dot + 1), secret))) {
    return null;
  }
  try {
    const state = JSON.parse(atob(encoded)) as Partial<AppInstallState>;
    if (
      state.purpose !== 'github-app' ||
      (typeof state.projectId === 'string') === (typeof state.clientId === 'string') ||
      typeof state.scope !== 'string' ||
      typeof state.returnUrl !== 'string' ||
      typeof state.nonce !== 'string' ||
      typeof state.exp !== 'number' ||
      state.exp < now
    ) {
      return null;
    }
    return state as AppInstallState;
  } catch {
    return null;
  }
}

/** True when the token parses as a state from this flow, before checking its signature or age. */
export function looksLikeAppInstallState(token: string): boolean {
  const dot = token.lastIndexOf('.');
  if (dot === -1) {
    return false;
  }
  try {
    return (
      (JSON.parse(atob(token.slice(0, dot))) as { purpose?: unknown }).purpose === 'github-app'
    );
  } catch {
    return false;
  }
}

export type InstallationDetails = Readonly<{
  installationId: string;
  accountId: string;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  repositorySelection: 'all' | 'selected';
  permissions: Record<string, string>;
}>;

type InstallationResponse = Readonly<{
  id?: number;
  account?: Readonly<{ id?: number | string; login?: string; type?: string }>;
  repository_selection?: string;
  permissions?: Record<string, unknown>;
}>;

/** The installation as the App sees it (`GET /app/installations/:id`), or null when GitHub says no. */
export async function getInstallationDetails(
  env: ApiEnv['Bindings'],
  installationId: string,
): Promise<InstallationDetails | null> {
  const res = await fetch(
    `${GITHUB_API_BASE}/app/installations/${encodeURIComponent(installationId)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${await createAppJwt(env)}`,
        'User-Agent': 'platform-api',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
    },
  );
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as InstallationResponse;
  const account = data.account;
  if (!account || account.id === undefined || typeof account.login !== 'string') {
    return null;
  }
  return {
    installationId,
    accountId: String(account.id),
    accountLogin: account.login,
    accountType: account.type === 'Organization' ? 'Organization' : 'User',
    repositorySelection: data.repository_selection === 'all' ? 'all' : 'selected',
    permissions: Object.fromEntries(
      Object.entries(data.permissions ?? {}).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value]] : [],
      ),
    ),
  };
}

export type InstallationRepository = Readonly<{
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
}>;

/** One page (30) of the repositories an installation token reaches. */
export async function listInstallationRepositoryPage(
  token: string,
  page: number,
): Promise<ReadonlyArray<InstallationRepository>> {
  const res = await fetch(`${GITHUB_API_BASE}/installation/repositories?per_page=30&page=${page}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'platform-api',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to list installation repositories: ${res.status}`);
  }
  const data = (await res.json()) as {
    repositories?: ReadonlyArray<{
      id: number;
      full_name: string;
      private?: boolean;
      default_branch?: string;
    }>;
  };
  return (data.repositories ?? []).map((repo) => ({
    id: repo.id,
    full_name: repo.full_name,
    private: repo.private ?? true,
    default_branch: repo.default_branch ?? 'main',
  }));
}
