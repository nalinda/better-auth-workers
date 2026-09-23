import { APIError } from 'better-auth';

import { warnOnce } from '../shared/warn-once';
import { disallowedMessage, methodOfPath } from './sign-in-routes';
import type { CreateAuthOptions } from './types';

type AllowedMethod = 'phone' | 'google' | 'magic-link';

interface BeforeHookContext {
  path: string;
  body?: { provider?: string; [key: string]: unknown };
}

// Deprecated in 0.3.0: every method is already opt-in per `createAuth`
// call, and this check only knows the routes in sign-in-routes.ts, so a
// plugin that adds another route into a method (Better Auth's oauthPopup
// or oneTap, for Google) is not restricted by it.
const ALLOWED_METHODS_DEPRECATION_WARNING =
  'better-auth-workers: `allowedMethods` is deprecated and will be removed in the next major version. Configure only the sign-in methods this Worker should accept (`phone`, `google`, `magicLink`) instead.';

const warnAllowedMethodsDeprecated = warnOnce(ALLOWED_METHODS_DEPRECATION_WARNING);

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
 * is nothing to restrict. Otherwise logs the deprecation warning, once per
 * isolate.
 */
export function buildAllowedMethodsHook(
  options?: CreateAuthOptions
): ((ctx: BeforeHookContext) => void) | undefined {
  // eslint-disable-next-line sonarjs/deprecation -- the deprecated option's own implementation
  const allowedMethods = options?.allowedMethods;
  if (!allowedMethods) return undefined;
  warnAllowedMethodsDeprecated();

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
