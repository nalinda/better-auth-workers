import { describe, expect, it, mock } from 'bun:test';

import { buildEnv, FakeKV, postJSON } from './helpers/auth';
import { migratedSqlite } from './helpers/sqlite';

// `cloudflare:workers` only exists in workerd; this stands in for its
// WorkerEntrypoint, which keeps `ctx` and `env` for the methods.
void mock.module('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { createAuthAdmin } = await import('../src/admin');
const { createAuth } = await import('../src/index');

const API = 'https://auth.example.com/api/auth';

describe('createAuthAdmin', () => {
  it('builds an entrypoint whose methods ban and unban with the options for its env', async () => {
    const db = migratedSqlite();
    const codes: string[] = [];
    const env = buildEnv({ DB: undefined, AUTH_KV: new FakeKV().asBinding() });
    const options = () => ({
      phone: {
        awaitDelivery: true,
        sendOTP: ({ code }: { code: string }) => {
          codes.push(code);
        },
      },
      betterAuth: { database: db },
    });
    const auth = createAuth(env, options());
    await auth.handler(postJSON(`${API}/phone-number/send-otp`, { phoneNumber: '+15550000001' }));
    const signIn = await auth.handler(
      postJSON(`${API}/phone-number/verify`, { phoneNumber: '+15550000001', code: codes[0] ?? '' })
    );
    const { user }: { user: { id: string } } = await signIn.json();
    const optionsFor = mock(options);

    const AuthAdmin = createAuthAdmin(optionsFor);
    const admin = new AuthAdmin({} as ExecutionContext, env);

    expect(await admin.banUser(user.id, { reason: 'spam' })).toEqual({
      found: true,
      revokedSessions: 1,
    });
    expect(db.query('select banned from user where id = ?').get(user.id)).toEqual({ banned: 1 });
    expect(await admin.unbanUser(user.id)).toEqual({ found: true });
    expect(db.query('select banned from user where id = ?').get(user.id)).toEqual({ banned: 0 });
    expect(optionsFor).toHaveBeenCalledWith(env);
  });
});
