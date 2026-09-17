import type { BetterAuthPlugin } from 'better-auth';
import { betterAuth } from 'better-auth';
import type { PhoneNumberOptions } from 'better-auth/plugins';
import { admin, bearer, phoneNumber } from 'better-auth/plugins';

export type AuthEnv = Record<
  string,
  string | KVNamespace | Hyperdrive | D1Database | Fetcher | boolean | number | object | undefined
>;

export interface CreateAuthPhoneOptions {
  sendOTP: (args: { phoneNumber: string; code: string }, request?: Request) => Promise<void> | void;
  otpLength?: number;
  expiresIn?: number;
  allowedAttempts?: number;
}

export interface CreateAuthDatabaseOptions {
  hyperdrive?: Hyperdrive | Record<string, string | number | boolean>;
  d1?: D1Database | Record<string, (arg?: string) => void>;
}

export interface KVStore {
  get(key: string): Promise<string | null> | string | null;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

export interface CreateAuthSecondaryStorage {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string, ttl?: number): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

export interface CreateAuthOptions {
  basePath?: string;
  baseURL?: string;
  secret?: string;
  database?: CreateAuthDatabaseOptions;
  kv?: KVStore;
  secondaryStorage?: CreateAuthSecondaryStorage;
  phone?: CreateAuthPhoneOptions;
  google?: boolean | { clientId: string; clientSecret: string };
  bearer?: boolean;
  allowedMethods?: Array<'phone' | 'google' | 'magic-link'>;
  plugins?: BetterAuthPlugin[];
  betterAuth?: Record<string, string | number | boolean | object | undefined>;
  [key: string]:
    string | number | boolean | object | ((...args: never[]) => Promise<void> | void) | undefined;
}

export type AuthInstance = ReturnType<typeof betterAuth>;

const instanceCache = new WeakMap<object, Map<string, AuthInstance>>();

function getOptionsKey(options?: CreateAuthOptions): string {
  if (!options || Object.keys(options).length === 0) return '{}';
  return JSON.stringify(options);
}

function resolveBaseURL(options?: CreateAuthOptions, envObj?: AuthEnv): string {
  const baseURL =
    options?.baseURL ??
    (typeof envObj?.AUTH_BASE_URL === 'string' ? envObj.AUTH_BASE_URL : undefined);
  if (!baseURL && !options?.betterAuth?.baseURL) {
    throw new Error('baseURL is required: specify options.baseURL or env.AUTH_BASE_URL');
  }
  return baseURL ?? (options?.betterAuth?.baseURL as string);
}

function resolveSecret(options?: CreateAuthOptions, envObj?: AuthEnv): string {
  const secret =
    options?.secret ??
    (typeof envObj?.BETTER_AUTH_SECRET === 'string' ? envObj.BETTER_AUTH_SECRET : undefined);
  if (!secret && !options?.betterAuth?.secret) {
    throw new Error('secret is required: specify options.secret or env.BETTER_AUTH_SECRET');
  }
  return secret ?? (options?.betterAuth?.secret as string);
}

function buildPlugins(options?: CreateAuthOptions): BetterAuthPlugin[] {
  const plugins: BetterAuthPlugin[] = [admin()];
  if (options?.phone) {
    const phoneOpts = options.phone;
    const phonePluginOptions: PhoneNumberOptions = {
      ...phoneOpts,
      sendOTP: async (data, ctx) => {
        const req = ctx?.request;
        await phoneOpts.sendOTP(data, req);
      },
    };
    plugins.push(phoneNumber(phonePluginOptions));
  }
  if (options?.bearer) {
    plugins.push(bearer());
  }
  if (options?.plugins) {
    plugins.push(...options.plugins);
  }
  return plugins;
}

function buildSecondaryStorage(options?: CreateAuthOptions, envObj?: AuthEnv) {
  if (options?.secondaryStorage) {
    return options.secondaryStorage;
  }
  const kv = (options?.kv ?? envObj?.AUTH_KV) as KVStore | undefined;
  if (!kv || typeof kv !== 'object') {
    return;
  }
  return {
    get: (key: string) => kv.get(key),
    set: (key: string, value: string, ttl?: number) =>
      kv.put(key, value, ttl ? { expirationTtl: ttl } : undefined),
    delete: (key: string) => kv.delete(key),
  };
}

function buildDatabase(options?: CreateAuthOptions, envObj?: AuthEnv) {
  if (options?.database !== undefined) {
    return options.database;
  }
  if (envObj?.DB) {
    return { d1: envObj.DB };
  }
}

function getCachedInstance(env: object, optionsKey: string): AuthInstance | undefined {
  return instanceCache.get(env)?.get(optionsKey);
}

function setCachedInstance(env: object, optionsKey: string, instance: AuthInstance): void {
  let envMap = instanceCache.get(env);
  if (!envMap) {
    envMap = new Map();
    instanceCache.set(env, envMap);
  }
  envMap.set(optionsKey, instance);
}

export function createAuth(env: AuthEnv, options?: CreateAuthOptions): AuthInstance {
  const optionsKey = getOptionsKey(options);

  const cached = getCachedInstance(env, optionsKey);
  if (cached) {
    return cached;
  }

  const baseURL = resolveBaseURL(options, env);
  const secret = resolveSecret(options, env);
  const plugins = buildPlugins(options);
  const secondaryStorage = buildSecondaryStorage(options, env);
  const database = buildDatabase(options, env);

  const defaults = {
    basePath: '/api/auth',
  };

  const authConfig = {
    ...defaults,
    ...options,
    baseURL,
    secret,
    ...(database !== undefined && { database }),
    ...(secondaryStorage !== undefined && { secondaryStorage }),
    plugins,
    ...options?.betterAuth,
  };

  // @ts-expect-error betterAuth accepts custom database adapters like D1/Hyperdrive in Cloudflare Workers
  const instance = betterAuth(authConfig);
  void instance.$context.catch(() => {});

  setCachedInstance(env, optionsKey, instance);

  return instance;
}
