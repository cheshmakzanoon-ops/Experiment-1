// Video player (watch page) component — the shared implementation used by
// every page that opens a video. Besides playback it owns the per-video
// actions on the watch page:
//   - adds the video to watch history when opened
//   - like / dislike (like is persisted in localStorage)
//   - share / download
//   - channel subscribe / unsubscribe (localStorage, no account needed)

import { $, el, showToast } from '../utils/domUtils.js';
import { formatViewCount } from '../utils/persianUtils.js';
import { getStreamUrl, apiFetch } from '../api.js';
import {
    showQualitySelector,
    getPreferredQuality,
    qualityLabel
} from './qualitySelector.js';
import { shareVideo } from './videoCard.js';
import {
    addToWatchHistory,
    channelIdFor,
    subscribeToChannel,
    unsubscribeFromChannel,
    isSubscribed,
    likeVideo,
    unlikeVideo,
    isVideoLiked
} from '../services/libraryService.js';
import {
    getDownload,
    startDownload,
    cancelDownload,
    offlinePlayUrl,
    offlineSupported
} from '../services/offlineService.js';

/** Current video + channel shown on the watch page (reset per open). */
let currentChannelId = '';
let currentSubscribed = false;
let currentLiked = false;
let currentDisliked = false;

/** The video that is currently open on the watch page (for offline UI). */
let currentVideoData = null;
/** True while playing from a downloaded Blob (no probe / no stream URL). */
let playingOffline = false;
let offlineEventsBound = false;

// --- stall detection state ---------------------------------------------------
// The server closes upstream reads that stall >30s (streamProxy.ts); here we
// additionally watch for client-side stalls (no playback progress for 15s)
// and surface a friendly Persian error instead of infinite buffering.
const STALL_CHECK_INTERVAL_MS = 5000;
const STALL_TIMEOUT_MS = 15000;
let stallTimerId = null;
let lastProgressAt = 0;

function stopStallDetection() {
    if (stallTimerId) {
        clearInterval(stallTimerId);
        stallTimerId = null;
    }
}

function showStreamError(msg) {
    const notice = $('#streamNotice');
    if (!notice) return;
    notice.hidden = false;
    notice.innerHTML =
        '<span class="material-icons-round">play_circle_outline</span>' +
        `<p>${msg}</p>`;
}

function checkForStall() {
    const watchPage = $('#watchPage');
    const videoPlayer = $('#videoPlayer');
    // Only meaningful for live (online) playback on the visible watch page.
    if (!watchPage || watchPage.style.display === 'none') return;
    if (playingOffline || !videoPlayer) return;
    if (videoPlayer.paused || videoPlayer.ended) return;

    if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
        console.warn('[player] Video stalled for 15s, showing error');
        stopStallDetection();
        videoPlayer.pause();
        showStreamError('پخش ویدیو متوقف شده است. لطفاً دوباره تلاش کنید.');
    }
}

function startStallDetection() {
    stopStallDetection();
    lastProgressAt = Date.now();
    const videoPlayer = $('#videoPlayer');
    if (videoPlayer) {
        videoPlayer.ontimeupdate = () => {
            lastProgressAt = Date.now();
        };
    }
    stallTimerId = setInterval(checkForStall, STALL_CHECK_INTERVAL_MS);
}

/**
 * Open the watch page for a video-like object ({ id, title, ... }).
 *
 * Metadata renders immediately; playback is wired after a successful probe
 * of the /api/stream proxy (200/206 for a Range request). Failures — a
 * 404/429/501 or a mid-playback error — show a friendly Persian notice
 * instead of a dead <video>.
 */
export async function openVideoPlayer(videoData, options = {}) {
    const watchPage = $('#watchPage');
    const mainContent = $('#mainContent');
    if (!watchPage || !mainContent) return;

    const videoPlayer = $('#videoPlayer');
    const title = $('#videoTitle');
    const viewCount = $('#videoViewCount');
    const uploadDate = $('#videoUploadDate');
    const channelName = $('#channelName');
    const description = $('#videoDescription');
    const notice = $('#streamNotice');

    // Remember what is open so the download button / events can react.
    currentVideoData = videoData;
    playingOffline = !!options.offlineUrl;

    // Show the page + metadata first so it feels instant on slow connections.
    watchPage.style.display = 'block';
    mainContent.style.display = 'none';

    if (title) title.textContent = videoData.title || '';
    if (viewCount) viewCount.textContent = formatViewCount(videoData.viewCount);
    if (uploadDate) uploadDate.textContent = uploadDateText(videoData);
    if (channelName) channelName.textContent = videoData.author || 'کانال نامشخص';
    if (description) description.textContent = videoData.description || '';
    if (notice) notice.hidden = true;

    // --- watch history ---
    addToWatchHistory({
        id: videoData.id,
        title: videoData.title,
        thumbnail: videoData.thumbnail,
        author: videoData.author,
        duration: videoData.duration
    });

    // --- channel + subscribe button ---
    setupChannelSection(videoData);

    // --- action buttons (like / dislike / share / download) ---
    setupActionButtons(videoData);

    // --- quality selector (144–480p) ---
    setupQualityButton();

    // Default to the user's preferred quality; the API key travels as a
    // query param because <video> cannot send request headers.
    const streamUrl = getStreamUrl(videoData.id, getPreferredQuality());

    if (!videoPlayer) return;

    // Surface real playback failures (e.g. the stream dying mid-load), but
    // stay quiet when the watch page is hidden (e.g. after closing).
    videoPlayer.onerror = () => {
        if (watchPage.style.display === 'none') return;
        showStreamError('پخش این ویدیو در حال حاضر ممکن نیست. لطفاً کمی بعد دوباره تلاش کنید.');
    };

    // Reset per-open state so a previously failed stream doesn't linger.
    videoPlayer.onplaying = () => {
        if (notice) notice.hidden = true;
        lastProgressAt = Date.now();
    };

    // Play the local copy directly — no probe, no network needed.
    if (options.offlineUrl) {
        videoPlayer.src = options.offlineUrl;
        videoPlayer.play().catch((err) => {
            console.log('Autoplay prevented:', err);
        });
        refreshDownloadButton();
        return;
    }

    // Lightweight preflight: the proxy answers 2xx (200/206) for range
    // requests. Any other status (404, 429, 501, …) keeps the player clean
    // and shows a friendly Persian message instead.
    let playable = false;
    try {
        const probe = await apiFetch(streamUrl, {
            headers: { Range: 'bytes=0-0' }
        });
        playable = probe.status === 200 || probe.status === 206;
    } catch (error) {
        console.log('Stream probe failed:', error);
        playable = false;
    }

    if (playable) {
        videoPlayer.src = streamUrl;
        videoPlayer.play().catch((err) => {
            console.log('Autoplay prevented:', err);
        });
        startStallDetection();
    } else {
        showStreamError('پخش این ویدیو در حال حاضر ممکن نیست. لطفاً کمی بعد دوباره تلاش کنید.');
    }

    refreshDownloadButton();
}

/** Close the watch page and stop playback. */
export function closeVideoPlayer() {
    const watchPage = $('#watchPage');
    const mainContent = $('#mainContent');
    const videoPlayer = $('#videoPlayer');
    const notice = $('#streamNotice');
    if (watchPage) watchPage.style.display = 'none';
    if (mainContent) mainContent.style.display = 'block';
    if (videoPlayer) {
        videoPlayer.pause();
        videoPlayer.removeAttribute('src');
        videoPlayer.load();
    }
    if (notice) notice.hidden = true;
    currentVideoData = null;
    playingOffline = false;
    stopStallDetection();
    if (videoPlayer) videoPlayer.ontimeupdate = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Show the current preferred quality on the gear button label. */
function updateQualityButtonLabel(button) {
    if (!button) return;
    const label = button.querySelector('span:last-child');
    if (label) label.textContent = qualityLabel(getPreferredQuality());
}

/**
 * Wire the watch-page quality button: opens the picker, saves the choice
 * and reloads the current video at the new quality.
 */
function setupQualityButton() {
    const qualityButton = $('#qualityButton');
    const videoPlayer = $('#videoPlayer');
    if (!qualityButton || !videoPlayer) return;

    updateQualityButtonLabel(qualityButton);

    qualityButton.onclick = () => {
        if (!currentVideoData) return;
        showQualitySelector(getPreferredQuality(), (newQuality) => {
            updateQualityButtonLabel(qualityButton);
            if (!currentVideoData) return;

            playingOffline = false;
            const notice = $('#streamNotice');
            if (notice) notice.hidden = true;

            const newStreamUrl = getStreamUrl(currentVideoData.id, newQuality);
            videoPlayer.src = newStreamUrl;
            videoPlayer.play().catch(() => {});

            lastProgressAt = Date.now();
            startStallDetection();
        });
    };
}

/** Best human text for the "when" part of the metadata row. */
function uploadDateText(videoData) {
    if (videoData.publishedText) return videoData.publishedText;
    const raw = videoData.uploadDate || '';
    const m = String(raw).match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) {
        const date = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
        if (!Number.isNaN(date.getTime())) {
            const diff = Date.now() - date.getTime();
            const days = Math.floor(diff / 86400000);
            const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
            const toFa = (n) =>
                String(n)
                    .split('')
                    .map((d) => (d >= '0' && d <= '9' ? PERSIAN_DIGITS[parseInt(d, 10)] : d))
                    .join('');
            if (days < 1) return 'امروز';
            if (days < 7) return `${toFa(days)} روز پیش`;
            if (days < 30) return `${toFa(Math.floor(days / 7))} هفته پیش`;
            if (days < 365) return `${toFa(Math.floor(days / 30))} ماه پیش`;
            return `${toFa(Math.floor(days / 365))} سال پیش`;
        }
    }
    return raw;
}

/** Set the icon+label of a watch-page action button. */
function setButton(button, iconName, label, active) {
    if (!button) return;
    button.innerHTML = '';
    button.appendChild(el('span', 'material-icons-round', iconName));
    button.appendChild(el('span', '', label));
    button.classList.toggle('action-button--active', !!active);
    button.classList.toggle('action-button--disliked', !active && iconName === 'thumb_down');
}

/** Subscribe/unsubscribe area under the video. */
function setupChannelSection(videoData) {
    const subscribeButton = $('#subscribeButton');
    const subscriberCount = $('#subscriberCount');

    const author = (videoData.author || '').trim();
    currentChannelId = videoData.authorId || (author ? channelIdFor(author) : '');

    if (!author || !currentChannelId) {
        if (subscribeButton) subscribeButton.style.display = 'none';
        if (subscriberCount) subscriberCount.style.display = 'none';
        return;
    }
    if (subscribeButton) subscribeButton.style.display = '';
    if (subscriberCount) subscriberCount.style.display = 'none'; // unknown count

    currentSubscribed = isSubscribed(currentChannelId);

    const applySubscribeState = () => {
        if (!subscribeButton) return;
        subscribeButton.classList.toggle('subscribe-button--subscribed', currentSubscribed);
        subscribeButton.textContent = currentSubscribed ? 'عضو شدید' : 'عضویت';
    };
    applySubscribeState();

    // Replace listeners each open so the callback captures this video.
    subscribeButton.onclick = () => {
        if (currentSubscribed) {
            unsubscribeFromChannel(currentChannelId);
            currentSubscribed = false;
            showToast('از کانال خارج شدید');
        } else {
            subscribeToChannel({ name: author, id: currentChannelId });
            currentSubscribed = true;
            showToast('در کانال عضو شدید');
        }
        applySubscribeState();
    };
}

/** Like / dislike / share / download actions under the video. */
function setupActionButtons(videoData) {
    const likeButton = $('#likeButton');
    const dislikeButton = $('#dislikeButton');
    const shareButton = $('#shareButton');
    const downloadButton = $('#downloadButton');

    currentLiked = isVideoLiked(videoData.id);
    currentDisliked = false;

    const applyLikeState = () => {
        setButton(likeButton, 'thumb_up', currentLiked ? 'پسندیدم' : 'پسندیدن', currentLiked);
        setButton(dislikeButton, 'thumb_down', currentDisliked ? 'نپسندیدم' : 'نپسندیدن', false);
    };
    applyLikeState();

    likeButton.onclick = () => {
        if (currentLiked) {
            unlikeVideo(videoData.id);
            currentLiked = false;
        } else {
            likeVideo(videoData);
            currentLiked = true;
            currentDisliked = false;
        }
        applyLikeState();
    };

    dislikeButton.onclick = () => {
        if (currentLiked) {
            unlikeVideo(videoData.id);
            currentLiked = false;
        }
        currentDisliked = !currentDisliked;
        applyLikeState();
    };

    shareButton.onclick = () => shareVideo(videoData);
    downloadButton.onclick = () => handleDownloadClick(videoData);

    bindOfflineEvents();
    refreshDownloadButton();
}

// --- offline download button (watch page) ---------------------------------

/**
 * The «دانلود» button doubles as the offline control for the current video:
 *   idle        → start the download
 *   downloading → cancel it
 *   ready       → play the local copy
 */
async function handleDownloadClick(videoData) {
    const entry = offlineSupported() ? await getDownload(videoData.id) : null;

    if (entry && entry.status === 'ready') {
        await playOfflineCopy(videoData);
        return;
    }
    if (entry && entry.status === 'downloading') {
        await cancelDownload(videoData.id);
        showToast('دانلود لغو شد');
        refreshDownloadButton();
        return;
    }
    if (!offlineSupported()) {
        showToast('این مرورگر دانلود آفلاین را پشتیبانی نمی‌کند');
        return;
    }

    try {
        await startDownload(videoData);
        showToast('دانلود شروع شد — وضعیت را در کتابخانه ببینید');
    } catch (error) {
        if (!error || error.name === 'cancelled') return;
        console.error('[offline] download failed:', error);
        showToast('دانلود ممکن نشد — دوباره تلاش کنید');
    }
    refreshDownloadButton();
}

/** Switch the current player to the downloaded Blob (no network needed). */
async function playOfflineCopy(videoData) {
    const videoPlayer = $('#videoPlayer');
    const notice = $('#streamNotice');
    const watchPage = $('#watchPage');
    if (!videoPlayer || !videoData) return;

    const url = await offlinePlayUrl(videoData.id);
    if (!url) {
        showToast('فایل آفلاین در دسترس نیست');
        refreshDownloadButton();
        return;
    }

    playingOffline = true;
    if (notice) notice.hidden = true;
    videoPlayer.src = url;
    videoPlayer.play().catch((err) => {
        console.log('Offline playback prevented:', err);
        playingOffline = false;
    });
    // Keep the watch page visible in case it was hidden behind the sheet.
    if (watchPage) watchPage.style.display = 'block';
    refreshDownloadButton();
}

/** Sync the download button label with the offline state of the video. */
async function refreshDownloadButton() {
    const watchPage = $('#watchPage');
    const downloadButton = $('#downloadButton');
    if (!downloadButton || !watchPage || watchPage.style.display === 'none') return;
    if (!currentVideoData) return;

    const entry = offlineSupported() ? await getDownload(currentVideoData.id) : null;
    if (!currentVideoData) return; // closed while awaiting

    if (entry && entry.status === 'ready') {
        setButton(downloadButton, 'offline_pin', 'پخش آفلاین', false);
    } else if (entry && entry.status === 'downloading') {
        setButton(downloadButton, 'download', 'در حال دانلود…', false);
    } else {
        setButton(downloadButton, 'download', 'دانلود', false);
    }
}

/** React to offline events while the watch page is open. */
function bindOfflineEvents() {
    if (offlineEventsBound) return;
    offlineEventsBound = true;

    document.addEventListener('offline:changed', (event) => {
        const watchPage = $('#watchPage');
        if (!watchPage || watchPage.style.display === 'none') return;
        if (!currentVideoData || !event.detail) return;
        if (currentVideoData.id === event.detail.id) refreshDownloadButton();
    });
    document.addEventListener('offline:progress', (event) => {
        const watchPage = $('#watchPage');
        if (!watchPage || watchPage.style.display === 'none') return;
        if (!currentVideoData || !event.detail) return;
        if (currentVideoData.id === event.detail.id) refreshDownloadButton();
    });
}
