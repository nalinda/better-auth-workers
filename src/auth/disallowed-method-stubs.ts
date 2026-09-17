import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';

import type { CreateAuthOptions } from './types';

// The sign-in routes each optional method's plugin would mount. When a
// deployment lists `allowedMethods` but has not configured a method at all,
// these are mounted as rejecting stubs so that method's routes answer 403
// like a configured-but-disallowed one, instead of 404 — a client gets the
// same clear error either way, and the routes are always there.
interface StubbedRoute {
  name: string;
  path: string;
  method: 'GET' | 'POST';
}

interface StubbedMethod {
  method: 'phone' | 'magic-link';
  isConfigured: (options: CreateAuthOptions) => boolean;
  routes: StubbedRoute[];
}

const STUBBED_METHODS: StubbedMethod[] = [
  {
    method: 'phone',
    isConfigured: (options) => Boolean(options.phone),
    routes: [
      { name: 'phoneNumberSendOtp', path: '/phone-number/send-otp', method: 'POST' },
      { name: 'phoneNumberVerify', path: '/phone-number/verify', method: 'POST' },
      { name: 'signInPhoneNumber', path: '/sign-in/phone-number', method: 'POST' },
    ],
  },
  {
    method: 'magic-link',
    isConfigured: (options) => Boolean(options.magicLink),
    routes: [
      { name: 'signInMagicLink', path: '/sign-in/magic-link', method: 'POST' },
      { name: 'magicLinkVerify', path: '/magic-link/verify', method: 'GET' },
    ],
  },
];

/**
 * Builds a plugin mounting 403 stubs for every method that is not in
 * `options.allowedMethods` and has no plugin of its own configured. Google's
 * `/sign-in/social` is always mounted by Better Auth itself, so it needs no
 * stub. Returns `undefined` when there is nothing to stub.
 */
export function buildDisallowedMethodStubs(
  options?: CreateAuthOptions
): BetterAuthPlugin | undefined {
  const allowed = options?.allowedMethods;
  if (!allowed) return;
  const endpoints: NonNullable<BetterAuthPlugin['endpoints']> = {};
  for (const { method, isConfigured, routes } of STUBBED_METHODS) {
    if (allowed.includes(method) || isConfigured(options)) continue;
    for (const route of routes) {
      endpoints[route.name] = createAuthEndpoint(route.path, { method: route.method }, () => {
        throw new APIError('FORBIDDEN', {
          message: `${method} sign-in is not enabled for this deployment`,
        });
      });
    }
  }
  if (Object.keys(endpoints).length === 0) return;
  return { id: 'better-auth-workers-disallowed-methods', endpoints };
}
