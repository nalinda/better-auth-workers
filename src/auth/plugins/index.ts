import type { BetterAuthPlugin } from 'better-auth';
import { admin, bearer } from 'better-auth/plugins';

import type { ContextRef } from '../../shared/non-blocking';
import { buildDisallowedMethodStubs } from '../disallowed-method-stubs';
import type { CreateAuthOptions } from '../types';
import { buildMagicLinkPlugin } from './magic-link';
import { buildPhonePlugin } from './phone';

export { buildSocialProviders } from './google';

export function buildPlugins(
  options: CreateAuthOptions | undefined,
  ctxRef: ContextRef
): BetterAuthPlugin[] {
  const plugins: BetterAuthPlugin[] = [admin()];
  const phonePlugin = buildPhonePlugin(options?.phone, ctxRef);
  if (phonePlugin) plugins.push(phonePlugin);
  const magicLinkPlugin = buildMagicLinkPlugin(options?.magicLink, ctxRef);
  if (magicLinkPlugin) plugins.push(magicLinkPlugin);
  const stubs = buildDisallowedMethodStubs(options);
  if (stubs) plugins.push(stubs);
  // `requireSignature` is not Better Auth's default: without it the plugin
  // signs a bare `Authorization: Bearer <token>` itself and accepts it, which
  // would make the bare session token a usable credential on its own. It is
  // not treated as one anywhere else here — it is the shared KV cache key,
  // it appears in `/revoke-session` bodies, and the session-cache entry only
  // matches on the full credential — so the plugin is held to the signed
  // `<token>.<signature>` form that sign-in hands back in `set-auth-token`.
  if (options?.bearer) plugins.push(bearer({ requireSignature: true }));
  if (options?.plugins) plugins.push(...options.plugins);
  // `betterAuth.plugins` is appended the same way, so the escape hatch adds
  // plugins rather than replacing the ones the package relies on.
  const escapeHatchPlugins = options?.betterAuth?.plugins;
  if (Array.isArray(escapeHatchPlugins)) plugins.push(...escapeHatchPlugins);
  return plugins;
}
