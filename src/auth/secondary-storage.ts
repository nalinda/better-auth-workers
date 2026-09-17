import { KV_MIN_TTL_SECONDS } from '../shared/session-cache';
import type { AuthEnv, KVStore } from '../types';
import { resolveKv } from './kv';
import type { CreateAuthOptions, CreateAuthSecondaryStorage } from './types';

// Cloudflare KV rejects `expirationTtl` below 60 seconds with a 400, and
// Better Auth passes shorter TTLs routinely: its rate limiter's default and
// sign-in windows are 10 seconds. A short TTL is raised to the minimum; the
// value then outlives its window in KV, which only ever makes a limit
// slightly stricter, never looser.
function kvExpiry(ttl?: number): { expirationTtl: number } | undefined {
  if (!ttl || ttl <= 0) return;
  return { expirationTtl: Math.max(Math.ceil(ttl), KV_MIN_TTL_SECONDS) };
}

function kvSecondaryStorage(kv: KVStore): CreateAuthSecondaryStorage {
  return {
    get: (key: string) => kv.get(key),
    set: (key: string, value: string, ttl?: number) => kv.put(key, value, kvExpiry(ttl)),
    delete: (key: string) => kv.delete(key),
    // Better Auth consumes one-shot verification values (phone OTP codes,
    // magic-link tokens) through `getAndDelete`. KV has no atomic
    // read-and-remove, so this is a read followed by a delete; the
    // consume-once guarantee for OTP still holds through the code's
    // attempt counter and expiry.
    getAndDelete: async (key: string): Promise<string | null> => {
      const value = await kv.get(key);
      if (value !== null) await kv.delete(key);
      return value;
    },
    increment: async (key: string, ttl: number): Promise<number> => {
      const current = await kv.get(key);
      const parsed = current ? Number(current) : 0;
      const next = (Number.isNaN(parsed) ? 0 : Math.trunc(parsed)) + 1;
      await kv.put(key, String(next), kvExpiry(ttl));
      return next;
    },
  };
}

export function buildSecondaryStorage(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): CreateAuthSecondaryStorage | undefined {
  if (options?.secondaryStorage) return options.secondaryStorage;
  const kv = resolveKv(options, envObj);
  if (!kv) return;
  return kvSecondaryStorage(kv);
}
