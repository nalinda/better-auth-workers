import type {
  CreateAuthOptions,
  CreateAuthRateLimitOptions,
  CreateAuthSecondaryStorage,
  CreateAuthSessionOptions,
} from './types';

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

  return {
    ...options?.session,
    ...betterAuthSession,
    cookieCache,
  };
}

export function buildRateLimitConfig(
  options?: CreateAuthOptions,
  secondaryStorage?: CreateAuthSecondaryStorage
): CreateAuthRateLimitOptions | undefined {
  const betterAuthRateLimit = options?.betterAuth?.rateLimit as
    CreateAuthRateLimitOptions | undefined;
  const userRateLimit = betterAuthRateLimit ?? options?.rateLimit;
  if (!secondaryStorage) {
    return userRateLimit;
  }
  return {
    storage: 'secondary-storage',
    ...userRateLimit,
  };
}
