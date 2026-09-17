export type { AuthInstance } from './auth/create-auth';
export { createAuth } from './auth/create-auth';
export type { ResolvedDatabase } from './auth/database';
export type {
  CreateAuthCookieCacheOptions,
  CreateAuthDatabaseOptions,
  CreateAuthHook,
  CreateAuthHooks,
  CreateAuthMagicLinkOptions,
  CreateAuthOptions,
  CreateAuthPhoneOptions,
  CreateAuthRateLimitOptions,
  CreateAuthSecondaryStorage,
  CreateAuthSessionOptions,
  HyperdriveDatabaseOption,
  PgDriver,
} from './auth/types';
export type { AuthEnv, ConfigValue, ExecutionContext, KVStore } from './types';
