import type { BetterAuthPlugin } from 'better-auth';
import { betterAuth } from 'better-auth';
import type { PhoneNumberOptions } from 'better-auth/plugins';
import { admin, bearer, phoneNumber } from 'better-auth/plugins';

export type AuthEnv = Record<
  string,
  string | KVNamespace | Hyperdrive | D1Database | Fetcher | boolean | number | object | undefined
>;

export interface ExecutionContext {
  waitUntil(promise: Promise<void | Response>): void;
  passThroughOnException?(): void;
}

export type ConfigValue =
  string | number | boolean | object | ((...args: never[]) => Promise<void> | void) | undefined;

export interface CreateAuthPhoneOptions {
  sendOTP: (args: { phoneNumber: string; code: string }, request?: Request) => Promise<void> | void;
  otpLength?: number;
  expiresIn?: number;
  allowedAttempts?: number;
}

export type HyperdriveDatabaseOption =
  Hyperdrive | { connectionString: string; [key: string]: ConfigValue };

export interface CreateAuthDatabaseOptions {
  hyperdrive?: HyperdriveDatabaseOption;
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
  database?: CreateAuthDatabaseOptions | D1Database;
  kv?: KVStore;
  secondaryStorage?: CreateAuthSecondaryStorage;
  ctx?: ExecutionContext;
  phone?: CreateAuthPhoneOptions;
  google?: boolean | { clientId: string; clientSecret: string };
  bearer?: boolean;
  allowedMethods?: Array<'phone' | 'google' | 'magic-link'>;
  plugins?: BetterAuthPlugin[];
  betterAuth?: Record<string, ConfigValue>;
  [key: string]: ConfigValue;
}

export type AuthInstance = ReturnType<typeof betterAuth>;

const instanceCache = new WeakMap<object, Map<string, AuthInstance>>();

function getOptionsKey(options?: CreateAuthOptions): string {
  if (!options || Object.keys(options).length === 0) return '{}';
  return JSON.stringify(
    options,
    (key: string, value: string | number | boolean | object | null | undefined) => {
      if (key === 'ctx') return;
      return value;
    }
  );
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

type PgPoolConfig = {
  connectionString?: string;
  max?: number;
  [key: string]: ConfigValue;
};

interface PgPool {
  end(): Promise<void>;
  [key: string]: ConfigValue;
}

interface PgModule {
  Pool: new (config: PgPoolConfig) => PgPool;
  default?: {
    Pool: new (config: PgPoolConfig) => PgPool;
  };
}

function loadPgPoolClass(): (new (config: PgPoolConfig) => PgPool) | undefined {
  try {
    const req = typeof require === 'function' ? require : undefined;
    const pg = req ? (req('pg') as PgModule) : undefined;
    return pg?.Pool ?? pg?.default?.Pool;
  } catch {
    return;
  }
}

function getHyperdriveOption(
  database?: CreateAuthDatabaseOptions | D1Database
): HyperdriveDatabaseOption | undefined {
  if (database && typeof database === 'object' && 'hyperdrive' in database) {
    return database.hyperdrive;
  }
}

function resolveHyperdriveConnectionString(
  options?: CreateAuthOptions,
  envObj?: AuthEnv
): string | undefined {
  const hyperdriveOption = getHyperdriveOption(options?.database);
  if (
    hyperdriveOption &&
    typeof hyperdriveOption === 'object' &&
    'connectionString' in hyperdriveOption &&
    typeof hyperdriveOption.connectionString === 'string'
  ) {
    return hyperdriveOption.connectionString;
  }
  if (options?.database !== undefined) {
    return;
  }
  const envHyperdrive = envObj?.HYPERDRIVE as { connectionString?: string } | undefined;
  if (
    envHyperdrive &&
    typeof envHyperdrive === 'object' &&
    typeof envHyperdrive.connectionString === 'string'
  ) {
    return envHyperdrive.connectionString;
  }
}

function isEnvLike(obj: object | undefined): obj is AuthEnv {
  if (!obj) return false;
  if ('AUTH_BASE_URL' in obj || 'BETTER_AUTH_SECRET' in obj) return true;
  return 'DB' in obj || 'HYPERDRIVE' in obj;
}

function isOptionsLike(obj: object | undefined): obj is CreateAuthOptions {
  if (!obj) return false;
  if ('database' in obj || 'phone' in obj || 'bearer' in obj) return true;
  return 'allowedMethods' in obj || 'betterAuth' in obj || 'secondaryStorage' in obj;
}

function normalizeArgs(
  arg1: AuthEnv | CreateAuthOptions,
  arg2?: CreateAuthOptions | AuthEnv
): { env: AuthEnv; options?: CreateAuthOptions } {
  if (isEnvLike(arg2) && !isEnvLike(arg1)) {
    return {
      env: arg2,
      options: arg1,
    };
  }
  if (isOptionsLike(arg1)) {
    return {
      env: arg2 ?? {},
      options: arg1,
    };
  }
  return {
    env: arg1,
    options: arg2,
  };
}

export type ResolvedDatabase =
  PgPool | D1Database | Record<string, (arg?: string) => void> | ConfigValue;

interface BuildDatabaseResult {
  database: ResolvedDatabase;
  pool?: PgPool;
}

function resolveD1Binding(
  options?: CreateAuthOptions,
  envObj?: AuthEnv
): D1Database | Record<string, (arg?: string) => void> | undefined {
  const databaseOpt = options?.database;
  if (databaseOpt && typeof databaseOpt === 'object') {
    if ('d1' in databaseOpt && databaseOpt.d1) {
      return databaseOpt.d1;
    }
    if ('prepare' in databaseOpt || 'batch' in databaseOpt) {
      return databaseOpt as D1Database;
    }
  }

  if (options?.database === undefined && envObj?.DB) {
    return envObj.DB as D1Database;
  }
}

function buildDatabase(options?: CreateAuthOptions, envObj?: AuthEnv): BuildDatabaseResult {
  const connectionString = resolveHyperdriveConnectionString(options, envObj);
  if (connectionString) {
    const PoolClass = loadPgPoolClass();
    if (PoolClass) {
      const pool = new PoolClass({
        connectionString,
        max: 5,
      });
      return { database: pool, pool };
    }
  }

  const d1 = resolveD1Binding(options, envObj);
  if (d1) {
    return { database: d1 };
  }

  if (options?.betterAuth?.database) {
    return { database: options.betterAuth.database };
  }

  throw new Error(
    'database is required: specify options.database.hyperdrive or options.database.d1 (or provide HYPERDRIVE or DB on env)'
  );
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

export function createAuth(env: AuthEnv, options?: CreateAuthOptions): AuthInstance;
export function createAuth(options: CreateAuthOptions, env?: AuthEnv): AuthInstance;
export function createAuth(
  arg1: AuthEnv | CreateAuthOptions,
  arg2?: CreateAuthOptions | AuthEnv
): AuthInstance {
  const { env, options } = normalizeArgs(arg1, arg2);
  const isHyperdrive = Boolean(resolveHyperdriveConnectionString(options, env));
  const optionsKey = getOptionsKey(options);

  if (!isHyperdrive) {
    const cached = getCachedInstance(env, optionsKey);
    if (cached) {
      return cached;
    }
  }

  const baseURL = resolveBaseURL(options, env);
  const secret = resolveSecret(options, env);
  const plugins = buildPlugins(options);
  const secondaryStorage = buildSecondaryStorage(options, env);
  const { database, pool } = buildDatabase(options, env);

  const defaults = {
    basePath: '/api/auth',
    advanced: {
      database: {
        validateSchema: false,
      },
    },
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

  if (pool) {
    const originalHandler = instance.handler.bind(instance);
    instance.handler = async (request: Request, ctx?: ExecutionContext) => {
      try {
        const response = await originalHandler(request);
        return response;
      } finally {
        const execCtx = ctx ?? options?.ctx;
        if (execCtx && typeof execCtx.waitUntil === 'function') {
          execCtx.waitUntil(pool.end());
        } else {
          setTimeout(() => {
            void pool.end();
          }, 0);
        }
      }
    };
  }

  if (!isHyperdrive) {
    setCachedInstance(env, optionsKey, instance);
  }

  return instance;
}
