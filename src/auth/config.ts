import type {
  CreateAuthOptions,
  CreateAuthRateLimitOptions,
  CreateAuthSecondaryStorage,
  CreateAuthSessionOptions,
} from './types';

// One merge rule for every passthrough option that also exists under
// `betterAuth`: the package default, then the top-level option, then
// `betterAuth.<field>`, shallow-merged field by field with the later layer
// winning. `betterAuth` is therefore always the last word, without a
// consumer having to restate the fields it does not change.
export function layerOptions<T extends object>(
  ...layers: Array<Partial<T> | undefined>
): Partial<T> {
  return Object.assign({}, ...layers) as Partial<T>;
}

export function buildSessionConfig(options?: CreateAuthOptions): CreateAuthSessionOptions {
  const betterAuthSession = options?.betterAuth?.session as CreateAuthSessionOptions | undefined;
  const userCookieCache = betterAuthSession?.cookieCache ?? options?.session?.cookieCache;
  const cookieCache =
    typeof userCookieCache === 'boolean'
      ? { enabled: userCookieCache }
      : {
          enabled: true,
          ...userCookieCache,
        };

  return { ...layerOptions(options?.session, betterAuthSession), cookieCache };
}

export function buildRateLimitConfig(
  options?: CreateAuthOptions,
  secondaryStorage?: CreateAuthSecondaryStorage
): CreateAuthRateLimitOptions | undefined {
  const betterAuthRateLimit = options?.betterAuth?.rateLimit as
    CreateAuthRateLimitOptions | undefined;
  if (!secondaryStorage) {
    if (!betterAuthRateLimit && !options?.rateLimit) return;
    return layerOptions(options?.rateLimit, betterAuthRateLimit);
  }
  return layerOptions<CreateAuthRateLimitOptions>(
    { storage: 'secondary-storage' },
    options?.rateLimit,
    betterAuthRateLimit
  );
}
