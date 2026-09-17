import type { MagicLinkOptions } from 'better-auth/plugins';
import { magicLink } from 'better-auth/plugins';

import { type ContextRef, getExecutionContext, runNonBlocking } from '../../shared/non-blocking';
import type { CreateAuthMagicLinkOptions } from '../types';

export function buildMagicLinkPlugin(
  magicLinkOpts: CreateAuthMagicLinkOptions | undefined,
  ctxRef: ContextRef
) {
  if (!magicLinkOpts) return;
  const magicLinkPluginOptions: MagicLinkOptions = {
    ...magicLinkOpts,
    sendMagicLink: (data, ctx) => {
      const req = ctx?.request;
      const execCtx = getExecutionContext(req, ctxRef.current);
      runNonBlocking(
        async () => {
          await magicLinkOpts.sendMagicLink(data, req);
        },
        execCtx,
        (error) => {
          console.error(error);
        }
      );
    },
  };
  return magicLink(magicLinkPluginOptions);
}
