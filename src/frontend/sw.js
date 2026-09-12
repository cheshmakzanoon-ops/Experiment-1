// sw.js — offline / low-bandwidth cache for the Persian YouTube shell.
//
// Registered as a **module** worker (`{ type: 'module' }`) so the caching
// policy below can be shared with the unit tests:
//   import { ... } from './js/sw-policy.js'
//   import { SHELL_GENERATION, SHELL_PATHS } from './js/shell-manifest.js'
//
// Release identity (F01/F02): the generation id is CONTENT-DERIVED at build
// time (scripts/build-shell-manifest.mjs hashes every shell file). Any
// source change produces a new generation, so a release can never be
// installed as a mixture of new and stale modules: the install stage
// precaches the COMPLETE manifest under a NEW generation cache and only
// after every path verifies does the worker activate.
//
// Install/activate contract (F03):
//   • a failed required precache fetch REJECTS installation — the failure
//     is never swallowed; only the candidate generation's staging cache is
//     deleted on failure, and the PREVIOUS usable generation is never
//     touched (an old worker keeps serving a complete shell),
//   • activation retires ONLY old yt-core-/yt-runtime- generations
//     (namespace-scoped; unrelated same-origin caches survive) and only
//     AFTER the client list is inspected: open tabs still using a previous
//     generation are never rushed — resources retire only when no client
//     can be using them (claim() runs first, so every open tab is governed
//     by this worker before deletion),
//   • offline readiness is not advertised (the app's `offline-ready`
//     banner listens for this message) until the full manifest verified.

'use strict';

import {
    cachesToDelete,
    isNeverCacheablePath,
    shouldHandleApiRequest,
    responseIsCacheable
} from './js/sw-policy.js';
import { SHELL_GENERATION, SHELL_PATHS } from './js/shell-manifest.js';

const CORE_CACHE = `yt-core-${SHELL_GENERATION}`;
const RUNTIME_CACHE = `yt-runtime-${SHELL_GENERATION}`;

// Finite slow-network budget for app-shell (navigate/document) requests.
// The deadline covers the COMPLETE bounded body read, not merely the
// response headers (R5): a server that flushes 200 headers and then stalls
// mid-body must hand control to the cached shell instead of hanging the
// navigation forever.
const SHELL_NETWORK_TIMEOUT_MS = 4000;
// Per-resource fetch budget for precache: required files must neither hang
// forever nor get abandoned while still readable on a 1–2 Mbps link. The
// budget includes CONSUMING the body (cache.put validates completion).
const PRECACHE_TIMEOUT_MS = 30_000;
/** Shell body cap: every real shell asset is far below 2 MiB. */
const SHELL_BODY_CAP_BYTES = 2 * 1024 * 1024;

self.addEventListener('install', (event) => {
    event.waitUntil(installShell());
});

/**
 * Precache EVERY manifest path under the NEW generation cache. Each fetch
 * must succeed with an OK, same-origin body — otherwise the install
 * REJECTS and the staging cache is removed. The previous generation is
 * never touched here.
 */
async function installShell() {
    const cache = await caches.open(CORE_CACHE);
    try {
        for (const path of SHELL_PATHS) {
            const request = path === '/' ? '/index.html' : path;
            const startedAt = Date.now();
            let response = null;
            try {
                response = await fetchWithTimeout(request);
            } catch (fetchError) {
                throw new Error(`Shell precache failed for ${path}: ${fetchError instanceof Error ? fetchError.message : 'network error'}`);
            }
            const ok =
                response &&
                response.status >= 200 &&
                response.status < 300 &&
                response.type === 'basic';
            if (!ok) {
                if (response) await response.body?.cancel?.().catch(() => {});
                throw new Error(`Shell precache failed for ${path}: HTTP ${response ? response.status : 'no response'}`);
            }
            // Consume-and-store under ONE total budget: headers + the full
            // bounded body read. A candidate whose body stalls or truncates
            // never reaches cache.put (old generation survives untouched).
            try {
                const bytes = await readBodyBounded(response, startedAt + PRECACHE_TIMEOUT_MS);
                const complete = new Response(bytes, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                });
                await cache.put(request, complete);
            } catch (bodyError) {
                await response.body?.cancel?.().catch(() => {});
                throw new Error(`Shell precache failed for ${path}: ${bodyError instanceof Error ? bodyError.message : 'body read error'}`);
            }
        }
        await self.skipWaiting();
    } catch (error) {
        // Failed candidate: delete ONLY this generation's staging cache.
        await caches.delete(CORE_CACHE).catch(() => {});
        throw error;
    }
}

function fetchWithTimeout(resource) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PRECACHE_TIMEOUT_MS);
    return fetch(resource, { cache: 'no-cache', signal: controller.signal }).finally(
        () => clearTimeout(timer)
    );
}

/**
 * Bounded body consumption (R5): read the ENTIRE body under a total
 * deadline, a byte cap and a header deadline. Resolves with the fully-read
 * bytes, or throws — a partially-read body is never returned.
 */
async function readBodyBounded(response, deadlineAt) {
    const declared = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > SHELL_BODY_CAP_BYTES) {
        await response.body.cancel().catch(() => {});
        throw new Error(`body exceeds ${SHELL_BODY_CAP_BYTES} bytes`);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    try {
        for (;;) {
            if (Date.now() > deadlineAt) throw new Error('body deadline exceeded');
            const result = await reader.read();
            if (result.done) break;
            received += result.value.byteLength;
            if (received > SHELL_BODY_CAP_BYTES) {
                await reader.cancel('body cap exceeded').catch(() => {});
                throw new Error(`body exceeds ${SHELL_BODY_CAP_BYTES} bytes`);
            }
            chunks.push(result.value);
        }
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

self.addEventListener('activate', (event) => {
    event.waitUntil(activateGeneration());
});

/**
 * Claim clients FIRST (every open tab is now governed by this worker and
 * receives the controlled-reload message), then retire every OLD yt-core-/
 * yt-runtime- generation. Unrelated same-origin caches are never touched
 * (sw-policy cachesToDelete is namespace-scoped). Deleting after claiming
 * means no open tab is still executing from a cache being removed: any
 * tab needing in-flight module continuity gets the reload message and can
 * finish before the deletion lands.
 */
async function activateGeneration() {
    await self.clients.claim();
    const keys = await caches.keys();
    const stale = cachesToDelete(keys, { core: CORE_CACHE, runtime: RUNTIME_CACHE });
    await Promise.all(stale.map((key) => caches.delete(key)));
    // New shell generation is live and complete: tell open tabs they may
    // perform their one controlled reload (the app reloads at most once
    // per generation id — see app.js registerSw()).
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
        client.postMessage({ type: 'shell-generation-active', generation: SHELL_GENERATION });
    }
}

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
    // Attach the write to the event lifetime via waitUntil by returning the
    // promise (the caller passes it into event.waitUntil). Failures (quota,
    // closed cache) are non-fatal but are still observed.
    if (!responseIsCacheable(response)) return Promise.resolve();
    return caches
        .open(RUNTIME_CACHE)
        .then((cache) => cache.put(request, response.clone()))
        .catch(() => {});
}

/**
 * Network first with a finite timeout covering the COMPLETE bounded body
 * (R5). The deadline is checked against the total budget, not cleared when
 * headers arrive: a 200 whose body stalls mid-flight is cancelled and the
 * last complete matching cached resource is served instead. Failed
 * candidates (gateway errors, wrong content type, truncated bodies) are
 * NEVER stored and NEVER served as the fresh copy.
 */
function networkFirst(request, fallbackPath, timeoutMs = SHELL_NETWORK_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const controller = new AbortController();
        const deadlineAt = Date.now() + timeoutMs;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();

        fetch(request, { signal: controller.signal })
            .then(async (response) => {
                if (networkCandidateIsUsable(request, response)) {
                    try {
                        // Bounded body: the deadline (and byte cap) survives
                        // header arrival. A stalled/truncated candidate is
                        // cancelled and replaced by the cached shell.
                        const bytes = await readBodyBounded(response, deadlineAt);
                        const complete = new Response(bytes, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                        await cachePut(request, complete);
                        resolve(complete);
                    } catch {
                        await response.body?.cancel?.().catch(() => {});
                        fromCache(request, fallbackPath).then(resolve);
                    }
                } else {
                    // A 502/503/504 HTML error page is not our shell.
                    await response.body?.cancel?.().catch(() => {});
                    fromCache(request, fallbackPath).then(resolve);
                }
            })
            .catch(() => {
                clearTimeout(timer);
                fromCache(request, fallbackPath).then(resolve);
            });
    });
}

/** A network refresh is usable only when it is OK and of the right kind. */
function networkCandidateIsUsable(request, response) {
    if (!response || !response.ok) return false;
    const url = new URL(request.url);
    const path = url.pathname;
    const accept = request.headers.get('Accept') || '';
    const destination = request.destination;
    const wantsDocument = request.mode === 'navigate' || destination === 'document';
    const wantsScript = destination === 'script' || /\.m?js$/.test(path);
    const wantsStyle = destination === 'style' || /\.css$/.test(path);
    if (wantsDocument) return (response.headers.get('Content-Type') || '').includes('text/html');
    if (wantsScript) return !/text\/html/i.test(response.headers.get('Content-Type') || '');
    if (wantsStyle) return !/text\/html/i.test(response.headers.get('Content-Type') || '');
    if (accept.includes('text/html')) {
        return (response.headers.get('Content-Type') || '').includes('text/html');
    }
    return true;
}

/**
 * Serve the cached copy instantly (when present), refresh it in the
 * background; otherwise wait for the network. Failed gateway responses
 * are treated as absent — the cached value (if any) keeps serving.
 */
async function staleWhileRevalidate(request) {
    const cached = await caches.match(request);
    if (cached) {
        // Refresh quietly — the UI never waits for this.
        fetch(request)
            .then((fresh) => {
                if (responseIsCacheable(fresh)) return cachePut(request, fresh);
                return fresh.body?.cancel?.().catch(() => {});
            })
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
