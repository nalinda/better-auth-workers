import { describe, expect, it, mock } from 'bun:test';

import {
  createSessionClient,
  type SessionClient,
  type SessionClientOptions,
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
    headers: { authorization: `Bearer ${TOKEN}` },
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
      authorization === `Bearer ${TOKEN}`
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
      expect(forwarded.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);

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
          headers: { authorization: 'Bearer nope-not-a-real-token' },
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

    it('keeps the cookie and bearer forms of one session in a single entry', async () => {
      const { binding, fetch } = fakeAuthBinding(new Date(Date.now() + 3_600_000));
      const kv = new FakeKV();
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });

      await client.get(makeSessionRequest());
      await client.get(makeBearerRequest());
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(kv.store.size).toBe(1);

      await client.get(makeSessionRequest());
      await client.get(makeBearerRequest());
      expect(fetch).toHaveBeenCalledTimes(2);
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
