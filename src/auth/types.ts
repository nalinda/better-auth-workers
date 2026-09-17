import type { BetterAuthPlugin } from 'better-auth';

import type { ConfigValue, ExecutionContext, KVStore } from '../types';

export interface CreateAuthPhoneOptions {
  sendOTP: (args: { phoneNumber: string; code: string }, request?: Request) => Promise<void> | void;
  otpLength?: number;
  expiresIn?: number;
  allowedAttempts?: number;
  signUpOnVerification?: {
    getTempEmail: (phoneNumber: string) => string;
    getTempName?: (phoneNumber: string) => string;
  };
}

export interface CreateAuthMagicLinkOptions {
  sendMagicLink: (
    args: { email: string; url: string; token: string; metadata?: Record<string, ConfigValue> },
    request?: Request
  ) => Promise<void> | void;
  expiresIn?: number;
  disableSignUp?: boolean;
}

export type HyperdriveDatabaseOption =
  Hyperdrive | { connectionString: string; [key: string]: ConfigValue };

export interface PgDriver {
  Pool: new (config: { connectionString?: string; max?: number }) => { end(): Promise<void> };
}

export interface CreateAuthDatabaseOptions {
  hyperdrive?: HyperdriveDatabaseOption;
  // The `pg` module (`import pg from 'pg'`). Workers are bundled, so the
  // driver has to be imported by the Worker itself for the bundler to
  // include it; the package cannot load it on the consumer's behalf.
  pg?: PgDriver;
  d1?: D1Database | Record<string, (arg?: string) => void>;
}

export interface CreateAuthSecondaryStorage {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string, ttl?: number): Promise<void> | void;
  delete(key: string): Promise<void> | void;
  getAndDelete?: (key: string) => Promise<string | null> | string | null;
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

// A Better Auth `hooks.before` / `hooks.after` handler. The context is
// Better Auth's endpoint context; it is left loose here so a consumer can
// pass a handler built with `createAuthMiddleware` or a plain function.
export type CreateAuthHook = (ctx: never) => unknown;

export interface CreateAuthHooks {
  before?: CreateAuthHook;
  after?: CreateAuthHook;
}

// Deliberately closed: there is no index signature, so a misspelled key
// (`magicLinks:` for `magicLink:`) is a type error rather than a silently
// ignored option. Anything Better Auth accepts that is not listed here goes
// through `betterAuth`, which is merged last and can override everything.
export interface CreateAuthOptions {
  basePath?: string;
  baseURL?: string;
  secret?: string;
  database?: CreateAuthDatabaseOptions | D1Database;
  kv?: KVStore;
  secondaryStorage?: CreateAuthSecondaryStorage;
  // The request's ExecutionContext. Only a fallback: pass the context to
  // `auth.handler(request, ctx)` on every request, since a memoised
  // instance would otherwise keep using the context of the request that
  // first built it.
  ctx?: ExecutionContext;
  phone?: CreateAuthPhoneOptions;
  magicLink?: CreateAuthMagicLinkOptions;
  google?: boolean | { clientId: string; clientSecret: string };
  bearer?: boolean;
  allowedMethods?: Array<'phone' | 'google' | 'magic-link'>;
  plugins?: BetterAuthPlugin[];
  rateLimit?: CreateAuthRateLimitOptions;
  session?: CreateAuthSessionOptions;
  hooks?: CreateAuthHooks;
  advanced?: Record<string, ConfigValue>;
  betterAuth?: Record<string, ConfigValue>;
}
