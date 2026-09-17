import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, mock } from 'bun:test';

interface PackageJson {
  name?: string;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface WranglerEnvConfig {
  vars?: Record<string, string>;
  compatibility_date?: string;
  compatibility_flags?: string[];
  hyperdrive?: Array<{ binding: string; id?: string; localConnectionString?: string }>;
  d1_databases?: Array<{ binding: string; database_name?: string; database_id?: string }>;
  kv_namespaces?: Array<{ binding: string; id?: string }>;
}

interface WranglerConfig extends WranglerEnvConfig {
  name?: string;
  main?: string;
  vars?: Record<string, string>;
  env?: Record<string, WranglerEnvConfig>;
}

interface ApiWranglerEnvConfig {
  kv_namespaces?: Array<{ binding: string; id?: string }>;
  services?: Array<{ binding: string; service: string }>;
}

interface ApiWranglerConfig {
  name?: string;
  main?: string;
  compatibility_flags?: string[];
  env?: Record<string, ApiWranglerEnvConfig>;
}

interface TsConfig {
  compilerOptions?: {
    strict?: boolean;
  };
}

interface WorkerModule {
  default: {
    fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response>;
  };
}

class FakeKV {
  readonly store = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
}

function createMockD1() {
  return {
    prepare: () => ({
      bind: () => ({
        all: () => Promise.resolve({ results: [], meta: { changes: 0 } }),
        first: () => Promise.resolve(null),
        run: () => Promise.resolve({ success: true, meta: { changes: 0 } }),
      }),
    }),
    batch: () => Promise.resolve([]),
    exec: () => Promise.resolve({ count: 0, duration: 0 }),
  };
}

class MockPool {
  connect = () =>
    Promise.resolve({
      query: () => Promise.resolve({ rows: [] }),
      release: () => {},
    });
  end = () => Promise.resolve();
}

void mock.module('pg', () => ({
  Pool: MockPool,
  default: { Pool: MockPool },
}));

const exampleDir = path.resolve(import.meta.dir, '../examples/hono');

function readJsonFile<T>(relativePath: string): T | undefined {
  const filePath = path.resolve(exampleDir, relativePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  if (!fs.existsSync(filePath)) return undefined;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  const raw = fs.readFileSync(filePath, 'utf8');
  const sanitized = raw
    .replaceAll(/\/\/[^\n]*/g, '')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/,(\s*[}\]])/g, '$1');
  return JSON.parse(sanitized) as T;
}

function readFileText(relativePath: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  return fs.readFileSync(path.resolve(exampleDir, relativePath), 'utf8');
}

const authWorkerPath = path.resolve(exampleDir, 'src/index.ts');
const apiWorkerPath = path.resolve(exampleDir, 'src/api.ts');

function stubAuthEnv(overrides: Record<string, unknown> = {}) {
  return {
    AUTH_BASE_URL: 'http://localhost',
    BETTER_AUTH_SECRET: 'test-secret-at-least-32-chars-long-1234567890',
    DB: createMockD1(),
    AUTH_KV: new FakeKV(),
    ...overrides,
  };
}

function stubCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        promises.push(promise);
      },
      passThroughOnException: () => {},
    },
    promises,
  };
}

function postJson(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const signIn = () =>
  postJson('http://localhost/auth/sign-in/social', { provider: 'google', callbackURL: '/' });

async function withCapturedLogs(run: () => Promise<void>): Promise<string[]> {
  const captured: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return captured;
}

describe('Example package scaffolding and configuration', () => {
  it('examples/hono/package.json exists with module type and package name', () => {
    const pkg = readJsonFile<PackageJson>('package.json');
    expect(pkg).toBeDefined();
    expect(pkg?.name).toBeDefined();
    expect(pkg?.type).toBe('module');
  });

  it('examples/hono/package.json defines dev script and environment scripts', () => {
    const pkg = readJsonFile<PackageJson>('package.json');
    expect(pkg?.scripts?.dev).toBeDefined();
    const scriptValues = Object.values(pkg?.scripts ?? {}).join(' ');
    expect(scriptValues).toMatch(/d1/);
    expect(scriptValues).toMatch(/hyperdrive|postgres/);
  });

  it('examples/hono/package.json declares required dependencies', () => {
    const pkg = readJsonFile<PackageJson>('package.json');
    const deps: Record<string, string> = {
      ...pkg?.dependencies,
      ...pkg?.devDependencies,
    };
    expect(deps['better-auth']).toBeDefined();
    expect(deps['hono']).toBeDefined();
    expect(deps['wrangler']).toBeDefined();
    expect(deps['better-auth-workers']).toBeDefined();
  });

  it('examples/hono/tsconfig.json exists and enables strict type checking', () => {
    const tsconfig = readJsonFile<TsConfig>('tsconfig.json');
    expect(tsconfig).toBeDefined();
    expect(tsconfig?.compilerOptions?.strict).toBe(true);
  });

  it('examples/hono/wrangler.jsonc defines Hyperdrive and D1 environments with nodejs_compat', () => {
    const wrangler = readJsonFile<WranglerConfig>('wrangler.jsonc');
    expect(wrangler).toBeDefined();

    const envEntries = Object.entries(wrangler?.env ?? {});
    expect(envEntries.length).toBeGreaterThanOrEqual(2);

    const hyperdriveEntry = envEntries.find(([, env]) => (env.hyperdrive?.length ?? 0) > 0);
    expect(hyperdriveEntry).toBeDefined();
    const hyperdriveEnv = hyperdriveEntry?.[1];
    const hyperdriveBinding = hyperdriveEnv?.hyperdrive?.[0];
    expect(hyperdriveBinding?.binding).toBeDefined();
    expect(
      Boolean(hyperdriveBinding?.localConnectionString || wrangler?.vars?.LOCAL_POSTGRES_URL)
    ).toBe(true);

    const d1Entry = envEntries.find(([, env]) => (env.d1_databases?.length ?? 0) > 0);
    expect(d1Entry).toBeDefined();
    const d1Env = d1Entry?.[1];

    const rootKv = wrangler?.kv_namespaces?.some((kv) => kv.binding === 'AUTH_KV');
    const hyperdriveKv = hyperdriveEnv?.kv_namespaces?.some((kv) => kv.binding === 'AUTH_KV');
    const d1Kv = d1Env?.kv_namespaces?.some((kv) => kv.binding === 'AUTH_KV');
    expect(Boolean(rootKv || (hyperdriveKv && d1Kv))).toBe(true);

    const flags = [
      ...(wrangler?.compatibility_flags ?? []),
      ...(hyperdriveEnv?.compatibility_flags ?? []),
      ...(d1Env?.compatibility_flags ?? []),
    ];
    expect(flags).toContain('nodejs_compat');
  });
});

describe('Example secrets handling', () => {
  it('keeps BETTER_AUTH_SECRET out of wrangler.jsonc and documents .dev.vars instead', () => {
    const raw = readFileText('wrangler.jsonc');
    const wrangler = readJsonFile<WranglerConfig>('wrangler.jsonc');
    const allVars = [wrangler?.vars, ...Object.values(wrangler?.env ?? {}).map((e) => e.vars)];
    for (const vars of allVars) expect(vars?.BETTER_AUTH_SECRET).toBeUndefined();
    expect(raw).not.toMatch(/"BETTER_AUTH_SECRET"\s*:/);

    expect(readFileText('.dev.vars.example')).toMatch(/^BETTER_AUTH_SECRET=/m);
    const readme = readFileText('README.md');
    expect(readme).toMatch(/\.dev\.vars/);
    expect(readme).toMatch(/wrangler secret put BETTER_AUTH_SECRET/);
  });
});

describe('Example TypeScript typechecking', () => {
  it('typechecks examples/hono against better-auth-workers public types with no errors', () => {
    const tsconfigPath = path.resolve(exampleDir, 'tsconfig.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
    const hasConfigFile = fs.existsSync(tsconfigPath);
    expect(hasConfigFile).toBe(true);
    if (!hasConfigFile) return;

    const tscBin = path.resolve(import.meta.dir, '../node_modules/.bin/tsc');
    const result = spawnSync(tscBin, ['-p', tsconfigPath, '--noEmit'], {
      cwd: exampleDir,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });
});

describe('Hono auth Worker implementation', () => {
  it('serves Better Auth under /auth/* through createAuth', async () => {
    const { default: app } = (await import(authWorkerPath)) as WorkerModule;
    expect(typeof app.fetch).toBe('function');

    const res = await app.fetch(
      new Request('http://localhost/auth/ok'),
      stubAuthEnv(),
      stubCtx().ctx
    );

    expect(res.status).toBe(200);
    const body: { ok?: boolean } = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('delivers a phone OTP by logging it, marked for local use only, under the request’s waitUntil', async () => {
    const { default: app } = (await import(authWorkerPath)) as WorkerModule;
    const { ctx, promises } = stubCtx();

    const logs = await withCapturedLogs(async () => {
      const res = await app.fetch(
        postJson('http://localhost/auth/phone-number/send-otp', { phoneNumber: '+15551234567' }),
        stubAuthEnv(),
        ctx
      );
      expect(res.status).toBe(200);
      await Promise.all(promises);
    });

    expect(promises).toHaveLength(1);
    const otpLine = logs.find((line) => /OTP for \+15551234567: \d{6}/.test(line));
    expect(otpLine).toBeDefined();
    expect(otpLine).toMatch(/local use only - not for production/);
  });

  it('delivers a magic link by logging it, marked for local use only, under the request’s waitUntil', async () => {
    const { default: app } = (await import(authWorkerPath)) as WorkerModule;
    const { ctx, promises } = stubCtx();

    const logs = await withCapturedLogs(async () => {
      const res = await app.fetch(
        postJson('http://localhost/auth/sign-in/magic-link', { email: 'someone@example.com' }),
        stubAuthEnv(),
        ctx
      );
      expect(res.status).toBe(200);
      await Promise.all(promises);
    });

    expect(promises).toHaveLength(1);
    const linkLine = logs.find((line) => line.includes('Magic link for someone@example.com'));
    expect(linkLine).toBeDefined();
    expect(linkLine).toMatch(/local use only - not for production/);
    expect(linkLine).toMatch(/http:\/\/localhost\/auth\/magic-link\/verify\?token=/);
  });

  it('enables Google sign-in only when the Google secrets are bound', async () => {
    const { default: app } = (await import(authWorkerPath)) as WorkerModule;

    const withoutSecrets = await app.fetch(signIn(), stubAuthEnv(), stubCtx().ctx);
    expect(withoutSecrets.status).toBe(403);

    const withSecrets = await app.fetch(
      signIn(),
      stubAuthEnv({ GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' }),
      stubCtx().ctx
    );
    expect(withSecrets.status).not.toBe(403);
    expect(withSecrets.status).not.toBe(404);
  });
});

describe('Second Worker with service binding and session validation', () => {
  it('has its own wrangler config binding the auth Worker as a service and sharing its KV namespace', () => {
    const config = readJsonFile<ApiWranglerConfig>('api.wrangler.jsonc');
    expect(config).toBeDefined();
    expect(config?.main).toBe('src/api.ts');
    expect(config?.compatibility_flags).toContain('nodejs_compat');

    const authConfig = readJsonFile<WranglerConfig>('wrangler.jsonc');
    const authEnvs = new Map(Object.entries(authConfig?.env ?? {}));
    const apiEnvs = Object.entries(config?.env ?? {});
    expect(apiEnvs.map(([name]) => name)).toEqual(['d1', 'hyperdrive']);
    for (const [envName, env] of apiEnvs) {
      expect(env.services).toEqual([
        { binding: 'AUTH', service: `${authConfig?.name}-${envName}` },
      ]);
      const authKv = authEnvs.get(envName)?.kv_namespaces?.find((kv) => kv.binding === 'AUTH_KV');
      expect(env.kv_namespaces).toEqual([{ binding: 'AUTH_KV', id: authKv?.id }]);
    }
  });

  it('has dev scripts for running the API Worker against each backend', () => {
    const pkg = readJsonFile<PackageJson>('package.json');
    expect(pkg?.scripts?.['dev:api']).toMatch(/api\.wrangler\.jsonc/);
    expect(pkg?.scripts?.['dev:api']).toMatch(/--env d1/);
    expect(pkg?.scripts?.['dev:api:hyperdrive']).toMatch(/--env hyperdrive/);
  });

  it('rejects unauthenticated requests with 401 over service binding', async () => {
    const { default: app } = (await import(apiWorkerPath)) as WorkerModule;
    expect(typeof app.fetch).toBe('function');

    const stubEnv = {
      AUTH: { fetch: () => Promise.resolve(Response.json(null)) },
      AUTH_KV: new FakeKV(),
    };

    const res = await app.fetch(new Request('http://localhost/me'), stubEnv, stubCtx().ctx);
    expect(res.status).toBe(401);
  });

  it('accepts authenticated requests with a valid session over service binding', async () => {
    const { default: app } = (await import(apiWorkerPath)) as WorkerModule;

    const mockSession = {
      session: {
        id: 'sess-1',
        token: 'tok-1',
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      user: { id: 'user-1', email: 'user@example.com' },
    };
    const authCalls: string[] = [];
    const stubEnv = {
      AUTH: {
        fetch: (input: Request | string | URL) => {
          authCalls.push(input instanceof Request ? input.url : String(input));
          return Promise.resolve(Response.json(mockSession));
        },
      },
      AUTH_KV: new FakeKV(),
    };

    const req = new Request('http://localhost/me', {
      // A Better Auth cookie is `<token>.<signature>`; the stub auth Worker
      // above accepts it, the way the real one would after verifying it.
      headers: { cookie: 'better-auth.session_token=tok-1.c2lnbmF0dXJl' },
    });
    const res = await app.fetch(req, stubEnv, stubCtx().ctx);

    expect(res.status).toBe(200);
    const user: typeof mockSession.user = await res.json();
    expect(user).toEqual(mockSession.user);
    // The client fetches get-session under the auth Worker's basePath.
    expect(authCalls).toEqual(['https://auth.internal/auth/get-session?disableCookieCache=true']);
  });
});
