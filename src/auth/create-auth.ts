import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import type { admin, bearer, magicLink, phoneNumber } from 'better-auth/plugins';

import { DEFAULT_BASE_PATH } from '../shared/base-path';
import { BoundedMap } from '../shared/bounded-map';
import { type ContextRef, withHandlerContext } from '../shared/non-blocking';
import type { AuthEnv, ConfigValue, WaitUntilContext } from '../types';
import { buildAllowedMethodsHook } from './allowed-methods';
import {
  buildAdvancedConfig,
  buildRateLimitConfig,
  buildSessionConfig,
  buildSocialProvidersConfig,
  buildVerificationConfig,
} from './config';
import {
  resolveDatabase,
  type ResolvedDatabase,
  resolveHyperdriveConnectionString,
} from './database';
import { resolveBaseURL, resolveSecret } from './env';
import { withErrorCodes } from './error-codes';
import { getOptionsKey } from './options-key';
import { buildPlugins, buildSocialProviders } from './plugins';
import { withPoolLifecycle } from './postgres-pool';
import { buildSecondaryStorage } from './secondary-storage';
import { buildSessionInvalidationHook, buildSessionTokenCollector } from './session-invalidation';
import { warnIfTestMode } from './test-mode';
import type { CreateAuthHook, CreateAuthHooks, CreateAuthOptions } from './types';
import { validateConfig } from './validate';
import { buildVerificationCleanup } from './verification-cleanup';

// The instance type is Better Auth's for the plugins this package builds,
// so `auth.api` is typed with their endpoints. `admin` is a generic
// factory; its endpoints only resolve when it is instantiated explicitly.
interface PackagePluginOptions {
  plugins: [
    ReturnType<typeof admin<Record<never, never>>>,
    ReturnType<typeof phoneNumber>,
    ReturnType<typeof magicLink>,
    ReturnType<typeof bearer>,
  ];
}

type BetterAuthInstance = ReturnType<typeof betterAuth<PackagePluginOptions>>;
type FullApi = BetterAuthInstance['api'];

// The phone and magic-link plugins are only registered when their option
// is set (see plugins/index.ts), so their endpoints exist on `auth.api`
// only then. The instance type follows the options type it was built from:
// an endpoint whose method the options do not configure is typed as
// possibly undefined, so calling it is a compile error rather than an "is
// not a function" at runtime. Options typed loosely (a plain
// `CreateAuthOptions`) get every optional endpoint as possibly undefined.
// The bearer plugin contributes no endpoints, only hooks.
type PhoneEndpointName = keyof ReturnType<typeof phoneNumber>['endpoints'];
type MagicLinkEndpointName = keyof ReturnType<typeof magicLink>['endpoints'];

type AbsentEndpointName<O extends CreateAuthOptions> =
  | (O extends { phone: object } ? never : PhoneEndpointName)
  | (O extends { magicLink: object } ? never : MagicLinkEndpointName);

type ApiFor<O extends CreateAuthOptions> = Omit<FullApi, AbsentEndpointName<O>> &
  Partial<Pick<FullApi, AbsentEndpointName<O>>>;

// `options` is the full Better Auth options type, since the configured
// instance is built from whatever the consumer passed, not the fixed plugin
// list the type above is derived from.
export type AuthInstance<O extends CreateAuthOptions = CreateAuthOptions> = Omit<
  BetterAuthInstance,
  'handler' | 'options' | 'api'
> & {
  api: ApiFor<O>;
  handler: (request: Request, ctx?: WaitUntilContext) => Promise<Response>;
  options: BetterAuthOptions;
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

// Our hooks run before the user's in both slots: in `before` so a
// disallowed method is rejected before the user's hook sees the request,
// and in `after` so cache invalidation has already happened by the time a
// user's hook runs — a user hook that throws cannot leave a session the
// endpoint just revoked alive in the consumer cache. The user's return
// value is what Better Auth sees. Both compositions resolve to a promise:
// Better Auth's hook runner awaits the return value, and a bare synchronous
// function would make its tracing wrapper return a non-promise and crash
// the runner's `.catch`.
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
    for (const hook of ours) await hook(ctx);
    const result = await user?.(ctx);
    return result ?? {};
  };
}

interface OwnHooks {
  before: CreateAuthHook[];
  after: CreateAuthHook[];
}

// Composes whichever of our hooks are active with the user's
// `betterAuth.hooks.before` / `.after`. The user's hook in either slot
// survives regardless of which of ours is active, so wiring cache
// invalidation never drops a user `before`, and restricting methods never
// drops a user `after`.
function buildHooksField(
  options: CreateAuthOptions | undefined,
  ours: OwnHooks
): Record<string, never> | { hooks: CreateAuthHooks } {
  const user = options?.betterAuth?.hooks ?? {};
  if (ours.before.length === 0 && ours.after.length === 0) {
    return user.before || user.after ? { hooks: user } : {};
  }
  const hooks: CreateAuthHooks = {};
  if (ours.before.length > 0 || user.before) hooks.before = composeBefore(ours.before, user.before);
  if (ours.after.length > 0 || user.after) hooks.after = composeAfter(ours.after, user.after);
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
  const cleanUpVerification = buildVerificationCleanup(options, env);
  if (cleanUpVerification) after.push(cleanUpVerification);
  return { before, after };
}

interface CachedInstance {
  instance: AuthInstance;
  ctxRef: ContextRef;
}

// The D1 path memoises the instance per `env` (one per isolate) and per
// options shape; the Hyperdrive path builds fresh per request for pool
// safety, since its instance owns a pg Pool that is released after the
// request. The key ignores functions (see options-key.ts), so the memoised
// instance keeps the callbacks of the request that built it — the README
// warns that they must not close over per-request state.
const instanceCache = new WeakMap<object, BoundedMap<string, CachedInstance>>();

function getCachedInstance(env: object, optionsKey: string): CachedInstance | undefined {
  return instanceCache.get(env)?.get(optionsKey);
}

// Options shapes memoised per env. Non-plain objects under `options` (a
// `betterAuth.secondaryStorage` instance, a wrapped `kv`) are keyed by identity, so a
// consumer constructing one inline per request would otherwise grow this
// map for the life of the isolate; the oldest shape is evicted instead.
const MAX_SHAPES_PER_ENV = 8;

function setCachedInstance(env: object, optionsKey: string, cached: CachedInstance): void {
  let envMap = instanceCache.get(env);
  if (!envMap) {
    envMap = new BoundedMap(MAX_SHAPES_PER_ENV);
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
  const socialProviders = buildSocialProvidersConfig(options, buildSocialProviders(options, env));
  const secondaryStorage = buildSecondaryStorage(options, env);
  const session = buildSessionConfig(options);
  const rateLimit = buildRateLimitConfig(options, secondaryStorage);

  return {
    basePath: options?.basePath ?? DEFAULT_BASE_PATH,
    baseURL,
    secret,
    ...(database !== undefined && { database }),
    ...(secondaryStorage !== undefined && { secondaryStorage }),
    ...options?.betterAuth,
    // Placed after the escape hatch on purpose: `betterAuth.plugins` is
    // folded into this list by buildPlugins, never allowed to replace the
    // package's own (admin, sign-in methods, allowedMethods stubs, bearer);
    // `socialProviders` is shallow-merged with `betterAuth.socialProviders`
    // by provider name the same way, rather than let the escape hatch
    // replace it wholesale.
    plugins,
    ...(socialProviders !== undefined && { socialProviders }),
    advanced: buildAdvancedConfig(options),
    session,
    verification: buildVerificationConfig(options),
    ...(rateLimit !== undefined && { rateLimit }),
    ...buildHooksField(options, buildOwnHooks(options, env)),
  };
}

export function createAuth<O extends CreateAuthOptions = CreateAuthOptions>(
  env: AuthEnv,
  options?: O
): AuthInstance<O> {
  const isHyperdrive = Boolean(resolveHyperdriveConnectionString(options, env));
  const optionsKey = isHyperdrive ? undefined : getOptionsKey(options);

  if (optionsKey !== undefined) {
    const cached = getCachedInstance(env, optionsKey);
    if (cached) {
      // The fallback context follows the latest request, not the one that
      // built the instance; `auth.handler(request, ctx)` still takes
      // precedence over it.
      cached.ctxRef.current = options?.ctx;
      return cached.instance as AuthInstance<O>;
    }
  }

  validateConfig(options, env);
  warnIfTestMode(options);

  const ctxRef: ContextRef = { current: options?.ctx };
  const { database, pool } = resolveDatabase(options, env) ?? {};
  const authConfig = buildAuthConfig(env, options, ctxRef, database);

  // The config is assembled as a loose record: it carries a D1 binding or a
  // pg Pool as `database`, which betterAuth accepts at runtime through its
  // adapters but does not express in its option types.
  // Built and cached with the loose options type; the cache holds instances
  // of every options shape, and the return narrows to the caller's.
  const instance = betterAuth(authConfig as never) as unknown as AuthInstance;
  void instance.$context.catch(() => {});

  withHandlerContext(instance, ctxRef);
  withErrorCodes(instance, options);

  if (pool) {
    withPoolLifecycle(instance, pool, ctxRef);
  }

  if (optionsKey !== undefined) {
    setCachedInstance(env, optionsKey, { instance, ctxRef });
  }

  return instance as AuthInstance<O>;
}
