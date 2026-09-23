import { describe, expect, it } from 'bun:test';

import { createSessionClient } from '../src/client';
import { createAuth } from '../src/index';
import { buildEnv, FakeKV } from './helpers/auth';
import { migratedSqlite } from './helpers/sqlite';

// The same-origin-behind-a-proxy path: the browser only ever talks to the
// app's origin; the app Worker forwards `/auth/*` over a service binding to
// a gateway Worker, which forwards it to the auth Worker. A service binding
// passes the Request through as is, URL and headers included, so what the
// auth Worker receives is the browser's request on the app's origin; that is
// what these tests send it. The binding itself is exercised for real by the
// wrangler dev integration suite (test/integration/gateway/index.ts forwards
// with `env.AUTH.fetch(request)`).

const APP = 'https://app.example.com';
const API = `${APP}/auth`;

function setup() {
  const kv = new FakeKV();
  const codes: string[] = [];
  const auth = createAuth(
    buildEnv({ DB: undefined, AUTH_BASE_URL: APP, AUTH_KV: kv.asBinding() }),
    {
      basePath: '/auth',
      phone: {
        sendOTP: ({ code }) => {
          codes.push(code);
        },
        awaitDelivery: true,
      },
      google: { clientId: 'client-id', clientSecret: 'client-secret' },
      betterAuth: {
        database: migratedSqlite(),
        // Better Auth turns its origin check off when it detects a test run
        // (NODE_ENV=test, which bun test sets); a deployed Worker has it on.
        advanced: { disableOriginCheck: false },
      },
    }
  );
  // The request as the app Worker forwards it, through the gateway, to the
  // auth Worker: unchanged.
  const appWorker = (request: Request) => auth.handler(request);
  return { auth, kv, codes, appWorker };
}

type Setup = ReturnType<typeof setup>;

function post(path: string, body: object, headers: Record<string, string> = {}): Request {
  return new Request(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function signIn({ appWorker, codes }: Setup): Promise<Response> {
  const phoneNumber = '+15550000001';
  await appWorker(post('/phone-number/send-otp', { phoneNumber }));
  return appWorker(post('/phone-number/verify', { phoneNumber, code: codes.at(-1) ?? '' }));
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

describe('same origin, the request forwarded as is', () => {
  it('sets host-only cookies for the app origin: no Domain, Path=/, Secure', async () => {
    const res = await signIn(setup());

    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie).not.toMatch(/;\s*Domain=/i);
      // Exactly `/`: a cookie scoped to `/auth` would never reach `/api/*`.
      expect(cookie).toMatch(/;\s*Path=\/(;|$)/i);
      expect(cookie).toMatch(/;\s*SameSite=Lax/i);
      expect(cookie).toMatch(/;\s*Secure/i);
      expect(cookie).toMatch(/;\s*HttpOnly/i);
    }
  });

  it('builds the Google redirect URI on the app origin under /auth', async () => {
    const { appWorker } = setup();

    const res = await appWorker(post('/sign-in/social', { provider: 'google', callbackURL: '/' }));

    const { url }: { url: string } = await res.json();
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(`${APP}/auth/callback/google`);
  });

  // Better Auth trusts the base URL's origin and refuses a cookie-carrying
  // POST from any other: the app's CSRF defence.
  it('refuses a signed-in POST from another origin, and accepts it from the app', async () => {
    const ctx = setup();
    const cookie = cookieHeader(await signIn(ctx));

    const foreign = await ctx.appWorker(
      post('/sign-out', {}, { cookie, origin: 'https://evil.example' })
    );
    const own = await ctx.appWorker(post('/sign-out', {}, { cookie, origin: APP }));

    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ code: 'INVALID_ORIGIN' });
    expect(own.status).toBe(200);
  });

  // Better Auth's origin check only covers requests that carry cookies. A
  // cross-site first sign-in is stopped instead by the JSON-only body: a
  // browser form can't send JSON, and a fetch with it needs a CORS preflight
  // the auth Worker never answers. Pinned here so an upgrade that changes it
  // is noticed.
  it('refuses a cross-site form POST to verify, which the origin check does not cover', async () => {
    const { appWorker } = setup();

    const res = await appWorker(
      new Request(`${API}/phone-number/verify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://evil.example',
        },
        body: 'phoneNumber=%2B15550000001&code=123456',
      })
    );

    expect(res.status).toBe(415);
  });

  it('refuses a callbackURL on another origin', async () => {
    const { appWorker } = setup();

    const res = await appWorker(
      post('/sign-in/social', { provider: 'google', callbackURL: 'https://evil.example/' })
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'INVALID_CALLBACK_URL' });
  });

  // The API Worker verifies the browser's cookie from its own forwarded
  // request, over its own binding to the auth Worker.
  it('lets the API Worker read the same session from a forwarded request', async () => {
    const ctx = setup();
    const cookie = cookieHeader(await signIn(ctx));
    const client = createSessionClient({
      auth: { fetch: (request: Request) => ctx.auth.handler(request) } as unknown as Fetcher,
      kv: ctx.kv.asBinding(),
      basePath: '/auth',
    });

    const session = await client.get(new Request(`${APP}/api/me`, { headers: { cookie } }));

    expect(session?.user).toMatchObject({ phoneNumber: '+15550000001' });
  });

  // The limiter keys on cf-connecting-ip. Forwarding the request object keeps
  // it; rebuilding a request from the URL alone drops it, and every user then
  // shares one bucket.
  it('keeps the client IP only when the request is forwarded as is', async () => {
    const ctx = setup();
    const send = (ip: string, isRebuilt: boolean) => {
      const original = post(
        '/phone-number/send-otp',
        { phoneNumber: '+15550000009' },
        { 'cf-connecting-ip': ip }
      );
      const forwarded = isRebuilt
        ? new Request(original.url, {
            method: 'POST',
            body: original.body,
            headers: { 'content-type': 'application/json' },
          })
        : original;
      return ctx.appWorker(forwarded);
    };

    // Up to one more request than any per-window limit here; distinct IPs
    // never reach it, one shared IP does.
    const ATTEMPTS = 25;
    const passedThrough: number[] = [];
    for (let i = 0; i < ATTEMPTS; i += 1) {
      const res = await send(`203.0.113.${String(i)}`, false);
      passedThrough.push(res.status);
    }
    const rebuilt: number[] = [];
    for (let i = 0; i < ATTEMPTS && !rebuilt.includes(429); i += 1) {
      const res = await send(`198.51.100.${String(i)}`, true);
      rebuilt.push(res.status);
    }

    expect(passedThrough).not.toContain(429);
    expect(rebuilt).toContain(429);
  });
});
