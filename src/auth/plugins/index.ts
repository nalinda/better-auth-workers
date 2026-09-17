import type { BetterAuthPlugin } from 'better-auth';
import { admin, bearer } from 'better-auth/plugins';

import type { CreateAuthOptions } from '../options';
import { buildPhonePlugin } from './phone';

export function buildPlugins(options?: CreateAuthOptions): BetterAuthPlugin[] {
  const plugins: BetterAuthPlugin[] = [admin()];
  const phonePlugin = buildPhonePlugin(options?.phone, options?.ctx);
  if (phonePlugin) plugins.push(phonePlugin);
  if (options?.bearer) plugins.push(bearer());
  if (options?.plugins) plugins.push(...options.plugins);
  return plugins;
}
