import type { SocialProviders } from 'better-auth';

import type { AuthEnv } from '../../types';
import type { CreateAuthOptions } from '../types';

export function buildSocialProviders(
  options?: CreateAuthOptions,
  env?: Partial<AuthEnv>
): SocialProviders | undefined {
  const googleOpts = options?.google;
  // Test mode's stub takes Google's place (see test-mode.ts).
  if (!googleOpts || options.testMode?.google) return;

  if (googleOpts === true) {
    const clientId = typeof env?.GOOGLE_CLIENT_ID === 'string' ? env.GOOGLE_CLIENT_ID : undefined;
    const clientSecret =
      typeof env?.GOOGLE_CLIENT_SECRET === 'string' ? env.GOOGLE_CLIENT_SECRET : undefined;
    if (!clientId || !clientSecret) return;
    return { google: { clientId, clientSecret } };
  }

  return { google: { clientId: googleOpts.clientId, clientSecret: googleOpts.clientSecret } };
}

export function googleCredentialProblems(
  options?: CreateAuthOptions,
  env?: Partial<AuthEnv>
): string[] {
  if (options?.google !== true || options.testMode?.google) return [];
  const problems: string[] = [];
  if (typeof env?.GOOGLE_CLIENT_ID !== 'string') {
    problems.push('google: true requires env.GOOGLE_CLIENT_ID to be set');
  }
  if (typeof env?.GOOGLE_CLIENT_SECRET !== 'string') {
    problems.push('google: true requires env.GOOGLE_CLIENT_SECRET to be set');
  }
  return problems;
}
