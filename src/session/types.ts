import type { JsonValue, KVStore } from '../types';

export interface SessionUser {
  id: string;
  email?: string;
  name?: string;
  [key: string]: JsonValue | undefined;
}

export interface SessionRecord {
  id: string;
  token: string;
  userId: string;
  expiresAt: string;
  [key: string]: JsonValue | undefined;
}

export interface SessionData {
  session: SessionRecord;
  user: SessionUser;
}

// What the session client stores in KV: the session plus the exact
// credentials (signed cookie value or bearer token) it was verified with.
export interface CachedSessionEntry {
  credentials: string[];
  session: SessionData;
}

export interface SessionClient {
  get: (request: Request) => Promise<SessionData | null>;
}

export interface SessionClientOptions {
  // Service binding (or any fetcher) pointing at the auth Worker.
  auth: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  // KV namespace shared with the auth Worker, used to cache verified sessions.
  kv: KVStore;
  // Better Auth basePath on the auth Worker. Defaults to `/api/auth`.
  basePath?: string;
  // Session cookie name. Defaults to Better Auth's `better-auth.session_token`.
  cookieName?: string;
}

export interface RequireSessionOptions {
  // A SessionClient built with createSessionClient, or anything with the same shape.
  client: SessionClient;
  // Optional role check run against the resolved session; returning false yields a 403.
  predicate?: (session: SessionData) => boolean | Promise<boolean>;
}
