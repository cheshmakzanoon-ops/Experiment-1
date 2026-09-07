// libraryService.js — localStorage-backed user data store.
//
// Everything here is device-local (no YouTube account needed): channel
// subscriptions, watch history, watch-later, liked videos and the
// "not interested" list used to slim down the home feed. Every read is
// guarded so corrupt/absent storage degrades to an empty list.

const SUBSCRIPTIONS_KEY = 'subscriptions';
const WATCH_HISTORY_KEY = 'watchHistory';
const WATCH_LATER_KEY = 'watchLater';
const LIKED_VIDEOS_KEY = 'likedVideos';
const NOT_INTERESTED_KEY = 'notInterested';

/** @returns {any[]} */
function readList(key) {
    try {
        const raw = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(raw) ? raw : [];
    } catch {
        return [];
    }
}

function writeList(key, list) {
    try {
        localStorage.setItem(key, JSON.stringify(list));
    } catch {
        // storage full/unavailable — non-critical
    }
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Stable local channel id. Flat yt-dlp search results rarely include a real
 * channel id, so derive one from the channel name — the same channel gets
 * the same id across videos and pages.
 * @param {string} channelName
 * @returns {string}
 */
export function channelIdFor(channelName) {
    const name = (channelName || '').trim();
    if (!name) return '';
    return `ch_${encodeURIComponent(name.toLowerCase())}`;
}

/** @returns {Array<{id: string, name: string, subscribedAt: number}>} */
export function getSubscriptions() {
    return readList(SUBSCRIPTIONS_KEY);
}

/**
 * Subscribe to a channel (deduplicated, newest first).
 * @param {{name: string, id?: string}} channel
 * @returns {boolean} true when newly subscribed
 */
export function subscribeToChannel(channel) {
    const name = (channel && channel.name || '').trim();
    if (!name) return false;
    const id = (channel && channel.id) || channelIdFor(name);

    const subs = getSubscriptions().filter((s) => s.id !== id);
    subs.unshift({ id, name, subscribedAt: Date.now() });
    writeList(SUBSCRIPTIONS_KEY, subs);
    return true;
}

export function unsubscribeFromChannel(channelId) {
    writeList(
        SUBSCRIPTIONS_KEY,
        getSubscriptions().filter((s) => s.id !== channelId)
    );
}

export function isSubscribed(channelId) {
    if (!channelId) return false;
    return getSubscriptions().some((s) => s.id === channelId);
}

// ---------------------------------------------------------------------------
// Watch history
// ---------------------------------------------------------------------------

/** @param {object} video */
export function addToWatchHistory(video) {
    const history = getWatchHistory().filter((v) => v.id !== video.id);
    history.unshift({
        id: video.id,
        title: video.title,
        thumbnail: video.thumbnail,
        author: video.author,
        duration: video.duration,
        watchedAt: Date.now()
    });
    writeList(WATCH_HISTORY_KEY, history.slice(0, 200));
}

export function getWatchHistory() {
    return readList(WATCH_HISTORY_KEY);
}

export function removeFromWatchHistory(videoId) {
    writeList(WATCH_HISTORY_KEY, getWatchHistory().filter((v) => v.id !== videoId));
}

export function clearWatchHistory() {
    writeList(WATCH_HISTORY_KEY, []);
}

// ---------------------------------------------------------------------------
// Watch later
// ---------------------------------------------------------------------------

/** @param {object} video @returns {boolean} */
export function addToWatchLater(video) {
    const list = getWatchLater().filter((v) => v.id !== video.id);
    list.unshift({
        id: video.id,
        title: video.title,
        thumbnail: video.thumbnail,
        author: video.author,
        duration: video.duration,
        savedAt: Date.now()
    });
    writeList(WATCH_LATER_KEY, list.slice(0, 200));
    return true;
}

export function getWatchLater() {
    return readList(WATCH_LATER_KEY);
}

export function removeFromWatchLater(videoId) {
    writeList(WATCH_LATER_KEY, getWatchLater().filter((v) => v.id !== videoId));
}

// ---------------------------------------------------------------------------
// Liked videos
// ---------------------------------------------------------------------------

/** @param {object} video @returns {boolean} true when newly liked */
export function likeVideo(video) {
    const list = getLikedVideos().filter((v) => v.id !== video.id);
    list.unshift({
        id: video.id,
        title: video.title,
        thumbnail: video.thumbnail,
        author: video.author,
        duration: video.duration,
        likedAt: Date.now()
    });
    writeList(LIKED_VIDEOS_KEY, list.slice(0, 200));
    return true;
}

export function unlikeVideo(videoId) {
    writeList(LIKED_VIDEOS_KEY, getLikedVideos().filter((v) => v.id !== videoId));
}

export function getLikedVideos() {
    return readList(LIKED_VIDEOS_KEY);
}

export function isVideoLiked(videoId) {
    return getLikedVideos().some((v) => v.id === videoId);
}

// ---------------------------------------------------------------------------
// Not interested (hidden from the home feed)
// ---------------------------------------------------------------------------

/** @returns {string[]} */
export function getNotInterested() {
    return readList(NOT_INTERESTED_KEY).map((v) => (typeof v === 'string' ? v : String(v)));
}

export function markNotInterested(videoId) {
    if (!videoId) return;
    const list = getNotInterested();
    if (!list.includes(videoId)) {
        list.push(videoId);
        writeList(NOT_INTERESTED_KEY, list.slice(-500));
    }
}

export function isNotInterested(videoId) {
    return getNotInterested().includes(videoId);
}
