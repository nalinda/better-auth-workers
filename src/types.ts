export type AuthEnv = Record<
  string,
  string | KVNamespace | Hyperdrive | D1Database | Fetcher | boolean | number | object | undefined
>;

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
