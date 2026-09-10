// offlineService.js — «تماشای آفلاین» (watch offline), interruption-safe.
//
// Downloads the low-bandwidth stream of a video through the proxy
// (/api/stream/:id?quality=240) in small sequential byte-range chunks and
// persists each chunk + its updated metadata in IndexedDB as one atomic
// transaction. A flaky 1–2 Mbps network can drop mid-download without
// losing anything:
//
//   • each chunk is an exact Range request that must return a matching 206
//     with a VALIDATED Content-Range ({start,end,total}, all safe integers,
//     positive total > end); unknown totals are unsupported and pause with
//     RANGE_TOTAL_UNKNOWN,
//   • a 200 response to a ranged download request is UNSUPPORTED — its
//     body is cancelled immediately (never blob()/arrayBuffer()/text()) and
//     the download pauses with RANGE_UNSUPPORTED (ordinary ONLINE playback
//     still relays truthful HTTP 200 responses unchanged),
//   • completed chunks + metadata are persisted together per chunk, so a
//     later start/resume continues from the last COMMITTED byte, derived
//     from validated stored chunk coverage (never optimistic counters),
//   • transient chunk failures retry at most three times with abortable
//     bounded backoff (network/timeouts/429/502/503/504 only), honoring
//     Retry-After (a Retry-After over 30 s pauses with a retry timestamp);
//     one reauthentication allowance per chunk operation, a second 401 is
//     terminal for that operation,
//   • only explicit cancel/remove deletes partial data (awaited,
//     ownership-fenced transaction across all stores),
//   • if the underlying object changes between chunks (established ETag /
//     total / Last-Modified without a strong ETag) the download performs
//     ONE clean restart; a second change pauses with SOURCE_CHANGED,
//   • memory stays bounded: at most one ~2 MiB chunk is accumulated per
//     fetch — never the whole video (strict counted reads with cap,
//     overflow cancels immediately, premature EOF is rejected),
//   • per-chunk deadlines: 180 s to response headers, 30 s body idle,
//     120 s overall body time; timers/listeners cleared on every path.
//
// IndexedDB schema (v3 — additive only; the v1 `blobs` store is preserved):
//   videos  { id, …meta, status: downloading|paused|ready, totalBytes,
//             completedBytes, chunkCount, mimeType, quality, etag,
//             etagStrong, lastModified, createdAt, updatedAt, … }
//   chunks  { key: "<videoId>:<index>", start, end, blob, size }
//   operations { videoId: "owner:<videoId>", owner, acquiredAt,
//                heartbeatAt, previousOwner } — durable cross-context
//                download ownership (A03/A10), heartbeat-fenced

import { ApiError, sessionEnforced, waitForGateOrAbort } from '../api.js';

const DB_NAME = 'yt-offline-db';
const DB_VERSION = 3;
const VIDEOS_STORE = 'videos';
const CHUNKS_STORE = 'chunks';
const OPERATIONS_STORE = 'operations';
const LEGACY_BLOBS_STORE = 'blobs';

const DOWNLOAD_QUALITY = 240; // matches the player's default stream
const CHUNK_BYTES = 2 * 1024 * 1024; // 2 MiB per bounded range request
const MAX_CHUNK_ATTEMPTS = 3;
const PROGRESS_EVENT_MS = 250;
const HEADER_DEADLINE_MS = 180_000;
const BODY_IDLE_DEADLINE_MS = 30_000;
const BODY_OVERALL_DEADLINE_MS = 120_000;
const MAX_SOURCE_RESTARTS = 1;

let dbPromise = null;
let persistRequested = false;

/** @type {Map<string, Operation>} active download operations */
const operations = new Map();
/** @type {Map<string, string>} created object URLs (revoked on delete) */
const urlCache = new Map();
/** @type {Map<string, number>} throttled progress emit timestamps */
const lastEmit = new Map();

/**
 * One download operation per video: owns the AbortController and a settled
 * promise so two simultaneous starts can never create two writers.
 */
class Operation {
    constructor(id) {
        this.id = id;
        this.controller = new AbortController();
        /** Filled by startDownload; awaiting it yields real settlement. */
        this.done = null;
    }
}

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
            // A05: schema changes stay additive. The v1-era `blobs` store is
            // PRESERVED — legacy monolithic downloads stay listed/playable
            // and are removed only by explicit user deletion.
            if (!db.objectStoreNames.contains(OPERATIONS_STORE)) {
                db.createObjectStore(OPERATIONS_STORE, { keyPath: 'videoId' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
    });
    return dbPromise;
}

/**
 * Run a synchronous request-issuing function inside ONE transaction.
 * Synchronous exceptions abort the transaction (rollback). Resolution
 * happens only on transaction completion; no unrelated async work runs
 * inside the transaction. When the callback returns a promise (a wrapped
 * request), the transaction waits for completion before resolving with the
 * request's value — a request error rejects and aborts the transaction.
 */
function withTransaction(storeNames, mode, fn) {
    return openDb().then(
        (db) =>
            new Promise((resolve, reject) => {
                const transaction = db.transaction(storeNames, mode);
                let pendingError = null;
                let syncError = null;
                let captured = undefined;
                let capturedPromise = null;
                try {
                    const result = fn(transaction);
                    if (result && typeof result.then === 'function') {
                        capturedPromise = result;
                        result.then(
                            (value) => {
                                captured = value;
                            },
                            (error) => {
                                pendingError = error;
                                try {
                                    transaction.abort();
                                } catch {
                                    /* already aborted */
                                }
                            }
                        );
                    } else {
                        captured = result;
                    }
                } catch (error) {
                    syncError = error;
                    try {
                        transaction.abort();
                    } catch {
                        /* already aborted */
                    }
                }
                transaction.oncomplete = () => {
                    if (syncError) reject(syncError);
                    else if (pendingError) reject(pendingError);
                    else resolve(captured);
                };
                transaction.onerror = () => {
                    if (syncError) reject(syncError);
                    else if (pendingError) reject(pendingError);
                    else reject(transaction.error || new Error('Transaction failed'));
                };
                transaction.onabort = () => {
                    if (syncError) reject(syncError);
                    else if (pendingError) reject(pendingError);
                    else reject(transaction.error || new Error('Transaction aborted'));
                };
                void capturedPromise;
            })
    );
}

const withVideosWrite = (fn) => withTransaction(VIDEOS_STORE, 'readwrite', (tx) => fn(tx.objectStore(VIDEOS_STORE)));

function getRecord(storeName, id) {
    return withTransaction(storeName, 'readonly', (tx) => {
        const request = tx.objectStore(storeName).get(id);
        return wrapRequest(request);
    });
}

function wrapRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function getAllRecords(storeName) {
    return withTransaction(storeName, 'readonly', (tx) => {
        const request = tx.objectStore(storeName).getAll();
        return wrapRequest(request);
    });
}

/** Chunk prefix cursor (never loads every video's blobs). */
function cursorChunksFor(id, onRecord) {
    return withTransaction(CHUNKS_STORE, 'readwrite', (tx) => {
        const store = tx.objectStore(CHUNKS_STORE);
        const range = IDBKeyRange.bound(`${id}:`, `${id}:\uffff`);
        const request = store.openCursor(range);
        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                onRecord(cursor.value, cursor);
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        });
    });
}

/** Cursor-delete a video's chunk records (part of larger transactions). */
function deleteChunkRangeInTx(chunksStore, id) {
    const range = IDBKeyRange.bound(`${id}:`, `${id}:\uffff`);
    const request = chunksStore.openCursor(range);
    let deleted = 0;
    request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        deleted++;
        cursor.continue();
    };
    request.onerror = () => {};
    return deleted;
}

// ---------------------------------------------------------------------------
// Durable download ownership — A03/A10
// ---------------------------------------------------------------------------

/**
 * Per-page-load instance identity. Two tabs of this app on one device must
 * never both write the same video's chunks. Ownership is persisted in the
 * `operations` store so it survives tab reloads and is FENCED by a heartbeat:
 * a crashed/closed writer stops heartbeating and its claim expires, so a
 * surviving context may resume instead of being locked out forever.
 */
const OWNER_HEARTBEAT_MS = 4_000;
const OWNER_LIVENESS_MS = 15_000;
const ownerInstance =
    (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `inst-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const ownerHeartbeats = new Map();

function isForeignOwner(record) {
    if (!record || record.owner === ownerInstance) return false;
    // Liveness fencing only: a claim whose heartbeat stopped for longer than
    // the liveness window belongs to a crashed/closed context and is
    // re-claimable. A frozen (bfcache) writer that resumes after another
    // context took over hits the fenced writes below and pauses cleanly —
    // data stays consistent either way.
    const heartbeatAt = Number(record.heartbeatAt) || 0;
    return Date.now() - heartbeatAt < OWNER_LIVENESS_MS;
}

function ownerRecord(id, previous) {
    return {
        videoId: `owner:${id}`,
        owner: ownerInstance,
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
        previousOwner: (previous && previous.owner) || null
    };
}

/**
 * Read the durable ownership record for `id`.
 * @returns {Promise<{record: object|null, mine: boolean, foreign: boolean}>}
 */
async function readOwnership(id) {
    let record = null;
    try {
        record = await getRecord(OPERATIONS_STORE, `owner:${id}`);
    } catch {
        record = null;
    }
    if (!record) return { record: null, mine: false, foreign: false };
    if (record.owner === ownerInstance) return { record, mine: true, foreign: false };
    return { record, mine: false, foreign: isForeignOwner(record) };
}

/**
 * Take durable ownership of `id` (create/overwrite the record in one
 * write transaction) and start the heartbeat. Returns false when another
 * LIVE context owns the download — the caller must not write.
 */
async function claimOwnership(id) {
    let previous = null;
    try {
        previous = await getRecord(OPERATIONS_STORE, `owner:${id}`);
    } catch {
        previous = null;
    }
    if (previous && isForeignOwner(previous)) return false;
    try {
        await withTransaction(OPERATIONS_STORE, 'readwrite', (tx) => {
            tx.objectStore(OPERATIONS_STORE).put(ownerRecord(id, previous));
        });
    } catch {
        // If we cannot persist the claim we must not silently compete.
        return false;
    }
    startOwnerHeartbeat(id);
    return true;
}

function startOwnerHeartbeat(id) {
    stopOwnerHeartbeat(id);
    const touch = () => {
        withTransaction(OPERATIONS_STORE, 'readwrite', (tx) => {
            const store = tx.objectStore(OPERATIONS_STORE);
            const request = store.get(`owner:${id}`);
            request.onsuccess = () => {
                const record = request.result;
                if (!record || record.owner !== ownerInstance) return;
                record.heartbeatAt = Date.now();
                store.put(record);
            };
        }).catch(() => {});
    };
    touch();
    const timer = setInterval(touch, OWNER_HEARTBEAT_MS);
    if (typeof timer === 'object' && timer && typeof timer.unref === 'function') timer.unref();
    ownerHeartbeats.set(id, timer);
}

function stopOwnerHeartbeat(id) {
    const timer = ownerHeartbeats.get(id);
    if (timer) {
        clearInterval(timer);
        ownerHeartbeats.delete(id);
    }
}

/** Release our durable ownership of `id` (only ever our own record). */
async function releaseOwnership(id) {
    stopOwnerHeartbeat(id);
    try {
        await withTransaction(OPERATIONS_STORE, 'readwrite', (tx) => {
            const store = tx.objectStore(OPERATIONS_STORE);
            const request = store.get(`owner:${id}`);
            request.onsuccess = () => {
                const record = request.result;
                if (record && record.owner === ownerInstance) store.delete(`owner:${id}`);
            };
        });
    } catch {
        /* release is best-effort; the record expires via liveness */
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function emit(name, detail) {
    if (typeof document !== 'undefined' && typeof CustomEvent !== 'undefined') {
        document.dispatchEvent(new CustomEvent(name, { detail }));
    }
}

function emitChanged(id) {
    emit('offline:changed', { id });
}

function emitProgress(id, progress, completedBytes) {
    emit('offline:progress', { id, progress, completedBytes });
}

function throttleProgress(id) {
    if (!lastEmit.has(id)) lastEmit.set(id, 0);
    const last = lastEmit.get(id);
    lastEmit.set(id, Date.now());
    return last;
}

// ---------------------------------------------------------------------------
// Public read API
// ---------------------------------------------------------------------------

/**
 * Read the v1 monolithic download for `id` from the preserved legacy
 * `blobs` store (A05). Returns a modern-shaped ready record or null.
 * Strictly validated: the row is skipped (never repaired, never deleted)
 * when it does not carry a real Blob.
 */
async function getLegacyDownload(id) {
    if (!id || typeof id !== 'string') return null;
    try {
        const row = await getRecord(LEGACY_BLOBS_STORE, id);
        if (!isValidLegacyRow(row)) return null;
        return legacyRecord(row);
    } catch {
        return null;
    }
}

/**
 * A05: explicit user removal reaches the preserved legacy store too. Only
 * a user-initiated cancel/remove calls this — never an upgrade, never a
 * repair. Best-effort: a failed legacy cleanup never reports failure for
 * the modern deletion that already succeeded.
 */
async function deleteLegacyBlobRecord(id) {
    try {
        await withTransaction(LEGACY_BLOBS_STORE, 'readwrite', (tx) => {
            tx.objectStore(LEGACY_BLOBS_STORE).delete(id);
        });
    } catch {
        /* best-effort — the legacy row may already be gone */
    }
}

/**
 * Metadata record for one video:
 * { id, title, author, thumbnail, duration, status: 'downloading'|'paused'|'ready',
 *   progress, totalBytes, completedBytes, chunkCount, mimeType, quality,
 *   createdAt, updatedAt, etag?, etagStrong?, lastModified? } or null.
 */
export async function getDownload(id) {
    if (!offlineSupported() || !id) return null;
    try {
        const record = await getRecord(VIDEOS_STORE, id);
        if (record) return withProgress(record);
    } catch {
        return null;
    }
    // A05: a v1-era download (monolithic Blob in the preserved legacy store)
    // stays visible after the v3 upgrade.
    const legacy = await getLegacyDownload(id);
    return legacy ? withProgress(legacy) : null;
}

/**
 * All download records (metadata only — chunks are never loaded here).
 * A05: v1-era legacy downloads are appended from the preserved `blobs`
 * store; a modern record for the same id always wins.
 */
export async function getDownloads() {
    if (!offlineSupported()) return [];
    try {
        const records = (await getAllRecords(VIDEOS_STORE)) || [];
        const modern = new Set(records.map((record) => record.id));
        const legacyRows = (await getAllRecords(LEGACY_BLOBS_STORE).catch(() => [])) || [];
        const legacy = legacyRows
            .filter((row) => row && !modern.has(row.id) && isValidLegacyRow(row))
            .map((row) => withProgress(legacyRecord(row)));
        return records.map(withProgress).concat(legacy);
    } catch {
        return [];
    }
}

/**
 * A05: build (and cache) a playback URL from the preserved v1 `blobs`
 * store. Strictly validated — a corrupt row yields null, never a
 * fabricated URL.
 */
async function playLegacyBlobUrl(id) {
    try {
        const row = await getRecord(LEGACY_BLOBS_STORE, id);
        if (!isValidLegacyRow(row)) return null;
        const url = URL.createObjectURL(row.blob);
        urlCache.set(id, url);
        return url;
    } catch {
        return null;
    }
}

/**
 * Strict shape check for a legacy `blobs` row (A05): a row without a real
 * Blob is reported absent — never fabricated, never auto-repaired.
 */
function isValidLegacyRow(row) {
    if (!row || typeof row.id !== 'string') return false;
    const blob = row.blob;
    return (
        !!blob &&
        typeof blob.size === 'number' &&
        typeof blob.slice === 'function' &&
        typeof blob.arrayBuffer === 'function'
    );
}

/** Modern-shaped ready record from a validated legacy `blobs` row. */
function legacyRecord(row) {
    return {
        id: row.id,
        title: typeof row.title === 'string' ? row.title : '',
        author: typeof row.author === 'string' ? row.author : '',
        thumbnail: '',
        duration: 0,
        status: 'ready',
        totalBytes: row.blob.size,
        completedBytes: row.blob.size,
        chunkCount: 1,
        mimeType: typeof row.mimeType === 'string' ? row.mimeType : 'video/mp4',
        quality: 0,
        pausedReason: null,
        retryAfterEpoch: null,
        etag: null,
        etagStrong: false,
        lastModified: null,
        createdAt: Number(row.createdAt) || 0,
        updatedAt: Number(row.updatedAt) || 0,
        legacy: true
    };
}

function withProgress(record) {
    if (!record) return record;
    const total = record.totalBytes || 0;
    const done = record.completedBytes || 0;
    return {
        ...record,
        progress: total > 0 ? Math.min(1, done / total) : 0
    };
}

// ---------------------------------------------------------------------------
// Chunk coverage validation (resume + playback)
// ---------------------------------------------------------------------------

/**
 * Read the persisted chunk descriptors for a video in ASCENDING start
 * order and validate them: contiguous starts, real Blob sizes matching
 * start/end, no gaps/overlaps. Returns { chunks, validThrough } where
 * validThrough is the end of the last trustworthy contiguous chunk (-1
 * when none).
 */
async function loadValidatedChunks(id) {
    const found = [];
    await cursorChunksFor(id, (chunk) => {
        if (chunk && chunk.key && String(chunk.key).startsWith(`${id}:`)) {
            found.push(chunk);
        }
    });
    found.sort((a, b) => {
        const aStart = Number.isSafeInteger(a.start) ? a.start : Infinity;
        const bStart = Number.isSafeInteger(b.start) ? b.start : Infinity;
        if (aStart !== bStart) return aStart - bStart;
        return 0;
    });

    const validated = [];
    let expectedStart = 0;
    for (const chunk of found) {
        const start = chunk.start;
        const end = chunk.end;
        const size = chunk.blob && typeof chunk.blob.size === 'number' ? chunk.blob.size : -1;
        if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            end < start ||
            size !== end - start + 1 ||
            start !== expectedStart
        ) {
            // First untrustworthy chunk: everything from here on is dropped.
            break;
        }
        validated.push({ start, end, blob: chunk.blob, size, key: chunk.key });
        expectedStart = end + 1;
    }
    const validThrough = validated.length > 0 ? validated[validated.length - 1].end : -1;
    return { chunks: validated, validThrough };
}

/**
 * Delete every chunk from `firstBadStart` onward for this video (only the
 * incompatible TRAILING records — never a whole-database wipe) and repair
 * the video metadata to the last contiguous valid prefix.
 */
async function repairTrailingChunks(id, meta, firstBadStart) {
    await withTransaction([VIDEOS_STORE, CHUNKS_STORE], 'readwrite', (tx) => {
        const videos = tx.objectStore(VIDEOS_STORE);
        const chunks = tx.objectStore(CHUNKS_STORE);
        // Delete ONLY the incompatible trailing records (start >= the first
        // bad offset) — never the contiguous prefix, never the whole DB.
        const range = IDBKeyRange.bound(`${id}:`, `${id}:\uffff`);
        const cursorRequest = chunks.openCursor(range);
        cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const value = cursor.value;
            if (value && Number.isSafeInteger(value.start) && value.start >= firstBadStart) {
                cursor.delete();
            }
            cursor.continue();
        };
        cursorRequest.onerror = () => {};
        if (meta) {
            videos.put(meta);
        }
    });
}

// ---------------------------------------------------------------------------
// Range/response validation (Section 5 contract)
// ---------------------------------------------------------------------------

/** Parse `Content-Range: bytes START-END/TOTAL` (all safe, total > end). */
export function parseContentRangeValue(value) {
    if (!value) return null;
    const match = String(value).match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) {
        return null;
    }
    if (start < 0 || end < start || total <= end || total <= 0) return null;
    return { start, end, total };
}

/** Parse a 416 Content-Range total token ("bytes asterisk / N" form). Returns N or null when malformed. */
export function parseUnsatisfiedTotal(value) {
    if (!value) return null;
    const match = String(value).match(/^bytes\s+\*\/\s*(\d+)$/);
    if (!match) return null;
    const total = Number(match[1]);
    if (!Number.isSafeInteger(total) || total < 0) return null;
    return total;
}

const isStrongEtag = (etag) => Boolean(etag) && !/^W\//i.test(String(etag));

function abortError(message) {
    const error = new Error(message || 'cancelled');
    error.name = 'AbortError';
    return error;
}

/**
 * Monotonic elapsed-time source for active deadlines (F07): a drifting or
 * adjusted wall clock can no longer extend or truncate a deadline.
 */
function monotonicNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

function isAbort(error) {
    return Boolean(error) && (error.name === 'AbortError' || error.name === 'cancelled');
}

function abortableSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            reject(abortError());
            return;
        }
        const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

function rangeError(kind, extra) {
    return new ApiError(kind, extra || {});
}

/**
 * Read one bounded 206 body with strict counting + deadlines (F07).
 *
 * EVERY awaited read — including the EOF confirmation after the expected
 * byte count has arrived — runs under the SAME cancellation, idle-timeout
 * and absolute-deadline mechanism. A read error (or an error on the EOF
 * check) propagates UNCHANGED: the historic `catch(() => ({done:true}))`
 * that fabricated a successful EOF out of a rejected read is gone. The
 * absolute deadline uses monotonic elapsed time so it expires even when
 * bytes keep trickling, and rejection never depends on an uncooperative
 * reader.cancel() promise settling.
 */
async function readRangeBody(reader, expectedLength, startedAt, signal) {
    const chunks = [];
    let counted = 0;
    let idleTimer = null;
    // Monotonic anchor: the overall body deadline expires even when bytes
    // keep trickling, regardless of wall-clock adjustments.
    const startMono = monotonicNow();
    const deadlineMono = startMono + BODY_OVERALL_DEADLINE_MS;
    const onAbort = () => {
        reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const clearTimers = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
    };
    const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            reader.cancel().catch(() => {});
            idleTimeout = true;
        }, BODY_IDLE_DEADLINE_MS);
    };

    let idleTimeout = false;
    /** Bounded read under the shared deadline/cancel mechanism. */
    const guardedRead = async () => {
        armIdle();
        try {
            return await reader.read();
        } finally {
            clearTimers();
        }
    };

    try {
        for (;;) {
            if (signal.aborted) throw abortError();
            if (idleTimeout) throw rangeError('timeout');
            if (monotonicNow() > deadlineMono) {
                reader.cancel().catch(() => {});
                throw rangeError('timeout');
            }

            let readResult;
            try {
                readResult = await guardedRead();
            } catch (readError) {
                if (signal.aborted) throw abortError();
                // Propagate the read failure UNCHANGED into the taxonomy as a
                // genuine network failure — never a fabricated done:true.
                throw new ApiError('offline', { cause: readError });
            }
            const { done, value } = readResult;
            if (signal.aborted) throw abortError();
            if (done) break;
            if (value && value.byteLength > 0) {
                counted += value.byteLength;
                if (counted > expectedLength) {
                    // Overflow: stop accumulating immediately; do not wait
                    // for an uncooperative cancel to settle.
                    reader.cancel().catch(() => {});
                    throw rangeError('rangeInvalid');
                }
                chunks.push(value);
            }
            if (counted === expectedLength) {
                // Exactly the promised bytes arrived. A well-behaved 206 ends
                // here; the NEXT read must confirm EOF under the SAME
                // deadlines/cancellation. An error there is an error (F07):
                // it must never be rewritten into done:true.
                let eofResult;
                try {
                    eofResult = await guardedRead();
                } catch (eofError) {
                    if (signal.aborted) throw abortError();
                    throw new ApiError('offline', { cause: eofError });
                }
                if (!eofResult.done) {
                    // More bytes than promised — the range lied.
                    reader.cancel().catch(() => {});
                    throw rangeError('rangeInvalid');
                }
                break;
            }
        }
    } finally {
        clearTimers();
        signal.removeEventListener('abort', onAbort);
        try {
            reader.releaseLock();
        } catch {
            /* lock already released */
        }
    }
    if (idleTimeout) throw rangeError('timeout');
    if (counted < expectedLength) {
        // Premature EOF: a 206 that promised more bytes than it sent.
        throw rangeError('rangeInvalid');
    }
    return new Blob(chunks);
}

/**
 * Fetch ONE exact byte range. Requires a 206 whose validated range is
 * consistent with the request. Returns
 *   { kind:'chunk', range:{start,end,total}, blob, etag, lastModified, mimeType }
 * or
 *   { kind:'unsatisfied', total, etag, lastModified }
 * (a 416 parsed from the "bytes asterisk / N" Content-Range form). A 200 to
 * a ranged request is unsupported: body cancelled immediately,
 * RANGE_UNSUPPORTED thrown. Never returns a consumed Response as an extra
 * source of truth.
 */
async function fetchSingleRange(streamUrl, start, end, signal) {
    const headers = { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' };
    const controller = new AbortController();
    const headerTimer = setTimeout(() => controller.abort(), HEADER_DEADLINE_MS);
    const onAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) throw abortError();
        signal.addEventListener('abort', onAbort, { once: true });
    }

    let response = null;
    let timedOut = false;
    try {
        response = await fetch(streamUrl, {
            headers,
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal
        });
    } catch (error) {
        timedOut = error && error.name === 'AbortError' && !signal?.aborted;
        if (signal?.aborted) throw abortError();
        throw timedOut ? rangeError('timeout') : new ApiError('offline', { cause: error });
    } finally {
        clearTimeout(headerTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (signal && signal.aborted) {
        await response.body?.cancel?.().catch(() => {});
        throw abortError();
    }

    const status = response.status;
    const etag = response.headers.get('ETag');
    const lastModified = response.headers.get('Last-Modified');
    const mimeType = response.headers.get('Content-Type') || 'video/mp4';

    if (status === 401 && sessionEnforced()) {
        await response.body?.cancel?.().catch(() => {});
        throw new ApiError('unauthorized', { status: 401 });
    }
    if (status === 416) {
        const total = parseUnsatisfiedTotal(response.headers.get('Content-Range'));
        await response.body?.cancel?.().catch(() => {});
        if (total === null) {
            throw rangeError('rangeInvalid', { status: 416 });
        }
        return { kind: 'unsatisfied', total, etag, lastModified };
    }
    if (status === 200) {
        // Every 200 response is unsupported for offline Range requests:
        // cancel the full body immediately, never buffer it.
        await response.body?.cancel?.().catch(() => {});
        throw rangeError('rangeUnsupported', { status: 200 });
    }
    if (status === 404) {
        await response.body?.cancel?.().catch(() => {});
        throw new ApiError('notFound', { status: 404 });
    }
    if (status === 429) {
        const retryAfterSeconds = Number(response.headers.get('Retry-After')) || 0;
        await response.body?.cancel?.().catch(() => {});
        throw new ApiError('rateLimited', { status: 429, retryAfterSeconds });
    }
    if (status === 502 || status === 503 || status === 504) {
        const retryAfterSeconds = Number(response.headers.get('Retry-After')) || 0;
        await response.body?.cancel?.().catch(() => {});
        throw new ApiError('serverUnavailable', { status, retryAfterSeconds });
    }
    if (status !== 206) {
        await response.body?.cancel?.().catch(() => {});
        throw rangeError(status >= 400 && status < 500 ? 'permanent' : 'serverUnavailable', { status });
    }

    const contentRangeValue = response.headers.get('Content-Range');
    const parsed = parseContentRangeValue(contentRangeValue);
    if (!parsed) {
        await response.body?.cancel?.().catch(() => {});
        // `bytes S-E/*` says the server will not expose a total — this
        // resumable downloader cannot work without one.
        if (contentRangeValue && /^bytes\s+\d+-\d+\/\*$/i.test(String(contentRangeValue))) {
            throw rangeError('rangeTotalUnknown', { status: 206 });
        }
        throw rangeError('rangeInvalid', { status: 206 });
    }
    // The response range must start exactly where we asked, never exceed
    // our requested end, and expose a positive total beyond its own end.
    if (parsed.start !== start || parsed.end > end) {
        await response.body?.cancel?.().catch(() => {});
        throw rangeError('rangeInvalid', { status: 206 });
    }

    const contentEncoding = (response.headers.get('Content-Encoding') || '').trim().toLowerCase();
    const expectedLength = parsed.end - parsed.start + 1;
    const reader = response.body?.getReader?.();
    if (!reader) {
        throw rangeError('rangeInvalid', { status: 206 });
    }

    const startedAt = Date.now();
    const blob = await readRangeBody(reader, expectedLength, startedAt, signal);

    // Content-Length, when present and unencoded, must agree with the
    // counted partial body. Encoded partial representations cannot be
    // matched to byte offsets — reject them.
    if (contentEncoding && contentEncoding !== 'identity') {
        throw rangeError('rangeInvalid', { status: 206 });
    }
    const contentLength = response.headers.get('Content-Length');
    if (contentLength !== null) {
        const declared = Number(contentLength);
        if (!Number.isSafeInteger(declared) || declared !== blob.size) {
            throw rangeError('rangeInvalid', { status: 206 });
        }
    }

    return {
        kind: 'chunk',
        range: { start: parsed.start, end: parsed.end, total: parsed.total },
        blob,
        etag,
        lastModified,
        mimeType
    };
}

/** Only network failures/timeouts/429/502/503/504 are retried transiently. */
function isTransientChunkError(error) {
    if (error instanceof ApiError) {
        return (
            error.kind === 'offline' ||
            error.kind === 'timeout' ||
            (error.kind === 'serverUnavailable' && error.status >= 500) ||
            (error.kind === 'rateLimited' && error.retryAfterSeconds <= 30)
        );
    }
    return false;
}

/**
 * One chunk operation with retry + a single reauthentication allowance.
 * A second 401 is terminal; a Retry-After over 30 s surfaces as a pause
 * (the caller records the retry timestamp) instead of retrying earlier.
 */
async function requestChunk(streamUrl, start, end, signal) {
    let authRetried = false;
    let lastError = null;

    for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt++) {
        if (signal.aborted) throw abortError();
        try {
            return await fetchSingleRange(streamUrl, start, end, signal);
        } catch (error) {
            if (isAbort(error)) throw error;
            lastError = error;

            if (error instanceof ApiError && error.kind === 'unauthorized') {
                if (!authRetried && sessionEnforced()) {
                    authRetried = true;
                    // One reauthentication allowance, cancellable by this
                    // operation without cancelling another caller's login.
                    await waitForGateOrAbort(signal);
                    attempt--; // auth retries do not consume transient budget
                    continue;
                }
                throw error; // second 401 is terminal for this operation
            }

            if (!isTransientChunkError(error)) throw error;
            if (error instanceof ApiError && error.retryAfterSeconds > 30) {
                // Honor Retry-After by pausing with a timestamp instead of
                // retrying earlier than the server asked.
                throw error;
            }
            if (attempt >= MAX_CHUNK_ATTEMPTS - 1) throw lastError;
            const backoff = 500 * Math.pow(2, attempt) + Math.random() * 300;
            await abortableSleep(backoff, signal);
        }
    }
    throw lastError || rangeError('serverUnavailable');
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

function defaultMeta(video, existing, now) {
    const id = video.id;
    return {
        id,
        title: video.title || (existing && existing.title) || '',
        author: video.author || (existing && existing.author) || '',
        thumbnail: video.thumbnail || (existing && existing.thumbnail) || '',
        duration: video.duration || (existing && existing.duration) || 0,
        quality: DOWNLOAD_QUALITY,
        mimeType: (existing && existing.mimeType) || 'video/mp4',
        status: 'downloading',
        totalBytes: (existing && Number.isSafeInteger(existing.totalBytes) && existing.totalBytes > 0
            ? existing.totalBytes
            : 0),
        completedBytes: 0,
        chunkCount: 0,
        etag: (existing && existing.etag) || null,
        etagStrong: Boolean(existing && existing.etagStrong),
        lastModified: (existing && existing.lastModified) || null,
        pausedReason: null,
        retryAfterEpoch: null,
        createdAt: (existing && existing.createdAt) || now,
        updatedAt: now
    };
}

/** Persist a video metadata record (best effort path is caller-chosen). */
function putVideoMeta(meta) {
    return withVideosWrite((store) => {
        const request = store.put({ ...meta });
        return wrapRequest(request);
    });
}

/**
 * A03/A10 — fenced chunk commit. The ownership record is re-checked INSIDE
 * the same transaction that writes the chunk: if another live context has
 * taken ownership (or a cancellation released ours), the write aborts and
 * nothing is committed. Sync-throwing inside the callback aborts the
 * transaction, so data and fencing stay atomic. The ownership GET must be
 * awaited (via the transaction promise) before any decision — a bare
 * request.result is always undefined at callback time.
 */
function writeOwnedChunkTransaction(id, meta, chunk) {
    return withTransaction([VIDEOS_STORE, CHUNKS_STORE, OPERATIONS_STORE], 'readwrite', (tx) => {
        const ownership = tx.objectStore(OPERATIONS_STORE);
        const recordRequest = ownership.get(`owner:${id}`);
        const videos = tx.objectStore(VIDEOS_STORE);
        const chunks = tx.objectStore(CHUNKS_STORE);
        return wrapRequest(recordRequest).then((owned) => {
            if (!owned || owned.owner !== ownerInstance) {
                throw new Error('download ownership lost');
            }
            videos.put({ ...meta });
            chunks.put({
                key: chunk.key,
                videoId: id,
                index: chunk.index,
                start: chunk.start,
                end: chunk.end,
                size: chunk.blob.size,
                blob: chunk.blob
            });
        });
    });
}

/**
 * A03/A10 — fenced authoritative reset for the one permitted
 * representation-change restart. Aborts when ownership was lost.
 */
async function resetForNewRepresentation(id, meta, etag, lastModified, total) {
    await withTransaction([VIDEOS_STORE, CHUNKS_STORE, OPERATIONS_STORE], 'readwrite', (tx) => {
        const ownership = tx.objectStore(OPERATIONS_STORE);
        const recordRequest = ownership.get(`owner:${id}`);
        const videos = tx.objectStore(VIDEOS_STORE);
        const chunks = tx.objectStore(CHUNKS_STORE);
        return wrapRequest(recordRequest).then((owned) => {
            if (!owned || owned.owner !== ownerInstance) {
                throw new Error('download ownership lost');
            }
            deleteChunkRangeInTx(chunks, id);
            const reset = {
                ...meta,
                status: 'downloading',
                completedBytes: 0,
                chunkCount: 0,
                totalBytes: Number.isSafeInteger(total) && total > 0 ? total : 0,
                etag: etag || null,
                etagStrong: isStrongEtag(etag),
                lastModified: lastModified || null,
                updatedAt: Date.now()
            };
            videos.put(reset);
        });
    });
}

/**
 * A03/A10 — fenced per-video deletion in ONE atomic transaction. Only ever
 * deletes a video's records when the durable ownership record permits it:
 * absent (nothing running in any context), expired (the previous owner
 * crashed), or owned by THIS context. A live foreign owner refuses the
 * delete so two tabs can never tear each other's data down. The ownership
 * check happens INSIDE the same transaction as the deletes, so a racing
 * reader can never see a half-deleted video and the baseline's
 * issue-order guarantee for same-context transactions is preserved.
 * Returns true when deleted, false when refused by a live foreign owner.
 */
function deleteVideoDataFenced(id) {
    return withTransaction([VIDEOS_STORE, CHUNKS_STORE, OPERATIONS_STORE], 'readwrite', (tx) => {
        const ownership = tx.objectStore(OPERATIONS_STORE);
        const recordRequest = ownership.get(`owner:${id}`);
        const videos = tx.objectStore(VIDEOS_STORE);
        const chunks = tx.objectStore(CHUNKS_STORE);
        return wrapRequest(recordRequest).then((owned) => {
            // Liveness-aware fencing: refuse only a LIVE foreign owner. An
            // expired claim (crashed/closed context) is deletable — the
            // delete also clears the stale record.
            if (isForeignOwner(owned)) {
                throw new Error('download owned by another live context');
            }
            revokeOfflineUrl(id);
            videos.delete(id);
            deleteChunkRangeInTx(chunks, id);
            ownership.delete(`owner:${id}`);
        });
    }).then(
        () => true,
        (error) => {
            if (error && error.message === 'download owned by another live context') {
                return false;
            }
            throw error;
        }
    );
}

function chunkKey(id, index) {
    return `${id}:${String(index).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Object URL assembly (validated coverage only)
// ---------------------------------------------------------------------------

/**
 * Object URL for a finished download assembled from validated persisted
 * chunks. Descriptors must be contiguous, sized correctly, in ascending
 * order, and the terminal end must match total-1.
 */
export async function offlinePlayUrl(id) {
    if (!offlineSupported() || !id) return null;
    const existing = urlCache.get(id);
    if (existing) return existing;
    try {
        const record = await getRecord(VIDEOS_STORE, id);
        if (record && record.status === 'ready') {
            const total = record.totalBytes;
            if (Number.isSafeInteger(total) && total > 0) {
                const { chunks, validThrough } = await loadValidatedChunks(id);
                if (validThrough === total - 1 && chunks.length > 0) {
                    const parts = chunks.map((chunk) => chunk.blob);
                    const blob = new Blob(parts, { type: record.mimeType || 'video/mp4' });
                    if (blob.size === total) {
                        const url = URL.createObjectURL(blob);
                        urlCache.set(id, url);
                        return url;
                    }
                }
            }
        }
    } catch {
        return null;
    }
    // A05: v1 monolithic downloads stay byte-playable after the v3 upgrade
    // through the preserved legacy store.
    return playLegacyBlobUrl(id);
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

/**
 * Start (or resume) an offline download.
 * @param {{id:string, title?:string, author?:string, thumbnail?:string, duration?:number}} video
 * @returns {Promise<{id:string, status:string}>}
 * Resolves with status 'paused' (partial data kept) or 'ready'; throws
 * Error('cancelled') only for explicit user cancellation.
 */
export async function startDownload(video) {
    if (!offlineSupported()) throw new Error('IndexedDB not available on this device');
    const id = video && video.id;
    if (!id) throw new Error('No video id');

    // Register the per-video operation BEFORE the first async metadata
    // read so simultaneous starts can never create two writers.
    let operation = operations.get(id);
    if (operation && operation.controller.signal.aborted) {
        // A cancelled operation is still cleaning up — wait for its real
        // settlement before a replacement starts.
        if (operation.done) {
            await operation.done.catch(() => {});
        }
        operation = operations.get(id);
    }
    if (operation) {
        // Already downloading: no second writer.
        return { id, status: 'downloading' };
    }

    const op = new Operation(id);
    // A03/A10 race fix: the settlement promise exists SYNCHRONOUSLY at
    // registration. A cancel racing this start can then always await the
    // operation's REAL settlement (abort → cleanup → ownership release)
    // before it deletes records — the baseline's cancel-then-delete
    // ordering survives the new async ownership-claim window.
    let settle;
    let fail;
    const settled = new Promise((resolve, reject) => {
        settle = resolve;
        fail = reject;
    });
    op.done = settled;
    operations.set(id, op);

    // A03/A10: durable ownership across browser contexts. If another LIVE
    // tab (or a reloaded page of the same SPA) owns this download, this
    // context reports the already-downloading state instead of spawning a
    // rival writer. A dead claim (heartbeat expired) is re-claimed.
    let owns = true;
    try {
        const current = await readOwnership(id);
        owns = current.foreign ? false : await claimOwnership(id);
    } catch {
        owns = false;
    }
    if (!owns) {
        if (operations.get(id) === op) operations.delete(id);
        settle({ id, status: 'downloading', ownedByOtherContext: true });
        return { id, status: 'downloading', ownedByOtherContext: true };
    }
    // Cancelled while the claim was being taken: release the claim and bail
    // out before any writer work begins.
    if (op.controller.signal.aborted) {
        await releaseOwnership(id);
        if (operations.get(id) === op) operations.delete(id);
        fail(abortError());
        throw abortError();
    }
    (async () => {
        try {
            const result = await runDownload(video, op);
            settle(result);
        } catch (error) {
            if (isAbort(error) || op.controller.signal.aborted) {
                // Cancellation: records are torn down by cancelDownload's
                // awaited delete, never by the writer itself.
                fail(abortError());
            } else {
                // Network loss / quota / repeated chunk failure: keep
                // partial data and mark paused with accurate metadata.
                await pauseWithError(id, op, error).catch(() => {});
                settle({ id, status: 'paused' });
            }
        } finally {
            // Finalizers delete the map entry only if it still belongs to
            // this operation (never a newer controller).
            if (operations.get(id) === op) operations.delete(id);
            lastEmit.delete(id);
            // A03/A10: the durable claim is released in every exit path so
            // a live context can resume immediately after this one settles.
            releaseOwnership(id);
        }
    })();
    return settled;
}

async function pauseWithError(id, op, error) {
    if (op.controller.signal.aborted) return;
    const latest = await getDownload(id).catch(() => null);
    const meta = latest || { id };
    meta.status = 'paused';
    meta.updatedAt = Date.now();
    if (error instanceof ApiError) {
        meta.pausedReason = error.kind;
        // Any transient answer that told us to wait longer than the in-app
        // backoff budget pauses with a concrete retry timestamp.
        if (error.retryAfterSeconds > 30) {
            meta.retryAfterEpoch = Date.now() + error.retryAfterSeconds * 1000;
        } else {
            meta.retryAfterEpoch = null;
        }
    }
    await putVideoMeta(meta);
    emitChanged(id);
}

async function runDownload(video, op) {
    const id = video.id;
    const signal = op.controller.signal;
    const now = Date.now();

    // Load existing metadata + validate stored chunks BEFORE any write.
    const existing = await getRecord(VIDEOS_STORE, id).catch(() => null);
    const meta = defaultMeta(video, existing, now);
    const loaded = await loadValidatedChunks(id);
    let validThrough = loaded.validThrough;

    if (existing) {
        const storedTotal = meta.totalBytes;
        const storedStatus = existing.status;
        const committedFromChunks = validThrough + 1;

        // Committed progress is DERIVED from validated stored chunk
        // coverage — never trusted from optimistic metadata counters. Repair
        // metadata to the last contiguous valid prefix and drop only the
        // incompatible TRAILING records (legacy inconsistent partial records
        // are never trusted automatically).
        if (loaded.chunks.length > 0) {
            meta.completedBytes = committedFromChunks;
            meta.chunkCount = loaded.chunks.length;
        } else if ((existing.chunkCount || 0) > 0 || (existing.completedBytes || 0) > 0) {
            meta.completedBytes = 0;
            meta.chunkCount = 0;
        }
        meta.totalBytes = storedTotal;

        const claimsBeyondValidated = (existing.completedBytes || 0) > committedFromChunks;
        const recordsBeyondValidated =
            loaded.chunks.length > 0 && (existing.chunkCount || 0) > loaded.chunks.length;
        if (validThrough >= 0 && (claimsBeyondValidated || recordsBeyondValidated)) {
            await repairTrailingChunks(id, null, committedFromChunks);
        } else if (validThrough < 0 && (existing.chunkCount || 0) > 0) {
            // Records were claimed but nothing validated — wipe the
            // inconsistent leftovers and start clean.
            await repairTrailingChunks(id, null, 0);
        }

        if (
            storedStatus === 'ready' &&
            Number.isSafeInteger(storedTotal) &&
            storedTotal > 0 &&
            meta.completedBytes === storedTotal &&
            meta.chunkCount > 0 &&
            validThrough === storedTotal - 1 &&
            loaded.chunks.length === meta.chunkCount
        ) {
            return { id, status: 'ready' };
        }

        // Without any usable validator we cannot prove an interrupted
        // previous run still matches — restart that partial once from zero.
        if (meta.completedBytes > 0 && !meta.etag && !meta.lastModified) {
            meta.completedBytes = 0;
            meta.chunkCount = 0;
            meta.totalBytes = 0;
            await repairTrailingChunks(id, null, 0);
            validThrough = -1;
        }
    }

    // Authoritative mutable state (initialized from validated persisted
    // metadata; updated immediately after each accepted response).
    let offset = meta.completedBytes || 0;
    let nextChunkIndex = meta.chunkCount || 0;
    let knownTotal = meta.totalBytes > 0 ? meta.totalBytes : null;
    let knownEtag = meta.etag || null;
    let knownEtagStrong = Boolean(meta.etagStrong);
    let knownLastModified = meta.lastModified || null;
    let sourceRestarts = 0;

    meta.status = 'downloading';
    meta.pausedReason = null;
    meta.retryAfterEpoch = null;
    meta.updatedAt = now;
    await putVideoMeta(meta);
    emitChanged(id);

    const streamUrl = `/api/stream/${encodeURIComponent(id)}?quality=${DOWNLOAD_QUALITY}`;

    const adoptValidators = (etag, lastModified) => {
        if (etag !== null && etag !== undefined) {
            knownEtag = etag;
            knownEtagStrong = isStrongEtag(etag);
        }
        if (lastModified !== null && lastModified !== undefined) {
            knownLastModified = lastModified;
        }
    };

    /** Detect whether the representation changed under our feet. */
    const representationChanged = (etag, lastModified, total) => {
        const newStrong = isStrongEtag(etag);
        if (knownEtag !== null && etag !== null && etag !== knownEtag && (knownEtagStrong || newStrong)) {
            return true; // changed established ETag (either side strong)
        }
        if (knownEtagStrong && (etag === null || etag === undefined)) {
            return true; // loss of an established strong validator
        }
        if (knownTotal !== null && total !== null && knownTotal !== total) {
            return true; // changed total
        }
        if (
            !knownEtagStrong &&
            knownLastModified !== null &&
            lastModified !== null &&
            knownLastModified !== lastModified &&
            (knownEtag === null || knownEtag === etag || etag === null || etag === undefined)
        ) {
            return true; // Last-Modified establishes identity when no strong ETag exists
        }
        return false;
    };

    /** One permitted clean restart for this invocation. */
    const restartForNewRepresentation = async (etag, lastModified, total) => {
        if (sourceRestarts >= MAX_SOURCE_RESTARTS) {
            throw rangeError('sourceChanged');
        }
        sourceRestarts++;
        // Discard only this video's partial chunks + revoke its cached
        // playback URL, then atomically reset progress/metadata — fenced
        // against a lost ownership claim (A03/A10).
        await resetForNewRepresentation(id, meta, etag, lastModified, total);
        offset = 0;
        nextChunkIndex = 0;
        knownTotal = Number.isSafeInteger(total) && total > 0 ? total : null;
        knownEtag = etag || null;
        knownEtagStrong = isStrongEtag(etag);
        knownLastModified = lastModified || null;
        meta.completedBytes = 0;
        meta.chunkCount = 0;
        meta.totalBytes = knownTotal || 0;
        meta.etag = knownEtag;
        meta.etagStrong = knownEtagStrong;
        meta.lastModified = knownLastModified;
        meta.updatedAt = Date.now();
        emitChanged(id);
    };

    // offset===total is authoritative only when every byte is covered by a
    // committed chunk; chunks are committed contiguously so offset alone
    // equals coverage whenever we advanced through persisted chunks.
    const canFinish = (total) => Number.isSafeInteger(total) && total >= 0 && offset === total;

    for (;;) {
        if (signal.aborted) throw abortError();

        if (knownTotal !== null) {
            if (offset > knownTotal) {
                // Offset past the total is corruption, not completion.
                throw rangeError('rangeInvalid');
            }
            if (canFinish(knownTotal)) {
                // Complete only when a numeric total + exact committed byte
                // count agree (contiguous by construction).
                break;
            }
        }

        const start = offset;
        const end =
            knownTotal !== null ? Math.min(start + CHUNK_BYTES - 1, knownTotal - 1) : start + CHUNK_BYTES - 1;

        const result = await requestChunk(streamUrl, start, end, signal);
        if (signal.aborted) throw abortError();

        if (result.kind === 'unsatisfied') {
            const { total } = result;
            if (knownTotal === null) {
                // No bytes committed yet: learn the authoritative total and
                // continue (or finish immediately when the file is empty).
                if (total === 0 && offset === 0) {
                    knownTotal = 0;
                    break;
                }
                if (total > 0 && offset === 0) {
                    knownTotal = total;
                    continue; // loop re-checks completion with a known total
                }
                throw rangeError('rangeInvalid');
            }
            if (total === knownTotal) {
                if (canFinish(knownTotal)) {
                    // 416 after verified completion, validators consistent.
                    const changed = representationChanged(result.etag, result.lastModified, total);
                    if (!changed) break;
                    throw rangeError('rangeInvalid');
                }
                // 416 while bytes are still missing: inconsistent.
                throw rangeError('rangeInvalid');
            }
            // A different N proves representation change → single restart.
            if (sourceRestarts >= MAX_SOURCE_RESTARTS) {
                throw rangeError('sourceChanged');
            }
            await restartForNewRepresentation(result.etag, result.lastModified, total);
            continue;
        }

        // Representation-change checks happen BEFORE writing anything.
        if (representationChanged(result.etag, result.lastModified, result.range.total)) {
            await restartForNewRepresentation(result.etag, result.lastModified, result.range.total);
            continue;
        }

        // Adopt the newly learned total/validators into both local state
        // and metadata.
        knownTotal = result.range.total;
        adoptValidators(result.etag, result.lastModified);

        const respStart = result.range.start;
        const respEnd = result.range.end;
        const totalNow = result.range.total;

        meta.completedBytes = respEnd + 1;
        meta.chunkCount = nextChunkIndex + 1;
        meta.totalBytes = totalNow;
        meta.etag = knownEtag;
        meta.etagStrong = knownEtagStrong;
        meta.lastModified = knownLastModified;
        meta.mimeType = result.mimeType || meta.mimeType || 'video/mp4';
        meta.status = 'downloading';
        meta.updatedAt = Date.now();

        // Persist the chunk + its updated metadata as ONE transaction,
        // fenced against a lost ownership claim (A03/A10).
        await writeOwnedChunkTransaction(id, meta, {
            key: chunkKey(id, nextChunkIndex),
            index: nextChunkIndex,
            start: respStart,
            end: respEnd,
            blob: result.blob
        });

        // Advance from the response's ACTUAL end (shorter valid responses
        // are fine); never derive the next index with floor(offset/CHUNK).
        nextChunkIndex = meta.chunkCount;
        offset = respEnd + 1;

        const total = knownTotal;
        if (total !== null && total > 0) {
            const progress = Math.min(1, offset / total);
            if (Date.now() - throttleProgress(id) >= PROGRESS_EVENT_MS) {
                emitProgress(id, progress, offset);
            }
            if (canFinish(total)) break;
        } else if (total === 0) {
            break;
        }
    }

    if (knownTotal !== null && offset === knownTotal) {
        // Ready only after the numeric total, exact committed byte count and
        // complete ordered chunk coverage agree.
        const committed = await getRecord(VIDEOS_STORE, id).catch(() => null);
        const coverage = committed
            ? await loadValidatedChunks(id).catch(() => ({ chunks: [], validThrough: -1 }))
            : { chunks: [], validThrough: -1 };
        const coveredFully =
            coverage.chunks.length > 0 &&
            coverage.chunks.length === (committed ? committed.chunkCount : 0) &&
            coverage.validThrough === knownTotal - 1;
        if (knownTotal === 0 || coveredFully) {
            const finalMeta = {
                ...(committed || meta),
                status: 'ready',
                completedBytes: knownTotal,
                chunkCount: knownTotal === 0 ? 0 : coverage.chunks.length,
                totalBytes: knownTotal,
                updatedAt: Date.now()
            };
            await putVideoMeta(finalMeta); // ready commits BEFORE progress=1
            emitProgress(id, 1, knownTotal);
            emitChanged(id);

            if (!persistRequested && typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
                persistRequested = true;
                navigator.storage.persist().catch(() => {});
            }
            return { id, status: 'ready' };
        }
    }

    // Reached with knownTotal null or incomplete coverage — pause.
    throw rangeError('rangeTotalUnknown');
}

/**
 * Cancel an in-flight download AND delete any partial data (explicit user
 * intent — only cancel/remove delete partial downloads). Cancellation
 * aborts the operation, AWAITS its settlement, then deletes its records in
 * a real awaited transaction; a replacement start never begins before that
 * cleanup completes.
 */
export async function cancelDownload(id) {
    if (!id) return;
    const operation = operations.get(id);
    if (operation) {
        if (!operation.controller.signal.aborted) operation.controller.abort();
        if (operation.done) {
            // A03/A10 race fix: op.done exists from the synchronously
            // registered deferred promise, so this ALWAYS awaits the real
            // settlement (abort → cleanup → ownership release) before the
            // delete below — no window where delete runs before cleanup.
            await operation.done.catch(() => {});
        }
    }
    // A03/A10: refuse to tear down data while ANOTHER live context owns
    // the download — a second tab cannot abort a foreign writer or delete
    // its partial chunks. This context's own claim (or an absent/expired
    // one) deletes. Explicit user intent also reaches the preserved v1
    // legacy `blobs` store.
    const fenced = await deleteVideoDataFenced(id);
    if (!fenced) {
        emitChanged(id);
        return;
    }
    await deleteLegacyBlobRecord(id);
    lastEmit.delete(id);
    emitChanged(id);
}

/** Delete a finished download or cancel+delete an in-flight one. */
export async function removeDownload(id) {
    if (!id) return;
    if (operations.has(id)) {
        await cancelDownload(id);
        return;
    }
    const fenced = await deleteVideoDataFenced(id);
    if (!fenced) {
        emitChanged(id);
        return;
    }
    await deleteLegacyBlobRecord(id);
    lastEmit.delete(id);
    emitChanged(id);
}
