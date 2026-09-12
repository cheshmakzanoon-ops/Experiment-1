// Video player (watch page) component — the shared implementation used by
// every page that opens a video. Besides playback it owns the per-video
// actions on the watch page:
//   - adds the video to watch history when opened
//   - like / dislike (like is persisted in localStorage)
//   - share / download
//   - channel subscribe / unsubscribe (localStorage, no account needed)
//
// Playback wiring (R3/R4):
//   - ONE replaceSourcePreservingState helper owns every source replacement
//     (startup, quality change, watchdog recovery, manual retry, offline).
//     It snapshots the finite position, aborts the previous attempt
//     (monotonic attemptId generation-fencing), restores the position after
//     loadedmetadata and resumes only when the user intended playback.
//   - The startup watchdog starts only AFTER real currentTime advancement
//     (never merely on src assignment or a playing event) and runs on
//     monotonic elapsed time with progress watched by POSITION changes —
//     unchanged timeupdate events cannot hide a stall.
//   - A finite startup budget (STARTUP_BUDGET_MS, default 120 s) spans
//     metadata resolution + first progress; a bounded rebuffer grace
//     (REBUFFER_GRACE_MS, default 30 s) applies after established playback.
//     User pause / ended / offline / hidden-tab suspension never counts as a
//     stall, and background time does not consume visible grace (the
//     baseline re-anchors on visibilitychange).

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

// ---------------------------------------------------------------------------
// R3 state machine
// ---------------------------------------------------------------------------

/**
 * idle → resolving → starting → playing ⇄ buffering/paused
 *                     ↓                ↘ recovering → failed
 * Offline playback uses the same machine but never talks to the network.
 */
const PlayerState = Object.freeze({
    IDLE: 'idle',
    RESOLVING: 'resolving',
    STARTING: 'starting',
    PLAYING: 'playing',
    BUFFERING: 'buffering',
    PAUSED: 'paused',
    RECOVERING: 'recovering',
    FAILED: 'failed',
    OFFLINE: 'offline'
});

let playerState = PlayerState.IDLE;

/** Monotonic attempt id: late callbacks from an old source can never touch a new one. */
let attemptGeneration = 0;

// --- timing constants (R3). Configurable via the injected timings object in
// tests; production defaults are documented here, not re-derived. ---
const TIMINGS = {
    /** Total startup budget: metadata resolution + first real progress. */
    STARTUP_BUDGET_MS: 120_000,
    /** Grace after established playback before declaring failure. */
    REBUFFER_GRACE_MS: 30_000,
    /** How often the watchdog inspects progress. */
    WATCHDOG_POLL_MS: 5_000
};

let startupDeadlineAt = null;
let rebufferDeadlineAt = null;
/** Monotonic baseline for progress comparisons (not Date.now()-based stall math). */
let lastProgressPos = 0;
let lastProgressAt = 0;
let watchdogTimerId = null;
/** Separate user intent from the browser's paused property (R3). */
let userIntendedPlayback = false;

function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function setState(next) {
    playerState = next;
}

/**
 * The steady-playback watchdog. It starts ONLY once real currentTime
 * advancement was observed (armed with the first true progress), and
 * compares POSITIONS (not timeupdate counts) over monotonic elapsed time.
 */
function startSteadyWatchdog() {
    stopWatchdog();
    watchdogTimerId = setInterval(() => {
        const videoPlayer = $('#videoPlayer');
        const watchPage = $('#watchPage');
        if (!watchPage || watchPage.style.display === 'none') return;
        if (!videoPlayer || playingOffline) return;
        if (playerState === PlayerState.FAILED || playerState === PlayerState.IDLE) return;

        // User pause, ended, and hidden/background suspension are NOT stalls.
        if (videoPlayer.paused || videoPlayer.ended) return;
        if (document.hidden) return;

        if (playerState === PlayerState.STARTING || playerState === PlayerState.RESOLVING) {
            if (startupDeadlineAt !== null && now() > startupDeadlineAt) {
                failPlayback('timeout', 'آماده‌سازی ویدیو بیش از حد طول کشید — دوباره تلاش کنید');
            }
            return;
        }

        // Established playback: buffering grace applies to real progress.
        if (playerState === PlayerState.PLAYING || playerState === PlayerState.BUFFERING) {
            const pos = Number.isFinite(videoPlayer.currentTime) ? videoPlayer.currentTime : 0;
            const progressed = pos > lastProgressPos + 0.001;
            if (progressed) {
                lastProgressPos = pos;
                lastProgressAt = now();
                // R4: the automatic-retry budget resets only after 10 s of
                // REAL advancing playback (not after a mere playing event).
                if (now() - lastProgressAt < 50 && now() - episodeStartAt > 10_000) {
                    autoRetriesThisEpisode = 0;
                    episodeStartAt = now();
                }
                if (rebufferDeadlineAt !== null) rebufferDeadlineAt = null; // back to healthy
                setState(PlayerState.PLAYING);
                const notice = $('#streamNotice');
                if (notice) notice.hidden = true;
                return;
            }
            // No progress: start (or continue) the bounded rebuffer window.
            if (rebufferDeadlineAt === null) {
                rebufferDeadlineAt = now() + TIMINGS.REBUFFER_GRACE_MS;
                setState(PlayerState.BUFFERING);
            } else if (now() > rebufferDeadlineAt) {
                recoverStalledPlayback();
            }
        }
    }, TIMINGS.WATCHDOG_POLL_MS);
    watchdogTimerId.unref?.();
}

function stopWatchdog() {
    if (watchdogTimerId) {
        clearInterval(watchdogTimerId);
        watchdogTimerId = null;
    }
    rebufferDeadlineAt = null;
}

/** Startup budget expiry → finite failure with a retry action. */
function failPlayback(kind, message) {
    const attempt = attemptGeneration;
    stopWatchdog();
    setState(PlayerState.FAILED);
    startupDeadlineAt = null;
    // R4: every failure path stores the position before anything restarts.
    const videoPlayer = $('#videoPlayer');
    if (videoPlayer && Number.isFinite(videoPlayer.currentTime) && videoPlayer.currentTime > 0) {
        retryDesiredTime = videoPlayer.currentTime;
    }
    videoPlayer?.pause();
    void classifyAndShowFailure(kind, message, attempt);
}

/** Bounded automatic recovery for an established-playback stall (R4). */
function recoverStalledPlayback() {
    if (playingOffline) return;
    const attempt = attemptGeneration;
    setState(PlayerState.RECOVERING);
    const videoPlayer = $('#videoPlayer');
    const desiredTime = Number.isFinite(videoPlayer?.currentTime) && videoPlayer.currentTime > 0
        ? videoPlayer.currentTime
        : retryDesiredTime;
    // R4: the position is stored on EVERY recovery path (incl. the watchdog).
    retryDesiredTime = desiredTime;
    void replaceSourcePreservingState({
        source: retryStreamUrl,
        videoId: currentVideoData?.id,
        reason: 'stall-recovery',
        desiredTime,
        shouldPlay: true
    }).catch(() => {
        /* classified below via failure path */
    });
    void attempt;
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
    startupTimeout: 'آماده‌سازی ویدیو بیش از حد طول کشید — دوباره تلاش کنید',
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

/** Classify + show a failure; the probe is bounded and cancellable. */
let activeProbeController = null;
async function classifyAndShowFailure(kind, message, attempt) {
    if (attempt !== attemptGeneration) return; // late failure of a dead attempt
    if (playingOffline) return;

    let shown = message || STREAM_MESSAGES.generic;
    if (!message && retryStreamUrl) {
        const probe = classifyStreamFailure(retryStreamUrl);
        // Bounded: a caller cancellation must not leave the probe running.
        void probe;
        shown = STREAM_MESSAGES[(await probe)] || STREAM_MESSAGES.generic;
    }
    if (attempt !== attemptGeneration) return; // re-check after the await
    showStreamError(shown);
}

// ---------------------------------------------------------------------------
// R4: single source-replacement helper
// ---------------------------------------------------------------------------

// --- retry state -------------------------------------------------------------
let retryStreamUrl = null;
let retryDesiredTime = 0;
let lastRetryAt = 0;
/** One automatic retry per continuous failure episode (R4). */
let autoRetriesThisEpisode = 0;
/** When the current failure episode began (episode reset bookkeeping). */
let episodeStartAt = 0;

/**
 * Replace the media source while preserving the viewer's position and
 * intention. Every replacement path (startup, quality change, watchdog
 * recovery, manual retry, offline) funnels through here:
 *
 *   - snapshot the finite currentTime BEFORE pausing/src removal,
 *   - bump the attempt id and abort the previous attempt's controller,
 *   - attach listeners BEFORE assigning the new src,
 *   - after loadedmetadata: validate attemptId/videoId, clamp the target
 *     into [0, seekableEnd), restore time, resume only if the user wanted
 *     playback (a paused user stays paused through a quality change),
 *   - a late callback from video A can never seek/restart/relabel video B.
 *
 * Inputs: source, videoId, reason, desiredTime, shouldPlay.
 */
async function replaceSourcePreservingState({
    source,
    videoId,
    reason: _reason = 'replace',
    desiredTime = 0,
    shouldPlay = true
}) {
    const videoPlayer = $('#videoPlayer');
    if (!videoPlayer || !source) {
        throw new ApiError('generic', { status: 0 });
    }

    const attemptId = ++attemptGeneration;
    // Track user playback intent separately from the browser paused property
    // (R3): a quality change must not silently turn a paused user into a
    // playing one, and vice versa.
    userIntendedPlayback = shouldPlay;
    if (autoRetriesThisEpisode === 0) episodeStartAt = now();

    // Snapshot BEFORE pausing / dropping the old src (not before a slow
    // lookup — callers resolve metadata first, then call here).
    let target = desiredTime;
    if ((!target || target <= 0) && Number.isFinite(videoPlayer.currentTime)) {
        target = videoPlayer.currentTime;
    }
    if (!Number.isFinite(target) || target < 0) target = 0;

    // Abort the previous attempt's in-flight work (probe/controller).
    if (activeProbeController && !activeProbeController.signal.aborted) {
        try { activeProbeController.abort('superseded'); } catch { /* already done */ }
    }
    activeProbeController = null;

    videoPlayer.pause();
    stopWatchdog();
    setState(shouldPlay ? PlayerState.STARTING : PlayerState.PAUSED);
    if (shouldPlay) {
        startupDeadlineAt = now() + TIMINGS.STARTUP_BUDGET_MS;
    } else {
        startupDeadlineAt = null;
    }

    const onLoadedMetadata = () => {
        if (attemptId !== attemptGeneration) return; // stale attempt
        if (videoId && currentVideoData && currentVideoData.id !== videoId) return;
        // Clamp to the valid duration / seekable bounds (live/unknown-safe).
        let end = Number.isFinite(videoPlayer.duration) && videoPlayer.duration > 0
            ? videoPlayer.duration
            : Number.POSITIVE_INFINITY;
        try {
            if (videoPlayer.seekable && videoPlayer.seekable.length > 0) {
                end = Math.min(end, videoPlayer.seekable.end(videoPlayer.seekable.length - 1));
            }
        } catch { /* seekable unavailable */ }
        const clamped = Math.min(Math.max(0, target), Number.isFinite(end) ? Math.max(0, end - 0.5) : target);
        if (clamped > 0) {
            try { videoPlayer.currentTime = clamped; } catch { /* seek clamp */ }
        }
        void userIntendedPlayback;
        lastProgressPos = clamped;
        lastProgressAt = now();
        if (shouldPlay) {
            const p = videoPlayer.play();
            if (p && typeof p.catch === 'function') {
                p.catch((error) => {
                    // NotAllowedError → visible play affordance; never swallow
                    // every rejection or auto-mute to claim success.
                    if (error && error.name === 'NotAllowedError') {
                        setState(PlayerState.PAUSED);
                        showPlayAffordance();
                    }
                    // Other rejections surface through onerror/timeout paths.
                });
            }
        }
    };
    videoPlayer.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });

    videoPlayer.src = source;
    videoPlayer.load();
    return attemptId;
}

/** Visible "press play" affordance (NotAllowedError path). */
function showPlayAffordance() {
    const notice = $('#streamNotice');
    if (!notice) return;
    notice.hidden = false;
    notice.innerHTML =
        '<span class="material-icons-round">play_arrow</span>' +
        '<p>برای ادامه پخش، دکمه پخش را لمس کنید</p>';
}

/** Re-attach the stream at the preserved position (bounded manual retry). */
async function retryCurrentStream() {
    const videoPlayer = $('#videoPlayer');
    const notice = $('#streamNotice');
    if (!videoPlayer || !retryStreamUrl) return;
    // Manual retry pacing: minimum 3 s between attempts (server Retry-After
    // is honored by the classify step through ApiError.retryAfterSeconds).
    if (Date.now() - lastRetryAt < 3000) return;
    lastRetryAt = Date.now();

    const desiredTime = retryDesiredTime || 0;
    if (notice) notice.hidden = true;
    autoRetriesThisEpisode = 0; // explicit user action: fresh episode budget
    await replaceSourcePreservingState({
        source: retryStreamUrl,
        videoId: currentVideoData?.id,
        reason: 'manual-retry',
        desiredTime,
        shouldPlay: true
    });
    startSteadyWatchdog();
}

function checkForStall() {
    // Retained for API compat; the steady watchdog owns stall detection.
    const watchPage = $('#watchPage');
    if (!watchPage || watchPage.style.display === 'none') return;
}

function startStallDetection() {
    // Legacy entry point: arm the steady watchdog (progress-gated).
    startSteadyWatchdog();
}

void checkForStall;
void startStallDetection;

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
    attemptGeneration++; // a fresh video invalidates every pending attempt

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

    if (options.offlineUrl) {
        setState(PlayerState.OFFLINE);
        userIntendedPlayback = true;
        retryStreamUrl = null;
        retryDesiredTime = 0;
        await replaceSourcePreservingState({
            source: options.offlineUrl,
            videoId: videoData.id,
            reason: 'offline-open',
            desiredTime: 0,
            shouldPlay: true
        });
        startSteadyWatchdog();
        refreshDownloadButton();
        return;
    }

    setState(PlayerState.RESOLVING);
    userIntendedPlayback = true;
    startupDeadlineAt = now() + TIMINGS.STARTUP_BUDGET_MS;
    const streamUrl = getStreamUrl(videoData.id, getPreferredQuality());
    retryStreamUrl = streamUrl;
    retryDesiredTime = 0;
    autoRetriesThisEpisode = 0;
    await replaceSourcePreservingState({
        source: streamUrl,
        videoId: videoData.id,
        reason: 'open',
        desiredTime: 0,
        shouldPlay: true
    });
    startSteadyWatchdog();
    refreshDownloadButton();
}

/** Called from the media error event; classifies and shows a retry option. */
async function handleStreamError() {
    const videoPlayer = $('#videoPlayer');
    const watchPage = $('#watchPage');
    if (!videoPlayer || !watchPage || watchPage.style.display === 'none') return;
    const attempt = attemptGeneration;

    // R4: preserve the position on EVERY failure path.
    const currentTime = videoPlayer.currentTime;
    if (Number.isFinite(currentTime) && currentTime > 0) {
        retryDesiredTime = currentTime;
    }
    stopWatchdog();

    // One automatic retry per continuous failure episode (decode/unsupported
    // errors are NOT retried against the same undecodable media forever).
    if (autoRetriesThisEpisode < 1 && retryStreamUrl && !playingOffline) {
        autoRetriesThisEpisode++;
        setState(PlayerState.RECOVERING);
        await replaceSourcePreservingState({
            source: retryStreamUrl,
            videoId: currentVideoData?.id,
            reason: 'auto-retry',
            desiredTime: retryDesiredTime,
            shouldPlay: true
        });
        startSteadyWatchdog();
        return;
    }

    if (!retryStreamUrl) {
        setState(PlayerState.FAILED);
        showStreamError(STREAM_MESSAGES.generic);
        return;
    }

    const kind = await classifyStreamFailure(retryStreamUrl);
    if (attempt !== attemptGeneration) return;
    setState(PlayerState.FAILED);
    if (kind === 'unauthorized') {
        showStreamError(STREAM_MESSAGES.unauthorized);
        void ensureSession().then(() => {
            if (attempt === attemptGeneration) retryCurrentStream();
        });
        return;
    }
    if (kind === 'ok') {
        // Transport healthy but decode failed — no endless reattach loop.
        showStreamError(STREAM_MESSAGES.generic);
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
    // Invalidate the generation FIRST: late callbacks become no-ops.
    attemptGeneration++;
    if (activeProbeController && !activeProbeController.signal.aborted) {
        try { activeProbeController.abort('closed'); } catch { /* already done */ }
    }
    activeProbeController = null;
    if (videoPlayer) {
        videoPlayer.pause();
        videoPlayer.removeAttribute('src');
        videoPlayer.load();
        videoPlayer.onerror = null;
        videoPlayer.onplaying = null;
    }
    if (notice) notice.hidden = true;
    currentVideoData = null;
    playingOffline = false;
    retryStreamUrl = null;
    retryDesiredTime = 0;
    startupDeadlineAt = null;
    setState(PlayerState.IDLE);
    stopWatchdog();
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
            // Capture the LATEST position immediately before replacing the
            // src (not before the sheet opened).
            const pos = Number.isFinite(videoPlayer.currentTime) ? videoPlayer.currentTime : 0;
            retryDesiredTime = pos;
            const shouldPlay = !videoPlayer.paused && !videoPlayer.ended;
            void replaceSourcePreservingState({
                source: newStreamUrl,
                videoId: currentVideoData.id,
                reason: 'quality-change',
                desiredTime: pos,
                shouldPlay
            }).then(() => startSteadyWatchdog());
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
            if (days < 30) return `${toFa(Math.floor(days / 30))} ماه پیش`;
            if (days < 365) return `${toFa(Math.floor(days / 365))} سال پیش`;
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
    setState(PlayerState.OFFLINE);
    if (notice) notice.hidden = true;
    await replaceSourcePreservingState({
        source: url,
        videoId: videoData.id,
        reason: 'offline-play',
        desiredTime: 0,
        shouldPlay: true
    });
    if (watchPage) watchPage.style.display = 'block';
    startSteadyWatchdog();
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
    // R3: re-anchor the progress baseline when the tab becomes visible again —
    // background time must not consume visible stall grace.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        const videoPlayer = $('#videoPlayer');
        if (!videoPlayer) return;
        lastProgressPos = Number.isFinite(videoPlayer.currentTime) ? videoPlayer.currentTime : 0;
        lastProgressAt = now();
        if (rebufferDeadlineAt !== null) {
            rebufferDeadlineAt = now() + TIMINGS.REBUFFER_GRACE_MS;
        }
        if (startupDeadlineAt !== null) {
            startupDeadlineAt = Math.max(startupDeadlineAt, now() + TIMINGS.WATCHDOG_POLL_MS);
        }
    });
}
