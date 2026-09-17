import {
  DEFAULT_COOKIE_NAME,
  sessionCredentialFromAuthorizationHeader,
  sessionCredentialFromCookie,
} from '../shared/credentials';
import {
  KV_MIN_TTL_SECONDS,
  MAX_CACHED_CREDENTIALS,
  sessionCacheKey,
  sessionTokenOf,
} from '../shared/session-cache';
import type { JsonValue, KVStore } from '../types';
import { remainingTtlSeconds, toCachedEntry, toSessionData } from './parse';
import type { CachedSessionEntry, SessionClient, SessionClientOptions, SessionData } from './types';

const DEFAULT_BASE_PATH = '/api/auth';
// Service bindings ignore the host; it only needs to be a valid absolute URL.
const SERVICE_BINDING_ORIGIN = 'https://auth.internal';

async function readCachedEntry(kv: KVStore, key: string): Promise<CachedSessionEntry | null> {
  try {
    const cached = await kv.get(key);
    if (!cached) return null;
    const entry = toCachedEntry(JSON.parse(cached) as JsonValue);
    if (!entry || remainingTtlSeconds(entry.session.session.expiresAt) <= 0) return null;
    return entry;
  } catch {
    return null;
  }
}

// Only a credential the auth Worker has verified before is served from the
// entry; any other form of the same token (a forged signature) misses.
function cachedSessionFor(
  entry: CachedSessionEntry | null,
  credential: string
): SessionData | null {
  if (!entry || !entry.credentials.includes(credential)) return null;
  return entry.session;
}

function entryWith(
  existing: CachedSessionEntry | null,
  credential: string,
  session: SessionData
): CachedSessionEntry {
  const others = (existing?.credentials ?? []).filter((known) => known !== credential);
  return { credentials: [...others, credential].slice(-MAX_CACHED_CREDENTIALS), session };
}

async function fetchSession(
  options: SessionClientOptions,
  request: Request
): Promise<SessionData | null> {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const url = `${SERVICE_BINDING_ORIGIN}${basePath.replace(/\/$/, '')}/get-session`;
  const headers = new Headers({ accept: 'application/json' });
  const authorization = request.headers.get('authorization');
  const cookie = request.headers.get('cookie');
  if (authorization) headers.set('authorization', authorization);
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
      const credential =
        sessionCredentialFromCookie(request, cookieName) ??
        sessionCredentialFromAuthorizationHeader(request);
      if (!credential) return null;

      const cacheKey = sessionCacheKey(sessionTokenOf(credential));
      const entry = await readCachedEntry(options.kv, cacheKey);
      const cached = cachedSessionFor(entry, credential);
      if (cached) return cached;

      const session = await fetchSession(options, request);
      if (!session) return null;

      const ttl = remainingTtlSeconds(session.session.expiresAt);
      if (ttl <= 0) return null;
      if (ttl >= KV_MIN_TTL_SECONDS) {
        try {
          await options.kv.put(cacheKey, JSON.stringify(entryWith(entry, credential, session)), {
            expirationTtl: ttl,
          });
        } catch {
          // A cache write failure must not break session verification.
        }
      }
      return session;
    },
  };
}
