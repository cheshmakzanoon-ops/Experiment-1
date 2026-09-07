// offlineService.js — «تماشای آفلاین» (watch offline).
//
// Downloads the low-bandwidth stream of a video through the proxy
// (/api/stream/:id?quality=240 — exactly what the player uses on a slow
// link) and stores the finished file in IndexedDB, so videos can be watched
// with zero connection (car trips, ISP outages) without re-streaming.
//
// Design notes:
//   • Metadata lives in the «videos» store; finished Blobs live in a
//     separate «blobs» store so the Library tab can list downloads without
//     ever pulling megabytes of video into memory.
//   • Long downloads stream through a reader so progress is visible; bytes
//     are assembled into a single Blob only at the end (browser Blobs are
//     disk-backed, so this stays memory-friendly for typical videos).
//   • Every mutation dispatches a DOM event the UI listens to:
//       offline:changed   → { id }        (started / finished / deleted)
//       offline:progress  → { id, progress, size }
//
// All functions are best-effort: storage failures reject so callers can
// show a Persian toast; they never crash the app.

const DB_NAME = 'yt-offline-db';
const DB_VERSION = 1;
const VIDEOS_STORE = 'videos';
const BLOBS_STORE = 'blobs';

const DOWNLOAD_QUALITY = 240; // matches the player's default stream
const PROGRESS_EVENT_MS = 250; // at most one progress event per 250 ms

let dbPromise = null;
let persistRequested = false;

/** @type {Map<string, AbortController>} in-flight downloads by video id */
const controllers = new Map();

/** @type {Map<string, string>} created object URLs, revoked on delete */
const urlCache = new Map();

// ---------------------------------------------------------------------------
// IndexedDB plumbing (no dependencies)
// ---------------------------------------------------------------------------

export function offlineSupported() {
    return (
        typeof indexedDB !== 'undefined' &&
        typeof Blob !== 'undefined' &&
        typeof AbortController !== 'undefined'
    );
}

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(VIDEOS_STORE)) {
                db.createObjectStore(VIDEOS_STORE, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(BLOBS_STORE)) {
                db.createObjectStore(BLOBS_STORE, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
    });
    return dbPromise;
}

/** Run a single transaction on one store. */
function withStore(storeName, mode, fn) {
    return openDb().then(
        (db) =>
            new Promise((resolve, reject) => {
                const transaction = db.transaction(storeName, mode);
                const store = transaction.objectStore(storeName);
                let result;
                try {
                    result = fn(store);
                } catch (error) {
                    reject(error);
                    return;
                }
                transaction.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
            })
    );
}

const getRecord = (storeName, id) =>
    withStore(storeName, 'readonly', (store) => store.get(id));
const getAllRecords = (storeName) =>
    withStore(storeName, 'readonly', (store) => store.getAll());
const putRecord = (storeName, value) =>
    withStore(storeName, 'readwrite', (store) => store.put(value));
const deleteRecord = (storeName, id) =>
    withStore(storeName, 'readwrite', (store) => store.delete(id));

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function emit(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
}

function emitChanged(id) {
    emit('offline:changed', { id });
}

function emitProgress(id, progress, size) {
    emit('offline:progress', { id, progress, size });
}

// ---------------------------------------------------------------------------
// Public read API
// ---------------------------------------------------------------------------

/**
 * Metadata record for one video: { id, title, author, thumbnail, duration,
 * status: 'downloading'|'ready', progress, size, downloadedAt } or null.
 * @param {string} id
 */
export async function getDownload(id) {
    if (!offlineSupported() || !id) return null;
    try {
        const record = await getRecord(VIDEOS_STORE, id);
        return record || null;
    } catch {
        return null;
    }
}

/** All download records (metadata only — blobs are never loaded here). */
export async function getDownloads() {
    if (!offlineSupported()) return [];
    try {
        return (await getAllRecords(VIDEOS_STORE)) || [];
    } catch {
        return [];
    }
}

/**
 * Object URL for a finished download (creates it once per id and reuses it).
 * @param {string} id
 * @returns {Promise<string|null>}
 */
export async function offlinePlayUrl(id) {
    if (!offlineSupported() || !id) return null;
    const existing = urlCache.get(id);
    if (existing) return existing;
    try {
        const record = await getRecord(BLOBS_STORE, id);
        if (!record || !record.blob) return null;
        const url = URL.createObjectURL(record.blob);
        urlCache.set(id, url);
        return url;
    } catch {
        return null;
    }
}

export function revokeOfflineUrl(id) {
    const url = urlCache.get(id);
    if (url) {
        URL.revokeObjectURL(url);
        urlCache.delete(id);
    }
}

// ---------------------------------------------------------------------------
// Download lifecycle
// ---------------------------------------------------------------------------

async function removeRecords(id) {
    revokeOfflineUrl(id);
    await Promise.allSettled([deleteRecord(VIDEOS_STORE, id), deleteRecord(BLOBS_STORE, id)]);
}

/**
 * Start (or resume) an offline download of a video.
 * Resolves { id }; rejects with Error('cancelled') when aborted via
 * cancelDownload/removeDownload and with the underlying error otherwise.
 * @param {{id: string, title: string, author?: string, thumbnail?: string, duration?: number}} video
 */
export async function startDownload(video) {
    if (!offlineSupported()) throw new Error('IndexedDB not available on this device');
    const id = video && video.id;
    if (!id) throw new Error('No video id');

    if (controllers.has(id)) return { id }; // already downloading
    const existing = await getDownload(id).catch(() => null);
    if (existing && existing.status === 'ready') return { id }; // already saved

    const controller = new AbortController();
    controllers.set(id, controller);

    // Base record kept fresh as the download progresses.
    const meta = {
        id,
        title: video.title || '',
        author: video.author || '',
        thumbnail: video.thumbnail || '',
        duration: video.duration || 0,
        status: 'downloading',
        progress: 0,
        size: existing && existing.size ? existing.size : 0,
        downloadedAt: (existing && existing.downloadedAt) || Date.now()
    };
    try {
        await putRecord(VIDEOS_STORE, meta);
        emitChanged(id);
    } catch (error) {
        controllers.delete(id);
        throw error;
    }

    const parts = [];
    let received = 0;
    let lastEventAt = 0;

    try {
        const response = await fetch(`/api/stream/${encodeURIComponent(id)}?quality=${DOWNLOAD_QUALITY}`, {
            cache: 'no-store',
            signal: controller.signal
        });
        if (!response.ok || !response.body) {
            throw new Error(`دانلود ممکن نشد (${response.status})`);
        }

        const total = Number(response.headers.get('Content-Length')) || 0;
        const mimeType = response.headers.get('Content-Type') || 'video/mp4';
        const reader = response.body.getReader();

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength) {
                parts.push(value);
                received += value.byteLength;
            }

            const now = Date.now();
            if (now - lastEventAt >= PROGRESS_EVENT_MS) {
                lastEventAt = now;
                const progress = total > 0 ? Math.min(1, received / total) : 0;
                meta.progress = progress;
                meta.size = received;
                try {
                    await putRecord(VIDEOS_STORE, meta);
                } catch {
                    // progress writes must never abort the download
                }
                emitProgress(id, progress, received);
            }
        }

        // Finished: assemble the file and move it to the blobs store.
        const blob = new Blob(parts, { type: mimeType });
        parts.length = 0;
        await putRecord(BLOBS_STORE, { id, blob, mimeType, size: received });

        meta.status = 'ready';
        meta.progress = 1;
        meta.size = received;
        await putRecord(VIDEOS_STORE, meta);
        controllers.delete(id);

        if (!persistRequested && navigator.storage && typeof navigator.storage.persist === 'function') {
            persistRequested = true;
            navigator.storage.persist().catch(() => {});
        }
        emitChanged(id);
        return { id };
    } catch (error) {
        controllers.delete(id);
        const cancelled = error && (error.name === 'AbortError' || error.name === 'cancelled');
        // Cleanup quietly; cancelDownload/removeDownload already announced it.
        await removeRecords(id).catch(() => {});
        if (!cancelled) emitChanged(id);
        if (cancelled) {
            const cancelledError = new Error('cancelled');
            cancelledError.name = 'cancelled';
            throw cancelledError;
        }
        throw error;
    }
}

/**
 * Cancel an in-flight download (and delete any partial data).
 * @param {string} id
 */
export async function cancelDownload(id) {
    if (!id) return;
    const controller = controllers.get(id);
    if (controller) {
        controllers.delete(id);
        controller.abort();
    }
    await removeRecords(id).catch(() => {});
    emitChanged(id);
}

/**
 * Delete a finished download (or cancel one in flight).
 * @param {string} id
 */
export async function removeDownload(id) {
    if (!id) return;
    await cancelDownload(id);
}
