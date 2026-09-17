import { describe, expect, it } from 'bun:test';

import { createAuth } from '../../src/index';

interface CreateAuthOptions {
  basePath?: string;
  baseURL?: string;
  secret?: string;
  database?: { hyperdrive: unknown } | { d1: unknown };
  kv?: unknown;
  google?: boolean | { clientId: string; clientSecret: string };
  [key: string]: unknown;
}

interface AuthInstanceLike {
  handler: (request: Request) => Promise<Response>;
  options: {
    basePath?: string;
    socialProviders?: {
      google?: { clientId?: string; clientSecret?: string };
    };
  };
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
const mockD1 = {
  prepare: () => ({
    bind: () => ({
      all: () => Promise.resolve({ results: [], success: true, meta: { changes: 0 } }),
      first: () => Promise.resolve(null),
      run: () => Promise.resolve({ success: true, meta: { changes: 0 } }),
    }),
  }),
  batch: () => Promise.resolve([]),
  exec: () => Promise.resolve({ count: 0, duration: 0 }),
};
const validEnv = {
  AUTH_BASE_URL: validBaseUrl,
  BETTER_AUTH_SECRET: validSecret,
  DB: mockD1,
};

describe('Google sign-in from secrets', () => {
  it('reads GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from env when google is true', () => {
    const env = {
      ...validEnv,
      GOOGLE_CLIENT_ID: 'client-id-from-env',
      GOOGLE_CLIENT_SECRET: 'client-secret-from-env',
    };
    const auth = createAuthInstance(env, { google: true });

    expect(auth.options.socialProviders?.google?.clientId).toBe('client-id-from-env');
    expect(auth.options.socialProviders?.google?.clientSecret).toBe('client-secret-from-env');
  });

  it('uses explicit credentials from the object form instead of env', () => {
    const env = {
      ...validEnv,
      GOOGLE_CLIENT_ID: 'ignored-id',
      GOOGLE_CLIENT_SECRET: 'ignored-secret',
    };
    const auth = createAuthInstance(env, {
      google: { clientId: 'explicit-id', clientSecret: 'explicit-secret' },
    });

    expect(auth.options.socialProviders?.google?.clientId).toBe('explicit-id');
    expect(auth.options.socialProviders?.google?.clientSecret).toBe('explicit-secret');
  });

  it('throws a clear error at creation time when GOOGLE_CLIENT_SECRET is missing', () => {
    const env = {
      ...validEnv,
      GOOGLE_CLIENT_ID: 'client-id-from-env',
    };
    expect(() => createAuthInstance(env, { google: true })).toThrow(/GOOGLE_CLIENT_SECRET/);
  });

  it('throws a clear error at creation time when GOOGLE_CLIENT_ID is missing', () => {
    const env = {
      ...validEnv,
      GOOGLE_CLIENT_SECRET: 'client-secret-from-env',
    };
    expect(() => createAuthInstance(env, { google: true })).toThrow(/GOOGLE_CLIENT_ID/);
  });

  it('does not configure a social provider when google is not set', () => {
    const auth = createAuthInstance(validEnv, {});
    expect(auth.options.socialProviders?.google).toBeUndefined();
  });
});
