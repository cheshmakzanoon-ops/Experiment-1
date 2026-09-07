// videoActions.js — shared, dependency-free video actions used by both the
// video card ⋮ menus and the watch page (and the native wrapper).
//
// Extracted so videoCard.js and videoPlayer.js never import each other:
// videoCard needs the player (openVideoPlayer) and videoPlayer used to need
// shareVideo from videoCard — a circular dependency that also masked a real
// runtime ReferenceError (videoCard called openVideoPlayer without
// importing it). Sharing now lives here; neither component imports the
// other.

import { getNativeBridge } from './nativeApp.js';
import { showToast } from './domUtils.js';

/**
 * Share a video. Inside the Android wrapper this opens the native share
 * sheet (AndroidBridge.shareVideo); otherwise the Web Share API or a
 * clipboard copy.
 * @param {{id: string, title?: string}} videoData
 */
export function shareVideo(videoData) {
    if (!videoData || !videoData.id) return;
    const url = `${window.location.origin}/watch?v=${encodeURIComponent(videoData.id)}`;
    const title = videoData.title || '';

    const bridge = getNativeBridge();
    if (bridge && typeof bridge.shareVideo === 'function') {
        bridge.shareVideo(title, url);
        return;
    }
    if (navigator.share) {
        navigator
            .share({ title, url })
            .catch(() => {});
        return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
            .writeText(url)
            .then(() => showToast('لینک کپی شد'))
            .catch(() => showToast('خطا در کپی لینک'));
        return;
    }
    showToast(title || url);
}

/** The shareable web URL for a video id. */
export function videoShareUrl(videoId) {
    return `${window.location.origin}/watch?v=${encodeURIComponent(videoId)}`;
}
