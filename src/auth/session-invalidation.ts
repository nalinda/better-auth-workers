import { sessionCacheKey } from '../shared/session-cache';
import type { AuthEnv, KVStore } from '../types';
import type { CreateAuthOptions } from './types';

// Better Auth invokes `hooks.after` with the endpoint context of the route
// handler that just ran. We only care about two paths: `/sign-out`, where the
// session token is the signed cookie the request carried, and
// `/revoke-session`, where the token is given in the request body. Both
// endpoints have already deleted the session from the primary store by the
// time `after` runs; our job is to also drop the copy `createSessionClient`
// may have cached in the shared KV namespace, so consumers stop seeing it.
interface AfterHookContext {
  path: string;
  body?: { token?: string };
  context: {
    secret: string;
    authCookies: { sessionToken: { name: string } };
  };
  getSignedCookie: (
    name: string,
    secret: string
  ) => Promise<string | undefined> | string | undefined;
}

async function resolveInvalidatedToken(ctx: AfterHookContext): Promise<string | undefined> {
  if (ctx.path === '/sign-out') {
    return ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
  }
  if (ctx.path === '/revoke-session') {
    return ctx.body?.token;
  }
  return undefined;
}

function resolveKv(options?: CreateAuthOptions, envObj?: AuthEnv): KVStore | undefined {
  const kv = (options?.kv ?? envObj?.AUTH_KV) as KVStore | undefined;
  if (!kv || typeof kv !== 'object') return;
  return kv;
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
  envObj?: AuthEnv
): ((ctx: AfterHookContext) => Promise<void>) | undefined {
  const kv = resolveKv(options, envObj);
  if (!kv) return undefined;

  return async (ctx: AfterHookContext) => {
    const token = await resolveInvalidatedToken(ctx);
    if (!token) return;
    await kv.delete(sessionCacheKey(token));
  };
}
