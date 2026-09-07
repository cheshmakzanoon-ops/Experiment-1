// Home page (آغاز): renders chips + feed into the main content area.
// The heavy lifting (category chips, trending feed, infinite scroll) lives
// in components/homeFeed.js.

import { $ } from '../utils/domUtils.js';
import { renderHomeFeed } from '../components/homeFeed.js';

export async function renderHome() {
    const feed = $('#videoFeed');
    if (!feed) return;
    await renderHomeFeed(feed);
}

export default { renderHome };
