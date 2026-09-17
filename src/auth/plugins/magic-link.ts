import type { MagicLinkOptions } from 'better-auth/plugins';
import { magicLink } from 'better-auth/plugins';

import type { ContextRef } from '../../shared/non-blocking';
import type { CreateAuthMagicLinkOptions } from '../types';
import { deliverNonBlocking } from './delivery';

export function buildMagicLinkPlugin(
  magicLinkOpts: CreateAuthMagicLinkOptions | undefined,
  ctxRef: ContextRef
) {
  if (!magicLinkOpts) return;
  const magicLinkPluginOptions: MagicLinkOptions = {
    ...magicLinkOpts,
    sendMagicLink: (data, ctx) => {
      const req = ctx?.request;
      // The token appears both on its own and inside the URL.
      deliverNonBlocking(() => magicLinkOpts.sendMagicLink(data, req), req, ctxRef, [
        data.token,
        data.url,
      ]);
    },
  };
  return magicLink(magicLinkPluginOptions);
}
