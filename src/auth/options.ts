import type { BetterAuthPlugin } from 'better-auth';

import type { AuthEnv, ConfigValue, ExecutionContext, KVStore } from '../types';

export interface CreateAuthPhoneOptions {
  sendOTP: (args: { phoneNumber: string; code: string }, request?: Request) => Promise<void> | void;
  otpLength?: number;
  expiresIn?: number;
  allowedAttempts?: number;
}

export type HyperdriveDatabaseOption =
  Hyperdrive | { connectionString: string; [key: string]: ConfigValue };

export interface CreateAuthDatabaseOptions {
  hyperdrive?: HyperdriveDatabaseOption;
  d1?: D1Database | Record<string, (arg?: string) => void>;
}

export interface CreateAuthSecondaryStorage {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string, ttl?: number): Promise<void> | void;
  delete(key: string): Promise<void> | void;
  increment?: (key: string, ttl: number) => Promise<number> | number;
}

export interface CreateAuthRateLimitOptions {
  enabled?: boolean;
  window?: number;
  max?: number;
  storage?: 'memory' | 'database' | 'secondary-storage';
  customRules?: Record<string, ConfigValue>;
  [key: string]: ConfigValue;
}

export interface CreateAuthCookieCacheOptions {
  enabled?: boolean;
  maxAge?: number;
  [key: string]: ConfigValue;
}

export interface CreateAuthSessionOptions {
  cookieCache?: CreateAuthCookieCacheOptions;
  storeSessionInDatabase?: boolean;
  [key: string]: ConfigValue;
}

export interface CreateAuthOptions {
  basePath?: string;
  baseURL?: string;
  secret?: string;
  database?: CreateAuthDatabaseOptions | D1Database;
  kv?: KVStore;
  secondaryStorage?: CreateAuthSecondaryStorage;
  ctx?: ExecutionContext;
  phone?: CreateAuthPhoneOptions;
  google?: boolean | { clientId: string; clientSecret: string };
  bearer?: boolean;
  allowedMethods?: Array<'phone' | 'google' | 'magic-link'>;
  plugins?: BetterAuthPlugin[];
  rateLimit?: CreateAuthRateLimitOptions;
  session?: CreateAuthSessionOptions;
  betterAuth?: Record<string, ConfigValue>;
  [key: string]: ConfigValue;
}

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
  if ('database' in obj || 'phone' in obj || 'bearer' in obj) return true;
  return Object.keys(obj).some((key) => OPTION_KEYS.has(key));
}

export function normalizeArgs(
  arg1: AuthEnv | CreateAuthOptions,
  arg2?: CreateAuthOptions | AuthEnv
): { env: AuthEnv; options?: CreateAuthOptions } {
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
