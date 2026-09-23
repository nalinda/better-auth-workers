import { isAPIError } from 'better-auth/api';

import type { AuthEnv } from '../types';
import type { CreateAuthOptions } from './types';

// Better Auth deletes expired verification rows only while looking one up
// (phone verify, the OAuth callback). Magic-link verification consumes its
// row without that sweep, so in a Worker whose only method is magic link,
// every link that is never opened would stay in the `verification` table
// for good; KV used to expire them by TTL. After a magic link is sent, the
// expired rows are deleted, at most once per interval per Worker env (one
// per isolate) so a busy Worker does not scan the table on every request.
// Better Auth's own `verification.disableCleanup` turns this off too.
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

// When each Worker env last swept its table. The env object is stable for
// the life of an isolate, including on the Hyperdrive path, where the auth
// instance is rebuilt per request.
const lastSweepAt = new WeakMap<object, number>();

interface CleanupContext {
  path: string;
  context: {
    returned?: unknown;
    adapter: {
      deleteMany: (input: {
        model: string;
        where: Array<{ field: string; value: Date; operator: 'lt' }>;
      }) => Promise<unknown>;
    };
  };
}

async function deleteExpiredVerifications(env: object, ctx: CleanupContext): Promise<void> {
  // Only after a link was actually sent, not after a refused request.
  if (ctx.path !== '/sign-in/magic-link' || isAPIError(ctx.context.returned)) return;
  const now = Date.now();
  // Housekeeping must never fail the request, even for a caller that passed
  // no env object; it then just isn't throttled.
  // `env` is typed as always present, but a JavaScript caller can omit it.
  const maybeEnv: unknown = env;
  const canThrottle = typeof maybeEnv === 'object' && maybeEnv !== null;
  if (canThrottle && now - (lastSweepAt.get(env) ?? 0) < CLEANUP_INTERVAL_MS) return;
  if (canThrottle) lastSweepAt.set(env, now);
  try {
    await ctx.context.adapter.deleteMany({
      model: 'verification',
      where: [{ field: 'expiresAt', value: new Date(now), operator: 'lt' }],
    });
  } catch (error) {
    // Housekeeping only: the magic link has been sent either way.
    console.error('better-auth-workers: could not delete expired verification rows', error);
  }
}

export function buildVerificationCleanup(
  options: CreateAuthOptions | undefined,
  env: AuthEnv
): ((ctx: CleanupContext) => Promise<void>) | undefined {
  if (!options?.magicLink) return;
  if (options.betterAuth?.verification?.disableCleanup) return;
  return (ctx: CleanupContext) => deleteExpiredVerifications(env, ctx);
}
