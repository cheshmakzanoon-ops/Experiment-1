// Search results page — runs a query against /api/search and renders the
// results as video cards below the search bar (same look as the home feed).

import { $, clear, showLoading, showError, el, icon } from '../utils/domUtils.js';
import { performSearch } from '../services/searchService.js';
import { createVideoCard } from '../components/videoCard.js';
import { openVideoPlayer } from '../components/videoPlayer.js';
import { toPersianDigits } from '../utils/persianUtils.js';

// Only the most recent request may paint — a slow earlier search must not
// overwrite the results of a newer one.
let renderSeq = 0;

export async function renderSearchResults(query) {
    const feed = $('#videoFeed');
    if (!feed) return;

    const seq = ++renderSeq;
    showLoading(feed, 'در حال جستجو...');

    try {
        const data = await performSearch(query);
        if (seq !== renderSeq) return; // a newer search superseded this one
        clear(feed);

        const results = Array.isArray(data.results) ? data.results : [];

        // Header: «نتایج جستجو برای: query» + result count
        const header = el('div', 'search-results-header');
        const title = el('h2', '', `نتایج جستجو برای: «${query}»`);
        header.appendChild(title);
        const count = el('span', 'search-results-count', `${toPersianDigits(results.length)} نتیجه`);
        header.appendChild(count);
        feed.appendChild(header);

        if (results.length === 0) {
            const empty = el('div', 'error-state');
            empty.appendChild(icon('search_off'));
            empty.appendChild(el('p', '', `نتیجه‌ای برای «${query}» یافت نشد`));
            empty.appendChild(
                el('p', '', 'عبارت دیگری را امتحان کنید')
            );
            feed.appendChild(empty);
            return;
        }

        results.forEach((video) => {
            feed.appendChild(createVideoCard(video, openVideoPlayer));
        });
    } catch (error) {
        console.error('Search failed:', error);
        if (seq !== renderSeq) return;
        showError(feed, 'خطا در جستجو');
    }
}

export default { renderSearchResults };
