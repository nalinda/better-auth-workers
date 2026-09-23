import fs from 'node:fs';
import path from 'node:path';

import { getMigrations } from 'better-auth/db/migration';
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { buildPlugins } from '../src/auth/plugins/index';
import { generatePostgresSql } from '../src/migrations/generate';

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

// A table reference in the generated SQL: a quoted name, optionally
// schema-qualified, after the keyword that introduces it.
// eslint-disable-next-line security/detect-unsafe-regex -- fixed pattern, run only over the generator's own output
const TABLE_REFERENCE = /(?:create table|on|references) ("[^"]+"(?:\."[^"]+")?)/g;

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('generatePostgresSql', () => {
  // The shipped Postgres migration is the generator's default output, so a
  // consumer who generates with no options gets exactly what ships.
  it('with no options, matches the shipped Postgres migration', async () => {
    expect(normalizeSql(await generatePostgresSql())).toBe(
      normalizeSql(readMigrationSql('postgres'))
    );
  });

  describe('with a schema and uuid ids', () => {
    const generated = generatePostgresSql({ schema: 'auth_ba', idType: 'uuid' });

    it('creates the schema before anything in it', async () => {
      const statements = normalizeSql(await generated).split('\n');
      expect(statements[0]).toBe('create schema if not exists "auth_ba";');
    });

    it('creates and references every table only inside the schema', async () => {
      const sql = await generated;
      const tableRefs = sql.matchAll(TABLE_REFERENCE).toArray();
      expect(tableRefs.length).toBeGreaterThan(0);
      for (const [, ref] of tableRefs) {
        expect(ref).toMatch(/^"auth_ba"\./);
      }
    });

    it('makes every id a uuid with a database default', async () => {
      const sql = await generated;
      const ids = sql
        .matchAll(/"id" ([^,]+?) primary key/g)
        .map(([, type]) => type)
        .toArray();
      expect(ids).toHaveLength(4);
      for (const type of ids) {
        expect(type).toBe('uuid default pg_catalog.gen_random_uuid() not null');
      }
    });

    it('makes every reference to user.id a uuid', async () => {
      const sql = await generated;
      const refs = sql.matchAll(/"userId" (\w+) not null references/g).toArray();
      expect(refs).toHaveLength(2);
      for (const [, type] of refs) {
        expect(type).toBe('uuid');
      }
    });
  });

  it('with only a schema, keeps text ids', async () => {
    const sql = await generatePostgresSql({ schema: 'auth_ba' });
    expect(sql).toContain('create table "auth_ba"."user" ("id" text not null primary key');
    expect(sql).not.toContain('uuid');
  });

  it('refuses a schema name it could not safely quote', async () => {
    for (const schema of ['auth"ba', 'Auth', 'auth ba', '']) {
      const error = await rejectionOf(generatePostgresSql({ schema }));
      expect(String(error)).toMatch(/schema must be/);
    }
  });

  it('refuses an unknown id type', async () => {
    const error = await rejectionOf(generatePostgresSql({ idType: 'serial' as never }));
    expect(String(error)).toMatch(/idType must be "text" or "uuid"/);
  });
});
