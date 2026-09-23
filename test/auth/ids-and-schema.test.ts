import { describe, expect, it, mock } from 'bun:test';

import { createAuth, type CreateAuthOptions } from '../../src/index';
import { buildEnv, FakeKV } from '../helpers/auth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A pg Pool double that records the text of every statement it is sent and
// answers each with an empty result.
function recordingPg() {
  const statements: string[] = [];
  const pools: Array<{ ended: boolean }> = [];
  class Pool {
    ended = false;
    constructor() {
      pools.push(this);
    }
    connect() {
      return Promise.resolve({
        query: (query: unknown) => {
          statements.push(
            typeof query === 'string' ? query : ((query as { text?: string }).text ?? '')
          );
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
        release: () => {},
      });
    }
    end() {
      this.ended = true;
      return Promise.resolve();
    }
  }
  return { pg: { Pool }, statements, pools };
}

function hyperdriveAuth(options: Partial<CreateAuthOptions> & { pg: { Pool: unknown } }) {
  const { pg, ...rest } = options;
  return createAuth(buildEnv({ DB: undefined }), {
    ...rest,
    database: {
      hyperdrive: { connectionString: 'postgres://u:p@hyperdrive.local:5432/db' },
      pg: pg as never,
      ...rest.database,
    },
  });
}

async function findUserByEmail(auth: ReturnType<typeof createAuth>): Promise<void> {
  const ctx = await auth.$context;
  await ctx.adapter.findOne({ model: 'user', where: [{ field: 'email', value: 'a@b.c' }] });
}

async function tryCreateUser(auth: ReturnType<typeof createAuth>): Promise<void> {
  const ctx = await auth.$context;
  try {
    await ctx.adapter.create({
      model: 'user',
      data: { email: 'a@b.c', name: 'A', emailVerified: false },
    });
  } catch {
    // The double returns no row for `returning`; only the statement matters.
  }
}

describe('database.schema on Postgres', () => {
  it('qualifies every query with the schema', async () => {
    const { pg, statements } = recordingPg();
    const auth = hyperdriveAuth({ pg, database: { schema: 'auth_ba' } });

    await findUserByEmail(auth);

    const userQueries = statements.filter((sql) => sql.includes('"user"'));
    expect(userQueries.length).toBeGreaterThan(0);
    for (const sql of userQueries) {
      expect(sql).toContain('"auth_ba"."user"');
    }
  });

  it('leaves queries unqualified without a schema', async () => {
    const { pg, statements } = recordingPg();
    const auth = hyperdriveAuth({ pg });

    await findUserByEmail(auth);

    const userQueries = statements.filter((sql) => sql.includes('"user"'));
    expect(userQueries.length).toBeGreaterThan(0);
    expect(userQueries.some((sql) => sql.includes('"auth_ba"'))).toBe(false);
    expect(auth.options.database).toBeDefined();
  });

  // The README's contract for Workers that call `auth.api.*` directly: the
  // pool they must release is reachable through `auth.options.database`.
  it('keeps the pool releasable through auth.options.database.end()', async () => {
    const { pg, pools } = recordingPg();
    const auth = hyperdriveAuth({ pg, database: { schema: 'auth_ba' } });

    await (auth.options.database as { end: () => Promise<void> }).end();

    expect(pools).toHaveLength(1);
    expect(pools[0]?.ended).toBe(true);
  });

  it('rejects a schema name that is not a plain lower-case identifier', () => {
    const { pg } = recordingPg();
    for (const schema of [
      'Auth',
      'auth-ba',
      'auth"; drop table x; --',
      '1auth',
      '',
      'a'.repeat(64),
      'pg_auth',
    ]) {
      expect(() => hyperdriveAuth({ pg, database: { schema } })).toThrow(
        /database\.schema must be a lower-case Postgres identifier/
      );
    }
  });

  it('rejects a schema on D1, which has no schemas', () => {
    expect(() =>
      createAuth(buildEnv(), { database: { d1: buildEnv().DB as D1Database, schema: 'auth_ba' } })
    ).toThrow(/database\.schema is only supported with Postgres/);
  });
});

describe('idType', () => {
  it('on Postgres, leaves uuid ids to the database default', async () => {
    const { pg, statements } = recordingPg();
    const auth = hyperdriveAuth({ pg, idType: 'uuid' });

    await tryCreateUser(auth);

    const insert = statements.find((sql) => sql.startsWith('insert into "user"'));
    expect(insert).toBeDefined();
    expect(insert).not.toMatch(/\("id",|, "id"[,)]/);
  });

  it('on Postgres with the default text ids, generates the id itself', async () => {
    const { pg, statements } = recordingPg();
    const auth = hyperdriveAuth({ pg });

    await tryCreateUser(auth);

    const insert = statements.find((sql) => sql.startsWith('insert into "user"'));
    expect(insert).toMatch(/"id"/);
  });

  it('on D1, generates a UUID and stores it as text', async () => {
    const bound: unknown[][] = [];
    const statement = (params: unknown[] = []) => ({
      bind: (...next: unknown[]) => statement(next),
      all: () => {
        bound.push(params);
        return Promise.resolve({ results: [], success: true, meta: { changes: 1 } });
      },
      first: () => Promise.resolve(null),
      run: () => {
        bound.push(params);
        return Promise.resolve({ success: true, meta: { changes: 1 } });
      },
      raw: () => Promise.resolve([]),
    });
    const d1 = {
      prepare: mock(() => statement()),
      batch: mock(() => Promise.resolve([])),
      exec: mock(() => Promise.resolve({ count: 0, duration: 0 })),
    } as unknown as D1Database;
    const auth = createAuth(buildEnv({ DB: d1, AUTH_KV: new FakeKV().asBinding() }), {
      idType: 'uuid',
    });

    await tryCreateUser(auth);

    const ids = bound.flat().filter((value) => typeof value === 'string' && UUID.test(value));
    expect(ids.length).toBeGreaterThan(0);
  });

  it('rejects an unknown idType', () => {
    expect(() => createAuth(buildEnv(), { idType: 'UUID' as never })).toThrow(
      /idType must be "text" or "uuid"/
    );
  });

  it('lets betterAuth.advanced.database.generateId override it', () => {
    const auth = createAuth(buildEnv(), {
      idType: 'uuid',
      betterAuth: { advanced: { database: { generateId: false } } },
    });

    expect(auth.options.advanced?.database?.generateId).toBe(false);
  });
});
