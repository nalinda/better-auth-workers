import type { Context, Env, MiddlewareHandler } from 'hono';

import type { RequireSessionOptions, SessionData } from './types';

// The variable the middleware sets; include it in the app's `Variables` to
// read it with `c.get('session')` downstream.
type SessionVariables = { session: SessionData };

// Generic over the app's own `Env` (bindings and other variables), so the
// middleware composes with any typed Hono app without a cast.
export function requireSession<E extends Env = Env>(
  options: RequireSessionOptions
): MiddlewareHandler<E & { Variables: SessionVariables }> {
  return async (c: Context<E & { Variables: SessionVariables }>, next) => {
    const session = await options.client.get(c.req.raw);
    if (!session) return c.text('Unauthorized', 401);

    if (options.predicate && !(await options.predicate(session))) {
      return c.text('Forbidden', 403);
    }

    c.set('session', session);
    await next();
  };
}
