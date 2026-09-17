import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { type Backend, type DevServer, requestedBackends, startDevServer } from './harness';

setDefaultTimeout(180_000);

const SESSION_COOKIE = 'better-auth.session_token';

interface VerifyResponse {
  status?: boolean;
  token?: string | null;
  user?: { id?: string; phoneNumber?: string };
}

interface SessionResponse {
  session?: { token?: string; userId?: string };
  user?: { id?: string; phoneNumber?: string; email?: string };
}

const phoneSequence = { next: Date.now() % 1_000_000 };

function nextPhone(): string {
  phoneSequence.next += 1;
  return `+1555${String(phoneSequence.next).padStart(7, '0')}`;
}

function sessionCookieFrom(response: Response): string | undefined {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(';', 1);
    if (pair.startsWith(`${SESSION_COOKIE}=`)) return pair;
  }
}

// Every cookie a response set, as one Cookie header value: the session
// token plus the cookie-cache (`session_data`) cookie when present.
function allCookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

// Better Auth's CSRF check (on by default; the example keeps it) refuses a
// cookie-bearing POST whose Origin is not a trusted one, so the suite sends
// the example's configured origin the way a browser on the app would.
async function postJson(
  server: DevServer,
  route: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${server.baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.appOrigin, ...headers },
    body: JSON.stringify(body),
  });
}

async function requestOtp(server: DevServer, phoneNumber: string): Promise<string> {
  const sent = await postJson(server, '/auth/phone-number/send-otp', { phoneNumber });
  expect(sent.status).toBe(200);
  const pattern = /OTP for (?<phone>\+\d+): (?<code>\d{4,8})/;
  const match = await server.waitForOutput(
    pattern,
    15_000,
    (candidate) => candidate.groups?.phone === phoneNumber
  );
  const code = match.groups?.code;
  if (!code) throw new Error('OTP code missing from matched log line');
  return code;
}

async function signInWithPhone(server: DevServer, phoneNumber: string): Promise<Response> {
  const code = await requestOtp(server, phoneNumber);
  return postJson(server, '/auth/phone-number/verify', { phoneNumber, code });
}

async function getSession(
  server: DevServer,
  headers: Record<string, string>
): Promise<{ response: Response; body: SessionResponse | null }> {
  const response = await fetch(`${server.baseUrl}/auth/get-session`, { headers });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as SessionResponse | null) : null;
  return { response, body };
}

async function requestMagicLink(server: DevServer, email: string): Promise<URL> {
  const sent = await postJson(server, '/auth/sign-in/magic-link', {
    email,
    callbackURL: '/',
  });
  expect(sent.status).toBe(200);
  const pattern = /Magic link for (?<email>\S+): (?<url>\S+)/;
  const match = await server.waitForOutput(
    pattern,
    15_000,
    (candidate) => candidate.groups?.email === email
  );
  const url = match.groups?.url;
  if (!url) throw new Error('magic link URL missing from matched log line');
  return new URL(url);
}

async function authCalls(server: DevServer): Promise<number> {
  const response = await fetch(`${server.baseUrl}/__gateway/auth-calls`);
  const body: { count: number } = await response.json();
  return body.count;
}

describe.each(requestedBackends())('example Worker under wrangler dev (%s)', (backend: Backend) => {
  const started = startDevServer(backend);
  let server: DevServer;

  beforeAll(async () => {
    server = await started;
  });

  afterAll(async () => {
    let running: DevServer | undefined;
    try {
      running = await started;
    } catch {
      return;
    }
    await running.stop();
  });

  it('sends a phone OTP through sendOTP and verifying it establishes a session', async () => {
    const phoneNumber = nextPhone();
    const verified = await signInWithPhone(server, phoneNumber);
    expect(verified.status).toBe(200);

    const body: VerifyResponse = await verified.json();
    expect(body.status).toBe(true);
    expect(typeof body.token).toBe('string');
    expect(body.user?.phoneNumber).toBe(phoneNumber);
    expect(sessionCookieFrom(verified)).toBeDefined();
  });

  it('get-session returns the signed-in user for a session cookie', async () => {
    const phoneNumber = nextPhone();
    const verified = await signInWithPhone(server, phoneNumber);
    const cookie = sessionCookieFrom(verified);
    expect(cookie).toBeDefined();

    const { response, body } = await getSession(server, { cookie: cookie as string });
    expect(response.status).toBe(200);
    expect(body?.user?.phoneNumber).toBe(phoneNumber);
    expect(typeof body?.session?.token).toBe('string');
  });

  it('sign-out ends the session so get-session no longer returns it', async () => {
    const phoneNumber = nextPhone();
    const verified = await signInWithPhone(server, phoneNumber);
    const cookie = sessionCookieFrom(verified);
    expect(cookie).toBeDefined();

    const signedOut = await postJson(server, '/auth/sign-out', {}, { cookie: cookie as string });
    expect(signedOut.status).toBe(200);
    const signedOutBody: { success?: boolean } = await signedOut.json();
    expect(signedOutBody).toEqual({ success: true });

    const { response, body } = await getSession(server, { cookie: cookie as string });
    expect(response.status).toBe(200);
    expect(body).toBeNull();
  });

  it('bearer flow: sign-in returns a token that authenticates without cookies', async () => {
    const phoneNumber = nextPhone();
    const verified = await signInWithPhone(server, phoneNumber);
    expect(verified.status).toBe(200);

    const token = verified.headers.get('set-auth-token');
    expect(token).toBeTruthy();

    const { response, body } = await getSession(server, {
      authorization: `Bearer ${token as string}`,
    });
    expect(response.status).toBe(200);
    expect(body?.user?.phoneNumber).toBe(phoneNumber);
  });

  it('magic link: following the link through /magic-link/verify establishes a session', async () => {
    const email = `magic-${String(Date.now())}-${String(phoneSequence.next)}@example.com`;
    const link = await requestMagicLink(server, email);
    expect(link.pathname).toBe('/auth/magic-link/verify');
    expect(link.searchParams.get('token')).toBeTruthy();

    // The example logs the link against its configured AUTH_BASE_URL; the
    // dev server listens on a test-chosen port, so only the path is reused.
    const verified = await fetch(`${server.baseUrl}${link.pathname}${link.search}`, {
      redirect: 'manual',
    });
    expect(verified.status).toBe(302);
    const cookie = sessionCookieFrom(verified);
    expect(cookie).toBeDefined();

    const { response, body } = await getSession(server, { cookie: cookie as string });
    expect(response.status).toBe(200);
    expect(body?.user?.email).toBe(email);
    expect(typeof body?.session?.token).toBe('string');
  });

  it('magic link: a link cannot be followed twice', async () => {
    const email = `once-${String(Date.now())}-${String(phoneSequence.next)}@example.com`;
    const link = await requestMagicLink(server, email);
    const target = `${server.baseUrl}${link.pathname}${link.search}`;

    const first = await fetch(target, { redirect: 'manual' });
    expect(sessionCookieFrom(first)).toBeDefined();

    const second = await fetch(target, { redirect: 'manual' });
    expect(sessionCookieFrom(second)).toBeUndefined();
    expect(second.headers.get('location')).toMatch(/error=/);
  });

  it('a warm get-session is served from the cookie cache without a primary-store query or a KV read', async () => {
    const phoneNumber = nextPhone();

    // Signing in writes the user and session, so the counter moves: this
    // is what makes the zero-delta assertions below meaningful.
    const beforeSignIn = await server.counters();
    const verified = await signInWithPhone(server, phoneNumber);
    const cookie = sessionCookieFrom(verified);
    expect(cookie).toBeDefined();
    const afterSignIn = await server.counters();
    expect(afterSignIn.primaryQueries).toBeGreaterThan(beforeSignIn.primaryQueries);

    // Cold: only the session token. Better Auth resolves the session from
    // KV (its secondary storage), so the primary store is not consulted.
    const cold = await getSession(server, { cookie: cookie as string });
    expect(cold.response.status).toBe(200);
    expect(cold.body?.user?.phoneNumber).toBe(phoneNumber);
    const afterCold = await server.counters();
    expect(afterCold.primaryQueries).toBe(afterSignIn.primaryQueries);
    expect(afterCold.kvReads).toBeGreaterThan(afterSignIn.kvReads);

    // Warm: the cold response set the signed cookie-cache cookie, so the
    // session comes straight from the request. No store is touched at all.
    const warmCookie = [cookie as string, allCookiesFrom(cold.response)].join('; ');
    const warm = await getSession(server, { cookie: warmCookie });
    expect(warm.response.status).toBe(200);
    expect(warm.body?.user?.phoneNumber).toBe(phoneNumber);
    const afterWarm = await server.counters();
    expect(afterWarm.primaryQueries).toBe(afterCold.primaryQueries);
    expect(afterWarm.kvReads).toBe(afterCold.kvReads);
  });

  it('session client serves a warm get-session from KV without calling the auth Worker', async () => {
    const phoneNumber = nextPhone();
    const verified = await signInWithPhone(server, phoneNumber);
    const cookie = sessionCookieFrom(verified);
    expect(cookie).toBeDefined();

    const cold = await fetch(`${server.baseUrl}/me`, { headers: { cookie: cookie as string } });
    expect(cold.status).toBe(200);
    const coldBody: { phoneNumber?: string } = await cold.json();
    expect(coldBody.phoneNumber).toBe(phoneNumber);

    const before = await authCalls(server);
    const warm = await fetch(`${server.baseUrl}/me`, { headers: { cookie: cookie as string } });
    expect(warm.status).toBe(200);
    expect(await authCalls(server)).toBe(before);
  });

  it('sign-out invalidates the session client cache shared through KV', async () => {
    const phoneNumber = nextPhone();
    const verified = await signInWithPhone(server, phoneNumber);
    const cookie = sessionCookieFrom(verified);
    expect(cookie).toBeDefined();

    const warm = await fetch(`${server.baseUrl}/me`, { headers: { cookie: cookie as string } });
    expect(warm.status).toBe(200);

    const signedOut = await postJson(server, '/auth/sign-out', {}, { cookie: cookie as string });
    expect(signedOut.status).toBe(200);

    const afterSignOut = await fetch(`${server.baseUrl}/me`, {
      headers: { cookie: cookie as string },
    });
    expect(afterSignOut.status).toBe(401);
  });

  it('a bearer-authenticated sign-out ends the session and invalidates the session client cache', async () => {
    const phoneNumber = nextPhone();
    const verified = await signInWithPhone(server, phoneNumber);
    const token = verified.headers.get('set-auth-token');
    expect(token).toBeTruthy();
    const authorization = `Bearer ${token as string}`;

    const warm = await fetch(`${server.baseUrl}/me`, { headers: { authorization } });
    expect(warm.status).toBe(200);

    const signedOut = await postJson(server, '/auth/sign-out', {}, { authorization });
    expect(signedOut.status).toBe(200);

    const { body } = await getSession(server, { authorization });
    expect(body).toBeNull();
    const afterSignOut = await fetch(`${server.baseUrl}/me`, { headers: { authorization } });
    expect(afterSignOut.status).toBe(401);
  });

  it('a revocation from elsewhere is seen even when the client still holds the cookie-cache cookie', async () => {
    // The browser keeps its full jar (session token + Better Auth's signed
    // session_data cookie). The session is revoked from another device;
    // the API Worker must not be talked into re-caching it by that cookie.
    const phoneNumber = nextPhone();
    const verified = await signInWithPhone(server, phoneNumber);
    const fullJar = allCookiesFrom(verified);
    expect(fullJar).toMatch(/session_data=/);
    const token = verified.headers.get('set-auth-token');
    expect(token).toBeTruthy();

    const warm = await fetch(`${server.baseUrl}/me`, { headers: { cookie: fullJar } });
    expect(warm.status).toBe(200);

    const revoked = await postJson(
      server,
      '/auth/revoke-sessions',
      {},
      { authorization: `Bearer ${token as string}` }
    );
    expect(revoked.status).toBe(200);

    const afterRevoke = await fetch(`${server.baseUrl}/me`, { headers: { cookie: fullJar } });
    expect(afterRevoke.status).toBe(401);
  });

  it('a bearer-authenticated revoke-sessions invalidates the session client cache too', async () => {
    const phoneNumber = nextPhone();
    const verified = await signInWithPhone(server, phoneNumber);
    const token = verified.headers.get('set-auth-token');
    expect(token).toBeTruthy();
    const authorization = `Bearer ${token as string}`;

    const warm = await fetch(`${server.baseUrl}/me`, { headers: { authorization } });
    expect(warm.status).toBe(200);

    const revoked = await postJson(server, '/auth/revoke-sessions', {}, { authorization });
    expect(revoked.status).toBe(200);

    const afterRevoke = await fetch(`${server.baseUrl}/me`, { headers: { authorization } });
    expect(afterRevoke.status).toBe(401);
  });

  it('allowedMethods rejects a sign-in method the Worker does not allow with 403', async () => {
    const rejected = await postJson(server, '/auth/sign-in/social', {
      provider: 'google',
      callbackURL: '/',
    });
    expect(rejected.status).toBe(403);
  });
});
