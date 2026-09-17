import { betterAuth } from 'better-auth';

import { withHandlerContext } from '../shared/non-blocking';
import type { AuthEnv } from '../types';
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

// Composes any user-supplied `hooks.after` with the session-cache
// invalidation hook, so wiring cache invalidation never clobbers a hook a
// consumer configured through `options.hooks` or `options.betterAuth.hooks`.
function mergeAfterHook(
  existing: { after?: (ctx: never) => Promise<unknown> } | undefined,
  invalidateSessionCache: (ctx: never) => Promise<void>
): { after: (ctx: never) => Promise<unknown> } {
  const existingAfter = existing?.after;
  if (!existingAfter) {
    return { after: invalidateSessionCache };
  }
  return {
    after: async (ctx: never) => {
      await existingAfter(ctx);
      await invalidateSessionCache(ctx);
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
    advanced: {
      database: {
        validateSchema: false,
      },
    },
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
