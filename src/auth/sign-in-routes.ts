import type { CreateAuthOptions } from './types';

// The one table of sign-in routes per optional method, read by both the
// `allowedMethods` before-hook (which route belongs to which method) and
// the disallowed-method stubs (which routes to mount as 403s when a method
// is not configured at all), so the two cannot drift apart.
export type OptionalMethod = 'phone' | 'magic-link';

interface SignInRoute {
  // Endpoint name the stub is registered under; Better Auth's plugin uses
  // the same name, so `auth.api.<name>` resolves either way.
  name: string;
  path: string;
  method: 'GET' | 'POST';
}

export interface MethodRoutes {
  method: OptionalMethod;
  isConfigured: (options: CreateAuthOptions) => boolean;
  // Routes the method's plugin mounts that the stub plugin reproduces.
  routes: SignInRoute[];
  // Path prefixes the before-hook matches on top of `routes`, for routes
  // the plugin mounts beyond sign-in (the phone plugin's password-reset
  // routes live under `/phone-number/` too).
  pathPrefixes: string[];
}

export const OPTIONAL_METHOD_ROUTES: MethodRoutes[] = [
  {
    method: 'phone',
    isConfigured: (options) => Boolean(options.phone),
    routes: [
      { name: 'phoneNumberSendOtp', path: '/phone-number/send-otp', method: 'POST' },
      { name: 'phoneNumberVerify', path: '/phone-number/verify', method: 'POST' },
      { name: 'signInPhoneNumber', path: '/sign-in/phone-number', method: 'POST' },
    ],
    pathPrefixes: ['/phone-number/'],
  },
  {
    method: 'magic-link',
    isConfigured: (options) => Boolean(options.magicLink),
    routes: [
      { name: 'signInMagicLink', path: '/sign-in/magic-link', method: 'POST' },
      { name: 'magicLinkVerify', path: '/magic-link/verify', method: 'GET' },
    ],
    pathPrefixes: [],
  },
];

// The optional method a request path belongs to, if any.
export function methodOfPath(path: string): OptionalMethod | undefined {
  return OPTIONAL_METHOD_ROUTES.find(
    ({ routes, pathPrefixes }) =>
      routes.some((route) => route.path === path) ||
      pathPrefixes.some((prefix) => path.startsWith(prefix))
  )?.method;
}

export function disallowedMessage(method: OptionalMethod | 'google'): string {
  return `${method} sign-in is not enabled for this deployment`;
}
