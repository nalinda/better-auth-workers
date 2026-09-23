import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'bun:test';

import type { CreateAuthMagicLinkOptions, CreateAuthPhoneOptions } from '../src/index';

// These tests exercise what a consumer installs: the `package.json#exports`
// map and the dist files it points at, not the TypeScript sources. dist is
// rebuilt first so the assertions cannot pass against a stale artefact.
const rootDir = path.resolve(import.meta.dir, '..');

interface ExportTarget {
  types: string;
  import: string;
  default: string;
}

interface PackageJson {
  exports: Record<string, ExportTarget>;
  files: string[];
}

function readPackageJson(): PackageJson {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as PackageJson;
}

function exportTarget(subpath: string): ExportTarget {
  const target = new Map(Object.entries(readPackageJson().exports)).get(subpath);
  if (!target) throw new Error(`package.json#exports has no "${subpath}" entry`);
  return target;
}

function distFile(relative: string): string {
  return path.join(rootDir, relative);
}

async function loadExport(subpath: string): Promise<Record<string, unknown>> {
  return (await import(distFile(exportTarget(subpath).import))) as Record<string, unknown>;
}

beforeAll(() => {
  const result = spawnSync(Bun.argv[0] ?? 'bun', ['run', 'build'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`bun run build failed:\n${result.stdout}\n${result.stderr}`);
  }
});

describe('package.json#exports', () => {
  it('publishes dist, and every export target is a file the build produces', () => {
    const pkg = readPackageJson();
    expect(pkg.files).toContain('dist');
    expect(Object.keys(pkg.exports).toSorted((a, b) => a.localeCompare(b))).toEqual([
      '.',
      './admin',
      './client',
    ]);
    for (const target of Object.values(pkg.exports)) {
      for (const file of [target.types, target.import, target.default]) {
        expect(file.startsWith('./dist/')).toBe(true);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths from package.json
        expect(fs.existsSync(distFile(file))).toBe(true);
      }
      expect(target.default).toBe(target.import);
    }
  });
});

describe('Entry points export documented functions', () => {
  it('exports createAuth as a function from the built . entry point', async () => {
    const root = await loadExport('.');
    expect(typeof root.createAuth).toBe('function');
  });

  it('exports createSessionClient and requireSession from the built ./client entry point', async () => {
    const client = await loadExport('./client');
    expect(typeof client.createSessionClient).toBe('function');
    expect(typeof client.requireSession).toBe('function');
  });

  // The admin entry imports `cloudflare:workers`, which only resolves inside
  // workerd, so it is checked as built rather than imported here.
  it('builds the ./admin entry point with createAuthAdmin, leaving cloudflare:workers external', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from package.json
    const code = fs.readFileSync(distFile(exportTarget('./admin').import), 'utf8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from package.json
    const declarations = fs.readFileSync(distFile(exportTarget('./admin').types), 'utf8');
    expect(code).toMatch(/from ["']cloudflare:workers["']/);
    expect(code).toContain('createAuthAdmin');
    for (const name of ['createAuthAdmin', 'AuthAdminRpc', 'BanUserOptions', 'BanUserResult']) {
      expect(declarations).toContain(name);
    }
  });

  // One copy of the package's code across entry points: an auth Worker that
  // imports both `.` and `./admin` must share one createAuth, with one
  // instance cache, not bundle two.
  it('shares one chunk of package code between . and ./admin', () => {
    const chunksImportedBy = (subpath: string): string[] => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from package.json
      const code = fs.readFileSync(distFile(exportTarget(subpath).import), 'utf8');
      return code
        .matchAll(/from ["']\.\/([^"']+\.js)["']/g)
        .map(([, file]) => file)
        .toArray();
    };
    const shared = chunksImportedBy('./admin').filter((chunk) =>
      chunksImportedBy('.').includes(chunk)
    );
    expect(shared.length).toBeGreaterThan(0);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from package.json
    const admin = fs.readFileSync(distFile(exportTarget('./admin').import), 'utf8');
    expect(admin).not.toContain('instanceCache');
  });

  it('declares the CreateAuth*Options types in the . declaration file', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from package.json
    const declarations = fs.readFileSync(distFile(exportTarget('.').types), 'utf8');
    for (const name of [
      'CreateAuthOptions',
      'CreateAuthMagicLinkOptions',
      'CreateAuthPhoneOptions',
      'ConfigValue',
    ]) {
      expect(declarations).toContain(name);
    }
    // Type-level: compiles only if the types are exported from '.'.
    const magicLink: CreateAuthMagicLinkOptions = { sendMagicLink: () => {} };
    const phone: CreateAuthPhoneOptions = { sendOTP: () => {} };
    expect(typeof magicLink.sendMagicLink).toBe('function');
    expect(typeof phone.sendOTP).toBe('function');
  });
});
