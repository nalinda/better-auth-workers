import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';

import { disallowedMessage, OPTIONAL_METHOD_ROUTES } from './sign-in-routes';
import type { CreateAuthOptions } from './types';

// The sign-in routes each optional method's plugin would mount (the shared
// table in sign-in-routes.ts). When a deployment lists `allowedMethods` but
// has not configured a method at all, these are mounted as rejecting stubs
// so that method's routes answer 403 like a configured-but-disallowed one,
// instead of 404 — a client gets the same clear error either way, and the
// routes are always there.

/**
 * Builds a plugin mounting 403 stubs for every method that is not in
 * `options.allowedMethods` and has no plugin of its own configured. Google's
 * `/sign-in/social` is always mounted by Better Auth itself, so it needs no
 * stub. Returns `undefined` when there is nothing to stub.
 */
export function buildDisallowedMethodStubs(
  options?: CreateAuthOptions
): BetterAuthPlugin | undefined {
  // eslint-disable-next-line sonarjs/deprecation -- the deprecated option's own implementation
  const allowed = options?.allowedMethods;
  if (!allowed) return;
  const endpoints: NonNullable<BetterAuthPlugin['endpoints']> = {};
  for (const { method, isConfigured, routes } of OPTIONAL_METHOD_ROUTES) {
    if (allowed.includes(method) || isConfigured(options)) continue;
    for (const route of routes) {
      endpoints[route.name] = createAuthEndpoint(route.path, { method: route.method }, () => {
        throw new APIError('FORBIDDEN', { message: disallowedMessage(method) });
      });
    }
  }
  if (Object.keys(endpoints).length === 0) return;
  return { id: 'better-auth-workers-disallowed-methods', endpoints };
}
