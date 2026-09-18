import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'bun:test';

interface PackageJson {
  name?: string;
  exports?: Record<string, unknown>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

interface TsConfig {
  compilerOptions?: {
    strict?: boolean;
    types?: string[];
  };
}

// Every path below is built from import.meta.dir plus a fixed relative
// string, never from external input, so the non-literal-argument warning
// these fs calls trigger does not apply.

function readPackageJson(): PackageJson | undefined {
  const pkgPath = path.resolve(import.meta.dir, '../package.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path, see file header
  if (!fs.existsSync(pkgPath)) return undefined;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path, see file header
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
}

function readTsConfig(): TsConfig | undefined {
  const tsconfigPath = path.resolve(import.meta.dir, '../tsconfig.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path, see file header
  if (!fs.existsSync(tsconfigPath)) return undefined;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path, see file header
  const raw = fs.readFileSync(tsconfigPath, 'utf8');
  const content = raw.replaceAll(/\/\/[^\n]*/g, '').replaceAll(/\/\*.*?\*\//gs, '');
  return JSON.parse(content) as TsConfig;
}

function readWorkflows(): string {
  const workflowsDir = path.resolve(import.meta.dir, '../.github/workflows');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path, see file header
  if (!fs.existsSync(workflowsDir)) return '';
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path, see file header
  const files = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  return files
    .map((f) =>
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path, see file header
      fs.readFileSync(path.join(workflowsDir, f), 'utf8')
    )
    .join('\n');
}

describe('Package scaffolding and metadata', () => {
  it('package.json exists with package name and module type', () => {
    const pkg = readPackageJson();
    expect(pkg?.name).toBe('better-auth-workers');
  });

  it('package.json defines exports mapping for . entry point', () => {
    const pkg = readPackageJson();
    expect(pkg?.exports?.['.']).toBeDefined();
  });

  it('package.json defines exports mapping for ./client entry point', () => {
    const pkg = readPackageJson();
    expect(pkg?.exports?.['./client']).toBeDefined();
  });

  it('package.json defines better-auth ^1.7 peer dependency', () => {
    const pkg = readPackageJson();
    expect(pkg?.peerDependencies?.['better-auth'] ?? '').toMatch(/^\^1\.7/);
  });

  it('package.json defines optional pg ^8 peer dependency', () => {
    const pkg = readPackageJson();
    expect(pkg?.peerDependencies?.['pg'] ?? '').toMatch(/^\^8/);
  });

  it('package.json marks pg as optional peer dependency in peerDependenciesMeta', () => {
    const pkg = readPackageJson();
    expect(pkg?.peerDependenciesMeta?.['pg']?.optional).toBe(true);
  });

  it('package.json defines optional hono ^4 peer dependency', () => {
    const pkg = readPackageJson();
    expect(pkg?.peerDependencies?.['hono'] ?? '').toMatch(/^\^4/);
  });

  it('package.json marks hono as optional peer dependency in peerDependenciesMeta', () => {
    const pkg = readPackageJson();
    expect(pkg?.peerDependenciesMeta?.['hono']?.optional).toBe(true);
  });

  it('package.json defines wrangler ^4 as dev dependency', () => {
    const pkg = readPackageJson();
    expect(pkg?.devDependencies?.['wrangler'] ?? '').toMatch(/^\^4/);
  });

  for (const script of ['test', 'ts-check', 'lint', 'build']) {
    it(`package.json defines ${script} script`, () => {
      const pkg = readPackageJson();
      // eslint-disable-next-line security/detect-object-injection -- script is one of the fixed literals above, not external input
      expect(pkg?.scripts?.[script]).toBeDefined();
    });
  }

  it('tsconfig.json enables strict mode', () => {
    const tsconfig = readTsConfig();
    expect(tsconfig?.compilerOptions?.strict).toBe(true);
  });

  it('tsconfig.json includes workers-types', () => {
    const tsconfig = readTsConfig();
    const types: string[] = tsconfig?.compilerOptions?.types ?? [];
    expect(types).toContain('@cloudflare/workers-types');
  });

  // `AuthEnv` names the ambient KVNamespace/Hyperdrive/D1Database globals;
  // the emitted declarations must say where they come from, and the
  // package must admit that dependency, or a consumer without the types
  // package sees unresolved names.
  it('the public types carry a preserved reference to @cloudflare/workers-types', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
    const source = fs.readFileSync(path.resolve(import.meta.dir, '../src/types.ts'), 'utf8');
    const [firstLine] = source.split('\n', 1);
    expect(firstLine).toBe('/// <reference types="@cloudflare/workers-types" preserve="true" />');
  });

  it('package.json declares @cloudflare/workers-types as an optional peer dependency', () => {
    const pkg = readPackageJson();
    expect(pkg?.peerDependencies?.['@cloudflare/workers-types']).toBeDefined();
    expect(pkg?.peerDependenciesMeta?.['@cloudflare/workers-types']?.optional).toBe(true);
  });

  it('GitHub Actions workflow triggers on push', () => {
    const workflows = readWorkflows();
    expect(workflows).toMatch(/push\s*:/);
  });

  it('GitHub Actions workflow triggers on pull request', () => {
    const workflows = readWorkflows();
    expect(workflows).toMatch(/pull_request\s*:/);
  });

  it('GitHub Actions workflow runs test script', () => {
    const workflows = readWorkflows();
    expect(workflows).toMatch(/bun (run )?test/);
  });

  it('GitHub Actions workflow runs ts-check script', () => {
    const workflows = readWorkflows();
    expect(workflows).toMatch(/bun (run )?ts-check/);
  });

  it('GitHub Actions workflow runs lint script', () => {
    const workflows = readWorkflows();
    expect(workflows).toMatch(/bun (run )?lint/);
  });
});
