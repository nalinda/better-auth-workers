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
  field: 'session' | 'rateLimit' | 'advanced' | 'socialProviders' | 'verification'
): Loose | undefined {
  // `field` is a closed literal union, so this is not an injection sink.
  // eslint-disable-next-line security/detect-object-injection -- field is a closed literal union
  const value = options?.betterAuth?.[field];
  return value && typeof value === 'object' ? value : undefined;
}

// Verification values live in the primary database, not KV: the package's
// KV storage declines them (see secondary-storage.ts), so Better Auth must
// be told to use the database. `betterAuth.verification` layers on top.
// An explicit `storeInDatabase: undefined` counts as unset, not as off:
// spread over the default it would turn the database off while the KV
// storage still declines these values, leaving them nowhere.
export function buildVerificationConfig(options?: CreateAuthOptions): Loose {
  const verification = betterAuthField(options, 'verification');
  return { ...verification, storeInDatabase: verification?.storeInDatabase ?? true };
}

// The package's KV storage never holds verification values, so turning the
// database off for them would leave OTP codes, magic links and OAuth state
// nowhere. A consumer who brings their own `betterAuth.secondaryStorage`
// decides for themselves.
export function verificationStorageProblem(options?: CreateAuthOptions): string | undefined {
  if (options?.betterAuth?.secondaryStorage) return;
  if (betterAuthField(options, 'verification')?.storeInDatabase !== false) return;
  return 'betterAuth.verification.storeInDatabase: false is not supported with the package KV storage, which keeps verification values (OTP codes, magic links, OAuth state) in the primary database';
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

// `idType: 'uuid'` is Better Auth's own `generateId: 'uuid'`: on Postgres it
// leaves the id to the column's `gen_random_uuid()` default, on D1 it
// generates the UUID itself. A `generateId` set through
// `betterAuth.advanced.database` still wins, like every escape-hatch field.
export function buildAdvancedConfig(options?: CreateAuthOptions): Loose {
  const advanced = betterAuthField(options, 'advanced');
  const database = advanced?.database as Loose | undefined;
  const ipAddress = advanced?.ipAddress as Loose | undefined;
  const generateId = options?.idType === 'uuid' ? { generateId: 'uuid' } : {};
  return {
    ...advanced,
    database: { validateSchema: false, ...generateId, ...database },
    ipAddress: { ipAddressHeaders: DEFAULT_IP_ADDRESS_HEADERS, ...ipAddress },
  };
}

// Every other field the package contributes and `betterAuth` can also touch
// is additive (plugins appended, session/rateLimit/advanced shallow-merged);
// `socialProviders` shallow-merges the same way, by provider name, so
// `betterAuth: { socialProviders: { github: {...} } }` adds a provider
// instead of silently replacing the package's own `google` config.
// Merges one level deeper than a plain spread: a provider `betterAuth`
// names in common with what the package built (typically `google`, to add
// a `scope` or `prompt`) has its fields merged rather than replaced
// wholesale, so the package's resolved `clientId`/`clientSecret` survive
// an override that only meant to add to them. A provider `betterAuth`
// names on its own (adding e.g. `github`) is used as is.
function mergedProvider(packageConfig: ConfigValue, userConfig: ConfigValue): ConfigValue {
  const areBothRecords = isRecord(packageConfig) && isRecord(userConfig);
  return areBothRecords ? { ...packageConfig, ...userConfig } : userConfig;
}

function isRecord(value: ConfigValue): value is Loose {
  return Boolean(value) && typeof value === 'object';
}

export function buildSocialProvidersConfig(
  options: CreateAuthOptions | undefined,
  socialProviders: Loose | undefined
): Loose | undefined {
  const fromBetterAuth = betterAuthField(options, 'socialProviders');
  if (!socialProviders && !fromBetterAuth) return undefined;
  const merged: Loose = { ...socialProviders };
  const userEntries = Object.entries(fromBetterAuth ?? {});
  for (const [provider, userConfig] of userEntries) {
    // `provider` comes from `Object.entries` on the caller's own object,
    // not attacker-controlled input.
    // eslint-disable-next-line security/detect-object-injection -- key from Object.entries, not external input
    merged[provider] = mergedProvider(socialProviders?.[provider], userConfig);
  }
  return merged;
}
