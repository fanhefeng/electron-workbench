import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ['out/**', 'release/**', 'test-results/**'],
    plugins: ['typescript', 'react'],
    categories: { correctness: 'error' },
    rules: {
      'typescript/no-explicit-any': 'error',
      'react/rules-of-hooks': 'error',
      'react/exhaustive-deps': 'error',
      'react/set-state-in-effect': 'off',
    },
    overrides: [
      {
        files: ['scripts/*.mjs', '*.mjs'],
        env: { node: true },
        globals: { window: 'readonly', document: 'readonly', innerWidth: 'readonly' },
        rules: { 'no-undef': 'error' },
      },
    ],
  },
  fmt: {
    ignorePatterns: ['out/**', 'release/**', 'test-results/**', 'package-lock.json'],
    singleQuote: true,
    printWidth: 100,
    trailingComma: 'all',
    sortPackageJson: false,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
