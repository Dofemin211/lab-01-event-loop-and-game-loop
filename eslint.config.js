import js from '@eslint/js';

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        document: 'readonly',
        globalThis: 'readonly',
        HTMLCanvasElement: 'readonly',
        Math: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        ResizeObserver: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        clearInterval: 'readonly',
        URLSearchParams: 'readonly',
        window: 'readonly',
      },
    },
  },
];
