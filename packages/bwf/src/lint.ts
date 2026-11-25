import cloudflare from '@cloudflare/oxlint-config';

type LintConfig = typeof cloudflare;

const plugin = (name: string, packageName: string): { name: string; specifier: string } => ({
  name,
  specifier: import.meta.resolve(packageName),
});

const effect = 'react-you-might-not-need-an-effect';

/**
 * The lint checks every bwf app shares: Cloudflare's Oxlint preset, Dillon Mulroy's anti-slop rules it doesn't carry
 * yet, the "You might not need an effect" rules, the React Compiler rules, React Doctor's component rules, and limits
 * on complexity, nesting and function size. Extend it in `oxlint.config.ts`, and turn a rule to `warn` while older
 * code still has reports.
 */
const lint: LintConfig = {
  ...cloudflare,
  jsPlugins: [
    ...(cloudflare.jsPlugins ?? []),
    plugin(effect, 'eslint-plugin-react-you-might-not-need-an-effect'),
    plugin('anti-slop', '@aranlucas/oxlint-plugin-anti-slop'),
    plugin('react-doctor', 'oxlint-plugin-react-doctor'),
  ],
  rules: {
    ...cloudflare.rules,
    [`${effect}/no-derived-state`]: 'error',
    [`${effect}/no-chain-state-updates`]: 'error',
    [`${effect}/no-event-handler`]: 'error',
    [`${effect}/no-adjust-state-on-prop-change`]: 'error',
    [`${effect}/no-reset-all-state-on-prop-change`]: 'error',
    [`${effect}/no-pass-live-state-to-parent`]: 'error',
    [`${effect}/no-pass-data-to-parent`]: 'error',
    [`${effect}/no-external-store-subscription`]: 'error',
    [`${effect}/no-initialize-state`]: 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-runtime-typeof': 'error',
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/no-unknown-parameters': 'error',
    'anti-slop/require-readable-spacing': 'error',
    'anti-slop/require-safety-comment-for-type-assertion': ['error', { markers: ['Decision'] }],
    'react/capitalized-calls': 'error',
    'react/exhaustive-effect-dependencies': 'error',
    'react/hooks': 'error',
    'react/no-deriving-state-in-effects': 'error',
    'react/rule-suppression': 'error',
    'react/syntax': 'error',
    'react/void-use-memo': 'error',
    'react-doctor/no-nested-component-definition': 'error',
    'react-doctor/no-high-complexity-react-function': 'warn',
    'react-doctor/no-giant-component': 'warn',
    complexity: ['warn', { max: 15 }],
    'max-depth': ['warn', 4],
    'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }],
  },
  overrides: [
    ...(cloudflare.overrides ?? []),
    {
      // Decision: A describe block holds a whole file's tests, so the function size limit doesn't fit there.
      files: ['**/test/**', '**/tests/**', '**/*.test.*', '**/*.spec.*'],
      rules: { 'max-lines-per-function': 'off' },
    },
  ],
};

export default lint;
