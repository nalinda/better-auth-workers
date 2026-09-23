export type { AuthInstance } from './auth/create-auth';
export { createAuth } from './auth/create-auth';
export {
  OTP_DELIVERY_FAILED,
  OTPDeliveryError,
  type OTPDeliveryErrorOptions,
  type OTPDeliveryErrorStatus,
} from './auth/otp-delivery-error';
export type {
  CreateAuthDatabaseOptions,
  CreateAuthIdType,
  CreateAuthMagicLinkOptions,
  CreateAuthOptions,
  CreateAuthPhoneOptions,
  CreateAuthTestModeOptions,
  HyperdriveDatabaseOption,
  PgDriver,
} from './auth/types';
export type { AuthEnv, ConfigValue, KVStore, WaitUntilContext } from './types';
