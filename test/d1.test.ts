import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createAuth } from '../src/index';

interface MockPoolConfig {
  connectionString?: string;
  max?: number;
  [key: string]: unknown;
}

const capturedPools: MockPool[] = [];

class MockPool {
  options: MockPoolConfig;
  constructor(options: MockPoolConfig) {
    this.options = options;
    capturedPools.push(this);
  }
}

mock.module('pg', () => ({
  Pool: MockPool,
  default: { Pool: MockPool },
}));

function createMockD1() {
  return {
    prepare: mock((_query: string) => ({
      bind: mock((..._params: unknown[]) => ({
        all: mock(() => Promise.resolve({ results: [], success: true, meta: { changes: 0 } })),
        first: mock(() => Promise.resolve(null)),
        run: mock(() => Promise.resolve({ success: true, meta: { changes: 0 } })),
      })),
    })),
    batch: mock((_stmts: unknown[]) => Promise.resolve([])),
    exec: mock((_query: string) => Promise.resolve({ count: 0, duration: 0 })),
  };
}

describe('D1 as the primary store', () => {
  const validSecret = 'test-secret-at-least-32-chars-long-1234567890';
  const validBaseUrl = 'https://auth.example.com';
  const validEnv = {
    AUTH_BASE_URL: validBaseUrl,
    BETTER_AUTH_SECRET: validSecret,
  };

  beforeEach(() => {
    capturedPools.length = 0;
  });

  describe('D1 binding plumbing and configuration', () => {
    it('passes the D1 binding straight through as Better Auth database config when called as createAuth({ database: { d1 } }, env)', () => {
      const mockD1 = createMockD1();
      const env = { ...validEnv };
      const auth = (createAuth as any)(
        {
          database: { d1: mockD1 },
        },
        env
      );

      expect(auth?.options?.database).toBe(mockD1);
      expect(capturedPools.length).toBe(0);
    });

    it('passes the D1 binding straight through when called as createAuth(env, { database: { d1 } })', () => {
      const mockD1 = createMockD1();
      const env = { ...validEnv };
      const auth = (createAuth as any)(env, {
        database: { d1: mockD1 },
      });

      expect(auth?.options?.database).toBe(mockD1);
      expect(capturedPools.length).toBe(0);
    });

    it('uses env.DB straight through as Better Auth database config when options.database is omitted', () => {
      const mockD1 = createMockD1();
      const envWithD1 = {
        ...validEnv,
        DB: mockD1,
      };

      const auth = (createAuth as any)(envWithD1);

      expect(auth?.options?.database).toBe(mockD1);
      expect(capturedPools.length).toBe(0);
    });

    it('throws a clear error when neither hyperdrive nor d1 is configured on options or env', () => {
      const envWithoutDb = {
        AUTH_BASE_URL: validBaseUrl,
        BETTER_AUTH_SECRET: validSecret,
      };

      expect(() => (createAuth as any)(envWithoutDb)).toThrow(/database/i);
      expect(() => (createAuth as any)(envWithoutDb, {})).toThrow(/database/i);
      expect(() => (createAuth as any)(envWithoutDb, { database: {} })).toThrow(/database/i);
      expect(() => (createAuth as any)({}, envWithoutDb)).toThrow(/database/i);
    });

    it('memoises the Better Auth instance on env across calls when using D1', () => {
      const mockD1 = createMockD1();
      const envWithD1 = {
        ...validEnv,
        DB: mockD1,
      };

      const auth1 = (createAuth as any)(envWithD1);
      const auth2 = (createAuth as any)(envWithD1);

      expect(auth1).toBe(auth2);
    });
  });
});
