// Video card component — used by the home feed and search results.
// Handles proxied thumbnails, duration/live badges, Persian metadata
// (views • time), and the ⋮ menu (watch later, share, not interested…).

import { formatViewCount, formatDuration } from '../utils/persianUtils.js';
import { showToast, el, icon } from '../utils/domUtils.js';
import { shareVideo } from '../utils/videoActions.js';
import { showActionSheet } from './actionSheet.js';
import { openVideoPlayer } from './videoPlayer.js';
import {
    addToWatchLater,
    markNotInterested
} from '../services/libraryService.js';
import {
    getDownload,
    startDownload,
    cancelDownload,
    removeDownload,
    offlinePlayUrl,
    offlineSupported
} from '../services/offlineService.js';

/**
 * Relative time from a yt-dlp upload_date ("20240901").
 * @param {string} uploadDate
 */
function uploadDateToText(uploadDate) {
    if (!uploadDate) return '';
    const m = String(uploadDate).match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return '';
    const date = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
    if (Number.isNaN(date.getTime())) return '';

    const diffMs = Date.now() - date.getTime();
    const day = Math.floor(diffMs / 86400000);
    const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
    const toFa = (n) =>
        String(n)
            .split('')
            .map((d) => (d >= '0' && d <= '9' ? PERSIAN_DIGITS[parseInt(d, 10)] : d))
            .join('');

    if (day < 1) return 'امروز';
    if (day < 7) return `${toFa(day)} روز پیش`;
    if (day < 30) return `${toFa(Math.floor(day / 7))} هفته پیش`;
    if (day < 365) return `${toFa(Math.floor(day / 30))} ماه پیش`;
    return `${toFa(Math.floor(day / 365))} سال پیش`;
}

/**
 * Create a video card element.
 * @param {object} videoData search/feed video ({id, title, thumbnail, …})
 * @param {(video: object) => void} onVideoClick
 * @returns {HTMLElement}
 */
export function createVideoCard(videoData, onVideoClick) {
    const card = el('div', 'video-card');
    card.dataset.videoId = videoData.id;

    // --- Thumbnail ---
    const thumbnail = el('div', 'video-card__thumbnail');
    const thumbnailImg = document.createElement('img');
    thumbnailImg.src =
        videoData.thumbnail || `/api/video/${videoData.id}/thumbnail`;
    thumbnailImg.alt = videoData.title || '';
    thumbnailImg.loading = 'lazy';
    thumbnailImg.decoding = 'async';
    thumbnailImg.onerror = () => {
        // Proxy might have failed for this video — hide the image and show
        // the surface background instead of a broken-image glyph.
        if (thumbnailImg.src.includes('/thumbnail')) {
            thumbnailImg.style.display = 'none';
        } else {
            thumbnailImg.src = `/api/video/${videoData.id}/thumbnail`;
        }
    };
    thumbnail.appendChild(thumbnailImg);

    if (videoData.isLive) {
        const liveBadge = el('div', 'video-card__live-badge', 'زنده');
        thumbnail.appendChild(liveBadge);
    } else if (videoData.duration && videoData.duration > 0) {
        const duration = el('div', 'video-card__duration', formatDuration(videoData.duration));
        thumbnail.appendChild(duration);
    }

    // --- Content ---
    const content = el('div', 'video-card__content');

    // Channel avatar
    const avatar = el('div', 'video-card__channel-avatar');
    const avatarImg = document.createElement('img');
    avatarImg.src = videoData.channelAvatar || '/assets/default-channel.svg';
    avatarImg.alt = videoData.author || '';
    avatarImg.loading = 'lazy';
    avatar.appendChild(avatarImg);
    content.appendChild(avatar);

    // Info
    const info = el('div', 'video-card__info');
    const title = el('h3', 'video-card__title', videoData.title || 'بدون عنوان');
    title.title = videoData.title || '';
    info.appendChild(title);

    const channelName = el('div', 'video-card__channel-name', videoData.author || 'ناشناس');
    info.appendChild(channelName);

    // Metadata: views • time (only the parts we actually have).
    const metadata = el('div', 'video-card__metadata');
    const parts = [];
    if (videoData.viewCount) {
        parts.push(formatViewCount(videoData.viewCount));
    }
    const timeText = videoData.publishedText || uploadDateToText(videoData.uploadDate);
    if (timeText) parts.push(timeText);

    if (parts.length > 0) {
        metadata.textContent = parts.join(' • ');
    } else {
        metadata.textContent = 'ویدیو';
    }
    info.appendChild(metadata);

    content.appendChild(info);

    // ⋮ menu
    const menu = el('div', 'video-card__menu');
    menu.appendChild(icon('more_vert'));
    menu.setAttribute('role', 'button');
    menu.setAttribute('aria-label', 'گزینه‌ها');
    menu.addEventListener('click', (e) => {
        e.stopPropagation();
        showVideoMenu(videoData, card);
    });
    content.appendChild(menu);

    card.appendChild(thumbnail);
    card.appendChild(content);

    card.addEventListener('click', () => {
        // R1: live cards are visibly nonplayable — explain before any stream
        // request so extraction is never attempted against a live source.
        if (videoData.isLive) {
            showToast('پخش زنده پشتیبانی نمی‌شود — پخش ویدیوهای ضبط‌شده فعال است');
            return;
        }
        if (typeof onVideoClick === 'function') {
            onVideoClick(videoData);
        }
    });

    return card;
}

/** Bottom-sheet menu for a video (YouTube's ⋮ sheet). */
async function showVideoMenu(videoData, card) {
    const download = offlineSupported() ? await getDownload(videoData.id) : null;

    // Offline entry (if any) sits at the top of the sheet, YouTube-style.
    const items = [];
    if (download && download.status === 'ready') {
        items.push({
            icon: 'offline_pin',
            label: 'پخش آفلاین',
            onClick: () => playOfflineVideo(videoData)
        });
        items.push({
            icon: 'delete',
            label: 'حذف دانلود',
            danger: true,
            onClick: () => {
                removeDownload(videoData.id);
                showToast('دانلود حذف شد');
            }
        });
    } else if (download && download.status === 'downloading') {
        items.push({
            icon: 'close',
            label: 'لغو دانلود',
            danger: true,
            onClick: () => {
                cancelDownload(videoData.id);
                showToast('دانلود لغو شد');
            }
        });
    } else if (download && download.status === 'paused') {
        items.push({
            icon: 'download',
            label: 'ادامه دانلود',
            onClick: () => startOfflineDownload(videoData)
        });
    } else if (offlineSupported()) {
        items.push({
            icon: 'download',
            label: 'دانلود برای تماشای آفلاین',
            onClick: () => startOfflineDownload(videoData)
        });
    }

    items.push(
        {
            icon: 'schedule',
            label: 'تماشا در آینده',
            onClick: () => {
                addToWatchLater(videoData);
                showToast('به «تماشا در آینده» اضافه شد');
            }
        },
        {
            icon: 'share',
            label: 'اشتراک‌گذاری',
            onClick: () => shareVideo(videoData)
        },
        {
            icon: 'block',
            label: 'بی‌علاقه',
            onClick: () => {
                markNotInterested(videoData.id);
                if (card && card.parentNode) card.style.display = 'none';
                showToast('دیگر پیشنهاد داده نمی‌شود');
            }
        }
    );

    showActionSheet({ title: videoData.title || '', items });
}

/** Begin (or resume) an offline download from the card menu. */
async function startOfflineDownload(videoData) {
    try {
        const result = await startDownload(videoData);
        if (result && result.status === 'paused') {
            showToast('دانلود متوقف شد — برای ادامه دوباره لمس کنید');
        } else if (result && result.status === 'ready') {
            showToast('دانلود کامل شد');
        } else {
            showToast('دانلود شروع شد — وضعیت را در کتابخانه ببینید');
        }
    } catch (error) {
        if (!error || error.name === 'cancelled') return;
        console.error('[offline] download failed:', error);
        showToast('دانلود ممکن نشد — دوباره تلاش کنید');
    }
}

/** Play a downloaded video (opens the watch page from its Blob). */
async function playOfflineVideo(videoData) {
    const url = await offlinePlayUrl(videoData.id);
    if (!url) {
        showToast('فایل آفلاین در دسترس نیست');
        return;
    }
    openVideoPlayer(videoData, { offlineUrl: url });
}

/**
 * Create a skeleton card for the loading state.
 * @returns {HTMLElement}
 */
export function createSkeletonCard() {
    const card = el('div', 'video-card video-card--skeleton');
    card.innerHTML = `
        <div class="video-card__thumbnail skeleton-animation"></div>
        <div class="video-card__content">
            <div class="video-card__channel-avatar skeleton-animation"></div>
            <div class="video-card__info">
                <div class="skeleton-line skeleton-animation" style="width: 92%"></div>
                <div class="skeleton-line skeleton-animation" style="width: 65%"></div>
                <div class="skeleton-line skeleton-animation" style="width: 40%"></div>
            </div>
        </div>
    `;
    return card;
}
