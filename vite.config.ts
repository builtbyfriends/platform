import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import cloudflare from '@cloudflare/oxlint-config';
import { defineConfig } from 'vite-plus';
import { SuiteSequencer } from './test/sequencer.ts';

const maxWorkers = process.env.CI ? 2 : Math.max(2, Math.floor(availableParallelism() * 0.75));
const apiTimezoneTests = [
  'platform/packages/api/test/integration/api-delete-accounting.test.ts',
  'platform/packages/api/test/integration/email-connections.test.ts',
];
// Decision: Platform unit files that start PGlite. New PGlite unit files go here.
const pgliteUnitTests = [
  'platform/packages/api/test/unit/admin-upgrade-compatibility.test.ts',
  'platform/packages/api/test/unit/email-migration.test.ts',
  'platform/packages/api/test/unit/email-shared-recipient-migration.test.ts',
  'platform/packages/api/test/unit/github-authority-constraints-migration.test.ts',
  'platform/packages/api/test/unit/github-authority-migration.test.ts',
];
const cliUnitTests = [
  'packages/bwf/test/unit/cf-*.test.ts',
  'packages/bwf/test/unit/provision-*.test.ts',
  'packages/bwf/test/unit/deploy-drift.test.ts',
];
// Decision: SDK unit files that start PGlite. New PGlite unit files go here.
const sdkPgliteUnitTests = [
  'packages/bwf/test/unit/auth-migrations.test.ts',
  'packages/bwf/test/unit/db-export-roundtrip.test.ts',
  'packages/bwf/test/unit/db-request-pool.test.ts',
  'packages/bwf/test/unit/db-reset-pg.test.ts',
  'packages/bwf/test/unit/platform-database-lock.test.ts',
  'packages/bwf/test/unit/platform-database-migrations.test.ts',
  'packages/bwf/test/unit/runner-pg.test.ts',
];

// Decision: Vitest forwards a filtered env to test workers: in CI only PLATFORM_E2E_CF_TOKEN survives. The
// live Cloudflare deploy e2e needs PLATFORM_E2E_CF_ACCOUNT_ID and PLATFORM_E2E_NAMESPACE too, so
// they're forwarded from this main process. Missing credentials become empty strings so normal runs
// skip the live suite.
const e2eWorkerEnv = {
  BWF_TEST_BROWSER: process.env.BWF_TEST_BROWSER ?? 'chromium',
  PLATFORM_E2E_CF_TOKEN: process.env.PLATFORM_E2E_CF_TOKEN ?? '',
  PLATFORM_E2E_CF_ACCOUNT_ID: process.env.PLATFORM_E2E_CF_ACCOUNT_ID ?? '',
  PLATFORM_E2E_NAMESPACE: process.env.PLATFORM_E2E_NAMESPACE ?? '',
};

const ciTimeoutScale = process.platform === 'win32' ? 3 : 1;
const testTimeout = 120_000 * ciTimeoutScale;
const hookTimeout = 120_000 * ciTimeoutScale;

const platformAlias = {
  '@builtbyfriends/bwf/_sandbox-container': fileURLToPath(
    new URL('packages/bwf/src/runtime/sandbox-container.ts', import.meta.url),
  ),
  'platform:sandbox-controller-source': fileURLToPath(
    new URL('platform/packages/api/test/__mocks__/sandbox-controller-source.ts', import.meta.url),
  ),
  'cloudflare:workers': fileURLToPath(
    new URL('platform/packages/api/test/__mocks__/cloudflare-workers.ts', import.meta.url),
  ),
  // Decision: cloudflare:email is a workerd built-in with no npm shim, so a module importing it can't load in
  // the plain-node unit runner.
  'cloudflare:email': fileURLToPath(
    new URL('platform/packages/api/test/__mocks__/cloudflare-email.ts', import.meta.url),
  ),
  'vite-plus/test': fileURLToPath(
    new URL('node_modules/vite-plus/dist/test/index.js', import.meta.url),
  ),
};

// Decision: These rules still have reports in older code, so they warn until the count reaches zero. Fix the
// warnings in the files you touch, and move a rule back to the preset's error once it's clean.
const unfinishedRules = {
  '@nkzw/require-use-effect-arguments': 'warn',
  eqeqeq: 'warn',
  'no-promise-executor-return': 'warn',
  'no-unused-vars': 'warn',
  'no-useless-assignment': 'warn',
  'prefer-promise-reject-errors': 'warn',
  'import/export': 'warn',
  'import/no-namespace': 'warn',
  'quality/no-array-filter-map': 'warn',
  'quality/no-conditional-empty-object-spread': 'warn',
  'quality/no-known-value-widening': 'warn',
  'quality/no-object-parameters': 'warn',
  'quality/no-reflect-apply': 'warn',
  'quality/no-reflect-get': 'warn',
  'quality/no-unknown-returns': 'warn',
  'quality/no-unsafe-dictionary-type': 'warn',
  'react/button-has-type': 'warn',
  'react/no-unescaped-entities': 'warn',
  'react/purity': 'warn',
  'react/refs': 'warn',
  'react/set-state-in-effect': 'warn',
  'react-hooks/rules-of-hooks': 'warn',
  'typescript/array-type': 'warn',
  'typescript/await-thenable': 'warn',
  'typescript/ban-ts-comment': 'warn',
  'typescript/consistent-type-imports': 'warn',
  'typescript/no-empty-object-type': 'warn',
  'typescript/no-floating-promises': 'warn',
  'typescript/no-import-type-side-effects': 'warn',
  'typescript/no-misused-promises': 'warn',
  'typescript/no-misused-spread': 'warn',
  'typescript/no-non-null-assertion': 'warn',
  'typescript/no-unnecessary-type-assertion': 'warn',
  'typescript/no-unsafe-argument': 'warn',
  'typescript/no-unsafe-assignment': 'warn',
  'typescript/no-unsafe-call': 'warn',
  'typescript/no-unsafe-member-access': 'warn',
  'typescript/no-unsafe-return': 'warn',
  'typescript/no-unsafe-type-assertion': 'warn',
  'typescript/no-unsafe-unary-minus': 'warn',
  'typescript/only-throw-error': 'warn',
  '@typescript-eslint/only-throw-error': 'warn',
  '@typescript-eslint/no-floating-promises': 'warn',
  'typescript/require-array-sort-compare': 'warn',
  'typescript/return-await': 'warn',
  'typescript/switch-exhaustiveness-check': 'warn',
  'typescript/unbound-method': 'warn',
  'typescript/use-unknown-in-catch-callback-variable': 'warn',
  'unicorn/consistent-function-scoping': 'warn',
  'unicorn/no-array-fill-with-reference-type': 'warn',
  'unicorn/prefer-number-properties': 'warn',
  'unicorn/prefer-single-call': 'warn',
  'unicorn/prefer-structured-clone': 'warn',
  'unicorn/prefer-top-level-await': 'warn',
} as const;

export default defineConfig({
  run: {
    tasks: {
      'build:all': {
        command:
          "vp run build && vp run --filter './platform/packages/**' build && vp run --filter './playground/**' --parallel build",
      },
      'lint:platform': {
        command: 'vp lint platform --type-aware --tsconfig platform/tsconfig.json',
      },
      'test:all': {
        command:
          'vp fmt --check && vp lint && vp run --cache build:all && node test/check-playground-build-artifacts.mjs && vp run lint:platform && vp run check && vp test run',
        // Decision: `vp run` passes only the env vars a task declares. Without this, the live Cloudflare e2e
        // credentials never reach `vp test run`. `untrackedEnv` forwards them without adding them to the
        // task's cache fingerprint.
        cache: {
          untrackedEnv: [
            'PLATFORM_E2E_CF_TOKEN',
            'PLATFORM_E2E_CF_ACCOUNT_ID',
            'PLATFORM_E2E_NAMESPACE',
          ],
        },
      },
    },
  },
  staged: {
    '*': 'vp fmt --no-error-on-unmatched-pattern',
    '*.{js,jsx,ts,tsx,mjs,cjs}': 'vp lint',
  },
  fmt: {
    singleQuote: true,
    experimentalSortImports: {
      newlinesBetween: false,
    },
    experimentalSortPackageJson: {
      sortScripts: true,
    },
    ignorePatterns: [
      '.svelte-kit/**',
      'eeaao/**',
      'packages/bwf/docs/**',
      'packages/bwf/skills/bwf/docs/**',
      'platform/packages/api/src/admin/fate/client.generated.ts',
      'playground/**/.output/**',
      'playground/**/build/**',
      'playground/**/wrangler.json',
      'playground/**/wrangler.jsonc',
    ],
  },
  lint: {
    ...cloudflare,
    categories: {
      correctness: 'off',
    },
    env: {
      browser: true,
      builtin: true,
      es2024: true,
      node: true,
    },
    jsPlugins: [
      ...(cloudflare.jsPlugins ?? []),
      {
        name: 'vite-plus',
        specifier: 'vite-plus/oxlint-plugin',
      },
      {
        name: 'react-hooks-js',
        specifier: 'eslint-plugin-react-hooks',
      },
      {
        name: 'bwf',
        specifier: './scripts/lint-plugin.mjs',
      },
      'eslint-plugin-react-you-might-not-need-an-effect',
    ],
    plugins: [...new Set([...(cloudflare.plugins ?? []), 'node', 'jsdoc'] as const)],
    ignorePatterns: [
      'eeaao/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/.bwf/**',
      '**/.vite-cloud/**',
      '**/.wrangler/**',
      '**/.tanstack/**',
      '**/.vitepress/cache/**',
      '**/*.tsbuildinfo',
      '.pnpm-store/**',
      'playground-local/**',
      '.worktrees/**',
      // Decision: Generated by @nkzw/fate, which can import helpers the client doesn't use.
      'platform/packages/api/src/admin/fate/client.generated.ts',
    ],
    overrides: [
      ...(cloudflare.overrides ?? []),
      { files: ['**/*'], rules: unfinishedRules },
      {
        files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
        rules: {
          'constructor-super': 'off',
          'getter-return': 'off',
          'no-class-assign': 'off',
          'no-const-assign': 'off',
          'no-dupe-class-members': 'off',
          'no-dupe-keys': 'off',
          'no-func-assign': 'off',
          'no-import-assign': 'off',
          'no-new-native-nonconstructor': 'off',
          'no-obj-calls': 'off',
          'no-redeclare': 'off',
          'no-setter-return': 'off',
          'no-this-before-super': 'off',
          'no-undef': 'off',
          'no-unreachable': 'off',
          'no-unsafe-negation': 'off',
          'no-with': 'off',
          'prefer-rest-params': 'error',
          'prefer-spread': 'error',
        },
      },
      {
        files: ['playground/pg-test/**/*', 'playground/spa/**/*', 'playground/websockets/**/*'],
        rules: {
          'react-hooks-js/component-hook-factories': 'error',
          'react-hooks-js/config': 'error',
          'react-hooks-js/error-boundaries': 'error',
          'react-hooks-js/gating': 'error',
          'react-hooks-js/globals': 'error',
          'react-hooks-js/immutability': 'error',
          'react-hooks-js/incompatible-library': 'error',
          'react-hooks-js/preserve-manual-memoization': 'error',
          'react-hooks-js/purity': 'error',
          'react-hooks-js/refs': 'error',
          'react-hooks-js/set-state-in-effect': 'error',
          'react-hooks-js/set-state-in-render': 'error',
          'react-hooks-js/static-components': 'error',
          'react-hooks-js/unsupported-syntax': 'error',
          'react-hooks-js/use-memo': 'error',
        },
      },
      {
        files: ['**/*.svelte'],
        rules: {
          'no-undef': 'off',
          'prefer-const': 'off',
        },
      },
      {
        files: ['**/*.vue'],
        rules: {
          'no-undef': 'off',
        },
      },
      {
        files: ['platform/**/*'],
        rules: {
          // Decision: The hosted platform uses Node's native path module. It keeps that lint contract while shared SDK
          // code uses pathslash.
          'no-restricted-imports': 'off',
        },
      },
      {
        files: ['**/test/**/*.{js,jsx,ts,tsx,mjs,cjs}'],
        rules: {
          // Decision: Tests derive expected paths independently of production's forward-slash wrapper, including on
          // Windows.
          'no-restricted-imports': [
            'error',
            {
              paths: [
                {
                  name: 'pathslash',
                  importNames: [
                    'dirname',
                    'extname',
                    'isAbsolute',
                    'join',
                    'normalize',
                    'relative',
                    'resolve',
                  ],
                  message:
                    'Use node:path for filesystem paths in tests; reserve pathslash for toSlash.',
                },
              ],
            },
          ],
        },
      },
      {
        // Decision: Tests call mocks and loose fixtures, cast test doubles and wait with bare promises.
        files: [
          '**/test/**',
          '**/tests/**',
          '**/e2e/**',
          '**/__mocks__/**',
          '**/fixtures/**',
          '**/*.test.*',
          '**/*.test-d.*',
        ],
        rules: {
          'no-promise-executor-return': 'off',
          'quality/no-chained-type-assertions': 'off',
          'quality/no-known-value-widening': 'off',
          'quality/no-unknown-returns': 'off',
          'quality/no-unknown-type-aliases': 'off',
          'quality/no-unsafe-dictionary-type': 'off',
          'quality/no-widen-then-assert': 'off',
          'typescript/no-explicit-any': 'off',
          'typescript/no-non-null-assertion': 'off',
          'typescript/no-unsafe-argument': 'off',
          'typescript/no-unsafe-assignment': 'off',
          'typescript/no-unsafe-call': 'off',
          'typescript/no-unsafe-member-access': 'off',
          'typescript/no-unsafe-return': 'off',
          'typescript/no-unsafe-type-assertion': 'off',
          'typescript/unbound-method': 'off',
          'unicorn/consistent-function-scoping': 'off',
        },
      },
    ],
    rules: {
      ...cloudflare.rules,
      'bwf/no-comments': 'error',
      // Decision: Workers send their logs through console, and the command line tool and scripts print on purpose.
      'no-console': 'off',
      // Decision: The error classes here are checked with instanceof, in our code and in the upstream code we merge.
      '@nkzw/no-instanceof': 'off',
      'react-you-might-not-need-an-effect/no-derived-state': 'error',
      'react-you-might-not-need-an-effect/no-chain-state-updates': 'error',
      'react-you-might-not-need-an-effect/no-event-handler': 'error',
      'react-you-might-not-need-an-effect/no-adjust-state-on-prop-change': 'error',
      'react-you-might-not-need-an-effect/no-reset-all-state-on-prop-change': 'error',
      'react-you-might-not-need-an-effect/no-pass-live-state-to-parent': 'error',
      'react-you-might-not-need-an-effect/no-pass-data-to-parent': 'error',
      'react-you-might-not-need-an-effect/no-external-store-subscription': 'error',
      'react-you-might-not-need-an-effect/no-initialize-state': 'error',
      '@typescript-eslint/array-type': [
        'error',
        {
          default: 'generic',
        },
      ],
      '@typescript-eslint/no-duplicate-enum-values': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-extra-non-null-assertion': 'error',
      '@typescript-eslint/no-misused-new': 'error',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'error',
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-unnecessary-type-constraint': 'error',
      '@typescript-eslint/no-unsafe-declaration-merging': 'error',
      '@typescript-eslint/no-wrapper-object-types': 'error',
      '@typescript-eslint/prefer-as-const': 'error',
      '@typescript-eslint/prefer-namespace-keyword': 'error',
      '@typescript-eslint/triple-slash-reference': 'error',
      curly: 'error',
      'for-direction': 'error',
      'getter-return': 'error',
      'import/default': 'error',
      'import/namespace': 'error',
      'no-array-constructor': 'error',
      'no-async-promise-executor': 'error',
      'no-case-declarations': 'error',
      'no-class-assign': 'error',
      'no-compare-neg-zero': 'error',
      'no-cond-assign': 'error',
      'no-const-assign': 'error',
      'no-constant-binary-expression': 'error',
      'no-constant-condition': 'error',
      'no-control-regex': 'error',
      'no-debugger': 'error',
      'no-delete-var': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty-character-class': 'error',
      'no-empty-pattern': 'error',
      'no-empty-static-block': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-ex-assign': 'error',
      'no-extra-boolean-cast': 'error',
      'no-fallthrough': 'error',
      'no-func-assign': 'error',
      'no-global-assign': 'error',
      'no-import-assign': 'error',
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'error',
      'no-loss-of-precision': 'error',
      'no-misleading-character-class': 'error',
      'no-new-native-nonconstructor': 'error',
      'no-nonoctal-decimal-escape': 'error',
      'no-obj-calls': 'error',
      'no-prototype-builtins': 'error',
      'no-redeclare': 'error',
      'no-regex-spaces': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:path',
              message:
                "Use `pathslash` instead. It re-exports the same API but always emits forward slashes, which avoids cross-platform breakage when paths are embedded in module specifiers, generated source, or compared against Vite's normalized watcher events. If you genuinely need format-specific behavior, import `node:path/win32` or `node:path/posix` explicitly.",
            },
            {
              name: 'path',
              message:
                'Use `pathslash` instead of the unprefixed `path` import (and prefer `node:path/win32` / `node:path/posix` for explicit format-specific behavior).',
            },
          ],
        },
      ],
      'no-self-assign': 'error',
      'no-setter-return': 'error',
      'no-shadow-restricted-names': 'error',
      'no-sparse-arrays': 'error',
      'no-this-before-super': 'error',
      'no-undef': 'error',
      'no-unexpected-multiline': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-unused-expressions': 'error',
      'no-unused-labels': 'error',
      'no-unused-private-class-members': 'error',
      // Decision: Also covers packages without TypeScript's noUnusedLocals and plain JS scripts. An options object
      // drops oxlint's default `^_` ignore pattern, so it's restated.
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
      'no-useless-backreference': 'error',
      'no-useless-catch': 'error',
      'no-useless-escape': 'error',
      'no-useless-rename': 'error',
      'no-var': 'error',
      'no-warning-comments': [
        'error',
        {
          terms: ['@nocommit'],
        },
      ],
      'no-with': 'error',
      'oxc/no-accumulating-spread': 'error',
      'prefer-const': 'error',
      'react/exhaustive-deps': 'error',
      'react/jsx-key': 'error',
      'react/jsx-no-duplicate-props': 'error',
      'react/jsx-no-target-blank': 'error',
      'react/jsx-no-undef': 'error',
      'react/no-children-prop': 'error',
      'react/no-danger-with-children': 'error',
      'react/no-direct-mutation-state': 'error',
      'react/no-find-dom-node': 'error',
      'react/no-is-mounted': 'error',
      'react/no-render-return-value': 'error',
      'react/no-string-refs': 'error',
      'react/require-render-return': 'error',
      'require-yield': 'error',
      'unicorn/consistent-empty-array-spread': 'error',
      'unicorn/no-abusive-eslint-disable': 'error',
      'unicorn/no-invalid-fetch-options': 'error',
      'unicorn/no-typeof-undefined': 'error',
      'unicorn/no-unnecessary-slice-end': 'error',
      'unicorn/no-useless-promise-resolve-reject': 'error',
      'unicorn/no-useless-spread': 'error',
      'unicorn/prefer-array-flat-map': 'error',
      'unicorn/prefer-array-index-of': 'error',
      'unicorn/prefer-array-some': 'error',
      'unicorn/prefer-native-coercion-functions': 'error',
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/prefer-optional-catch-binding': 'error',
      'unicorn/prefer-set-size': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'vite-plus/prefer-vite-plus-imports': 'error',
      // Decision: Vitest rejects `.only` only in CI; this catches it locally and in pre-commit too.
      'vitest/no-focused-tests': 'error',
      ...unfinishedRules,
    },
    options: {
      ...cloudflare.options,
      typeCheck: false,
    },
  },
  resolve: { alias: platformAlias },
  test: {
    fsModuleCache: true,
    // Decision: Reuses Node's compiled JS and TypeScript across subprocesses and forks. Vitest turns it off for
    // V8 coverage; standalone Node coverage is honored too.
    env: {
      NODE_COMPILE_CACHE:
        process.env.NODE_COMPILE_CACHE ??
        fileURLToPath(new URL('./node_modules/.cache/node-compile', import.meta.url)),
      ...(process.env.NODE_V8_COVERAGE ? { NODE_DISABLE_COMPILE_CACHE: '1' } : {}),
    },
    silent: 'passed-only',
    sequence: { sequencer: SuiteSequencer },
    // Decision: Node 24 bundles undici 7, whose fetch() calls socket.setTypeOfService() on each connection
    // without catching errors. On macOS that throws EINVAL when the server already reset the connection
    // (a test polling a port while Vite briefly binds it). The fetch still rejects for the caller; only
    // this stray uncaught copy is dropped. undici 8.8+ ignores the error itself.
    onUnhandledError(error) {
      const { code, syscall } = error as { code?: unknown; syscall?: unknown };
      return !(syscall === 'setTypeOfService' && code === 'EINVAL');
    },
    projects: [
      {
        extends: false,
        test: {
          name: 'cli-unit',
          fsModuleCache: true,
          css: { include: [/starter-ui\.css(?:\?|$)/] },
          include: cliUnitTests,
          pool: 'threads',
          maxWorkers,
          ...(process.platform === 'win32' ? { testTimeout: 20_000 } : {}),
        },
      },
      {
        extends: false,
        test: {
          name: 'unit',
          fsModuleCache: true,
          css: { include: [/starter-ui\.css(?:\?|$)/] },
          include: ['packages/*/test/unit/**/*.test.ts'],
          exclude: [...cliUnitTests, ...sdkPgliteUnitTests],
          sequence: { groupOrder: 2 },
          pool: 'threads',
          maxWorkers,
          // Decision: Windows unit tests that import the plugin or spawn a CLI can pass Vitest's 5-second default
          // under CI load. Other platforms keep the faster default.
          ...(process.platform === 'win32' ? { testTimeout: 20_000 } : {}),
        },
      },
      {
        extends: false,
        test: {
          name: 'unit-pglite',
          fsModuleCache: true,
          include: sdkPgliteUnitTests,
          sequence: { groupOrder: 2 },
          // Decision: Native Node 24 worker crashes can abort the run on Linux and macOS, so each database keeps
          // PGlite's Wasm heap in its own process.
          pool: ['linux', 'darwin'].includes(process.platform) ? 'forks' : 'threads',
          maxWorkers,
          ...(process.platform === 'win32' ? { testTimeout: 20_000 } : {}),
        },
      },
      {
        extends: false,
        resolve: { alias: platformAlias },
        test: {
          name: 'platform-unit',
          fsModuleCache: true,
          pool: 'threads',
          include: ['platform/packages/*/test/**/*.test.ts'],
          exclude: ['platform/packages/api/test/integration/**', ...pgliteUnitTests],
          maxWorkers,
        },
      },
      {
        extends: false,
        resolve: { alias: platformAlias },
        test: {
          name: 'platform-unit-pglite',
          fsModuleCache: true,
          // Decision: Native Node 24 worker crashes can abort the run on Linux and macOS, so each database keeps
          // PGlite's Wasm heap in its own process.
          pool: ['linux', 'darwin'].includes(process.platform) ? 'forks' : 'threads',
          include: pgliteUnitTests,
          maxWorkers,
        },
      },
      {
        extends: false,
        resolve: { alias: platformAlias },
        test: {
          name: 'platform-api-integration',
          fsModuleCache: true,
          include: apiTimezoneTests,
          globalSetup: ['platform/packages/api/test/integration/global-setup.ts'],
          setupFiles: ['platform/packages/api/test/integration/setup.ts'],
          ...(process.env.BWF_TEST_DATABASE_URL ? { fileParallelism: false } : {}),
          maxWorkers,
        },
      },
      {
        extends: false,
        resolve: { alias: platformAlias },
        test: {
          name: 'platform-api-integration-threads',
          fsModuleCache: true,
          // Decision: Native Node 24 worker crashes can abort the run on Linux and macOS, so each database keeps
          // PGlite's Wasm heap in its own process.
          pool: ['linux', 'darwin'].includes(process.platform) ? 'forks' : 'threads',
          include: ['platform/packages/api/test/integration/**/*.test.ts'],
          exclude: apiTimezoneTests,
          globalSetup: ['platform/packages/api/test/integration/global-setup.ts'],
          setupFiles: ['platform/packages/api/test/integration/setup.ts'],
          ...(process.env.BWF_TEST_DATABASE_URL ? { fileParallelism: false } : {}),
          maxWorkers,
        },
      },
      {
        extends: false,
        test: {
          // Decision: Each integration file here owns its fixture directory, so one pool can run the longest files
          // first and fill idle slots across packages.
          name: 'parallel-integration',
          fsModuleCache: true,
          pool: 'forks',
          // Decision: Bounds simultaneous database engines and framework compilers locally. Unit tests still fill
          // unused integration workers in the same phase.
          sequence: { groupOrder: 2 },
          // Decision: maxWorkers limits files, not describe.concurrent tests. On Windows CI, two files at the default
          // concurrency open up to ten browser contexts at once, so concurrency is lowered there to reduce
          // socket pressure.
          ...(process.platform === 'win32'
            ? { maxConcurrency: 2, setupFiles: ['test/windows-integration-setup.ts'] }
            : {}),
          testTimeout,
          hookTimeout,
          // Decision: Kept next to the e2e glob so a new e2e file also gets its credentials past the worker env filter
          // (see e2eWorkerEnv). The e2e file drives playground/spa, and the other SPA integration uses an
          // isolated copy, so both stay safe when credentials are present.
          env: e2eWorkerEnv,
          include: [
            'packages/bwf/test/integration/**/*.test.ts',
            // Decision: The gated live-account e2e is collected here so CI skips it cleanly (no token) instead of not
            // finding it. It runs only when its env vars are set.
            'packages/bwf/test/e2e/**/*.test.ts',
          ],
          maxWorkers,
        },
      },
    ],
  },
});
