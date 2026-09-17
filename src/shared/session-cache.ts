const CACHE_KEY_PREFIX = 'better-auth-workers:session:';

// Cloudflare KV rejects expirationTtl values below 60 seconds.
export const KV_MIN_TTL_SECONDS = 60;

export function sessionCacheKey(token: string): string {
  return `${CACHE_KEY_PREFIX}${token}`;
}
