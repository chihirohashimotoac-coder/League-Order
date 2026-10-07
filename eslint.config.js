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
    /**
     * The share layer presents a finished order. It must never reach into the optimizer,
     * so adding a share feature cannot change constraint, scoring or search behaviour
     * (追加要件 §15).
     */
    files: ['src/share/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/optimizer/**'],
              message: 'share must not depend on the optimizer (DESIGN.md 追補 §S9).',
            },
            {
              group: ['**/state/**', '**/pages/**', '**/components/**', '**/storage/**'],
              message: 'share must not depend on UI or storage layers (DESIGN.md 追補 §S9).',
            },
          ],
        },
      ],
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
              group: ['**/storage/**', '**/components/**', '**/pages/**', '**/state/**', '**/share/**'],
              message: 'domain/optimizer must not depend on storage, UI or share layers (DESIGN.md §12).',
            },
            {
              group: ['**/integrations/**'],
              message:
                'domain/optimizer must not depend on the n01 integration: no HTTP below the state layer (N01_MASTER_DESIGN.md §4).',
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
    /**
     * The n01 integration is the network boundary. It may use the domain, but never React,
     * storage, the UI, the share layer or the optimizer (N01_MASTER_DESIGN.md §4).
     */
    files: ['src/integrations/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'integrations must stay React-free (N01_MASTER_DESIGN.md §4).' },
            { name: 'react-dom', message: 'integrations must stay React-free (N01_MASTER_DESIGN.md §4).' },
          ],
          patterns: [
            {
              group: ['**/storage/**', '**/components/**', '**/pages/**', '**/state/**', '**/share/**', '**/optimizer/**', '**/test/**'],
              message: 'integrations must not depend on storage, UI, share, optimizer or test code (N01_MASTER_DESIGN.md §4).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'integrations must stay DOM-free.' },
        { name: 'window', message: 'integrations must stay DOM-free.' },
        { name: 'localStorage', message: 'integrations must not touch storage.' },
        { name: 'indexedDB', message: 'integrations must not touch storage.' },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'src/test/**/*.ts', 'e2e/**/*.ts', 'scripts/**/*.{ts,mjs}'],
    rules: { 'no-console': 'off' },
  },
);
