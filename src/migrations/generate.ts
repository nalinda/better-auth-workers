import { getMigrations } from 'better-auth/db/migration';
import { PostgresDialect } from 'kysely';

import { schemaNameProblem } from '../auth/database';
import { buildPlugins } from '../auth/plugins';
import type { CreateAuthIdType } from '../auth/types';

export interface GeneratePostgresSqlOptions {
  // Postgres schema the tables are created in; `public` (unqualified) when
  // omitted. Must match `database.schema` passed to `createAuth`.
  schema?: string;
  // Must match `idType` passed to `createAuth`.
  idType?: CreateAuthIdType;
}

// Every sign-in method enabled, so the SQL covers the tables and columns of
// every plugin the package can register (admin, phone number, bearer, magic
// link), whichever of them a given Worker turns on.
function everyPackagePlugin() {
  return buildPlugins(
    {
      phone: { sendOTP: () => {} },
      magicLink: { sendMagicLink: () => {} },
      google: { clientId: 'unused', clientSecret: 'unused' },
      bearer: true,
    },
    { current: undefined }
  );
}

// A pool that answers Better Auth's introspection as an empty database, so
// the compiled migration creates everything. No connection is ever opened.
function emptyDatabasePool() {
  const client = {
    query: (query: unknown) => {
      const text =
        typeof query === 'string' ? query : ((query as { text?: string } | undefined)?.text ?? '');
      const rows =
        text.includes('current_schema') || text.includes('pg_namespace')
          ? [{ schema: 'public', nspname: 'public' }]
          : [];
      return Promise.resolve({ rows });
    },
    release: () => {},
  };
  return { connect: () => Promise.resolve(client) };
}

/**
 * The Postgres SQL for the package's schema, compiled by Better Auth's own
 * migration generator: the same statements `@better-auth/cli generate`
 * would produce for this package's plugins. With `schema` every table,
 * index and foreign key is qualified with it and the schema is created;
 * with `idType: 'uuid'` the ids and the `userId` references are `uuid`,
 * and ids default to `gen_random_uuid()`.
 */
export async function generatePostgresSql(
  options: GeneratePostgresSqlOptions = {}
): Promise<string> {
  const { schema } = options;
  // Typed, but the CLI and JavaScript callers can still pass anything.
  const idType: unknown = options.idType ?? 'text';
  if (schema !== undefined) {
    const problem = schemaNameProblem(schema, 'schema');
    if (problem) throw new Error(problem);
  }
  if (idType !== 'text' && idType !== 'uuid') {
    throw new Error(`idType must be "text" or "uuid", got ${JSON.stringify(idType)}`);
  }
  const { compileMigrations } = await getMigrations({
    database: {
      dialect: new PostgresDialect({ pool: emptyDatabasePool() as never }),
      type: 'postgres',
      ...(schema !== undefined && { schemaName: schema }),
    },
    ...(idType === 'uuid' && { advanced: { database: { generateId: 'uuid' } } }),
    plugins: everyPackagePlugin(),
  });
  const sql = await compileMigrations();
  return sql.trim();
}
