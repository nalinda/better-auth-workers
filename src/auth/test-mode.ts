import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api';
import type { OAuthProvider } from 'better-auth/oauth2';

import { warnOnce } from '../shared/warn-once';
import type { AuthEnv } from '../types';
import type { CreateAuthOptions } from './types';

// Test mode swaps the two things an end-to-end suite cannot drive for
// deterministic stand-ins: the phone OTP (every code is `otpCode`, and
// nothing is sent) and Google (an in-process stub that signs in whoever the
// sign-in names, with no network call). Both let anyone sign in as anyone,
// so test mode is refused unless every base URL the instance could run
// under is plain http on a loopback host, and while it is on the instance
// answers no request whose URL (or forwarded Host) names another host.

const TEST_MODE_WARNING =
  'better-auth-workers: TEST MODE is on. Phone codes are fixed and/or Google sign-in is stubbed, so anyone can sign in as anyone. It only runs on http://localhost; never enable it in a deployed environment.';

const warnTestMode = warnOnce(TEST_MODE_WARNING);

// localhost, *.localhost, 127.0.0.0/8 and ::1. This reads the host the
// request names (its URL, set from the Host header), not where it came from:
// behind the startup guard that is enough, since a deployed route never
// names a loopback host, but `wrangler dev --ip 0.0.0.0` would let another
// machine on the network send `Host: localhost`.
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || isLoopbackIPv4(host)
  );
}

function isLoopbackIPv4(host: string): boolean {
  const octets = host.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function isLoopbackHttpURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

// Every base URL the instance could end up with (the option, the env var
// and the escape hatch, whichever are set), since at runtime the escape
// hatch wins but validation reads the option first. A `betterAuth.baseURL`
// key that is present counts even when it is not a string: spread last, an
// `undefined` or a dynamic config there replaces the resolved base URL.
function candidateBaseURLs(options: CreateAuthOptions, env?: Partial<AuthEnv>): unknown[] {
  const candidates: unknown[] = [options.baseURL, env?.AUTH_BASE_URL].filter(
    (value) => value !== undefined
  );
  const escapeHatch = options.betterAuth;
  if (escapeHatch && 'baseURL' in escapeHatch) candidates.push(escapeHatch.baseURL);
  return candidates;
}

export function testModeProblems(
  options: CreateAuthOptions | undefined,
  env?: Partial<AuthEnv>
): string[] {
  const testMode = options?.testMode;
  if (!testMode) return [];
  const problems: string[] = [];
  const nonLoopback = candidateBaseURLs(options, env).filter(
    (value) => typeof value !== 'string' || !isLoopbackHttpURL(value)
  );
  if (nonLoopback.length > 0) {
    problems.push(
      `testMode is only allowed when every base URL is http:// on a loopback host (localhost, *.localhost, 127.0.0.1, [::1]); got ${nonLoopback.map((value) => JSON.stringify(value)).join(', ')}`
    );
  }
  // Test mode stands in for a method the deployment has, never adds one: a
  // suite passing against a method production does not offer proves nothing.
  if (testMode.otpCode !== undefined && !options.phone) {
    problems.push('testMode.otpCode requires phone to be configured');
  }
  if (testMode.google && !options.google) {
    problems.push('testMode.google requires google to be configured');
  }
  if (testMode.otpCode !== undefined && !/^\d{4,10}$/.test(testMode.otpCode)) {
    problems.push('testMode.otpCode must be 4 to 10 digits');
  }
  return problems;
}

export function warnIfTestMode(options?: CreateAuthOptions): void {
  if (options?.testMode) warnTestMode();
}

// The identity the Google stub signs in, chosen by the sign-in's
// `loginHint` (`authClient.signIn.social({ provider: 'google', loginHint })`).
interface StubProfile {
  sub: string;
  email: string;
  name: string;
  email_verified: boolean;
}

const DEFAULT_STUB_EMAIL = 'test.user@example.com';
const STUB_ERROR_PREFIX = 'error:';

function stubProfile(loginHint: string | undefined): StubProfile {
  const email = (loginHint ?? DEFAULT_STUB_EMAIL).toLowerCase();
  return {
    sub: `test-${email}`,
    email,
    name: email.split('@', 1)[0] ?? email,
    email_verified: true,
  };
}

function encodeProfile(profile: StubProfile): string {
  const bytes = new TextEncoder().encode(JSON.stringify(profile));
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function decodeProfile(code: string): StubProfile | null {
  try {
    const base64 = code.replaceAll('-', '+').replaceAll('_', '/');
    const bytes = Uint8Array.from(atob(base64), (char) => char.codePointAt(0) ?? 0);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const profile: Partial<Record<keyof StubProfile, unknown>> = parsed;
    if (typeof profile.sub !== 'string' || typeof profile.email !== 'string') return null;
    return {
      sub: profile.sub,
      email: profile.email,
      name: typeof profile.name === 'string' ? profile.name : profile.email,
      email_verified: profile.email_verified === true,
    };
  } catch {
    return null;
  }
}

const GOOGLE_STUB_AUTHORIZE_PATH = '/test-mode/google/authorize';

// A provider with Google's id and callback route, so the client calls
// `signIn.social({ provider: 'google' })` exactly as in production. The
// authorization URL is the stub endpoint below, which redirects straight
// back with a code; the code is the profile itself, decoded here without a
// token exchange or any network call.
function googleStubProvider(authorizeURL: string): OAuthProvider<StubProfile> {
  return {
    id: 'google',
    name: 'Google (test mode)',
    accountSubject: ({ profile }) => profile.sub,
    createAuthorizationURL: ({ state, redirectURI, loginHint }) => {
      const url = new URL(authorizeURL);
      url.searchParams.set('state', state);
      url.searchParams.set('redirect_uri', redirectURI);
      if (loginHint) url.searchParams.set('login_hint', loginHint);
      return url;
    },
    validateAuthorizationCode: ({ code }) =>
      Promise.resolve(decodeProfile(code) ? { accessToken: code, tokenType: 'Bearer' } : null),
    // The account id comes from `accountSubject` (the profile's `sub`),
    // as for the real provider.
    getUserInfo: (tokens) => {
      const profile = tokens.accessToken ? decodeProfile(tokens.accessToken) : null;
      if (!profile) return Promise.resolve(null);
      return Promise.resolve({
        user: { email: profile.email, name: profile.name, emailVerified: profile.email_verified },
        data: profile,
      });
    },
  };
}

// Where the stub's authorize page sends the browser: only ever this
// instance's own Google callback, so the endpoint cannot bounce a browser
// elsewhere, with either the `loginHint` identity as the code or, for
// `error:<code>`, the error a refused consent screen returns.
function stubCallbackURL(query: URLSearchParams, callback: string): string {
  const state = query.get('state');
  if (!state || query.get('redirect_uri') !== callback) {
    throw new APIError('BAD_REQUEST', {
      message: 'state is required and redirect_uri must be the Google callback',
    });
  }
  const target = new URL(callback);
  target.searchParams.set('state', state);
  const hint = query.get('login_hint') ?? undefined;
  if (hint?.startsWith(STUB_ERROR_PREFIX)) {
    target.searchParams.set('error', hint.slice(STUB_ERROR_PREFIX.length) || 'access_denied');
    return target.href;
  }
  if (hint !== undefined && !hint.includes('@')) {
    throw new APIError('BAD_REQUEST', {
      message: 'loginHint must be an email address or error:<code>',
    });
  }
  target.searchParams.set('code', encodeProfile(stubProfile(hint)));
  return target.href;
}

// In test mode the instance answers no call that names a host other than a
// loopback one, whatever the route: the startup guard is the first line,
// this is the one that holds if a deployed Worker is ever started with a
// localhost base URL and test mode on.
//
// The hosts a call names: the request's URL for HTTP requests through
// `auth.handler`; for a server-side `auth.api` call, the `host` and any
// `x-forwarded-host` it forwarded (`auth.api.x({ body, headers:
// request.headers })`, the usual pattern for a route of the consumer's own).
// Forwarded headers that name no host at all are refused, since they still
// came from a request. Only a server-side call with no headers, the Worker's
// own code rather than a client's, names nothing and is let through. A host
// that does not parse names nothing loopback and is refused.
function namedHosts(ctx: { request?: Request; headers?: Headers }): string[] | undefined {
  if (ctx.request) return [new URL(ctx.request.url).hostname];
  if (!ctx.headers) return;
  const hosts = [ctx.headers.get('host'), ctx.headers.get('x-forwarded-host')].filter(
    (value) => value !== null
  );
  return hosts.map((host) => {
    try {
      return new URL(`http://${host}`).hostname;
    } catch {
      return '';
    }
  });
}

const refuseOffLoopbackRequests = {
  matcher: () => true,
  handler: createAuthMiddleware((ctx) => {
    const hosts = namedHosts(ctx);
    if (
      hosts !== undefined &&
      (hosts.length === 0 || hosts.some((host) => !isLoopbackHost(host)))
    ) {
      throw new APIError('FORBIDDEN', {
        code: 'TEST_MODE_LOCALHOST_ONLY',
        message: 'This instance is in test mode and only answers requests to localhost',
      });
    }
    return Promise.resolve();
  }),
};

/**
 * The test-mode plugin, whenever `testMode` is set: refuses requests that
 * did not arrive on a loopback host. With `testMode.google` it also replaces
 * the Google provider with the in-process stub and mounts its authorize
 * endpoint. A `loginHint` of `error:<code>` makes the stub answer like a
 * refused Google consent screen (`error:access_denied`), for testing that
 * path; any other hint must be an email address.
 */
export function buildTestModePlugin(options?: CreateAuthOptions): BetterAuthPlugin | undefined {
  if (!options?.testMode) return;
  const guard: BetterAuthPlugin = {
    id: 'better-auth-workers-test-mode',
    hooks: { before: [refuseOffLoopbackRequests] },
  };
  if (!options.testMode.google) return guard;
  return {
    ...guard,
    init: (context) => {
      const authorizeURL = `${context.baseURL}${GOOGLE_STUB_AUTHORIZE_PATH}`;
      const others = context.socialProviders.filter((provider) => provider.id !== 'google');
      return {
        context: {
          socialProviders: [...others, googleStubProvider(authorizeURL)],
        },
      };
    },
    endpoints: {
      testModeGoogleAuthorize: createAuthEndpoint(
        GOOGLE_STUB_AUTHORIZE_PATH,
        { method: 'GET' },
        (ctx) => {
          // A browser redirect, so only reachable as an HTTP request; the
          // request's host was checked by the before hook.
          if (!ctx.request) {
            throw new APIError('BAD_REQUEST', {
              message: 'the stub authorize page is for browsers',
            });
          }
          const query = new URL(ctx.request.url).searchParams;
          throw ctx.redirect(stubCallbackURL(query, `${ctx.context.baseURL}/callback/google`));
        }
      ),
    },
  };
}
