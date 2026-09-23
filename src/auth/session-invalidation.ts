import { isAPIError } from 'better-auth/api';

import { bearerCredentialFromHeader } from '../shared/credentials';
import { sessionCacheKey, sessionTokenOf } from '../shared/session-cache';
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
interface SessionTokenRow {
  token: string;
}

interface InternalAdapter {
  findSession: (
    token: string
  ) => Promise<{ session: SessionTokenRow; user: { id: string } } | null>;
  listSessions: (userId: string) => Promise<SessionTokenRow[]>;
}

interface HookContext {
  path: string;
  body?: {
    token?: string;
    sessionToken?: string;
    userId?: string;
    data?: { banned?: boolean };
    updatePhoneNumber?: boolean;
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

// Session-authenticated routes that may delete every session of the caller
// (`/change-password` does so when `revokeOtherSessions` is set). The
// password-reset routes are not here: they identify the user through a
// one-time token rather than a session, so their entries expire on their
// own — the README says so.
const CURRENT_USER_PATHS = new Set([
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/delete-user',
  '/delete-user/callback',
  '/change-password',
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

type RevocationScope = 'admin' | 'current';

// The one place a path is classified against BODY_USER_PATHS /
// CURRENT_USER_PATHS; collectSessionTokens classifies once and hands the
// result to resolveTargetUserId, instead of each re-deriving it from the
// path.
function revocationScope(path: string): RevocationScope | undefined {
  if (BODY_USER_PATHS.has(path)) return 'admin';
  if (CURRENT_USER_PATHS.has(path)) return 'current';
}

// Tokens collected by the before hook, keyed on the per-request endpoint
// context Better Auth hands to both hooks of one dispatch.
const pendingTokens = new WeakMap<object, string[]>();

// The hooks read Better Auth internals that carry no stability promise:
// `context.internalAdapter.findSession` / `.listSessions` and
// `context.authCookies.sessionToken.name`. Verified against better-auth
// 1.7.x; if a later release within the peer range reshapes them, this
// fails loudly on the first revocation instead of silently leaving
// consumer caches stale. test/auth/hooks/session-invalidation.test.ts also
// checks the shape against the real instance context.
const INTERNALS_MISMATCH_MESSAGE =
  'better-auth-workers: the Better Auth endpoint context no longer has the shape this package relies on for session-cache invalidation (context.internalAdapter.findSession/listSessions, context.authCookies.sessionToken.name, getSignedCookie). Check the installed better-auth version against the peer range; invalidation cannot proceed.';

function hasInvalidationShape(ctx: unknown): boolean {
  const candidate = ctx as Partial<HookContext> | null | undefined;
  if (typeof candidate?.getSignedCookie !== 'function') return false;
  const context = candidate.context as Partial<HookContext['context']> | undefined;
  if (typeof context?.secret !== 'string') return false;
  const cookieName = (
    context.authCookies as Partial<HookContext['context']['authCookies']> | undefined
  )?.sessionToken?.name;
  if (typeof cookieName !== 'string') return false;
  const adapter = context.internalAdapter as Partial<InternalAdapter> | undefined;
  return typeof adapter?.findSession === 'function' && typeof adapter.listSessions === 'function';
}

export function assertInvalidationInternals(ctx: unknown): asserts ctx is HookContext {
  if (!hasInvalidationShape(ctx)) throw new Error(INTERNALS_MISMATCH_MESSAGE);
}

// Our `hooks.before` runs before the bearer plugin's, which is what turns
// `Authorization: Bearer …` into the session cookie, so a bearer caller is
// read off the header here, with the same parsing the session client uses.
// The token is only ever used to look a session up; nothing is invalidated
// on the strength of it. The endpoint still has to succeed for the `after`
// hook to act, and the bearer plugin only lets a signed
// `<token>.<signature>` credential authenticate one.
function bearerSessionToken(ctx: HookContext): string | undefined {
  const header = ctx.request?.headers.get('authorization') ?? ctx.headers?.get('authorization');
  const credential = bearerCredentialFromHeader(header);
  return credential ? sessionTokenOf(credential) || undefined : undefined;
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
  scope: RevocationScope,
  canUseBearer: boolean
): Promise<string | undefined> {
  const isAdminRoute = scope === 'admin';
  const target = isAdminRoute ? bodyTargetUserId(ctx) : undefined;
  if (isAdminRoute && !target) return;
  const token = await currentSessionToken(ctx, canUseBearer);
  if (!token) return;
  const caller = await ctx.context.internalAdapter.findSession(token);
  if (!caller) return;
  return isAdminRoute ? target : caller.user.id;
}

const SINGLE_TOKEN_PATHS = new Set([
  '/sign-out',
  '/admin/stop-impersonating',
  '/revoke-session',
  '/admin/revoke-user-session',
]);

// Routes that change the signed-in user without revoking any session. Every
// session of that user caches the user in the session client's KV entry, so
// all of them are evicted (listed in `before`, cleared in `after`, like the
// revoke-all routes), or a `phoneNumberVerified` gate would keep refusing
// the user on their other devices after they verify on one.
function isCurrentUserUpdate(ctx: HookContext): boolean {
  if (ctx.path === '/update-user') return true;
  return ctx.path === '/phone-number/verify' && ctx.body?.updatePhoneNumber === true;
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
  const scope = revocationScope(ctx.path) ?? (isCurrentUserUpdate(ctx) ? 'current' : undefined);
  if (!scope) return;
  assertInvalidationInternals(ctx);
  const userId = await resolveTargetUserId(ctx, scope, canUseBearer);
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
    if (collected && isCurrentUserUpdate(ctx)) {
      // The update itself succeeded; a stale cached copy is the worst a
      // failed eviction leaves (KV refuses a second write to a key within a
      // second), so it is logged rather than turned into a failed update.
      // Revocations above fail loudly: a surviving entry there is a session
      // that should be dead.
      try {
        await invalidateTokens(kv, collected);
      } catch (error) {
        console.error(
          'better-auth-workers: could not evict cached sessions after a user update',
          error
        );
      }
      return;
    }
    if (collected) {
      await invalidateTokens(kv, collected);
      return;
    }
    if (!SINGLE_TOKEN_PATHS.has(ctx.path)) return;
    assertInvalidationInternals(ctx);
    const token = await resolveSingleToken(ctx);
    if (!token) return;
    await invalidateTokens(kv, [token]);
  };
}
