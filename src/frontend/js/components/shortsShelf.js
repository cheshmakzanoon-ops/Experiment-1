// Shorts shelf component. Builds a horizontal-scrolling shelf of Shorts
// cards (9:16 vertical thumbnails). In phase 1 no shorts data source
// exists yet; the renderer accepts an array so follow-up phases can feed
// it search/trending results.

import { el } from '../utils/domUtils.js';
import { formatDuration, toPersianDigits } from '../utils/persianUtils.js';

/**
 * Build a Shorts shelf element.
 * @param {Array<{id: string, title: string, thumbnail?: string, duration?: number, viewCount?: number}>} shorts
 * @returns {HTMLElement|null}
 */
export function createShortsShelf(shorts = []) {
    if (!shorts.length) return null;

    const shelf = el('div', 'shorts-shelf');
    const title = el('div', 'shorts-shelf__title');
    title.innerHTML = '<span class="material-icons-round">shorts</span>';
    title.appendChild(el('span', '', 'Shorts'));
    shelf.appendChild(title);

    const row = el('div', 'shorts-shelf__row');
    shorts.forEach((short) => {
        const card = el('div', 'short-card');
        card.dataset.videoId = short.id;

        const thumb = el('div', 'short-card__thumbnail');
        const img = document.createElement('img');
        img.src = short.thumbnail || `/api/video/${short.id}/thumbnail`;
        img.alt = short.title || '';
        img.loading = 'lazy';
        thumb.appendChild(img);

        if (short.duration) {
            const badge = el('div', 'short-card__duration', formatDuration(short.duration));
            thumb.appendChild(badge);
        }

        const cardTitle = el('div', 'short-card__title', short.title || '');
        card.appendChild(thumb);
        card.appendChild(cardTitle);

        if (short.viewCount != null) {
            card.appendChild(el('div', 'short-card__views', `${toPersianDigits(short.viewCount)} بازدید`));
        }

        row.appendChild(card);
    });

    shelf.appendChild(row);
    return shelf;
}
