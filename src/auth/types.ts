import type { BetterAuthPlugin } from 'better-auth';

import type { ConfigValue, ExecutionContext, KVStore } from '../types';

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
