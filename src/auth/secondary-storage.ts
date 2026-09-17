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
    // Better Auth's rate limiter expects a fixed window: the TTL applies
    // when the counter is created and later increments must not extend it,
    // or a client that keeps retrying at the limit would never leave 429.
    // KV cannot increment while preserving a TTL, so the window's end is
    // stored with the count and re-applied as the remaining TTL on every
    // write; a counter whose window has passed starts over at 1.
    increment: async (key: string, ttl: number): Promise<number> => {
      const now = Date.now();
      const current = parseCounter(await kv.get(key));
      const entry: RateLimitCounter =
        current && current.expiresAt > now
          ? { count: current.count + 1, expiresAt: current.expiresAt }
          : { count: 1, expiresAt: now + Math.max(ttl, 1) * 1000 };
      await kv.put(key, JSON.stringify(entry), kvExpiry((entry.expiresAt - now) / 1000));
      return entry.count;
    },
  };
}

interface RateLimitCounter {
  count: number;
  expiresAt: number;
}

function parseCounter(raw: string | null): RateLimitCounter | undefined {
  if (!raw) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as RateLimitCounter).count === 'number' &&
      typeof (parsed as RateLimitCounter).expiresAt === 'number'
    ) {
      return parsed as RateLimitCounter;
    }
  } catch {
    // an unrecognised value (e.g. a bare number from an older release) starts a fresh window
  }
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
