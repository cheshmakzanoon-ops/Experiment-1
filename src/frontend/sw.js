// sw.js — offline / low-bandwidth cache for the Persian YouTube shell.
//
// Strategy (for a 1–2 Mbps household connection):
//   • App shell (html/css/js)          → network-first with cache fallback:
//     updates arrive on the next load (no stale-code reloads after deploy)
//     and the shell still works fully offline once visited.
//   • Thumbnails (/api/video/:id/thumb)→ stale-while-revalidate (they never
//     change for a video id — a huge saving on slow links).
//   • Feeds / search / metadata        → stale-while-revalidate: previously
//     seen content is served instantly (and offline), refreshed in the
//     background when a connection exists.
//   • Video streams (/api/stream/...)  → NEVER cached here: they are large,
//     byte-relayed with Range support (the Cache API breaks Range), and
//     real offline files go through the IndexedDB download manager instead
//     (see js/services/offlineService.js).
//
// Everything is best-effort: if registration fails (private browsing, older
// WebViews, insecure context) the app simply works without a service worker.

'use strict';

const VERSION = 'v1';
const CORE_CACHE = `yt-core-${VERSION}`;
const RUNTIME_CACHE = `yt-runtime-${VERSION}`;

// Static shell assets — always updated by bumping VERSION on deploy.
const CORE_ASSETS = [
    '/',
    '/index.html',
    '/styles/main.css',
    '/styles/youtube-theme.css',
    '/styles/components.css',
    '/styles/rtl.css',
    '/js/app.js',
    '/assets/default-avatar.svg',
    '/assets/default-channel.svg'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches
            .open(CORE_CACHE)
            .then((cache) => cache.addAll(CORE_ASSETS))
            .then(() => self.skipWaiting())
            .catch(() => {}) // precache failure must not block the SW install
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((key) => key !== CORE_CACHE && key !== RUNTIME_CACHE)
                        .map((key) => caches.delete(key))
                )
            )
            .then(() => self.clients.claim())
    );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fromCache(request, fallbackPath) {
    const hit = await caches.match(request);
    if (hit) return hit;
    if (fallbackPath) {
        const fallback = await caches.match(fallbackPath);
        if (fallback) return fallback;
    }
    return Response.error();
}

function cachePut(request, response) {
    // Fire-and-forget: failures (quota, closed cache) are non-fatal.
    if (!response || !response.ok) return Promise.resolve();
    return caches
        .open(RUNTIME_CACHE)
        .then((cache) => cache.put(request, response.clone()))
        .catch(() => {});
}

/** Network first, cached copy as the offline fallback (used for pages/assets). */
function networkFirst(request, fallbackPath) {
    return fetch(request)
        .then((response) => {
            cachePut(request, response);
            return response;
        })
        .catch(() => fromCache(request, fallbackPath));
}

/**
 * Serve the cached copy instantly (when present), refresh it in the
 * background; otherwise wait for the network. Ideal for thumbnails, feeds
 * and search responses on a slow link.
 */
async function staleWhileRevalidate(request) {
    const cached = await caches.match(request);
    if (cached) {
        // Refresh quietly — the UI never waits for this.
        fetch(request)
            .then((fresh) => cachePut(request, fresh))
            .catch(() => {});
        return cached;
    }
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cachePut(request, fresh);
    return fresh;
}

// ---------------------------------------------------------------------------
// Fetch routing
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    // Pages: always try the network, fall back to the cached shell offline.
    if (request.mode === 'navigate' || request.destination === 'document') {
        event.respondWith(networkFirst(request, '/index.html'));
        return;
    }

    const path = url.pathname;

    // Never touch streams (Range/206 + huge files) or health checks.
    if (path.startsWith('/api/stream') || path.startsWith('/api/health')) {
        return;
    }

    // API responses worth caching (all proxied through this same origin).
    if (path.startsWith('/api/')) {
        event.respondWith(staleWhileRevalidate(request));
        return;
    }

    // Static assets of the app shell — network-first so code changes are
    // visible on the very next load; the cached copy serves offline.
    if (path === '/index.html' || /^\/(styles|js|assets)\//.test(path)) {
        event.respondWith(networkFirst(request));
        return;
    }

    // Everything else (Google Fonts, etc.) is left to the default fetch.
});
