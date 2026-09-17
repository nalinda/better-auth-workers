import type { AuthEnv, ConfigValue } from '../types';
import { loadPgPoolClass, type PgPool } from './postgres-pool';
import type {
  CreateAuthDatabaseOptions,
  CreateAuthOptions,
  HyperdriveDatabaseOption,
} from './types';

export type ResolvedDatabase =
  PgPool | D1Database | Record<string, (arg?: string) => void> | ConfigValue;

interface BuildDatabaseResult {
  database: ResolvedDatabase;
  pool?: PgPool;
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
): D1Database | Record<string, (arg?: string) => void> | undefined {
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
function resolvePgPoolClass(
  options?: CreateAuthOptions
): (new (config: { connectionString?: string; max?: number }) => PgPool) | undefined {
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
      return { database: pool, pool };
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

// Reports the same "is a database resolvable" question as resolveDatabase,
// without instantiating a pg Pool, so validation can run without the
// side effect of opening a connection.
export function databaseProblem(
  options?: CreateAuthOptions,
  envObj?: Partial<AuthEnv>
): string | undefined {
  const hasDatabase =
    resolveHyperdriveConnectionString(options, envObj) !== undefined ||
    resolveD1Binding(options, envObj) !== undefined ||
    Boolean(options?.betterAuth?.database);
  return hasDatabase ? undefined : DATABASE_MISSING_MESSAGE;
}
