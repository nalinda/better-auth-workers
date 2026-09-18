export type { AuthInstance } from './auth/create-auth';
export { createAuth } from './auth/create-auth';
export type {
  CreateAuthDatabaseOptions,
  CreateAuthMagicLinkOptions,
  CreateAuthOptions,
  CreateAuthPhoneOptions,
  HyperdriveDatabaseOption,
  PgDriver,
} from './auth/types';
export type { AuthEnv, ConfigValue, KVStore, WaitUntilContext } from './types';
