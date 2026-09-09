/**
 * ESLint 9 flat config for the vanilla-JS frontend.
 *
 * The critical rule is `no-undef`: the historic `openVideoPlayer is not
 * defined` bug was exactly this class of error and would have been caught
 * at lint time. Browser/service-worker globals are declared explicitly.
 */
import js from '@eslint/js'

const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  indexedDB: 'readonly',
  IDBKeyRange: 'readonly',
  fetch: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  FormData: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  EventTarget: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queueMicrotask: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  IntersectionObserver: 'readonly',
  MutationObserver: 'readonly',
  matchMedia: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  structuredClone: 'readonly',
  visualViewport: 'readonly',
  devicePixelRatio: 'readonly',
  // Service worker (sw.js / module worker):
  self: 'readonly',
  caches: 'readonly',
  clients: 'readonly',
  skipWaiting: 'readonly',
  // Worker constructor (module-worker capability probe in app.js):
  Worker: 'readonly'
}

export default [
  { ignores: ['dist/**', 'node_modules/**', '.runtime/**', 'android/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['src/frontend/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...BROWSER_GLOBALS }
    },
    rules: {
      // The audit's #1 frontend finding — undefined identifiers.
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'error',
      'no-irregular-whitespace': 'error'
    }
  }
]
