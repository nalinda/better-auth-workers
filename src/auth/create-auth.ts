import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';

import { type ContextRef, withHandlerContext } from '../shared/non-blocking';
import type { AuthEnv, ConfigValue, ExecutionContext } from '../types';
import { buildAllowedMethodsHook } from './allowed-methods';
import { buildRateLimitConfig, buildSessionConfig } from './config';
import {
  resolveDatabase,
  type ResolvedDatabase,
  resolveHyperdriveConnectionString,
} from './database';
import { resolveBaseURL, resolveSecret } from './env';
import { getOptionsKey } from './options-key';
import { buildPlugins, buildSocialProviders } from './plugins';
import { withPoolLifecycle } from './postgres-pool';
import { buildSecondaryStorage } from './secondary-storage';
import { buildSessionInvalidationHook, buildSessionTokenCollector } from './session-invalidation';
import type { CreateAuthHook, CreateAuthHooks, CreateAuthOptions } from './types';
import { validateConfig } from './validate';

type BetterAuthInstance = ReturnType<typeof betterAuth>;

// Better Auth's own instance, with `handler` widened to take the request's
// ExecutionContext: `auth.handler(request, ctx)` is how a Worker hands the
// package the context its waitUntil work runs on.
export type AuthInstance = Omit<BetterAuthInstance, 'handler'> & {
  handler: (request: Request, ctx?: ExecutionContext) => Promise<Response>;
};

// Better Auth's dispatcher hands hooks the raw dispatch context, which
// carries the request headers but not the cookie helpers (`getSignedCookie`)
// an endpoint handler gets. `createAuthMiddleware` builds those helpers from
// the request, so a hook can read the signed session cookie over HTTP. A
// context that already has the helpers (a direct call with an endpoint
// context) is used as is, since re-wrapping would replace its
// `getSignedCookie` with one that only sees request headers.
function withEndpointContext(handler: (ctx: never) => Promise<void>): CreateAuthHook {
  const wrapped = createAuthMiddleware(handler as never) as unknown as CreateAuthHook;
  return (ctx: never) =>
    typeof (ctx as { getSignedCookie?: unknown }).getSignedCookie === 'function'
      ? handler(ctx)
      : wrapped(ctx);
}

// Our hooks run before the user's in `before` (a disallowed method is
// rejected before the user's hook sees the request) and after the user's
// in `after`; the user's return value is what Better Auth sees in both
// cases. Both compositions resolve to a promise: Better Auth's hook runner
// awaits the return value, and a bare synchronous function would make its
// tracing wrapper return a non-promise and crash the runner's `.catch`.
function composeBefore(ours: CreateAuthHook[], user: CreateAuthHook | undefined): CreateAuthHook {
  return async (ctx: never) => {
    for (const hook of ours) await hook(ctx);
    return await user?.(ctx);
  };
}

// The dispatcher reads `headers` and `response` off whatever the after
// hook resolves to, so this always resolves to an object: the user's
// result when there is one, an empty one otherwise.
function composeAfter(ours: CreateAuthHook[], user: CreateAuthHook | undefined): CreateAuthHook {
  return async (ctx: never) => {
    const result = await user?.(ctx);
    for (const hook of ours) await hook(ctx);
    return result ?? {};
  };
}

interface OwnHooks {
  before: CreateAuthHook[];
  after: CreateAuthHook[];
}

// Composes whichever of our hooks are active with the user's
// `hooks.before` and `hooks.after` (from `options.hooks` or
// `options.betterAuth.hooks`). The user's hook in either slot survives
// regardless of which of ours is active, so wiring cache invalidation never
// drops a user `before`, and restricting methods never drops a user `after`.
function buildHooksField(
  options: CreateAuthOptions | undefined,
  ours: OwnHooks
): Record<string, never> | { hooks: CreateAuthHooks } {
  const user = (options?.betterAuth?.hooks ?? options?.hooks) as CreateAuthHooks | undefined;
  if (ours.before.length === 0 && ours.after.length === 0) return user ? { hooks: user } : {};
  const hooks: CreateAuthHooks = {};
  if (ours.before.length > 0 || user?.before)
    hooks.before = composeBefore(ours.before, user?.before);
  if (ours.after.length > 0 || user?.after) hooks.after = composeAfter(ours.after, user?.after);
  return { hooks };
}

function buildOwnHooks(options: CreateAuthOptions | undefined, env: AuthEnv): OwnHooks {
  const before: CreateAuthHook[] = [];
  const after: CreateAuthHook[] = [];
  const checkAllowedMethods = buildAllowedMethodsHook(options);
  if (checkAllowedMethods) before.push(checkAllowedMethods);
  const collectSessionTokens = buildSessionTokenCollector(options, env);
  if (collectSessionTokens) before.push(withEndpointContext(collectSessionTokens));
  const invalidateSessionCache = buildSessionInvalidationHook(options, env);
  if (invalidateSessionCache) after.push(withEndpointContext(invalidateSessionCache));
  return { before, after };
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

interface CachedInstance {
  instance: AuthInstance;
  ctxRef: ContextRef;
}

// Memoisation is per `env` (one per isolate) and per options shape. It only
// applies to the D1 path: a Hyperdrive instance owns a pg Pool that is
// released after its request, so it is rebuilt on every call.
const instanceCache = new WeakMap<object, Map<string, CachedInstance>>();

function getCachedInstance(env: object, optionsKey: string): CachedInstance | undefined {
  return instanceCache.get(env)?.get(optionsKey);
}

function setCachedInstance(env: object, optionsKey: string, cached: CachedInstance): void {
  let envMap = instanceCache.get(env);
  if (!envMap) {
    envMap = new Map();
    instanceCache.set(env, envMap);
  }
  envMap.set(optionsKey, cached);
}

// Only what Better Auth accepts reaches it: the package's own options
// (`kv`, `phone`, `allowedMethods`, the raw `database` option, ...) are
// consumed here and never spread through, so they cannot surface on
// `auth.options` or be misread as Better Auth fields. Package defaults,
// then what the package resolves and wires (baseURL, secret, storage,
// plugins, hooks), then the `betterAuth` escape hatch last so it can
// override anything.
function buildAuthConfig(
  env: AuthEnv,
  options: CreateAuthOptions | undefined,
  ctxRef: ContextRef,
  database: ResolvedDatabase | undefined
): Record<string, ConfigValue> {
  const baseURL = resolveBaseURL(options, env) as string;
  const secret = resolveSecret(options, env) as string;
  const plugins = buildPlugins(options, ctxRef);
  const socialProviders = buildSocialProviders(options, env);
  const secondaryStorage = buildSecondaryStorage(options, env);
  const session = buildSessionConfig(options);
  const rateLimit = buildRateLimitConfig(options, secondaryStorage);

  return {
    basePath: options?.basePath ?? '/api/auth',
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
    ...buildHooksField(options, buildOwnHooks(options, env)),
  };
}

export function createAuth(env: AuthEnv, options?: CreateAuthOptions): AuthInstance {
  const isHyperdrive = Boolean(resolveHyperdriveConnectionString(options, env));
  const optionsKey = isHyperdrive ? undefined : getOptionsKey(options);

  if (optionsKey !== undefined) {
    const cached = getCachedInstance(env, optionsKey);
    if (cached) {
      // The fallback context follows the latest request, not the one that
      // built the instance; `auth.handler(request, ctx)` still takes
      // precedence over it.
      cached.ctxRef.current = options?.ctx;
      return cached.instance;
    }
  }

  validateConfig(options, env);

  const ctxRef: ContextRef = { current: options?.ctx };
  const { database, pool } = resolveDatabase(options, env) ?? {};
  const authConfig = buildAuthConfig(env, options, ctxRef, database);

  // The config is assembled as a loose record: it carries a D1 binding or a
  // pg Pool as `database`, which betterAuth accepts at runtime through its
  // adapters but does not express in its option types.
  const instance = betterAuth(authConfig as never) as unknown as AuthInstance;
  void instance.$context.catch(() => {});

  withHandlerContext(instance, ctxRef);

  if (pool) {
    withPoolLifecycle(instance, pool, ctxRef);
  }

  if (optionsKey !== undefined) {
    setCachedInstance(env, optionsKey, { instance, ctxRef });
  }

  return instance;
}
