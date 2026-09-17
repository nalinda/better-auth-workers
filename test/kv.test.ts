import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createAuth } from '../src/index';

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

function createMockD1(initialSession?: { token: string; userId: string; email: string }) {
  let queryCount = 0;
  return {
    getQueryCount: () => queryCount,
    resetQueryCount: () => {
      queryCount = 0;
    },
    prepare: mock((sql: string) => {
      queryCount++;
      return {
        bind: mock((..._params: unknown[]) => ({
          all: mock(() => {
            if (initialSession && sql.includes('session')) {
              return Promise.resolve({
                results: [
                  {
                    id: 's1',
                    token: initialSession.token,
                    userId: initialSession.userId,
                    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  },
                ],
                meta: { changes: 0 },
              });
            }
            if (initialSession && sql.includes('user')) {
              return Promise.resolve({
                results: [
                  {
                    id: initialSession.userId,
                    name: 'Alice',
                    email: initialSession.email,
                    emailVerified: 1,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  },
                ],
                meta: { changes: 0 },
              });
            }
            return Promise.resolve({ results: [], meta: { changes: 0 } });
          }),
          first: mock(() => Promise.resolve(null)),
          run: mock(() => Promise.resolve({ success: true, meta: { changes: 0 } })),
        })),
      };
    }),
    batch: mock((stmts: unknown[]) => {
      queryCount += Array.isArray(stmts) ? stmts.length : 1;
      return Promise.resolve([]);
    }),
    exec: mock((_sql: string) => {
      queryCount++;
      return Promise.resolve({ count: 0, duration: 0 });
    }),
  };
}

async function signCookieHeader(
  cookieName: string,
  value: string,
  secret: string
): Promise<string> {
  const secretBuf = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    secretBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  const signedValue = encodeURIComponent(`${value}.${b64}`);
  return `${cookieName}=${signedValue}`;
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

describe('Issue #5: KV secondary storage for session cache and rate limiter', () => {
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

  describe('Warm get-session primary store bypass', () => {
    it('serves a warm get-session without querying the primary database (query count is zero on the second call)', async () => {
      const token = 'test-session-token-warm';
      const d1 = createMockD1({
        token,
        userId: 'user-warm-1',
        email: 'warm@example.com',
      });
      const mockKv = new FakeKV();
      const auth = createAuthInstance(validEnv, {
        database: { d1 },
        kv: mockKv,
        betterAuth: {
          session: { storeSessionInDatabase: true },
        },
      });

      const ctx = await auth.$context;
      const cookieName = ctx.authCookies.sessionToken.name;
      const cookieHeader = await signCookieHeader(cookieName, token, validSecret);

      // First call: cold get-session (queries primary database)
      d1.resetQueryCount();
      const req1 = new Request('https://auth.example.com/api/auth/get-session', {
        headers: { cookie: cookieHeader },
      });
      const res1 = await auth.handler(req1);
      expect(res1.status).toBe(200);
      const call1QueryCount = d1.getQueryCount();
      expect(call1QueryCount).toBeGreaterThan(0);

      // Build cookies for second call (including any cookie cache established by call 1)
      const setCookies = res1.headers.getSetCookie();
      const call2Cookies = [cookieHeader, ...setCookies.map((c: string) => c.split(';')[0])].join(
        '; '
      );

      // Second call: warm get-session (must NOT query primary database)
      d1.resetQueryCount();
      const req2 = new Request('https://auth.example.com/api/auth/get-session', {
        headers: { cookie: call2Cookies },
      });
      const res2 = await auth.handler(req2);
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2?.user?.email).toBe('warm@example.com');
      expect(body2?.session?.token).toBe(token);

      // The acceptance criterion: assert the mock database query count is zero on the second call
      const call2QueryCount = d1.getQueryCount();
      expect(call2QueryCount).toBe(0);
    });
  });

  describe('Rate limiter configured with secondary storage across isolates', () => {
    it('configures the rate limiter to use secondary storage when KV is provided', () => {
      const mockKv = new FakeKV();
      const auth = createAuthInstance(validEnv, { kv: mockKv });
      expect(auth?.options?.rateLimit?.storage).toBe('secondary-storage');
    });

    it('shares rate-limit counters across two separate createAuth instances sharing one KV namespace', async () => {
      const sharedKv = new FakeKV();
      const clientIp = '198.51.100.42';

      // Two separate env objects representing separate Worker isolates
      const env1 = { ...validEnv, id: 'isolate-1' };
      const env2 = { ...validEnv, id: 'isolate-2' };

      const rateLimitConfig = {
        enabled: true,
        window: 60,
        max: 2,
        customRules: {
          '/test-rate-limit': { window: 60, max: 2 },
        },
      };

      const testPlugin = {
        id: 'rate-limit-test-plugin',
        endpoints: {
          testEndpoint: {
            path: '/test-rate-limit',
            method: 'GET',
            handler: () => new Response('allowed'),
          },
        },
      };

      const auth1 = createAuthInstance(env1, {
        kv: sharedKv,
        rateLimit: rateLimitConfig,
        plugins: [testPlugin],
      });

      const auth2 = createAuthInstance(env2, {
        kv: sharedKv,
        rateLimit: rateLimitConfig,
        plugins: [testPlugin],
      });

      // Confirm both are distinct instances
      expect(auth1).not.toBe(auth2);

      const makeRequest = () =>
        new Request('https://auth.example.com/api/auth/test-rate-limit', {
          headers: { 'cf-connecting-ip': clientIp },
        });

      // Request 1 on Instance 1: allowed (count = 1)
      let status1: number | undefined;
      try {
        const res1 = await auth1.handler(makeRequest());
        status1 = res1.status;
      } catch {
        status1 = undefined;
      }
      expect(status1).not.toBe(429);

      // Request 2 on Instance 1: allowed (count = 2, limit reached)
      let status2: number | undefined;
      try {
        const res2 = await auth1.handler(makeRequest());
        status2 = res2.status;
      } catch {
        status2 = undefined;
      }
      expect(status2).not.toBe(429);

      // Request 3 on Instance 2 (different isolate, shared KV): must see count = 3 > max and reject with 429
      let status3: number | undefined;
      try {
        const res3 = await auth2.handler(makeRequest());
        status3 = res3.status;
      } catch {
        status3 = undefined;
      }
      expect(status3).toBe(429);

      // Rate limit counters must be stored in the shared KV namespace
      expect(sharedKv.store.size).toBeGreaterThan(0);
    });
  });
});
