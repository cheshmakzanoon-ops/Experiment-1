// homeFeed.js — the Home tab (آغاز).
//
// Renders into #videoFeed through a dedicated wrapper (#homeFeedView) so
// in-flight requests can tell when another page has replaced the feed
// content. Responsibilities:
//   - category chips (from /api/feed/categories, Persian labels)
//   - first page of the mixed home feed (category "all") or a category feed
//   - infinite scroll (IntersectionObserver) for further pages
//   - per-category result caching + quiet refresh after a few minutes
//
// YouTube traffic is fully server-side, so the UI only ever calls /api/feed.

import {
    fetchHomeFeed,
    fetchCategoryFeed,
    fetchCategories,
    FALLBACK_CATEGORIES
} from '../services/feedService.js';
import { createVideoCard, createSkeletonCard } from './videoCard.js';
import { openVideoPlayer } from './videoPlayer.js';
import { showToast, clear, el, icon } from '../utils/domUtils.js';
import { getNotInterested } from '../services/libraryService.js';

const VIEW_ID = 'homeFeedView';

/** Loaded feeds older than this are quietly refreshed on re-entry. */
const REFRESH_AFTER_MS = 15 * 60 * 1000;
/** Minimum wait after a failed "load more" before retrying on scroll. */
const RETRY_COOLDOWN_MS = 8000;

// --- module state ----------------------------------------------------------
let activeCategory = 'all';
let chipsReady = false;
let generation = 0;
let lastSentinel = null;
let observer = null;
let viewEl = null;

const feedStates = new Map(); // categoryId → { videos, page, hasMore, loading, inflight, loadedAt, nextRetryAt }

function getState(categoryId) {
    if (!feedStates.has(categoryId)) {
        feedStates.set(categoryId, {
            videos: [],
            page: 1,
            hasMore: true,
            loading: false,
            cycleGen: -1,
            loadedAt: 0,
            nextRetryAt: 0
        });
    }
    return feedStates.get(categoryId);
}

/** Filter out videos the user marked "not interested". */
function visibleVideos(videos) {
    const hidden = new Set(getNotInterested());
    return videos.filter((v) => !hidden.has(v.id));
}

/**
 * True when this render cycle may still touch the DOM.
 * @param {number} [genAtStart] generation captured when the async work began
 */
function cycleAlive(genAtStart) {
    return (
        !!viewEl &&
        viewEl.isConnected &&
        (genAtStart === undefined || genAtStart === generation) &&
        viewEl.dataset.gen === String(generation)
    );
}

function bumpGeneration() {
    generation += 1;
    if (viewEl) viewEl.dataset.gen = String(generation);
}

// --- IntersectionObserver (infinite scroll) --------------------------------
function io() {
    if (observer) return observer;
    observer = new IntersectionObserver(
        (entries) => {
            if (entries.some((e) => e.isIntersecting)) loadMore();
        },
        { rootMargin: '800px', threshold: 0.01 }
    );
    return observer;
}

function observeSentinel(node) {
    if (lastSentinel && lastSentinel !== node) io().unobserve(lastSentinel);
    lastSentinel = node || null;
    if (node) io().observe(node);
}

// --- DOM helpers -------------------------------------------------------------
function ensureWrapper(container) {
    let wrapper = document.getElementById(VIEW_ID);
    if (wrapper && wrapper.parentNode === container) return wrapper;

    // Coming back to Home from another page: replace whatever is in the feed.
    clear(container);
    wrapper = el('div', '', '');
    wrapper.id = VIEW_ID;
    container.appendChild(wrapper);
    return wrapper;
}

function paintSkeletons(wrapper) {
    clear(wrapper);
    for (let i = 0; i < 6; i++) {
        wrapper.appendChild(createSkeletonCard());
    }
}

function paintFeedError(wrapper, retry) {
    clear(wrapper);
    const box = el('div', 'error-state');
    box.appendChild(icon('wifi_off'));
    box.appendChild(el('p', '', 'خطا در بارگذاری ویدیوها'));
    box.appendChild(
        el('p', '', 'اتصال اینترنت را بررسی کنید و دوباره تلاش کنید')
    );
    const button = el('button', '', 'تلاش مجدد');
    button.addEventListener('click', retry);
    box.appendChild(button);
    wrapper.appendChild(box);
}

function paintEmpty(wrapper) {
    clear(wrapper);
    const box = el('div', 'error-state');
    box.appendChild(icon('video_library_off'));
    box.appendChild(el('p', '', 'ویدیویی یافت نشد'));
    box.appendChild(
        el('p', '', 'کمی بعد دوباره تلاش کنید یا دسته‌بندی دیگری را ببینید')
    );
    wrapper.appendChild(box);
}

function appendVideoCards(wrapper, videos) {
    videos.forEach((video) => {
        wrapper.appendChild(createVideoCard(video, openVideoPlayer));
    });
}

function ensureSentinel(wrapper, state) {
    wrapper.querySelectorAll('.feed-sentinel').forEach((n) => n.remove());
    if (!state.hasMore) {
        observeSentinel(null);
        return;
    }
    const sentinel = el('div', 'feed-sentinel');
    wrapper.appendChild(sentinel);
    observeSentinel(sentinel);
}

/** Paint a full page of cards (used for first pages + silent refresh). */
function paintPage(wrapper, videos, state) {
    clear(wrapper);
    if (!videos.length) {
        paintEmpty(wrapper);
        return;
    }
    appendVideoCards(wrapper, visibleVideos(videos));
    ensureSentinel(wrapper, state);
}

function showLoadMoreIndicator(wrapper) {
    wrapper.querySelectorAll('.load-more-indicator').forEach((n) => n.remove());
    const row = el('div', 'load-more-indicator');
    const spinner = el('div', 'spinner');
    row.appendChild(spinner);
    row.appendChild(el('span', '', 'در حال بارگذاری...'));
    wrapper.appendChild(row);
    return row;
}

// --- data fetching ------------------------------------------------------------

/** Which endpoint serves the given category. */
function fetchFeedPage(categoryId, page) {
    // The API caps pagination (20 pages for home, 10 per category); stop
    // asking before the server would answer 400.
    const maxPage = categoryId === 'all' ? 20 : 10;
    if (page > maxPage) {
        return Promise.resolve({ videos: [], hasMore: false });
    }
    return categoryId === 'all'
        ? fetchHomeFeed(page, 12)
        : fetchCategoryFeed(categoryId, page, 12);
}

/**
 * Fetch page 1 of the active category and paint it.
 * `silent` skips the skeleton (used when refreshing already-visible content).
 */
async function loadFirstPage(state, categoryId, wrapper, silent = false) {
    if (state.loading) return;
    state.loading = true;
    const genAtStart = generation;
    state.cycleGen = genAtStart;

    if (!silent && cycleAlive(genAtStart)) {
        paintSkeletons(wrapper);
    }

    try {
        const response = await fetchFeedPage(categoryId, 1);
        if (categoryId !== activeCategory || !cycleAlive(genAtStart)) return;

        state.videos = response.videos || [];
        state.page = 2;
        state.hasMore = !!response.hasMore && state.videos.length > 0;
        state.loadedAt = Date.now();
        state.nextRetryAt = 0;

        paintPage(wrapper, state.videos, state);
    } catch (error) {
        console.error('[home] Feed load failed:', error);
        state.nextRetryAt = Date.now() + RETRY_COOLDOWN_MS;
        if (categoryId === activeCategory && cycleAlive()) {
            if (!silent || !state.videos.length) {
                paintFeedError(wrapper, () => loadFirstPage(state, categoryId, wrapper, false));
            } else {
                showToast('خطا در بارگذاری ویدیوها');
            }
        }
    } finally {
        state.loading = false;
    }
}

/** Append the next page of the active category (infinite scroll). */
async function loadMore() {
    if (!cycleAlive()) return;

    const categoryId = activeCategory;
    const state = getState(categoryId);
    if (!state.hasMore || state.loading) return;
    if (Date.now() < state.nextRetryAt) return; // cooldown after a failure

    state.loading = true;
    const genAtStart = generation;
    const wrapper = viewEl;
    const indicator = showLoadMoreIndicator(wrapper);

    try {
        let page = state.page;
        const existingIds = new Set(state.videos.map((v) => v.id));
        const hidden = new Set(getNotInterested());
        const appendedVideos = [];

        // yt-dlp search pages overlap, so skip ahead until we find unseen
        // videos or the server says there is nothing more.
        let hasMore = true;
        for (let attempt = 0; attempt < 4; attempt++) {
            const response = await fetchFeedPage(categoryId, page);
            if (categoryId !== activeCategory || !cycleAlive(genAtStart)) return;

            const fresh = (response.videos || []).filter(
                (v) => !existingIds.has(v.id) && !hidden.has(v.id)
            );
            appendedVideos.push(...fresh);
            fresh.forEach((v) => existingIds.add(v.id));
            page += 1;
            hasMore = !!response.hasMore;

            if (fresh.length > 0 || !hasMore) break;
        }

        state.page = page;
        state.loadedAt = Date.now();
        state.nextRetryAt = 0;
        // Never keep scrolling forever on duplicate/empty pages.
        state.hasMore = hasMore && appendedVideos.length > 0;

        if (cycleAlive(genAtStart)) {
            appendVideoCards(wrapper, appendedVideos);
            if (!state.hasMore) observeSentinel(null);
        }
    } catch (error) {
        console.error('[home] Load more failed:', error);
        state.nextRetryAt = Date.now() + RETRY_COOLDOWN_MS;
        showToast('خطا در بارگذاری ویدیوهای بیشتر');
    } finally {
        state.loading = false;
        if (viewEl && viewEl.isConnected) {
            viewEl.querySelectorAll('.load-more-indicator').forEach((n) => n.remove());
        }
    }
}

// --- chips --------------------------------------------------------------------

/** Render the chip row for the given category list. */
function paintChips(categories) {
    const chipsEl = document.getElementById('filterChips');
    if (!chipsEl || !categories || !categories.length) return;

    clear(chipsEl);
    categories.forEach((cat) => {
        const chip = el('div', `filter-chip${cat.id === activeCategory ? ' filter-chip--active' : ''}`, cat.nameFa);
        chip.dataset.categoryId = cat.id;
        chip.addEventListener('click', () => selectCategory(cat.id));
        chipsEl.appendChild(chip);
    });
}

function ensureChips() {
    const chipsEl = document.getElementById('filterChips');
    if (!chipsEl || chipsReady) return;

    chipsReady = true;
    // Paint instantly from the built-in list (works offline / before the
    // first server round-trip), then swap in the server's list when it
    // arrives — fetchCategories() falls back to the same built-in list.
    paintChips(FALLBACK_CATEGORIES);
    fetchCategories()
        .then((categories) => {
            if (Array.isArray(categories) && categories.length > 0) {
                paintChips(categories);
            }
        })
        .catch(() => {});
}

function updateChipActive() {
    const chipsEl = document.getElementById('filterChips');
    if (!chipsEl) return;
    chipsEl.querySelectorAll('.filter-chip').forEach((chip) => {
        chip.classList.toggle('filter-chip--active', chip.dataset.categoryId === activeCategory);
    });
}

// --- public API ---------------------------------------------------------------

/**
 * Render the home feed into the container.
 * @param {HTMLElement} container the #videoFeed element
 */
export async function renderHomeFeed(container) {
    if (!container) return;

    ensureChips();
    updateChipActive();

    const state = getState(activeCategory);
    const wrapper = document.getElementById(VIEW_ID);
    const freshView =
        !wrapper ||
        wrapper.parentNode !== container ||
        (wrapper.childElementCount === 0 && !state.loading);

    if (freshView) {
        // Coming back to Home (or first load): own a new render cycle. If a
        // stale request from an earlier cycle is still pending, drop it and
        // start over — it can no longer paint.
        clear(container);
        viewEl = el('div', '', '');
        viewEl.id = VIEW_ID;
        container.appendChild(viewEl);
        bumpGeneration();

        if (state.loading && state.cycleGen !== generation) {
            state.loading = false;
        }

        if (state.videos.length > 0) {
            // Instant paint from the cache; refresh quietly in the background.
            paintPage(viewEl, state.videos, state);
            if (Date.now() - state.loadedAt > REFRESH_AFTER_MS && !state.loading) {
                loadFirstPage(state, activeCategory, viewEl, true);
            }
        } else if (!state.loading) {
            await loadFirstPage(state, activeCategory, viewEl, false);
        } else if (state.cycleGen === generation) {
            // A fresh request is already in flight for this cycle.
            if (viewEl.childElementCount === 0) paintSkeletons(viewEl);
        }
        return;
    }

    // The wrapper from an earlier cycle is still on screen.
    viewEl = wrapper;
    if (state.videos.length > 0) {
        paintPage(viewEl, state.videos, state);
        if (Date.now() - state.loadedAt > REFRESH_AFTER_MS && !state.loading) {
            loadFirstPage(state, activeCategory, viewEl, true); // quiet refresh
        }
    } else if (!state.loading) {
        await loadFirstPage(state, activeCategory, viewEl, false);
    }
    // else: an in-flight request for this cycle will paint when it resolves.
}

/** Switch the feed to another category (chip click). */
export function selectCategory(categoryId) {
    if (categoryId === activeCategory || !viewEl || !viewEl.isConnected) return;

    activeCategory = categoryId;
    updateChipActive();
    bumpGeneration();
    window.scrollTo(0, 0);

    const state = getState(categoryId);
    if (state.videos.length > 0 && !state.loading) {
        paintPage(viewEl, state.videos, state);
        if (Date.now() - state.loadedAt > REFRESH_AFTER_MS) {
            loadFirstPage(state, categoryId, viewEl, true);
        }
    } else if (!state.loading) {
        loadFirstPage(state, categoryId, viewEl, false);
    }
}
