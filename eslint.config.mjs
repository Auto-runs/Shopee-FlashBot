import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'dist/**', 'legacy-python/**'] },
  js.configs.recommended,
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.serviceworker, ...globals.webextensions, FB: 'writable', module: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.{js,mjs}', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] },
  },
  {
    // Fungsi yang dievaluasi di dalam browser / service worker lewat Playwright.
    files: ['test/e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.serviceworker, ...globals.webextensions } },
  },
  {
    files: ['test/**/*.cjs', 'test/unit/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
];
