import type { ContextRef } from '../shared/non-blocking';
import type { ConfigValue, ExecutionContext } from '../types';

type PgPoolConfig = {
  connectionString?: string;
  max?: number;
  [key: string]: ConfigValue;
};

export interface PgPool {
  end(): Promise<void>;
  [key: string]: ConfigValue;
}

interface PgModule {
  Pool: new (config: PgPoolConfig) => PgPool;
  default?: {
    Pool: new (config: PgPoolConfig) => PgPool;
  };
}

export function loadPgPoolClass(): (new (config: PgPoolConfig) => PgPool) | undefined {
  try {
    const req = typeof require === 'function' ? require : undefined;
    const pg = req ? (req('pg') as PgModule) : undefined;
    return pg?.Pool ?? pg?.default?.Pool;
  } catch {
    return;
  }
}

interface HandlerHost {
  handler: (request: Request, ctx?: ExecutionContext) => Promise<Response>;
}

const POOL_ALREADY_RELEASED_MESSAGE =
  'better-auth-workers: this Hyperdrive-backed instance has already served a request and released its pool. Call createAuth(env, options) again for each request; the Hyperdrive path is not memoised.';

// Ends the pool after the response through waitUntil when an execution context
// is available, otherwise on the next tick so it never blocks the response.
// The pool is released exactly once: a second `handler` call on the same
// instance would run against an ended pool and fail deep inside the driver,
// so it is refused up front with an error that names the fix.
export function withPoolLifecycle(instance: HandlerHost, pool: PgPool, ctxRef: ContextRef): void {
  const originalHandler = instance.handler.bind(instance);
  let isReleased = false;
  instance.handler = async (request: Request, ctx?: ExecutionContext) => {
    if (isReleased) {
      throw new Error(POOL_ALREADY_RELEASED_MESSAGE);
    }
    isReleased = true;
    try {
      return await originalHandler(request, ctx);
    } finally {
      const execCtx = ctx ?? ctxRef.current;
      if (execCtx && typeof execCtx.waitUntil === 'function') {
        execCtx.waitUntil(pool.end());
      } else {
        setTimeout(() => {
          void pool.end();
        }, 0);
      }
    }
  };
}
