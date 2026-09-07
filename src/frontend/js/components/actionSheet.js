// actionSheet.js — YouTube-Android-style bottom action sheet.
//
// A dimmed overlay + a rounded panel that slides up from the bottom with a
// list of icon+label actions. Used by video cards (⋯), the watch page and
// the subscriptions/library rows.

import { el, icon } from '../utils/domUtils.js';

/**
 * Show a bottom action sheet.
 * @param {object} options
 * @param {string} [options.title] small heading above the actions
 * @param {string} [options.subtitle] secondary line under the title
 * @param {Array<{icon: string, label: string, danger?: boolean, onClick: () => void}>} options.items
 * @returns {void}
 */
export function showActionSheet({ title = '', subtitle = '', items = [] }) {
    const overlay = el('div', 'action-sheet-overlay');
    const sheet = el('div', 'action-sheet');

    const close = () => {
        overlay.remove();
        sheet.remove();
    };

    overlay.addEventListener('click', close);

    if (title) {
        const heading = el('div', 'action-sheet__header');
        if (subtitle) {
            const titleEl = el('h3', 'action-sheet__title', title);
            const subEl = el('p', 'action-sheet__subtitle', subtitle);
            heading.appendChild(titleEl);
            heading.appendChild(subEl);
        } else {
            heading.appendChild(el('h3', 'action-sheet__title', title));
        }
        sheet.appendChild(heading);
    }

    items.forEach((item) => {
        const row = el('button', `action-sheet__item${item.danger ? ' action-sheet__item--danger' : ''}`);
        row.type = 'button';
        row.appendChild(icon(item.icon, 'action-sheet__item-icon'));
        row.appendChild(el('span', 'action-sheet__item-label', item.label));
        row.addEventListener('click', () => {
            close();
            if (typeof item.onClick === 'function') item.onClick();
        });
        sheet.appendChild(row);
    });

    document.body.appendChild(overlay);
    document.body.appendChild(sheet);
}
