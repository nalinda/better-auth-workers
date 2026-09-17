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
  body?: { token?: string; sessionToken?: string; userId?: string };
  context: {
    secret: string;
    authCookies: { sessionToken: { name: string } };
    internalAdapter: {
      findSession: (
        token: string
      ) => Promise<{ session: SessionRecord; user: { id: string } } | null>;
      listSessions: (userId: string) => Promise<SessionRecord[]>;
    };
  };
  getSignedCookie: (name: string, secret: string) => Promise<string | undefined>;
}

const SESSION_COOKIE_NAME = 'better-auth.session_token';
const TOKEN = 'session-token-abc123';
const USER_ID = 'user-1';
const USER_TOKENS = ['session-token-abc123', 'session-token-def456', 'session-token-ghi789'];

interface FakeStore {
  sessions: Map<string, { token: string; userId: string }>;
}

function fakeStore(): FakeStore {
  return { sessions: new Map(USER_TOKENS.map((token) => [token, { token, userId: USER_ID }])) };
}

function endpointContext(
  store: FakeStore,
  path: string,
  options: { cookieToken?: string; body?: NonNullable<FakeEndpointContext['body']> } = {}
): FakeEndpointContext {
  return {
    path,
    body: options.body,
    context: {
      secret: VALID_SECRET,
      authCookies: { sessionToken: { name: SESSION_COOKIE_NAME } },
      internalAdapter: {
        findSession: (token) => {
          const found = store.sessions.get(token);
          return Promise.resolve(found ? { session: { token }, user: { id: found.userId } } : null);
        },
        listSessions: (userId) =>
          Promise.resolve(
            store.sessions
              .values()
              .filter((session) => session.userId === userId)
              .map(({ token }) => ({ token }))
              .toArray()
          ),
      },
    },
    getSignedCookie: () => Promise.resolve(options.cookieToken),
  };
}

// Plays the dispatcher: before hook, the route's own revocation, after hook.
async function dispatch(
  auth: AuthInstance,
  ctx: FakeEndpointContext,
  revoke: () => void
): Promise<void> {
  await auth.options.hooks?.before?.(ctx as never);
  revoke();
  await auth.options.hooks?.after?.(ctx as never);
}

function seededKv(tokens: string[]): FakeKV {
  const kv = new FakeKV();
  for (const token of tokens) {
    kv.store.set(sessionCacheKey(token), JSON.stringify({ session: { token } }));
  }
  return kv;
}

function authWith(kv: FakeKV): AuthInstance {
  return createAuth(buildEnv({ AUTH_KV: kv.asBinding() }), { kv });
}

describe('createAuth wires session cache invalidation into the Better Auth instance', () => {
  describe('sign-out', () => {
    it('registers an after-hook on the instance when a KV namespace is configured', () => {
      const auth = authWith(new FakeKV());
      expect(auth.options.hooks?.after).toBeDefined();
    });

    it('deletes the session-client cache entry for the signed-out session token', async () => {
      const kv = seededKv([TOKEN]);
      const auth = authWith(kv);

      await auth.options.hooks!.after!(
        endpointContext(fakeStore(), '/sign-out', { cookieToken: TOKEN }) as never
      );

      expect(kv.deletes).toContain(sessionCacheKey(TOKEN));
      expect(await kv.get(sessionCacheKey(TOKEN))).toBeNull();
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
      const kv = seededKv([TOKEN]);
      const auth = authWith(kv);

      await auth.options.hooks!.after!(
        endpointContext(fakeStore(), '/revoke-session', { body: { token: TOKEN } }) as never
      );

      expect(kv.deletes).toEqual([sessionCacheKey(TOKEN)]);
    });

    it('deletes the cache entry for the sessionToken in /admin/revoke-user-session’s body', async () => {
      const kv = seededKv([TOKEN]);
      const auth = authWith(kv);

      await auth.options.hooks!.after!(
        endpointContext(fakeStore(), '/admin/revoke-user-session', {
          body: { sessionToken: TOKEN },
        }) as never
      );

      expect(kv.deletes).toEqual([sessionCacheKey(TOKEN)]);
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
        const kv = seededKv(USER_TOKENS);
        const store = fakeStore();
        const auth = authWith(kv);
        const ctx = endpointContext(store, path, { cookieToken: TOKEN });
        let deletesAtRevocation = -1;

        await dispatch(auth, ctx, () => {
          deletesAtRevocation = kv.deletes.length;
          store.sessions.clear();
        });

        expect(deletesAtRevocation).toBe(0);
        expect(new Set(kv.deletes)).toEqual(
          new Set(USER_TOKENS.map((token) => sessionCacheKey(token)))
        );
        for (const token of USER_TOKENS) {
          expect(await kv.get(sessionCacheKey(token))).toBeNull();
        }
      }
    );

    it('does nothing when the request carries no session', async () => {
      const kv = seededKv(USER_TOKENS);
      const store = fakeStore();
      const auth = authWith(kv);

      await dispatch(auth, endpointContext(store, '/revoke-sessions'), () => {});

      expect(kv.deletes).toHaveLength(0);
    });

    it('only clears the sessions of the signed-in user', async () => {
      const kv = seededKv([...USER_TOKENS, 'other-user-token']);
      const store = fakeStore();
      store.sessions.set('other-user-token', { token: 'other-user-token', userId: 'user-2' });
      const auth = authWith(kv);

      await dispatch(
        auth,
        endpointContext(store, '/revoke-sessions', { cookieToken: TOKEN }),
        () => {}
      );

      expect(kv.deletes).not.toContain(sessionCacheKey('other-user-token'));
      expect(kv.deletes).toHaveLength(USER_TOKENS.length);
    });
  });

  describe('admin routes revoking every session of a user named in the body', () => {
    it.each(['/admin/revoke-user-sessions', '/admin/remove-user'])(
      '%s clears every cached session of body.userId, after the revocation',
      async (path) => {
        const kv = seededKv(USER_TOKENS);
        const store = fakeStore();
        const auth = authWith(kv);
        const ctx = endpointContext(store, path, {
          cookieToken: 'admin-session-token',
          body: { userId: USER_ID },
        });
        let deletesAtRevocation = -1;

        await dispatch(auth, ctx, () => {
          deletesAtRevocation = kv.deletes.length;
          store.sessions.clear();
        });

        expect(deletesAtRevocation).toBe(0);
        expect(new Set(kv.deletes)).toEqual(
          new Set(USER_TOKENS.map((token) => sessionCacheKey(token)))
        );
      }
    );
  });

  describe('requests that neither sign out nor revoke a session', () => {
    it('leaves an unrelated cached session entry in place', async () => {
      const kv = seededKv([TOKEN]);
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
