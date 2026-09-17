import { describe, expect, it } from 'bun:test';

import { type AuthEnv, createAuth, type CreateAuthOptions } from '../../src/index';
import { buildEnv, createMockD1, FakeKV, VALID_SECRET } from '../helpers/auth';

// Type-level contract, checked by `bun run ts-check` (which compiles the
// test tree): `AuthEnv` and `CreateAuthOptions` are closed types, so a
// mistyped binding or a misspelled option is a compile error, not a
// runtime surprise. `AuthEnv`'s fields are optional (each is a fallback for
// an `options` field), so an env that binds nothing under the package's
// names still type-checks and is caught by startup validation instead.
// Each directive below would itself error if the expression stopped
// failing to type-check.
function typeContract(env: AuthEnv, options: CreateAuthOptions): unknown[] {
  const bindsElsewhere: AuthEnv = {};
  // @ts-expect-error AUTH_KV must be a KVNamespace, not a string
  const wrongKv: AuthEnv = { ...env, AUTH_KV: 'not-a-namespace' };
  // @ts-expect-error `magicLinks` is not an option; `magicLink` is
  const misspelled: CreateAuthOptions = { ...options, magicLinks: {} };
  // @ts-expect-error unknown Better Auth options go through `betterAuth`, not the top level
  const stray: CreateAuthOptions = { ...options, trustedOrigins: [] };
  return [bindsElsewhere, wrongKv, misspelled, stray];
}

describe('createAuth: combined missing-binding diagnostics', () => {
  it('throws a single error naming every missing binding, not just the first', () => {
    // baseURL, secret, database and kv are all unresolvable from either
    // options or env, mirroring a WorkerEnv typed as AuthEnv but missing
    // AUTH_BASE_URL, BETTER_AUTH_SECRET, AUTH_KV, and both HYPERDRIVE and DB.
    const env = {} as AuthEnv;

    let caught: Error | undefined;
    try {
      createAuth(env, {});
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/4 problems/);
    expect(caught?.message).toMatch(/baseURL/i);
    expect(caught?.message).toMatch(/secret/i);
    expect(caught?.message).toMatch(/database/i);
    expect(caught?.message).toMatch(/kv is required/);
  });

  it('throws a single error naming missing Google credentials alongside other missing bindings', () => {
    const env = {} as AuthEnv;

    let caught: Error | undefined;
    try {
      createAuth(env, { google: true });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/baseURL/i);
    expect(caught?.message).toMatch(/GOOGLE_CLIENT_ID/);
    expect(caught?.message).toMatch(/GOOGLE_CLIENT_SECRET/);
  });

  it('does not throw when every required binding is resolvable', () => {
    expect(() => createAuth(buildEnv(), {})).not.toThrow();
  });

  it('accepts an env that binds under other names when the values come through options', () => {
    // A Worker's own Env extends AuthEnv but binds under its own names;
    // nothing the package reads from env is present, so no cast is needed.
    interface WorkerEnv extends AuthEnv {
      SESSIONS: KVNamespace;
      AUTH_DB: D1Database;
    }
    const env: WorkerEnv = {
      SESSIONS: new FakeKV().asBinding(),
      AUTH_DB: createMockD1().asBinding(),
    };
    expect(() =>
      createAuth(env, {
        baseURL: 'https://auth.example.com',
        secret: VALID_SECRET,
        kv: env.SESSIONS,
        database: { d1: env.AUTH_DB },
      })
    ).not.toThrow();
  });

  it('exposes the type contract helper so the compile-time checks are part of the suite', () => {
    expect(typeof typeContract).toBe('function');
  });
});
