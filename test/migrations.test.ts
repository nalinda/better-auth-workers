import fs from 'node:fs';
import path from 'node:path';

import { getMigrations } from 'better-auth/db/migration';
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { buildPlugins } from '../src/auth/plugins/index';

interface PackageJson {
  name?: string;
  files?: string[];
}

interface MockQueryResult {
  rows: Array<Record<string, unknown>>;
}

interface MockClient {
  query: (sql: unknown) => Promise<MockQueryResult>;
  release: () => void;
}

interface MockPool {
  connect: () => Promise<MockClient>;
}

function readPackageJson(): PackageJson | undefined {
  const pkgPath = path.resolve(import.meta.dir, '../package.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  if (!fs.existsSync(pkgPath)) return undefined;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
}

function getMigrationFiles(databaseType: 'postgres' | 'sqlite'): string[] {
  const dirPath = path.resolve(import.meta.dir, `../migrations/${databaseType}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  if (!fs.existsSync(dirPath)) return [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  return fs
    .readdirSync(dirPath)
    .filter((file) => file.endsWith('.sql'))
    .toSorted((a, b) => a.localeCompare(b));
}

function readMigrationSql(databaseType: 'postgres' | 'sqlite'): string {
  const dirPath = path.resolve(import.meta.dir, `../migrations/${databaseType}`);
  const files = getMigrationFiles(databaseType);
  if (files.length === 0) return '';
  return files
    .map((file) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
      return fs.readFileSync(path.join(dirPath, file), 'utf8');
    })
    .join('\n')
    .trim();
}

function normalizeSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('--'))
    .join('\n');
}

// The plugin list is the package's own, with every optional sign-in method
// enabled, so a plugin added to buildPlugins that brings its own tables
// turns the drift check red instead of silently missing from the shipped SQL.
function everyPackagePlugin() {
  return buildPlugins(
    {
      phone: { sendOTP: () => {} },
      magicLink: { sendMagicLink: () => {} },
      google: { clientId: 'id', clientSecret: 'secret' },
      bearer: true,
    },
    { current: undefined }
  );
}

async function generateExpectedSchema(databaseType: 'postgres' | 'sqlite'): Promise<string> {
  const plugins = everyPackagePlugin();

  if (databaseType === 'sqlite') {
    const db = new Database(':memory:');
    const { compileMigrations } = await getMigrations({
      database: db,
      plugins,
    });
    const compiled = await compileMigrations();
    return compiled.trim();
  }

  const dummyClient: MockClient = {
    query: (queryText: unknown) => {
      const text =
        typeof queryText === 'string'
          ? queryText
          : ((queryText as { text?: string } | undefined)?.text ?? '');
      if (text.includes('current_schema') || text.includes('pg_namespace')) {
        return Promise.resolve({ rows: [{ schema: 'public', nspname: 'public' }] });
      }
      return Promise.resolve({ rows: [] });
    },
    release: () => {},
  };

  const pool: MockPool = {
    connect: () => Promise.resolve(dummyClient),
  };

  const { compileMigrations } = await getMigrations({
    database: pool as unknown as never,
    plugins,
  });
  const compiled = await compileMigrations();
  return compiled.trim();
}

describe('SQL migrations publishing and schema drift', () => {
  describe('package distribution', () => {
    it('package.json includes migrations in files whitelist', () => {
      const pkg = readPackageJson();
      expect(pkg?.files).toContain('migrations');
    });
  });

  describe('migration files', () => {
    it('ships SQL migration files under migrations/postgres', () => {
      const files = getMigrationFiles('postgres');
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((file) => file.endsWith('.sql'))).toBe(true);
    });

    it('ships SQL migration files under migrations/sqlite', () => {
      const files = getMigrationFiles('sqlite');
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((file) => file.endsWith('.sql'))).toBe(true);
    });
  });

  describe('schema definition', () => {
    it('Postgres migration creates core tables and columns for admin and phone plugins', () => {
      const sql = readMigrationSql('postgres');
      expect(sql).toContain('create table "user"');
      expect(sql).toContain('create table "session"');
      expect(sql).toContain('create table "account"');
      expect(sql).toContain('create table "verification"');
      expect(sql).toContain('"role"');
      expect(sql).toContain('"banned"');
      expect(sql).toContain('"phoneNumber"');
      expect(sql).toContain('"phoneNumberVerified"');
      expect(sql).toContain('"impersonatedBy"');
    });

    it('SQLite migration creates core tables and columns for admin and phone plugins', () => {
      const sql = readMigrationSql('sqlite');
      expect(sql).toContain('create table "user"');
      expect(sql).toContain('create table "session"');
      expect(sql).toContain('create table "account"');
      expect(sql).toContain('create table "verification"');
      expect(sql).toContain('"role"');
      expect(sql).toContain('"banned"');
      expect(sql).toContain('"phoneNumber"');
      expect(sql).toContain('"phoneNumberVerified"');
      expect(sql).toContain('"impersonatedBy"');
    });
  });

  describe('schema drift verification', () => {
    it('regenerated Postgres schema matches committed migrations without drift', async () => {
      const committedSql = readMigrationSql('postgres');
      const expectedSql = await generateExpectedSchema('postgres');
      expect(normalizeSql(committedSql)).toBe(normalizeSql(expectedSql));
    });

    it('regenerated SQLite schema matches committed migrations without drift', async () => {
      const committedSql = readMigrationSql('sqlite');
      const expectedSql = await generateExpectedSchema('sqlite');
      expect(normalizeSql(committedSql)).toBe(normalizeSql(expectedSql));
    });
  });
});
