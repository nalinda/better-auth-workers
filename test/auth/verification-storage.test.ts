import { describe, expect, it } from 'bun:test';

import { createAuth, type CreateAuthOptions } from '../../src/index';
import { buildEnv, FakeKV, postJSON } from '../helpers/auth';
import { migratedSqlite } from '../helpers/sqlite';

// Cloudflare KV refuses a second write (put or delete) to one key within a
// second. FakeKV does not; this one does, so these tests fail for any
// verification value that still goes through KV.
class StrictKV extends FakeKV {
  private readonly lastWrite = new Map<string, number>();

  // The refusal, if this write comes within a second of the last to `key`.
  private refusedWrite(key: string): Error | undefined {
    const now = Date.now();
    const last = this.lastWrite.get(key);
    if (last !== undefined && now - last < 1000) {
      return new Error(`KV write to ${key} failed: 429 Too Many Requests`);
    }
    this.lastWrite.set(key, now);
  }

  override put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const refused = this.refusedWrite(key);
    return refused ? Promise.reject(refused) : super.put(key, value, options);
  }

  override delete(key: string): Promise<void> {
    const refused = this.refusedWrite(key);
    return refused ? Promise.reject(refused) : super.delete(key);
  }
}

const API = 'https://auth.example.com/api/auth';
const PHONE = '+15550000001';

function setup(options: Partial<CreateAuthOptions> = {}) {
  const kv = new StrictKV();
  const db = migratedSqlite();
  const codes: string[] = [];
  const links: string[] = [];
  const auth = createAuth(buildEnv({ DB: undefined, AUTH_KV: kv.asBinding() }), {
    phone: {
      sendOTP: ({ code }) => {
        codes.push(code);
      },
    },
    magicLink: {
      sendMagicLink: ({ url }) => {
        links.push(url);
      },
    },
    betterAuth: { database: db },
    ...options,
  });
  return { auth, kv, db, codes, links };
}

async function settle(): Promise<void> {
  // sendOTP / sendMagicLink run under waitUntil-style non-blocking delivery.
  await Bun.sleep(0);
}

describe('verification values in the primary database', () => {
  it('stores phone codes in the database, never in KV', async () => {
    const { auth, kv, db } = setup();

    await auth.handler(postJSON(`${API}/phone-number/send-otp`, { phoneNumber: PHONE }));

    expect(db.query('select identifier from verification').all()).toEqual([{ identifier: PHONE }]);
    expect(kv.store.keys().some((key) => key.startsWith('verification:'))).toBe(false);
  });

  // A wrong guess deletes the code and writes it back with the attempt
  // counted, within the same second; on KV the write-back was refused and
  // the code lost.
  it('keeps the code usable after a wrong guess, under KV write limits', async () => {
    const { auth, codes } = setup();
    await auth.handler(postJSON(`${API}/phone-number/send-otp`, { phoneNumber: PHONE }));
    await settle();
    const right = codes[0] ?? '';
    const wrong = right === '000000' ? '111111' : '000000';

    const guessed = await auth.handler(
      postJSON(`${API}/phone-number/verify`, { phoneNumber: PHONE, code: wrong })
    );
    const verified = await auth.handler(
      postJSON(`${API}/phone-number/verify`, { phoneNumber: PHONE, code: right })
    );

    expect(guessed.status).toBe(400);
    expect(await guessed.json()).toMatchObject({ code: 'INVALID_OTP' });
    expect(verified.status).toBe(200);
  });

  it('keeps magic-link tokens in the database, so a link works under KV write limits', async () => {
    const { auth, kv, db, links } = setup();
    await auth.handler(
      postJSON(`${API}/sign-in/magic-link`, { email: 'a@example.com', callbackURL: '/home' })
    );
    await settle();

    expect(db.query('select count(*) as n from verification').get()).toEqual({ n: 1 });
    expect(kv.store.keys().some((key) => key.startsWith('verification:'))).toBe(false);
    const res = await auth.handler(new Request(links[0] ?? ''));
    expect(res.headers.getSetCookie().some((cookie) => cookie.includes('session_token='))).toBe(
      true
    );
  });

  // The sweep as wired into createAuth: a fresh env, so its interval is
  // unspent.
  it('deletes expired verification rows when a magic link is sent', async () => {
    const { auth, db } = setup();
    db.run(
      "insert into verification (id, identifier, value, expiresAt, createdAt, updatedAt) values ('old', 'stale', 'x', ?, ?, ?)",
      [
        new Date(Date.now() - 60_000).toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      ]
    );

    await auth.handler(
      postJSON(`${API}/sign-in/magic-link`, { email: 'a@example.com', callbackURL: '/home' })
    );

    const ids = db.query('select id from verification').all() as Array<{ id: string }>;
    expect(ids.map((row) => row.id)).not.toContain('old');
    expect(ids).toHaveLength(1);
  });

  it('tells Better Auth to use the database for verification values', () => {
    const { auth } = setup();

    expect(auth.options.verification?.storeInDatabase).toBe(true);
  });

  // Spread over the default, an explicit undefined would switch the database
  // off while the KV storage still declines these values.
  it('treats an explicit storeInDatabase: undefined as unset', async () => {
    const { auth, codes } = setup({
      betterAuth: { database: migratedSqlite(), verification: { storeInDatabase: undefined } },
    });
    await auth.handler(postJSON(`${API}/phone-number/send-otp`, { phoneNumber: PHONE }));
    await settle();

    const verified = await auth.handler(
      postJSON(`${API}/phone-number/verify`, { phoneNumber: PHONE, code: codes[0] ?? '' })
    );

    expect(auth.options.verification?.storeInDatabase).toBe(true);
    expect(verified.status).toBe(200);
  });

  it('refuses storeInDatabase: false with the package KV storage', () => {
    expect(() =>
      createAuth(buildEnv(), { betterAuth: { verification: { storeInDatabase: false } } })
    ).toThrow(/storeInDatabase: false is not supported/);
  });

  it('leaves the choice to a consumer who brings their own secondary storage', () => {
    const own = new FakeKV().asSecondaryStorage();
    const auth = createAuth(buildEnv(), {
      betterAuth: { secondaryStorage: own, verification: { storeInDatabase: false } },
    });

    expect(auth.options.verification?.storeInDatabase).toBe(false);
  });
});
