// searchService.js — search execution + recent-searches storage.
// Recent searches live in localStorage (no account needed), and the
// suggestion list combines them with common Persian queries.

const API_BASE = '/api';
const RECENT_SEARCHES_KEY = 'recentSearches';
const MAX_RECENT_SEARCHES = 10;

/** Persian queries offered as suggestions while typing. */
export const COMMON_SUGGESTIONS = [
    'آهنگ جدید',
    'آموزش آشپزی',
    'فیلم کامل',
    'مستند',
    'کلیپ طنز',
    'سریال',
    'موزیک ویدیو',
    'بازی',
    'خبر',
    'ورزش',
    'آموزش زبان',
    'سلامتی',
    'تکنولوژی',
    'هنر',
    'سفر',
    'علمی',
    'کارتون',
    'انیمیشن',
    'مدرسه',
    'دانشگاه'
];

/**
 * Perform a search against /api/search.
 * @param {string} query
 * @returns {Promise<{query: string, results: object[], total: number}>}
 */
export async function performSearch(query) {
    const response = await fetch(
        `${API_BASE}/search?q=${encodeURIComponent(query)}&max=12`
    );
    if (!response.ok) {
        throw new Error(`Search failed: ${response.status}`);
    }
    return response.json();
}

/** @returns {string[]} recent searches, newest first. */
export function getRecentSearches() {
    try {
        const raw = JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || '[]');
        return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : [];
    } catch {
        return [];
    }
}

/** Add a query to the top of recent searches (deduplicated, capped). */
export function addRecentSearch(query) {
    if (!query || query.trim().length < 2) return;
    const trimmed = query.trim();
    const recent = getRecentSearches().filter((s) => s !== trimmed);
    recent.unshift(trimmed);
    try {
        localStorage.setItem(
            RECENT_SEARCHES_KEY,
            JSON.stringify(recent.slice(0, MAX_RECENT_SEARCHES))
        );
    } catch {
        // storage full/unavailable — recent searches are non-critical
    }
}

export function clearRecentSearches() {
    try {
        localStorage.removeItem(RECENT_SEARCHES_KEY);
    } catch {
        // ignore
    }
}

/**
 * Suggestions for the dropdown:
 *  - no query → the recent searches (with a clear button).
 *  - with query → matching recent searches + matching common suggestions.
 * @param {string} query
 * @returns {{recent: string[], suggestions: string[]}}
 */
export function getSearchSuggestions(query) {
    const recent = getRecentSearches();
    const normalized = (query || '').trim().toLowerCase();

    if (!normalized) {
        return { recent: recent.slice(0, 5), suggestions: [] };
    }

    const recentMatches = recent.filter((s) => s.toLowerCase().includes(normalized));
    const suggestions = COMMON_SUGGESTIONS.filter((s) =>
        s.toLowerCase().includes(normalized)
    ).slice(0, 8);

    return { recent: recentMatches.slice(0, 5), suggestions };
}
