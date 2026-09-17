import type { SocialProviders } from 'better-auth';

import type { AuthEnv } from '../../types';
import type { CreateAuthOptions } from '../types';

export function buildSocialProviders(
  options?: CreateAuthOptions,
  env?: AuthEnv
): SocialProviders | undefined {
  const googleOpts = options?.google;
  if (!googleOpts) return;

  if (googleOpts === true) {
    const clientId = typeof env?.GOOGLE_CLIENT_ID === 'string' ? env.GOOGLE_CLIENT_ID : undefined;
    if (!clientId) {
      throw new Error('google: true requires env.GOOGLE_CLIENT_ID to be set');
    }
    const clientSecret =
      typeof env?.GOOGLE_CLIENT_SECRET === 'string' ? env.GOOGLE_CLIENT_SECRET : undefined;
    if (!clientSecret) {
      throw new Error('google: true requires env.GOOGLE_CLIENT_SECRET to be set');
    }
    return { google: { clientId, clientSecret } };
  }

  return { google: { clientId: googleOpts.clientId, clientSecret: googleOpts.clientSecret } };
}
