// playwright.config.mjs — REAL browser regression harness (A01–A04, A10, A12,
// A13, A17). Tests here exercise the shipped frontend modules, service worker
// lifecycle, CacheStorage, and IndexedDB in an actual Chromium context — the
// Vitest Node suite cannot validate those lifecycles.
//
// Contract notes:
//   • .spec.mjs files are deliberately OUTSIDE Vitest's tests/**/*.test.*
//     glob so the Node suite never imports browser-only modules.
//   • No webServer helper: every spec serves its own deterministic fixture
//     shell (and, where needed, its own backend) on an ephemeral port so
//     service-worker registration, real CacheStorage and real IndexedDB all
//     run against same-origin URLs that the test owns end to end.
export default {
    testDir: 'tests/browser',
    testMatch: '**/*.spec.mjs',
    fullyParallel: false,
    workers: 1,
    timeout: 60_000,
    expect: { timeout: 15_000 },
    use: {
        headless: true,
        // Sandboxed CI containers need this; the browser is single-tenant
        // per test so the relaxation does not cross test boundaries.
        launchOptions: { args: ['--no-sandbox'] },
        // Each test gets an isolated profile: downloads/IndexedDB/service
        // workers never leak between tests while still being REAL storage.
        contextOptions: {}
    },
    // Gitignored output — never committed.
    outputDir: '.runtime/playwright-artifacts',
    reporter: [['list']]
};
