import fs from 'node:fs';
import path from 'node:path';

import { Database } from 'bun:sqlite';

// An in-memory SQLite database with the shipped SQLite migration applied,
// handed to createAuth through `betterAuth.database`, for route tests that
// need real rows (users, accounts) rather than a statement double.
export function migratedSqlite(): Database {
  const db = new Database(':memory:');
  const migration = path.resolve(import.meta.dir, '../../migrations/sqlite/0001_init.sql');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  db.run(fs.readFileSync(migration, 'utf8'));
  return db;
}
