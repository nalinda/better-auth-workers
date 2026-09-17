import { describe, expect, it, mock } from 'bun:test';
import { createSessionClient } from '../src/client';

interface SessionClientOptions {
  auth: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  kv: FakeKV;
  basePath?: string;
}

// Typed wrapper so the test compiles against the current stub signature and the final one alike
const buildSessionClient = (
  options: SessionClientOptions
): { get: (req: Request) => Promise<any> } =>
  (
    createSessionClient as unknown as (o: SessionClientOptions) => {
      get: (req: Request) => Promise<any>;
    }
  )(options);

class FakeKV {
  readonly store = new Map<string, string>();
  readonly puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }

  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
    this.puts.push({ key, value, options });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
}

const BASE_PATH = '/auth';
const TOKEN = 'sess_abc123';
const SIGNED_TOKEN = `${TOKEN}.c2lnbmF0dXJl`;
const VALID_COOKIE = `better-auth.session_token=${encodeURIComponent(SIGNED_TOKEN)}`;
const INVALID_COOKIE = 'better-auth.session_token=nope.invalid';

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
    if (cookie.includes(encodeURIComponent(SIGNED_TOKEN)) || cookie.includes(SIGNED_TOKEN)) {
      return Promise.resolve(Response.json(sessionPayload(expiresAt)));
    }
    // Better Auth's get-session returns a JSON null for a missing or invalid session
    return Promise.resolve(Response.json(null));
  });
  return { binding: { fetch }, fetch, seen };
}

describe('Issue #9: createSessionClient verifies sessions over a service binding with a KV cache', () => {
  describe('get(request) with a valid session cookie', () => {
    it('forwards the Cookie header to the auth Worker get-session route over the service binding and returns the session', async () => {
      const expiresAt = new Date(Date.now() + 3600_000);
      const { binding, fetch, seen } = fakeAuthBinding(expiresAt);
      const kv = new FakeKV();
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });

      const incoming = new Request('https://api.example.com/me', {
        headers: { cookie: VALID_COOKIE },
      });
      const result = await client.get(incoming);

      expect(fetch).toHaveBeenCalledTimes(1);
      const forwarded = seen[0]!;
      expect(new URL(forwarded.url).pathname).toBe(`${BASE_PATH}/get-session`);
      expect(forwarded.method).toBe('GET');
      expect(forwarded.headers.get('cookie')).toBe(VALID_COOKIE);

      expect(result).not.toBeNull();
      expect(result.session.token).toBe(TOKEN);
      expect(result.user.id).toBe('user-1');
    });

    it('accepts any plain Request without a framework wrapper', async () => {
      const { binding } = fakeAuthBinding(new Date(Date.now() + 3600_000));
      const client = buildSessionClient({ auth: binding, kv: new FakeKV(), basePath: BASE_PATH });

      const result = await client.get(
        new Request('https://anything.example.com/some/path?x=1', {
          method: 'POST',
          headers: { cookie: VALID_COOKIE },
        })
      );

      expect(result?.user?.email).toBe('alice@example.com');
    });
  });

  describe('KV cache', () => {
    it('serves a second get(request) for the same session token from KV without calling the service binding again', async () => {
      const { binding, fetch } = fakeAuthBinding(new Date(Date.now() + 3600_000));
      const kv = new FakeKV();
      const client = buildSessionClient({ auth: binding, kv, basePath: BASE_PATH });
      const makeRequest = () =>
        new Request('https://api.example.com/me', { headers: { cookie: VALID_COOKIE } });

      const first = await client.get(makeRequest());
      const second = await client.get(makeRequest());

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(second).not.toBeNull();
      expect(second.session.token).toBe(first.session.token);
      expect(second.user.id).toBe(first.user.id);
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

      expect(kv.puts.length).toBe(1);
      const put = kv.puts[0]!;
      expect(put.key).toContain(TOKEN);
      const ttl = put.options?.expirationTtl;
      expect(typeof ttl).toBe('number');
      expect(ttl!).toBeGreaterThanOrEqual(remainingSeconds - 5);
      expect(ttl!).toBeLessThanOrEqual(remainingSeconds);
    });

    it('lets a second client sharing the same KV namespace resolve the session without touching its service binding', async () => {
      const expiresAt = new Date(Date.now() + 3600_000);
      const kv = new FakeKV();
      const primary = fakeAuthBinding(expiresAt);
      const consumer = fakeAuthBinding(expiresAt);
      const makeRequest = () =>
        new Request('https://api.example.com/me', { headers: { cookie: VALID_COOKIE } });

      await buildSessionClient({ auth: primary.binding, kv, basePath: BASE_PATH }).get(
        makeRequest()
      );
      const result = await buildSessionClient({
        auth: consumer.binding,
        kv,
        basePath: BASE_PATH,
      }).get(makeRequest());

      expect(primary.fetch).toHaveBeenCalledTimes(1);
      expect(consumer.fetch).toHaveBeenCalledTimes(0);
      expect(result?.session?.token).toBe(TOKEN);
    });
  });

  describe('missing or invalid sessions', () => {
    it('returns null without throwing when the request carries no cookie', async () => {
      const { binding } = fakeAuthBinding(new Date(Date.now() + 3600_000));
      const client = buildSessionClient({ auth: binding, kv: new FakeKV(), basePath: BASE_PATH });

      const result = await client.get(new Request('https://api.example.com/me'));

      expect(result).toBeNull();
    });

    it('returns null without throwing when the cookie does not match a session', async () => {
      const { binding, fetch } = fakeAuthBinding(new Date(Date.now() + 3600_000));
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
