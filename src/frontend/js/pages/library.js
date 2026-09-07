// Library page (کتابخانه) — four localStorage/IndexedDB-backed sections:
//   تاریخچه تماشا (watch history) · تماشا در آینده (watch later) ·
//   پسندیده‌ها (liked) · آفلاین (offline downloads)
// Every row can be opened (adds back to history) and removed via its ⋮ menu.
//
// The offline section is live: while a download runs it shows a progress
// bar that updates in place (offline:progress), and when downloads start,
// finish or are deleted the section re-renders (offline:changed) so its
// rows always reflect reality.

import { $, clear, el, icon, showToast } from '../utils/domUtils.js';
import { openVideoPlayer } from '../components/videoPlayer.js';
import { showActionSheet } from '../components/actionSheet.js';
import { formatDuration, toPersianDigits } from '../utils/persianUtils.js';
import {
    getWatchHistory,
    removeFromWatchHistory,
    clearWatchHistory,
    getWatchLater,
    removeFromWatchLater,
    getLikedVideos,
    unlikeVideo
} from '../services/libraryService.js';
import {
    offlineSupported,
    getDownloads,
    getDownload,
    startDownload,
    cancelDownload,
    removeDownload,
    offlinePlayUrl
} from '../services/offlineService.js';

const HISTORY_SHOWN = 10;

/** Body element of the «آفلاین» section (replaced on each render). */
let offlineBodyEl = null;
let offlineEventsBound = false;

export async function renderLibrary() {
    const feed = $('#videoFeed');
    if (!feed) return;
    clear(feed);

    const history = getWatchHistory();
    const watchLater = getWatchLater();
    const liked = getLikedVideos();

    feed.appendChild(
        buildSectionHeader('history', 'تاریخچه تماشا', history.length, () => {
            clearWatchHistory();
            showToast('تاریخچه پاک شد');
            renderLibrary();
        })
    );
    const historyBody = el('div', 'library-section-body');
    if (history.length === 0) {
        historyBody.appendChild(emptyRow('هنوز ویدیویی تماشا نکرده‌اید'));
    } else {
        const shown = history.slice(0, HISTORY_SHOWN);
        shown.forEach((video) =>
            historyBody.appendChild(
                buildRow(video, [
                    {
                        icon: 'delete',
                        label: 'حذف از تاریخچه',
                        danger: true,
                        onClick: () => {
                            removeFromWatchHistory(video.id);
                            showToast('از تاریخچه حذف شد');
                            renderLibrary();
                        }
                    }
                ])
            )
        );
        if (history.length > HISTORY_SHOWN) {
            historyBody.appendChild(
                buildShowMoreButton(
                    `نمایش ${toPersianDigits(history.length - HISTORY_SHOWN)} ویدیوی دیگر`,
                    () => {
                        history.slice(HISTORY_SHOWN).forEach((video) =>
                            historyBody.insertBefore(
                                buildRow(video, [
                                    {
                                        icon: 'delete',
                                        label: 'حذف از تاریخچه',
                                        danger: true,
                                        onClick: () => {
                                            removeFromWatchHistory(video.id);
                                            renderLibrary();
                                        }
                                    }
                                ]),
                                historyBody.querySelector('.show-more-button')
                            )
                        );
                        historyBody.querySelector('.show-more-button')?.remove();
                    }
                )
            );
        }
    }
    feed.appendChild(historyBody);

    feed.appendChild(
        buildSectionHeader('watch_later', 'تماشا در آینده', watchLater.length)
    );
    const laterBody = el('div', 'library-section-body');
    if (watchLater.length === 0) {
        laterBody.appendChild(emptyRow('فهرست خالی است — از منوی ⋮ هر ویدیو ذخیره کنید'));
    } else {
        watchLater.forEach((video) =>
            laterBody.appendChild(
                buildRow(video, [
                    {
                        icon: 'delete',
                        label: 'حذف از تماشا در آینده',
                        danger: true,
                        onClick: () => {
                            removeFromWatchLater(video.id);
                            showToast('حذف شد');
                            renderLibrary();
                        }
                    }
                ])
            )
        );
    }
    feed.appendChild(laterBody);

    feed.appendChild(buildSectionHeader('thumb_up', 'ویدیوهای پسندیده', liked.length));
    const likedBody = el('div', 'library-section-body');
    if (liked.length === 0) {
        likedBody.appendChild(emptyRow('هنوز ویدیویی را نپسندیده‌اید'));
    } else {
        liked.forEach((video) =>
            likedBody.appendChild(
                buildRow(video, [
                    {
                        icon: 'delete',
                        label: 'حذف از ویدیوهای پسندیده',
                        danger: true,
                        onClick: () => {
                            unlikeVideo(video.id);
                            showToast('پسندیدن لغو شد');
                            renderLibrary();
                        }
                    }
                ])
            )
        );
    }
    feed.appendChild(likedBody);

    // --- Offline downloads (live section) ---
    const downloads = offlineSupported() ? await getDownloads() : [];
    const readyCount = downloads.filter((d) => d.status === 'ready').length;
    feed.appendChild(buildSectionHeader('offline_pin', 'آفلاین', readyCount));

    const offlineBody = el('div', 'library-section-body');
    offlineBodyEl = offlineBody;
    fillOfflineBody(offlineBody, downloads);
    feed.appendChild(offlineBody);

    bindOfflineEvents();
}

// ---------------------------------------------------------------------------
// Offline section
// ---------------------------------------------------------------------------

/** One-time document listeners that always patch the current offline body. */
function bindOfflineEvents() {
    if (offlineEventsBound) return;
    offlineEventsBound = true;

    document.addEventListener('offline:progress', async (event) => {
        if (!offlineBodyEl || !offlineBodyEl.isConnected || !event.detail) return;
        const entry = await getDownload(event.detail.id);
        if (!entry) return;
        for (const row of offlineBodyEl.children) {
            if (row.dataset && row.dataset.videoId === event.detail.id) {
                updateOfflineRow(row, entry);
                break;
            }
        }
    });

    // Start / finish / delete → rows change shape (progress bar vs playable
    // row, empty state, …), so re-render the whole section quietly.
    document.addEventListener('offline:changed', () => {
        if (!offlineBodyEl || !offlineBodyEl.isConnected) return;
        renderLibrary();
    });
}

function fillOfflineBody(body, downloads) {
    clear(body);

    if (!offlineSupported()) {
        body.appendChild(emptyRow('این مرورگر دانلود آفلاین را پشتیبانی نمی‌کند'));
        return;
    }
    if (downloads.length === 0) {
        body.appendChild(
            emptyRow('هنوز ویدیویی دانلود نشده — از منوی ⋮ گزینه «دانلود برای تماشای آفلاین»')
        );
        return;
    }

    // In-flight downloads first (by progress), then saved ones (newest first).
    downloads
        .slice()
        .sort((a, b) => {
            const aActive = a.status === 'downloading' ? 0 : 1;
            const bActive = b.status === 'downloading' ? 0 : 1;
            if (aActive !== bActive) return aActive - bActive;
            if (a.status === 'downloading') return (a.progress || 0) - (b.progress || 0);
            return (b.downloadedAt || 0) - (a.downloadedAt || 0);
        })
        .forEach((download) => body.appendChild(buildOfflineRow(download)));
}

/** A row in the offline list — mirrors the compact rows of other sections. */
function buildOfflineRow(download) {
    const row = el('div', 'compact-video-card compact-video-card--offline');
    row.dataset.videoId = download.id;

    const thumbnail = el('div', 'compact-video-card__thumbnail');
    const img = document.createElement('img');
    img.src = download.thumbnail || `/api/video/${download.id}/thumbnail`;
    img.alt = download.title || '';
    img.loading = 'lazy';
    img.onerror = () => {
        img.style.display = 'none';
    };
    thumbnail.appendChild(img);
    if (download.duration && download.duration > 0) {
        thumbnail.appendChild(
            el('span', 'compact-video-card__duration', formatDuration(download.duration))
        );
    }
    row.appendChild(thumbnail);

    const info = el('div', 'compact-video-card__info');
    info.appendChild(el('h4', 'compact-video-card__title', download.title || 'بدون عنوان'));
    info.appendChild(el('span', 'compact-video-card__meta', download.author || 'ناشناس'));

    if (download.status === 'downloading' || download.status === 'paused') {
        const status = el('div', 'offline-download-status');
        status.appendChild(el('span', 'offline-download-status__text', progressLabel(download)));
        const track = el('div', 'download-progress');
        const bar = el('div', 'download-progress__bar');
        applyProgressBar(bar, download);
        track.appendChild(bar);
        status.appendChild(track);
        info.appendChild(status);
        if (download.status === 'paused') {
            info.appendChild(el('div', 'offline-paused-label', 'متوقف — برای ادامه لمس کنید'));
        }
    } else {
        info.appendChild(
            el('div', 'offline-ready-label', `آفلاین • ${formatBytes(download.size || download.totalBytes)}`)
        );
    }
    row.appendChild(info);

    // ⋮ menu
    let menuItems;
    if (download.status === 'downloading') {
        menuItems = [
            {
                icon: 'close',
                label: 'لغو دانلود',
                danger: true,
                onClick: () => {
                    cancelDownload(download.id);
                    showToast('دانلود لغو شد');
                }
            }
        ];
    } else if (download.status === 'paused') {
        menuItems = [
            {
                icon: 'download',
                label: 'ادامه دانلود',
                onClick: () => resumeOfflineRow(download)
            },
            {
                icon: 'delete',
                label: 'حذف دانلود',
                danger: true,
                onClick: () => {
                    removeDownload(download.id);
                    showToast('دانلود حذف شد');
                }
            }
        ];
    } else {
        menuItems = [
                  {
                      icon: 'play_circle_outline',
                      label: 'پخش آفلاین',
                      onClick: () => playOfflineRow(download)
                  },
                  {
                      icon: 'delete',
                      label: 'حذف دانلود',
                      danger: true,
                      onClick: () => {
                          removeDownload(download.id);
                          showToast('دانلود حذف شد');
                      }
                  }
              ];
    }
    const menu = el('button', 'compact-video-card__menu');
    menu.type = 'button';
    menu.setAttribute('aria-label', 'گزینه‌ها');
    menu.appendChild(icon('more_vert'));
    menu.addEventListener('click', (e) => {
        e.stopPropagation();
        showActionSheet({ title: download.title || '', items: menuItems });
    });
    row.appendChild(menu);

    // Row tap plays the local copy (ignored while still downloading); a tap
    // on a paused download resumes it.
    if (download.status === 'ready') {
        row.addEventListener('click', () => playOfflineRow(download));
    } else if (download.status === 'paused') {
        row.addEventListener('click', () => resumeOfflineRow(download));
    }
    return row;
}

/** Resume a paused download (keeps already-downloaded chunks). */
async function resumeOfflineRow(download) {
    try {
        const result = await startDownload(download);
        if (result.status === 'paused') {
            showToast('دانلود همچنان متوقف است — اتصال را بررسی کنید');
        } else if (result.status === 'ready') {
            showToast('دانلود کامل شد');
        }
    } catch (error) {
        if (!error || error.name === 'cancelled') return;
        showToast('ادامه دانلود ممکن نشد');
    }
}

/** Play a finished download straight from the stored Blob. */
async function playOfflineRow(download) {
    const url = await offlinePlayUrl(download.id);
    if (!url) {
        showToast('فایل آفلاین در دسترس نیست');
        return;
    }
    openVideoPlayer(
        {
            id: download.id,
            title: download.title,
            author: download.author,
            thumbnail: download.thumbnail,
            duration: download.duration
        },
        { offlineUrl: url }
    );
}

/** Update a rendered row in place from a fresh download record. */
function updateOfflineRow(row, entry) {
    const text = row.querySelector('.offline-download-status__text');
    if (text) text.textContent = progressLabel(entry);
    const bar = row.querySelector('.download-progress__bar');
    if (bar) applyProgressBar(bar, entry);

    // Finished while the row was showing a progress bar → rebuild section.
    if (entry.status === 'ready') {
        renderLibrary();
    }
}

/** Percent (when known) + bytes for the download status line. */
function progressLabel(entry) {
    const bytes = formatBytes(entry.completedBytes || entry.size || 0);
    const progress = entry.progress || 0;
    if (progress > 0 && progress < 1) {
        return `${toPersianDigits(Math.round(progress * 100))}٪ • ${bytes}`;
    }
    if (entry.status === 'paused' && progress <= 0) {
        return `متوقف • ${bytes}`;
    }
    return bytes;
}

function applyProgressBar(bar, entry) {
    if (!bar) return;
    const progress = entry.progress || 0;
    const knownTotal = progress > 0;
    bar.style.width = knownTotal ? `${Math.round(progress * 100)}%` : '';
    bar.classList.toggle('download-progress__bar--indeterminate', !knownTotal && (entry.size || 0) > 0);
}

function formatBytes(bytes) {
    if (!bytes) return '۰ کیلوبایت';
    const mb = bytes / 1048576;
    if (mb >= 100) return `${toPersianDigits(Math.round(mb))} مگابایت`;
    if (mb >= 1) return `${toPersianDigits(Number(mb.toFixed(1)))} مگابایت`;
    return `${toPersianDigits(Math.max(1, Math.round(mb * 1024)))} کیلوبایت`;
}

// ---------------------------------------------------------------------------
// Builders (shared with the localStorage sections)
// ---------------------------------------------------------------------------

/** Section header with icon, title, count and an optional trailing action. */
function buildSectionHeader(iconName, title, count, onAction) {
    const header = el('div', 'library-section-header');
    const heading = el('h2');
    heading.appendChild(icon(iconName));
    heading.appendChild(el('span', '', title));
    header.appendChild(heading);

    if (onAction && count > 0) {
        const action = el('button', 'clear-history-button');
        action.type = 'button';
        action.appendChild(icon('delete_all'));
        action.appendChild(el('span', '', 'پاک کردن همه'));
        action.addEventListener('click', onAction);
        header.appendChild(action);
    } else if (count > 0) {
        header.appendChild(el('span', 'section-count', `${toPersianDigits(count)} ویدیو`));
    }
    return header;
}

/** Horizontal compact video row used by the localStorage sections. */
function buildRow(video, menuItems) {
    const row = el('div', 'compact-video-card');
    row.dataset.videoId = video.id;

    const thumbnail = el('div', 'compact-video-card__thumbnail');
    const img = document.createElement('img');
    img.src = video.thumbnail || `/api/video/${video.id}/thumbnail`;
    img.alt = video.title || '';
    img.loading = 'lazy';
    img.onerror = () => {
        img.style.display = 'none';
    };
    thumbnail.appendChild(img);
    if (video.duration && video.duration > 0) {
        thumbnail.appendChild(
            el('span', 'compact-video-card__duration', formatDuration(video.duration))
        );
    }
    row.appendChild(thumbnail);

    const info = el('div', 'compact-video-card__info');
    info.appendChild(el('h4', 'compact-video-card__title', video.title || 'بدون عنوان'));
    info.appendChild(el('span', 'compact-video-card__meta', video.author || 'ناشناس'));
    row.appendChild(info);

    if (menuItems && menuItems.length) {
        const menu = el('button', 'compact-video-card__menu');
        menu.type = 'button';
        menu.setAttribute('aria-label', 'گزینه‌ها');
        menu.appendChild(icon('more_vert'));
        menu.addEventListener('click', (e) => {
            e.stopPropagation();
            showActionSheet({
                title: video.title || '',
                items: menuItems
            });
        });
        row.appendChild(menu);
    }

    row.addEventListener('click', () => openVideoPlayer(video));
    return row;
}

function emptyRow(text) {
    const row = el('div', 'empty-section');
    row.appendChild(el('p', '', text));
    return row;
}

function buildShowMoreButton(label, onClick) {
    const button = el('button', 'show-more-button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
}

export default { renderLibrary };
