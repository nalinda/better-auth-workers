import { describe, expect, it } from 'bun:test';

import { createAuth } from '../../src/index';
import type { AuthEnv } from '../../src/types';

// Type-level contract for AuthEnv: a consumer Worker's Env typed with
// AuthEnv must supply every required binding, or tsc rejects it when
// called the documented way, createAuth(env, options). This snippet is
// not compiled (see the runtime test below for the equivalent behaviour),
// but documents the shape tsc enforces:
//
// interface WorkerEnv extends AuthEnv {}
// declare const badEnv: Omit<WorkerEnv, 'AUTH_BASE_URL'>;
// // @ts-expect-error AUTH_BASE_URL is required by AuthEnv and missing here
// createAuth(badEnv, {});
//
// declare const wrongShapeEnv: Omit<WorkerEnv, 'AUTH_KV'> & { AUTH_KV: string };
// // @ts-expect-error AUTH_KV must be a KVNamespace, not a string
// createAuth(wrongShapeEnv, {});

interface CreateAuthOptions {
  basePath?: string;
  baseURL?: string;
  secret?: string;
  database?: { hyperdrive: unknown } | { d1: unknown };
  [key: string]: unknown;
}

const createAuthInstance = (env: Record<string, unknown>, options?: CreateAuthOptions) =>
  (createAuth as unknown as (e: Record<string, unknown>, o?: CreateAuthOptions) => unknown)(
    env,
    options
  );

describe('createAuth: combined missing-binding diagnostics', () => {
  it('throws a single error naming every missing binding, not just the first', () => {
    // baseURL, secret and database are all unresolvable from either
    // options or env, mirroring a WorkerEnv typed as AuthEnv but missing
    // AUTH_BASE_URL, BETTER_AUTH_SECRET, and both HYPERDRIVE and DB.
    const env: Partial<AuthEnv> = {};

    let caught: Error | undefined;
    try {
      createAuthInstance(env, {});
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/baseURL/i);
    expect(caught?.message).toMatch(/secret/i);
    expect(caught?.message).toMatch(/database/i);
  });

  it('throws a single error naming missing Google credentials alongside other missing bindings', () => {
    const env: Partial<AuthEnv> = {};

    let caught: Error | undefined;
    try {
      createAuthInstance(env, { google: true });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/baseURL/i);
    expect(caught?.message).toMatch(/GOOGLE_CLIENT_ID/);
    expect(caught?.message).toMatch(/GOOGLE_CLIENT_SECRET/);
  });

  it('does not throw when every required binding is resolvable', () => {
    const mockD1 = {
      prepare: () => ({
        bind: () => ({
          all: () => Promise.resolve({ results: [], success: true, meta: { changes: 0 } }),
          first: () => Promise.resolve(null),
          run: () => Promise.resolve({ success: true, meta: { changes: 0 } }),
        }),
      }),
      batch: () => Promise.resolve([]),
      exec: () => Promise.resolve({ count: 0, duration: 0 }),
    };
    const env: Partial<AuthEnv> = {
      AUTH_BASE_URL: 'https://auth.example.com',
      BETTER_AUTH_SECRET: 'test-secret-at-least-32-chars-long-1234567890',
      DB: mockD1 as unknown as D1Database,
    };

    expect(() => createAuthInstance(env, {})).not.toThrow();
  });
});
