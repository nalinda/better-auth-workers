import { describe, expect, it } from 'bun:test';

import { createAuth } from '../../../src/index';
import { sessionCacheKey } from '../../../src/shared/session-cache';

// A minimal double for the Cloudflare KV binding, matching what
// `createSessionClient` writes to and reads from (see src/session/session-client.ts).
class FakeKV {
  readonly store = new Map<string, string>();
  readonly deletes: string[] = [];

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }

  put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    this.deletes.push(key);
    return Promise.resolve();
  }
}

// Better Auth invokes `options.hooks.after` with the same endpoint context the
// route handler received: `path`, `body`, `context.secret`, `context.authCookies`
// and `getSignedCookie` are all real fields on that context (see
// node_modules/better-auth/dist/api/routes/sign-out.mjs and
// node_modules/better-auth/dist/api/dispatch.mjs's runAfterHooks).
interface FakeEndpointContext {
  path: string;
  body?: { token?: string };
  context: {
    secret: string;
    authCookies: { sessionToken: { name: string } };
  };
  getSignedCookie: (name: string, secret: string) => Promise<string | undefined>;
}

const SECRET = 'test-secret-at-least-32-chars-long-1234567890';
const SESSION_COOKIE_NAME = 'better-auth.session_token';
const TOKEN = 'session-token-abc123';

function signOutContext(token: string | undefined): FakeEndpointContext {
  return {
    path: '/sign-out',
    context: { secret: SECRET, authCookies: { sessionToken: { name: SESSION_COOKIE_NAME } } },
    getSignedCookie: () => Promise.resolve(token),
  };
}

function revokeSessionContext(token: string | undefined): FakeEndpointContext {
  return {
    path: '/revoke-session',
    body: { token },
    context: { secret: SECRET, authCookies: { sessionToken: { name: SESSION_COOKIE_NAME } } },
    getSignedCookie: () => Promise.resolve(undefined),
  };
}

function getSessionContext(token: string | undefined): FakeEndpointContext {
  return {
    path: '/get-session',
    context: { secret: SECRET, authCookies: { sessionToken: { name: SESSION_COOKIE_NAME } } },
    getSignedCookie: () => Promise.resolve(token),
  };
}

function createMockD1() {
  return {
    prepare: () => ({
      bind: () => ({
        all: () => Promise.resolve({ results: [], success: true, meta: { changes: 0 } }),
        first: () => Promise.resolve(null),
        run: () => Promise.resolve({ success: true, meta: { changes: 0 } }),
      }),
    }),
    batch: () => Promise.resolve([]),
    exec: () => Promise.resolve({ count: 0, duration: 0 }),
  };
}

interface AuthInstanceLike {
  options: {
    hooks?: {
      after?: (ctx: FakeEndpointContext) => Promise<unknown>;
    };
  };
}

type LooseCreateAuth = (
  env: Record<string, unknown>,
  options?: Record<string, unknown>
) => AuthInstanceLike;

const callCreateAuth = createAuth as unknown as LooseCreateAuth;

function buildEnv(kv?: FakeKV) {
  const base = {
    AUTH_BASE_URL: 'https://auth.example.com',
    BETTER_AUTH_SECRET: SECRET,
    DB: createMockD1(),
  };
  return kv ? { ...base, AUTH_KV: kv } : base;
}

describe('createAuth wires session cache invalidation into the Better Auth instance', () => {
  describe('sign-out', () => {
    it('registers an after-hook on the instance when a KV namespace is configured', () => {
      const kv = new FakeKV();
      const auth = callCreateAuth(buildEnv(kv), { kv });
      expect(auth.options.hooks?.after).toBeDefined();
    });

    it('deletes the session-client cache entry for the signed-out session token', async () => {
      const kv = new FakeKV();
      const cacheKey = sessionCacheKey(TOKEN);
      await kv.put(cacheKey, JSON.stringify({ session: { token: TOKEN } }));
      const auth = callCreateAuth(buildEnv(kv), { kv });

      expect(auth.options.hooks?.after).toBeDefined();
      await auth.options.hooks!.after!(signOutContext(TOKEN));

      expect(kv.deletes).toContain(cacheKey);
      expect(await kv.get(cacheKey)).toBeNull();
    });

    it('does nothing when the sign-out request carries no session cookie', async () => {
      const kv = new FakeKV();
      const auth = callCreateAuth(buildEnv(kv), { kv });

      expect(auth.options.hooks?.after).toBeDefined();
      await auth.options.hooks!.after!(signOutContext(undefined));

      expect(kv.deletes).toHaveLength(0);
    });
  });

  describe('session revocation', () => {
    it('deletes the session-client cache entry for a revoked session token', async () => {
      const kv = new FakeKV();
      const cacheKey = sessionCacheKey(TOKEN);
      await kv.put(cacheKey, JSON.stringify({ session: { token: TOKEN } }));
      const auth = callCreateAuth(buildEnv(kv), { kv });

      expect(auth.options.hooks?.after).toBeDefined();
      await auth.options.hooks!.after!(revokeSessionContext(TOKEN));

      expect(kv.deletes).toContain(cacheKey);
      expect(await kv.get(cacheKey)).toBeNull();
    });
  });

  describe('requests that neither sign out nor revoke a session', () => {
    it('leaves an unrelated cached session entry in place', async () => {
      const kv = new FakeKV();
      const cacheKey = sessionCacheKey(TOKEN);
      await kv.put(cacheKey, JSON.stringify({ session: { token: TOKEN } }));
      const auth = callCreateAuth(buildEnv(kv), { kv });

      expect(auth.options.hooks?.after).toBeDefined();
      await auth.options.hooks!.after!(getSessionContext(TOKEN));

      expect(kv.deletes).toHaveLength(0);
      expect(await kv.get(cacheKey)).not.toBeNull();
    });
  });

  describe('no shared KV namespace configured', () => {
    it('does not wire cache invalidation when neither options.kv nor env.AUTH_KV is set', () => {
      const auth = callCreateAuth(buildEnv(), {});
      expect(auth.options.hooks?.after).toBeUndefined();
    });
  });
});
