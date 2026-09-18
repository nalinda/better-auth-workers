import type { HandlerHost } from '../shared/handler-host';
import type { ContextRef } from '../shared/non-blocking';
import type { WaitUntilContext } from '../types';

export interface PgPool {
  end(): Promise<void>;
}

// The shape of `pg.Pool` this package relies on, whether the driver comes
// from the consumer (`database.pg`) or from `require('pg')`.
export type PgPoolConstructor = new (config: { connectionString?: string; max?: number }) => PgPool;

interface PgModule {
  Pool: PgPoolConstructor;
  default?: { Pool: PgPoolConstructor };
}

export function loadPgPoolClass(): PgPoolConstructor | undefined {
  try {
    const req = typeof require === 'function' ? require : undefined;
    const pg = req ? (req('pg') as PgModule) : undefined;
    return pg?.Pool ?? pg?.default?.Pool;
  } catch {
    return;
  }
}

const POOL_ALREADY_RELEASED_MESSAGE =
  'better-auth-workers: this Hyperdrive-backed instance has already served a request and released its pool. Call createAuth(env, options) again for each request; the Hyperdrive path is not memoised.';

// Ends the pool at most once: a second call (whether from a second
// `handler` invocation or a consumer's own cleanup after calling
// `auth.api.*` directly) returns the same in-flight promise instead of
// calling `pool.end()` again, which a driver may reject or error on.
function createPoolReleaser(pool: PgPool): () => Promise<void> {
  let released: Promise<void> | undefined;
  return () => {
    released ??= (async () => {
      try {
        await pool.end();
      } catch (error) {
        console.error('better-auth-workers: failed to release the pg Pool', error);
      }
    })();
    return released;
  };
}

// Ends the pool after the response through waitUntil when an execution context
// is available, otherwise on the next tick so it never blocks the response.
// A second `handler` call on the same instance would run against an
// already-releasing pool and fail deep inside the driver, so it is refused
// up front with an error that names the fix. A Worker that calls
// `auth.api.*` directly instead of `handler` owns the pool it created
// (`auth.options.database`) and must release it itself — nothing here can
// know when such a caller is done with it, since there is no `handler`
// call marking the end of the request; see README "Storage".
export function withPoolLifecycle(instance: HandlerHost, pool: PgPool, ctxRef: ContextRef): void {
  const originalHandler = instance.handler.bind(instance);
  const release = createPoolReleaser(pool);
  let isReleased = false;
  instance.handler = async (request: Request, ctx?: WaitUntilContext) => {
    if (isReleased) {
      throw new Error(POOL_ALREADY_RELEASED_MESSAGE);
    }
    isReleased = true;
    try {
      return await originalHandler(request, ctx);
    } finally {
      const execCtx = ctx ?? ctxRef.current;
      if (execCtx && typeof execCtx.waitUntil === 'function') {
        execCtx.waitUntil(release());
      } else {
        // Without a context nothing logs a failed end() for us (waitUntil
        // reports its own rejections); log it rather than leave it unhandled.
        setTimeout(() => {
          void release();
        }, 0);
      }
    }
  };
}
