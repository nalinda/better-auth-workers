import type { ConfigValue } from '../types';
import type { CreateAuthOptions, CreateAuthSecondaryStorage } from './types';

// Better Auth's own `session`, `rateLimit` and `advanced` settings are
// configured through `betterAuth`, the single escape hatch. The package
// only contributes defaults underneath them (cookie cache on, rate-limit
// counters in KV, schema validation off), shallow-merged so a consumer
// states just the fields they change and `betterAuth` remains the last word.
type Loose = Record<string, ConfigValue>;

function betterAuthField(
  options: CreateAuthOptions | undefined,
  field: 'session' | 'rateLimit' | 'advanced' | 'socialProviders'
): Loose | undefined {
  // `field` is a closed literal union, so this is not an injection sink.
  // eslint-disable-next-line security/detect-object-injection -- field is a closed literal union
  const value = options?.betterAuth?.[field];
  return value && typeof value === 'object' ? (value as Loose) : undefined;
}

export function buildSessionConfig(options?: CreateAuthOptions): Loose {
  const session = betterAuthField(options, 'session');
  const userCookieCache = session?.cookieCache;
  const cookieCache =
    typeof userCookieCache === 'boolean'
      ? { enabled: userCookieCache }
      : { enabled: true, ...(userCookieCache as Loose | undefined) };
  return { ...session, cookieCache };
}

// Better Auth only turns its rate limiter on when `NODE_ENV` is
// "production", read from the runtime's `process.env`. On Workers that
// holds the Worker's own vars, not a build-time NODE_ENV, so left to Better
// Auth the limiter would be off in a deployed Worker. It is on by default
// here, in KV; `betterAuth.rateLimit` can still turn it off or tune it.
export function buildRateLimitConfig(
  options?: CreateAuthOptions,
  secondaryStorage?: CreateAuthSecondaryStorage
): Loose | undefined {
  const rateLimit = betterAuthField(options, 'rateLimit');
  if (!secondaryStorage) return rateLimit;
  return { enabled: true, storage: 'secondary-storage', ...rateLimit };
}

// Schema validation is off by default because the schema ships as SQL
// migrations (see migrations/) and D1/Hyperdrive have no introspection the
// check could use; a consumer's `betterAuth.advanced` is layered on top so
// setting e.g. `advanced.disableCSRFCheck` does not turn the check back on.
// The rate limiter keys on the client IP. Better Auth's default reads only
// x-forwarded-for and, with no trusted proxies configured, drops any
// multi-valued value into one shared bucket — which a client can force by
// sending its own X-Forwarded-For. On Workers, cf-connecting-ip is set by
// Cloudflare and cannot be spoofed, so it is preferred; x-forwarded-for
// remains the fallback for the service-binding path the session client
// populates. `betterAuth.advanced.ipAddress` overrides this wholesale.
const DEFAULT_IP_ADDRESS_HEADERS = ['cf-connecting-ip', 'x-forwarded-for'];

export function buildAdvancedConfig(options?: CreateAuthOptions): Loose {
  const advanced = betterAuthField(options, 'advanced');
  const database = advanced?.database as Loose | undefined;
  const ipAddress = advanced?.ipAddress as Loose | undefined;
  return {
    ...advanced,
    database: { validateSchema: false, ...database },
    ipAddress: { ipAddressHeaders: DEFAULT_IP_ADDRESS_HEADERS, ...ipAddress },
  };
}

// Every other field the package contributes and `betterAuth` can also touch
// is additive (plugins appended, session/rateLimit/advanced shallow-merged);
// `socialProviders` shallow-merges the same way, by provider name, so
// `betterAuth: { socialProviders: { github: {...} } }` adds a provider
// instead of silently replacing the package's own `google` config.
export function buildSocialProvidersConfig(
  options: CreateAuthOptions | undefined,
  socialProviders: Loose | undefined
): Loose | undefined {
  const fromBetterAuth = betterAuthField(options, 'socialProviders');
  if (!socialProviders && !fromBetterAuth) return undefined;
  return { ...socialProviders, ...fromBetterAuth };
}
