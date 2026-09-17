import { describe, expect, it } from 'bun:test';

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
      return await import(candidate);
    } catch {
      // ignore resolution/loading errors
    }
  }
  return {};
}

describe('Issue #1: Entry points export documented functions', () => {
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
});
