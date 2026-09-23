import { describe, expect, it } from 'bun:test';

import { createAuth } from '../../src/index';
import { sessionCacheKey, sessionTokenOf } from '../../src/shared/session-cache';
import { buildEnv, FakeKV, postJSON } from '../helpers/auth';
import { migratedSqlite } from '../helpers/sqlite';

// A signed-in user's own changes must not leave either cached copy of their
// session behind: the cookie cache (read by get-session) and the session
// client's KV entry (read by requireSession in other Workers). The consumer
// gates on `phoneNumberVerified`, which a stale copy would keep refusing.

const ORIGIN = 'https://auth.example.com';
const API = `${ORIGIN}/api/auth`;
const FIRST = '+15550000001';
const SECOND = '+15550000002';

function setup(kv: FakeKV = new FakeKV()) {
  const codes: string[] = [];
  const auth = createAuth(buildEnv({ DB: undefined, AUTH_KV: kv.asBinding() }), {
    phone: {
      awaitDelivery: true,
      sendOTP: ({ code }) => {
        codes.push(code);
      },
    },
    betterAuth: { database: migratedSqlite() },
  });
  return { auth, kv, codes };
}

type Setup = ReturnType<typeof setup>;

function cookiePairs(response: Response): Map<string, string> {
  return new Map(
    response.headers.getSetCookie().map((cookie) => {
      const [pair = ''] = cookie.split(';', 1);
      const separator = pair.indexOf('=');
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    })
  );
}

function cookieHeader(cookies: Map<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function signIn({ auth, codes }: Setup, phoneNumber: string): Promise<Map<string, string>> {
  await auth.handler(postJSON(`${API}/phone-number/send-otp`, { phoneNumber }));
  const res = await auth.handler(
    postJSON(`${API}/phone-number/verify`, { phoneNumber, code: codes.at(-1) ?? '' })
  );
  expect(res.status).toBe(200);
  return cookiePairs(res);
}

// Seeds the session client's cache entry for the signed-in session, as the
// API Worker's first `requireSession` would.
function seedClientCache({ kv }: Setup, cookies: Map<string, string>): string {
  const signed = decodeURIComponent(cookies.get('__Secure-better-auth.session_token') ?? '');
  const key = sessionCacheKey(sessionTokenOf(signed));
  kv.store.set(key, JSON.stringify({ credentials: [signed], session: {} }));
  return key;
}

function signedInRequest(path: string, cookies: Map<string, string>, body: object): Request {
  return new Request(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader(cookies), origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

async function changeNumber(ctx: Setup, cookies: Map<string, string>, code?: string) {
  await ctx.auth.handler(postJSON(`${API}/phone-number/send-otp`, { phoneNumber: SECOND }));
  return ctx.auth.handler(
    signedInRequest('/phone-number/verify', cookies, {
      phoneNumber: SECOND,
      code: code ?? ctx.codes.at(-1),
      updatePhoneNumber: true,
    })
  );
}

describe('a phone number change through verify with updatePhoneNumber', () => {
  it('expires the cookie cache, so get-session returns the new number', async () => {
    const ctx = setup();
    const cookies = await signIn(ctx, FIRST);

    const res = await changeNumber(ctx, cookies);

    expect(res.status).toBe(200);
    const expired = res.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Secure-better-auth.session_data='));
    expect(expired).toMatch(/Max-Age=0/i);
    // What the browser holds next: the session token, without the cache.
    cookies.delete('__Secure-better-auth.session_data');
    const session = await ctx.auth.handler(
      new Request(`${API}/get-session`, { headers: { cookie: cookieHeader(cookies) } })
    );
    const body: { user: { phoneNumber: string; phoneNumberVerified: boolean } } =
      await session.json();
    expect(body.user).toMatchObject({ phoneNumber: SECOND, phoneNumberVerified: true });
  });

  it("evicts the session client's cached copy", async () => {
    const ctx = setup();
    const cookies = await signIn(ctx, FIRST);
    const key = seedClientCache(ctx, cookies);

    await changeNumber(ctx, cookies);

    expect(ctx.kv.store.has(key)).toBe(false);
  });

  // A session on another device caches the same user; the web session that
  // verified can't reach that device's cookies, but its KV entry must go.
  it("evicts the session client's copy for every session of the user", async () => {
    const ctx = setup();
    const web = await signIn(ctx, FIRST);
    const phone = await signIn(ctx, FIRST);
    const webKey = seedClientCache(ctx, web);
    const phoneKey = seedClientCache(ctx, phone);

    await changeNumber(ctx, web);

    expect(ctx.kv.store.has(webKey)).toBe(false);
    expect(ctx.kv.store.has(phoneKey)).toBe(false);
  });

  it('also expires the chunks of a cookie cache too large for one cookie', async () => {
    const ctx = setup();
    const cookies = await signIn(ctx, FIRST);
    cookies.set('__Secure-better-auth.session_data.0', 'part');

    const res = await changeNumber(ctx, cookies);

    const chunk = res.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Secure-better-auth.session_data.0='));
    expect(chunk).toMatch(/Max-Age=0/i);
  });

  it('leaves both caches alone when the change fails', async () => {
    const ctx = setup();
    const cookies = await signIn(ctx, FIRST);
    const key = seedClientCache(ctx, cookies);

    const res = await changeNumber(ctx, cookies, 'not-the-code');

    expect(res.status).toBe(400);
    expect(
      res.headers.getSetCookie().some((c) => c.startsWith('__Secure-better-auth.session_data='))
    ).toBe(false);
    expect(ctx.kv.store.has(key)).toBe(true);
  });
});

// KV refuses a second write to a key within a second; here, every delete of
// a session client cache entry (the eviction under test), and nothing else.
class CacheDeleteRefusingKV extends FakeKV {
  override delete(key: string): Promise<void> {
    if (key.startsWith('better-auth-workers:session:')) {
      return Promise.reject(new Error('KV DELETE failed: 429 Too Many Requests'));
    }
    return super.delete(key);
  }
}

describe('/update-user', () => {
  it("evicts the session client's copy for every session of the user", async () => {
    const ctx = setup();
    const web = await signIn(ctx, FIRST);
    const phone = await signIn(ctx, FIRST);
    const keys = [seedClientCache(ctx, web), seedClientCache(ctx, phone)];

    const res = await ctx.auth.handler(signedInRequest('/update-user', web, { name: 'New' }));

    expect(res.status).toBe(200);
    for (const key of keys) expect(ctx.kv.store.has(key)).toBe(false);
  });

  // The update has happened; a stale cached copy is the worst a failed
  // eviction leaves, so it must not turn into a failed request.
  it('still succeeds when the cache eviction is refused', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const ctx = setup(new CacheDeleteRefusingKV());
      const cookies = await signIn(ctx, FIRST);
      seedClientCache(ctx, cookies);

      const res = await ctx.auth.handler(signedInRequest('/update-user', cookies, { name: 'New' }));

      expect(res.status).toBe(200);
    } finally {
      console.error = originalError;
    }
  });
});
