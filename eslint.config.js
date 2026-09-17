import { node } from '@serendibyte-co/eslint-config/node';

// The shared config downgrades many rules to 'warn' because the monorepo it
// was extracted from had pre-existing violations, not because the rules
// don't matter (see its own base.js comment). This project starts clean, so
// every warning is promoted to an error — nothing here should be quietly
// ignorable.
function errorsOnly(configs) {
  return configs.map((config) => {
    if (!config.rules) return config;
    const rules = Object.fromEntries(
      Object.entries(config.rules).map(([name, value]) => {
        if (value === 'warn') return [name, 'error'];
        if (Array.isArray(value) && value[0] === 'warn')
          return [name, ['error', ...value.slice(1)]];
        return [name, value];
      })
    );
    return { ...config, rules };
  });
}

export default [
  {
    ignores: ['node_modules', 'dist', '.wrangler', '.worktrees'],
  },
  ...errorsOnly(
    node({
      tsconfigRootDir: import.meta.dirname,
      files: ['src/**/*.ts', 'examples/**/*.ts', 'test/**/*.ts'],
      runtime: 'worker',
    })
  ),
  {
    files: ['src/**/*.ts', 'examples/**/*.ts', 'test/**/*.ts'],
    rules: {
      // unknown is the correct type for genuinely open-shaped data (env
      // bindings, KV values, JSON payloads) — banning it just pushes
      // toward fabricated interfaces or the separately-banned `any`.
      '@typescript-eslint/no-restricted-types': 'off',
    },
  },
  {
    // Test files legitimately run long — a suite covering many scenarios for
    // one function reads better kept together than split just to satisfy a
    // line-count ceiling.
    files: ['test/**/*.ts'],
    rules: {
      'sonarjs/max-lines': 'off',
      'sonarjs/max-lines-per-function': 'off',
    },
  },
  {
    // Example apps configure router instances at module top level.
    files: ['examples/**/*.ts'],
    rules: {
      'unicorn/no-top-level-side-effects': 'off',
    },
  },
];
