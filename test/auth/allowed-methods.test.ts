import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type * as AllowedMethods from '../../src/auth/allowed-methods';
import { createAuth } from '../../src/index';
import { buildEnv, postJSON as postJSONTo, VALID_BASE_URL } from '../helpers/auth';

// Routes here are relative to the instance's basePath.
const postJSON = (path: string, body: Record<string, unknown>): Request =>
  postJSONTo(`${VALID_BASE_URL}/api/auth${path}`, body);

function getRequest(path: string): Request {
  return new Request(`${VALID_BASE_URL}/api/auth${path}`);
}

// A Worker configured with Google only: no phone or magicLink plugin at all.
function googleOnlyAuth(env: ReturnType<typeof buildEnv>) {
  return createAuth(env, {
    google: { clientId: 'client-id', clientSecret: 'client-secret' },
    allowedMethods: ['google'],
    betterAuth: { account: { storeStateStrategy: 'cookie' } },
  });
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

  describe('a disallowed method stays mounted even when its plugin is not configured', () => {
    // The acceptance criterion: a Worker configured with Google only
    // rejects phone OTP sign-in with 403 (not 404) while Google sign-in and
    // get-session still succeed.
    it.each([
      ['POST', '/phone-number/send-otp', { phoneNumber: '+15551234567' }],
      ['POST', '/phone-number/verify', { phoneNumber: '+15551234567', code: '123456' }],
      ['POST', '/sign-in/phone-number', { phoneNumber: '+15551234567', password: 'x' }],
      ['POST', '/sign-in/magic-link', { email: 'user@example.com' }],
      ['GET', '/magic-link/verify?token=abc', {}],
    ])(
      'answers %s %s with 403 on a Google-only Worker with no phone or magicLink configured',
      async (method, path, body) => {
        const auth = googleOnlyAuth(validEnv);

        const res = await auth.handler(method === 'GET' ? getRequest(path) : postJSON(path, body));

        expect(res.status).toBe(403);
      }
    );

    it('still serves Google sign-in and get-session on that Worker', async () => {
      const auth = googleOnlyAuth(validEnv);

      const social = await auth.handler(postJSON('/sign-in/social', { provider: 'google' }));
      const session = await auth.handler(getRequest('/get-session'));

      expect([social.status, session.status]).toEqual([200, 200]);
    });

    it('does not mount stubs for a method that is allowed but simply not configured', async () => {
      const auth = createAuth(validEnv, {
        google: { clientId: 'client-id', clientSecret: 'client-secret' },
        allowedMethods: ['phone', 'google'],
      });

      const res = await auth.handler(
        postJSON('/phone-number/send-otp', { phoneNumber: '+15551234567' })
      );

      // Nothing serves phone here: it is allowed, just not configured.
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

describe('allowedMethods is deprecated', () => {
  // A fresh copy of the module per test: its warning is once per isolate,
  // and other tests in this process may already have set `allowedMethods`.
  let fresh = 0;
  async function freshModule(): Promise<typeof AllowedMethods> {
    fresh += 1;
    const specifier = `../../src/auth/allowed-methods.ts?fresh=${String(fresh)}`;
    return (await import(specifier)) as typeof AllowedMethods;
  }

  const originalWarn = console.warn;
  let warn: ReturnType<typeof mock>;

  beforeEach(() => {
    warn = mock(() => {});
    console.warn = warn;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it('warns once, however many instances set it', async () => {
    const { buildAllowedMethodsHook } = await freshModule();

    buildAllowedMethodsHook({ allowedMethods: ['google'] });
    buildAllowedMethodsHook({ allowedMethods: ['phone'] });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('`allowedMethods` is deprecated');
  });

  it('does not warn when allowedMethods is not set', async () => {
    const { buildAllowedMethodsHook } = await freshModule();

    buildAllowedMethodsHook({});
    buildAllowedMethodsHook();

    expect(warn).not.toHaveBeenCalled();
  });

  it('still restricts sign-in routes while deprecated', async () => {
    const { buildAllowedMethodsHook } = await freshModule();

    const check = buildAllowedMethodsHook({ allowedMethods: ['google'] });

    expect(() => check?.({ path: '/phone-number/send-otp' })).toThrow(
      'phone sign-in is not enabled for this deployment'
    );
  });
});
