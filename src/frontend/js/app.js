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
 */
function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        registerSw();
    } else {
        window.addEventListener('load', registerSw);
    }
}

function registerSw() {
    // Module worker: sw.js imports the shared caching policy from
    // js/sw-policy.js. Unsupported browsers reject the promise and the app
    // simply stays online-only — never fatal.
    navigator.serviceWorker
        .register('sw.js', { type: 'module' })
        .catch((error) => {
            console.warn('[sw] registration failed:', error);
        });
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
