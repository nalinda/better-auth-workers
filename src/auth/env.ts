import type { AuthEnv } from '../types';
import type { CreateAuthOptions } from './options';

export function resolveBaseURL(options?: CreateAuthOptions, envObj?: AuthEnv): string {
  const baseURL =
    options?.baseURL ??
    (typeof envObj?.AUTH_BASE_URL === 'string' ? envObj.AUTH_BASE_URL : undefined);
  if (!baseURL && !options?.betterAuth?.baseURL) {
    throw new Error('baseURL is required: specify options.baseURL or env.AUTH_BASE_URL');
  }
  return baseURL ?? (options?.betterAuth?.baseURL as string);
}

export function resolveSecret(options?: CreateAuthOptions, envObj?: AuthEnv): string {
  const secret =
    options?.secret ??
    (typeof envObj?.BETTER_AUTH_SECRET === 'string' ? envObj.BETTER_AUTH_SECRET : undefined);
  if (!secret && !options?.betterAuth?.secret) {
    throw new Error('secret is required: specify options.secret or env.BETTER_AUTH_SECRET');
  }
  return secret ?? (options?.betterAuth?.secret as string);
}
