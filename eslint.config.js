// Flat config for ESLint 9. Intentionally light: correctness-focused rules,
// no stylistic bikeshedding (Prettier owns formatting).
export default [
  {
    files: ['src/**/*.js', 'test/**/*.js', 'native-host/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        queueMicrotask: 'readonly',
        AbortController: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      eqeqeq: ['error', 'smart'],
      'no-console': 'off',
    },
  },
  {
    // Extension code runs in the browser with the chrome.* API.
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        chrome: 'readonly',
        document: 'readonly',
        window: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        navigator: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
    },
  },
  {
    ignores: ['node_modules/**', '**/*.epub', 'coverage/**'],
  },
];
