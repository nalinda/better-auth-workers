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
  user?: { id?: string; phoneNumber?: string };
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

async function postJson(
  baseUrl: string,
  route: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function requestOtp(server: DevServer, phoneNumber: string): Promise<string> {
  const sent = await postJson(server.baseUrl, '/auth/phone-number/send-otp', { phoneNumber });
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
  return postJson(server.baseUrl, '/auth/phone-number/verify', { phoneNumber, code });
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

async function authCalls(server: DevServer): Promise<number> {
  const response = await fetch(`${server.baseUrl}/__gateway/auth-calls`);
  const body = (await response.json()) as { count: number };
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

    const body = (await verified.json()) as VerifyResponse;
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

    const signedOut = await postJson(
      server.baseUrl,
      '/auth/sign-out',
      {},
      { cookie: cookie as string }
    );
    expect(signedOut.status).toBe(200);
    expect(await signedOut.json()).toEqual({ success: true });

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

  it('session client serves a warm get-session from KV without calling the auth Worker', async () => {
    const phoneNumber = nextPhone();
    const verified = await signInWithPhone(server, phoneNumber);
    const cookie = sessionCookieFrom(verified);
    expect(cookie).toBeDefined();

    const cold = await fetch(`${server.baseUrl}/me`, { headers: { cookie: cookie as string } });
    expect(cold.status).toBe(200);
    expect(((await cold.json()) as { phoneNumber?: string }).phoneNumber).toBe(phoneNumber);

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

    const signedOut = await postJson(
      server.baseUrl,
      '/auth/sign-out',
      {},
      { cookie: cookie as string }
    );
    expect(signedOut.status).toBe(200);

    const afterSignOut = await fetch(`${server.baseUrl}/me`, {
      headers: { cookie: cookie as string },
    });
    expect(afterSignOut.status).toBe(401);
  });

  it('allowedMethods rejects a sign-in method the Worker does not allow with 403', async () => {
    const rejected = await postJson(server.baseUrl, '/auth/sign-in/social', {
      provider: 'google',
      callbackURL: '/',
    });
    expect(rejected.status).toBe(403);
  });
});
