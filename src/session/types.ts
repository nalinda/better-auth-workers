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

export type SessionHandler = () => Promise<void>;
