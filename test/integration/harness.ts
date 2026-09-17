import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { SQL } from 'bun';

import { type PostgresProxy, startPostgresProxy } from './postgres-proxy';

export type Backend = 'd1' | 'hyperdrive';

export interface Counters {
  // Statements sent to the primary store (D1 statements, or Postgres
  // statements on the wire for the Hyperdrive backend).
  primaryQueries: number;
  // KV reads through the auth Worker's AUTH_KV binding.
  kvReads: number;
}

export interface DevServer {
  baseUrl: string;
  // The example's configured AUTH_BASE_URL: Better Auth's trusted origin,
  // which cookie-bearing POSTs must name in `Origin` to pass its CSRF check.
  appOrigin: string;
  output: () => string;
  waitForOutput: (
    pattern: RegExp,
    timeoutMs?: number,
    isWanted?: (match: RegExpExecArray) => boolean
  ) => Promise<RegExpExecArray>;
  counters: () => Promise<Counters>;
  stop: () => Promise<void>;
}

const rootDir = path.resolve(import.meta.dir, '../..');
const wranglerBin = path.resolve(rootDir, 'node_modules/.bin/wrangler');
const exampleConfig = path.resolve(rootDir, 'examples/hono/wrangler.jsonc');
const authWrapperEntry = path.resolve(import.meta.dir, 'auth/index.ts');
const gatewayConfig = path.resolve(import.meta.dir, 'gateway.wrangler.jsonc');
const apiConfig = path.resolve(import.meta.dir, 'api.wrangler.jsonc');
const persistRoot = path.resolve(import.meta.dir, '.wrangler');

const READY_TIMEOUT_MS = 90_000;
const INTEGRATION_SECRET = 'integration-secret-value-must-be-at-least-32-chars-long';

export function requestedBackends(): Backend[] {
  const raw = Bun.env.INTEGRATION_BACKENDS ?? '';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is Backend => value === 'd1' || value === 'hyperdrive');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('could not allocate a port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readMigration(dialect: 'postgres' | 'sqlite'): string {
  const file = path.resolve(rootDir, `migrations/${dialect}/0001_init.sql`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  return fs.readFileSync(file, 'utf8');
}

interface PostgresHandle {
  connectionString: string;
  stop: () => Promise<void>;
}

async function waitForPostgres(adminUrl: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const sql = new SQL(adminUrl);
    try {
      await sql`select 1`;
      await sql.close();
      return;
    } catch (error) {
      lastError = error;
      try {
        await sql.close();
      } catch {
        // the failed connection is being discarded anyway
      }
      await sleep(500);
    }
  }
  throw new Error(`postgres did not become ready: ${String(lastError)}`);
}

function dockerBin(): string {
  const bin = Bun.which('docker');
  if (!bin) throw new Error('docker is required to start a local Postgres container');
  return bin;
}

// `docker run -d` returns before the container has necessarily published
// its port; poll until it is running and the mapping is visible instead of
// reading it once and failing the whole collection on a slow start.
function waitForMappedPort(docker: string, name: string): string | undefined {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = spawnSync(docker, ['inspect', '-f', '{{.State.Running}}', name], {
      encoding: 'utf8',
    });
    if (state.status === 0 && state.stdout.trim() === 'true') {
      const port = spawnSync(docker, ['port', name, '5432'], { encoding: 'utf8' });
      const match = /:(\d+)\s*$/m.exec(port.stdout);
      if (match) return match[1];
    }
    Bun.sleepSync(250);
  }
}

function startPostgresContainer(): { adminUrl: string; stop: () => Promise<void> } {
  const docker = dockerBin();
  const name = `better-auth-workers-it-${crypto.randomUUID().slice(0, 8)}-${String(Date.now())}`;
  const run = spawnSync(
    docker,
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-p',
      '127.0.0.1:0:5432',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      'postgres:17-alpine',
    ],
    { encoding: 'utf8' }
  );
  if (run.status !== 0) {
    throw new Error(`docker run failed: ${run.stderr}`);
  }
  const mappedPort = waitForMappedPort(docker, name);
  if (!mappedPort) {
    spawnSync(docker, ['rm', '-f', name]);
    throw new Error(`container ${name} did not publish port 5432 in time`);
  }
  return {
    adminUrl: `postgresql://postgres:postgres@127.0.0.1:${mappedPort}/postgres`,
    stop: () => {
      spawnSync(docker, ['rm', '-f', name]);
      return Promise.resolve();
    },
  };
}

async function provisionPostgres(): Promise<PostgresHandle> {
  const external = Bun.env.INTEGRATION_POSTGRES_URL;
  const container = external ? undefined : startPostgresContainer();
  const adminUrl = external ?? (container as { adminUrl: string }).adminUrl;
  await waitForPostgres(adminUrl);

  const dbName = `auth_it_${Date.now().toString(36)}`;
  const admin = new SQL(adminUrl);
  await admin.unsafe(`create database ${dbName}`);
  await admin.close();

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const connectionString = url.href;

  const db = new SQL(connectionString);
  await db.unsafe(readMigration('postgres'));
  await db.close();

  return {
    connectionString,
    stop: async () => {
      if (container) {
        await container.stop();
        return;
      }
      const cleanup = new SQL(adminUrl);
      try {
        await cleanup.unsafe(`drop database if exists ${dbName} with (force)`);
      } finally {
        await cleanup.close();
      }
    },
  };
}

// The auth Worker under test is the example's own wrangler config (name,
// bindings, environments, flags) with only `main` pointed at the counting
// wrapper in ./auth, so the config the example ships stays what is exercised.
interface ExampleConfig {
  $schema?: string;
  main?: string;
  vars?: Record<string, string>;
  env?: Record<string, { vars?: Record<string, string> }>;
}

function readExampleConfig(): ExampleConfig {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  const raw = fs.readFileSync(exampleConfig, 'utf8');
  return JSON.parse(
    raw
      .replaceAll(/\/\/[^\n]*/g, '')
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .replaceAll(/,(\s*[}\]])/g, '$1')
  ) as ExampleConfig;
}

function exampleAppOrigin(backend: Backend): string {
  const config = readExampleConfig();
  const envConfig = new Map(Object.entries(config.env ?? {})).get(backend);
  const baseUrl = envConfig?.vars?.AUTH_BASE_URL ?? config.vars?.AUTH_BASE_URL;
  if (!baseUrl) throw new Error('examples/hono/wrangler.jsonc sets no AUTH_BASE_URL');
  return new URL(baseUrl).origin;
}

function writeAuthWorkerConfig(persistTo: string): string {
  const config = readExampleConfig();
  delete config.$schema;
  config.main = authWrapperEntry;
  const configPath = path.join(persistTo, 'auth.wrangler.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-owned persist directory
  fs.mkdirSync(persistTo, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-owned persist directory
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  // The signing secret is not in the example's config (it is a secret);
  // wrangler dev reads it from a .dev.vars beside the config it is given.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-owned persist directory
  fs.writeFileSync(path.join(persistTo, '.dev.vars'), `BETTER_AUTH_SECRET=${INTEGRATION_SECRET}\n`);
  return configPath;
}

function applyD1Migration(persistTo: string): void {
  const result = spawnSync(
    wranglerBin,
    [
      'd1',
      'execute',
      'example-auth-db',
      '--local',
      '--env',
      'd1',
      '-c',
      exampleConfig,
      '--persist-to',
      persistTo,
      '--file',
      path.resolve(rootDir, 'migrations/sqlite/0001_init.sql'),
    ],
    { cwd: rootDir, encoding: 'utf8', env: { ...Bun.env, CI: '1' } }
  );
  if (result.status !== 0) {
    throw new Error(`d1 migration failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function spawnWrangler(
  backend: Backend,
  port: number,
  persistTo: string,
  authConfig: string,
  extraEnv: Record<string, string>
): ChildProcess {
  return spawn(
    wranglerBin,
    [
      'dev',
      '-c',
      gatewayConfig,
      '-c',
      authConfig,
      '-c',
      apiConfig,
      '--env',
      backend,
      '--port',
      String(port),
      '--inspector-port',
      '0',
      '--persist-to',
      persistTo,
      '--show-interactive-dev-session=false',
    ],
    {
      cwd: rootDir,
      env: { ...Bun.env, CI: '1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
}

function findMatch(
  text: string,
  pattern: RegExp,
  isWanted: (match: RegExpExecArray) => boolean
): RegExpExecArray | undefined {
  for (const line of text.split('\n')) {
    const match = pattern.exec(line);
    if (match && isWanted(match)) return match;
  }
}

export async function startDevServer(backend: Backend): Promise<DevServer> {
  const persistTo = path.resolve(persistRoot, backend);
  fs.rmSync(persistTo, { recursive: true, force: true });

  const extraEnv: Record<string, string> = {};
  let postgres: PostgresHandle | undefined;
  let proxy: PostgresProxy | undefined;
  if (backend === 'hyperdrive') {
    postgres = await provisionPostgres();
    proxy = await startPostgresProxy(postgres.connectionString);
    extraEnv.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = proxy.connectionString;
  } else {
    applyD1Migration(persistTo);
  }
  const authConfig = writeAuthWorkerConfig(persistTo);

  const port = await freePort();
  const child = spawnWrangler(backend, port, persistTo, authConfig, extraEnv);

  let buffer = '';
  const state: { exited?: { code: number | null; signal: NodeJS.Signals | null } } = {};
  const append = (chunk: Buffer) => {
    buffer += chunk.toString();
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('exit', (code, signal) => {
    state.exited = { code, signal };
  });

  const waitForOutput = async (
    pattern: RegExp,
    timeoutMs = 15_000,
    isWanted: (match: RegExpExecArray) => boolean = () => true
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = findMatch(buffer, pattern, isWanted);
      if (match) return match;
      if (state.exited) {
        throw new Error(
          `wrangler dev exited (code ${String(state.exited.code)}, signal ${String(state.exited.signal)}) before matching ${String(pattern)}:\n${buffer}`
        );
      }
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${String(pattern)} in wrangler output:\n${buffer}`);
  };

  const hasExited = () => state.exited !== undefined;

  const stop = async () => {
    if (!hasExited()) {
      child.kill('SIGTERM');
      const deadline = Date.now() + 10_000;
      while (!hasExited() && Date.now() < deadline) {
        await sleep(100);
      }
      if (!hasExited()) child.kill('SIGKILL');
    }
    await proxy?.close();
    await postgres?.stop();
  };

  try {
    await waitForOutput(/Ready on (http:\/\/\S+)/, READY_TIMEOUT_MS);
  } catch (error) {
    await stop();
    throw error;
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/__gateway/auth-calls`);
      break;
    } catch {
      await sleep(250);
    }
  }

  const counters = async (): Promise<Counters> => {
    const response = await fetch(`${baseUrl}/__auth/counters`);
    const body: Counters = await response.json();
    return proxy ? { ...body, primaryQueries: proxy.statements() } : body;
  };

  return {
    baseUrl,
    appOrigin: exampleAppOrigin(backend),
    output: () => buffer,
    waitForOutput,
    counters,
    stop,
  };
}
