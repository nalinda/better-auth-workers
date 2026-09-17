import { describe, expect, it } from 'bun:test';
import { createAuth } from '../src/index';

interface CreateAuthOptions {
  basePath?: string;
  baseURL?: string;
  secret?: string;
  database?: { hyperdrive: unknown } | { d1: unknown };
  kv?: unknown;
  phone?: {
    sendOTP: (
      args: { phoneNumber: string; code: string },
      request?: Request
    ) => Promise<void> | void;
    otpLength?: number;
    expiresIn?: number;
    allowedAttempts?: number;
  };
  google?: boolean | { clientId: string; clientSecret: string };
  bearer?: boolean;
  allowedMethods?: Array<'phone' | 'google' | 'magic-link'>;
  plugins?: Array<{ id: string; [key: string]: unknown }>;
  betterAuth?: Record<string, unknown>;
  [key: string]: unknown;
}

// Typed wrapper to allow calling createAuth with env and options across red and green phases
const createAuthInstance = (env: Record<string, unknown>, options?: CreateAuthOptions): any =>
  (createAuth as unknown as (e: Record<string, unknown>, o?: CreateAuthOptions) => any)(
    env,
    options
  );

describe('Issue #2: createAuth: per-request Better Auth instance memoised on env', () => {
  const validSecret = 'test-secret-at-least-32-chars-long-1234567890';
  const validBaseUrl = 'https://auth.example.com';
  const validEnv = {
    AUTH_BASE_URL: validBaseUrl,
    BETTER_AUTH_SECRET: validSecret,
  };

  describe('Instance creation', () => {
    it('builds a Better Auth instance from options and bindings on env', () => {
      const auth = createAuthInstance(validEnv, {});
      expect(typeof auth?.api).toBe('object');
      expect(typeof auth?.handler).toBe('function');
      expect(auth?.options).toBeDefined();
    });
  });

  describe('Memoisation', () => {
    it('memoises on the env object so repeated calls return the same instance', () => {
      const env = { ...validEnv };
      const auth1 = createAuthInstance(env, {});
      const auth2 = createAuthInstance(env, {});
      expect(auth1).toBe(auth2);
    });

    it('returns different instances for different env objects', () => {
      const envA = { ...validEnv, id: 'a' };
      const envB = { ...validEnv, id: 'b' };
      const authA1 = createAuthInstance(envA, {});
      const authA2 = createAuthInstance(envA, {});
      const authB = createAuthInstance(envB, {});
      expect(authA1).toBe(authA2);
      expect(authA1).not.toBe(authB);
    });
  });

  describe('baseURL and secret resolution', () => {
    it('throws a clear error when baseURL is missing in both options and env', () => {
      const env = { BETTER_AUTH_SECRET: validSecret };
      expect(() => createAuthInstance(env, {})).toThrow(/baseURL/i);
    });

    it('throws a clear error when secret is missing in both options and env', () => {
      const env = { AUTH_BASE_URL: validBaseUrl };
      expect(() => createAuthInstance(env, {})).toThrow(/secret/i);
    });

    it('resolves baseURL from options first, taking precedence over env.AUTH_BASE_URL', () => {
      const env = {
        AUTH_BASE_URL: 'https://env.example.com',
        BETTER_AUTH_SECRET: validSecret,
      };
      const auth = createAuthInstance(env, { baseURL: 'https://options.example.com' });
      expect(auth?.options?.baseURL).toBe('https://options.example.com');
    });

    it('resolves baseURL from env.AUTH_BASE_URL when options.baseURL is omitted', () => {
      const env = {
        AUTH_BASE_URL: 'https://env.example.com',
        BETTER_AUTH_SECRET: validSecret,
      };
      const auth = createAuthInstance(env, {});
      expect(auth?.options?.baseURL).toBe('https://env.example.com');
    });

    it('resolves secret from options first, taking precedence over env.BETTER_AUTH_SECRET', () => {
      const env = {
        AUTH_BASE_URL: validBaseUrl,
        BETTER_AUTH_SECRET: 'env-secret-at-least-32-chars-long-12345',
      };
      const auth = createAuthInstance(env, {
        secret: 'options-secret-at-least-32-chars-long-67890',
      });
      expect(auth?.options?.secret).toBe('options-secret-at-least-32-chars-long-67890');
    });

    it('resolves secret from env.BETTER_AUTH_SECRET when options.secret is omitted', () => {
      const env = {
        AUTH_BASE_URL: validBaseUrl,
        BETTER_AUTH_SECRET: 'env-secret-at-least-32-chars-long-12345',
      };
      const auth = createAuthInstance(env, {});
      expect(auth?.options?.secret).toBe('env-secret-at-least-32-chars-long-12345');
    });
  });

  describe('Merge order and defaults', () => {
    it('applies package default basePath of /api/auth when not specified', () => {
      const auth = createAuthInstance(validEnv, {});
      expect(auth?.options?.basePath).toBe('/api/auth');
    });

    it('allows options to override package defaults', () => {
      const auth = createAuthInstance(validEnv, { basePath: '/custom-auth' });
      expect(auth?.options?.basePath).toBe('/custom-auth');
    });

    it('merges options.betterAuth last so it can override anything', () => {
      const auth = createAuthInstance(validEnv, {
        basePath: '/custom-auth',
        betterAuth: {
          basePath: '/overridden-by-better-auth',
        },
      });
      expect(auth?.options?.basePath).toBe('/overridden-by-better-auth');
    });
  });

  describe('Plugin configuration', () => {
    it('enables the admin plugin by default without phone or bearer plugins', () => {
      const auth = createAuthInstance(validEnv, {});
      const pluginIds = auth?.options?.plugins?.map((p: any) => p.id) ?? [];
      expect(pluginIds).toEqual(['admin']);
    });

    it('enables the phone-number plugin when options.phone is set', () => {
      const auth = createAuthInstance(validEnv, {
        phone: {
          sendOTP: async () => {},
        },
      });
      const pluginIds = auth?.options?.plugins?.map((p: any) => p.id) ?? [];
      expect(pluginIds).toEqual(['admin', 'phone-number']);
    });

    it('enables the bearer plugin when options.bearer is true', () => {
      const auth = createAuthInstance(validEnv, {
        bearer: true,
      });
      const pluginIds = auth?.options?.plugins?.map((p: any) => p.id) ?? [];
      expect(pluginIds).toEqual(['admin', 'bearer']);
    });

    it('enables both phone-number and bearer plugins when both options are set', () => {
      const auth = createAuthInstance(validEnv, {
        phone: {
          sendOTP: async () => {},
        },
        bearer: true,
      });
      const pluginIds = auth?.options?.plugins?.map((p: any) => p.id) ?? [];
      expect(pluginIds).toEqual(['admin', 'phone-number', 'bearer']);
    });

    it('appends options.plugins after the built-in plugins', () => {
      const customPlugin = { id: 'custom-audit-plugin' };
      const auth = createAuthInstance(validEnv, {
        phone: {
          sendOTP: async () => {},
        },
        bearer: true,
        plugins: [customPlugin],
      });
      const pluginIds = auth?.options?.plugins?.map((p: any) => p.id) ?? [];
      expect(pluginIds).toEqual(['admin', 'phone-number', 'bearer', 'custom-audit-plugin']);
    });
  });

  describe('Worker route serving', () => {
    it('serves Better Auth routes under a configurable basePath', async () => {
      const auth = createAuthInstance(validEnv, { basePath: '/custom-auth' });
      const response = await auth.handler(new Request('https://auth.example.com/custom-auth/ok'));
      expect(response.status).toBe(200);
    });

    it('serves Better Auth routes from a Worker request handler', async () => {
      const worker = {
        async fetch(request: Request, env: Record<string, unknown>) {
          const auth = createAuthInstance(env, { basePath: '/auth' });
          return auth.handler(request);
        },
      };
      const response = await worker.fetch(
        new Request('https://auth.example.com/auth/ok'),
        validEnv
      );
      expect(response.status).toBe(200);
    });
  });
});
