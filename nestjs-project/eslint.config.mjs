// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import jestPlugin from 'eslint-plugin-jest';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Test files: use eslint-plugin-jest's mock-aware unbound-method in place of
    // the type-aware rule, which false-positives on `expect(mock.method)`.
    files: ['**/*.spec.ts', '**/*.integration-spec.ts', 'test/**/*.ts'],
    extends: [jestPlugin.configs['flat/recommended']],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      'jest/unbound-method': 'error',
      // supertest's `request(...).expect(...)` is an assertion; teach the rule
      // about it so HTTP-status-only e2e tests are not flagged as assertionless.
      'jest/expect-expect': [
        'error',
        { assertFunctionNames: ['expect', 'request.**.expect'] },
      ],
    },
  },
  {
    rules: {
      // NestJS DI classes (@Module / @Injectable / @Controller) are intentionally
      // memberless — the decorator carries all the metadata. Keep the rule active
      // for genuinely extraneous (non-decorated) utility classes.
      '@typescript-eslint/no-extraneous-class': [
        'error',
        { allowWithDecorator: true },
      ],
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
);
