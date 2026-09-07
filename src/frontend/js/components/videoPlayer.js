// Video player (watch page) component — the shared implementation used by
// every page that opens a video. Besides playback it owns the per-video
// actions on the watch page:
//   - adds the video to watch history when opened
//   - like / dislike (like is persisted in localStorage)
//   - share / download
//   - channel subscribe / unsubscribe (localStorage, no account needed)
//
// Playback wiring: the player sets the stream source directly and relies on
// HTML media events — there is NO range-probe preflight that doubles normal
// playback traffic. When a real playback error occurs an explicit
// one-off diagnostic request (Range bytes=0-0) classifies the failure so
// the Persian message can distinguish offline / server busy / video
// unavailable / temporary YouTube block, and a retry button re-attaches the
// stream at the preserved playback position.

import { $, el, showToast } from '../utils/domUtils.js';
import { formatViewCount } from '../utils/persianUtils.js';
import { getStreamUrl, apiFetch, ensureSession, ApiError } from '../api.js';
import {
    showQualitySelector,
    getPreferredQuality,
    qualityLabel
} from './qualitySelector.js';
import { shareVideo } from '../utils/videoActions.js';
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
// The server closes upstream reads that stall (streamProxy); here we also
// watch for client-side stalls (no playback progress) and surface a friendly
// Persian error instead of infinite buffering.
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

/** Message templates for the classified failure kinds. */
const STREAM_MESSAGES = {
    offline: 'اتصال اینترنت برقرار نیست — اتصال را بررسی کنید',
    timeout: 'سرور دیر پاسخ داد — دوباره تلاش کنید',
    unauthorized: 'نشست شما معتبر نیست — دوباره وارد شوید',
    notFound: 'این ویدیو در دسترس نیست',
    rateLimited: 'سرور شلوغ است — چند لحظه بعد دوباره تلاش کنید',
    serverUnavailable: 'سرور در دسترس نیست — کمی بعد تلاش کنید',
    youtubeBlocked: 'یوتیوب موقتاً این درخواست را رد کرد — کمی بعد تلاش کنید',
    generic: 'پخش این ویدیو در حال حاضر ممکن نیست'
};

function showStreamError(msg) {
    const notice = $('#streamNotice');
    if (!notice) return;
    notice.hidden = false;
    notice.innerHTML =
        '<span class="material-icons-round">play_circle_outline</span>' +
        `<p>${msg}</p>`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stream-retry-button';
    button.textContent = 'تلاش مجدد';
    button.addEventListener('click', () => retryCurrentStream());
    notice.appendChild(button);
}

/** Explicit one-off diagnostic only AFTER a real playback error. */
async function classifyStreamFailure(streamUrl) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
    try {
        const response = await apiFetch(streamUrl, {
            headers: { Range: 'bytes=0-0' },
            timeoutMs: 10000
        });
        if (response.status === 401) return 'unauthorized';
        if (response.status === 403) return 'youtubeBlocked';
        if (response.status === 404) return 'notFound';
        if (response.status === 429) return 'rateLimited';
        if (response.status === 502 || response.status === 504) return 'serverUnavailable';
        if (response.status === 503) return 'rateLimited';
        if (response.ok || response.status === 206) return 'ok';
        return 'generic';
    } catch (error) {
        if (error instanceof ApiError) {
            if (error.kind === 'timeout') return 'timeout';
            if (error.kind === 'unauthorized') return 'unauthorized';
            if (error.kind === 'rateLimited') return 'rateLimited';
            if (error.kind === 'serverUnavailable') return 'serverUnavailable';
            if (error.kind === 'youtubeBlocked') return 'youtubeBlocked';
            if (error.kind === 'notFound') return 'notFound';
            if (error.kind === 'offline') return 'offline';
        }
        return 'offline';
    }
}

// --- retry state -------------------------------------------------------------
let retryStreamUrl = null;
let retryDesiredTime = 0;
let lastRetryAt = 0;

/** Re-attach the stream at the preserved position (bounded retry pacing). */
async function retryCurrentStream() {
    const videoPlayer = $('#videoPlayer');
    const notice = $('#streamNotice');
    if (!videoPlayer || !retryStreamUrl) return;
    // Guard against hammering the server right after a failure.
    if (Date.now() - lastRetryAt < 3000) return;
    lastRetryAt = Date.now();

    const desiredTime = retryDesiredTime || 0;
    if (notice) notice.hidden = true;
    videoPlayer.src = retryStreamUrl;
    const restorePosition = () => {
        if (desiredTime > 0 && Number.isFinite(desiredTime) && videoPlayer.readyState >= 1) {
            try {
                videoPlayer.currentTime = desiredTime;
            } catch {
                /* ignore seek clamp */
            }
        }
        videoPlayer.play().catch(() => {});
        startStallDetection();
    };
    videoPlayer.addEventListener('loadedmetadata', restorePosition, { once: true });
    videoPlayer.play().catch(() => {});
    startStallDetection();
}

function checkForStall() {
    const watchPage = $('#watchPage');
    const videoPlayer = $('#videoPlayer');
    if (!watchPage || watchPage.style.display === 'none') return;
    if (playingOffline || !videoPlayer) return;
    if (videoPlayer.paused || videoPlayer.ended) return;

    if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
        stopStallDetection();
        videoPlayer.pause();
        showStreamError('پخش ویدیو متوقف شده است — دوباره تلاش کنید');
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

    currentVideoData = videoData;
    playingOffline = !!options.offlineUrl;

    watchPage.style.display = 'block';
    mainContent.style.display = 'none';

    if (title) title.textContent = videoData.title || '';
    if (viewCount) viewCount.textContent = formatViewCount(videoData.viewCount);
    if (uploadDate) uploadDate.textContent = uploadDateText(videoData);
    if (channelName) channelName.textContent = videoData.author || 'کانال نامشخص';
    if (description) description.textContent = videoData.description || '';
    if (notice) notice.hidden = true;

    addToWatchHistory({
        id: videoData.id,
        title: videoData.title,
        thumbnail: videoData.thumbnail,
        author: videoData.author,
        duration: videoData.duration
    });

    setupChannelSection(videoData);
    setupActionButtons(videoData);
    setupQualityButton();

    if (!videoPlayer) return;

    // Media events drive playback success/failure (no preflight probe).
    videoPlayer.onerror = () => {
        if (watchPage.style.display === 'none') return;
        handleStreamError();
    };
    videoPlayer.onplaying = () => {
        if (notice) notice.hidden = true;
        lastProgressAt = Date.now();
    };

    if (options.offlineUrl) {
        retryStreamUrl = null;
        videoPlayer.src = options.offlineUrl;
        videoPlayer.play().catch(() => {});
        refreshDownloadButton();
        return;
    }

    const streamUrl = getStreamUrl(videoData.id, getPreferredQuality());
    retryStreamUrl = streamUrl;
    retryDesiredTime = 0;
    videoPlayer.src = streamUrl;
    videoPlayer.play().catch(() => {});
    startStallDetection();
    refreshDownloadButton();
}

/** Called from the media error event; classifies and shows a retry option. */
async function handleStreamError() {
    const videoPlayer = $('#videoPlayer');
    const watchPage = $('#watchPage');
    if (!videoPlayer || !watchPage || watchPage.style.display === 'none') return;
    stopStallDetection();

    // Preserve the position for the retry affordance.
    const currentTime = videoPlayer.currentTime;
    if (Number.isFinite(currentTime) && currentTime > 0) {
        retryDesiredTime = currentTime;
    }

    const streamUrl = retryStreamUrl;
    if (!streamUrl) {
        showStreamError(STREAM_MESSAGES.generic);
        return;
    }

    const kind = await classifyStreamFailure(streamUrl);
    if (kind === 'unauthorized') {
        void ensureSession().then(() => {
            retryCurrentStream();
        });
        showStreamError(STREAM_MESSAGES.unauthorized);
        return;
    }
    if (kind === 'ok') {
        // The server is healthy; a transient drop — offer an automatic
        // single retry at the preserved position.
        retryCurrentStream();
        return;
    }
    showStreamError(STREAM_MESSAGES[kind] || STREAM_MESSAGES.generic);
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
    retryStreamUrl = null;
    retryDesiredTime = 0;
    stopStallDetection();
    if (videoPlayer) videoPlayer.ontimeupdate = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateQualityButtonLabel(button) {
    if (!button) return;
    const label = button.querySelector('span:last-child');
    if (label) label.textContent = qualityLabel(getPreferredQuality());
}

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
            retryStreamUrl = newStreamUrl;
            retryDesiredTime = videoPlayer.currentTime || 0;
            videoPlayer.src = newStreamUrl;
            videoPlayer.play().catch(() => {});

            lastProgressAt = Date.now();
            startStallDetection();
        });
    };
}

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

function setButton(button, iconName, label, active) {
    if (!button) return;
    button.innerHTML = '';
    button.appendChild(el('span', 'material-icons-round', iconName));
    button.appendChild(el('span', '', label));
    button.classList.toggle('action-button--active', !!active);
    button.classList.toggle('action-button--disliked', !active && iconName === 'thumb_down');
}

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
    if (subscriberCount) subscriberCount.style.display = 'none';

    currentSubscribed = isSubscribed(currentChannelId);

    const applySubscribeState = () => {
        if (!subscribeButton) return;
        subscribeButton.classList.toggle('subscribe-button--subscribed', currentSubscribed);
        subscribeButton.textContent = currentSubscribed ? 'عضو شدید' : 'عضویت';
    };
    applySubscribeState();

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
        if (!isCurrent(videoData.id)) return;
        const after = await getDownload(videoData.id);
        if (after && after.status === 'ready') {
            showToast('دانلود کامل شد');
        } else if (after && after.status === 'paused') {
            showToast('دانلود متوقف شد — برای ادامه دوباره لمس کنید');
        } else {
            showToast('دانلود شروع شد — وضعیت را در کتابخانه ببینید');
        }
    } catch (error) {
        if (!error || error.name === 'cancelled') return;
        console.error('[offline] download failed:', error);
        showToast('دانلود ممکن نشد — دوباره تلاش کنید');
    }
    refreshDownloadButton();
}

function isCurrent(id) {
    return currentVideoData && currentVideoData.id === id;
}

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
    retryStreamUrl = null;
    if (notice) notice.hidden = true;
    videoPlayer.src = url;
    videoPlayer.play().catch(() => {
        playingOffline = false;
    });
    if (watchPage) watchPage.style.display = 'block';
    refreshDownloadButton();
}

async function refreshDownloadButton() {
    const watchPage = $('#watchPage');
    const downloadButton = $('#downloadButton');
    if (!downloadButton || !watchPage || watchPage.style.display === 'none') return;
    if (!currentVideoData) return;

    const entry = offlineSupported() ? await getDownload(currentVideoData.id) : null;
    if (!currentVideoData) return;

    if (entry && entry.status === 'ready') {
        setButton(downloadButton, 'offline_pin', 'پخش آفلاین', false);
    } else if (entry && entry.status === 'downloading') {
        setButton(downloadButton, 'download', 'در حال دانلود…', false);
    } else if (entry && entry.status === 'paused') {
        setButton(downloadButton, 'download', 'ادامه دانلود', false);
    } else {
        setButton(downloadButton, 'download', 'دانلود', false);
    }
}

function bindOfflineEvents() {
    if (offlineEventsBound) return;
    offlineEventsBound = true;

    document.addEventListener('offline:changed', (event) => {
        if (!currentVideoData || !event.detail) return;
        if (currentVideoData.id === event.detail.id) refreshDownloadButton();
    });
    document.addEventListener('offline:progress', (event) => {
        if (!currentVideoData || !event.detail) return;
        if (currentVideoData.id === event.detail.id) refreshDownloadButton();
    });
}
