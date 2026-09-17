import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';

import { type AuthInstance, createAuth } from '../../src/index';
import { buildEnv, FakeKV, VALID_BASE_URL } from '../helpers/auth';

type SecondaryStorage = NonNullable<AuthInstance['options']['secondaryStorage']>;

function secondaryStorageOf(auth: AuthInstance): SecondaryStorage {
  const storage: SecondaryStorage | undefined = auth.options.secondaryStorage;
  if (!storage) throw new Error('secondaryStorage is not configured on this instance');
  return storage;
}

const okRequest = (clientIp: string) =>
  new Request(`${VALID_BASE_URL}/api/auth/ok`, { headers: { 'x-forwarded-for': clientIp } });

describe('KV secondary storage for session cache and rate limiter', () => {
  describe('Secondary storage wiring over KV namespace', () => {
    it('wires options.kv as Better Auth secondaryStorage with get, set with TTL, and delete', async () => {
      const mockKv = new FakeKV();
      const auth = createAuth(buildEnv(), { kv: mockKv });
      const storage = secondaryStorageOf(auth);

      await storage.set('test-key', 'test-value', 300);
      expect(mockKv.puts).toHaveLength(1);
      expect(mockKv.puts[0]?.key).toBe('test-key');
      expect(mockKv.puts[0]?.value).toBe('test-value');
      expect(mockKv.puts[0]?.options?.expirationTtl).toBe(300);

      const value = await storage.get('test-key');
      expect(value).toBe('test-value');

      await storage.delete('test-key');
      expect(mockKv.deletes).toContain('test-key');
      const deletedValue = await storage.get('test-key');
      expect(deletedValue).toBeNull();
    });

    it('wires env.AUTH_KV as secondaryStorage when options.kv is omitted', () => {
      const mockKv = new FakeKV();
      const auth = createAuth(buildEnv({ AUTH_KV: mockKv.asBinding() }));
      expect(auth.options.secondaryStorage).toBeDefined();
    });

    it('prefers options.kv over env.AUTH_KV', async () => {
      const optionsKv = new FakeKV();
      const envKv = new FakeKV();
      const auth = createAuth(buildEnv({ AUTH_KV: envKv.asBinding() }), { kv: optionsKv });

      await secondaryStorageOf(auth).set('k', 'v');

      expect(optionsKv.puts).toHaveLength(1);
      expect(envKv.puts).toHaveLength(0);
    });

    it('implements getAndDelete on secondaryStorage so one-shot verification values are consumed', async () => {
      const mockKv = new FakeKV();
      const auth = createAuth(buildEnv(), { kv: mockKv });
      const storage = secondaryStorageOf(auth);

      await storage.set('verification:otp', 'code', 300);
      const consumed = await storage.getAndDelete('verification:otp');
      expect(consumed).toBe('code');
      expect(mockKv.deletes).toContain('verification:otp');
      expect(await storage.get('verification:otp')).toBeNull();

      const missing = await storage.getAndDelete('verification:missing');
      expect(missing).toBeNull();
      expect(mockKv.deletes).not.toContain('verification:missing');
    });

    it('implements increment on secondaryStorage for distributed rate limiting', async () => {
      const mockKv = new FakeKV();
      const auth = createAuth(buildEnv(), { kv: mockKv });
      const storage = secondaryStorageOf(auth);

      expect(typeof storage.increment).toBe('function');

      const count1 = await storage.increment('test-limit-key', 60);
      expect(count1).toBe(1);

      const count2 = await storage.increment('test-limit-key', 60);
      expect(count2).toBe(2);
    });
  });

  describe('Rate-limit counters are fixed windows', () => {
    afterEach(() => {
      setSystemTime();
    });

    it('does not extend the window on later increments and resets once it has passed', async () => {
      const mockKv = new FakeKV();
      const storage = secondaryStorageOf(createAuth(buildEnv(), { kv: mockKv }));
      const start = new Date('2026-09-17T12:00:00Z');

      setSystemTime(start);
      expect(await storage.increment('rate:key', 100)).toBe(1);

      // Halfway through the window: the count grows, but the entry is
      // written with the remaining TTL, not a fresh full window.
      setSystemTime(new Date(start.getTime() + 50_000));
      expect(await storage.increment('rate:key', 100)).toBe(2);
      expect(mockKv.puts.map((put) => put.options?.expirationTtl)).toEqual([100, 60]);

      // Just past the window: a fresh window starts at 1, not 3.
      setSystemTime(new Date(start.getTime() + 101_000));
      expect(await storage.increment('rate:key', 100)).toBe(1);
      expect(mockKv.puts.at(-1)?.options?.expirationTtl).toBe(100);
    });

    it('lets a client that keeps retrying at the limit through once the window passes', async () => {
      const kv = new FakeKV();
      const auth = createAuth(buildEnv(), {
        kv,
        betterAuth: { rateLimit: { enabled: true, window: 100, max: 1 } },
      });
      const start = new Date('2026-09-17T12:00:00Z');

      const statusAt = async (seconds: number) => {
        setSystemTime(new Date(start.getTime() + seconds * 1000));
        const res = await auth.handler(okRequest('198.51.100.45'));
        return res.status;
      };

      expect(await statusAt(0)).toBe(200);
      expect(await statusAt(30)).toBe(429);
      expect(await statusAt(60)).toBe(429);
      expect(await statusAt(90)).toBe(429);
      expect(await statusAt(101)).toBe(200);
    });

    it('treats a counter left by an older release (a bare number) as a fresh window', async () => {
      const mockKv = new FakeKV();
      mockKv.store.set('rate:legacy', '7');
      const storage = secondaryStorageOf(createAuth(buildEnv(), { kv: mockKv }));

      expect(await storage.increment('rate:legacy', 60)).toBe(1);
    });
  });

  describe('KV minimum TTL', () => {
    // Better Auth's rate limiter calls increment(key, window) with windows
    // as short as 10 seconds; Cloudflare KV rejects expirationTtl < 60.
    it('raises a sub-60s TTL to the KV minimum on increment and set', async () => {
      const mockKv = new FakeKV();
      const storage = secondaryStorageOf(createAuth(buildEnv(), { kv: mockKv }));

      expect(await storage.increment('rate:key', 10)).toBe(1);
      await storage.set('short-lived', 'value', 5);

      expect(mockKv.puts.map((put) => put.options?.expirationTtl)).toEqual([60, 60]);
    });

    it('passes a TTL at or above the minimum through unchanged', async () => {
      const mockKv = new FakeKV();
      const storage = secondaryStorageOf(createAuth(buildEnv(), { kv: mockKv }));

      await storage.increment('rate:key', 60);
      await storage.set('long-lived', 'value', 300);

      expect(mockKv.puts.map((put) => put.options?.expirationTtl)).toEqual([60, 300]);
    });

    it('rate-limits with a 10-second window on a KV that enforces the minimum TTL', async () => {
      const kv = new FakeKV();
      const rateLimit = { enabled: true, window: 10, max: 1 };
      const auth = createAuth(buildEnv(), { kv, betterAuth: { rateLimit } });

      const first = await auth.handler(okRequest('198.51.100.44'));
      const second = await auth.handler(okRequest('198.51.100.44'));

      expect([first.status, second.status]).toEqual([200, 429]);
    });
  });

  describe('KV is required', () => {
    it('throws a clear error naming kv when neither options.kv nor env.AUTH_KV is set', () => {
      const env = buildEnv({ AUTH_KV: undefined as unknown as KVNamespace });
      expect(() => createAuth(env, {})).toThrow(/kv is required.*options\.kv.*env\.AUTH_KV/s);
    });

    it('reports the missing kv alongside the other missing bindings in one error', () => {
      const env = buildEnv({
        AUTH_KV: undefined as unknown as KVNamespace,
        DB: undefined,
      });
      expect(() => createAuth(env, {})).toThrow(/database is required[\s\S]*kv is required/);
    });

    it('still requires kv when a consumer-supplied secondaryStorage is set, since invalidation needs it', () => {
      const env = buildEnv({ AUTH_KV: undefined as unknown as KVNamespace });
      expect(() => createAuth(env, { secondaryStorage: new FakeKV() as never })).toThrow(
        /kv is required/
      );
    });

    it('uses a consumer-supplied secondaryStorage for Better Auth while kv keeps invalidation', () => {
      const storage = new FakeKV();
      const auth = createAuth(buildEnv(), { secondaryStorage: storage as never });
      expect(auth.options.secondaryStorage).toBe(storage as never);
      expect(auth.options.hooks?.after).toBeDefined();
    });
  });

  describe('Cookie caching by default', () => {
    it('enables cookie caching by default in Better Auth session options', () => {
      const auth = createAuth(buildEnv(), { kv: new FakeKV() });
      expect(auth.options.session?.cookieCache?.enabled).toBe(true);
    });

    it('allows cookie caching to be explicitly disabled or customized in options', () => {
      const auth = createAuth(buildEnv(), {
        kv: new FakeKV(),
        betterAuth: { session: { cookieCache: { enabled: false } } },
      });
      expect(auth.options.session?.cookieCache?.enabled).toBe(false);
    });
  });

  describe('Rate limiter configured with secondary storage across isolates', () => {
    it('configures the rate limiter to use secondary storage when KV is provided', () => {
      const auth = createAuth(buildEnv(), { kv: new FakeKV() });
      expect(auth.options.rateLimit?.storage).toBe('secondary-storage');
    });

    // Two envs stand in for two isolates. The counter lives in our KV
    // `increment` (Better Auth calls it to consume a request), so a second
    // instance on the same namespace continues the first one's count.
    it('shares rate-limit counters across two createAuth instances on one KV namespace', async () => {
      const sharedKv = new FakeKV();
      const clientIp = '198.51.100.42';
      const rateLimit = { enabled: true, window: 60, max: 2 };
      const request = () =>
        new Request(`${VALID_BASE_URL}/api/auth/ok`, { headers: { 'x-forwarded-for': clientIp } });

      const auth1 = createAuth(buildEnv(), { kv: sharedKv, betterAuth: { rateLimit } });
      const auth2 = createAuth(buildEnv(), { kv: sharedKv, betterAuth: { rateLimit } });
      expect(auth1).not.toBe(auth2);

      const first = await auth1.handler(request());
      const second = await auth1.handler(request());
      const third = await auth2.handler(request());

      expect([first.status, second.status, third.status]).toEqual([200, 200, 429]);
      const counts = sharedKv.store
        .values()
        .map((value) => (JSON.parse(value) as { count?: number }).count)
        .filter((count) => count === 3)
        .toArray();
      expect(counts).toHaveLength(1);
    });

    it('does not share counters between instances on different KV namespaces', async () => {
      const clientIp = '198.51.100.43';
      const rateLimit = { enabled: true, window: 60, max: 2 };
      const request = () =>
        new Request(`${VALID_BASE_URL}/api/auth/ok`, { headers: { 'x-forwarded-for': clientIp } });

      const auth1 = createAuth(buildEnv(), { kv: new FakeKV(), betterAuth: { rateLimit } });
      const auth2 = createAuth(buildEnv(), { kv: new FakeKV(), betterAuth: { rateLimit } });

      const first = await auth1.handler(request());
      const second = await auth1.handler(request());
      const third = await auth2.handler(request());

      expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    });
  });
});
