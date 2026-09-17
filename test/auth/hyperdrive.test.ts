import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

import { createAuth } from '../../src/index';
import { buildEnv, createMockExecutionContext, VALID_BASE_URL } from '../helpers/auth';

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

  constructor(options: MockPoolConfig) {
    this.options = options;
    capturedPools.push(this);
  }
}

// The package reaches the driver through `require('pg')` when no
// `database.pg` is supplied. `mock.module` only intercepts ESM imports of an
// installed package (and another test file's mock would shadow an `import`
// here), so the CommonJS module object the package sees is patched instead.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- must be the same module object `require('pg')` in src resolves to
const pgModule = require('pg') as { Pool: unknown };
const realPool = pgModule.Pool;

beforeAll(() => {
  pgModule.Pool = MockPool;
});

afterAll(() => {
  pgModule.Pool = realPool;
});

// Hyperdrive bindings in tests are plain objects carrying only the
// connection string, which is all the package reads off the binding.
function hyperdrive(connectionString: string): Hyperdrive {
  return { connectionString } as Hyperdrive;
}

describe('Postgres through Hyperdrive with a per-request pg Pool', () => {
  // No D1 binding: the Hyperdrive binding is the database.
  const validEnv = buildEnv({ DB: undefined });
  const DEFAULT_CONNECTION_STRING = 'postgres://user:pass@hyperdrive.local:5432/authdb';

  beforeEach(() => {
    capturedPools.length = 0;
  });

  describe('Pool construction and configuration', () => {
    it('constructs a pg Pool from env.HYPERDRIVE.connectionString with a bounded max', () => {
      const connectionString = 'postgres://user:pass@hyperdrive.local:5432/authdb';
      const env = { ...validEnv, HYPERDRIVE: hyperdrive(connectionString) };

      createAuth(env, {
        database: { hyperdrive: env.HYPERDRIVE },
      });

      expect(capturedPools).toHaveLength(1);
      const pool = capturedPools[0];
      expect(pool.options.connectionString).toBe(connectionString);
      expect(typeof pool.options.max).toBe('number');
      expect(pool.options.max!).toBeGreaterThan(0);
      expect(pool.options.max!).toBeLessThanOrEqual(10);
    });

    it('constructs the Pool from a pg driver passed as database.pg, as a bundled Worker must', () => {
      const connectionString = 'postgres://user:pass@hyperdrive.local:5432/authdb';
      const env = { ...validEnv, HYPERDRIVE: hyperdrive(connectionString) };
      const suppliedPools: MockPoolConfig[] = [];
      class SuppliedPool {
        end = () => Promise.resolve();
        constructor(options: MockPoolConfig) {
          suppliedPools.push(options);
        }
      }

      const auth = createAuth(env, {
        database: { hyperdrive: env.HYPERDRIVE, pg: { Pool: SuppliedPool } },
      });

      expect(capturedPools).toHaveLength(0);
      expect(suppliedPools).toHaveLength(1);
      expect(suppliedPools[0]?.connectionString).toBe(connectionString);
      expect(auth.options.database).toBeInstanceOf(SuppliedPool);
    });

    it('hands the pg Pool to Better Auth database option', () => {
      const connectionString = 'postgres://user:pass@hyperdrive.local:5432/authdb';
      const env = { ...validEnv, HYPERDRIVE: hyperdrive(connectionString) };

      const auth = createAuth(env, {
        database: { hyperdrive: env.HYPERDRIVE },
      });

      expect(capturedPools).toHaveLength(1);
      expect(auth.options.database as unknown).toBe(capturedPools[0]);
    });

    it('creates a pg Pool automatically when env.HYPERDRIVE is present and database option is omitted', () => {
      const connectionString = 'postgres://user:pass@hyperdrive.local:5432/defaultdb';
      const env = { ...validEnv, HYPERDRIVE: hyperdrive(connectionString) };

      const auth = createAuth(env);

      expect(capturedPools).toHaveLength(1);
      expect(capturedPools[0].options.connectionString).toBe(connectionString);
      expect(auth.options.database as unknown).toBe(capturedPools[0]);
    });

    it('supports database: { hyperdrive } in options when passed explicitly', () => {
      const customConnectionString = 'postgres://custom:pass@custom-hyperdrive:5432/db';
      const customHyperdrive = hyperdrive(customConnectionString);
      const env = { ...validEnv };

      createAuth(env, {
        database: { hyperdrive: customHyperdrive },
      });

      expect(capturedPools).toHaveLength(1);
      expect(capturedPools[0].options.connectionString).toBe(customConnectionString);
    });
  });

  describe('Pool lifecycle and cleanup', () => {
    it('ends the pool exactly once via ctx.waitUntil when an execution context is passed to the handler', async () => {
      const env = { ...validEnv, HYPERDRIVE: hyperdrive(DEFAULT_CONNECTION_STRING) };
      const { ctx, waitUntil } = createMockExecutionContext();

      const auth = createAuth(env, {
        database: { hyperdrive: env.HYPERDRIVE },
        ctx,
        betterAuth: { advanced: { database: { validateSchema: false } } },
      });

      const req = new Request(`${VALID_BASE_URL}/api/auth/ok`);
      try {
        await auth.handler(req, ctx);
      } catch {
        // Red phase: adapter initialization may error before hyperdrive pool support is implemented
      }

      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(capturedPools[0]?.endCalls).toBe(1);
    });

    it('ends the pool exactly once via ctx.waitUntil after the handler settles even if the handler throws or rejects', async () => {
      const env = { ...validEnv, HYPERDRIVE: hyperdrive(DEFAULT_CONNECTION_STRING) };
      const { ctx, waitUntil } = createMockExecutionContext();

      const auth = createAuth(env, {
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

      const req = new Request(`${VALID_BASE_URL}/api/auth/failing-route`);
      try {
        await auth.handler(req, ctx);
      } catch {
        // Handler rejection expected
      }

      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(capturedPools[0]?.endCalls).toBe(1);
    });

    it('schedules ending the pool on the next tick without blocking the response when no execution context is passed', async () => {
      const env = { ...validEnv, HYPERDRIVE: hyperdrive(DEFAULT_CONNECTION_STRING) };

      const auth = createAuth(env, {
        database: { hyperdrive: env.HYPERDRIVE },
        betterAuth: { advanced: { database: { validateSchema: false } } },
      });

      let isPoolEndedBeforeSettlement = false;
      let isHandlerResolved = false;

      const req = new Request(`${VALID_BASE_URL}/api/auth/ok`);
      try {
        const handlerPromise = auth.handler(req);
        if (capturedPools[0]) {
          const originalEnd = capturedPools[0].end;
          capturedPools[0].end = mock(() => {
            if (!isHandlerResolved) isPoolEndedBeforeSettlement = true;
            return originalEnd();
          });
        }
        await handlerPromise;
        isHandlerResolved = true;
      } catch {
        isHandlerResolved = true;
      }

      // Allow the scheduled next-tick task to execute
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(isPoolEndedBeforeSettlement).toBe(false);
      expect(capturedPools[0]?.endCalls).toBe(1);
    });
  });

  describe('Pool release failure without a context', () => {
    it('logs a rejected end() instead of leaving it as an unhandled rejection', async () => {
      const env = { ...validEnv, HYPERDRIVE: hyperdrive(DEFAULT_CONNECTION_STRING) };
      const auth = createAuth(env, { database: { hyperdrive: env.HYPERDRIVE } });
      expect(capturedPools).toHaveLength(1);
      const pool = capturedPools[0];
      pool.end = mock(() => Promise.reject(new Error('socket dropped')));

      const errors: unknown[][] = [];
      const unhandled: unknown[] = [];
      const originalError = console.error;
      const onUnhandled = (event: PromiseRejectionEvent) => {
        unhandled.push(event.reason);
        event.preventDefault();
      };
      console.error = (...args: unknown[]) => {
        errors.push(args);
      };
      addEventListener('unhandledrejection', onUnhandled);
      try {
        await auth.handler(new Request(`${VALID_BASE_URL}/api/auth/ok`));
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        console.error = originalError;
        removeEventListener('unhandledrejection', onUnhandled);
      }

      expect(unhandled).toHaveLength(0);
      expect(errors.some((args) => String(args[0]).includes('failed to release the pg Pool'))).toBe(
        true
      );
    });
  });

  describe('pg driver is required', () => {
    it('throws a clear error at creation when neither database.pg nor a loadable pg module provides a Pool', () => {
      const env = { ...validEnv, HYPERDRIVE: hyperdrive(DEFAULT_CONNECTION_STRING) };
      const withoutPool = pgModule as { Pool: unknown; default?: unknown };
      const savedDefault = withoutPool.default;
      withoutPool.Pool = undefined;
      withoutPool.default = undefined;
      try {
        expect(() => createAuth(env, { database: { hyperdrive: env.HYPERDRIVE } })).toThrow(
          /database\.pg is required with Hyperdrive/
        );
        expect(capturedPools).toHaveLength(0);
      } finally {
        withoutPool.Pool = MockPool;
        withoutPool.default = savedDefault;
      }
    });
  });

  describe('Instance is single-use', () => {
    it('refuses a second handler call on the same instance instead of using the released pool', async () => {
      const env = { ...validEnv, HYPERDRIVE: hyperdrive(DEFAULT_CONNECTION_STRING) };
      const { ctx } = createMockExecutionContext();
      const auth = createAuth(env, { database: { hyperdrive: env.HYPERDRIVE }, ctx });

      await auth.handler(new Request(`${VALID_BASE_URL}/api/auth/ok`), ctx);
      expect(capturedPools[0]?.endCalls).toBe(1);

      let refused: unknown;
      try {
        await auth.handler(new Request(`${VALID_BASE_URL}/api/auth/ok`), ctx);
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).message).toMatch(/already served a request/);
      expect(capturedPools[0]?.endCalls).toBe(1);
    });

    it('never memoises a Hyperdrive instance, so each createAuth call gets its own pool', () => {
      const env = { ...validEnv, HYPERDRIVE: hyperdrive(DEFAULT_CONNECTION_STRING) };
      const auth1 = createAuth(env, { database: { hyperdrive: env.HYPERDRIVE } });
      const auth2 = createAuth(env, { database: { hyperdrive: env.HYPERDRIVE } });

      expect(auth1).not.toBe(auth2);
      expect(capturedPools).toHaveLength(2);
    });
  });

  describe('Per-request pool isolation', () => {
    it('creates a new Pool for a second request rather than reusing an ended one', async () => {
      const env = { ...validEnv, HYPERDRIVE: hyperdrive(DEFAULT_CONNECTION_STRING) };

      const { ctx: ctx1 } = createMockExecutionContext();
      const auth1 = createAuth(env, {
        database: { hyperdrive: env.HYPERDRIVE },
        ctx: ctx1,
        betterAuth: { advanced: { database: { validateSchema: false } } },
      });

      try {
        await auth1.handler(new Request(`${VALID_BASE_URL}/api/auth/ok`), ctx1);
      } catch {
        // the mocked handler may reject; only the pool lifecycle is under test
      }

      const { ctx: ctx2 } = createMockExecutionContext();
      const auth2 = createAuth(env, {
        database: { hyperdrive: env.HYPERDRIVE },
        ctx: ctx2,
        betterAuth: { advanced: { database: { validateSchema: false } } },
      });

      try {
        await auth2.handler(new Request(`${VALID_BASE_URL}/api/auth/ok`), ctx2);
      } catch {
        // the mocked handler may reject; only the pool lifecycle is under test
      }

      expect(capturedPools).toHaveLength(2);
      expect(capturedPools[0]).not.toBe(capturedPools[1]);
      expect(capturedPools[0]?.ended).toBe(true);
      expect(capturedPools[1]?.ended).toBe(true);
    });

    it('prevents pool leaks across repeated sequential requests', async () => {
      const env = { ...validEnv, HYPERDRIVE: hyperdrive(DEFAULT_CONNECTION_STRING) };

      const requestCount = 50;
      for (let i = 0; i < requestCount; i++) {
        const { ctx } = createMockExecutionContext();
        const auth = createAuth(env, {
          database: { hyperdrive: env.HYPERDRIVE },
          ctx,
          betterAuth: { advanced: { database: { validateSchema: false } } },
        });

        try {
          await auth.handler(new Request(`${VALID_BASE_URL}/api/auth/ok`), ctx);
        } catch {
          // the mocked handler may reject; only the pool lifecycle is under test
        }
      }

      expect(capturedPools).toHaveLength(requestCount);
      const activePools = capturedPools.filter((p) => !p.ended || p.endCalls !== 1);
      expect(activePools).toHaveLength(0);
    });
  });
});
