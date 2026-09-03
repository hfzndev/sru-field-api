import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

/**
 * Flat config (ESLint 9). CI runs `npm run lint` before the build (doc 09 §2),
 * so this needs to stay quick and free of false positives — a lint step that
 * cries wolf gets skipped, and then it catches nothing.
 */
const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'data/**', 'public/**', 'lib/schema.generated.js'],
  },

  ...nextCoreWebVitals,

  {
    rules: {
      // Photos are served from an authenticated API route, never as static
      // files (doc 08 §7), so next/image cannot handle them — it would need
      // a loader that bypasses the auth check.
      '@next/next/no-img-element': 'off',

      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'log'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    // Tests reach into internals and shadow freely; the app rules are noise here.
    files: ['test/**/*.js', 'scripts/**/*.js'],
    rules: { 'no-console': 'off' },
  },
];

export default config;
