import type { Context, Env, MiddlewareHandler } from 'hono';

import { type RequireSessionOptions, type SessionData, SessionUnavailableError } from './types';

// The variable the middleware sets; include it in the app's `Variables` to
// read it with `c.get('session')` downstream.
type SessionVariables = { session: SessionData };

type SessionContext<E extends Env> = Context<E & { Variables: SessionVariables }>;

// Generic over the app's own `Env` (bindings and other variables), so the
// middleware composes with any typed Hono app without a cast. `client` may
// be a function of the context, so the middleware mounts directly on a
// route when the client lives on a Hono variable.
export function requireSession<E extends Env = Env>(
  options: RequireSessionOptions<SessionContext<E>>
): MiddlewareHandler<E & { Variables: SessionVariables }> {
  return async (c: SessionContext<E>, next) => {
    const client = typeof options.client === 'function' ? options.client(c) : options.client;
    let session: SessionData | null;
    try {
      session = await client.get(c.req.raw);
    } catch (error) {
      // No answer from the auth Worker is not "not signed in": tell the
      // client to retry rather than to drop its session.
      if (error instanceof SessionUnavailableError) return c.text('Service Unavailable', 503);
      throw error;
    }
    if (!session) return c.text('Unauthorized', 401);

    if (options.predicate && !(await options.predicate(session))) {
      return c.text('Forbidden', 403);
    }

    c.set('session', session);
    await next();
  };
}
