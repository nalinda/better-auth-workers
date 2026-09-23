/* eslint-disable unicorn/prefer-https -- test mode only runs on plain-http localhost; the http URLs are the point */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { createSessionClient } from '../../src/client';
import { type AuthEnv, createAuth, type CreateAuthOptions } from '../../src/index';
import { buildEnv, FakeKV, postJSON } from '../helpers/auth';
import { migratedSqlite } from '../helpers/sqlite';

const LOCAL = 'http://localhost:8787';
const API = `${LOCAL}/api/auth`;

// A fresh database, KV and env per test; `options` is layered over a
// phone + Google configuration with test mode on.
function localAuth(options: Partial<CreateAuthOptions> = {}) {
  const db = migratedSqlite();
  const sendOTP = mock(() => {});
  const auth = createAuth(
    buildEnv({ DB: undefined, AUTH_BASE_URL: LOCAL, AUTH_KV: new FakeKV().asBinding() }),
    {
      phone: { sendOTP },
      google: true,
      testMode: { otpCode: '123456', google: true },
      betterAuth: { database: db },
      ...options,
    }
  );
  return { auth, db, sendOTP };
}

function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

describe('test mode is refused outside localhost', () => {
  const cases: Array<[string, Partial<AuthEnv>, Partial<CreateAuthOptions>]> = [
    ['an https base URL', { AUTH_BASE_URL: 'https://app.example.com' }, {}],
    ['a plain-http public host', { AUTH_BASE_URL: 'http://app.example.com' }, {}],
    ['https on localhost', { AUTH_BASE_URL: 'https://localhost:8787' }, {}],
    ['an https baseURL option', { AUTH_BASE_URL: LOCAL }, { baseURL: 'https://app.example.com' }],
    [
      'an https betterAuth.baseURL',
      { AUTH_BASE_URL: LOCAL },
      { betterAuth: { baseURL: 'https://app.example.com' } },
    ],
    // Spread last, an explicit undefined would replace the resolved base
    // URL, and Better Auth would then take it from each request.
    [
      'an explicitly undefined betterAuth.baseURL',
      { AUTH_BASE_URL: LOCAL },
      { betterAuth: { baseURL: undefined } },
    ],
    [
      'a dynamic betterAuth.baseURL',
      { AUTH_BASE_URL: LOCAL },
      { betterAuth: { baseURL: { allowedHosts: ['localhost:8787'] } } },
    ],
    [
      'a loopback option over an https env',
      { AUTH_BASE_URL: 'https://app.example.com' },
      { baseURL: LOCAL },
    ],
  ];
  for (const [label, env, options] of cases) {
    it(`throws at startup with ${label}`, () => {
      expect(() => createAuth(buildEnv(env), { ...options, testMode: { google: true } })).toThrow(
        /testMode is only allowed when every base URL is http:\/\/ on a loopback host/
      );
    });
  }

  // Hosts that merely contain or resemble a loopback name.
  const LOOKALIKES = [
    'localhost.evil.com',
    'evillocalhost',
    '127.0.0.1.nip.io',
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- a lookalike the guard must refuse
    '128.0.0.1',
    '[::2]',
  ];

  for (const host of LOOKALIKES) {
    it(`throws at startup for the lookalike host ${host}`, () => {
      expect(() =>
        createAuth(buildEnv({ AUTH_BASE_URL: `http://${host}:8787` }), {
          google: { clientId: 'id', clientSecret: 'secret' },
          testMode: { google: true },
        })
      ).toThrow(/testMode is only allowed/);
    });
  }

  for (const baseURL of [
    'http://localhost:8787',
    'http://127.0.0.1:5173',
    'http://127.1.2.3',
    'http://[::1]:8787',
    'http://app.localhost',
  ]) {
    it(`accepts ${baseURL}`, () => {
      expect(() =>
        createAuth(buildEnv({ AUTH_BASE_URL: baseURL }), {
          google: { clientId: 'id', clientSecret: 'secret' },
          testMode: { google: true },
        })
      ).not.toThrow();
    });
  }

  it('requires google for the Google stub', () => {
    expect(() =>
      createAuth(buildEnv({ AUTH_BASE_URL: LOCAL }), { testMode: { google: true } })
    ).toThrow(/testMode.google requires google/);
  });

  it('requires phone for a fixed OTP code, and digits', () => {
    const env = buildEnv({ AUTH_BASE_URL: LOCAL });
    expect(() => createAuth(env, { testMode: { otpCode: '123456' } })).toThrow(
      /testMode.otpCode requires phone/
    );
    for (const otpCode of ['abc', '123', '12345678901', '12 34']) {
      expect(() =>
        createAuth(env, { phone: { sendOTP: () => {} }, testMode: { otpCode } })
      ).toThrow(/testMode.otpCode must be 4 to 10 digits/);
    }
    for (const otpCode of ['1234', '1234567890']) {
      expect(() =>
        createAuth(env, { phone: { sendOTP: () => {} }, testMode: { otpCode } })
      ).not.toThrow();
    }
  });
});

describe('test mode phone OTP', () => {
  let setup: ReturnType<typeof localAuth>;

  beforeEach(() => {
    setup = localAuth();
  });

  it('sends nothing', async () => {
    const res = await setup.auth.handler(
      postJSON(`${API}/phone-number/send-otp`, { phoneNumber: '+15550001111' })
    );

    expect(res.status).toBe(200);
    expect(setup.sendOTP).not.toHaveBeenCalled();
  });

  it('signs in with the fixed code', async () => {
    const res = await setup.auth.handler(
      postJSON(`${API}/phone-number/verify`, { phoneNumber: '+15550001111', code: '123456' })
    );

    expect(res.status).toBe(200);
    const body: { user: { phoneNumber: string } } = await res.json();
    expect(body.user.phoneNumber).toBe('+15550001111');
  });

  it('rejects any other code', async () => {
    const res = await setup.auth.handler(
      postJSON(`${API}/phone-number/verify`, { phoneNumber: '+15550001111', code: '654321' })
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_OTP' });
  });

  it('rejects the fixed code on a request that did not arrive on localhost', async () => {
    const res = await setup.auth.handler(
      postJSON('http://auth.example.com/api/auth/phone-number/verify', {
        phoneNumber: '+15550001111',
        code: '123456',
      })
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'TEST_MODE_LOCALHOST_ONLY' });
    expect(setup.db.query('select count(*) as n from user').get()).toEqual({ n: 0 });
  });

  // The usual pattern for a route of the consumer's own: the request's
  // headers forwarded to a server-side call, with no Request.
  it('refuses a server-side call that forwards a non-localhost Host', async () => {
    let error: unknown;
    try {
      await setup.auth.api.verifyPhoneNumber({
        body: { phoneNumber: '+15550001111', code: '123456' },
        headers: new Headers({ host: 'auth.example.com' }),
      });
    } catch (rejection) {
      error = rejection;
    }
    expect(error).toMatchObject({ statusCode: 403, body: { code: 'TEST_MODE_LOCALHOST_ONLY' } });
  });

  const forwardedHostCases: Array<[string, Record<string, string>]> = [
    ['a lookalike host', { host: 'localhost.evil.com' }],
    [
      'a public x-forwarded-host beside a loopback host',
      { host: 'localhost:8787', 'x-forwarded-host': 'app.example.com' },
    ],
    ['headers that name no host', { cookie: 'a=b' }],
    ['a host that does not parse', { host: 'bad host.localhost' }],
  ];
  for (const [label, headers] of forwardedHostCases) {
    it(`refuses a server-side call forwarding ${label}`, async () => {
      let error: unknown;
      try {
        await setup.auth.api.verifyPhoneNumber({
          body: { phoneNumber: '+15550001111', code: '123456' },
          headers: new Headers(headers),
        });
      } catch (rejection) {
        error = rejection;
      }
      expect(error).toMatchObject({ statusCode: 403, body: { code: 'TEST_MODE_LOCALHOST_ONLY' } });
    });
  }

  it('accepts a server-side call forwarding a loopback host', async () => {
    const result = await setup.auth.api.verifyPhoneNumber({
      body: { phoneNumber: '+15550001111', code: '123456', disableSession: true },
      headers: new Headers({ host: 'localhost:8787' }),
    });

    expect(result).toMatchObject({ status: true });
  });

  it("lets the Worker's own server-side calls through", async () => {
    const result = await setup.auth.api.verifyPhoneNumber({
      body: { phoneNumber: '+15550001111', code: '123456', disableSession: true },
    });

    expect(result).toMatchObject({ status: true });
  });

  // The API Worker's own view of the session: over a service binding the
  // session client addresses the auth Worker by a placeholder host, which
  // test mode must not refuse.
  it('keeps createSessionClient working against a test-mode auth Worker', async () => {
    const signIn = await setup.auth.handler(
      postJSON(`${API}/phone-number/verify`, { phoneNumber: '+15550001111', code: '123456' })
    );
    const client = createSessionClient({
      auth: { fetch: (request: Request) => setup.auth.handler(request) } as unknown as Fetcher,
      kv: new FakeKV().asBinding(),
    });

    const session = await client.get(
      new Request('http://localhost:5173/me', { headers: { cookie: cookiesFrom(signIn) } })
    );

    expect(session?.user).toMatchObject({ phoneNumber: '+15550001111' });
  });

  // The flow the consumer uses to add a verified phone to a Google user.
  it('accepts the fixed code when a signed-in user changes their number', async () => {
    const signIn = await setup.auth.handler(
      postJSON(`${API}/phone-number/verify`, { phoneNumber: '+15550001111', code: '123456' })
    );
    const cookie = cookiesFrom(signIn);

    const update = await setup.auth.handler(
      new Request(`${API}/phone-number/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: LOCAL },
        body: JSON.stringify({
          phoneNumber: '+15550002222',
          code: '123456',
          updatePhoneNumber: true,
        }),
      })
    );

    expect(update.status).toBe(200);
    const body: { user: { phoneNumber: string } } = await update.json();
    expect(body.user.phoneNumber).toBe('+15550002222');
  });
});

async function startGoogleSignIn(
  auth: ReturnType<typeof createAuth>,
  loginHint: string
): Promise<{ authorizeURL: string; cookies: string }> {
  const res = await auth.handler(
    postJSON(`${API}/sign-in/social`, { provider: 'google', loginHint, callbackURL: '/home' })
  );
  expect(res.status).toBe(200);
  const body: { url: string } = await res.json();
  return { authorizeURL: body.url, cookies: cookiesFrom(res) };
}

describe('test mode Google stub', () => {
  it('signs in the identity named by loginHint, without Google credentials', async () => {
    const { auth, db } = localAuth();
    const { authorizeURL, cookies } = await startGoogleSignIn(auth, 'alice@example.com');
    expect(authorizeURL).toStartWith(`${API}/test-mode/google/authorize?`);

    const authorized = await auth.handler(new Request(authorizeURL));
    expect(authorized.status).toBe(302);
    const callbackURL = authorized.headers.get('location') ?? '';
    expect(callbackURL).toStartWith(`${API}/callback/google?`);

    const callback = await auth.handler(new Request(callbackURL, { headers: { cookie: cookies } }));
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/home');
    expect(cookiesFrom(callback)).toContain('better-auth.session_token=');

    const account = db
      .query(
        'select a."accountId", u.email from account a join user u on u.id = a."userId" where a."providerId" = ?'
      )
      .get('google');
    expect(account).toEqual({ accountId: 'test-alice@example.com', email: 'alice@example.com' });
  });

  it('answers like a refused consent screen for loginHint error:access_denied', async () => {
    const { auth } = localAuth();
    const { authorizeURL, cookies } = await startGoogleSignIn(auth, 'error:access_denied');

    const authorized = await auth.handler(new Request(authorizeURL));
    const callbackURL = authorized.headers.get('location') ?? '';
    expect(new URL(callbackURL).searchParams.get('error')).toBe('access_denied');

    const callback = await auth.handler(new Request(callbackURL, { headers: { cookie: cookies } }));
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain('error=access_denied');
  });

  it('only redirects back to its own Google callback', async () => {
    const { auth } = localAuth();
    const res = await auth.handler(
      new Request(
        `${API}/test-mode/google/authorize?state=s&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}`
      )
    );

    expect(res.status).toBe(400);
    const body: { message?: string } = await res.json();
    expect(body.message).toContain('redirect_uri must be the Google callback');
  });

  // The stub's code is the profile itself, so without the localhost check a
  // forged code at the callback would sign in as anyone.
  it('refuses a forged code at a callback that did not arrive on localhost', async () => {
    const { auth, db } = localAuth();
    const forged = btoa(
      JSON.stringify({ sub: 'x', email: 'victim@example.com', email_verified: true })
    );
    const signIn = await auth.handler(
      postJSON('http://auth.example.com/api/auth/sign-in/social', {
        provider: 'google',
        callbackURL: '/',
      })
    );
    expect(signIn.status).toBe(403);
    expect(await signIn.json()).toMatchObject({ code: 'TEST_MODE_LOCALHOST_ONLY' });

    const callback = await auth.handler(
      new Request(`http://auth.example.com/api/auth/callback/google?state=s&code=${forged}`)
    );

    expect(callback.status).toBe(403);
    expect(await callback.json()).toMatchObject({ code: 'TEST_MODE_LOCALHOST_ONLY' });
    expect(db.query('select count(*) as n from user').get()).toEqual({ n: 0 });
  });

  it('refuses a loginHint that is neither an email address nor error:<code>', async () => {
    const { auth } = localAuth();
    const redirect = encodeURIComponent(`${API}/callback/google`);
    const res = await auth.handler(
      new Request(
        `${API}/test-mode/google/authorize?state=s&redirect_uri=${redirect}&login_hint=alice`
      )
    );

    expect(res.status).toBe(400);
    const body: { message?: string } = await res.json();
    expect(body.message).toContain('loginHint must be an email address');
  });

  it('refuses a request that did not arrive on localhost', async () => {
    const { auth } = localAuth();
    const redirect = encodeURIComponent(`${API}/callback/google`);
    const res = await auth.handler(
      new Request(
        `http://auth.example.com/api/auth/test-mode/google/authorize?state=s&redirect_uri=${redirect}`
      )
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'TEST_MODE_LOCALHOST_ONLY' });
  });

  it('answers a server-side call to the authorize page with 400', async () => {
    const { auth } = localAuth();
    let error: unknown;
    try {
      // Mounted by the test-mode plugin, so not on the typed `auth.api`.
      const api = auth.api as unknown as Record<string, (input: object) => Promise<unknown>>;
      await api.testModeGoogleAuthorize({});
    } catch (rejection) {
      error = rejection;
    }
    expect(error).toMatchObject({ statusCode: 400 });
  });

  it('is not mounted without test mode', async () => {
    const auth = createAuth(buildEnv({ AUTH_BASE_URL: LOCAL }), {
      google: { clientId: 'id', clientSecret: 'secret' },
    });
    const res = await auth.handler(
      new Request(`${API}/test-mode/google/authorize?state=s&redirect_uri=x`)
    );

    expect(res.status).toBe(404);
  });
});
/* eslint-enable unicorn/prefer-https */
