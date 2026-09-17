import type { AuthEnv } from '../types';
import type { CreateAuthOptions } from './types';

export function getOptionsKey(options?: CreateAuthOptions): string {
  if (!options || Object.keys(options).length === 0) return '{}';
  return JSON.stringify(
    options,
    (key: string, value: string | number | boolean | object | null | undefined) => {
      if (key === 'ctx') return;
      return value;
    }
  );
}

function isEnvLike(obj: object | undefined): obj is AuthEnv {
  if (!obj) return false;
  if ('AUTH_BASE_URL' in obj || 'BETTER_AUTH_SECRET' in obj) return true;
  return 'DB' in obj || 'HYPERDRIVE' in obj;
}

const OPTION_KEYS = new Set([
  'allowedMethods',
  'betterAuth',
  'secondaryStorage',
  'kv',
  'rateLimit',
  'session',
]);

function isOptionsLike(obj: object | undefined): obj is CreateAuthOptions {
  if (!obj) return false;
  if ('database' in obj || 'phone' in obj || 'magicLink' in obj || 'bearer' in obj) return true;
  return Object.keys(obj).some((key) => OPTION_KEYS.has(key));
}

export function normalizeArgs(
  arg1: AuthEnv | CreateAuthOptions,
  arg2?: CreateAuthOptions | AuthEnv
): { env: Partial<AuthEnv>; options?: CreateAuthOptions } {
  if (isEnvLike(arg2) && !isEnvLike(arg1)) {
    return {
      env: arg2,
      options: arg1,
    };
  }
  if (isOptionsLike(arg1)) {
    return {
      env: arg2 ?? {},
      options: arg1,
    };
  }
  return {
    env: arg1,
    options: arg2,
  };
}
