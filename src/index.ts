export type { AuthInstance } from './auth/create-auth';
export { createAuth } from './auth/create-auth';
export type { ResolvedDatabase } from './auth/database';
export type {
  CreateAuthCookieCacheOptions,
  CreateAuthDatabaseOptions,
  CreateAuthOptions,
  CreateAuthPhoneOptions,
  CreateAuthRateLimitOptions,
  CreateAuthSecondaryStorage,
  CreateAuthSessionOptions,
  HyperdriveDatabaseOption,
} from './auth/options';
export type { AuthEnv, ConfigValue, ExecutionContext, KVStore } from './types';
