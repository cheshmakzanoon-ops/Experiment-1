// offlineHarness.mjs — shared deterministic harness for the offline
// downloader regression tests (A03/A05/A10). Mirrors the conventions of
// tests/offline-download.test.js: fake-indexeddb provides the IndexedDB
// engine, chunk fetches run through the real production code, and only the
// authentication gate in api.js is mockable (the mock itself must be
// declared in each test file — vi.mock is hoisted per file).
//
// All raw DB opens are VERSIONLESS: the production service owns the schema
// version (v3 since the durable-ownership migration), so a raw open with a
// pinned lower version would fail once the service has upgraded the
// database.

import { vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

export const DB_NAME = 'yt-offline-db'
export { IDBKeyRange }

// ---------------------------------------------------------------------------
// Deterministic bytes + mock HTTP server
// ---------------------------------------------------------------------------

export const CHUNK = 2 * 1024 * 1024

/** Deterministic non-uniform bytes (mulberry32) of the requested length. */
export function makeBytes(seed, length) {
    let a = seed >>> 0
    const rand = () => {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(rand() * 256)
    return bytes
}

/**
 * A minimal Response-shaped object driven by a REAL ReadableStream so the
 * production reader (getReader/read/cancel/releaseLock) runs untouched.
 */
export function streamResponse({ status = 206, headers = {}, bytes = null, pull = null, onCancel = null }) {
    const headerMap = new Map(Object.entries(headers))
    let cancelCount = 0
    const stream = new ReadableStream(
        {
            start(controller) {
                this.controller = controller
                if (bytes !== null) {
                    controller.enqueue(bytes)
                    controller.close()
                } else if (!pull) {
                    controller.close()
                }
            },
            pull() {
                if (pull && this.controller && !this.used) {
                    this.used = true
                    const controller = this.controller
                    return Promise.resolve(pull(controller)).catch(() => {
                        try {
                            controller.error(new Error('stream aborted'))
                        } catch {
                            /* ignore */
                        }
                    })
                }
                return undefined
            },
            cancel() {
                cancelCount++
                if (onCancel) onCancel()
            }
        },
        { highWaterMark: 0 }
    )
    return {
        status,
        headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? null },
        body: stream,
        get cancelled() {
            return cancelCount > 0
        }
    }
}

export function makeHeaders({ start, end, total, etag, lastModified, mime, contentLength, contentRange, encoding }) {
    const h = {}
    if (contentRange !== undefined) h['content-range'] = contentRange
    else h['content-range'] = `bytes ${start}-${end}/${total}`
    if (contentLength !== undefined) h['content-length'] = String(contentLength)
    else h['content-length'] = String(end - start + 1)
    if (etag !== undefined) h.etag = etag
    if (lastModified !== undefined) h['last-modified'] = lastModified
    if (mime !== undefined) h['content-type'] = mime
    if (encoding !== undefined) h['content-encoding'] = encoding
    return h
}

/**
 * Request-recording fake fetch serving byte ranges of `source` from memory.
 * opts.maxChunkLen caps how many bytes each 206 actually serves; opts.onRequest
 * can return a custom Response-shaped object or delay (then return null to use
 * the default slice).
 */
export function rangeServer(source, opts = {}) {
    const requests = []
    let index = 0
    const total = source.length

    const fetchImpl = async (_url, init = {}) => {
        const rangeHeader = (init.headers && init.headers.Range) || ''
        const match = String(rangeHeader).match(/^bytes=(\d+)-(\d+)$/)
        const record = { index, rangeHeader, start: null, end: null }
        if (match) {
            record.start = Number(match[1])
            record.end = Number(match[2])
        }
        requests.push(record)
        const reqIndex = index++

        if (opts.onRequest) {
            const custom = await opts.onRequest(reqIndex, record)
            if (custom) return custom
        }

        if (record.start === null || record.start >= total) {
            return streamResponse({
                status: 416,
                headers: {
                    'content-range': `bytes */${total}`,
                    etag: opts.etag || `"v1-${total}"`
                }
            })
        }

        const requestedEnd = record.end === null ? total - 1 : Math.min(record.end, total - 1)
        const cap = opts.maxChunkLen ? Math.min(requestedEnd, record.start + opts.maxChunkLen - 1) : requestedEnd
        const end = Math.max(cap, record.start)
        record.servedEnd = end
        const slice = source.slice(record.start, end + 1)
        const headers = makeHeaders({
            start: record.start,
            end,
            total,
            etag: opts.etag || `"v1-${total}"`,
            lastModified: opts.lastModified,
            mime: opts.mime || 'video/mp4'
        })
        return streamResponse({ status: 206, headers, bytes: slice })
    }

    return { fetchImpl, requests }
}

// ---------------------------------------------------------------------------
// IndexedDB raw helpers
// ---------------------------------------------------------------------------

export function rawOpen() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME)
        request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'id' })
            if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'key' })
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

export async function rawVideo(id) {
    const db = await rawOpen()
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('videos', 'readonly')
            const req = tx.objectStore('videos').get(id)
            req.onsuccess = () => resolve(req.result || null)
            req.onerror = () => reject(req.error)
        })
    } finally {
        db.close()
    }
}

export async function rawChunks(id) {
    const db = await rawOpen()
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('chunks', 'readonly')
            const range = IDBKeyRange.bound(`${id}:`, `${id}:\uffff`)
            const out = []
            const req = tx.objectStore('chunks').openCursor(range)
            req.onsuccess = () => {
                const cursor = req.result
                if (!cursor) return resolve(out)
                out.push(cursor.value)
                cursor.continue()
            }
            req.onerror = () => reject(req.error)
        })
    } finally {
        db.close()
    }
}

export async function rawObjectStoreNames() {
    const db = await rawOpen()
    try {
        return Array.from(db.objectStoreNames)
    } finally {
        db.close()
    }
}

export async function rawLegacyRow(id) {
    const db = await rawOpen()
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('blobs', 'readonly')
            const req = tx.objectStore('blobs').get(id)
            req.onsuccess = () => resolve(req.result || null)
            req.onerror = () => reject(req.error)
        })
    } finally {
        db.close()
    }
}

export async function rawOwnerRow(id) {
    const db = await rawOpen()
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('operations', 'readonly')
            const req = tx.objectStore('operations').get(`owner:${id}`)
            req.onsuccess = () => resolve(req.result || null)
            req.onerror = () => reject(req.error)
        })
    } finally {
        db.close()
    }
}

export async function rawPutOwnerRow(id, record) {
    const db = await rawOpen()
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction('operations', 'readwrite')
            tx.objectStore('operations').put({ videoId: `owner:${id}`, ...record })
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
            tx.onabort = () => reject(tx.error || new Error('put aborted'))
        })
    } finally {
        db.close()
    }
}

/**
 * Seed a GENUINE legacy v2 database (no `operations` store, plus an optional
 * v1-era `blobs` row) and close it, so the production service performs the
 * real v2→v3 upgrade against it. `meta` may be null to skip the videos row.
 */
export async function seedLegacyV2Database(id, { blobBytes, meta = {}, legacy = {} } = {}) {
    const existing = await indexedDB.databases().catch(() => [])
    const present = Array.isArray(existing) && existing.some((d) => d && d.name === DB_NAME)
    if (present) {
        await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(DB_NAME)
            request.onsuccess = () => resolve()
            request.onerror = () => reject(request.error)
            request.onblocked = () => resolve()
        })
    }
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 2)
        request.onupgradeneeded = () => {
            const upgraded = request.result
            if (!upgraded.objectStoreNames.contains('videos')) upgraded.createObjectStore('videos', { keyPath: 'id' })
            if (!upgraded.objectStoreNames.contains('chunks')) upgraded.createObjectStore('chunks', { keyPath: 'key' })
            if (legacy.blob) {
                upgraded.createObjectStore('blobs', { keyPath: 'id' })
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(legacy.blob ? ['videos', 'blobs'] : 'videos', 'readwrite')
            if (legacy.blob) {
                tx.objectStore('blobs').put({
                    id,
                    blob: new Blob(legacy.blob, { type: legacy.mime || 'video/mp4' }),
                    title: legacy.title || '',
                    author: legacy.author || '',
                    mimeType: legacy.mime || 'video/mp4',
                    createdAt: legacy.createdAt || 0,
                    updatedAt: legacy.updatedAt || 0
                })
            }
            if (meta) {
                tx.objectStore('videos').put({ id, ...meta })
            }
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
            tx.onabort = () => reject(tx.error || new Error('seed aborted'))
        })
    } finally {
        db.close()
    }
}

// ---------------------------------------------------------------------------
// Service loading (fresh module instance per test)
// ---------------------------------------------------------------------------

export function video(id, overrides = {}) {
    return { id, title: `Video ${id}`, author: 'Test Channel', ...overrides }
}

let service = null
let seenUrls = []
let urlBlob = null

/**
 * Load a FRESH production offlineService module instance against the current
 * global indexedDB, with a stubbed URL for object-URL observation.
 */
export async function loadService() {
    vi.resetModules()
    service = await import('../../src/frontend/js/services/offlineService.js')
    seenUrls = []
    urlBlob = null
    vi.stubGlobal('URL', {
        createObjectURL: (blob) => {
            seenUrls.push(blob)
            urlBlob = blob
            return `blob:mock-${seenUrls.length}`
        },
        revokeObjectURL: () => {}
    })
    return service
}

export function getService() {
    return service
}

export function getSeenUrls() {
    return seenUrls
}

export function getUrlBlob() {
    return urlBlob
}

/** Standard per-test global setup: fresh IDB factory + fresh service. */
export async function beforeEachHarness() {
    vi.unstubAllGlobals()
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    await loadService()
}

export function afterEachHarness() {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
}
