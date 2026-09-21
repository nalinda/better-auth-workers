const CACHE_KEY_PREFIX = 'better-auth-workers:session:';

// Cloudflare KV rejects expirationTtl values below 60 seconds.
export const KV_MIN_TTL_SECONDS = 60;

// The consumer-side cache is keyed by the bare session token, which is the
// one thing every revocation point on the auth Worker has in hand (a
// sign-out's cookie, a revoke body, a listed session). What makes the key
// safe is the entry, not the key: it records the exact credentials the
// auth Worker verified (the signed `<token>.<signature>` value, sent as a
// cookie or as a bearer credential), and a request presenting anything
// else — a cookie with a forged signature, say — is treated as a miss and
// sent to the auth Worker, which is the only place a signature is checked.
// Nothing here has to reproduce Better Auth's cookie signing.
export function sessionCacheKey(token: string): string {
  return `${CACHE_KEY_PREFIX}${token}`;
}

// Better Auth signs cookies as `<token>.<signature>`, and a bearer
// credential is held to that same signed form. The bare token is the part
// before the first dot — a cache key, never a credential in its own right.
export function sessionTokenOf(credential: string): string {
  const [token] = credential.split('.', 1);
  return token;
}

// How many distinct credential forms one entry keeps (cookie and bearer of
// the same session, at most); older ones fall off.
export const MAX_CACHED_CREDENTIALS = 4;
