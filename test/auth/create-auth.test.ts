import { describe, expect, it, mock } from 'bun:test';

import type { CreateAuthSecondaryStorage } from '../../src/auth/types';
import {
  type AuthEnv,
  type AuthInstance,
  createAuth,
  type CreateAuthOptions,
} from '../../src/index';
import { sessionCacheKey } from '../../src/shared/session-cache';
import {
  buildEnv,
  createMockD1,
  createMockExecutionContext,
  FakeKV,
  postJSON,
  VALID_BASE_URL,
  VALID_SECRET,
} from '../helpers/auth';

const validEnv = buildEnv();

describe('createAuth: instance creation', () => {
  it('builds a Better Auth instance from options and bindings on env', () => {
    const auth = createAuth(validEnv, {});
    expect(typeof auth.api).toBe('object');
    expect(typeof auth.handler).toBe('function');
    expect(auth.options).toBeDefined();
  });

  it('builds a Better Auth instance using bindings on env', () => {
    const env = buildEnv();
    const auth = createAuth(env, { kv: env.AUTH_KV, database: { d1: env.DB } });
    expect(auth.options.database).toBeDefined();
    expect(auth.options.secondaryStorage).toBeDefined();
  });
});

describe('Memoisation', () => {
  it('memoises on the env object so repeated calls return the same instance', () => {
    const env = buildEnv();
    const auth1 = createAuth(env, {});
    const auth2 = createAuth(env, {});
    expect(auth1).toBe(auth2);
  });

  it('returns different instances for different env objects', () => {
    const envA = buildEnv();
    const envB = buildEnv();
    const authA1 = createAuth(envA, {});
    const authA2 = createAuth(envA, {});
    const authB = createAuth(envB, {});
    expect(authA1).toBe(authA2);
    expect(authA1).not.toBe(authB);
  });

  it('hits the cache for an options literal rebuilt inline with new callbacks and plugin objects', () => {
    const env = buildEnv();
    const build = () =>
      createAuth(env, {
        basePath: '/auth',
        phone: { sendOTP: () => {} },
        plugins: [{ id: 'audit' }],
        betterAuth: { session: { cookieCache: { maxAge: 60 } } },
      });
    expect(build()).toBe(build());
  });

  it('does not share an instance between option sets that differ in a primitive field', () => {
    const env = buildEnv();
    const a = createAuth(env, { basePath: '/a' });
    const b = createAuth(env, { basePath: '/b' });
    expect(a).not.toBe(b);
  });

  it('keeps only the most recent option shapes per env, so identity-keyed objects cannot grow it unbounded', () => {
    const env = buildEnv();
    const first = createAuth(env, {
      betterAuth: { secondaryStorage: new FakeKV().asSecondaryStorage() },
    });
    for (let i = 0; i < 8; i += 1)
      createAuth(env, { betterAuth: { secondaryStorage: new FakeKV().asSecondaryStorage() } });

    // The first shape was evicted: the same storage object builds afresh.
    const storage = first.options.secondaryStorage as unknown as CreateAuthSecondaryStorage;
    const rebuilt = createAuth(env, { betterAuth: { secondaryStorage: storage } });
    expect(rebuilt).not.toBe(first);
  });

  it('does not serialise binding contents or secrets into the cache key', () => {
    // A binding whose enumerable fields throw when read: serialising it
    // would blow up, keying it by identity does not.
    const trap = new Proxy(new FakeKV(), {
      ownKeys: () => {
        throw new Error('binding contents must not be read for the cache key');
      },
    }) as unknown as KVNamespace;
    const env = buildEnv({ AUTH_KV: trap });
    expect(() => createAuth(env, { kv: trap, secret: VALID_SECRET })).not.toThrow();
  });

  it('misses the cache when only options.secret differs, instead of sharing the first secret’s instance', () => {
    const env = buildEnv();
    const authA = createAuth(env, { secret: 'secret-a-at-least-32-chars-long-1234567' });
    const authB = createAuth(env, { secret: 'secret-b-at-least-32-chars-long-1234567' });
    expect(authA).not.toBe(authB);
    expect(authA.options.secret).toBe('secret-a-at-least-32-chars-long-1234567');
    expect(authB.options.secret).toBe('secret-b-at-least-32-chars-long-1234567');
  });

  it('misses the cache when only google.clientSecret differs', () => {
    const env = buildEnv();
    const authA = createAuth(env, { google: { clientId: 'id', clientSecret: 'secret-a' } });
    const authB = createAuth(env, { google: { clientId: 'id', clientSecret: 'secret-b' } });
    expect(authA).not.toBe(authB);
  });

  it('still hits the cache when the secret is identical across calls', () => {
    const env = buildEnv();
    const authA = createAuth(env, { secret: VALID_SECRET, basePath: '/auth' });
    const authB = createAuth(env, { secret: VALID_SECRET, basePath: '/auth' });
    expect(authA).toBe(authB);
  });
});

const sendOtp = () =>
  postJSON(`${VALID_BASE_URL}/api/auth/phone-number/send-otp`, { phoneNumber: '+15551234567' });

const getSession = () => new Request(`${VALID_BASE_URL}/api/auth/get-session`);

const pluginIds = (auth: AuthInstance) => auth.options.plugins?.map((plugin) => plugin.id) ?? [];

describe('Execution context per request', () => {
  it('schedules delivery on the context passed to handler, without any options.ctx', async () => {
    const { ctx, waitUntil, promises } = createMockExecutionContext();
    const auth = createAuth(buildEnv(), { phone: { sendOTP: () => {} } });

    const res = await auth.handler(sendOtp(), ctx);

    expect(res.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(promises);
  });

  it('uses each request’s own handler context on a memoised instance, not the one that built it', async () => {
    const env = buildEnv();
    const first = createMockExecutionContext();
    const auth1 = createAuth(env, { phone: { sendOTP: () => {} }, ctx: first.ctx });
    await auth1.handler(sendOtp(), first.ctx);
    expect(first.waitUntil).toHaveBeenCalledTimes(1);

    const second = createMockExecutionContext();
    const auth2 = createAuth(env, { phone: { sendOTP: () => {} }, ctx: second.ctx });
    expect(auth2).toBe(auth1);
    await auth2.handler(sendOtp(), second.ctx);

    expect(second.waitUntil).toHaveBeenCalledTimes(1);
    expect(first.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('refreshes the options.ctx fallback on every createAuth call for a memoised instance', async () => {
    const env = buildEnv();
    const first = createMockExecutionContext();
    const auth1 = createAuth(env, { phone: { sendOTP: () => {} }, ctx: first.ctx });
    await auth1.handler(sendOtp());
    expect(first.waitUntil).toHaveBeenCalledTimes(1);

    const second = createMockExecutionContext();
    const auth2 = createAuth(env, { phone: { sendOTP: () => {} }, ctx: second.ctx });
    expect(auth2).toBe(auth1);
    await auth2.handler(sendOtp());

    expect(second.waitUntil).toHaveBeenCalledTimes(1);
    expect(first.waitUntil).toHaveBeenCalledTimes(1);
  });
});

describe('baseURL and secret resolution', () => {
  it('throws a clear error when baseURL is missing in both options and env', () => {
    const env = { ...validEnv, AUTH_BASE_URL: undefined } as unknown as AuthEnv;
    expect(() => createAuth(env, {})).toThrow(/baseURL/i);
  });

  it('throws a clear error when secret is missing in both options and env', () => {
    const env = { ...validEnv, BETTER_AUTH_SECRET: undefined } as unknown as AuthEnv;
    expect(() => createAuth(env, {})).toThrow(/secret/i);
  });

  it('resolves baseURL from options first, taking precedence over env.AUTH_BASE_URL', () => {
    const env = buildEnv({ AUTH_BASE_URL: 'https://env.example.com' });
    const auth = createAuth(env, { baseURL: 'https://options.example.com' });
    expect(auth.options.baseURL).toBe('https://options.example.com');
  });

  it('resolves baseURL from env.AUTH_BASE_URL when options.baseURL is omitted', () => {
    const env = buildEnv({ AUTH_BASE_URL: 'https://env.example.com' });
    const auth = createAuth(env, {});
    expect(auth.options.baseURL).toBe('https://env.example.com');
  });

  it('resolves secret from options first, taking precedence over env.BETTER_AUTH_SECRET', () => {
    const env = buildEnv({ BETTER_AUTH_SECRET: 'env-secret-at-least-32-chars-long-12345' });
    const auth = createAuth(env, { secret: 'options-secret-at-least-32-chars-long-67890' });
    expect(auth.options.secret).toBe('options-secret-at-least-32-chars-long-67890');
  });

  it('resolves secret from env.BETTER_AUTH_SECRET when options.secret is omitted', () => {
    const env = buildEnv({ BETTER_AUTH_SECRET: 'env-secret-at-least-32-chars-long-12345' });
    const auth = createAuth(env, {});
    expect(auth.options.secret).toBe('env-secret-at-least-32-chars-long-12345');
  });
});

describe('Merge order and defaults', () => {
  it('passes only Better Auth options through, never the package’s own', () => {
    const { ctx } = createMockExecutionContext();
    const auth = createAuth(buildEnv(), {
      ctx,
      phone: { sendOTP: () => {} },
      google: { clientId: 'id', clientSecret: 'secret' },
      bearer: true,
      allowedMethods: ['phone'],
      database: { d1: createMockD1().asBinding() },
    });
    const options = auth.options as Record<string, unknown>;

    for (const key of ['kv', 'ctx', 'phone', 'magicLink', 'google', 'bearer', 'allowedMethods']) {
      expect(options).not.toHaveProperty(key);
    }
    // The raw `{ d1 }` option is resolved to the binding, not passed through.
    expect(typeof (options.database as { prepare?: unknown }).prepare).toBe('function');
    expect(options.plugins).toBeDefined();
    expect(options.secondaryStorage).toBeDefined();
    expect(options.socialProviders).toBeDefined();
  });

  it('shallow-merges betterAuth.socialProviders with the google option instead of replacing it', () => {
    const auth = createAuth(validEnv, {
      google: { clientId: 'id', clientSecret: 'secret' },
      betterAuth: { socialProviders: { github: { clientId: 'gh-id', clientSecret: 'gh-secret' } } },
    });
    const socialProviders = auth.options.socialProviders as Record<string, unknown>;
    expect(socialProviders.google).toEqual({ clientId: 'id', clientSecret: 'secret' });
    expect(socialProviders.github).toEqual({ clientId: 'gh-id', clientSecret: 'gh-secret' });
  });

  it('lets betterAuth.socialProviders override the same provider key it sets', () => {
    const auth = createAuth(validEnv, {
      google: { clientId: 'id', clientSecret: 'secret' },
      betterAuth: {
        socialProviders: { google: { clientId: 'override', clientSecret: 'override' } },
      },
    });
    const socialProviders = auth.options.socialProviders as Record<string, unknown>;
    expect(socialProviders.google).toEqual({ clientId: 'override', clientSecret: 'override' });
  });

  it('merges a partial betterAuth.socialProviders.google override into the resolved credentials, instead of replacing them', () => {
    // Better Auth's own `GoogleOptions` requires `clientId`/`clientSecret`,
    // so a typed caller cannot write a credential-free partial override —
    // the `betterAuth` retyping already catches this at compile time. The
    // cast below simulates an untyped (JS, or `as never`) caller, which the
    // runtime merge still has to handle safely.
    const auth = createAuth(validEnv, {
      google: { clientId: 'id', clientSecret: 'secret' },
      betterAuth: { socialProviders: { google: { scope: ['openid'] } as never } },
    });
    const socialProviders = auth.options.socialProviders as Record<string, unknown>;
    // A scope-only override must not drop the clientId/clientSecret the
    // package resolved, or sign-in fails at request time with
    // CLIENT_ID_AND_SECRET_REQUIRED despite `google: true` being configured.
    expect(socialProviders.google).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
      scope: ['openid'],
    });
  });

  it('applies package default basePath of /api/auth when not specified', () => {
    const auth = createAuth(validEnv, {});
    expect(auth.options.basePath).toBe('/api/auth');
  });

  it('allows options to override package defaults', () => {
    const auth = createAuth(validEnv, { basePath: '/custom-auth' });
    expect(auth.options.basePath).toBe('/custom-auth');
  });

  it('merges options.betterAuth last so it can override anything', () => {
    const auth = createAuth(validEnv, {
      basePath: '/custom-auth',
      betterAuth: { basePath: '/overridden-by-better-auth' },
    });
    expect(auth.options.basePath).toBe('/overridden-by-better-auth');
  });

  it('allows options.betterAuth to override baseURL and secret resolved from options and env', () => {
    const auth = createAuth(validEnv, {
      baseURL: 'https://options.example.com',
      secret: 'options-secret-at-least-32-chars-long-12345',
      betterAuth: {
        baseURL: 'https://override.example.com',
        secret: 'override-secret-at-least-32-chars-long-99999',
      },
    });
    expect(auth.options.baseURL).toBe('https://override.example.com');
    expect(auth.options.secret).toBe('override-secret-at-least-32-chars-long-99999');
  });
});

describe('Plugin configuration', () => {
  it('enables the admin plugin by default without phone or bearer plugins', () => {
    expect(pluginIds(createAuth(validEnv, {}))).toEqual(['admin']);
  });

  it('does not enable bearer or phone plugins when bearer is false and phone is undefined', () => {
    expect(pluginIds(createAuth(validEnv, { bearer: false, phone: undefined }))).toEqual(['admin']);
  });

  it('enables the phone-number plugin when options.phone is set', () => {
    const auth = createAuth(validEnv, { phone: { sendOTP: async () => {} } });
    expect(pluginIds(auth)).toEqual(['admin', 'phone-number']);
  });

  it('enables the bearer plugin when options.bearer is true', () => {
    expect(pluginIds(createAuth(validEnv, { bearer: true }))).toEqual(['admin', 'bearer']);
  });

  it('enables both phone-number and bearer plugins when both options are set', () => {
    const auth = createAuth(validEnv, { phone: { sendOTP: async () => {} }, bearer: true });
    expect(pluginIds(auth)).toEqual(['admin', 'phone-number', 'bearer']);
  });

  it('appends betterAuth.plugins after the built-in plugins instead of replacing them', () => {
    const auth = createAuth(validEnv, {
      phone: { sendOTP: async () => {} },
      bearer: true,
      allowedMethods: ['phone'],
      plugins: [{ id: 'first-party' }],
      betterAuth: { plugins: [{ id: 'escape-hatch-plugin' }] },
    });
    expect(pluginIds(auth)).toEqual([
      'admin',
      'phone-number',
      'better-auth-workers-disallowed-methods',
      'bearer',
      'first-party',
      'escape-hatch-plugin',
    ]);
  });

  it('appends options.plugins after the built-in plugins', () => {
    const auth = createAuth(validEnv, {
      phone: { sendOTP: async () => {} },
      bearer: true,
      plugins: [{ id: 'custom-audit-plugin' }],
    });
    expect(pluginIds(auth)).toEqual(['admin', 'phone-number', 'bearer', 'custom-audit-plugin']);
  });
});

describe('betterAuth is the single escape hatch, layered over the package defaults', () => {
  it('rateLimit: betterAuth.rateLimit keeps the KV storage default unless it overrides it', () => {
    const auth = createAuth(buildEnv(), { betterAuth: { rateLimit: { max: 5, window: 30 } } });
    expect(auth.options.rateLimit).toEqual({
      enabled: true,
      storage: 'secondary-storage',
      max: 5,
      window: 30,
    });

    const memory = createAuth(buildEnv(), { betterAuth: { rateLimit: { storage: 'memory' } } });
    expect(memory.options.rateLimit?.storage).toBe('memory');
  });

  it('session: betterAuth.session keeps the cookie-cache default unless it overrides it', () => {
    const auth = createAuth(buildEnv(), { betterAuth: { session: { expiresIn: 100 } } });
    expect(auth.options.session).toEqual({ expiresIn: 100, cookieCache: { enabled: true } });
  });

  it('advanced: betterAuth.advanced keeps schema validation off unless it overrides it', () => {
    const auth = createAuth(buildEnv(), {
      betterAuth: { advanced: { cookiePrefix: 'b' } },
    });
    expect(auth.options.advanced).toEqual({
      cookiePrefix: 'b',
      database: { validateSchema: false },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] },
    });
  });
});

describe('Hook composition', () => {
  it('keeps a user hooks.before when only KV (an after hook of ours) is configured', async () => {
    const before = mock(async (_ctx: unknown) => {
      await Promise.resolve();
    });
    // KV on, allowedMethods off: only our `after` hook is active.
    const auth = createAuth(buildEnv(), { betterAuth: { hooks: { before } } });

    await auth.handler(getSession());

    expect(before).toHaveBeenCalledTimes(1);
  });

  it('keeps a user hooks.after when allowedMethods (a before hook of ours) is configured', async () => {
    const after = mock(async (_ctx: unknown) => {
      await Promise.resolve();
    });
    const auth = createAuth(buildEnv(), {
      allowedMethods: ['google'],
      betterAuth: { hooks: { after } },
    });

    await auth.handler(getSession());

    expect(after).toHaveBeenCalledTimes(1);
  });

  it('runs the package’s after hook before the user’s, so a throwing user hook cannot skip invalidation', async () => {
    const kv = new FakeKV();
    const cookieToken = 'session-token-xyz';
    kv.store.set(sessionCacheKey(cookieToken), JSON.stringify({ credentials: [], session: {} }));
    const auth = createAuth(buildEnv({ AUTH_KV: kv.asBinding() }), {
      kv,
      betterAuth: {
        hooks: {
          after: () => {
            throw new Error('consumer after hook failed');
          },
        },
      },
    });
    // A sign-out endpoint context, as Better Auth hands it to `hooks.after`.
    const ctx = {
      path: '/sign-out',
      context: {
        secret: VALID_SECRET,
        authCookies: { sessionToken: { name: 'better-auth.session_token' } },
        internalAdapter: {
          findSession: () => Promise.resolve(null),
          listSessions: () => Promise.resolve([]),
        },
        returned: { success: true },
      },
      getSignedCookie: () => Promise.resolve(cookieToken),
    };

    let thrown: unknown;
    try {
      await auth.options.hooks!.after!(ctx as never);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe('consumer after hook failed');

    expect(kv.deletes).toEqual([sessionCacheKey(cookieToken)]);
  });

  it('keeps both user hooks when both of ours are active', async () => {
    const calls: string[] = [];
    const auth = createAuth(buildEnv(), {
      allowedMethods: ['google'],
      betterAuth: {
        hooks: {
          before: async () => {
            await Promise.resolve();
            calls.push('before');
          },
          after: async () => {
            await Promise.resolve();
            calls.push('after');
          },
        },
      },
    });

    await auth.handler(getSession());

    expect(calls).toEqual(['before', 'after']);
  });
});

describe('auth.api is typed with the package’s plugin endpoints', () => {
  // Compile-time (via `bun run ts-check`) as much as runtime: each of these
  // is an endpoint a plugin the package builds contributes.
  it('exposes admin, phone, magic-link and bearer endpoints on the instance', () => {
    const auth = createAuth(buildEnv(), {
      phone: { sendOTP: () => {} },
      magicLink: { sendMagicLink: () => {} },
      bearer: true,
    });

    const endpoints: Array<(...args: never[]) => unknown> = [
      auth.api.sendPhoneNumberOTP,
      auth.api.verifyPhoneNumber,
      auth.api.signInMagicLink,
      auth.api.listUsers,
      auth.api.banUser,
      auth.api.getSession,
    ];
    for (const endpoint of endpoints) expect(typeof endpoint).toBe('function');
  });

  it('types the endpoints of a method the options do not configure as possibly undefined, matching the runtime', () => {
    const auth = createAuth(buildEnv(), { magicLink: { sendMagicLink: () => {} } });

    // @ts-expect-error -- phone is not configured, so its endpoint may be undefined
    const readPhonePath = (): string => auth.api.sendPhoneNumberOTP.path;
    expect(readPhonePath).toThrow(TypeError);
    expect(auth.api.sendPhoneNumberOTP).toBeUndefined();
    // A configured method's endpoint stays required, as does admin's.
    const magicLinkPath: string = auth.api.signInMagicLink.path;
    expect(magicLinkPath).toBe('/sign-in/magic-link');
    expect(typeof auth.api.listUsers).toBe('function');

    // Loosely typed options: every optional endpoint is possibly undefined.
    const loose: CreateAuthOptions = { phone: { sendOTP: () => {} } };
    const fromLoose = createAuth(buildEnv(), loose);
    // @ts-expect-error -- the options type does not say phone is set
    const loosePath: string = fromLoose.api.sendPhoneNumberOTP.path;
    expect(loosePath).toBe('/phone-number/send-otp');
  });
});

describe('Worker route serving', () => {
  it('threads a configurable basePath into the instance options', () => {
    const auth = createAuth(validEnv, { basePath: '/custom-auth' });
    expect(auth.options.basePath).toBe('/custom-auth');
  });

  it('exposes a fetch-compatible handler a Worker or Hono route can call directly', () => {
    const auth = createAuth(validEnv, { basePath: '/auth' });
    expect(typeof auth.handler).toBe('function');
  });
});
