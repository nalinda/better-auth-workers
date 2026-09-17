import type { KVStore } from './index';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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

const noopSessionHandler: SessionHandler = () => Promise.resolve();

const DEFAULT_BASE_PATH = '/api/auth';
const DEFAULT_COOKIE_NAME = 'better-auth.session_token';
const CACHE_KEY_PREFIX = 'better-auth-workers:session:';
// Cloudflare KV rejects expirationTtl values below 60 seconds.
const KV_MIN_TTL_SECONDS = 60;
// Service bindings ignore the host; it only needs to be a valid absolute URL.
const SERVICE_BINDING_ORIGIN = 'https://auth.internal';

function readCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name && key !== `__Secure-${name}`) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
}

// Better Auth signs cookies as `<token>.<signature>`; the session is keyed by the bare token.
function sessionTokenFromCookie(request: Request, cookieName: string): string | undefined {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return;
  const signed = readCookie(cookieHeader, cookieName);
  if (!signed) return;
  const [token] = signed.split('.', 1);
  return token || undefined;
}

function remainingTtlSeconds(expiresAt: string): number {
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) return 0;
  return Math.floor((expiresMs - Date.now()) / 1000);
}

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(field: JsonValue | undefined): string | undefined {
  return typeof field === 'string' ? field : undefined;
}

function toSessionRecord(value: JsonValue | undefined): SessionRecord | null {
  if (!isObject(value)) return null;
  const id = asString(value.id);
  const token = asString(value.token);
  const userId = asString(value.userId);
  const expiresAt = asString(value.expiresAt);
  if (!id || !token || !userId || !expiresAt) return null;
  return { ...value, id, token, userId, expiresAt };
}

function toSessionUser(value: JsonValue | undefined): SessionUser | null {
  if (!isObject(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  return { ...value, id };
}

function toSessionData(value: JsonValue | undefined): SessionData | null {
  if (!isObject(value)) return null;
  const session = toSessionRecord(value.session);
  const user = toSessionUser(value.user);
  if (!session || !user) return null;
  return { session, user };
}

async function readCachedSession(kv: KVStore, key: string): Promise<SessionData | null> {
  try {
    const cached = await kv.get(key);
    if (!cached) return null;
    const parsed = toSessionData(JSON.parse(cached) as JsonValue);
    if (!parsed || remainingTtlSeconds(parsed.session.expiresAt) <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function fetchSession(
  options: SessionClientOptions,
  request: Request
): Promise<SessionData | null> {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const url = `${SERVICE_BINDING_ORIGIN}${basePath.replace(/\/$/, '')}/get-session`;
  const headers = new Headers({ accept: 'application/json' });
  const cookie = request.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);

  try {
    const response = await options.auth.fetch(new Request(url, { headers }));
    if (!response.ok) return null;
    return toSessionData((await response.json()) as JsonValue);
  } catch {
    return null;
  }
}

export function createSessionClient(options: SessionClientOptions): SessionClient {
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;

  return {
    get: async (request) => {
      const token = sessionTokenFromCookie(request, cookieName);
      if (!token) return null;

      const cacheKey = `${CACHE_KEY_PREFIX}${token}`;
      const cached = await readCachedSession(options.kv, cacheKey);
      if (cached) return cached;

      const session = await fetchSession(options, request);
      if (!session) return null;

      const ttl = remainingTtlSeconds(session.session.expiresAt);
      if (ttl <= 0) return null;
      if (ttl >= KV_MIN_TTL_SECONDS) {
        try {
          await options.kv.put(cacheKey, JSON.stringify(session), { expirationTtl: ttl });
        } catch {
          // A cache write failure must not break session verification.
        }
      }
      return session;
    },
  };
}

export function requireSession(): SessionHandler {
  return noopSessionHandler;
}
