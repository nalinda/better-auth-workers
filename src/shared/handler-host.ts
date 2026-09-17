import type { ExecutionContext } from '../types';

// The one thing the package wraps on a Better Auth instance: its request
// handler, widened to take the request's ExecutionContext.
export interface HandlerHost {
  handler: (request: Request, ctx?: ExecutionContext) => Promise<Response>;
}
