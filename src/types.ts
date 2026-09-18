/// <reference types="@cloudflare/workers-types" preserve="true" />

// The bindings createAuth reads. Extend it (`interface Env extends AuthEnv`)
// with whatever else the Worker binds; there is no index signature, so the
// package's own bindings stay exactly typed. Every field is optional because
// each is a fallback for an `options` field (`kv`, `baseURL`, `secret`,
// `database`): a Worker may bind under other names and pass the values
// through options. Startup validation, which checks every source, is what
// enforces that each value is present.
export interface AuthEnv {
  // KV namespace used for secondary storage, rate limiting and session-cache invalidation.
  AUTH_KV?: KVNamespace;
  // Public base URL Better Auth uses to build absolute URLs.
  AUTH_BASE_URL?: string;
  // Secret Better Auth uses to sign and encrypt session data.
  BETTER_AUTH_SECRET?: string;
  // Hyperdrive binding, for a Postgres-backed database.
  HYPERDRIVE?: Hyperdrive;
  // D1 binding, for a SQLite-backed database.
  DB?: D1Database;
  // Google OAuth client id; required together with GOOGLE_CLIENT_SECRET when google: true.
  GOOGLE_CLIENT_ID?: string;
  // Google OAuth client secret; required together with GOOGLE_CLIENT_ID when google: true.
  GOOGLE_CLIENT_SECRET?: string;
}

// Named `WaitUntilContext`, not `ExecutionContext`, because consumers must
// install `@cloudflare/workers-types` for this package's declarations to
// resolve (see README "Installation"), and that package declares a global
// `ExecutionContext` of its own — the same name here would silently shadow
// it with this narrower shape wherever both are in scope.
export interface WaitUntilContext {
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
