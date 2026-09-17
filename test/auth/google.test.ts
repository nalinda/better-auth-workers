import { describe, expect, it } from 'bun:test';

import { type AuthInstance, createAuth } from '../../src/index';
import { buildEnv, VALID_BASE_URL } from '../helpers/auth';

// Better Auth types `socialProviders.google` as possibly lazy; the package
// always configures it as a plain credentials object.
function googleCredentials(auth: AuthInstance): { clientId?: string; clientSecret?: string } {
  return (auth.options.socialProviders?.google ?? {}) as {
    clientId?: string;
    clientSecret?: string;
  };
}

const validEnv = buildEnv();

// A callback without a valid OAuth state is rejected by the route with a
// redirect to the error page; a 404 would mean the route is missing.
const callback = (basePath: string) =>
  new Request(`${VALID_BASE_URL}${basePath}/callback/google?state=missing`);

describe('Google sign-in from secrets', () => {
  it('reads GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from env when google is true', () => {
    const env = buildEnv({
      GOOGLE_CLIENT_ID: 'client-id-from-env',
      GOOGLE_CLIENT_SECRET: 'client-secret-from-env',
    });
    const auth = createAuth(env, { google: true });

    expect(googleCredentials(auth).clientId).toBe('client-id-from-env');
    expect(googleCredentials(auth).clientSecret).toBe('client-secret-from-env');
  });

  it('uses explicit credentials from the object form instead of env', () => {
    const env = buildEnv({
      GOOGLE_CLIENT_ID: 'ignored-id',
      GOOGLE_CLIENT_SECRET: 'ignored-secret',
    });
    const auth = createAuth(env, {
      google: { clientId: 'explicit-id', clientSecret: 'explicit-secret' },
    });

    expect(googleCredentials(auth).clientId).toBe('explicit-id');
    expect(googleCredentials(auth).clientSecret).toBe('explicit-secret');
  });

  it('throws a clear error at creation time when GOOGLE_CLIENT_SECRET is missing', () => {
    const env = buildEnv({ GOOGLE_CLIENT_ID: 'client-id-from-env' });
    expect(() => createAuth(env, { google: true })).toThrow(/GOOGLE_CLIENT_SECRET/);
  });

  it('throws a clear error at creation time when GOOGLE_CLIENT_ID is missing', () => {
    const env = buildEnv({ GOOGLE_CLIENT_SECRET: 'client-secret-from-env' });
    expect(() => createAuth(env, { google: true })).toThrow(/GOOGLE_CLIENT_ID/);
  });

  it('does not configure a social provider when google is not set', () => {
    const auth = createAuth(validEnv, {});
    expect(auth.options.socialProviders?.google).toBeUndefined();
  });

  describe('callback route', () => {
    const quiet = { logger: { disabled: true } };

    it('mounts the Google callback under the default basePath', async () => {
      const auth = createAuth(validEnv, {
        google: { clientId: 'explicit-id', clientSecret: 'explicit-secret' },
        betterAuth: quiet,
      });

      const res = await auth.handler(callback('/api/auth'));

      expect(res.status).not.toBe(404);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('error=');
    });

    it('mounts the Google callback under a custom basePath', async () => {
      const auth = createAuth(validEnv, {
        basePath: '/auth',
        google: { clientId: 'explicit-id', clientSecret: 'explicit-secret' },
        betterAuth: quiet,
      });

      const res = await auth.handler(callback('/auth'));

      expect(res.status).not.toBe(404);
      expect(res.status).toBe(302);
    });
  });
});
