import { describe, expect, it } from 'bun:test';

import type { CreateAuthMagicLinkOptions, CreateAuthPhoneOptions } from '../src/index';

async function loadEntryPoint(subpath = '.'): Promise<Record<string, unknown>> {
  const candidates =
    subpath === '.'
      ? [
          'better-auth-workers',
          '../src/index',
          '../src/index.ts',
          '../dist/index',
          '../dist/index.js',
        ]
      : [
          `better-auth-workers/${subpath.replace(/^\.\//, '')}`,
          `../src/${subpath.replace(/^\.\//, '')}`,
          `../src/${subpath.replace(/^\.\//, '')}.ts`,
          `../dist/${subpath.replace(/^\.\//, '')}`,
          `../dist/${subpath.replace(/^\.\//, '')}.js`,
        ];

  for (const candidate of candidates) {
    try {
      return (await import(candidate)) as Record<string, unknown>;
    } catch {
      // ignore resolution/loading errors
    }
  }
  return {};
}

describe('Entry points export documented functions', () => {
  it('exports createAuth as a function from . entry point', async () => {
    const root = await loadEntryPoint('.');
    expect(typeof root.createAuth).toBe('function');
  });

  it('exports createSessionClient as a function from ./client entry point', async () => {
    const client = await loadEntryPoint('./client');
    expect(typeof client.createSessionClient).toBe('function');
  });

  it('exports requireSession as a function from ./client entry point', async () => {
    const client = await loadEntryPoint('./client');
    expect(typeof client.requireSession).toBe('function');
  });

  it('exports the CreateAuth*Options types, including CreateAuthMagicLinkOptions', () => {
    // Type-level: this compiles only if the type is exported from '.'.
    const magicLink: CreateAuthMagicLinkOptions = { sendMagicLink: () => {} };
    const phone: CreateAuthPhoneOptions = { sendOTP: () => {} };
    expect(typeof magicLink.sendMagicLink).toBe('function');
    expect(typeof phone.sendOTP).toBe('function');
  });
});
