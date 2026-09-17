import { describe, expect, it } from 'bun:test';

import { type AuthInstance, createAuth } from '../../src/index';
import { buildEnv, FakeKV, VALID_BASE_URL } from '../helpers/auth';

type SecondaryStorage = NonNullable<AuthInstance['options']['secondaryStorage']>;

function secondaryStorageOf(auth: AuthInstance): SecondaryStorage {
  const storage: SecondaryStorage | undefined = auth.options.secondaryStorage;
  if (!storage) throw new Error('secondaryStorage is not configured on this instance');
  return storage;
}

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

    it('accepts a consumer-supplied secondaryStorage in place of kv', () => {
      const env = buildEnv({ AUTH_KV: undefined as unknown as KVNamespace });
      expect(() => createAuth(env, { secondaryStorage: new FakeKV() as never })).not.toThrow();
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

      const auth1 = createAuth(buildEnv(), { kv: sharedKv, rateLimit });
      const auth2 = createAuth(buildEnv(), { kv: sharedKv, rateLimit });
      expect(auth1).not.toBe(auth2);

      const first = await auth1.handler(request());
      const second = await auth1.handler(request());
      const third = await auth2.handler(request());

      expect([first.status, second.status, third.status]).toEqual([200, 200, 429]);
      const counters = sharedKv.store
        .values()
        .filter((value) => value === '3')
        .toArray();
      expect(counters).toHaveLength(1);
    });

    it('does not share counters between instances on different KV namespaces', async () => {
      const clientIp = '198.51.100.43';
      const rateLimit = { enabled: true, window: 60, max: 2 };
      const request = () =>
        new Request(`${VALID_BASE_URL}/api/auth/ok`, { headers: { 'x-forwarded-for': clientIp } });

      const auth1 = createAuth(buildEnv(), { kv: new FakeKV(), rateLimit });
      const auth2 = createAuth(buildEnv(), { kv: new FakeKV(), rateLimit });

      const first = await auth1.handler(request());
      const second = await auth1.handler(request());
      const third = await auth2.handler(request());

      expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    });
  });
});
