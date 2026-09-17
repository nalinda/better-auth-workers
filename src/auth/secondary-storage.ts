import { BoundedMap } from '../shared/bounded-map';
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

// Cloudflare KV allows one write per second per key and rejects the rest,
// and Better Auth's rate limiter has no catch around `increment`, so a
// naive read-modify-write would turn two same-key requests within a second
// (parallel get-session calls on page load) into a failed auth request.
// Counters therefore live in an in-memory shadow per isolate: increments
// to one key are serialised, the shadow is written through to KV at most
// once a second, and a KV write that is refused anyway keeps the shadow
// and is retried on the next increment. KV still carries the count across
// isolates (best-effort, as the README says); the shadow is what keeps a
// burst from erroring.
const WRITE_INTERVAL_MS = 1000;
const MAX_SHADOWED_KEYS = 1000;

interface ShadowCounter extends RateLimitCounter {
  lastWriteAt: number;
}

function createCounters(kv: KVStore) {
  const shadow = new BoundedMap<string, ShadowCounter>(MAX_SHADOWED_KEYS);
  const chains = new Map<string, Promise<number>>();

  async function load(key: string, now: number): Promise<ShadowCounter | undefined> {
    const local = shadow.get(key);
    if (local && local.expiresAt > now) return local;
    const stored = parseCounter(await kv.get(key));
    return stored && stored.expiresAt > now ? { ...stored, lastWriteAt: 0 } : undefined;
  }

  async function writeThrough(key: string, entry: ShadowCounter, now: number): Promise<void> {
    if (now - entry.lastWriteAt < WRITE_INTERVAL_MS) return;
    try {
      await kv.put(key, JSON.stringify(entry), kvExpiry((entry.expiresAt - now) / 1000));
      entry.lastWriteAt = now;
    } catch {
      // Refused (rate-limited) or failed: the shadow keeps counting and
      // the next increment past the interval writes again.
    }
  }

  async function incrementOnce(key: string, ttl: number): Promise<number> {
    const now = Date.now();
    const entry = (await load(key, now)) ?? {
      count: 0,
      expiresAt: now + Math.max(ttl, 1) * 1000,
      lastWriteAt: 0,
    };
    entry.count += 1;
    shadow.set(key, entry);
    await writeThrough(key, entry, now);
    return entry.count;
  }

  return {
    increment(key: string, ttl: number): Promise<number> {
      // Serialise per key so concurrent increments in one isolate each count.
      const previous = chains.get(key) ?? Promise.resolve(0);
      const next = (async () => {
        try {
          await previous;
        } catch {
          // the previous increment's failure is its own caller's to see
        }
        return incrementOnce(key, ttl);
      })();
      chains.set(key, next);
      void next.finally(() => {
        if (chains.get(key) === next) chains.delete(key);
      });
      return next;
    },
  };
}

// One shadow per KV binding for the life of the isolate, so instances that
// are rebuilt per request (the Hyperdrive path) still coalesce writes.
const countersByKv = new WeakMap<KVStore, ReturnType<typeof createCounters>>();

function countersFor(kv: KVStore): ReturnType<typeof createCounters> {
  let counters = countersByKv.get(kv);
  if (!counters) {
    counters = createCounters(kv);
    countersByKv.set(kv, counters);
  }
  return counters;
}

function kvSecondaryStorage(kv: KVStore): CreateAuthSecondaryStorage {
  const counters = countersFor(kv);
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
    increment: (key: string, ttl: number): Promise<number> => counters.increment(key, ttl),
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

// Better Auth's secondary storage over the KV namespace. A consumer who
// wants a different store sets `betterAuth.secondaryStorage`, which the
// escape hatch layers over this; `kv` stays required either way, since the
// session-cache invalidation hook deletes from it.
export function buildSecondaryStorage(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): CreateAuthSecondaryStorage | undefined {
  const kv = resolveKv(options, envObj);
  if (!kv) return;
  return kvSecondaryStorage(kv);
}
