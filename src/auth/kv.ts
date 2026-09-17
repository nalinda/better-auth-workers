import type { AuthEnv, KVStore } from '../types';
import type { CreateAuthOptions } from './types';

// The KV namespace backs three things at once: Better Auth's secondary
// storage, the rate limiter's counters and the session-client cache that
// sign-out/revocation invalidates. Every one of them resolves the namespace
// through here so they can never disagree about which binding is in use.
export function resolveKv(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): KVStore | undefined {
  const kv = options?.kv ?? envObj?.AUTH_KV;
  if (!kv || typeof kv !== 'object') return;
  return kv;
}

const KV_MISSING_MESSAGE = 'kv is required: specify options.kv or env.AUTH_KV';

// A missing namespace would otherwise degrade silently: sessions fall back
// to the primary store, rate limits become per-isolate, and sign-out stops
// clearing the consumer-side cache. A `betterAuth.secondaryStorage` of the
// consumer's own can stand in for the first two but not the third — the
// invalidation hook deletes from the KV namespace the consumer Workers
// share — so it does not satisfy this check.
export function kvProblem(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): string | undefined {
  return resolveKv(options, envObj) ? undefined : KV_MISSING_MESSAGE;
}
