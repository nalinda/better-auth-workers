import { DEFAULT_COOKIE_NAME, sessionTokenFromCookie } from '../shared/credentials';
import { KV_MIN_TTL_SECONDS, sessionCacheKey } from '../shared/session-cache';
import type { JsonValue, KVStore } from '../types';
import { remainingTtlSeconds, toSessionData } from './parse';
import type { SessionClient, SessionClientOptions, SessionData } from './types';

const DEFAULT_BASE_PATH = '/api/auth';
// Service bindings ignore the host; it only needs to be a valid absolute URL.
const SERVICE_BINDING_ORIGIN = 'https://auth.internal';

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

      const cacheKey = sessionCacheKey(token);
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
