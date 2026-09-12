// Main application entry point.
//
// index.html owns the markup (top app bar, search overlay, feed, watch page,
// bottom nav); this module wires the shared components/pages together:
//   - components/bottomNav.js   → bottom tab switching
//   - components/searchBar.js   → search overlay open/close + suggestions
//   - pages/home|search|subscriptions|library.js → per-tab content
//   - components/videoPlayer.js → watch page open/close

import { initBottomNav, setActiveNav } from './components/bottomNav.js';
import {
    initSearchBar,
    openSearch,
    closeSearch,
    isSearchOpen
} from './components/searchBar.js';
import { closeVideoPlayer } from './components/videoPlayer.js';
import { renderHome } from './pages/home.js';
import { renderSearchResults } from './pages/search.js';
import { renderSubscriptions } from './pages/subscriptions.js';
import { renderLibrary } from './pages/library.js';
import { onAndroidReady, requestPersistentStorage } from './utils/nativeApp.js';

// Which content tab is currently shown (home/shorts/subscriptions/library).
let activePage = 'home';
// True while the feed is showing search results instead of the active tab.
let showingSearchResults = false;

function init() {
    registerServiceWorker();
    initNativeWrapper();
    initSearchBar(runSearch);
    initBottomNav(navigateToPage);

    const searchButton = document.getElementById('searchButton');
    if (searchButton) {
        searchButton.addEventListener('click', () => {
            openSearch(runSearch);
            setChipsVisible(false);
        });
    }

    // Back from search restores the tab that was visible before searching.
    const searchBackButton = document.getElementById('searchBackButton');
    if (searchBackButton) searchBackButton.addEventListener('click', restoreAfterSearch);

    const videoCloseButton = document.getElementById('videoCloseButton');
    if (videoCloseButton) videoCloseButton.addEventListener('click', closeVideoPlayer);

    // Filter chips are owned by the home feed (components/homeFeed.js) — they
    // are fetched from /api/feed/categories and drive real category feeds.
    // Scrolling is left to the browser; overscroll-behavior in the CSS
    // already prevents pull-to-refresh without blocking feed scrolling.

    navigateToPage('home');
}

/** Render the content tab for the given bottom-nav page. */
function navigateToPage(page) {
    // The center "+" opens the upload/create sheet — arrives in a later phase.
    if (page === 'create') return;
    if (isSearchOpen()) closeSearch();

    showingSearchResults = false;
    activePage = page;
    setActiveNav(page);
    window.scrollTo(0, 0);

    switch (page) {
        case 'subscriptions':
            renderSubscriptions();
            break;
        case 'library':
            renderLibrary();
            break;
        case 'shorts':
            renderShortsPlaceholder();
            break;
        case 'home':
        default:
            renderHome();
            break;
    }

    // YouTube only shows the category chips on the Home tab.
    setChipsVisible(page === 'home');
}

/** Run a search and show the results in the feed (search bar stays open). */
async function runSearch(query) {
    showingSearchResults = true;
    await renderSearchResults(query);

    // If the user navigated away while the search was still loading, put the
    // active tab's content back (renderSearchResults may have just replaced it).
    if (!showingSearchResults) {
        navigateToPage(activePage);
    }
}

/** Called when the search bar's back arrow is pressed. */
function restoreAfterSearch() {
    if (showingSearchResults) {
        navigateToPage(activePage);
    } else {
        // No results were shown — just put the chips back if we were on Home.
        setChipsVisible(activePage === 'home');
    }
}

/** Show/hide the filter-chip row ('' lets the stylesheet decide, e.g. RTL). */
function setChipsVisible(visible) {
    const chips = document.getElementById('filterChips');
    if (chips) chips.style.display = visible ? '' : 'none';
}

/**
 * Native-wrapper hooks (android/ WebView). Best-effort: in a plain browser
 * every helper degrades silently, so this only adds a couple of listeners.
 *   • Ask for persistent storage so IndexedDB offline downloads survive
 *     (native bridge on Android, navigator.storage.persist elsewhere).
 *   • When the wrapper announces itself (android-wrapper-ready), mark the
 *     page and disable the browser pull-to-refresh gesture.
 */
function initNativeWrapper() {
    requestPersistentStorage().then((granted) => {
        if (granted) {
            console.log('[native] Persistent storage granted — offline videos won\'t be auto-cleared');
        }
    });

    onAndroidReady(() => {
        document.body.classList.add('native-app');
        // Pull-to-refresh is handled by the wrapper's SwipeRefreshLayout.
        document.body.style.overscrollBehavior = 'none';
        console.log('[native] Running inside the Android wrapper');
    });
}

/**
 * Offline/low-bandwidth cache (sw.js). Best-effort: unsupported browsers or
 * restricted contexts (e.g. private browsing) simply keep working online.
 *
 * Registration details (F03):
 *   • registers in the app's own top scope ('/') and unregisters any stale
 *     handle found OUTSIDE that scope instead of fighting over scope,
 *   • module-worker support is probed once; no classic-worker fallback is
 *     attempted (this sw.js imports ES modules — a classic worker would
 *     die on its first import and leave a half-installed shell),
 *   • exactly ONE controlled reload per generation: the worker announces a
 *     new verified generation only after its full manifest has activated,
 *     and the page reloads once per generation id (never in a loop).
 */
const SW_SCOPE = '/';
const SW_GENERATION_KEY = 'swShellGeneration';
let shellReloadArmed = false;

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Module-worker capability is decided by the REGISTRATION itself, not by
    // a blob-worker probe: a CSP that legitimately forbids blob: scripts
    // (script-src 'self' without blob:) made the old probe throw and the
    // catch disabled the real service worker too (R5). Attempting the real
    // registration keeps every unsupported-browser outcome identical (the
    // register promise rejects → warn → stay online-only) while a strict CSP
    // no longer breaks offline support.
    if (typeof Worker === 'undefined') {
        console.warn('[sw] workers unsupported — staying online-only');
        return;
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        void registerSw();
    } else {
        window.addEventListener('load', () => void registerSw());
    }
}

async function registerSw() {
    try {
        // Stale registrations outside our scope cannot serve this shell.
        const expectedScope = new URL(SW_SCOPE, location.href).href;
        const existing = await navigator.serviceWorker.getRegistrations();
        for (const stale of existing) {
            if (stale.scope !== expectedScope) {
                await stale.unregister().catch(() => {});
            }
        }

        await navigator.serviceWorker.register('sw.js', {
            scope: SW_SCOPE,
            type: 'module'
        });

        // ONE controlled reload per generation: the worker sends this after
        // its complete manifest activated. Download writes are transactional
        // (IndexedDB), so a reload never corrupts a partial chunk write.
        navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event && event.data;
            if (!data || data.type !== 'shell-generation-active') return;
            let lastGeneration = null;
            try {
                lastGeneration = sessionStorage.getItem(SW_GENERATION_KEY);
            } catch {
                /* private mode: the armed flag still guards the loop */
            }
            if (lastGeneration === data.generation || shellReloadArmed) return;
            shellReloadArmed = true;
            try {
                sessionStorage.setItem(SW_GENERATION_KEY, String(data.generation));
            } catch {
                /* non-fatal */
            }
            window.location.reload();
        });
    } catch (error) {
        console.warn('[sw] registration failed:', error);
    }
}

/** Shorts shelf needs a data source (later phase); show a friendly stub. */
function renderShortsPlaceholder() {
    const feed = document.getElementById('videoFeed');
    if (!feed) return;
    feed.innerHTML = `
        <div class="error-state">
            <span class="material-icons-round">shorts</span>
            <p>Shorts در حال آمادهسازی است</p>
        </div>
    `;
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
