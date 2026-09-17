import type { AuthEnv, ConfigValue } from '../types';
import type {
  CreateAuthDatabaseOptions,
  CreateAuthOptions,
  HyperdriveDatabaseOption,
} from './options';
import { loadPgPoolClass, type PgPool } from './postgres-pool';

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
  envObj?: AuthEnv
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
  envObj?: AuthEnv
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
    return envObj.DB as D1Database;
  }
}

export function buildDatabase(options?: CreateAuthOptions, envObj?: AuthEnv): BuildDatabaseResult {
  const connectionString = resolveHyperdriveConnectionString(options, envObj);
  if (connectionString) {
    const PoolClass = loadPgPoolClass();
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

  throw new Error(
    'database is required: specify options.database.hyperdrive or options.database.d1 (or provide HYPERDRIVE or DB on env)'
  );
}
