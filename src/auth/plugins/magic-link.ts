import type { MagicLinkOptions } from 'better-auth/plugins';
import { magicLink } from 'better-auth/plugins';

import { getExecutionContext, runNonBlocking } from '../../shared/non-blocking';
import type { ExecutionContext } from '../../types';
import type { CreateAuthMagicLinkOptions } from '../types';

export function buildMagicLinkPlugin(
  magicLinkOpts?: CreateAuthMagicLinkOptions,
  optionsCtx?: ExecutionContext
) {
  if (!magicLinkOpts) return;
  const magicLinkPluginOptions: MagicLinkOptions = {
    ...magicLinkOpts,
    sendMagicLink: (data, ctx) => {
      const req = ctx?.request;
      const execCtx = getExecutionContext(req, optionsCtx);
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
