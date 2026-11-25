import { jwtVerify, SignJWT } from 'jose';
import type { JWTPayload } from 'jose';

export type JwtPayload = Readonly<{
  sub: string;
  login: string;
  aud: string;
  iat: number;
  exp: number;
  /**
   * Optional project scope. Present on `aud:'deploy'` tokens minted for
   * remote builds — pins the token to a single project so the deploy
   * endpoint can reject cross-project use. Absent on `aud:'api'` tokens.
   */
  project?: string;
  /**
   * Optional build binding. Present on `aud:'deploy'` tokens minted for a
   * specific remote build (CF Container or GitHub Actions) — ties the token
   * to that build's row so the deploy endpoint can reject a stale runner once
   * its build is no longer active (e.g. superseded/cancelled by a newer push
   * or run). Absent on full `aud:'api'` tokens and CI credential tokens. A
   * deploy token must carry either this or `credential`.
   */
  build?: string;
  /** Revocable project automation credential record. */
  credential?: string;
  /** Dedicated, revocable operator session; never accepted by application APIs. */
  jti?: string;
  operatorOrigin?: string;
  /** Revocable human session; never used for project-scoped build credentials. */
  sid?: string;
  /** Delegated application deployment, accepted only by the OAuth-aware runtime. */
  oauthApproval?: string;
  /** Private preview view, tied to a live connected-app grant. */
  oauthGrant?: string;
}>;

function isJwtPayload(payload: JWTPayload): payload is JWTPayload & JwtPayload {
  return (
    typeof payload.sub === 'string' &&
    typeof payload.login === 'string' &&
    typeof payload.aud === 'string' &&
    typeof payload.iat === 'number' &&
    typeof payload.exp === 'number'
  );
}

const EXPIRY_SECONDS = 30 * 24 * 60 * 60;

// Decision: Import each secret's HMAC key once per isolate; the secret doesn't change while it runs.
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    keyCache.set(secret, key);
  }
  return key;
}

export async function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  opts?: { ttlSeconds?: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // Decision: Header first, then the claims with iat and exp last: the same bytes the old signer made.
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + (opts?.ttlSeconds ?? EXPIRY_SECONDS))
    .sign(await hmacKey(secret));
}

/** The token's claims, or null when its signature, expiry or audience doesn't check out. */
export async function verifyJwt(
  token: string,
  secret: string,
  expectedAud?: string,
): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, await hmacKey(secret), {
      algorithms: ['HS256'],
      audience: expectedAud || undefined,
      requiredClaims: ['exp'],
    });
    return isJwtPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}
