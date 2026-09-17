import type { BetterAuthPlugin } from 'better-auth';
import { admin, bearer } from 'better-auth/plugins';

import type { CreateAuthOptions } from '../types';
import { buildMagicLinkPlugin } from './magic-link';
import { buildPhonePlugin } from './phone';

export { buildSocialProviders } from './google';

export function buildPlugins(options?: CreateAuthOptions): BetterAuthPlugin[] {
  const plugins: BetterAuthPlugin[] = [admin()];
  const phonePlugin = buildPhonePlugin(options?.phone, options?.ctx);
  if (phonePlugin) plugins.push(phonePlugin);
  const magicLinkPlugin = buildMagicLinkPlugin(options?.magicLink, options?.ctx);
  if (magicLinkPlugin) plugins.push(magicLinkPlugin);
  if (options?.bearer) plugins.push(bearer());
  if (options?.plugins) plugins.push(...options.plugins);
  return plugins;
}
