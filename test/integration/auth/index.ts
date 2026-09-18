import type { AuthEnv } from 'better-auth-workers';

import app from '../../../examples/hono/src/index';

// Test-only entry for the example auth Worker. It serves the example's own
// Hono app with the example's own bindings, and only adds observation: the
// D1 and KV bindings are wrapped so the suite can count how many primary
// store statements and KV reads a request caused (the Hyperdrive path's
// statements are counted on the wire by the harness instead, since the pg
// driver is the example's). The counters are read at `/__auth/counters`.
const counters = { primaryQueries: 0, kvReads: 0 };

// Wraps every method of `target` so `onCall` observes each one invoked,
// before the real call runs. `countingD1` and `countingKv` differ only in
// which method names count against which counter.
function counting<T extends object>(
  target: T,
  onCall: (prop: PropertyKey, args: unknown[]) => void
): T {
  return new Proxy(target, {
    get(proxyTarget, prop, receiver) {
      const value = Reflect.get(proxyTarget, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        onCall(prop, args);
        return Reflect.apply(value as (...fnArgs: unknown[]) => unknown, proxyTarget, args);
      };
    },
  });
}

function countingD1(db: D1Database): D1Database {
  return counting(db, (prop, args) => {
    if (prop === 'prepare' || prop === 'exec') {
      counters.primaryQueries += 1;
    } else if (prop === 'batch') {
      counters.primaryQueries += (args[0] as unknown[]).length;
    }
  });
}

function countingKv(kv: KVNamespace): KVNamespace {
  return counting(kv, (prop) => {
    if (prop === 'get' || prop === 'getWithMetadata') counters.kvReads += 1;
  });
}

// One wrapped env per real env object, so createAuth's memoisation on `env`
// behaves exactly as it does for the example Worker on its own.
const wrappedEnvs = new WeakMap<AuthEnv, AuthEnv>();

function countingEnv(env: AuthEnv): AuthEnv {
  const existing = wrappedEnvs.get(env);
  if (existing) return existing;
  const wrapped: AuthEnv = {
    ...env,
    ...(env.AUTH_KV && { AUTH_KV: countingKv(env.AUTH_KV) }),
    ...(env.DB && { DB: countingD1(env.DB) }),
  };
  wrappedEnvs.set(env, wrapped);
  return wrapped;
}

export default {
  fetch(request: Request, env: AuthEnv, ctx: ExecutionContext): Promise<Response> | Response {
    const { pathname } = new URL(request.url);
    if (pathname === '/__auth/counters') {
      return Response.json(counters);
    }
    return app.fetch(request, countingEnv(env), ctx);
  },
};
