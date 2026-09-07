// sw-policy.js — pure service-worker caching policy (imported by sw.js and
// by the unit tests). Kept free of worker globals so it is directly testable.
//
// Rule: only an explicit allowlist of /api resources is ever cached, and
// only successful (2xx) responses without `Cache-Control: no-store`.
// Never cached:
//   /api/session, /api/diag/*, /api/health*, /api/stream* (media/Range),
//   /api/*/stats — and never 401/403/429/5xx bodies, never no-store bodies.

const THUMBNAIL_RE = /^\/api\/video\/[A-Za-z0-9_-]{11}\/thumbnail$/;
const METADATA_RE = /^\/api\/video\/[A-Za-z0-9_-]{11}$/;
const FEED_HOME_RE = /^\/api\/feed\/home$/;
const FEED_CATEGORY_RE = /^\/api\/feed\/category\/[^/]+$/;
const FEED_CATEGORIES_RE = /^\/api\/feed\/categories$/;
const SEARCH_RE = /^\/api\/search$/;

/** Search URLs legitimately carry ?q= and ?page= — everything else on the
 *  cacheable list is stored under its full URL, so query strings simply
 *  become part of the cache key (never a separate security boundary). */
export function isCacheableApiUrl(url) {
  const path = url.pathname
  if (isNeverCacheablePath(path)) return false
  return isCacheableApiPath(path)
}

/** Static shell/assets paths that may be precached. */
export const CORE_PATHS = [
    '/',
    '/index.html',
    '/styles/fonts.css',
    '/styles/main.css',
    '/styles/youtube-theme.css',
    '/styles/components.css',
    '/styles/rtl.css',
    '/js/app.js',
    '/assets/default-avatar.svg',
    '/assets/default-channel.svg',
    '/assets/fonts/Vazirmatn-Regular.woff2',
    '/assets/fonts/Vazirmatn-Medium.woff2',
    '/assets/fonts/Vazirmatn-Bold.woff2',
    '/assets/fonts/MaterialIconsRound-Regular.woff2'
];

/** Whether a same-origin GET to this path may ever be cached. */
export function isCacheableApiPath(pathname) {
    if (THUMBNAIL_RE.test(pathname)) return true;
    if (METADATA_RE.test(pathname)) return true;
    if (FEED_HOME_RE.test(pathname)) return true;
    if (FEED_CATEGORY_RE.test(pathname)) return true;
    if (FEED_CATEGORIES_RE.test(pathname)) return true;
    if (SEARCH_RE.test(pathname)) return true;
    return false;
}

/** Denylist sanity (never cache these even if allowlist regresses). */
export function isNeverCacheablePath(pathname) {
    return (
        pathname.startsWith('/api/session') ||
        pathname.startsWith('/api/diag') ||
        pathname.startsWith('/api/health') ||
        pathname.startsWith('/api/stream') ||
        pathname.endsWith('/stats')
    );
}

/** Decide for a full request URL whether the SW may serve/store it. */
export function shouldHandleApiRequest(url) {
    return isCacheableApiUrl(url);
}

/**
 * Namespace-scoped cache retirement: keys to delete from `allKeys` for a
 * new generation — every OTHER generation in the yt-core- and
 * yt-runtime- namespaces (asterisk suffix), and nothing else (unrelated
 * same-origin caches are never touched).
 */
export function cachesToDelete(allKeys, { core, runtime }) {
  return allKeys.filter((key) => {
    if (!/^yt-(?:core|runtime)-/.test(key)) return false
    return key !== core && key !== runtime
  })
}

/** A response may be stored only when it is a successful, private-safe GET. */
export function responseIsCacheable(response) {
    if (!response || !response.ok) return false;
    // Byte-range media responses are NEVER stored by the worker: the Cache
    // API cannot preserve Range semantics and offline files belong to the
    // IndexedDB downloader.
    if (response.status === 206 || response.status === 416) return false;
    if (response.status === 401 || response.status === 403 || response.status === 429) return false;
    if (response.status >= 500) return false;
    const cacheControl = response.headers.get('Cache-Control') || '';
    if (/no-store/i.test(cacheControl)) return false;
    if (response.headers.get('Set-Cookie')) return false;
    return true;
}
