// nativeApp.js — detection + bridge helpers for the Android WebView wrapper.
//
// The wrapper (android/) injects two globals after each page load:
//   • window.AndroidWrapper = { isNative: true, ... }   → set by WebViewClient
//   • window.AndroidBridge   → @JavascriptInterface object named "AndroidBridge"
//
// In a normal browser both are absent and every helper degrades to the web
// platform equivalent, so this module is safe to import unconditionally.

/** True when running inside the Android WebView wrapper. */
export function isNativeApp() {
    return (
        typeof window !== 'undefined' &&
        typeof window.AndroidWrapper !== 'undefined' &&
        window.AndroidWrapper.isNative === true
    );
}

/** The native bridge object (null in a plain browser). */
export function getNativeBridge() {
    if (isNativeApp() && typeof window.AndroidBridge !== 'undefined') {
        return window.AndroidBridge;
    }
    return null;
}

/**
 * Show a toast: native Android toast when available, otherwise dispatch a
 * fallback to the app's own toast renderer.
 * @returns {boolean} true if a native toast was shown.
 */
export function showNativeToast(message) {
    const bridge = getNativeBridge();
    if (bridge && typeof bridge.showToast === 'function') {
        bridge.showToast(String(message));
        return true;
    }
    return false;
}

/** Connectivity: prefer the native (ConnectivityManager) answer. */
export function isNetworkAvailable() {
    const bridge = getNativeBridge();
    if (bridge && typeof bridge.isNetworkAvailable === 'function') {
        return bridge.isNetworkAvailable();
    }
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

/**
 * Ask for persistent storage so IndexedDB offline downloads are not evicted.
 * Returns a promise of the granted boolean (best effort — false when the
 * platform cannot grant or report it).
 */
export async function requestPersistentStorage() {
    const bridge = getNativeBridge();
    if (bridge && typeof bridge.requestPersistentStorage === 'function') {
        try {
            return !!bridge.requestPersistentStorage();
        } catch {
            return false;
        }
    }
    if (navigator.storage && navigator.storage.persist) {
        try {
            return await navigator.storage.persist();
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * Share a video link: native Android share sheet inside the wrapper, Web
 * Share API in browsers, clipboard copy as the last resort.
 */
export function shareVideo(title, url) {
    const bridge = getNativeBridge();
    if (bridge && typeof bridge.shareVideo === 'function') {
        bridge.shareVideo(String(title || ''), String(url));
        return;
    }
    if (navigator.share) {
        navigator
            .share({ title: title || '', url })
            .catch(() => {});
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
            .writeText(url)
            .catch(() => {});
    }
}

/**
 * Run `callback` once, when the native wrapper announces it is ready.
 * If the event already fired before this listener was attached (script
 * loaded after onPageFinished), the wrapper flag check still catches it.
 */
export function onAndroidReady(callback) {
    if (typeof callback !== 'function') return;
    if (isNativeApp()) {
        // Event may have fired already or will fire on the next page finish —
        // call once immediately and keep listening for future full loads.
        callback();
    }
    window.addEventListener('android-wrapper-ready', callback, { once: true });
}
