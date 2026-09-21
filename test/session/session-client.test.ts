import { describe, expect, it, mock } from 'bun:test';

import {
  createSessionClient,
  type SessionClient,
  type SessionClientOptions,
  SessionUnavailableError,
} from '../../src/client';
import { sessionCacheKey } from '../../src/shared/session-cache';
import { FakeKV } from '../helpers/auth';

// The real exported types, so a breaking change to createSessionClient's
// signature turns this file red at compile time.
const buildSessionClient = (options: SessionClientOptions): SessionClient =>
  createSessionClient(options);

const BASE_PATH = '/auth';
const TOKEN = 'sess_abc123';
const SIGNED_TOKEN = `${TOKEN}.c2lnbmF0dXJl`;
const VALID_COOKIE = `better-auth.session_token=${encodeURIComponent(SIGNED_TOKEN)}`;
const INVALID_COOKIE = 'better-auth.session_token=nope.invalid';
// The genuine token with a signature the auth Worker never produced.
const FORGED_SIGNED_TOKEN = `${TOKEN}.Zm9yZ2Vk`;
const FORGED_COOKIE = `better-auth.session_token=${encodeURIComponent(FORGED_SIGNED_TOKEN)}`;

function makeSessionRequest(): Request {
  return new Request('https://api.example.com/me', { headers: { cookie: VALID_COOKIE } });
}

function makeBearerRequest(): Request {
  return new Request('https://api.example.com/me', {
    headers: { authorization: `Bearer ${SIGNED_TOKEN}` },
  });
}

function sessionPayload(expiresAt: Date) {
  return {
    session: {
      id: 'session-id-1',
      token: TOKEN,
      userId: 'user-1',
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    },
    user: {
      id: 'user-1',
      email: 'alice@example.com',
      name: 'Alice',
    },
  };
}

async function caught(client: SessionClient): Promise<unknown> {
  try {
    await client.get(makeSessionRequest());
  } catch (error) {
    return error;
  }
}

function toRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  if (input instanceof Request) return new Request(input, init);
  return new Request(String(input), init);
}

// A fake auth Worker service binding that only knows one valid session cookie
function fakeAuthBinding(expiresAt: Date) {
  const seen: Request[] = [];
  const fetch = mock((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = toRequest(input, init);
    seen.push(req);
    const url = new URL(req.url);
    if (!url.pathname.endsWith(`${BASE_PATH}/get-session`)) {
      return Promise.resolve(new Response('Not found', { status: 404 }));
    }
    const cookie = req.headers.get('cookie') ?? '';
    const authorization = req.headers.get('authorization') ?? '';
    if (
      cookie.includes(encodeURIComponent(SIGNED_TOKEN)) ||
      cookie.includes(SIGNED_TOKEN) ||
      authorization === `Bearer ${SIGNED_TOKEN}`
    ) {
      return Promise.resolve(Response.json(sessionPayload(expiresAt)));
    }
    // Better Auth's get-session returns a JSON null for a missing or invalid session
    return Promise.resolve(Response.json(null));
  });
  return { binding: { fetch }, fetch, seen };
}

describe('createSessionClient verifies sessions over a service binding with a KV cache', () => {
  describe('get(request) with a valid session cookie', () => {
    it('forwards only the session-token cookie to get-session, bypassing Better Auth’s cookie cache', async () => {
      const expiresAt = new Date(Date.now() + 3_600_000);
      const { binding, fetch, seen } = fakeAuthBinding(expiresAt);
      const kv = new FakeKV();
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });

      // A browser's full jar: Better Auth's own cookie-cache cookie rides
      // alongside the session token. It must not reach the auth Worker,
      // whose cookie cache would answer for a session it has since revoked.
      const incoming = new Request('https://api.example.com/me', {
        headers: { cookie: `other=1; ${VALID_COOKIE}; better-auth.session_data=stale.signed.blob` },
      });
      const result = await client.get(incoming);

      expect(fetch).toHaveBeenCalledTimes(1);
      const forwarded = seen[0];
      const url = new URL(forwarded.url);
      expect(url.pathname).toBe(`${BASE_PATH}/get-session`);
      expect(url.searchParams.get('disableCookieCache')).toBe('true');
      expect(forwarded.method).toBe('GET');
      expect(forwarded.headers.get('cookie')).toBe(VALID_COOKIE);

      expect(result).not.toBeNull();
      expect(result!.session.token).toBe(TOKEN);
      expect(result!.user.id).toBe('user-1');
    });

    it('accepts any plain Request without a framework wrapper', async () => {
      const { binding } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const client = buildSessionClient({ auth: binding, kv: new FakeKV(), basePath: BASE_PATH });

      const result = await client.get(
        new Request('https://anything.example.com/some/path?x=1', {
          method: 'POST',
          headers: { cookie: VALID_COOKIE },
        })
      );

      expect(result?.user.email).toBe('alice@example.com');
    });
  });

  describe('get(request) with an Authorization: Bearer header', () => {
    it('forwards the Authorization header to the auth Worker get-session route and returns the same session a cookie would', async () => {
      const expiresAt = new Date(Date.now() + 3_600_000);
      const { binding, fetch, seen } = fakeAuthBinding(expiresAt);
      const kv = new FakeKV();
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });

      const result = await client.get(makeBearerRequest());

      expect(fetch).toHaveBeenCalledTimes(1);
      const forwarded = seen[0];
      expect(forwarded.headers.get('authorization')).toBe(`Bearer ${SIGNED_TOKEN}`);

      expect(result).not.toBeNull();
      expect(result!.session.token).toBe(TOKEN);
      expect(result!.user.id).toBe('user-1');
    });

    it('resolves the same session a cookie-carrying request would', async () => {
      const expiresAt = new Date(Date.now() + 3_600_000);
      const kv = new FakeKV();
      const cookieClient = buildSessionClient({
        auth: fakeAuthBinding(expiresAt).binding,
        kv,
        basePath: BASE_PATH,
      });
      const bearerClient = buildSessionClient({
        auth: fakeAuthBinding(expiresAt).binding,
        kv,
        basePath: BASE_PATH,
      });

      const cookieResult = await cookieClient.get(makeSessionRequest());
      const bearerResult = await bearerClient.get(makeBearerRequest());

      expect(cookieResult).not.toBeNull();
      expect(bearerResult).not.toBeNull();
      expect(bearerResult!.session.token).toBe(cookieResult!.session.token);
      expect(bearerResult!.user.id).toBe(cookieResult!.user.id);
    });

    it('serves a second get(request) for the same bearer token from KV without calling the service binding again', async () => {
      const { binding, fetch } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const kv = new FakeKV();
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });

      const first = await client.get(makeBearerRequest());
      const second = await client.get(makeBearerRequest());

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(second).not.toBeNull();
      expect(second!.session.token).toBe(first!.session.token);
      expect(second!.user.id).toBe(first!.user.id);
    });

    it('returns null without throwing when the request carries no cookie or bearer token', async () => {
      const { binding } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const client = buildSessionClient({ auth: binding, kv: new FakeKV(), basePath: BASE_PATH });

      const result = await client.get(new Request('https://api.example.com/me'));

      expect(result).toBeNull();
    });

    it('returns null without throwing when the bearer token does not match a session', async () => {
      const { binding, fetch } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const kv = new FakeKV();
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });

      const result = await client.get(
        new Request('https://api.example.com/me', {
          headers: { authorization: 'Bearer nope.not-a-real-token' },
        })
      );

      expect(result).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(kv.store.size).toBe(0);
    });
  });

  describe('KV cache', () => {
    it('serves a second get(request) for the same session token from KV without calling the service binding again', async () => {
      const { binding, fetch } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const kv = new FakeKV();
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });
      const first = await client.get(makeSessionRequest());
      const second = await client.get(makeSessionRequest());

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(second).not.toBeNull();
      expect(second!.session.token).toBe(first!.session.token);
      expect(second!.user.id).toBe(first!.user.id);
    });

    it('stores the session in KV keyed by the session token with a TTL equal to the remaining session lifetime', async () => {
      const remainingSeconds = 1800;
      const expiresAt = new Date(Date.now() + remainingSeconds * 1000);
      const { binding } = fakeAuthBinding(expiresAt);
      const kv = new FakeKV();
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });

      await client.get(
        new Request('https://api.example.com/me', { headers: { cookie: VALID_COOKIE } })
      );

      expect(kv.puts).toHaveLength(1);
      const put = kv.puts[0];
      expect(put.key).toContain(TOKEN);
      const ttl = put.options?.expirationTtl;
      expect(typeof ttl).toBe('number');
      expect(ttl!).toBeGreaterThanOrEqual(remainingSeconds - 5);
      expect(ttl!).toBeLessThanOrEqual(remainingSeconds);
    });

    it('lets a second client sharing the same KV namespace resolve the session without touching its service binding', async () => {
      const expiresAt = new Date(Date.now() + 3_600_000);
      const kv = new FakeKV();
      const primary = fakeAuthBinding(expiresAt);
      const consumer = fakeAuthBinding(expiresAt);
      await buildSessionClient({ auth: primary.binding, kv, basePath: BASE_PATH }).get(
        makeSessionRequest()
      );
      const result = await buildSessionClient({
        auth: consumer.binding,
        kv,
        basePath: BASE_PATH,
      }).get(makeSessionRequest());

      expect(primary.fetch).toHaveBeenCalledTimes(1);
      expect(consumer.fetch).toHaveBeenCalledTimes(0);
      expect(result?.session.token).toBe(TOKEN);
    });
  });

  describe('bearer credential forms', () => {
    // A client may echo the cookie value into the Authorization header
    // verbatim, URL-encoded (the base64 signature ends in `=`). Whatever
    // form it sends, the entry sits under the bare token — the one key the
    // auth Worker's revocation clears — with the decoded credential stored.
    it('caches an encoded signed bearer token under the bare-token key revocation clears', async () => {
      const signedValue = `${TOKEN}.c2lnbmF0dXJl=`;
      const encodedHeader = `Bearer ${encodeURIComponent(signedValue)}`;
      const payload = sessionPayload(new Date(Date.now() + 3_600_000));
      const answer = (input: RequestInfo | URL) =>
        toRequest(input).headers.get('authorization') === encodedHeader
          ? Response.json(payload)
          : Response.json(null);
      const binding = { fetch: mock((input: RequestInfo | URL) => Promise.resolve(answer(input))) };
      const kv = new FakeKV();
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });
      const request = () =>
        new Request('https://api.example.com/me', { headers: { authorization: encodedHeader } });

      const result = await client.get(request());
      expect(result?.session.token).toBe(TOKEN);
      expect(kv.store.keys().toArray()).toEqual([sessionCacheKey(TOKEN)]);
      const entry = JSON.parse(kv.store.get(sessionCacheKey(TOKEN)) ?? '{}') as {
        credentials: string[];
      };
      expect(entry.credentials).toEqual([signedValue]);

      // Served from the entry on the next request.
      await client.get(request());
      expect(binding.fetch).toHaveBeenCalledTimes(1);

      // The auth Worker revokes the session by deleting the bare-token key.
      await kv.delete(sessionCacheKey(TOKEN));

      await client.get(request());
      expect(binding.fetch).toHaveBeenCalledTimes(2);
    });

    // Both forms carry the same signed value, so one session is one entry
    // under the bare-token key, whichever header the request used.
    it('keeps the cookie and bearer forms of one session in a single entry', async () => {
      const { binding, fetch } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const kv = new FakeKV();
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });

      await client.get(makeSessionRequest());
      await client.get(makeBearerRequest());
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(kv.store.keys().toArray()).toEqual([sessionCacheKey(TOKEN)]);
      const entry = JSON.parse(kv.store.get(sessionCacheKey(TOKEN)) ?? '{}') as {
        credentials: string[];
      };
      expect(entry.credentials).toEqual([SIGNED_TOKEN]);

      await client.get(makeSessionRequest());
      await client.get(makeBearerRequest());
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    // The auth Worker refuses a bare token (the bearer plugin runs with
    // `requireSignature`), so the session client must not let one in either
    // — not even past the cache, which is never consulted for it.
    it('ignores a bare bearer token even when an entry already records that exact string', async () => {
      const expiresAt = new Date(Date.now() + 3_600_000);
      const { binding, fetch } = fakeAuthBinding(expiresAt);
      const kv = new FakeKV();
      // An entry under this session that has the bare token recorded as a
      // verified credential, as one written before signatures were required.
      const stale = { credentials: [TOKEN], session: sessionPayload(expiresAt) };
      kv.store.set(sessionCacheKey(TOKEN), JSON.stringify(stale));
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });

      const result = await client.get(
        new Request('https://api.example.com/me', {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      );

      expect(result).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(0);
    });
  });

  describe('only the credential being verified is forwarded', () => {
    it('does not let a valid bearer token vouch for a forged cookie on the same request', async () => {
      const { binding, fetch, seen } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const kv = new FakeKV();
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });

      // The cookie is the credential (cookies win); the bearer token would
      // be accepted by the auth Worker, but must not be sent alongside it.
      const result = await client.get(
        new Request('https://api.example.com/me', {
          headers: { cookie: FORGED_COOKIE, authorization: `Bearer ${SIGNED_TOKEN}` },
        })
      );

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(seen[0].headers.get('authorization')).toBeNull();
      expect(seen[0].headers.get('cookie')).toBe(FORGED_COOKIE);
      expect(result).toBeNull();
      expect(kv.store.size).toBe(0);
    });

    it('forwards only the Authorization header for a bearer credential', async () => {
      const { binding, seen } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const client = buildSessionClient({ auth: binding, kv: new FakeKV(), basePath: BASE_PATH });

      await client.get(
        new Request('https://api.example.com/me', {
          headers: { authorization: `Bearer ${SIGNED_TOKEN}`, cookie: 'unrelated=1' },
        })
      );

      expect(seen[0].headers.get('authorization')).toBe(`Bearer ${SIGNED_TOKEN}`);
      expect(seen[0].headers.get('cookie')).toBeNull();
    });

    it('drops recorded credentials when the entry turns out to hold a different session', async () => {
      const kv = new FakeKV();
      const cacheKey = sessionCacheKey(TOKEN);
      const other = sessionPayload(new Date(Date.now() + 3_600_000));
      // An entry under this token that describes some other session, with a
      // credential recorded against it.
      kv.store.set(
        cacheKey,
        JSON.stringify({
          credentials: ['stale-credential'],
          session: { ...other, session: { ...other.session, token: 'some-other-token' } },
        })
      );
      const { binding } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });

      await client.get(makeSessionRequest());

      const entry = JSON.parse(kv.store.get(cacheKey) ?? '{}') as { credentials: string[] };
      expect(entry.credentials).toEqual([SIGNED_TOKEN]);
    });
  });

  describe('client IP forwarding', () => {
    it('forwards cf-connecting-ip as x-forwarded-for so the auth Worker rate-limits per client', async () => {
      const { binding, seen } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const client = buildSessionClient({ auth: binding, kv: new FakeKV(), basePath: BASE_PATH });

      await client.get(
        new Request('https://api.example.com/me', {
          headers: { cookie: VALID_COOKIE, 'cf-connecting-ip': '203.0.113.7' },
        })
      );

      expect(seen[0].headers.get('x-forwarded-for')).toBe('203.0.113.7');
    });

    it('falls back to the incoming x-forwarded-for and sends nothing when neither is present', async () => {
      const expiresAt = new Date(Date.now() + 3_600_000);
      const withForwardedFor = fakeAuthBinding(expiresAt);
      const withoutAny = fakeAuthBinding(expiresAt);
      // Separate caches: both requests must reach their auth Worker, and the
      // two carry the same signed credential.
      await buildSessionClient({
        auth: withForwardedFor.binding,
        kv: new FakeKV(),
        basePath: BASE_PATH,
      }).get(
        new Request('https://api.example.com/me', {
          headers: { cookie: VALID_COOKIE, 'x-forwarded-for': '198.51.100.9' },
        })
      );
      await buildSessionClient({
        auth: withoutAny.binding,
        kv: new FakeKV(),
        basePath: BASE_PATH,
      }).get(
        new Request('https://api.example.com/me', {
          headers: { authorization: `Bearer ${SIGNED_TOKEN}` },
        })
      );

      expect(withForwardedFor.seen[0].headers.get('x-forwarded-for')).toBe('198.51.100.9');
      expect(withoutAny.seen[0].headers.get('x-forwarded-for')).toBeNull();
    });
  });

  describe('auth Worker unavailable', () => {
    it('throws SessionUnavailableError when the service binding throws', async () => {
      const binding = { fetch: () => Promise.reject(new Error('service binding not connected')) };
      const client = buildSessionClient({ auth: binding, kv: new FakeKV(), basePath: BASE_PATH });

      expect(await caught(client)).toBeInstanceOf(SessionUnavailableError);
    });

    it('throws SessionUnavailableError on a 5xx from the auth Worker, carrying the status', async () => {
      const binding = { fetch: () => Promise.resolve(new Response('boom', { status: 502 })) };
      const client = buildSessionClient({ auth: binding, kv: new FakeKV(), basePath: BASE_PATH });

      const thrown = await caught(client);
      expect(thrown).toBeInstanceOf(SessionUnavailableError);
      expect((thrown as SessionUnavailableError).status).toBe(502);
    });

    it('throws SessionUnavailableError on a 429, since a throttled miss is not "not signed in"', async () => {
      const binding = { fetch: () => Promise.resolve(new Response('slow down', { status: 429 })) };
      const client = buildSessionClient({ auth: binding, kv: new FakeKV(), basePath: BASE_PATH });

      const thrown = await caught(client);
      expect(thrown).toBeInstanceOf(SessionUnavailableError);
      expect((thrown as SessionUnavailableError).status).toBe(429);
    });

    it('returns null for a 401 or 403, the genuine negative answers', async () => {
      for (const status of [401, 403]) {
        const binding = { fetch: () => Promise.resolve(new Response('no', { status })) };
        const client = buildSessionClient({ auth: binding, kv: new FakeKV(), basePath: BASE_PATH });

        expect(await client.get(makeSessionRequest())).toBeNull();
      }
    });

    it('throws SessionUnavailableError on any other non-2xx (a 404 from a wrong basePath, a 400), so a misconfiguration is loud rather than "not signed in"', async () => {
      for (const status of [400, 404, 405]) {
        const binding = { fetch: () => Promise.resolve(new Response('no', { status })) };
        const client = buildSessionClient({ auth: binding, kv: new FakeKV(), basePath: BASE_PATH });

        const thrown = await caught(client);
        expect(thrown).toBeInstanceOf(SessionUnavailableError);
        expect((thrown as SessionUnavailableError).status).toBe(status);
      }
    });
  });

  describe('cookie signatures', () => {
    it('does not serve a cookie with a forged signature from the entry a genuine request warmed', async () => {
      const { binding, fetch } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const kv = new FakeKV();
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });

      const genuine = await client.get(makeSessionRequest());
      expect(genuine?.session.token).toBe(TOKEN);
      expect(kv.store.size).toBe(1);

      const forged = await client.get(
        new Request('https://api.example.com/me', { headers: { cookie: FORGED_COOKIE } })
      );

      // The forged cookie missed the cache and was refused by the auth Worker.
      expect(forged).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(kv.store.size).toBe(1);
    });

    it('ignores a cookie that carries a bare token without a signature', async () => {
      const { binding, fetch } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const client = buildSessionClient({ auth: binding, kv: new FakeKV(), basePath: BASE_PATH });

      const result = await client.get(
        new Request('https://api.example.com/me', {
          headers: { cookie: `better-auth.session_token=${TOKEN}` },
        })
      );

      expect(result).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(0);
    });
  });

  describe('missing or invalid sessions', () => {
    it('returns null without throwing when the request carries no cookie', async () => {
      const { binding } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const client = buildSessionClient({ auth: binding, kv: new FakeKV(), basePath: BASE_PATH });

      const result = await client.get(new Request('https://api.example.com/me'));

      expect(result).toBeNull();
    });

    it('returns null without throwing when the cookie does not match a session', async () => {
      const { binding, fetch } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const kv = new FakeKV();
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });

      const result = await client.get(
        new Request('https://api.example.com/me', { headers: { cookie: INVALID_COOKIE } })
      );

      expect(result).toBeNull();
      // The auth Worker was consulted and said no; nothing valid was cached
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(kv.store.size).toBe(0);
    });

    it('returns null when the auth Worker rejects the session with a non-2xx status', async () => {
      const fetch = mock(() => Promise.resolve(new Response('Unauthorized', { status: 401 })));
      const client = buildSessionClient({ auth: { fetch }, kv: new FakeKV(), basePath: BASE_PATH });

      const result = await client.get(
        new Request('https://api.example.com/me', { headers: { cookie: VALID_COOKIE } })
      );

      expect(result).toBeNull();
    });
  });
});
