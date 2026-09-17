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

// Ends the pool after the response through waitUntil when an execution context
// is available, otherwise on the next tick so it never blocks the response.
export function withPoolLifecycle(
  instance: HandlerHost,
  pool: PgPool,
  optionsCtx?: ExecutionContext
): void {
  const originalHandler = instance.handler.bind(instance);
  instance.handler = async (request: Request, ctx?: ExecutionContext) => {
    try {
      return await originalHandler(request, ctx);
    } finally {
      const execCtx = ctx ?? optionsCtx;
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
