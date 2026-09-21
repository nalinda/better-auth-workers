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
// credentials it was verified with — the signed `<token>.<signature>`
// value, whether it arrived as a cookie or as a bearer credential.
export interface CachedSessionEntry {
  credentials: string[];
  session: SessionData;
}

export interface SessionClient {
  // Resolves to the session, or `null` when the auth Worker answered that
  // there is none. Throws `SessionUnavailableError` when it could not get an
  // answer at all (service binding unreachable, auth Worker 5xx), so an
  // outage is never mistaken for "not signed in".
  get: (request: Request) => Promise<SessionData | null>;
}

// Thrown by `SessionClient.get` when the auth Worker gave no answer: the
// service binding threw or returned a 5xx. Distinct from `null`, which is a
// real negative answer.
export class SessionUnavailableError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SessionUnavailableError';
    this.status = status;
  }
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

export interface RequireSessionOptions<C = unknown> {
  // A SessionClient built with createSessionClient (or anything with the
  // same shape), or a function returning one from the request context — for
  // a client an earlier middleware put on a Hono variable.
  client: SessionClient | ((c: C) => SessionClient);
  // Optional role check run against the resolved session; returning false yields a 403.
  predicate?: (session: SessionData) => boolean | Promise<boolean>;
}
