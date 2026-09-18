import type { WaitUntilContext } from '../types';

// The one thing the package wraps on a Better Auth instance: its request
// handler, widened to take the request's WaitUntilContext.
export interface HandlerHost {
  handler: (request: Request, ctx?: WaitUntilContext) => Promise<Response>;
}
