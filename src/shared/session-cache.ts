const CACHE_KEY_PREFIX = 'better-auth-workers:session:';

// Cloudflare KV rejects expirationTtl values below 60 seconds.
export const KV_MIN_TTL_SECONDS = 60;

// The consumer-side cache is keyed by the credential exactly as a request
// presents it: the signed cookie value (`<token>.<signature>`) or the bare
// bearer token. A cookie with a forged signature therefore never maps to an
// entry a genuine request warmed; it misses and is refused by the auth
// Worker, which is the only place the signature is checked.
export function sessionCacheKey(credential: string): string {
  return `${CACHE_KEY_PREFIX}${credential}`;
}

// Better Auth (through better-call) signs the session cookie as
// `<token>.<base64(HMAC-SHA256(secret, token))>`. The auth Worker rebuilds
// that value to find the cache entry a cookie-carrying request created.
//
// This mirrors better-call's `signCookieValue` (better-call 1.4.0, the
// version better-auth 1.7.5 pins; package.json pins the same version as a
// devDependency for the test below), which is not a documented format.
// test/shared/session-cache.test.ts compares this against better-call's own
// `serializeSignedCookie`, so a bump that changes the shape fails there
// rather than silently leaving revoked sessions in the consumer cache.
async function signedSessionValue(token: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token));
  return `${token}.${btoa(String.fromCodePoint(...new Uint8Array(signature)))}`;
}

// Every cache key a session token can be cached under: the bearer form and
// the signed-cookie form.
export async function sessionCacheKeysFor(token: string, secret: string): Promise<string[]> {
  return [sessionCacheKey(token), sessionCacheKey(await signedSessionValue(token, secret))];
}
