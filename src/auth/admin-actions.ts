import { sessionCacheKey } from '../shared/session-cache';
import type { AuthEnv, KVStore } from '../types';
import { createAuth } from './create-auth';
import { resolveHyperdriveConnectionString } from './database';
import { resolveKv } from './kv';
import type { CreateAuthOptions } from './types';

export interface BanUserOptions {
  // Stored as `banReason`; an empty or missing reason becomes 'No reason',
  // as in Better Auth's admin plugin.
  reason?: string;
  // Seconds until the ban lifts on its own. Permanent when omitted, and, as
  // in the admin plugin, when it is not a positive number.
  expiresIn?: number;
}

export interface BanUserResult {
  // False when no user has this id; nothing was changed.
  found: boolean;
  // How many of the user's sessions were revoked (and evicted from the
  // session client's cache).
  revokedSessions: number;
}

export interface UnbanUserResult {
  found: boolean;
}

// The methods an `AuthAdmin` entrypoint exposes over a service binding, for
// typing that binding in the calling Worker (`env.AUTH_ADMIN`).
export interface AuthAdminRpc {
  banUser: (userId: string, options?: BanUserOptions) => Promise<BanUserResult>;
  unbanUser: (userId: string) => Promise<UnbanUserResult>;
}

interface UserRow {
  id: string;
}

// The slice of Better Auth's internal adapter the ban uses; the admin
// plugin's own ban endpoint makes the same calls.
interface InternalAdapter {
  findUserById: (userId: string) => Promise<UserRow | null>;
  updateUser: (userId: string, data: Record<string, unknown>) => Promise<UserRow | null>;
  listSessions: (userId: string) => Promise<Array<{ token: string }>>;
  deleteUserSessions: (userId: string) => Promise<void>;
}

type AuthInstance = ReturnType<typeof createAuth>;

async function internalAdapterOf(auth: AuthInstance): Promise<InternalAdapter> {
  const context = await auth.$context;
  return context.internalAdapter;
}

/**
 * Bans a user the way Better Auth's admin plugin does (`banned`,
 * `banReason`, `banExpires`, then every session revoked), without an admin
 * session, and also deletes each revoked session's entry from the session
 * client's KV cache, so a Worker using `createSessionClient` stops seeing
 * the user on its next request rather than when the cache entry expires.
 */
export async function banUser(
  auth: AuthInstance,
  kv: KVStore | undefined,
  userId: string,
  options: BanUserOptions = {}
): Promise<BanUserResult> {
  const adapter = await internalAdapterOf(auth);
  if (!(await adapter.findUserById(userId))) return { found: false, revokedSessions: 0 };
  const now = Date.now();
  const { expiresIn } = options;
  const expires =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(now + expiresIn * 1000)
      : null;
  // Banned first: from here the admin plugin refuses any new session, so the
  // sessions listed next are all there will be. Listing first would miss a
  // sign-in that completed in between, and a retry after a failed eviction
  // would find nothing left to evict.
  await adapter.updateUser(userId, {
    banned: true,
    banReason: options.reason || 'No reason',
    banExpires: expires,
    updatedAt: new Date(now),
  });
  const sessions = await adapter.listSessions(userId);
  const tokens = sessions.map((session) => session.token);
  await adapter.deleteUserSessions(userId);
  if (kv) {
    await Promise.all(
      tokens.map(async (token) => {
        await kv.delete(sessionCacheKey(token));
      })
    );
  }
  return { found: true, revokedSessions: tokens.length };
}

export async function unbanUser(auth: AuthInstance, userId: string): Promise<UnbanUserResult> {
  const adapter = await internalAdapterOf(auth);
  if (!(await adapter.findUserById(userId))) return { found: false };
  await adapter.updateUser(userId, {
    banned: false,
    banReason: null,
    banExpires: null,
    updatedAt: new Date(),
  });
  return { found: true };
}

/**
 * Runs `action` against an instance built for `env` and `options`, as a
 * request would. On the Hyperdrive path the instance owns a fresh pg Pool
 * that nothing else will release (only `auth.handler` does), so it is ended
 * here once the action settles.
 */
export async function withAuthInstance<T>(
  env: AuthEnv,
  options: CreateAuthOptions,
  action: (auth: AuthInstance, kv: KVStore | undefined) => Promise<T>
): Promise<T> {
  const auth = createAuth(env, options);
  try {
    return await action(auth, resolveKv(options, env));
  } finally {
    if (resolveHyperdriveConnectionString(options, env) !== undefined) {
      // The action has already committed; a pool that fails to close must
      // not turn its result into an error (the HTTP path logs it the same way).
      try {
        await (auth.options.database as { end: () => Promise<void> }).end();
      } catch (error) {
        console.error('better-auth-workers: failed to release the pg Pool', error);
      }
    }
  }
}
