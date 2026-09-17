import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';

import { withHandlerContext } from '../shared/non-blocking';
import type { AuthEnv, ConfigValue } from '../types';
import { buildAllowedMethodsHook } from './allowed-methods';
import { buildRateLimitConfig, buildSessionConfig } from './config';
import { resolveDatabase, resolveHyperdriveConnectionString } from './database';
import { resolveBaseURL, resolveSecret } from './env';
import { getOptionsKey, normalizeArgs } from './normalize';
import { buildPlugins, buildSocialProviders } from './plugins';
import { withPoolLifecycle } from './postgres-pool';
import { buildSecondaryStorage } from './secondary-storage';
import { buildSessionInvalidationHook } from './session-invalidation';
import type { CreateAuthOptions } from './types';
import { validateConfig } from './validate';

export type AuthInstance = ReturnType<typeof betterAuth>;

// Better Auth's dispatcher hands `hooks.after` the raw dispatch context, which
// carries the request headers but not the cookie helpers (`getSignedCookie`)
// an endpoint handler gets. `createAuthMiddleware` builds those helpers from
// the request, so the invalidation hook can read the signed session cookie
// on `/sign-out` over HTTP. A context that already has the helpers (a direct
// call with an endpoint context) is used as is, since re-wrapping would
// replace its `getSignedCookie` with one that only sees request headers.
function withEndpointContext(
  handler: (ctx: never) => Promise<void>
): (ctx: never) => Promise<unknown> {
  const wrapped = createAuthMiddleware(handler as never) as unknown as (
    ctx: never
  ) => Promise<unknown>;
  return (ctx: never) =>
    typeof (ctx as { getSignedCookie?: unknown }).getSignedCookie === 'function'
      ? handler(ctx)
      : wrapped(ctx);
}

// Composes any user-supplied `hooks.after` with the session-cache
// invalidation hook, so wiring cache invalidation never clobbers a hook a
// consumer configured through `options.hooks` or `options.betterAuth.hooks`.
// The dispatcher reads `headers` and `response` off whatever the hook
// resolves to, so this always resolves to an object: the user's result when
// there is one, an empty one otherwise.
function mergeAfterHook(
  existing: { after?: (ctx: never) => Promise<unknown> } | undefined,
  invalidateSessionCache: (ctx: never) => Promise<void>
): { after: (ctx: never) => Promise<unknown> } {
  const existingAfter = existing?.after;
  const invalidate = withEndpointContext(invalidateSessionCache);
  return {
    after: async (ctx: never) => {
      const result = await existingAfter?.(ctx);
      await invalidate(ctx);
      return result ?? {};
    },
  };
}

// Composes any user-supplied `hooks.before` with the allowedMethods
// restriction, so wiring the restriction never clobbers a hook a consumer
// configured through `options.hooks` or `options.betterAuth.hooks`. The
// restriction runs first so a disallowed method is rejected before the
// user's hook sees the request.
function mergeBeforeHook(
  existing: { before?: (ctx: never) => Promise<unknown> } | undefined,
  checkAllowedMethods: (ctx: never) => void
): { before: (ctx: never) => Promise<unknown> } {
  const existingBefore = existing?.before;
  return {
    // Better Auth's hook runner always awaits the return value of
    // `hooks.before`, so this must resolve to a promise even when there is
    // no user-supplied `before` hook to compose with (a bare synchronous
    // function would make `withSpan` return the raw, non-promise value and
    // crash the runner's `.catch` chain).
    before: async (ctx: never) => {
      checkAllowedMethods(ctx);
      return await existingBefore?.(ctx);
    },
  };
}

function buildHooksField(
  options: CreateAuthOptions | undefined,
  invalidateSessionCache: ((ctx: never) => Promise<void>) | undefined,
  checkAllowedMethods: ((ctx: never) => void) | undefined
):
  | Record<string, never>
  | {
      hooks: {
        after?: (ctx: never) => Promise<unknown>;
        before?: (ctx: never) => unknown;
      };
    } {
  if (!invalidateSessionCache && !checkAllowedMethods) return {};
  const existing = (options?.betterAuth?.hooks ?? options?.hooks) as
    | { after?: (ctx: never) => Promise<unknown>; before?: (ctx: never) => Promise<unknown> }
    | undefined;
  return {
    hooks: {
      ...(invalidateSessionCache && mergeAfterHook(existing, invalidateSessionCache)),
      ...(checkAllowedMethods && mergeBeforeHook(existing, checkAllowedMethods)),
    },
  };
}

// Schema validation is off by default because the schema ships as SQL
// migrations (see migrations/) and D1/Hyperdrive have no introspection the
// check could use. A consumer's `advanced` settings (through `options` or
// `options.betterAuth`) are layered on top rather than replacing the default,
// so setting e.g. `advanced.disableCSRFCheck` does not silently turn the
// schema check back on.
function buildAdvancedConfig(options?: CreateAuthOptions): Record<string, ConfigValue> {
  const user = (options?.betterAuth?.advanced ?? options?.advanced) as
    Record<string, ConfigValue> | undefined;
  const userDatabase = user?.database as Record<string, ConfigValue> | undefined;
  return {
    ...user,
    database: { validateSchema: false, ...userDatabase },
  };
}

const instanceCache = new WeakMap<object, Map<string, AuthInstance>>();

function getCachedInstance(env: object, optionsKey: string): AuthInstance | undefined {
  return instanceCache.get(env)?.get(optionsKey);
}

function setCachedInstance(env: object, optionsKey: string, instance: AuthInstance): void {
  let envMap = instanceCache.get(env);
  if (!envMap) {
    envMap = new Map();
    instanceCache.set(env, envMap);
  }
  envMap.set(optionsKey, instance);
}

export function createAuth(env: AuthEnv, options?: CreateAuthOptions): AuthInstance;
export function createAuth(options: CreateAuthOptions, env?: AuthEnv): AuthInstance;
export function createAuth(
  arg1: AuthEnv | CreateAuthOptions,
  arg2?: CreateAuthOptions | AuthEnv
): AuthInstance {
  const { env, options } = normalizeArgs(arg1, arg2);
  const isHyperdrive = Boolean(resolveHyperdriveConnectionString(options, env));
  const optionsKey = getOptionsKey(options);

  if (!isHyperdrive) {
    const cached = getCachedInstance(env, optionsKey);
    if (cached) {
      return cached;
    }
  }

  validateConfig(options, env);

  const baseURL = resolveBaseURL(options, env) as string;
  const secret = resolveSecret(options, env) as string;
  const plugins = buildPlugins(options);
  const socialProviders = buildSocialProviders(options, env);
  const secondaryStorage = buildSecondaryStorage(options, env);
  const { database, pool } = resolveDatabase(options, env) ?? {};
  const session = buildSessionConfig(options);
  const rateLimit = buildRateLimitConfig(options, secondaryStorage);
  const invalidateSessionCache = buildSessionInvalidationHook(options, env);
  const checkAllowedMethods = buildAllowedMethodsHook(options);

  const defaults = {
    basePath: '/api/auth',
  };

  const authConfig = {
    ...defaults,
    ...options,
    baseURL,
    secret,
    ...(database !== undefined && { database }),
    ...(secondaryStorage !== undefined && { secondaryStorage }),
    ...(socialProviders !== undefined && { socialProviders }),
    plugins,
    ...options?.betterAuth,
    advanced: buildAdvancedConfig(options),
    session,
    ...(rateLimit !== undefined && { rateLimit }),
    ...buildHooksField(options, invalidateSessionCache, checkAllowedMethods),
  };

  // @ts-expect-error betterAuth accepts custom database adapters like D1/Hyperdrive in Cloudflare Workers
  const instance = betterAuth(authConfig);
  void instance.$context.catch(() => {});

  withHandlerContext(instance, options?.ctx);

  if (pool) {
    withPoolLifecycle(instance, pool, options?.ctx);
  }

  if (!isHyperdrive) {
    setCachedInstance(env, optionsKey, instance);
  }

  return instance;
}
