// Search bar (top overlay) logic — open/close, the suggestion dropdown and
// search execution. Suggestions combine the user's recent searches (kept in
// localStorage) with common Persian queries; typing debounces into a real
// /api/search call, Enter or tapping a suggestion searches immediately.

import { $, clear, el, icon } from '../utils/domUtils.js';
import {
    getRecentSearches,
    getSearchSuggestions,
    addRecentSearch,
    clearRecentSearches
} from '../services/searchService.js';

let onQueryHandler = null;
let debounceTimer = null;
let lastSubmittedQuery = '';

export function isSearchOpen() {
    const container = $('#searchBarContainer');
    return !!container && container.style.display !== 'none';
}

export function openSearch(onQuery) {
    const container = $('#searchBarContainer');
    const topBar = $('#topAppBar');
    const input = $('#searchInput');
    if (!container) return;

    onQueryHandler = onQuery || null;
    container.style.display = 'block';
    document.body.classList.add('search-open');
    if (topBar) topBar.style.display = 'none';
    if (input) {
        input.focus();
        renderSuggestions(input.value || '');
    }
}

export function closeSearch() {
    const container = $('#searchBarContainer');
    const topBar = $('#topAppBar');
    const input = $('#searchInput');
    if (!container) return;

    container.style.display = 'none';
    document.body.classList.remove('search-open');
    if (topBar) topBar.style.display = 'flex';
    if (input) input.value = '';
    clear($('#searchSuggestions'));
    clearTimeout(debounceTimer);
    onQueryHandler = null;
}

/**
 * Run a search: record it in recent searches, clear the suggestion panel and
 * hand the query to the app (which renders results in the feed).
 */
export function submit(query) {
    const trimmed = (query || '').trim();
    if (!trimmed) return;

    clearTimeout(debounceTimer);
    addRecentSearch(trimmed);
    lastSubmittedQuery = trimmed;
    clear($('#searchSuggestions'));

    if (onQueryHandler) {
        onQueryHandler(trimmed);
    }
}

/** Render the suggestion dropdown for the given query text. */
export function renderSuggestions(query) {
    const box = $('#searchSuggestions');
    if (!box) return;
    clear(box);

    const { recent, suggestions } = getSearchSuggestions(query);
    const hasRecent = recent.length > 0;
    const hasQuery = (query || '').trim().length > 0;

    if (hasRecent && hasQuery) {
        box.appendChild(
            el('div', 'suggestion-header', 'جستجوهای اخیر')
        );
    } else if (hasRecent && !hasQuery) {
        const header = el('div', 'suggestion-header');
        header.appendChild(el('span', '', 'جستجوهای اخیر'));
        const clearButton = el('button', 'clear-recent');
        clearButton.type = 'button';
        clearButton.title = 'پاک کردن';
        clearButton.appendChild(icon('delete'));
        clearButton.addEventListener('click', () => {
            clearRecentSearches();
            renderSuggestions('');
        });
        header.appendChild(clearButton);
        box.appendChild(header);
    }

    recent.forEach((text) => box.appendChild(createSuggestionRow(text, 'history')));

    if (hasRecent && suggestions.length > 0) {
        box.appendChild(el('div', 'suggestion-separator'));
    }

    suggestions.forEach((text) => box.appendChild(createSuggestionRow(text, 'search')));

    if (!hasRecent && !suggestions.length && !hasQuery) {
        box.appendChild(
            el('div', 'suggestion-item suggestion-item--empty', 'چیزی برای پیشنهاد نیست')
        );
    }
}

/** A single suggestion row (history or search icon). */
function createSuggestionRow(text, kind) {
    const row = el('div', 'suggestion-item');
    row.appendChild(icon(kind === 'history' ? 'history' : 'search'));
    row.appendChild(el('span', 'suggestion-text', text));
    row.addEventListener('click', () => {
        const input = $('#searchInput');
        if (input) input.value = text;
        submit(text);
    });
    return row;
}

/**
 * Wire all search-bar events. Called once by app.js.
 * @param {(query: string) => void} onQuery
 */
export function initSearchBar(onQuery) {
    const input = $('#searchInput');
    const back = $('#searchBackButton');

    if (input) {
        input.addEventListener('input', (e) => {
            const q = e.target.value.trim();
            renderSuggestions(q);

            clearTimeout(debounceTimer);
            // Debounced auto-search while typing (like YouTube's live
            // suggestions, but backed by our own search endpoint).
            if (q.length >= 2 && q !== lastSubmittedQuery) {
                debounceTimer = setTimeout(() => submit(q), 1000);
            }
        });
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submit(input.value);
            }
        });
    }
    if (back) back.addEventListener('click', closeSearch);
    if (onQuery) onQueryHandler = onQuery;

    // Tapping outside the search bar (e.g. on a result card) closes just the
    // suggestion dropdown; the results stay visible below.
    document.addEventListener('click', (e) => {
        const container = $('#searchBarContainer');
        if (!container || container.style.display === 'none') return;
        if (!container.contains(e.target)) {
            clear($('#searchSuggestions'));
        }
    });
}
