import { isAPIError } from 'better-auth/api';

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
// `hooks.after`, once the revocation has actually happened. Better Auth
// runs `after` hooks for failed endpoints too (the context then carries an
// APIError as `returned`), and nothing is invalidated in that case: an
// unauthenticated `/revoke-session` must not evict anyone's cache entry.
interface SessionRecord {
  token: string;
}

interface InternalAdapter {
  findSession: (token: string) => Promise<{ session: SessionRecord; user: { id: string } } | null>;
  listSessions: (userId: string) => Promise<SessionRecord[]>;
}

interface HookContext {
  path: string;
  body?: {
    token?: string;
    sessionToken?: string;
    userId?: string;
    data?: { banned?: boolean };
  };
  headers?: Headers;
  request?: Request;
  context: {
    secret: string;
    authCookies: { sessionToken: { name: string } };
    internalAdapter: InternalAdapter;
    // What the endpoint returned; an APIError when it failed.
    returned?: unknown;
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

// Admin routes that delete every session of the user named in the body:
// bulk revocation, removal, and banning (`/admin/update-user` only when the
// update sets `banned: true`).
const BODY_USER_PATHS = new Set([
  '/admin/revoke-user-sessions',
  '/admin/remove-user',
  '/admin/ban-user',
  '/admin/update-user',
]);

function bodyTargetUserId(ctx: HookContext): string | undefined {
  if (!BODY_USER_PATHS.has(ctx.path)) return;
  if (ctx.path === '/admin/update-user' && ctx.body?.data?.banned !== true) return;
  return ctx.body?.userId;
}

// Tokens collected by the before hook, keyed on the per-request endpoint
// context Better Auth hands to both hooks of one dispatch.
const pendingTokens = new WeakMap<object, string[]>();

// Our `hooks.before` runs before the bearer plugin's, which is what turns
// `Authorization: Bearer …` into the session cookie, so a bearer caller is
// read off the header here the way that plugin does: the value is either
// the bare token or the signed `<token>.<signature>` form (possibly
// URL-encoded). The token is only ever used to look the session up, so an
// unsigned or forged value resolves to nothing.
function bearerSessionToken(ctx: HookContext): string | undefined {
  const header = ctx.request?.headers.get('authorization') ?? ctx.headers?.get('authorization');
  if (!header || header.slice(0, 7).toLowerCase() !== 'bearer ') return;
  let value = header.slice(7).trim();
  if (value.includes('%')) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return;
    }
  }
  const [token] = value.split('.', 1);
  return token || undefined;
}

async function currentSessionToken(
  ctx: HookContext,
  canUseBearer: boolean
): Promise<string | undefined> {
  const token = await ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret
  );
  if (token) return token;
  return canUseBearer ? bearerSessionToken(ctx) : undefined;
}

// The admin routes name the target user in the body, which is
// attacker-chosen input on an unauthenticated request; their sessions are
// only listed for a caller that has a session of its own. The admin
// plugin's own authorization then decides whether the revocation happens.
async function resolveTargetUserId(
  ctx: HookContext,
  canUseBearer: boolean
): Promise<string | undefined> {
  const isAdminRoute = BODY_USER_PATHS.has(ctx.path);
  if (!isAdminRoute && !CURRENT_USER_PATHS.has(ctx.path)) return;
  const target = isAdminRoute ? bodyTargetUserId(ctx) : undefined;
  if (isAdminRoute && !target) return;
  const token = await currentSessionToken(ctx, canUseBearer);
  if (!token) return;
  const caller = await ctx.context.internalAdapter.findSession(token);
  if (!caller) return;
  return isAdminRoute ? target : caller.user.id;
}

async function resolveSingleToken(ctx: HookContext): Promise<string | undefined> {
  // By `after`, the bearer plugin has already turned the header into the
  // cookie. `/admin/stop-impersonating` deletes the impersonation session,
  // which is the one the request's cookie carries.
  if (ctx.path === '/sign-out' || ctx.path === '/admin/stop-impersonating') {
    return currentSessionToken(ctx, false);
  }
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
  const canUseBearer = Boolean(options?.bearer);
  return (ctx: HookContext) => collectSessionTokens(ctx, canUseBearer);
}

async function collectSessionTokens(ctx: HookContext, canUseBearer: boolean): Promise<void> {
  const userId = await resolveTargetUserId(ctx, canUseBearer);
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
    pendingTokens.delete(ctx.context);
    if (isAPIError(ctx.context.returned)) return;
    if (collected) {
      await invalidateTokens(kv, collected);
      return;
    }
    const token = await resolveSingleToken(ctx);
    if (!token) return;
    await invalidateTokens(kv, [token]);
  };
}
