import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { type AuthEnv, createAuth } from '../../src/index';
import { buildEnv, createMockD1 } from '../helpers/auth';

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

void mock.module('pg', () => ({
  Pool: MockPool,
  default: { Pool: MockPool },
}));

describe('D1 as the primary store', () => {
  beforeEach(() => {
    capturedPools.length = 0;
  });

  describe('D1 binding plumbing and configuration', () => {
    it('passes the D1 binding straight through as Better Auth database config when called as createAuth(env, { database: { d1 } })', () => {
      const mockD1 = createMockD1().asBinding();
      const auth = createAuth(buildEnv({ DB: undefined }), { database: { d1: mockD1 } });

      expect(auth.options.database).toBe(mockD1);
      expect(capturedPools).toHaveLength(0);
    });

    it('prefers options.database.d1 over env.DB', () => {
      const optionsD1 = createMockD1().asBinding();
      const envD1 = createMockD1().asBinding();
      const auth = createAuth(buildEnv({ DB: envD1 }), { database: { d1: optionsD1 } });

      expect(auth.options.database).toBe(optionsD1);
    });

    it('uses env.DB straight through as Better Auth database config when options.database is omitted', () => {
      const mockD1 = createMockD1().asBinding();
      const auth = createAuth(buildEnv({ DB: mockD1 }));

      expect(auth.options.database).toBe(mockD1);
      expect(capturedPools).toHaveLength(0);
    });

    it('throws a clear error when neither hyperdrive nor d1 is configured on options or env', () => {
      const envWithoutDb = buildEnv({ DB: undefined });

      expect(() => createAuth(envWithoutDb)).toThrow(/database/i);
      expect(() => createAuth(envWithoutDb, {})).toThrow(/database/i);
      expect(() => createAuth(envWithoutDb, { database: {} })).toThrow(/database/i);
    });

    it('memoises the Better Auth instance on env across calls when using D1', () => {
      const env: AuthEnv = buildEnv();

      const auth1 = createAuth(env);
      const auth2 = createAuth(env);

      expect(auth1).toBe(auth2);
    });
  });
});
