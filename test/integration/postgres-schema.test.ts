import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import pg from 'pg';

import { createAuth } from '../../src/index';
import { generatePostgresSql } from '../../src/migrations/generate';
import { buildEnv, createMockExecutionContext, FakeKV, postJSON } from '../helpers/auth';
import { type PostgresHandle, provisionPostgres, requestedBackends } from './harness';

// Runs createAuth in-process against a real Postgres (the CI service
// container, or a local Docker one) with the tables in their own schema and
// uuid ids, applying the SQL the CLI generates for those options. Part of
// the Hyperdrive backend: skipped unless INTEGRATION_BACKENDS includes it.

const SCHEMA = 'auth_ba';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE = 'https://auth.example.com/api/auth';

const isEnabled = requestedBackends().includes('hyperdrive');

describe.skipIf(!isEnabled)('Postgres with a custom schema and uuid ids', () => {
  let postgres: PostgresHandle;
  let db: SQL;
  const kv = new FakeKV();
  const sentCodes = new Map<string, string>();

  beforeAll(async () => {
    postgres = await provisionPostgres(
      await generatePostgresSql({ schema: SCHEMA, idType: 'uuid' })
    );
    db = new SQL(postgres.connectionString);
  }, 120_000);

  afterAll(async () => {
    await db.close();
    await postgres.stop();
  });

  // One instance per request, as on Workers: the Hyperdrive path owns a
  // pool per request and releases it after the response.
  async function send(request: Request): Promise<Response> {
    const auth = createAuth(buildEnv({ DB: undefined, AUTH_KV: kv.asBinding() }), {
      database: { hyperdrive: { connectionString: postgres.connectionString }, pg, schema: SCHEMA },
      idType: 'uuid',
      phone: {
        sendOTP: ({ phoneNumber, code }) => {
          sentCodes.set(phoneNumber, code);
        },
      },
    });
    const { ctx, promises } = createMockExecutionContext();
    const response = await auth.handler(request, ctx);
    await Promise.all(promises);
    return response;
  }

  async function signInByPhone(phoneNumber: string): Promise<{ user: { id: string } }> {
    const sent = await send(postJSON(`${BASE}/phone-number/send-otp`, { phoneNumber }));
    expect(sent.status).toBe(200);
    const code = sentCodes.get(phoneNumber);
    expect(code).toBeDefined();
    const verified = await send(
      postJSON(`${BASE}/phone-number/verify`, { phoneNumber, code: code ?? '' })
    );
    expect(verified.status).toBe(200);
    const body: { user: { id: string } } = await verified.json();
    return body;
  }

  it('signs up a new phone user with a uuid id, in the schema', async () => {
    const { user } = await signInByPhone('+15550000001');

    expect(user.id).toMatch(UUID);
    const rows: Array<{ id: string }> = await db.unsafe(
      `select id::text as id from "${SCHEMA}"."user" where "phoneNumber" = $1`,
      ['+15550000001']
    );
    expect(rows).toEqual([{ id: user.id }]);
  });

  // The consumer migrates its existing users into Better Auth's table with
  // the uuids its own tables already reference.
  it('signs in a user inserted by SQL with a caller-chosen uuid', async () => {
    const id = crypto.randomUUID();
    await db.unsafe(
      `insert into "${SCHEMA}"."user" (id, name, email, "emailVerified", "phoneNumber", "phoneNumberVerified")
       values ($1, 'Existing', 'existing@phone.invalid', false, '+15550000002', true)`,
      [id]
    );

    const { user } = await signInByPhone('+15550000002');

    expect(user.id).toBe(id);
    const counts: Array<{ count: number }> = await db.unsafe(
      `select count(*)::int as count from "${SCHEMA}"."user" where "phoneNumber" = $1`,
      ['+15550000002']
    );
    expect(counts).toEqual([{ count: 1 }]);
  });

  it('creates nothing in public', async () => {
    const tables: Array<{ table_name: string }> = await db.unsafe(
      `select table_name from information_schema.tables where table_schema = 'public'`
    );
    expect(tables).toEqual([]);
    const authTables: Array<{ table_name: string }> = await db.unsafe(
      `select table_name from information_schema.tables where table_schema = $1 order by table_name`,
      [SCHEMA]
    );
    expect(authTables.map((row) => row.table_name)).toEqual([
      'account',
      'session',
      'user',
      'verification',
    ]);
  });
});
