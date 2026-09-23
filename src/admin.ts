import { WorkerEntrypoint } from 'cloudflare:workers';

import {
  type AuthAdminRpc,
  banUser,
  type BanUserOptions,
  type BanUserResult,
  unbanUser,
  type UnbanUserResult,
  withAuthInstance,
} from './auth/admin-actions';
import type { CreateAuthOptions } from './auth/types';
import type { AuthEnv } from './types';

export type {
  AuthAdminRpc,
  BanUserOptions,
  BanUserResult,
  UnbanUserResult,
} from './auth/admin-actions';

/**
 * Builds the `AuthAdmin` entrypoint class for the auth Worker to export.
 * Another Worker bound to it (`services: [{ binding, service, entrypoint:
 * 'AuthAdmin' }]`) can ban and unban users over RPC. The binding is the
 * authorisation: there is no HTTP route and no secret, so only Workers you
 * bind to this entrypoint can call it. `optionsFor` returns the same options
 * the auth Worker passes to `createAuth`.
 */
export function createAuthAdmin<Env extends AuthEnv>(
  optionsFor: (env: Env) => CreateAuthOptions
): new (ctx: ExecutionContext, env: Env) => WorkerEntrypoint<Env> & AuthAdminRpc {
  return class AuthAdmin extends WorkerEntrypoint<Env> implements AuthAdminRpc {
    banUser(userId: string, options?: BanUserOptions): Promise<BanUserResult> {
      return withAuthInstance(this.env, optionsFor(this.env), (auth, kv) =>
        banUser(auth, kv, userId, options)
      );
    }

    unbanUser(userId: string): Promise<UnbanUserResult> {
      return withAuthInstance(this.env, optionsFor(this.env), (auth) => unbanUser(auth, userId));
    }
  };
}
