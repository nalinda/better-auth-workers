import { APIError } from 'better-auth';

import { disallowedMessage, methodOfPath } from './sign-in-routes';
import type { CreateAuthOptions } from './types';

type AllowedMethod = 'phone' | 'google' | 'magic-link';

interface BeforeHookContext {
  path: string;
  body?: { provider?: string; [key: string]: unknown };
}

function forbidden(method: AllowedMethod): never {
  throw new APIError('FORBIDDEN', { message: disallowedMessage(method) });
}

/**
 * Builds the `hooks.before` handler that rejects sign-in routes for methods
 * not present in `options.allowedMethods` with a 403. The rejected routes
 * stay mounted — by the method's own plugin when it is configured, or by a
 * rejecting stub (see disallowed-method-stubs.ts) when it is not — so a
 * client always gets a clear 403 rather than a 404.
 *
 * Get-session, sign-out and account-management routes are never restricted:
 * the check matches only google's `/sign-in/social` and the routes listed
 * for each method in sign-in-routes.ts (every route the phone plugin
 * mounts, `/phone-number/*`, which includes its password-reset routes as
 * well as sign-in and OTP).
 *
 * Returns `undefined` when `options.allowedMethods` is not set, since there
 * is nothing to restrict.
 */
export function buildAllowedMethodsHook(
  options?: CreateAuthOptions
): ((ctx: BeforeHookContext) => void) | undefined {
  const allowedMethods = options?.allowedMethods;
  if (!allowedMethods) return undefined;

  const allowed = new Set<AllowedMethod>(allowedMethods);

  return (ctx: BeforeHookContext) => {
    const method = methodOfPath(ctx.path);
    if (method) {
      if (!allowed.has(method)) forbidden(method);
      return;
    }

    if (ctx.path === '/sign-in/social') {
      const provider = ctx.body?.provider;
      if (provider === 'google' && !allowed.has('google')) forbidden('google');
    }
  };
}
