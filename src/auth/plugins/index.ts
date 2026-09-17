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
  if (options?.bearer) plugins.push(bearer());
  if (options?.plugins) plugins.push(...options.plugins);
  return plugins;
}
