import { describe, expect, it } from 'bun:test';

import { createAuth, type CreateAuthOptions } from '../src/index';
import { buildEnv, FakeKV, postJSON } from './helpers/auth';
import { migratedSqlite } from './helpers/sqlite';

// Every error code the README's "Error codes" table documents, produced
// through the real app. Most come from Better Auth; this keeps the table
// true across Better Auth upgrades.

const API = 'https://auth.example.com/api/auth';
const PHONE = '+15551234567';

function setup(options: Partial<CreateAuthOptions> = {}) {
  const db = migratedSqlite();
  const codes: string[] = [];
  const auth = createAuth(buildEnv({ DB: undefined, AUTH_KV: new FakeKV().asBinding() }), {
    phone: {
      awaitDelivery: true,
      sendOTP: ({ code }) => {
        codes.push(code);
      },
    },
    betterAuth: { database: db },
    ...options,
  });
  return { auth, db, codes };
}

const post = (auth: ReturnType<typeof createAuth>, path: string, body: Record<string, unknown>) =>
  auth.handler(postJSON(`${API}${path}`, body));

async function codeOf(response: Response): Promise<unknown> {
  const body: { code?: unknown } = await response.json();
  return body.code;
}

// Always the same client IP, so Better Auth's per-IP limiter counts them.
function sendFromOneClient(): Request {
  return new Request(`${API}/phone-number/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
    body: JSON.stringify({ phoneNumber: PHONE }),
  });
}

describe('documented error codes', () => {
  it('INVALID_PHONE_NUMBER (400): a number that is not E.164', async () => {
    const { auth } = setup();
    const res = await post(auth, '/phone-number/send-otp', { phoneNumber: '0771234567' });
    expect([res.status, await codeOf(res)]).toEqual([400, 'INVALID_PHONE_NUMBER']);
  });

  it('OTP_NOT_FOUND (400): verifying before any code was sent', async () => {
    const { auth } = setup();
    const res = await post(auth, '/phone-number/verify', { phoneNumber: PHONE, code: '000000' });
    expect([res.status, await codeOf(res)]).toEqual([400, 'OTP_NOT_FOUND']);
  });

  it('INVALID_OTP (400): a wrong code', async () => {
    const { auth, codes } = setup();
    await post(auth, '/phone-number/send-otp', { phoneNumber: PHONE });
    const wrong = codes[0] === '000000' ? '111111' : '000000';
    const res = await post(auth, '/phone-number/verify', { phoneNumber: PHONE, code: wrong });
    expect([res.status, await codeOf(res)]).toEqual([400, 'INVALID_OTP']);
  });

  it('TOO_MANY_ATTEMPTS (403): after the allowed wrong codes, even the right one', async () => {
    const { auth, codes } = setup();
    await post(auth, '/phone-number/send-otp', { phoneNumber: PHONE });
    const right = codes[0] ?? '';
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i += 1) {
      await post(auth, '/phone-number/verify', { phoneNumber: PHONE, code: wrong });
    }
    const res = await post(auth, '/phone-number/verify', { phoneNumber: PHONE, code: right });
    expect([res.status, await codeOf(res)]).toEqual([403, 'TOO_MANY_ATTEMPTS']);
  });

  it('OTP_EXPIRED (400): a code past its expiry', async () => {
    const { auth, codes } = setup({
      phone: {
        expiresIn: 1,
        sendOTP: ({ code }) => {
          codes.push(code);
        },
      },
    });
    await post(auth, '/phone-number/send-otp', { phoneNumber: PHONE });
    await Bun.sleep(1100);
    const res = await post(auth, '/phone-number/verify', {
      phoneNumber: PHONE,
      code: codes[0] ?? '',
    });
    expect([res.status, await codeOf(res)]).toEqual([400, 'OTP_EXPIRED']);
  });

  it('BANNED_USER (403): a banned user signing in', async () => {
    const { auth, db, codes } = setup();
    db.run(
      `insert into user (id, name, email, emailVerified, createdAt, updatedAt, banned, phoneNumber, phoneNumberVerified)
       values ('u1', 'U', 'u1@phone.invalid', 0, 0, 0, 1, ?, 1)`,
      [PHONE]
    );
    await post(auth, '/phone-number/send-otp', { phoneNumber: PHONE });
    const res = await post(auth, '/phone-number/verify', {
      phoneNumber: PHONE,
      code: codes[0] ?? '',
    });
    expect([res.status, await codeOf(res)]).toEqual([403, 'BANNED_USER']);
  });

  it('PHONE_NUMBER_EXIST (400): changing to a number another user has', async () => {
    const { auth, codes } = setup();
    const signIn = async (phoneNumber: string) => {
      await post(auth, '/phone-number/send-otp', { phoneNumber });
      return post(auth, '/phone-number/verify', { phoneNumber, code: codes.at(-1) ?? '' });
    };
    await signIn('+15550000001');
    const second = await signIn('+15550000002');
    const cookie = second.headers
      .getSetCookie()
      .map((c) => c.split(';', 1)[0])
      .join('; ');

    await post(auth, '/phone-number/send-otp', { phoneNumber: '+15550000001' });
    const body = JSON.stringify({
      phoneNumber: '+15550000001',
      code: codes.at(-1),
      updatePhoneNumber: true,
    });
    const headers = {
      'content-type': 'application/json',
      cookie,
      origin: 'https://auth.example.com',
    };
    const res = await auth.handler(
      new Request(`${API}/phone-number/verify`, { method: 'POST', headers, body })
    );
    expect([res.status, await codeOf(res)]).toEqual([400, 'PHONE_NUMBER_EXIST']);
  });

  it('RATE_LIMITED (429, X-Retry-After header): too many phone requests from one client', async () => {
    const { auth } = setup();
    let limited: Response | undefined;
    for (let i = 0; !limited && i < 12; i += 1) {
      const res = await auth.handler(sendFromOneClient());
      if (res.status === 429) limited = res;
    }
    expect(limited).toBeDefined();
    expect(Number(limited?.headers.get('x-retry-after'))).toBeGreaterThan(0);
    expect(limited?.headers.get('content-type')).toContain('application/json');
    expect(limited?.statusText).toBe('Too Many Requests');
    expect(await limited?.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  // A failure Better Auth didn't handle: here the rate limiter's KV read
  // throws, which escapes the handler before any endpoint runs, and a closed
  // database, which Better Auth answers with an empty 500.
  it('INTERNAL_ERROR (500): an unexpected failure', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      class FailingKV extends FakeKV {
        override get(): Promise<string | null> {
          return Promise.reject(new Error('KV GET failed: 500'));
        }
      }
      const throwing = createAuth(
        buildEnv({ DB: undefined, AUTH_KV: new FailingKV().asBinding() }),
        { phone: { sendOTP: () => {} }, betterAuth: { database: migratedSqlite() } }
      );
      const closed = migratedSqlite();
      closed.close();
      const emptyBodied = createAuth(
        buildEnv({ DB: undefined, AUTH_KV: new FakeKV().asBinding() }),
        {
          phone: { sendOTP: () => {} },
          betterAuth: { database: closed },
        }
      );

      for (const auth of [throwing, emptyBodied]) {
        const res = await auth.handler(
          new Request(`${API}/phone-number/send-otp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
            body: JSON.stringify({ phoneNumber: PHONE }),
          })
        );
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect(res.headers.get('content-type')).toContain('application/json');
        const body: { code?: string } = await res.json();
        expect(body.code === 'INTERNAL_ERROR' || body.code?.startsWith('FAILED_TO_')).toBe(true);
      }
    } finally {
      console.error = originalError;
    }
  });

  it('PROVIDER_NOT_FOUND (404): Google sign-in when Google is not configured', async () => {
    const { auth } = setup();
    const res = await post(auth, '/sign-in/social', { provider: 'google', callbackURL: '/' });
    expect([res.status, await codeOf(res)]).toEqual([404, 'PROVIDER_NOT_FOUND']);
  });

  it('SIGN_IN_METHOD_NOT_ALLOWED (403): a method the deprecated allowedMethods refuses', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const { auth } = setup({ allowedMethods: ['google'] });
      const res = await post(auth, '/phone-number/send-otp', { phoneNumber: PHONE });
      expect([res.status, await codeOf(res)]).toEqual([403, 'SIGN_IN_METHOD_NOT_ALLOWED']);
    } finally {
      console.warn = originalWarn;
    }
  });

  // The admin plugin's ban check fails inside the OAuth callback, which turns
  // it into a redirect rather than JSON. Driven through test mode's Google
  // stub, on localhost.
  it('BANNED_USER for Google: error=BANNED_USER on the error callback URL', async () => {
    const LOCAL = 'http://localhost:8787';
    const db = migratedSqlite();
    const auth = createAuth(
      buildEnv({ DB: undefined, AUTH_BASE_URL: LOCAL, AUTH_KV: new FakeKV().asBinding() }),
      {
        google: true,
        testMode: { google: true },
        betterAuth: { database: db },
      }
    );
    const signInWithGoogle = async () => {
      const start = await auth.handler(
        postJSON(`${LOCAL}/api/auth/sign-in/social`, {
          provider: 'google',
          loginHint: 'banned@example.com',
          callbackURL: '/home',
          errorCallbackURL: '/sign-in',
        })
      );
      const { url }: { url: string } = await start.json();
      const cookie = start.headers
        .getSetCookie()
        .map((c) => c.split(';', 1)[0])
        .join('; ');
      const authorized = await auth.handler(new Request(url));
      return auth.handler(
        new Request(authorized.headers.get('location') ?? '', { headers: { cookie } })
      );
    };
    await signInWithGoogle();
    db.run("update user set banned = 1 where email = 'banned@example.com'");

    const res = await signInWithGoogle();

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '', LOCAL);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('error')).toBe('BANNED_USER');
  });

  // Google's consent screen sends `error=access_denied` back when the user
  // cancels or refuses; Better Auth forwards it to errorCallbackURL.
  it('Google consent refused: error=access_denied on the error callback URL', async () => {
    const { auth } = setup({ google: { clientId: 'id', clientSecret: 'secret' } });
    const start = await post(auth, '/sign-in/social', {
      provider: 'google',
      callbackURL: '/home',
      errorCallbackURL: '/sign-in',
    });
    const { url }: { url: string } = await start.json();
    const state = new URL(url).searchParams.get('state') ?? '';
    const cookie = start.headers
      .getSetCookie()
      .map((c) => c.split(';', 1)[0])
      .join('; ');

    const res = await auth.handler(
      new Request(`${API}/callback/google?state=${state}&error=access_denied`, {
        headers: { cookie },
      })
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '', 'https://auth.example.com');
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('error')).toBe('access_denied');
  });
});
