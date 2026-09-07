// feedService.js — client access to the /api/feed endpoints (home feed,
// category feeds, category list). The server proxies all YouTube traffic,
// so these are the only calls the UI makes for trending content.

const API_BASE = '/api'

/** Default category list shown while the server list is loading/offline. */
export const FALLBACK_CATEGORIES = [
    { id: 'all', nameFa: 'همه', nameEn: 'All' },
    { id: 'music', nameFa: 'موسیقی', nameEn: 'Music' },
    { id: 'gaming', nameFa: 'بازی‌ها', nameEn: 'Gaming' },
    { id: 'live', nameFa: 'پخش زنده', nameEn: 'Live' },
    { id: 'cooking', nameFa: 'آشپزی', nameEn: 'Cooking' },
    { id: 'news', nameFa: 'اخبار', nameEn: 'News' },
    { id: 'comedy', nameFa: 'طنز', nameEn: 'Comedy' },
    { id: 'learning', nameFa: 'آموزش', nameEn: 'Learning' },
    { id: 'sports', nameFa: 'ورزش', nameEn: 'Sports' },
    { id: 'tech', nameFa: 'تکنولوژی', nameEn: 'Technology' },
    { id: 'movies', nameFa: 'فیلم', nameEn: 'Movies' },
    { id: 'kids', nameFa: 'کودکان', nameEn: 'Kids' }
];

/**
 * Fetch the mixed home feed.
 * @param {number} page 1-based page number
 * @param {number} limit videos per page
 * @returns {Promise<{page: number, hasMore: boolean, videos: object[]}>}
 */
export async function fetchHomeFeed(page = 1, limit = 12) {
    const response = await fetch(`${API_BASE}/feed/home?page=${page}&limit=${limit}`);
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
}

/**
 * Fetch a category-specific feed.
 * @param {string} categoryId
 * @param {number} page
 * @param {number} limit
 */
export async function fetchCategoryFeed(categoryId, page = 1, limit = 12) {
    const response = await fetch(
        `${API_BASE}/feed/category/${encodeURIComponent(categoryId)}?page=${page}&limit=${limit}`
    );
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
}

/**
 * Get the list of available categories (Persian labels for the chips).
 * Falls back to the built-in list when the server is unreachable so the
 * home tab still has working chips.
 * @returns {Promise<{id: string, nameFa: string}[]>}
 */
export async function fetchCategories() {
    try {
        const response = await fetch(`${API_BASE}/feed/categories`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return Array.isArray(data.categories) && data.categories.length > 0
            ? data.categories
            : FALLBACK_CATEGORIES;
    } catch (error) {
        console.error('[feedService] Categories failed:', error);
        return FALLBACK_CATEGORIES;
    }
}
