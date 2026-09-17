import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
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

  describe('SQLite schema verification', () => {
    it('verifies the default schema plus phone-number, admin and bearer plugin tables work on SQLite', async () => {
      const sqliteDb = new Database(':memory:');
      const { betterAuth } = await import('better-auth');
      const { getMigrations } =
        await import('../node_modules/better-auth/dist/db/get-migration.mjs');
      const { admin, bearer, phoneNumber } = await import('better-auth/plugins');

      const auth = betterAuth({
        baseURL: validBaseUrl,
        secret: validSecret,
        database: sqliteDb,
        plugins: [
          admin(),
          phoneNumber({
            sendOTP: () => {},
          }),
          bearer(),
        ],
      });

      const { toBeCreated, runMigrations } = await getMigrations(auth.options);
      expect(toBeCreated.length).toBeGreaterThan(0);

      const tableNames = toBeCreated.map((t: { table: string }) => t.table);
      expect(tableNames).toContain('user');
      expect(tableNames).toContain('session');
      expect(tableNames).toContain('account');
      expect(tableNames).toContain('verification');

      await runMigrations();

      const createdTables = sqliteDb
        .query("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const createdNames = createdTables.map((t) => t.name);

      expect(createdNames).toContain('user');
      expect(createdNames).toContain('session');
      expect(createdNames).toContain('account');
      expect(createdNames).toContain('verification');

      const userCols = (
        sqliteDb.query('PRAGMA table_info(user)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(userCols).toContain('id');
      expect(userCols).toContain('email');
      expect(userCols).toContain('role');
      expect(userCols).toContain('banned');
      expect(userCols).toContain('phoneNumber');
      expect(userCols).toContain('phoneNumberVerified');

      const sessionCols = (
        sqliteDb.query('PRAGMA table_info(session)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(sessionCols).toContain('id');
      expect(sessionCols).toContain('token');
      expect(sessionCols).toContain('userId');
      expect(sessionCols).toContain('impersonatedBy');

      sqliteDb.run(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role, phoneNumber)
         VALUES ('u1', 'Alice', 'alice@example.com', 1, 1000, 1000, 'admin', '+1234567890')`
      );
      const userRow = sqliteDb.query("SELECT * FROM user WHERE id = 'u1'").get() as any;
      expect(userRow?.name).toBe('Alice');
      expect(userRow?.role).toBe('admin');
      expect(userRow?.phoneNumber).toBe('+1234567890');

      sqliteDb.close();
    });
  });
});
