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
  field: 'session' | 'rateLimit' | 'advanced'
): Loose | undefined {
  const escapeHatch = options?.betterAuth;
  if (!escapeHatch) return;
  const value = new Map(Object.entries(escapeHatch)).get(field);
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

export function buildRateLimitConfig(
  options?: CreateAuthOptions,
  secondaryStorage?: CreateAuthSecondaryStorage
): Loose | undefined {
  const rateLimit = betterAuthField(options, 'rateLimit');
  if (!secondaryStorage) return rateLimit;
  return { storage: 'secondary-storage', ...rateLimit };
}

// Schema validation is off by default because the schema ships as SQL
// migrations (see migrations/) and D1/Hyperdrive have no introspection the
// check could use; a consumer's `betterAuth.advanced` is layered on top so
// setting e.g. `advanced.disableCSRFCheck` does not turn the check back on.
export function buildAdvancedConfig(options?: CreateAuthOptions): Loose {
  const advanced = betterAuthField(options, 'advanced');
  const database = advanced?.database as Loose | undefined;
  return { ...advanced, database: { validateSchema: false, ...database } };
}
