import type { Context, MiddlewareHandler } from 'hono';

import type { RequireSessionOptions, SessionData } from './types';

type SessionVariables = { session: SessionData };

export function requireSession(
  options: RequireSessionOptions
): MiddlewareHandler<{ Variables: SessionVariables }> {
  return async (c: Context<{ Variables: SessionVariables }>, next) => {
    const session = await options.client.get(c.req.raw);
    if (!session) return c.text('Unauthorized', 401);

    if (options.predicate && !(await options.predicate(session))) {
      return c.text('Forbidden', 403);
    }

    c.set('session', session);
    await next();
  };
}
