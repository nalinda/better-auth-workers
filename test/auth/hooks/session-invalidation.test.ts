import { APIError } from 'better-auth';
import { describe, expect, it } from 'bun:test';

import { type AuthInstance, createAuth } from '../../../src/index';
import { sessionCacheKey } from '../../../src/shared/session-cache';
import { buildEnv, FakeKV, VALID_SECRET } from '../../helpers/auth';

// Better Auth invokes `options.hooks.before` / `options.hooks.after` with the
// endpoint context the route handler receives: `path`, `body`,
// `context.secret`, `context.authCookies`, `context.internalAdapter` and
// `getSignedCookie` are all real fields on that context (see
// node_modules/better-auth/dist/api/dispatch.mjs). One `context` object is
// shared by both hooks of a dispatch.
interface SessionRecord {
  token: string;
}

interface FakeEndpointContext {
  path: string;
  body?: {
    token?: string;
    sessionToken?: string;
    userId?: string;
    data?: { banned?: boolean; name?: string };
  };
  headers?: Headers;
  context: {
    secret: string;
    authCookies: { sessionToken: { name: string } };
    internalAdapter: {
      findSession: (
        token: string
      ) => Promise<{ session: SessionRecord; user: { id: string } } | null>;
      listSessions: (userId: string) => Promise<SessionRecord[]>;
    };
    returned?: unknown;
  };
  getSignedCookie: (name: string, secret: string) => Promise<string | undefined>;
}

const SESSION_COOKIE_NAME = 'better-auth.session_token';
const TOKEN = 'session-token-abc123';
const USER_ID = 'user-1';
const USER_TOKENS = ['session-token-abc123', 'session-token-def456', 'session-token-ghi789'];
const ADMIN_TOKEN = 'admin-session-token';
const UNAUTHORIZED = new APIError('UNAUTHORIZED', { message: 'Unauthorized' });

interface FakeStore {
  sessions: Map<string, { token: string; userId: string }>;
  listCalls: string[];
}

function fakeStore(): FakeStore {
  const sessions = new Map<string, { token: string; userId: string }>();
  for (const token of USER_TOKENS) sessions.set(token, { token, userId: USER_ID });
  sessions.set(ADMIN_TOKEN, { token: ADMIN_TOKEN, userId: 'admin-1' });
  return { sessions, listCalls: [] };
}

function endpointContext(
  store: FakeStore,
  path: string,
  options: {
    cookieToken?: string;
    bearer?: string;
    body?: NonNullable<FakeEndpointContext['body']>;
  } = {}
): FakeEndpointContext {
  return {
    path,
    body: options.body,
    headers: options.bearer
      ? new Headers({ authorization: `Bearer ${options.bearer}` })
      : undefined,
    context: {
      secret: VALID_SECRET,
      authCookies: { sessionToken: { name: SESSION_COOKIE_NAME } },
      internalAdapter: {
        findSession: (token) => {
          const found = store.sessions.get(token);
          return Promise.resolve(found ? { session: { token }, user: { id: found.userId } } : null);
        },
        listSessions: (userId) => {
          store.listCalls.push(userId);
          return Promise.resolve(
            store.sessions
              .values()
              .filter((session) => session.userId === userId)
              .map(({ token }) => ({ token }))
              .toArray()
          );
        },
      },
    },
    getSignedCookie: () => Promise.resolve(options.cookieToken),
  };
}

// Plays the dispatcher: before hook, the route itself (whose result, an
// APIError when it failed, lands on `context.returned`), after hook.
async function dispatch(
  auth: AuthInstance,
  ctx: FakeEndpointContext,
  route: () => unknown
): Promise<void> {
  await auth.options.hooks?.before?.(ctx as never);
  ctx.context.returned = route();
  await auth.options.hooks?.after?.(ctx as never);
}

// The consumer cache is keyed by the bare session token (see
// src/shared/session-cache.ts), whichever credential form warmed it.
function cacheKeysFor(tokens: string[]): Promise<string[]> {
  return Promise.resolve(tokens.map((token) => sessionCacheKey(token)));
}

async function seededKv(tokens: string[]): Promise<FakeKV> {
  const kv = new FakeKV();
  const keys = await cacheKeysFor(tokens);
  for (const key of keys) {
    kv.store.set(key, JSON.stringify({ credentials: [], session: { token: key } }));
  }
  return kv;
}

function authWith(kv: FakeKV, hasBearer = false): AuthInstance {
  return createAuth(buildEnv({ AUTH_KV: kv.asBinding() }), { kv, bearer: hasBearer });
}

describe('createAuth wires session cache invalidation into the Better Auth instance', () => {
  describe('sign-out', () => {
    it('registers an after-hook on the instance when a KV namespace is configured', () => {
      const auth = authWith(new FakeKV());
      expect(auth.options.hooks?.after).toBeDefined();
    });

    it('deletes the session-client cache entry for the signed-out session token', async () => {
      const kv = await seededKv([TOKEN]);
      const auth = authWith(kv);

      await auth.options.hooks!.after!(
        endpointContext(fakeStore(), '/sign-out', { cookieToken: TOKEN }) as never
      );

      expect(new Set(kv.deletes)).toEqual(new Set(await cacheKeysFor([TOKEN])));
      const keys = await cacheKeysFor([TOKEN]);
      for (const key of keys) {
        expect(await kv.get(key)).toBeNull();
      }
    });

    it('resolves to an object, since the after-hook runner reads headers and response off the result', async () => {
      const auth = authWith(new FakeKV());

      const result = await auth.options.hooks!.after!(
        endpointContext(fakeStore(), '/sign-out', { cookieToken: TOKEN }) as never
      );

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    it('does nothing when the sign-out request carries no session cookie', async () => {
      const kv = new FakeKV();
      const auth = authWith(kv);

      await auth.options.hooks!.after!(endpointContext(fakeStore(), '/sign-out') as never);

      expect(kv.deletes).toHaveLength(0);
    });
  });

  describe('single-session revocation', () => {
    it('deletes the cache entry for the token in /revoke-session’s body', async () => {
      const kv = await seededKv([TOKEN]);
      const auth = authWith(kv);

      await auth.options.hooks!.after!(
        endpointContext(fakeStore(), '/revoke-session', { body: { token: TOKEN } }) as never
      );

      expect(new Set(kv.deletes)).toEqual(new Set(await cacheKeysFor([TOKEN])));
    });

    it('deletes the cache entry for the sessionToken in /admin/revoke-user-session’s body', async () => {
      const kv = await seededKv([TOKEN]);
      const auth = authWith(kv);

      await auth.options.hooks!.after!(
        endpointContext(fakeStore(), '/admin/revoke-user-session', {
          body: { sessionToken: TOKEN },
        }) as never
      );

      expect(new Set(kv.deletes)).toEqual(new Set(await cacheKeysFor([TOKEN])));
    });
  });

  describe('revoking every session of the current user', () => {
    it.each([
      '/revoke-sessions',
      '/revoke-other-sessions',
      '/delete-user',
      '/delete-user/callback',
    ])(
      '%s clears every cached session of the signed-in user, after the revocation',
      async (path) => {
        const kv = await seededKv(USER_TOKENS);
        const store = fakeStore();
        const auth = authWith(kv);
        const ctx = endpointContext(store, path, { cookieToken: TOKEN });
        let deletesAtRevocation = -1;

        await dispatch(auth, ctx, () => {
          deletesAtRevocation = kv.deletes.length;
          store.sessions.clear();
        });

        expect(deletesAtRevocation).toBe(0);
        expect(new Set(kv.deletes)).toEqual(new Set(await cacheKeysFor(USER_TOKENS)));
        const keys = await cacheKeysFor(USER_TOKENS);
        for (const key of keys) {
          expect(await kv.get(key)).toBeNull();
        }
      }
    );

    it('does nothing when the request carries no session', async () => {
      const kv = await seededKv(USER_TOKENS);
      const store = fakeStore();
      const auth = authWith(kv);

      await dispatch(auth, endpointContext(store, '/revoke-sessions'), () => {});

      expect(kv.deletes).toHaveLength(0);
    });

    it('only clears the sessions of the signed-in user', async () => {
      const kv = await seededKv([...USER_TOKENS, 'other-user-token']);
      const store = fakeStore();
      store.sessions.set('other-user-token', { token: 'other-user-token', userId: 'user-2' });
      const auth = authWith(kv);

      await dispatch(
        auth,
        endpointContext(store, '/revoke-sessions', { cookieToken: TOKEN }),
        () => {}
      );

      const otherKeys = await cacheKeysFor(['other-user-token']);
      for (const key of otherKeys) {
        expect(kv.deletes).not.toContain(key);
      }
      expect(new Set(kv.deletes)).toEqual(new Set(await cacheKeysFor(USER_TOKENS)));
    });
  });

  describe('bearer-authenticated callers', () => {
    // Our before hook runs before the bearer plugin's, so the caller is
    // read off the Authorization header directly.
    it.each([
      ['bare token', TOKEN],
      ['signed token', `${TOKEN}.c2lnbmF0dXJl`],
      ['URL-encoded signed token', encodeURIComponent(`${TOKEN}.c2lnbmF0dXJl=`)],
    ])(
      '/revoke-sessions over a %s clears every cached session of the caller',
      async (_form, bearer) => {
        const kv = await seededKv(USER_TOKENS);
        const store = fakeStore();
        const auth = authWith(kv, true);
        const ctx = endpointContext(store, '/revoke-sessions', { bearer });

        await dispatch(auth, ctx, () => store.sessions.clear());

        expect(new Set(kv.deletes)).toEqual(new Set(await cacheKeysFor(USER_TOKENS)));
      }
    );

    it('/admin/revoke-user-sessions over a bearer token clears the named user’s sessions', async () => {
      const kv = await seededKv(USER_TOKENS);
      const store = fakeStore();
      const auth = authWith(kv, true);
      const ctx = endpointContext(store, '/admin/revoke-user-sessions', {
        bearer: ADMIN_TOKEN,
        body: { userId: USER_ID },
      });

      await dispatch(auth, ctx, () => store.sessions.clear());

      expect(new Set(kv.deletes)).toEqual(new Set(await cacheKeysFor(USER_TOKENS)));
    });

    it('ignores the Authorization header when the bearer plugin is not enabled', async () => {
      const kv = await seededKv(USER_TOKENS);
      const store = fakeStore();
      const auth = authWith(kv, false);

      await dispatch(auth, endpointContext(store, '/revoke-sessions', { bearer: TOKEN }), () =>
        store.sessions.clear()
      );

      expect(store.listCalls).toHaveLength(0);
      expect(kv.deletes).toHaveLength(0);
    });

    it('ignores a bearer token that does not match a session', async () => {
      const kv = await seededKv(USER_TOKENS);
      const store = fakeStore();
      const auth = authWith(kv, true);

      await dispatch(
        auth,
        endpointContext(store, '/revoke-sessions', { bearer: 'not-a-session' }),
        () => UNAUTHORIZED
      );

      expect(store.listCalls).toHaveLength(0);
      expect(kv.deletes).toHaveLength(0);
    });
  });

  describe('admin routes revoking every session of a user named in the body', () => {
    it.each(['/admin/revoke-user-sessions', '/admin/remove-user', '/admin/ban-user'])(
      '%s clears every cached session of body.userId, after the revocation',
      async (path) => {
        const kv = await seededKv(USER_TOKENS);
        const store = fakeStore();
        const auth = authWith(kv);
        const ctx = endpointContext(store, path, {
          cookieToken: ADMIN_TOKEN,
          body: { userId: USER_ID },
        });
        let deletesAtRevocation = -1;

        await dispatch(auth, ctx, () => {
          deletesAtRevocation = kv.deletes.length;
          store.sessions.clear();
        });

        expect(deletesAtRevocation).toBe(0);
        expect(new Set(kv.deletes)).toEqual(new Set(await cacheKeysFor(USER_TOKENS)));
      }
    );

    it('/admin/update-user with banned: true clears every cached session of body.userId', async () => {
      const kv = await seededKv(USER_TOKENS);
      const store = fakeStore();
      const auth = authWith(kv);
      const ctx = endpointContext(store, '/admin/update-user', {
        cookieToken: ADMIN_TOKEN,
        body: { userId: USER_ID, data: { banned: true } },
      });

      await dispatch(auth, ctx, () => store.sessions.clear());

      expect(new Set(kv.deletes)).toEqual(new Set(await cacheKeysFor(USER_TOKENS)));
    });

    it('/admin/update-user without a ban neither lists nor clears anything', async () => {
      const kv = await seededKv(USER_TOKENS);
      const store = fakeStore();
      const auth = authWith(kv);
      const ctx = endpointContext(store, '/admin/update-user', {
        cookieToken: ADMIN_TOKEN,
        body: { userId: USER_ID, data: { name: 'Renamed' } },
      });

      await dispatch(auth, ctx, () => {});

      expect(store.listCalls).toHaveLength(0);
      expect(kv.deletes).toHaveLength(0);
    });

    it('/admin/stop-impersonating clears the impersonation session the request carries', async () => {
      const kv = await seededKv([TOKEN]);
      const auth = authWith(kv);

      await dispatch(
        auth,
        endpointContext(fakeStore(), '/admin/stop-impersonating', { cookieToken: TOKEN }),
        () => ({ success: true })
      );

      expect(new Set(kv.deletes)).toEqual(new Set(await cacheKeysFor([TOKEN])));
    });

    it.each(['/admin/revoke-user-sessions', '/admin/remove-user', '/admin/ban-user'])(
      '%s does not look up or clear anything for an unauthenticated caller',
      async (path) => {
        const kv = await seededKv(USER_TOKENS);
        const store = fakeStore();
        const auth = authWith(kv);
        const ctx = endpointContext(store, path, { body: { userId: USER_ID } });

        await dispatch(auth, ctx, () => UNAUTHORIZED);

        expect(store.listCalls).toHaveLength(0);
        expect(kv.deletes).toHaveLength(0);
      }
    );
  });

  describe('a revocation the endpoint rejected', () => {
    it('does not evict the named session when /revoke-session fails', async () => {
      const kv = await seededKv([TOKEN]);
      const store = fakeStore();
      const auth = authWith(kv);

      await dispatch(
        auth,
        endpointContext(store, '/revoke-session', { body: { token: TOKEN } }),
        () => UNAUTHORIZED
      );

      expect(kv.deletes).toHaveLength(0);
      expect(await kv.get(sessionCacheKey(TOKEN))).not.toBeNull();
    });

    it('does not evict the collected sessions when an authenticated admin call is refused', async () => {
      const kv = await seededKv(USER_TOKENS);
      const store = fakeStore();
      const auth = authWith(kv);
      const ctx = endpointContext(store, '/admin/revoke-user-sessions', {
        cookieToken: ADMIN_TOKEN,
        body: { userId: USER_ID },
      });

      await dispatch(auth, ctx, () => new APIError('FORBIDDEN', { message: 'Forbidden' }));

      expect(kv.deletes).toHaveLength(0);
    });

    it('does not evict the cached session when sign-out fails', async () => {
      const kv = await seededKv([TOKEN]);
      const auth = authWith(kv);
      const ctx = endpointContext(fakeStore(), '/sign-out', { cookieToken: TOKEN });

      await dispatch(auth, ctx, () => UNAUTHORIZED);

      expect(kv.deletes).toHaveLength(0);
    });
  });

  describe('requests that neither sign out nor revoke a session', () => {
    it('leaves an unrelated cached session entry in place', async () => {
      const kv = await seededKv([TOKEN]);
      const store = fakeStore();
      const auth = authWith(kv);

      await dispatch(
        auth,
        endpointContext(store, '/get-session', { cookieToken: TOKEN }),
        () => {}
      );

      expect(kv.deletes).toHaveLength(0);
      expect(await kv.get(sessionCacheKey(TOKEN))).not.toBeNull();
    });
  });

  describe('no shared KV namespace configured', () => {
    it('does not wire cache invalidation when a custom secondaryStorage stands in for KV', () => {
      const env = buildEnv({ AUTH_KV: undefined as unknown as KVNamespace });
      const auth = createAuth(env, { secondaryStorage: new FakeKV() as never });
      expect(auth.options.hooks?.after).toBeUndefined();
      expect(auth.options.hooks?.before).toBeUndefined();
    });
  });
});
