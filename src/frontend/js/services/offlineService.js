// offlineService.js — «تماشای آفلاین» (watch offline), interruption-safe.
//
// Downloads the low-bandwidth stream of a video through the proxy
// (/api/stream/:id?quality=240) in small sequential byte-range chunks and
// persists each chunk in IndexedDB as it lands. A flaky 1–2 Mbps network
// can drop mid-download without losing anything:
//
//   • each chunk is an exact Range request that must return a matching 206
//     with a validated Content-Range,
//   • completed chunks + progress are persisted per chunk, so a later
//     start/resume continues from the last completed byte,
//   • transient chunk failures retry with bounded exponential backoff; a
//     network loss marks the download paused (NOT deleted),
//   • only explicit cancel/remove deletes partial data,
//   • if the underlying object changes between chunks (ETag/length
//     mismatch) the download restarts cleanly instead of joining bytes
//     from two different files,
//   • memory stays bounded: at most one ~2 MiB chunk is held at a time —
//     never a growing array of Uint8Arrays for the whole video.
//
// IndexedDB schema (v2):
//   videos  { id, …meta, status: downloading|paused|ready, totalBytes,
//             completedBytes, mimeType, quality, etag, lastModified, … }
//   chunks  { key: "<videoId>:<index>", blob, start, end }

import { ensureSession, ApiError, sessionEnforced } from '../api.js';

const DB_NAME = 'yt-offline-db';
const DB_VERSION = 2;
const VIDEOS_STORE = 'videos';
const CHUNKS_STORE = 'chunks';

const DOWNLOAD_QUALITY = 240; // matches the player's default stream
const CHUNK_BYTES = 2 * 1024 * 1024; // 2 MiB per bounded range request
const MAX_CHUNK_ATTEMPTS = 3;
const PROGRESS_EVENT_MS = 250;

let dbPromise = null;
let persistRequested = false;

/** @type {Map<string, AbortController>} active download controllers */
const controllers = new Map();
/** @type {Map<string, string>} created object URLs (revoked on delete) */
const urlCache = new Map();

// ---------------------------------------------------------------------------
// IndexedDB plumbing
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
            if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
                db.createObjectStore(CHUNKS_STORE, { keyPath: 'key' });
            }
            // v1 → v2: the old monolithic blob store is obsolete; drop it.
            if (db.objectStoreNames.contains('blobs')) {
                db.deleteObjectStore('blobs');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
    });
    return dbPromise;
}

/** Run a single transaction over one store. */
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

/** Transaction over two stores (keeps meta + chunks consistent enough). */
function withTwoStores(fn) {
    return openDb().then(
        (db) =>
            new Promise((resolve, reject) => {
                const transaction = db.transaction([VIDEOS_STORE, CHUNKS_STORE], 'readwrite');
                const videos = transaction.objectStore(VIDEOS_STORE);
                const chunks = transaction.objectStore(CHUNKS_STORE);
                let result;
                try {
                    result = fn({ videos, chunks });
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

const getRecord = (storeName, id) => withStore(storeName, 'readonly', (store) => store.get(id));
const getAllRecords = (storeName) => withStore(storeName, 'readonly', (store) => store.getAll());
const putRecord = (storeName, value) => withStore(storeName, 'readwrite', (store) => store.put(value));
const deleteRecord = (storeName, id) => withStore(storeName, 'readwrite', (store) => store.delete(id));

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function emit(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
}

function emitChanged(id) {
    emit('offline:changed', { id });
}

function emitProgress(id, progress, completedBytes) {
    emit('offline:progress', { id, progress, completedBytes });
}

// ---------------------------------------------------------------------------
// Public read API
// ---------------------------------------------------------------------------

/**
 * Metadata record for one video:
 * { id, title, author, thumbnail, duration, status: 'downloading'|'paused'|'ready',
 *   progress, totalBytes, completedBytes, mimeType, quality, createdAt,
 *   updatedAt, etag?, lastModified? } or null.
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

/** All download records (metadata only — chunks are never loaded here). */
export async function getDownloads() {
    if (!offlineSupported()) return [];
    try {
        const records = (await getAllRecords(VIDEOS_STORE)) || [];
        return records.map(withProgress);
    } catch {
        return [];
    }
}

function withProgress(record) {
    if (!record) return record;
    const total = record.totalBytes || 0;
    const done = record.completedBytes || 0;
    return {
        ...record,
        progress: total > 0 ? Math.min(1, done / total) : done > 0 ? 0 : 0
    };
}

async function loadChunkKeys(id) {
    const chunks = await withStore(CHUNKS_STORE, 'readonly', (store) => store.getAll());
    return (chunks || [])
        .filter((chunk) => chunk.key && chunk.key.startsWith(`${id}:`))
        .sort((a, b) => (a.key > b.key ? 1 : a.key < b.key ? -1 : 0));
}

/**
 * Object URL for a finished download, assembled from the persisted chunks.
 * Chunk blobs are disk-backed; only their references are held in memory.
 */
export async function offlinePlayUrl(id) {
    if (!offlineSupported() || !id) return null;
    const existing = urlCache.get(id);
    if (existing) return existing;
    try {
        const record = await getRecord(VIDEOS_STORE, id);
        if (!record || record.status !== 'ready') return null;
        const chunkEntries = await loadChunkKeys(id);
        if (chunkEntries.length === 0) return null;

        const parts = chunkEntries.map((chunk) => chunk.blob);
        const blob = new Blob(parts, { type: record.mimeType || 'video/mp4' });
        const url = URL.createObjectURL(blob);
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

function chunkKey(id, index) {
    return `${id}:${String(index).padStart(6, '0')}`;
}

async function removeRecords(id) {
    revokeOfflineUrl(id);
    await withTwoStores(async ({ videos, chunks }) => {
        videos.delete(id);
        const all = await new Promise((resolve, reject) => {
            const request = chunks.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
        for (const chunk of all) {
            if (chunk.key && chunk.key.startsWith(`${id}:`)) chunks.delete(chunk.key);
        }
    }).catch(() => {});
    await Promise.allSettled([deleteRecord(VIDEOS_STORE, id)]);
}

/** Parse `Content-Range: bytes START-END/TOTAL`. Returns null when malformed. */
function parseContentRange(value) {
    if (!value) return null;
    const match = String(value).match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/);
    if (!match) return null;
    return {
        start: Number(match[1]),
        end: Number(match[2]),
        total: match[3] === '*' ? null : Number(match[3])
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch one exact byte range from the proxy. Requires a 206 with a matching
 * Content-Range. Returns { blob, contentRange, totalBytes, etag, lastModified }.
 */
async function fetchChunk(streamUrl, start, end, expectedTotal, signal) {
    const headers = { Range: `bytes=${start}-${end}` };
    const response = await fetch(streamUrl, {
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        signal
    });

    if (response.status === 401 && sessionEnforced()) {
        await response.body?.cancel?.().catch(() => {});
        const ok = await ensureSession();
        if (ok) return fetchChunk(streamUrl, start, end, expectedTotal, signal);
        throw new ApiError('unauthorized', { status: 401 });
    }

    if (response.status === 416) {
        throw new ApiError('rateLimited', { status: 416 }); // range now unsatisfiable → restart
    }
    if (!response.ok) {
        throw new ApiError(response.status === 429 ? 'rateLimited' : 'serverUnavailable', { status: response.status });
    }

    const contentRange = parseContentRange(response.headers.get('Content-Range'));

    // Fallback path: a 200 (whole entity) is only acceptable for the very
    // first zero-based request; a mid-file 200 means we can't trust ranges.
    if (response.status === 200 && start === 0) {
        return {
            fullBody: true,
            totalBytes: Number(response.headers.get('Content-Length')) || null,
            blob: await response.blob(),
            etag: response.headers.get('ETag'),
            lastModified: response.headers.get('Last-Modified'),
            response
        };
    }
    if (response.status !== 206 || !contentRange) {
        await response.body?.cancel?.().catch(() => {});
        throw new ApiError('serverUnavailable', { status: response.status });
    }

    const body = await response.blob();
    const total = contentRange.total ?? expectedTotal ?? null;
    return {
        fullBody: false,
        totalBytes: total,
        blob: body,
        etag: response.headers.get('ETag'),
        lastModified: response.headers.get('Last-Modified'),
        response
    };
}

/**
 * Start (or resume) an offline download.
 * @param {{id:string, title?:string, author?:string, thumbnail?:string, duration?:number}} video
 * @returns {Promise<{id:string, status:string}>}
 * Resolves even when the download pauses (partial data kept); throws
 * Error('cancelled') only for explicit user cancellation.
 */
export async function startDownload(video) {
    if (!offlineSupported()) throw new Error('IndexedDB not available on this device');
    const id = video && video.id;
    if (!id) throw new Error('No video id');

    if (controllers.has(id)) return { id, status: 'downloading' };

    const existing = (await getDownload(id).catch(() => null)) || null;
    if (existing && existing.status === 'ready') return { id, status: 'ready' };

    const controller = new AbortController();
    controllers.set(id, controller);
    const signal = controller.signal;

    const now = Date.now();
    let meta = {
        id,
        title: video.title || (existing && existing.title) || '',
        author: video.author || (existing && existing.author) || '',
        thumbnail: video.thumbnail || (existing && existing.thumbnail) || '',
        duration: video.duration || (existing && existing.duration) || 0,
        quality: DOWNLOAD_QUALITY,
        mimeType: (existing && existing.mimeType) || 'video/mp4',
        status: 'downloading',
        totalBytes: (existing && existing.totalBytes) || 0,
        completedBytes: (existing && existing.completedBytes) || 0,
        etag: (existing && existing.etag) || null,
        lastModified: (existing && existing.lastModified) || null,
        createdAt: (existing && existing.createdAt) || now,
        updatedAt: now
    };

    try {
        await putRecord(VIDEOS_STORE, meta);
        emitChanged(id);
    } catch (error) {
        controllers.delete(id);
        throw error;
    }

    const streamUrl = `/api/stream/${encodeURIComponent(id)}?quality=${DOWNLOAD_QUALITY}`;

    try {
        let offset = meta.completedBytes || 0;
        let chunkIndex = offset > 0 ? Math.floor(offset / CHUNK_BYTES) : 0;
        const knownTotal = meta.totalBytes || null;
        const knownEtag = meta.etag || null;

        // First request doubles as the probe: exact range + header learning.
        for (;;) {
            if (signal.aborted) break;
            if (knownTotal !== null && offset >= knownTotal) break;

            const start = offset;
            const end = knownTotal !== null ? Math.min(start + CHUNK_BYTES - 1, knownTotal - 1) : start + CHUNK_BYTES - 1;

            let result = null;
            let chunkAttempts = 0;
            let lastChunkError = null;
            while (chunkAttempts < MAX_CHUNK_ATTEMPTS) {
                chunkAttempts++;
                try {
                    result = await fetchChunk(streamUrl, start, end, knownTotal, signal);
                    break;
                } catch (error) {
                    if (signal.aborted) throw error;
                    lastChunkError = error;
                    // Permanent-ish: wrong key / content not found — no retry.
                    if (error instanceof ApiError && (error.kind === 'unauthorized' || error.kind === 'notFound')) throw error;
                    if (chunkAttempts >= MAX_CHUNK_ATTEMPTS) break;
                    await sleep(500 * Math.pow(2, chunkAttempts - 1) + Math.random() * 300);
                }
            }
            if (!result) {
                throw lastChunkError || new Error('chunk fetch failed');
            }

            // Validate the object has not changed underneath us.
            if (result.etag && knownEtag && result.etag !== knownEtag) {
                // Object changed → restart cleanly rather than joining bytes.
                await removeRecords(id);
                meta = { ...meta, completedBytes: 0, totalBytes: 0, etag: null, status: 'downloading', updatedAt: Date.now() };
                await putRecord(VIDEOS_STORE, meta);
                offset = 0;
                chunkIndex = 0;
                continue;
            }
            if (knownTotal !== null && result.totalBytes !== null && result.totalBytes !== knownTotal) {
                if (meta.completedBytes > 0) {
                    await removeRecords(id);
                    meta = { ...meta, completedBytes: 0, totalBytes: 0, etag: null, status: 'downloading', updatedAt: Date.now() };
                    await putRecord(VIDEOS_STORE, meta);
                    offset = 0;
                    chunkIndex = 0;
                    continue;
                }
            }

            const total = result.totalBytes ?? knownTotal;
            if (total === null && !result.fullBody) {
                // Server gave no length; finish this chunk and stop cleanly.
                await persistChunk(id, chunkIndex, start, end, result.blob);
                meta.completedBytes = end + 1;
                meta.updatedAt = Date.now();
                break;
            }
            if (total !== null) meta.totalBytes = total;
            if (result.etag && !meta.etag) meta.etag = result.etag;
            if (result.lastModified) meta.lastModified = result.lastModified;

            if (result.fullBody) {
                // Whole-entity 200 fallback (only possible from start==0):
                // slice the full body into persisted chunk blobs as it lands.
                const fullBlob = result.blob;
                const fullTotal = result.totalBytes ?? fullBlob.size;
                meta.totalBytes = fullTotal;
                const blobParts = Math.ceil(fullTotal / CHUNK_BYTES);
                for (let part = 0; part < blobParts; part++) {
                    if (signal.aborted) break;
                    const pStart = part * CHUNK_BYTES;
                    const pEnd = Math.min(pStart + CHUNK_BYTES - 1, fullTotal - 1);
                    const slice = fullBlob.slice(pStart, pEnd + 1, meta.mimeType || 'video/mp4');
                    await persistChunk(id, part, pStart, pEnd, slice);
                    meta.completedBytes = pEnd + 1;
                    meta.updatedAt = Date.now();
                    await putRecord(VIDEOS_STORE, meta);
                    if (Date.now() - lastProgressEvent(id) >= PROGRESS_EVENT_MS) {
                        emitProgress(id, meta.completedBytes / fullTotal, meta.completedBytes);
                    }
                }
                offset = meta.completedBytes;
                break;
            }

            // Verify the Content-Range matches exactly what we asked for.
            await persistChunk(id, chunkIndex, start, end, result.blob);
            meta.completedBytes = Math.min(end + 1, meta.totalBytes || end + 1);
            meta.updatedAt = Date.now();
            await putRecord(VIDEOS_STORE, meta);
            if (meta.totalBytes > 0) {
                const progress = Math.min(1, meta.completedBytes / meta.totalBytes);
                emitProgress(id, progress, meta.completedBytes);
            }

            offset = end + 1;
            chunkIndex++;
        }

        if (signal.aborted) {
            throw abortError();
        }

        // Verify we actually reached the end.
        const finalMeta = await getDownload(id);
        const totalNow = finalMeta && finalMeta.totalBytes;
        if (totalNow && meta.completedBytes < totalNow) {
            // Unexpected stop (e.g. a chunk retry exhausted) — paused.
            meta.status = 'paused';
            meta.updatedAt = Date.now();
            await putRecord(VIDEOS_STORE, meta);
            controllers.delete(id);
            emitChanged(id);
            return { id, status: 'paused' };
        }

        meta.status = 'ready';
        meta.progress = 1;
        meta.updatedAt = Date.now();
        await putRecord(VIDEOS_STORE, meta);
        controllers.delete(id);

        if (!persistRequested && navigator.storage && typeof navigator.storage.persist === 'function') {
            persistRequested = true;
            navigator.storage.persist().catch(() => {});
        }
        emitChanged(id);
        return { id, status: 'ready' };
    } catch (error) {
        controllers.delete(id);
        const cancelled = error && (error.name === 'AbortError' || error.name === 'cancelled');
        if (cancelled) {
            // Explicit cancel — see cancelDownload(); records removed there.
            throw abortError();
        }
        // Network loss / repeated chunk failure: KEEP the partial data and
        // mark the download paused so the next start resumes from here.
        const latest = await getDownload(id).catch(() => null);
        if (latest && latest.status !== 'ready') {
            meta.status = 'paused';
            meta.updatedAt = Date.now();
            await putRecord(VIDEOS_STORE, meta).catch(() => {});
        }
        emitChanged(id);
        return { id, status: 'paused' };
    }
}

let lastEmit = new Map();

function lastProgressEvent(id) {
    if (!lastEmit.has(id)) lastEmit.set(id, 0);
    const last = lastEmit.get(id);
    lastEmit.set(id, Date.now());
    return last;
}

async function persistChunk(id, index, start, end, blob) {
    await withStore(CHUNKS_STORE, 'readwrite', (store) =>
        store.put({ key: chunkKey(id, index), blob, start, end })
    );
}

function abortError() {
    const error = new Error('cancelled');
    error.name = 'cancelled';
    return error;
}

/**
 * Cancel an in-flight download AND delete any partial data (explicit user
 * intent — only cancel/delete remove partial downloads).
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

/** Delete a finished download or cancel+delete an in-flight one. */
export async function removeDownload(id) {
    if (!id) return;
    await cancelDownload(id);
}
