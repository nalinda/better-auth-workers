import { sessionCacheKey } from '../shared/session-cache';
import type { AuthEnv, KVStore } from '../types';
import { resolveKv } from './kv';
import type { CreateAuthOptions } from './types';

// Every route that revokes a session server-side also has to drop the copy
// `createSessionClient` may have cached in the shared KV namespace, so a
// consumer Worker stops seeing the session on its next request.
//
// Routes that name one token carry it in the request (`/sign-out`: the
// signed session cookie; `/revoke-session`: `body.token`;
// `/admin/revoke-user-session`: `body.sessionToken`), so `hooks.after`
// derives the cache key directly. Routes that revoke every session of a
// user have deleted them all from the primary store by the time `after`
// runs, so their tokens are listed in `hooks.before` and cleared in
// `hooks.after`, once the revocation has actually happened.
interface SessionRecord {
  token: string;
}

interface InternalAdapter {
  findSession: (token: string) => Promise<{ session: SessionRecord; user: { id: string } } | null>;
  listSessions: (userId: string) => Promise<SessionRecord[]>;
}

interface HookContext {
  path: string;
  body?: { token?: string; sessionToken?: string; userId?: string };
  context: {
    secret: string;
    authCookies: { sessionToken: { name: string } };
    internalAdapter: InternalAdapter;
  };
  getSignedCookie: (
    name: string,
    secret: string
  ) => Promise<string | null | undefined> | string | null | undefined;
}

const CURRENT_USER_PATHS = new Set([
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/delete-user',
  '/delete-user/callback',
]);

const BODY_USER_PATHS = new Set(['/admin/revoke-user-sessions', '/admin/remove-user']);

// Tokens collected by the before hook, keyed on the per-request endpoint
// context Better Auth hands to both hooks of one dispatch.
const pendingTokens = new WeakMap<object, string[]>();

async function currentSessionToken(ctx: HookContext): Promise<string | undefined> {
  const token = await ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret
  );
  return token ?? undefined;
}

async function resolveTargetUserId(ctx: HookContext): Promise<string | undefined> {
  if (BODY_USER_PATHS.has(ctx.path)) return ctx.body?.userId;
  if (!CURRENT_USER_PATHS.has(ctx.path)) return;
  const token = await currentSessionToken(ctx);
  if (!token) return;
  const found = await ctx.context.internalAdapter.findSession(token);
  return found?.user.id;
}

async function resolveSingleToken(ctx: HookContext): Promise<string | undefined> {
  if (ctx.path === '/sign-out') return currentSessionToken(ctx);
  if (ctx.path === '/revoke-session') return ctx.body?.token;
  if (ctx.path === '/admin/revoke-user-session') return ctx.body?.sessionToken;
}

/**
 * Builds the `hooks.before` handler that, on a route revoking every session
 * of a user, lists that user's session tokens while they still exist so the
 * matching `hooks.after` can clear their cache entries.
 */
export function buildSessionTokenCollector(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): ((ctx: HookContext) => Promise<void>) | undefined {
  if (!resolveKv(options, envObj)) return undefined;
  return collectSessionTokens;
}

async function collectSessionTokens(ctx: HookContext): Promise<void> {
  const userId = await resolveTargetUserId(ctx);
  if (!userId) return;
  const sessions = await ctx.context.internalAdapter.listSessions(userId);
  pendingTokens.set(
    ctx.context,
    sessions.map((session) => session.token)
  );
}

async function invalidateTokens(kv: KVStore, tokens: string[]): Promise<void> {
  await Promise.all(
    tokens.map(async (token) => {
      await kv.delete(sessionCacheKey(token));
    })
  );
}

/**
 * Builds the `hooks.after` handler that deletes a signed-out or revoked
 * session's cache entry from the shared KV namespace, so a
 * `createSessionClient.get` in a consumer Worker sharing that namespace
 * returns `null` on its next request.
 *
 * Returns `undefined` when no KV namespace is configured (via `options.kv`
 * or `env.AUTH_KV`), since there is no cache entry to invalidate.
 */
export function buildSessionInvalidationHook(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): ((ctx: HookContext) => Promise<void>) | undefined {
  const kv = resolveKv(options, envObj);
  if (!kv) return undefined;

  return async (ctx: HookContext) => {
    const collected = pendingTokens.get(ctx.context);
    if (collected) {
      pendingTokens.delete(ctx.context);
      await invalidateTokens(kv, collected);
      return;
    }
    const token = await resolveSingleToken(ctx);
    if (!token) return;
    await invalidateTokens(kv, [token]);
  };
}
