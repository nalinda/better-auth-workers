import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';

import type { ConfigValue, KVStore, WaitUntilContext } from '../types';
import type { PgPoolConstructor } from './postgres-pool';

export interface CreateAuthPhoneOptions {
  sendOTP: (args: { phoneNumber: string; code: string }, request?: Request) => Promise<void> | void;
  otpLength?: number;
  expiresIn?: number;
  allowedAttempts?: number;
  // Await `sendOTP` before answering, so a delivery failure reaches the
  // client as an error instead of a `200`. See README "Delivery failures".
  awaitDelivery?: boolean;
  // Runs before a code is created, so a refusal (throw an OTPDeliveryError)
  // leaves any code already sent to the number valid. Per-number limits go
  // here. See README "Limiting codes per number".
  beforeSendOTP?: (args: { phoneNumber: string }, request?: Request) => Promise<void> | void;
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
  Pool: PgPoolConstructor;
}

export interface CreateAuthDatabaseOptions {
  hyperdrive?: HyperdriveDatabaseOption;
  // The `pg` module (`import pg from 'pg'`). Workers are bundled, so the
  // driver has to be imported by the Worker itself for the bundler to
  // include it; the package cannot load it on the consumer's behalf.
  pg?: PgDriver;
  // Postgres schema the auth tables live in (Hyperdrive only). Every query
  // is qualified with it through Better Auth's `schemaName`, so nothing
  // relies on the connection's `search_path`. Generate matching SQL with
  // `better-auth-workers sql --schema <name>`.
  schema?: string;
  d1?: D1Database;
}

// How ids are generated. `'uuid'` has Better Auth issue UUIDs: on Postgres
// the database generates them (the id columns need a `gen_random_uuid()`
// default, which `better-auth-workers sql --id-type uuid` emits), on D1
// Better Auth generates them itself and stores them as text.
export type CreateAuthIdType = 'text' | 'uuid';

// Deterministic stand-ins for end-to-end tests. Refused unless every base
// URL is http:// on a loopback host; see README "Test mode".
export interface CreateAuthTestModeOptions {
  // Every phone verification accepts this code (4 to 10 digits), and
  // nothing is sent.
  otpCode?: string;
  // Google sign-in goes through an in-process stub that signs in the
  // identity named by the sign-in's `loginHint`.
  google?: boolean;
}

export interface CreateAuthSecondaryStorage {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string, ttl?: number): Promise<void> | void;
  delete(key: string): Promise<void> | void;
  getAndDelete?: (key: string) => Promise<string | null> | string | null;
  increment?: (key: string, ttl: number) => Promise<number> | number;
}

// A Better Auth `hooks.before` / `hooks.after` handler as configured
// through `betterAuth.hooks`; the package composes its own hooks around it.
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
  // The request's WaitUntilContext. Only a fallback: pass the context to
  // `auth.handler(request, ctx)` on every request, since a memoised
  // instance would otherwise keep using the context of the request that
  // first built it.
  ctx?: WaitUntilContext;
  phone?: CreateAuthPhoneOptions;
  magicLink?: CreateAuthMagicLinkOptions;
  google?: boolean | { clientId: string; clientSecret: string };
  bearer?: boolean;
  idType?: CreateAuthIdType;
  /**
   * @deprecated Configure only the sign-in methods this Worker should accept
   * (`phone`, `google`, `magicLink`) instead. Removed in the next major
   * version.
   */
  allowedMethods?: Array<'phone' | 'google' | 'magic-link'>;
  plugins?: BetterAuthPlugin[];
  testMode?: CreateAuthTestModeOptions;
  // The single escape hatch: any Better Auth option (`session`, `rateLimit`,
  // `hooks`, `advanced`, ...). Merged last, so it can override anything.
  // Typed against Better Auth's own options, so a misspelled key here is a
  // type error too, not just at the top level — except for the four fields
  // this package builds and merges itself, which the internal config
  // assembly treats as a loose `ConfigValue` (see `config.ts`) rather than
  // Better Auth's stricter shape for them.
  betterAuth?: Partial<
    Omit<BetterAuthOptions, 'database' | 'plugins' | 'secondaryStorage' | 'hooks'>
  > & {
    // `NonNullable`, since `ConfigValue` already includes `undefined` and
    // the `?` on the key is what conveys optionality here.
    database?: NonNullable<ConfigValue>;
    plugins?: BetterAuthPlugin[];
    secondaryStorage?: CreateAuthSecondaryStorage;
    hooks?: CreateAuthHooks;
  };
}
