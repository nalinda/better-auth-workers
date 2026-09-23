import { PostgresDialect } from 'kysely';

import type { AuthEnv, ConfigValue } from '../types';
import { loadPgPoolClass, type PgPool, type PgPoolConstructor } from './postgres-pool';
import type {
  CreateAuthDatabaseOptions,
  CreateAuthOptions,
  HyperdriveDatabaseOption,
} from './types';

// What Better Auth is handed as `database`: a pg Pool on the Hyperdrive
// path, the D1 binding on the D1 path, or whatever `betterAuth.database`
// supplied through the escape hatch.
export type ResolvedDatabase = PgPool | D1Database | ConfigValue;

interface BuildDatabaseResult {
  database: ResolvedDatabase;
  pool?: PgPool;
}

// A Postgres schema name as the generator and Better Auth's `schemaName`
// accept it: an unquoted lower-case identifier, within Postgres's 63-byte
// limit, so the same name works quoted in the SQL and in every query.
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function schemaNameProblem(schema: string, label = 'database.schema'): string | undefined {
  if (SCHEMA_NAME.test(schema)) return;
  return `${label} must be a lower-case Postgres identifier (letters, digits and underscores, starting with a letter or underscore, at most 63 characters), got ${JSON.stringify(schema)}`;
}

// With a schema, Better Auth is handed its dialect form rather than the bare
// pool, since only that form carries `schemaName`; `transaction: true`
// matches what it infers for a bare pool. `end` keeps the documented
// contract that a Worker calling `auth.api.*` directly releases the pool
// through `auth.options.database.end()`.
function withSchema(pool: PgPool, schema: string): ResolvedDatabase {
  return {
    dialect: new PostgresDialect({ pool: pool as never }),
    type: 'postgres',
    schemaName: schema,
    transaction: true,
    end: () => pool.end(),
  };
}

function getDatabaseSchema(options?: CreateAuthOptions): string | undefined {
  const database = options?.database;
  if (database && typeof database === 'object' && 'schema' in database) {
    return database.schema;
  }
}

function getHyperdriveOption(
  database?: CreateAuthDatabaseOptions | D1Database
): HyperdriveDatabaseOption | undefined {
  if (database && typeof database === 'object' && 'hyperdrive' in database) {
    return database.hyperdrive;
  }
}

export function resolveHyperdriveConnectionString(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): string | undefined {
  const hyperdriveOption = getHyperdriveOption(options?.database);
  if (
    hyperdriveOption &&
    typeof hyperdriveOption === 'object' &&
    'connectionString' in hyperdriveOption &&
    typeof hyperdriveOption.connectionString === 'string'
  ) {
    return hyperdriveOption.connectionString;
  }
  if (options?.database !== undefined) {
    return;
  }
  const envHyperdrive = envObj?.HYPERDRIVE as { connectionString?: string } | undefined;
  if (
    envHyperdrive &&
    typeof envHyperdrive === 'object' &&
    typeof envHyperdrive.connectionString === 'string'
  ) {
    return envHyperdrive.connectionString;
  }
}

function resolveD1Binding(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): D1Database | undefined {
  const databaseOpt = options?.database;
  if (databaseOpt && typeof databaseOpt === 'object') {
    if ('d1' in databaseOpt && databaseOpt.d1) {
      return databaseOpt.d1;
    }
    if ('prepare' in databaseOpt || 'batch' in databaseOpt) {
      return databaseOpt as D1Database;
    }
  }

  if (options?.database === undefined && envObj?.DB) {
    return envObj.DB;
  }
}

// The `pg` driver comes from the consumer (`database.pg`) when the Worker
// is bundled, since a bundler only includes modules it can see imported;
// `require('pg')` is a fallback for runtimes that resolve modules at
// runtime (Bun, Node).
function resolvePgPoolClass(options?: CreateAuthOptions): PgPoolConstructor | undefined {
  const database = options?.database;
  if (database && typeof database === 'object' && 'pg' in database && database.pg) {
    return database.pg.Pool;
  }
  return loadPgPoolClass();
}

export function resolveDatabase(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): BuildDatabaseResult | undefined {
  const connectionString = resolveHyperdriveConnectionString(options, envObj);
  if (connectionString) {
    const PoolClass = resolvePgPoolClass(options);
    if (PoolClass) {
      const pool = new PoolClass({
        connectionString,
        max: 5,
      });
      const schema = getDatabaseSchema(options);
      return { database: schema === undefined ? pool : withSchema(pool, schema), pool };
    }
  }

  const d1 = resolveD1Binding(options, envObj);
  if (d1) {
    return { database: d1 };
  }

  if (options?.betterAuth?.database) {
    return { database: options.betterAuth.database };
  }
}

const DATABASE_MISSING_MESSAGE =
  'database is required: specify options.database.hyperdrive or options.database.d1 (or provide HYPERDRIVE or DB on env)';

const SCHEMA_WITHOUT_POSTGRES_MESSAGE =
  'database.schema is only supported with Postgres through Hyperdrive; D1 has no schemas';

const PG_DRIVER_MISSING_MESSAGE =
  "database.pg is required with Hyperdrive: import pg from 'pg' and pass database: { hyperdrive, pg } (a bundled Worker only includes modules it imports itself)";

// Reports the same "is a database resolvable" question as resolveDatabase,
// without instantiating a pg Pool, so validation can run without the
// side effect of opening a connection. A Hyperdrive binding without a pg
// driver to open it is reported here too, instead of surfacing as Better
// Auth's opaque adapter error on the first request.
export function databaseProblem(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): string | undefined {
  const schema = getDatabaseSchema(options);
  if (resolveHyperdriveConnectionString(options, envObj) !== undefined) {
    if (!resolvePgPoolClass(options)) return PG_DRIVER_MISSING_MESSAGE;
    return schema === undefined ? undefined : schemaNameProblem(schema);
  }
  const hasDatabase =
    resolveD1Binding(options, envObj) !== undefined || Boolean(options?.betterAuth?.database);
  if (!hasDatabase) return DATABASE_MISSING_MESSAGE;
  return schema === undefined ? undefined : SCHEMA_WITHOUT_POSTGRES_MESSAGE;
}
