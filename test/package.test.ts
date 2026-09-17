import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

function readPackageJson(): any {
  const pkgPath = path.resolve(import.meta.dir, '../package.json');
  if (!fs.existsSync(pkgPath)) return undefined;
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}

function readTsConfig(): any {
  const tsconfigPath = path.resolve(import.meta.dir, '../tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return undefined;
  const content = fs
    .readFileSync(tsconfigPath, 'utf8')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return JSON.parse(content);
}

function readWorkflows(): string {
  const workflowsDir = path.resolve(import.meta.dir, '../.github/workflows');
  if (!fs.existsSync(workflowsDir)) return '';
  const files = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  return files.map((f) => fs.readFileSync(path.join(workflowsDir, f), 'utf8')).join('\n');
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

  it('package.json defines test script', () => {
    const pkg = readPackageJson();
    expect(pkg?.scripts?.['test']).toBeDefined();
  });

  it('package.json defines ts-check script', () => {
    const pkg = readPackageJson();
    expect(pkg?.scripts?.['ts-check']).toBeDefined();
  });

  it('package.json defines lint script', () => {
    const pkg = readPackageJson();
    expect(pkg?.scripts?.['lint']).toBeDefined();
  });

  it('package.json defines build script', () => {
    const pkg = readPackageJson();
    expect(pkg?.scripts?.['build']).toBeDefined();
  });

  it('tsconfig.json enables strict mode', () => {
    const tsconfig = readTsConfig();
    expect(tsconfig?.compilerOptions?.strict).toBe(true);
  });

  it('tsconfig.json includes workers-types', () => {
    const tsconfig = readTsConfig();
    const types: string[] = tsconfig?.compilerOptions?.types ?? [];
    expect(types).toContain('@cloudflare/workers-types');
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
