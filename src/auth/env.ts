import type { AuthEnv } from '../types';
import type { CreateAuthOptions } from './types';

export function resolveBaseURL(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): string | undefined {
  const baseURL =
    options?.baseURL ??
    (typeof envObj?.AUTH_BASE_URL === 'string' ? envObj.AUTH_BASE_URL : undefined);
  return (
    baseURL ??
    (typeof options?.betterAuth?.baseURL === 'string' ? options.betterAuth.baseURL : undefined)
  );
}

export function resolveSecret(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): string | undefined {
  const secret =
    options?.secret ??
    (typeof envObj?.BETTER_AUTH_SECRET === 'string' ? envObj.BETTER_AUTH_SECRET : undefined);
  return (
    secret ??
    (typeof options?.betterAuth?.secret === 'string' ? options.betterAuth.secret : undefined)
  );
}
