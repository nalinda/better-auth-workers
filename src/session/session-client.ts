import {
  DEFAULT_COOKIE_NAME,
  sessionCookiePairFrom,
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
import {
  type CachedSessionEntry,
  type SessionClient,
  type SessionClientOptions,
  type SessionData,
  SessionUnavailableError,
} from './types';

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

// Credentials already recorded are only kept when the entry still describes
// the same session; an entry that turns out to hold a different session's
// data (the token was reused, or the entry was tampered with) starts over
// with just the credential verified now.
function entryWith(
  existing: CachedSessionEntry | null,
  credential: string,
  session: SessionData
): CachedSessionEntry {
  const isSameSession = existing?.session.session.token === session.session.token;
  const others = isSameSession ? existing.credentials.filter((known) => known !== credential) : [];
  return { credentials: [...others, credential].slice(-MAX_CACHED_CREDENTIALS), session };
}

// Which header the credential came from. Exactly that one is forwarded to
// the auth Worker, so the answer verifies the credential that gets recorded
// — never a different one that happened to ride along on the same request.
type Credential = { value: string; source: 'cookie' | 'bearer' };

function credentialFrom(request: Request, cookieName: string): Credential | undefined {
  const cookie = sessionCredentialFromCookie(request, cookieName);
  if (cookie) return { value: cookie, source: 'cookie' };
  const bearer = sessionCredentialFromAuthorizationHeader(request);
  return bearer ? { value: bearer, source: 'bearer' } : undefined;
}

// A cache miss is answered by the auth Worker's store, never by Better
// Auth's own cookie cache: only the session-token cookie is forwarded (not
// `session_data`), and `disableCookieCache` is set for good measure. The
// consumer's KV cache already provides the fast path, and Better Auth's
// cookie cache would keep answering for a session the auth Worker has just
// revoked — an answer that would then be cached here for days.
async function fetchSession(
  options: SessionClientOptions,
  request: Request,
  cookieName: string,
  credential: Credential
): Promise<SessionData | null> {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const url = `${SERVICE_BINDING_ORIGIN}${basePath.replace(/\/$/, '')}/get-session?disableCookieCache=true`;
  const headers = new Headers({ accept: 'application/json' });
  if (credential.source === 'cookie') {
    const sessionCookie = sessionCookiePairFrom(request, cookieName);
    if (sessionCookie) headers.set('cookie', sessionCookie);
  } else {
    const authorization = request.headers.get('authorization');
    if (authorization) headers.set('authorization', authorization);
  }

  let response: Response;
  try {
    response = await options.auth.fetch(new Request(url, { headers }));
  } catch (error) {
    throw new SessionUnavailableError(
      `auth Worker unreachable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  // A 5xx is the auth Worker failing to answer; anything else non-2xx (a
  // 401 for a rejected credential, say) is a negative answer.
  if (response.status >= 500) {
    throw new SessionUnavailableError(
      `auth Worker answered ${String(response.status)}`,
      response.status
    );
  }
  if (!response.ok) return null;
  try {
    const payload: JsonValue = await response.json();
    return toSessionData(payload);
  } catch {
    return null;
  }
}

export function createSessionClient(options: SessionClientOptions): SessionClient {
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;

  return {
    get: async (request) => {
      const credential = credentialFrom(request, cookieName);
      if (!credential) return null;

      const cacheKey = sessionCacheKey(sessionTokenOf(credential.value));
      const entry = await readCachedEntry(options.kv, cacheKey);
      const cached = cachedSessionFor(entry, credential.value);
      if (cached) return cached;

      const session = await fetchSession(options, request, cookieName, credential);
      if (!session) return null;

      const ttl = remainingTtlSeconds(session.session.expiresAt);
      if (ttl <= 0) return null;
      if (ttl >= KV_MIN_TTL_SECONDS) {
        try {
          await options.kv.put(
            cacheKey,
            JSON.stringify(entryWith(entry, credential.value, session)),
            {
              expirationTtl: ttl,
            }
          );
        } catch {
          // A cache write failure must not break session verification.
        }
      }
      return session;
    },
  };
}
