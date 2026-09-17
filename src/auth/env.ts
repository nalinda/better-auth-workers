import type { AuthEnv } from '../types';
import type { CreateAuthOptions } from './types';

// Both resolvable values follow the same three-way fallback: the top-level
// option, then the env binding, then the `betterAuth` escape hatch.
function resolveFromOptionsEnvOrEscapeHatch(
  field: 'baseURL' | 'secret',
  envKey: 'AUTH_BASE_URL' | 'BETTER_AUTH_SECRET',
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): string | undefined {
  // The keys are closed literal unions, not injection sinks.
  // eslint-disable-next-line security/detect-object-injection -- envKey is a closed literal union
  const fromEnv = envObj?.[envKey];
  // eslint-disable-next-line security/detect-object-injection -- field is a closed literal union
  const fromEscapeHatch = options?.betterAuth?.[field];
  // eslint-disable-next-line security/detect-object-injection -- field is a closed literal union
  const fromOptions = options?.[field];
  return fromOptions ?? asString(fromEnv) ?? asString(fromEscapeHatch);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function resolveBaseURL(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): string | undefined {
  return resolveFromOptionsEnvOrEscapeHatch('baseURL', 'AUTH_BASE_URL', options, envObj);
}

export function resolveSecret(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): string | undefined {
  return resolveFromOptionsEnvOrEscapeHatch('secret', 'BETTER_AUTH_SECRET', options, envObj);
}
