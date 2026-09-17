export interface AuthEnv {
  /**
  KV namespace used for secondary storage, rate limiting and session-cache invalidation.
  */
  AUTH_KV: KVNamespace;
  /**
  Public base URL Better Auth uses to build absolute URLs.
  */
  AUTH_BASE_URL: string;
  /**
  Secret Better Auth uses to sign and encrypt session data.
  */
  BETTER_AUTH_SECRET: string;
  /**
  Hyperdrive binding, for a Postgres-backed database.
  */
  HYPERDRIVE?: Hyperdrive;
  /**
  D1 binding, for a SQLite-backed database.
  */
  DB?: D1Database;
  /**
  Google OAuth client id; required together with GOOGLE_CLIENT_SECRET when google: true.
  */
  GOOGLE_CLIENT_ID?: string;
  /**
  Google OAuth client secret; required together with GOOGLE_CLIENT_ID when google: true.
  */
  GOOGLE_CLIENT_SECRET?: string;
  [key: string]:
    | string
    | KVNamespace
    | Hyperdrive
    | D1Database
    | Fetcher
    | boolean
    | number
    | object
    | undefined;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<void | Response>): void;
  passThroughOnException?(): void;
}

export type ConfigValue =
  string | number | boolean | object | ((...args: never[]) => Promise<void> | void) | undefined;

export interface KVStore {
  get(key: string): Promise<string | null> | string | null;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
