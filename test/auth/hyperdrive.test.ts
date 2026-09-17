import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createAuth } from '../../src/index';

interface MockPoolConfig {
  connectionString?: string;
  max?: number;
  [key: string]: unknown;
}

const capturedPools: MockPool[] = [];

class MockPool {
  options: MockPoolConfig;
  endCalls = 0;
  ended = false;

  constructor(options: MockPoolConfig) {
    this.options = options;
    capturedPools.push(this);
  }

  connect = mock(() =>
    Promise.resolve({
      query: mock((_sql: unknown) => Promise.resolve({ rows: [] })),
      release: mock(() => {}),
    })
  );

  end = mock(() => {
    this.endCalls++;
    this.ended = true;
    return Promise.resolve();
  });
}

mock.module('pg', () => ({
  Pool: MockPool,
  default: { Pool: MockPool },
}));

interface CreateAuthOptions {
  basePath?: string;
  baseURL?: string;
  secret?: string;
  database?: { hyperdrive?: unknown; d1?: unknown };
  kv?: unknown;
  ctx?: { waitUntil: (promise: Promise<unknown>) => void; passThroughOnException?: () => void };
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

// Typed wrapper to allow calling createAuth with env, options and handler context across red and green phases
const createAuthInstance = (env: Record<string, unknown>, options?: CreateAuthOptions): any =>
  (createAuth as unknown as (e: Record<string, unknown>, o?: CreateAuthOptions) => any)(
    env,
    options
  );

describe('Postgres through Hyperdrive with a per-request pg Pool', () => {
  const validSecret = 'test-secret-at-least-32-chars-long-1234567890';
  const validBaseUrl = 'https://auth.example.com';
  const validEnv = {
    AUTH_BASE_URL: validBaseUrl,
    BETTER_AUTH_SECRET: validSecret,
  };

  beforeEach(() => {
    capturedPools.length = 0;
  });

  describe('Pool construction and configuration', () => {
    it('constructs a pg Pool from env.HYPERDRIVE.connectionString with a bounded max', () => {
      const connectionString = 'postgres://user:pass@hyperdrive.local:5432/authdb';
      const env = {
        ...validEnv,
        HYPERDRIVE: { connectionString },
      };

      createAuthInstance(env, {
        database: { hyperdrive: env.HYPERDRIVE },
      });

      expect(capturedPools.length).toBe(1);
      const pool = capturedPools[0]!;
      expect(pool.options.connectionString).toBe(connectionString);
      expect(typeof pool.options.max).toBe('number');
      expect(pool.options.max!).toBeGreaterThan(0);
      expect(pool.options.max!).toBeLessThanOrEqual(10);
    });

    it('hands the pg Pool to Better Auth database option', () => {
      const connectionString = 'postgres://user:pass@hyperdrive.local:5432/authdb';
      const env = {
        ...validEnv,
        HYPERDRIVE: { connectionString },
      };

      const auth = createAuthInstance(env, {
        database: { hyperdrive: env.HYPERDRIVE },
      });

      expect(capturedPools.length).toBe(1);
      expect(auth?.options?.database).toBe(capturedPools[0]);
    });

    it('creates a pg Pool automatically when env.HYPERDRIVE is present and database option is omitted', () => {
      const connectionString = 'postgres://user:pass@hyperdrive.local:5432/defaultdb';
      const env = {
        ...validEnv,
        HYPERDRIVE: { connectionString },
      };

      const auth = createAuthInstance(env);

      expect(capturedPools.length).toBe(1);
      expect(capturedPools[0]!.options.connectionString).toBe(connectionString);
      expect(auth?.options?.database).toBe(capturedPools[0]);
    });

    it('supports database: { hyperdrive } in options when passed explicitly', () => {
      const customConnectionString = 'postgres://custom:pass@custom-hyperdrive:5432/db';
      const customHyperdrive = { connectionString: customConnectionString };
      const env = { ...validEnv };

      createAuthInstance(env, {
        database: { hyperdrive: customHyperdrive },
      });

      expect(capturedPools.length).toBe(1);
      expect(capturedPools[0]!.options.connectionString).toBe(customConnectionString);
    });
  });

  describe('Pool lifecycle and cleanup', () => {
    it('ends the pool exactly once via ctx.waitUntil when an execution context is passed to the handler', async () => {
      const env = {
        ...validEnv,
        HYPERDRIVE: {
          connectionString: 'postgres://user:pass@hyperdrive.local:5432/authdb',
        },
      };
      const ctx = {
        waitUntil: mock((_promise: Promise<unknown>) => {}),
        passThroughOnException: mock(() => {}),
      };

      const auth = createAuthInstance(env, {
        database: { hyperdrive: env.HYPERDRIVE },
        ctx,
        betterAuth: { advanced: { database: { validateSchema: false } } },
      });

      const req = new Request('https://auth.example.com/api/auth/ok');
      try {
        await auth.handler(req, ctx);
      } catch {
        // Red phase: adapter initialization may error before hyperdrive pool support is implemented
      }

      expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
      expect(capturedPools[0]?.endCalls).toBe(1);
    });

    it('ends the pool exactly once via ctx.waitUntil after the handler settles even if the handler throws or rejects', async () => {
      const env = {
        ...validEnv,
        HYPERDRIVE: {
          connectionString: 'postgres://user:pass@hyperdrive.local:5432/authdb',
        },
      };
      const ctx = {
        waitUntil: mock((_promise: Promise<unknown>) => {}),
        passThroughOnException: mock(() => {}),
      };

      const auth = createAuthInstance(env, {
        database: { hyperdrive: env.HYPERDRIVE },
        ctx,
        plugins: [
          {
            id: 'failing-test-plugin',
            onRequest: () => {
              throw new Error('Simulated handler error');
            },
          },
        ],
        betterAuth: { advanced: { database: { validateSchema: false } } },
      });

      const req = new Request('https://auth.example.com/api/auth/failing-route');
      try {
        await auth.handler(req, ctx);
      } catch {
        // Handler rejection expected
      }

      expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
      expect(capturedPools[0]?.endCalls).toBe(1);
    });

    it('schedules ending the pool on the next tick without blocking the response when no execution context is passed', async () => {
      const env = {
        ...validEnv,
        HYPERDRIVE: {
          connectionString: 'postgres://user:pass@hyperdrive.local:5432/authdb',
        },
      };

      const auth = createAuthInstance(env, {
        database: { hyperdrive: env.HYPERDRIVE },
        betterAuth: { advanced: { database: { validateSchema: false } } },
      });

      let poolEndedBeforeSettlement = false;
      let handlerResolved = false;

      const req = new Request('https://auth.example.com/api/auth/ok');
      try {
        const handlerPromise = auth.handler(req);
        if (capturedPools[0]) {
          const originalEnd = capturedPools[0].end;
          capturedPools[0].end = mock(() => {
            if (!handlerResolved) poolEndedBeforeSettlement = true;
            return originalEnd();
          });
        }
        await handlerPromise;
        handlerResolved = true;
      } catch {
        handlerResolved = true;
      }

      // Allow the scheduled next-tick task to execute
      await new Promise((r) => setTimeout(r, 10));

      expect(poolEndedBeforeSettlement).toBe(false);
      expect(capturedPools[0]?.endCalls).toBe(1);
    });
  });

  describe('Per-request pool isolation', () => {
    it('creates a new Pool for a second request rather than reusing an ended one', async () => {
      const env = {
        ...validEnv,
        HYPERDRIVE: {
          connectionString: 'postgres://user:pass@hyperdrive.local:5432/authdb',
        },
      };

      const ctx1 = {
        waitUntil: mock((_p: Promise<unknown>) => {}),
        passThroughOnException: mock(() => {}),
      };
      const auth1 = createAuthInstance(env, {
        database: { hyperdrive: env.HYPERDRIVE },
        ctx: ctx1,
        betterAuth: { advanced: { database: { validateSchema: false } } },
      });

      try {
        await auth1.handler(new Request('https://auth.example.com/api/auth/ok'), ctx1);
      } catch {}

      const ctx2 = {
        waitUntil: mock((_p: Promise<unknown>) => {}),
        passThroughOnException: mock(() => {}),
      };
      const auth2 = createAuthInstance(env, {
        database: { hyperdrive: env.HYPERDRIVE },
        ctx: ctx2,
        betterAuth: { advanced: { database: { validateSchema: false } } },
      });

      try {
        await auth2.handler(new Request('https://auth.example.com/api/auth/ok'), ctx2);
      } catch {}

      expect(capturedPools.length).toBe(2);
      expect(capturedPools[0]).not.toBe(capturedPools[1]);
      expect(capturedPools[0]?.ended).toBe(true);
      expect(capturedPools[1]?.ended).toBe(true);
    });

    it('prevents pool leaks across repeated sequential requests', async () => {
      const env = {
        ...validEnv,
        HYPERDRIVE: {
          connectionString: 'postgres://user:pass@hyperdrive.local:5432/authdb',
        },
      };

      const requestCount = 50;
      for (let i = 0; i < requestCount; i++) {
        const ctx = {
          waitUntil: mock((_p: Promise<unknown>) => {}),
          passThroughOnException: mock(() => {}),
        };
        const auth = createAuthInstance(env, {
          database: { hyperdrive: env.HYPERDRIVE },
          ctx,
          betterAuth: { advanced: { database: { validateSchema: false } } },
        });

        try {
          await auth.handler(new Request('https://auth.example.com/api/auth/ok'), ctx);
        } catch {}
      }

      expect(capturedPools.length).toBe(requestCount);
      const activePools = capturedPools.filter((p) => !p.ended || p.endCalls !== 1);
      expect(activePools.length).toBe(0);
    });
  });
});
