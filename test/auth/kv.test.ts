import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createAuth } from '../../src/index';

class FakeKV {
  readonly store = new Map<string, string>();
  readonly gets: string[] = [];
  readonly puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];
  readonly deletes: string[] = [];

  get(key: string): Promise<string | null> {
    this.gets.push(key);
    return Promise.resolve(this.store.get(key) ?? null);
  }

  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
    this.puts.push({ key, value, options });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    this.deletes.push(key);
    return Promise.resolve();
  }
}

function createMockD1() {
  return {
    prepare: mock(() => ({
      bind: mock(() => ({
        all: mock(() => Promise.resolve({ results: [], meta: { changes: 0 } })),
        first: mock(() => Promise.resolve(null)),
        run: mock(() => Promise.resolve({ success: true, meta: { changes: 0 } })),
      })),
    })),
    batch: mock(() => Promise.resolve([])),
    exec: mock(() => Promise.resolve({ count: 0, duration: 0 })),
  };
}

interface CreateAuthOptions {
  basePath?: string;
  baseURL?: string;
  secret?: string;
  database?: { hyperdrive?: unknown; d1?: unknown } | unknown;
  kv?: unknown;
  rateLimit?: {
    enabled?: boolean;
    window?: number;
    max?: number;
    storage?: 'memory' | 'database' | 'secondary-storage';
    customRules?: Record<string, unknown>;
  };
  session?: {
    cookieCache?: {
      enabled?: boolean;
      maxAge?: number;
    };
    storeSessionInDatabase?: boolean;
  };
  plugins?: Array<{ id: string; [key: string]: unknown }>;
  betterAuth?: Record<string, unknown>;
  [key: string]: unknown;
}

const createAuthInstance = (env: Record<string, unknown>, options?: CreateAuthOptions): any =>
  (createAuth as unknown as (e: Record<string, unknown>, o?: CreateAuthOptions) => any)(
    env,
    options
  );

describe('KV secondary storage for session cache and rate limiter', () => {
  const validSecret = 'test-secret-at-least-32-chars-long-1234567890';
  const validBaseUrl = 'https://auth.example.com';
  let mockD1: ReturnType<typeof createMockD1>;
  let validEnv: Record<string, unknown>;

  beforeEach(() => {
    mockD1 = createMockD1();
    validEnv = {
      AUTH_BASE_URL: validBaseUrl,
      BETTER_AUTH_SECRET: validSecret,
      DB: mockD1,
    };
  });

  describe('Secondary storage wiring over KV namespace', () => {
    it('wires options.kv as Better Auth secondaryStorage with get, set with TTL, and delete', async () => {
      const mockKv = new FakeKV();
      const auth = createAuthInstance(validEnv, { kv: mockKv });

      expect(auth?.options?.secondaryStorage).toBeDefined();

      // Test set with TTL
      await auth?.options?.secondaryStorage?.set('test-key', 'test-value', 300);
      expect(mockKv.puts.length).toBe(1);
      expect(mockKv.puts[0]?.key).toBe('test-key');
      expect(mockKv.puts[0]?.value).toBe('test-value');
      expect(mockKv.puts[0]?.options?.expirationTtl).toBe(300);

      // Test get
      const value = await auth?.options?.secondaryStorage?.get('test-key');
      expect(value).toBe('test-value');

      // Test delete
      await auth?.options?.secondaryStorage?.delete('test-key');
      expect(mockKv.deletes).toContain('test-key');
      const deletedValue = await auth?.options?.secondaryStorage?.get('test-key');
      expect(deletedValue).toBeNull();
    });

    it('wires env.AUTH_KV as secondaryStorage when options.kv is omitted', () => {
      const mockKv = new FakeKV();
      const envWithKv = { ...validEnv, AUTH_KV: mockKv };
      const auth = createAuthInstance(envWithKv);
      expect(auth?.options?.secondaryStorage).toBeDefined();
    });

    it('supports options first argument order: createAuth({ kv }, env)', () => {
      const mockKv = new FakeKV();
      const auth = (createAuth as any)({ kv: mockKv }, validEnv);
      expect(auth?.options?.secondaryStorage).toBeDefined();
    });

    it('implements increment on secondaryStorage for distributed rate limiting', async () => {
      const mockKv = new FakeKV();
      const auth = createAuthInstance(validEnv, { kv: mockKv });

      expect(typeof auth?.options?.secondaryStorage?.increment).toBe('function');

      const count1 = await auth?.options?.secondaryStorage?.increment('test-limit-key', 60);
      expect(count1).toBe(1);

      const count2 = await auth?.options?.secondaryStorage?.increment('test-limit-key', 60);
      expect(count2).toBe(2);
    });
  });

  describe('Cookie caching by default', () => {
    it('enables cookie caching by default in Better Auth session options', () => {
      const mockKv = new FakeKV();
      const auth = createAuthInstance(validEnv, { kv: mockKv });
      expect(auth?.options?.session?.cookieCache?.enabled).toBe(true);
    });

    it('allows cookie caching to be explicitly disabled or customized in options', () => {
      const mockKv = new FakeKV();
      const auth = createAuthInstance(validEnv, {
        kv: mockKv,
        betterAuth: { session: { cookieCache: { enabled: false } } },
      });
      expect(auth?.options?.session?.cookieCache?.enabled).toBe(false);
    });
  });

  describe('Rate limiter configured with secondary storage across isolates', () => {
    it('configures the rate limiter to use secondary storage when KV is provided', () => {
      const mockKv = new FakeKV();
      const auth = createAuthInstance(validEnv, { kv: mockKv });
      expect(auth?.options?.rateLimit?.storage).toBe('secondary-storage');
    });
  });
});
