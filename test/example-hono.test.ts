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

function readFileText(relativePath: string): string | undefined {
  const filePath = path.resolve(exampleDir, relativePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  if (!fs.existsSync(filePath)) return undefined;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  return fs.readFileSync(filePath, 'utf8');
}

function getSecondWorkerPath(): string | undefined {
  const candidates = [
    path.resolve(exampleDir, 'src/api.ts'),
    path.resolve(exampleDir, 'src/consumer.ts'),
  ];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  return candidates.find((p) => fs.existsSync(p));
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
  it('examples/hono/src/index.ts exists and exports a Hono application', () => {
    const authSource = readFileText('src/index.ts');
    expect(authSource).toBeDefined();
    expect(authSource).toMatch(/new Hono/);
    expect(authSource).toMatch(/export default/);
  });

  it('auth Worker serves /auth/* using createAuth', () => {
    const authSource = readFileText('src/index.ts');
    expect(authSource).toBeDefined();
    expect(authSource).toMatch(/\/auth/);
    expect(authSource).toContain('createAuth');
  });

  it('auth Worker enables phone OTP with console-logging sendOTP marked not for production', () => {
    const authSource = readFileText('src/index.ts');
    expect(authSource).toBeDefined();
    expect(authSource).toMatch(/phone\s*:/);
    expect(authSource).toMatch(/sendOTP/);
    expect(authSource).toMatch(/console\.log/);
    expect(authSource).toMatch(
      /not (for|safe for) production|do not (use|ship) in production|local( use)? only/i
    );
  });

  it('auth Worker enables Google sign-in and bearer plugin', () => {
    const authSource = readFileText('src/index.ts');
    expect(authSource).toBeDefined();
    expect(authSource).toMatch(/google\s*:/);
    expect(authSource).toMatch(/bearer\s*:\s*true/);
  });

  it('auth Worker fetch handler responds without throwing when constructed with stub bindings', async () => {
    const indexPath = path.resolve(exampleDir, 'src/index.ts');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
    const hasWorkerSource = fs.existsSync(indexPath);
    expect(hasWorkerSource).toBe(true);
    if (!hasWorkerSource) return;

    const appModule = (await import(indexPath)) as WorkerModule;
    const app = appModule.default;
    expect(typeof app.fetch).toBe('function');

    const stubEnv = {
      AUTH_BASE_URL: 'http://localhost',
      BETTER_AUTH_SECRET: 'test-secret-at-least-32-chars-long-1234567890',
      DB: createMockD1(),
      AUTH_KV: new FakeKV(),
    };
    const stubCtx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    };

    const req = new Request('http://localhost/auth/ok');
    const res = await app.fetch(req, stubEnv, stubCtx);
    expect(res).toBeInstanceOf(Response);
  });
});

describe('Second minimal Worker with service binding and session validation', () => {
  it('second Worker exists demonstrating createSessionClient and requireSession', () => {
    const secondWorkerPath = getSecondWorkerPath();
    expect(secondWorkerPath).toBeDefined();
    if (!secondWorkerPath) return;

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
    const source = fs.readFileSync(secondWorkerPath, 'utf8');
    expect(source).toContain('createSessionClient');
    expect(source).toContain('requireSession');
  });

  it('second Worker defines protected route with session middleware over service binding', () => {
    const secondWorkerPath = getSecondWorkerPath();
    expect(secondWorkerPath).toBeDefined();
    if (!secondWorkerPath) return;

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
    const source = fs.readFileSync(secondWorkerPath, 'utf8');
    expect(source).toMatch(/service|AUTH/i);
    expect(source).toMatch(/requireSession\s*\(/);
  });

  it('second Worker rejects unauthenticated requests with 401 over service binding', async () => {
    const secondWorkerPath = getSecondWorkerPath();
    expect(secondWorkerPath).toBeDefined();
    if (!secondWorkerPath) return;

    const mod = (await import(secondWorkerPath)) as WorkerModule;
    const app = mod.default;
    expect(typeof app.fetch).toBe('function');

    const stubEnv = {
      AUTH: {
        fetch: () => Promise.resolve(Response.json(null)),
      },
      AUTH_KV: new FakeKV(),
    };
    const stubCtx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    };

    const req = new Request('http://localhost/me');
    const res = await app.fetch(req, stubEnv, stubCtx);
    expect(res.status).toBe(401);
  });

  it('second Worker accepts authenticated requests with valid session over service binding', async () => {
    const secondWorkerPath = getSecondWorkerPath();
    expect(secondWorkerPath).toBeDefined();
    if (!secondWorkerPath) return;

    const mod = (await import(secondWorkerPath)) as WorkerModule;
    const app = mod.default;
    expect(typeof app.fetch).toBe('function');

    const mockSession = {
      session: {
        id: 'sess-1',
        token: 'tok-1',
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      user: {
        id: 'user-1',
        email: 'user@example.com',
      },
    };

    const stubEnv = {
      AUTH: {
        fetch: () => Promise.resolve(Response.json(mockSession)),
      },
      AUTH_KV: new FakeKV(),
    };
    const stubCtx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    };

    const req = new Request('http://localhost/me', {
      headers: { cookie: 'better-auth.session_token=tok-1' },
    });
    const res = await app.fetch(req, stubEnv, stubCtx);
    expect(res.status).toBe(200);
  });
});
