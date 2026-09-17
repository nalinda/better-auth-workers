import { node } from '@serendibyte-co/eslint-config/node';

export default [
  {
    ignores: ['node_modules', 'dist', '.wrangler'],
  },
  ...node({
    tsconfigRootDir: import.meta.dirname,
    files: ['src/**/*.ts', 'examples/**/*.ts'],
    runtime: 'worker',
  }),
];
