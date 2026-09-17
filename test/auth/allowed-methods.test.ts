import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { createAuth } from '../../src/index';

function createMockD1() {
  return {
    prepare: mock(() => ({
      bind: mock(() => ({
        all: mock(() => Promise.resolve({ results: [], meta: { changes: 0 } })),
        first: mock(() => Promise.resolve(null)),
        run: mock(() => Promise.resolve({ success: true, meta: { changes: 0 } })),
      })),
    })),
    batch: mock(() => Promise.resolve([])),
    exec: mock(() => Promise.resolve({ count: 0, duration: 0 })),
  };
}

interface CreateAuthOptions {
  basePath?: string;
  baseURL?: string;
  secret?: string;
  database?: unknown;
  google?: boolean | { clientId: string; clientSecret: string };
  phone?: {
    sendOTP: (
      args: { phoneNumber: string; code: string },
      request?: Request
    ) => Promise<void> | void;
  };
  magicLink?: {
    sendMagicLink: (
      args: { email: string; url: string; token: string },
      request?: Request
    ) => Promise<void> | void;
  };
  allowedMethods?: Array<'phone' | 'google' | 'magic-link'>;
  betterAuth?: {
    hooks?: {
      before?: (ctx: unknown) => Promise<unknown>;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface AuthInstanceLike {
  handler: (req: Request) => Promise<Response>;
  [key: string]: unknown;
}

const createAuthInstance = (
  env: Record<string, unknown>,
  options?: CreateAuthOptions
): AuthInstanceLike =>
  (
    createAuth as unknown as (e: Record<string, unknown>, o?: CreateAuthOptions) => AuthInstanceLike
  )(env, options);

const validSecret = 'test-secret-at-least-32-chars-long-1234567890';
const validBaseUrl = 'https://auth.example.com';

function buildEnv(): Record<string, unknown> {
  return {
    AUTH_BASE_URL: validBaseUrl,
    BETTER_AUTH_SECRET: validSecret,
    DB: createMockD1(),
  };
}

function postJSON(path: string, body: Record<string, unknown>): Request {
  return new Request(`${validBaseUrl}/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(path: string): Request {
  return new Request(`${validBaseUrl}/api/auth${path}`);
}

describe('allowedMethods restricts sign-in routes per deployment', () => {
  let validEnv: Record<string, unknown>;

  beforeEach(() => {
    validEnv = buildEnv();
  });

  function buildGoogleAndPhoneAuth(allowedMethods: Array<'phone' | 'google' | 'magic-link'>) {
    return createAuthInstance(validEnv, {
      google: { clientId: 'client-id', clientSecret: 'client-secret' },
      phone: { sendOTP: async () => {} },
      allowedMethods,
      // Keeps OAuth state in a signed cookie instead of the verification
      // table, so the mock D1 adapter (which has no working create/read
      // round-trip) does not stand in the way of exercising the sign-in
      // route itself.
      betterAuth: { account: { storeStateStrategy: 'cookie' } },
    });
  }

  describe('phone OTP restricted when phone is not in allowedMethods', () => {
    it('rejects a phone OTP send-otp request with 403 when only google is allowed', async () => {
      const auth = buildGoogleAndPhoneAuth(['google']);

      const res = await auth.handler(
        postJSON('/phone-number/send-otp', { phoneNumber: '+15551234567' })
      );

      expect(res.status).toBe(403);
    });

    it('rejects a phone OTP verify request with 403 when only google is allowed', async () => {
      const auth = buildGoogleAndPhoneAuth(['google']);

      const res = await auth.handler(
        postJSON('/phone-number/verify', { phoneNumber: '+15551234567', code: '123456' })
      );

      expect(res.status).toBe(403);
    });

    it('leaves the phone OTP route mounted, returning 403 rather than 404', async () => {
      const auth = buildGoogleAndPhoneAuth(['google']);

      const res = await auth.handler(
        postJSON('/phone-number/send-otp', { phoneNumber: '+15551234567' })
      );

      expect(res.status).not.toBe(404);
    });
  });

  describe('google sign-in still served when allowedMethods includes it', () => {
    it('still returns a successful authorization response for google sign-in', async () => {
      const auth = buildGoogleAndPhoneAuth(['google']);

      const res = await auth.handler(postJSON('/sign-in/social', { provider: 'google' }));

      expect(res.status).toBe(200);
    });
  });

  describe('get-session is never restricted', () => {
    it('still serves get-session when allowedMethods excludes every configured method', async () => {
      const auth = buildGoogleAndPhoneAuth(['google']);

      const res = await auth.handler(getRequest('/get-session'));

      expect(res.status).toBe(200);
    });

    it('serves get-session even when allowedMethods is an empty list', async () => {
      const auth = buildGoogleAndPhoneAuth([]);

      const res = await auth.handler(getRequest('/get-session'));

      expect(res.status).toBe(200);
    });
  });

  describe('sign-out is never restricted', () => {
    it('still serves sign-out when allowedMethods excludes every configured method', async () => {
      const auth = buildGoogleAndPhoneAuth([]);

      const res = await auth.handler(postJSON('/sign-out', {}));

      expect(res.status).toBe(200);
    });
  });

  describe('account-management routes are never restricted', () => {
    it('does not return 403 for update-user when allowedMethods excludes every configured method', async () => {
      const auth = buildGoogleAndPhoneAuth([]);

      const res = await auth.handler(postJSON('/update-user', { name: 'New Name' }));

      // Unauthenticated update-user fails with 401 from Better Auth's own
      // session middleware, never with the 403 our restriction would produce.
      expect(res.status).toBe(401);
    });
  });

  describe('magic-link restricted when magic-link is not in allowedMethods', () => {
    it('rejects a magic-link sign-in request with 403 when only google is allowed', async () => {
      const auth = createAuthInstance(validEnv, {
        google: { clientId: 'client-id', clientSecret: 'client-secret' },
        magicLink: { sendMagicLink: async () => {} },
        allowedMethods: ['google'],
      });

      const res = await auth.handler(
        postJSON('/sign-in/magic-link', { email: 'user@example.com' })
      );

      expect(res.status).toBe(403);
    });

    it('leaves the magic-link route mounted, returning 403 rather than 404', async () => {
      const auth = createAuthInstance(validEnv, {
        google: { clientId: 'client-id', clientSecret: 'client-secret' },
        magicLink: { sendMagicLink: async () => {} },
        allowedMethods: ['google'],
      });

      const res = await auth.handler(
        postJSON('/sign-in/magic-link', { email: 'user@example.com' })
      );

      expect(res.status).not.toBe(404);
    });
  });

  describe('composition with a user-supplied hooks.before', () => {
    it('still invokes an existing options.betterAuth.hooks.before alongside the allowedMethods check', async () => {
      const calls: string[] = [];
      const auth = createAuthInstance(validEnv, {
        google: { clientId: 'client-id', clientSecret: 'client-secret' },
        allowedMethods: ['google'],
        betterAuth: {
          hooks: {
            before: async (ctx: unknown) => {
              await Promise.resolve();
              calls.push((ctx as { path: string }).path);
            },
          },
        },
      });

      await auth.handler(getRequest('/get-session'));

      expect(calls).toContain('/get-session');
    });
  });

  describe('no allowedMethods configured', () => {
    it('serves phone OTP send-otp without restriction when allowedMethods is not set', async () => {
      const auth = createAuthInstance(validEnv, {
        phone: { sendOTP: async () => {} },
      });

      const res = await auth.handler(
        postJSON('/phone-number/send-otp', { phoneNumber: '+15551234567' })
      );

      expect(res.status).not.toBe(403);
    });
  });
});
