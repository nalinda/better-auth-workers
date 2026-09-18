import { mock } from 'bun:test';

import type { CreateAuthSecondaryStorage } from '../../src/auth/types';
import type { AuthEnv, KVStore, WaitUntilContext } from '../../src/index';

// Shared fixtures for the createAuth unit tests. Every test builds its env
// as a real `AuthEnv` and passes real `CreateAuthOptions`, so a breaking
// change to either public type turns the tests red instead of being hidden
// behind a per-file cast.

export const VALID_SECRET = 'test-secret-at-least-32-chars-long-1234567890';
export const VALID_BASE_URL = 'https://auth.example.com';

// A minimal double for the Cloudflare KV binding, recording every call so
// tests can assert on what was read, written and deleted. Like the real
// binding, it rejects an `expirationTtl` under 60 seconds.
export class FakeKV implements KVStore {
  readonly store = new Map<string, string>();
  readonly gets: string[] = [];
  readonly puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];
  readonly deletes: string[] = [];

  get(key: string): Promise<string | null> {
    this.gets.push(key);
    return Promise.resolve(this.store.get(key) ?? null);
  }

  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
      return Promise.reject(
        new Error(
          'KV PUT failed: 400 Invalid expiration_ttl of ' +
            String(options.expirationTtl) +
            '. Expiration TTL must be at least 60.'
        )
      );
    }
    this.store.set(key, value);
    this.puts.push({ key, value, options });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    this.deletes.push(key);
    return Promise.resolve();
  }

  // The binding type has more surface than the package uses; the cast is
  // confined to here.
  asBinding(): KVNamespace {
    return this as unknown as KVNamespace;
  }

  // Used where a test only needs *some* distinct object under
  // `betterAuth.secondaryStorage` (identity-keyed memoisation, "kv is still
  // required regardless of what's here"), not one that implements Better
  // Auth's actual get/set/delete storage contract; the cast is confined to
  // here.
  asSecondaryStorage(): CreateAuthSecondaryStorage {
    return this as unknown as CreateAuthSecondaryStorage;
  }
}

export interface MockD1 {
  prepare: ReturnType<typeof mock>;
  batch: ReturnType<typeof mock>;
  exec: ReturnType<typeof mock>;
  asBinding: () => D1Database;
}

// A D1 double that answers every statement with an empty result set.
export function createMockD1(): MockD1 {
  const d1 = {
    prepare: mock((_query: string) => ({
      bind: mock((..._params: unknown[]) => ({
        all: mock(() => Promise.resolve({ results: [], success: true, meta: { changes: 0 } })),
        first: mock(() => Promise.resolve(null)),
        run: mock(() => Promise.resolve({ success: true, meta: { changes: 0 } })),
      })),
    })),
    batch: mock((_statements: unknown[]) => Promise.resolve([])),
    exec: mock((_query: string) => Promise.resolve({ count: 0, duration: 0 })),
  };
  return { ...d1, asBinding: () => d1 as unknown as D1Database };
}

// A complete, valid env on the D1 path. Override any binding per test.
export function buildEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    AUTH_BASE_URL: VALID_BASE_URL,
    BETTER_AUTH_SECRET: VALID_SECRET,
    AUTH_KV: new FakeKV().asBinding(),
    DB: createMockD1().asBinding(),
    ...overrides,
  };
}

export interface MockExecutionContext {
  ctx: WaitUntilContext;
  // The same function as `ctx.waitUntil`, exposed for call assertions.
  waitUntil: ReturnType<typeof mock<(promise: Promise<unknown>) => void>>;
  promises: Promise<unknown>[];
}

export function createMockExecutionContext(): MockExecutionContext {
  const promises: Promise<unknown>[] = [];
  const waitUntil = mock((promise: Promise<unknown>) => {
    promises.push(promise);
  });
  return {
    ctx: { waitUntil, passThroughOnException: () => {} },
    waitUntil,
    promises,
  };
}

export function postJSON(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
