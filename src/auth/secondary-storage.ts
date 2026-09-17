import type { AuthEnv, KVStore } from '../types';
import type { CreateAuthOptions, CreateAuthSecondaryStorage } from './types';

function resolveKv(options?: CreateAuthOptions, envObj?: Partial<AuthEnv>): KVStore | undefined {
  const kv = options?.kv ?? envObj?.AUTH_KV;
  if (!kv || typeof kv !== 'object') return;
  return kv;
}

function kvSecondaryStorage(kv: KVStore): CreateAuthSecondaryStorage {
  return {
    get: (key: string) => kv.get(key),
    set: (key: string, value: string, ttl?: number) =>
      kv.put(key, value, ttl ? { expirationTtl: ttl } : undefined),
    delete: (key: string) => kv.delete(key),
    increment: async (key: string, ttl: number): Promise<number> => {
      const current = await kv.get(key);
      const parsed = current ? Number(current) : 0;
      const next = (Number.isNaN(parsed) ? 0 : Math.trunc(parsed)) + 1;
      await kv.put(key, String(next), ttl ? { expirationTtl: ttl } : undefined);
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
