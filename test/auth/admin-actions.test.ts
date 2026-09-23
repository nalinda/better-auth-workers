import { describe, expect, it, mock } from 'bun:test';

import { banUser, unbanUser, withAuthInstance } from '../../src/auth/admin-actions';
import { createAuth } from '../../src/index';
import { sessionCacheKey, sessionTokenOf } from '../../src/shared/session-cache';
import { buildEnv, FakeKV, postJSON } from '../helpers/auth';
import { migratedSqlite } from '../helpers/sqlite';

const API = 'https://auth.example.com/api/auth';
const PHONE = '+15550000001';

function setup() {
  const kv = new FakeKV();
  const db = migratedSqlite();
  const codes: string[] = [];
  const env = buildEnv({ DB: undefined, AUTH_KV: kv.asBinding() });
  const auth = createAuth(env, {
    phone: {
      awaitDelivery: true,
      sendOTP: ({ code }) => {
        codes.push(code);
      },
    },
    betterAuth: { database: db },
  });
  return { auth, kv, db, codes };
}

type Setup = ReturnType<typeof setup>;

// Signs in by phone and returns the user id and the signed session cookie.
async function signIn({ auth, codes }: Setup): Promise<{ userId: string; cookie: string }> {
  await auth.handler(postJSON(`${API}/phone-number/send-otp`, { phoneNumber: PHONE }));
  const res = await auth.handler(
    postJSON(`${API}/phone-number/verify`, { phoneNumber: PHONE, code: codes.at(-1) ?? '' })
  );
  const body: { user: { id: string } } = await res.json();
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';', 1)[0])
    .join('; ');
  return { userId: body.user.id, cookie };
}

function sessionTokenIn(cookie: string): string {
  const match = /__Secure-better-auth\.session_token=([^;]+)/.exec(cookie);
  return sessionTokenOf(decodeURIComponent(match?.[1] ?? ''));
}

async function getSession({ auth }: Setup, cookie: string): Promise<unknown> {
  const res = await auth.handler(
    new Request(`${API}/get-session?disableCookieCache=true`, { headers: { cookie } })
  );
  return res.json();
}

describe('banUser', () => {
  it('bans the user, revokes every session and evicts the session client cache', async () => {
    const ctx = setup();
    const first = await signIn(ctx);
    const second = await signIn(ctx);
    const cacheKeys = [first, second].map(({ cookie }) => sessionCacheKey(sessionTokenIn(cookie)));
    for (const key of cacheKeys) ctx.kv.store.set(key, '{}');

    const result = await banUser(ctx.auth, ctx.kv, first.userId, {
      reason: 'spam',
      expiresIn: 3600,
    });

    expect(result).toEqual({ found: true, revokedSessions: 2 });
    const row = ctx.db
      .query('select banned, banReason, banExpires from user where id = ?')
      .get(first.userId) as { banned: number; banReason: string; banExpires: string };
    expect(row.banned).toBe(1);
    expect(row.banReason).toBe('spam');
    expect(new Date(row.banExpires).getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(await getSession(ctx, first.cookie)).toBeNull();
    for (const key of cacheKeys) expect(ctx.kv.store.has(key)).toBe(false);
  });

  it('is permanent with a default reason when no options are given', async () => {
    const ctx = setup();
    const { userId } = await signIn(ctx);

    await banUser(ctx.auth, ctx.kv, userId);

    expect(ctx.db.query('select banReason, banExpires from user where id = ?').get(userId)).toEqual(
      { banReason: 'No reason', banExpires: null }
    );
  });

  // As in the admin plugin: an empty reason is defaulted, and an expiry that
  // is not a positive number means a permanent ban rather than one that has
  // already lapsed.
  it('treats an empty reason and a non-positive or invalid expiry like the admin plugin', async () => {
    for (const expiresIn of [0, -60, NaN]) {
      const ctx = setup();
      const { userId } = await signIn(ctx);

      await banUser(ctx.auth, ctx.kv, userId, { reason: '', expiresIn });

      expect(
        ctx.db.query('select banReason, banExpires from user where id = ?').get(userId)
      ).toEqual({ banReason: 'No reason', banExpires: null });
    }
  });

  it('stops the user signing in again', async () => {
    const ctx = setup();
    const { userId } = await signIn(ctx);
    await banUser(ctx.auth, ctx.kv, userId);

    await ctx.auth.handler(postJSON(`${API}/phone-number/send-otp`, { phoneNumber: PHONE }));
    const res = await ctx.auth.handler(
      postJSON(`${API}/phone-number/verify`, { phoneNumber: PHONE, code: ctx.codes.at(-1) ?? '' })
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'BANNED_USER' });
  });

  it('reports an unknown user and changes nothing', async () => {
    const ctx = setup();

    expect(await banUser(ctx.auth, ctx.kv, 'no-such-user')).toEqual({
      found: false,
      revokedSessions: 0,
    });
  });
});

describe('unbanUser', () => {
  it('lifts the ban so the user can sign in again', async () => {
    const ctx = setup();
    const { userId } = await signIn(ctx);
    await banUser(ctx.auth, ctx.kv, userId, { reason: 'spam' });

    expect(await unbanUser(ctx.auth, userId)).toEqual({ found: true });

    expect(
      ctx.db.query('select banned, banReason, banExpires from user where id = ?').get(userId)
    ).toEqual({ banned: 0, banReason: null, banExpires: null });
    const again = await signIn(ctx);
    expect(again.userId).toBe(userId);
  });

  it('reports an unknown user', async () => {
    expect(await unbanUser(setup().auth, 'no-such-user')).toEqual({ found: false });
  });
});

describe('withAuthInstance', () => {
  // The Hyperdrive path builds a pool per instance that only `handler`
  // releases; an RPC call never goes through `handler`.
  it('ends the pg pool it created on the Hyperdrive path, even when the action fails', async () => {
    const pools: Array<{ ended: boolean }> = [];
    class Pool {
      ended = false;
      constructor() {
        pools.push(this);
      }
      end() {
        this.ended = true;
        return Promise.resolve();
      }
    }
    const env = buildEnv({ DB: undefined });
    const options = {
      database: { hyperdrive: { connectionString: 'postgres://u:p@h:5432/d' }, pg: { Pool } },
    };

    await withAuthInstance(env, options, () => Promise.resolve());
    let failure: unknown;
    try {
      await withAuthInstance(env, options, () => Promise.reject(new Error('boom')));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(pools.map((pool) => pool.ended)).toEqual([true, true]);
  });

  it('leaves a D1 binding alone', async () => {
    const db = { prepare: mock(), batch: mock(), exec: mock(), end: mock() };
    const env = buildEnv({ DB: db as unknown as D1Database });

    await withAuthInstance(env, {}, () => Promise.resolve());

    expect(db.end).not.toHaveBeenCalled();
  });
});
