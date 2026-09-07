// sw.js — offline / low-bandwidth cache for the Persian YouTube shell.
//
// Registered as a **module** worker (`{ type: 'module' }`) so the caching
// policy below can be shared with the unit tests:
//   import { ... } from './js/sw-policy.js'
//
// Strategy (for a 1–2 Mbps household connection):
//   • App shell (html/css/js/fonts) → network-first with a finite
//     slow-network timeout (~4 s), then the cached shell. An apparently
//     connected but unusable network therefore falls back instead of
//     spinning forever; the next refresh recovers.
//   • Thumbnails / feeds / search / metadata → stale-while-revalidate,
//     but ONLY for the explicit API allowlist in js/sw-policy.js.
//     /api/session, /api/diag/*, /api/health*, /api/stream* and stats
//     responses are never cached, and no 401/403/429/5xx/no-store body
//     is ever stored.
//   • Video streams (/api/stream/...) → NEVER touched here: they are
//     large, byte-relayed with Range support (the Cache API breaks
//     Range), and real offline files go through the IndexedDB download
//     manager instead (see js/services/offlineService.js). The browser's
//     default same-origin fetch already sends the session cookie.
//
// Everything is best-effort: if registration fails (private browsing,
// older WebViews, insecure context) the app simply works without a
// service worker.

'use strict';

import {
    CORE_PATHS,
    cachesToDelete,
    isNeverCacheablePath,
    shouldHandleApiRequest,
    responseIsCacheable
} from './js/sw-policy.js';

// Bump VERSION when a release changes the JS/CSS the shell precaches — the
// next install precaches the new shell under the new generation and the
// activate handler removes ONLY this application's older yt-core-/yt-
// runtime- generations (never unrelated same-origin caches, never IndexedDB).
const VERSION = 'v3';
const CORE_CACHE = `yt-core-${VERSION}`;
const RUNTIME_CACHE = `yt-runtime-${VERSION}`;

// Finite slow-network budget for app-shell (navigate/document) requests.
const SHELL_NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches
            .open(CORE_CACHE)
            .then((cache) => cache.addAll(CORE_PATHS))
            .then(() => self.skipWaiting())
            .catch(() => {}) // precache failure must not block the SW install
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => cachesToDelete(keys, { core: CORE_CACHE, runtime: RUNTIME_CACHE }))
            .then((stale) => Promise.all(stale.map((key) => caches.delete(key))))
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
    if (!responseIsCacheable(response)) return Promise.resolve();
    return caches
        .open(RUNTIME_CACHE)
        .then((cache) => cache.put(request, response.clone()))
        .catch(() => {});
}

/**
 * Network first with a finite timeout; the cached copy is the fallback.
 * Used for the app shell so a hung-but-connected network never leaves the
 * user waiting indefinitely before cache fallback occurs.
 */
function networkFirst(request, fallbackPath, timeoutMs = SHELL_NETWORK_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        fetch(request, { signal: controller.signal })
            .then((response) => {
                clearTimeout(timer);
                cachePut(request, response);
                resolve(response);
            })
            .catch(() => {
                clearTimeout(timer);
                fromCache(request, fallbackPath).then(resolve);
            });
    });
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
    if (responseIsCacheable(fresh)) cachePut(request, fresh);
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

    const path = url.pathname;

    // Pages: try the network (bounded), fall back to the cached shell.
    if (request.mode === 'navigate' || request.destination === 'document') {
        event.respondWith(networkFirst(request, '/index.html'));
        return;
    }

    // Video streams and anything else the policy forbids: let the network
    // handle it untouched (same-origin cookies still apply).
    if (path.startsWith('/api/stream')) return;

    // API responses: only the explicit allowlist is cached (session,
    // diagnostics, health, and stats are excluded by the policy).
    if (path.startsWith('/api/')) {
        if (isNeverCacheablePath(path) || !shouldHandleApiRequest(url)) return;
        event.respondWith(staleWhileRevalidate(request));
        return;
    }

    // Static assets of the app shell — network-first so code changes are
    // visible on the very next load; the cached copy serves offline.
    if (path === '/index.html' || /^\/(styles|js|assets|fonts)\//.test(path)) {
        event.respondWith(networkFirst(request));
        return;
    }

    // Everything else is left to the default fetch (no external origins
    // are needed by this app: fonts/icons are self-hosted).
});
