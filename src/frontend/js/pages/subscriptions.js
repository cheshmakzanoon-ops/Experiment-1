// Subscriptions page (اشتراک‌ها) — localStorage-backed list of the channels
// the user subscribed to from the watch page. No YouTube account needed.
// Tapping a channel bell opens the channel sheet with «حذف اشتراک».

import { $, clear, el, icon, showToast } from '../utils/domUtils.js';
import { showActionSheet } from '../components/actionSheet.js';
import { toPersianDigits } from '../utils/persianUtils.js';
import {
    getSubscriptions,
    unsubscribeFromChannel
} from '../services/libraryService.js';

export function renderSubscriptions() {
    const feed = $('#videoFeed');
    if (!feed) return;
    clear(feed);

    const subs = getSubscriptions();

    if (subs.length === 0) {
        const empty = el('div', 'error-state');
        empty.appendChild(icon('subscriptions'));
        empty.appendChild(el('p', '', 'اشتراکی ندارید'));
        empty.appendChild(
            el(
                'p',
                '',
                'برای عضویت در کانال‌ها، ویدیوها را تماشا کنید و روی دکمه «عضویت» بزنید'
            )
        );
        feed.appendChild(empty);
        return;
    }

    // Header
    const header = el('div', 'subscriptions-header');
    header.appendChild(el('h2', '', 'کانال‌های من'));
    header.appendChild(
        el('span', 'subscriptions-count', `${toPersianDigits(subs.length)} کانال`)
    );
    feed.appendChild(header);

    // Channel list
    const list = el('div', 'subscriptions-list');
    subs.forEach((channel) => list.appendChild(buildChannelRow(channel)));
    feed.appendChild(list);

    // Note about future uploads
    const note = el('div', 'subscriptions-note');
    note.appendChild(
        el('p', '', 'ویدیوهای جدید این کانال‌ها به‌زودی در این صفحه نمایش داده می‌شود')
    );
    feed.appendChild(note);
}

/** One subscribed channel row: letter avatar, name, since date, bell. */
function buildChannelRow(channel) {
    const row = el('div', 'subscription-item');
    row.dataset.channelId = channel.id;

    // Letter avatar (no external image service — works fully offline/iran).
    const avatar = el('div', 'subscription-avatar subscription-avatar--letter');
    avatar.textContent = (channel.name || '؟').trim().charAt(0);
    row.appendChild(avatar);

    const info = el('div', 'subscription-info');
    info.appendChild(el('h3', '', channel.name || 'کانال'));
    const since = channel.subscribedAt ? formatSince(channel.subscribedAt) : '';
    if (since) info.appendChild(el('span', 'subscription-date', since));
    row.appendChild(info);

    const bell = el('button', 'subscription-bell');
    bell.type = 'button';
    bell.setAttribute('aria-label', 'مدیریت اشتراک');
    bell.appendChild(icon('notifications'));
    bell.addEventListener('click', (e) => {
        e.stopPropagation();
        showActionSheet({
            title: channel.name || 'کانال',
            subtitle: 'مدیریت اشتراک این کانال',
            items: [
                {
                    icon: 'person_remove',
                    label: 'حذف اشتراک',
                    danger: true,
                    onClick: () => {
                        unsubscribeFromChannel(channel.id);
                        showToast('از کانال خارج شدید');
                        renderSubscriptions();
                    }
                }
            ]
        });
    });
    row.appendChild(bell);

    return row;
}

/** "از امروز / ۳ روز پیش / …" for the subscription date. */
function formatSince(timestamp) {
    const diffDays = Math.floor((Date.now() - timestamp) / 86400000);
    const toFa = (n) =>
        String(n)
            .split('')
            .map((d) => (d >= '0' && d <= '9' ? '۰۱۲۳۴۵۶۷۸۹'[parseInt(d, 10)] : d))
            .join('');

    if (diffDays < 1) return 'از امروز';
    if (diffDays < 7) return `از ${toFa(diffDays)} روز پیش`;
    if (diffDays < 30) return `از ${toFa(Math.floor(diffDays / 7))} هفته پیش`;
    if (diffDays < 365) return `از ${toFa(Math.floor(diffDays / 30))} ماه پیش`;
    return `از ${toFa(Math.floor(diffDays / 365))} سال پیش`;
}

export default { renderSubscriptions };
