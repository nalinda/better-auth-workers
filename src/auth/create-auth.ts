import { betterAuth } from 'better-auth';

import { withHandlerContext } from '../shared/non-blocking';
import type { AuthEnv } from '../types';
import { buildRateLimitConfig, buildSessionConfig } from './config';
import { buildDatabase, resolveHyperdriveConnectionString } from './database';
import { resolveBaseURL, resolveSecret } from './env';
import { type CreateAuthOptions, getOptionsKey, normalizeArgs } from './options';
import { buildPlugins, buildSocialProviders } from './plugins';
import { withPoolLifecycle } from './postgres-pool';
import { buildSecondaryStorage } from './secondary-storage';
import { buildSessionInvalidationHook } from './session-invalidation';

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

function buildHooksField(
  options: CreateAuthOptions | undefined,
  invalidateSessionCache: ((ctx: never) => Promise<void>) | undefined
): Record<string, never> | { hooks: { after: (ctx: never) => Promise<unknown> } } {
  if (!invalidateSessionCache) return {};
  const existing = (options?.betterAuth?.hooks ?? options?.hooks) as
    { after?: (ctx: never) => Promise<unknown> } | undefined;
  return { hooks: mergeAfterHook(existing, invalidateSessionCache) };
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

  const baseURL = resolveBaseURL(options, env);
  const secret = resolveSecret(options, env);
  const plugins = buildPlugins(options);
  const socialProviders = buildSocialProviders(options, env);
  const secondaryStorage = buildSecondaryStorage(options, env);
  const { database, pool } = buildDatabase(options, env);
  const session = buildSessionConfig(options);
  const rateLimit = buildRateLimitConfig(options, secondaryStorage);
  const invalidateSessionCache = buildSessionInvalidationHook(options, env);

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
    ...buildHooksField(options, invalidateSessionCache),
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
