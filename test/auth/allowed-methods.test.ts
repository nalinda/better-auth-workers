import { beforeEach, describe, expect, it } from 'bun:test';

import { createAuth } from '../../src/index';
import { buildEnv, VALID_BASE_URL } from '../helpers/auth';

function postJSON(path: string, body: Record<string, unknown>): Request {
  return new Request(`${VALID_BASE_URL}/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(path: string): Request {
  return new Request(`${VALID_BASE_URL}/api/auth${path}`);
}

describe('allowedMethods restricts sign-in routes per deployment', () => {
  let validEnv: ReturnType<typeof buildEnv>;

  beforeEach(() => {
    validEnv = buildEnv();
  });

  function buildGoogleAndPhoneAuth(allowedMethods: Array<'phone' | 'google' | 'magic-link'>) {
    return createAuth(validEnv, {
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
      const auth = createAuth(validEnv, {
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
      const auth = createAuth(validEnv, {
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
      const auth = createAuth(validEnv, {
        google: { clientId: 'client-id', clientSecret: 'client-secret' },
        allowedMethods: ['google'],
        betterAuth: {
          hooks: {
            before: async (ctx: { path: string }) => {
              await Promise.resolve();
              calls.push(ctx.path);
            },
          },
        },
      });

      await auth.handler(getRequest('/get-session'));

      expect(calls).toContain('/get-session');
    });
  });

  describe('a method that is not configured has no routes, allowed or not', () => {
    it('returns 404 for phone routes when phone is not configured, even if allowedMethods lists it', async () => {
      const auth = createAuth(validEnv, {
        google: { clientId: 'client-id', clientSecret: 'client-secret' },
        allowedMethods: ['phone', 'google'],
      });

      const res = await auth.handler(
        postJSON('/phone-number/send-otp', { phoneNumber: '+15551234567' })
      );

      expect(res.status).toBe(404);
    });

    it('returns 404, not 403, for magic-link routes when magicLink is not configured and not allowed', async () => {
      const auth = createAuth(validEnv, {
        google: { clientId: 'client-id', clientSecret: 'client-secret' },
        allowedMethods: ['google'],
      });

      const res = await auth.handler(
        postJSON('/sign-in/magic-link', { email: 'user@example.com' })
      );

      expect(res.status).toBe(404);
    });
  });

  describe('no allowedMethods configured', () => {
    it('serves phone OTP send-otp without restriction when allowedMethods is not set', async () => {
      const auth = createAuth(validEnv, {
        phone: { sendOTP: async () => {} },
      });

      const res = await auth.handler(
        postJSON('/phone-number/send-otp', { phoneNumber: '+15551234567' })
      );

      expect(res.status).not.toBe(403);
    });
  });
});
