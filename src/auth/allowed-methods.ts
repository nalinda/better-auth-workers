import { APIError } from 'better-auth';

import type { CreateAuthOptions } from './types';

type AllowedMethod = 'phone' | 'google' | 'magic-link';

interface BeforeHookContext {
  path: string;
  body?: { provider?: string; [key: string]: unknown };
}

const PHONE_PATH_PREFIXES = ['/phone-number/', '/sign-in/phone-number'];
const MAGIC_LINK_PATHS = new Set(['/sign-in/magic-link', '/magic-link/verify']);

function isPhoneRoute(path: string): boolean {
  return PHONE_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

function isMagicLinkRoute(path: string): boolean {
  return MAGIC_LINK_PATHS.has(path);
}

function forbidden(message: string): never {
  throw new APIError('FORBIDDEN', { message });
}

/**
 * Builds the `hooks.before` handler that rejects sign-in routes for methods
 * not present in `options.allowedMethods` with a 403. The rejected routes
 * stay mounted — by the method's own plugin when it is configured, or by a
 * rejecting stub (see disallowed-method-stubs.ts) when it is not — so a
 * client always gets a clear 403 rather than a 404.
 *
 * Get-session, sign-out and account-management routes are never restricted,
 * since this check only ever matches sign-in route paths.
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
    if (isPhoneRoute(ctx.path)) {
      if (!allowed.has('phone')) {
        forbidden('phone sign-in is not enabled for this deployment');
      }
      return;
    }

    if (isMagicLinkRoute(ctx.path)) {
      if (!allowed.has('magic-link')) {
        forbidden('magic-link sign-in is not enabled for this deployment');
      }
      return;
    }

    if (ctx.path === '/sign-in/social') {
      const provider = ctx.body?.provider;
      if (provider === 'google' && !allowed.has('google')) {
        forbidden('google sign-in is not enabled for this deployment');
      }
    }
  };
}
