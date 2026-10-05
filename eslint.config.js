import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint configuration.
 *
 * The architectural rule from docs/DESIGN.md §12 is enforced mechanically here: the
 * domain and optimizer layers must not depend on React, the DOM or storage, which is
 * what keeps them pure and directly testable.
 */
export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'coverage', 'node_modules', 'playwright-report', 'test-results'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
    },
  },
  {
    // Purity boundary for the domain and optimizer layers.
    files: ['src/domain/**/*.ts', 'src/optimizer/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/optimizer/order.worker.ts', 'src/optimizer/runner.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'domain/optimizer must stay React-free (DESIGN.md §12).' },
            { name: 'react-dom', message: 'domain/optimizer must stay React-free (DESIGN.md §12).' },
          ],
          patterns: [
            {
              group: ['**/storage/**', '**/components/**', '**/pages/**', '**/state/**'],
              message: 'domain/optimizer must not depend on storage or UI layers (DESIGN.md §12).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'domain/optimizer must stay DOM-free (DESIGN.md §12).' },
        { name: 'window', message: 'domain/optimizer must stay DOM-free (DESIGN.md §12).' },
        { name: 'localStorage', message: 'domain/optimizer must not touch storage (DESIGN.md §12).' },
        { name: 'indexedDB', message: 'domain/optimizer must not touch storage (DESIGN.md §12).' },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'src/test/**/*.ts', 'e2e/**/*.ts', 'scripts/**/*.{ts,mjs}'],
    rules: { 'no-console': 'off' },
  },
);
