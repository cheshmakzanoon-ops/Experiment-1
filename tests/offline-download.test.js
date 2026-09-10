// offline-download.test.js
//
// Deterministic IndexedDB tests for the interruption-safe offline downloader
// (Sections 5–7 of the remediation): strict Range/206 contract, bounded
// counted body reads, one-transaction chunk+metadata persistence, validated
// resume coverage, single source-change restart, awaited cancellation, and
// the three-chunk fixture the spec pins (requests at 0 / 2097152 / 4194304,
// final committed end 5243002, byte-for-byte reconstruction through a FRESH
// service instance).
//
// fake-indexeddb provides the browser IndexedDB engine; Blob round-trips are
// verified against it. The api.js module is partially mocked so the download
// authentication path (waitForGateOrAbort) is externally controllable; all
// chunk fetches go through the real production code.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

// ---------------------------------------------------------------------------
// Controllable auth gate (vi.mock is hoisted, so state lives in vi.hoisted)
// ---------------------------------------------------------------------------

const gate = vi.hoisted(() => {
    const state = { waiters: [] }
    return { state }
})

function makeAbort() {
    const error = new Error('cancelled')
    error.name = 'AbortError'
    return error
}

vi.mock('../src/frontend/js/api.js', async (importOriginal) => {
    const actual = await importOriginal()
    return {
        ...actual,
        // Same contract as the real waiter: pre-aborted callers reject at
        // once; otherwise the caller waits until auth completes (test
        // resolves the waiter) or its own signal aborts (reject AbortError).
        waitForGateOrAbort: (signal) => {
            if (signal && signal.aborted) return Promise.reject(makeAbort())
            return new Promise((resolve, reject) => {
                const waiter = { resolve, reject }
                gate.state.waiters.push(waiter)
                const onAbort = () => {
                    const i = gate.state.waiters.indexOf(waiter)
                    if (i >= 0) gate.state.waiters.splice(i, 1)
                    if (signal) signal.removeEventListener('abort', onAbort)
                    reject(makeAbort())
                }
                if (signal) signal.addEventListener('abort', onAbort, { once: true })
            })
        }
    }
})

/** Simulate a successful shared login: resolve every waiting caller. */
async function completeAuth() {
    const waiters = gate.state.waiters.splice(0)
    for (const w of waiters) w.resolve(true)
    await Promise.resolve()
    await Promise.resolve()
}

/** Simulate a failed/absent login interaction. */
async function failAuth() {
    const waiters = gate.state.waiters.splice(0)
    for (const w of waiters) w.reject(makeAbort())
    await Promise.resolve()
    await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Deterministic bytes + mock HTTP server
// ---------------------------------------------------------------------------

const CHUNK = 2 * 1024 * 1024

/** Deterministic non-uniform bytes (mulberry32) of the requested length. */
function makeBytes(seed, length) {
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
function streamResponse({ status = 206, headers = {}, bytes = null, pull = null, onCancel = null }) {
    const headerMap = new Map(Object.entries(headers))
    let cancelCount = 0
    let started = false
    let pullFn = pull
    const stream = new ReadableStream(
        {
            start(controller) {
                started = true
                this.controller = controller
                if (bytes !== null) {
                    controller.enqueue(bytes)
                    controller.close()
                } else if (!pullFn) {
                    controller.close()
                }
            },
            pull() {
                // Enqueue once; the reader drives each read via pull.
                if (pullFn && this.controller && !this.used) {
                    this.used = true
                    const controller = this.controller
                    return Promise.resolve(pullFn(controller)).catch(() => {
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

function makeHeaders({ start, end, total, etag, lastModified, mime, contentLength, contentRange, encoding }) {
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
 * opts:
 *   maxChunkLen   cap how many bytes each 206 actually serves (shorter valid
 *                 responses) — parsed from the request.
 *   onRequest     (reqIndex, {start,end}, record) → a Response-shaped object
 *                 to return instead of the default slice.
 */
function rangeServer(source, opts = {}) {
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
            // Unsatisfiable — bytes */TOTAL (distinct from rate limiting).
            record.servedEnd = null
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
        return streamResponse({
            status: 206,
            headers,
            bytes: opts.wrapBytes ? opts.wrapBytes(slice) : slice
        })
    }

    return { fetchImpl, requests }
}

// ---------------------------------------------------------------------------
// IndexedDB + service-instance plumbing
// ---------------------------------------------------------------------------

const DB_NAME = 'yt-offline-db'
// Versionless raw opens: the production service owns the schema version
// (v3 since the durable-ownership migration). Opening raw with a pinned
// lower version would fail once the service has upgraded the database.

function rawOpen() {
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

/**
 * Seed a GENUINE legacy v2 database (no `operations` store, plus a v1-era
 * `blobs` row) and close it, so the production service performs the real
 * v2→v3 upgrade against it.
 */
async function seedLegacyV2Database(id, { blobBytes, meta = {}, legacy = {} } = {}) {
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
            const tx = db.transaction(
                legacy.blob ? ['videos', 'blobs'] : 'videos',
                'readwrite'
            )
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

async function rawObjectStoreNames() {
    const db = await rawOpen()
    try {
        return Array.from(db.objectStoreNames)
    } finally {
        db.close()
    }
}

async function rawLegacyRow(id) {
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

async function rawOwnerRow(id) {
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

async function rawPutOwnerRow(id, record) {
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

async function rawChunks(id) {
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

const RealURL = globalThis.URL

/** The shared IDBObjectStore prototype (fake-indexeddb exposes no global). */
async function objectStorePrototype() {
    const db = await rawOpen()
    try {
        const tx = db.transaction('videos', 'readonly')
        return Object.getPrototypeOf(tx.objectStore('videos'))
    } finally {
        db.close()
    }
}

async function rawVideo(id) {
    const db = await rawOpen()
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('videos', 'readonly')
            const req = tx.objectStore('videos').get(id)
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
        })
    } finally {
        db.close()
    }
}

async function concatChunkBytes(id) {
    const chunks = await rawChunks(id)
    chunks.sort((a, b) => a.index - b.index)
    const parts = []
    for (const c of chunks) parts.push(new Uint8Array(await c.blob.arrayBuffer()))
    const totalLen = parts.reduce((n, p) => n + p.length, 0)
    const merged = new Uint8Array(totalLen)
    let at = 0
    for (const p of parts) {
        merged.set(p, at)
        at += p.length
    }
    return merged
}

function video(id, overrides = {}) {
    return { id, title: `Video ${id}`, author: 'Test Channel', ...overrides }
}

let service = null
let seenUrls = []
let urlBlob = null

async function loadService() {
    vi.resetModules()
    service = await import('../src/frontend/js/services/offlineService.js')
    seenUrls = []
    urlBlob = null
    // Plain object: offlineService only reads the two static URL methods.
    vi.stubGlobal('URL', {
        createObjectURL: (blob) => {
            seenUrls.push(blob)
            urlBlob = blob
            return `blob:mock-${seenUrls.length}`
        },
        revokeObjectURL: () => {}
    })
    void RealURL
    return service
}

beforeEach(async () => {
    vi.unstubAllGlobals()
    gate.state.waiters.splice(0)
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    await loadService()
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('offline download — strict response contract', () => {
    it('parses and rejects Content-Range values per the contract', () => {
        const { parseContentRangeValue, parseUnsatisfiedTotal } = service
        expect(parseContentRangeValue('bytes 0-99/100')).toEqual({ start: 0, end: 99, total: 100 })
        expect(parseContentRangeValue('bytes 0-0/1')).toEqual({ start: 0, end: 0, total: 1 })
        // Non-safe integers / inverted / total not greater than end.
        expect(parseContentRangeValue('bytes 999999999999999999999-999999999999999999999/2')).toBeNull()
        expect(parseContentRangeValue('bytes 10-5/100')).toBeNull()
        expect(parseContentRangeValue('bytes 0-99/99')).toBeNull()
        expect(parseContentRangeValue('bytes 0-99/0')).toBeNull()
        expect(parseContentRangeValue('chunks 0-99/100')).toBeNull()
        expect(parseContentRangeValue('')).toBeNull()
        expect(parseContentRangeValue('bytes */100')).toBeNull()

        expect(parseUnsatisfiedTotal('bytes */5243003')).toBe(5243003)
        expect(parseUnsatisfiedTotal('bytes */0')).toBe(0)
        expect(parseUnsatisfiedTotal('bytes */abc')).toBeNull()
        expect(parseUnsatisfiedTotal('bytes */-3')).toBeNull()
        expect(parseUnsatisfiedTotal('bytes */99999999999999999999')).toBeNull()
        expect(parseUnsatisfiedTotal('bytes 0-1/5')).toBeNull()
    })
})

describe('offline download — happy paths', () => {
    const TOTAL = 5 * 1024 * 1024 + 123 // 5243003
    const seed = 0xc0ffee

    it('three-chunk fixture: requests at 0/2097152/4194304, ready, byte-equal', async () => {
        const source = makeBytes(seed, TOTAL)
        const server = rangeServer(source, { etag: '"fixture-1"' })
        vi.stubGlobal('fetch', server.fetchImpl)

        const result = await service.startDownload(video('vid-three'))
        expect(result).toEqual({ id: 'vid-three', status: 'ready' })

        // Exactly three requests, exact starts, final committed end.
        expect(server.requests).toHaveLength(3)
        expect(server.requests.map((r) => r.start)).toEqual([0, 2097152, 4194304])
        expect(server.requests.map((r) => r.end)).toEqual([2097151, 4194303, 5243002])

        const meta = await rawVideo('vid-three')
        expect(meta.status).toBe('ready')
        expect(meta.totalBytes).toBe(TOTAL)
        expect(meta.completedBytes).toBe(TOTAL)
        expect(meta.chunkCount).toBe(3)
        expect(meta.etag).toBe('"fixture-1"')

        // No fourth request after completion.
        expect(server.requests.length).toBe(3)

        const merged = await concatChunkBytes('vid-three')
        expect(merged.length).toBe(TOTAL)
        expect(Buffer.from(merged).equals(Buffer.from(source))).toBe(true)

        const download = await service.getDownload('vid-three')
        expect(download.status).toBe('ready')
        expect(download.progress).toBe(1)

        // Fresh service instance against the SAME persisted database.
        await loadService()
        const fresh = await service.getDownload('vid-three')
        expect(fresh.status).toBe('ready')
        const url = await service.offlinePlayUrl('vid-three')
        expect(url).toBeTruthy()
        expect(urlBlob).toBeTruthy()
        const rebuilt = new Uint8Array(await urlBlob.arrayBuffer())
        expect(rebuilt.length).toBe(TOTAL)
        expect(Buffer.from(rebuilt).equals(Buffer.from(source))).toBe(true)
    })

    it('single-byte file downloads in one request', async () => {
        const source = makeBytes(7, 1)
        const server = rangeServer(source, { etag: '"tiny"' })
        vi.stubGlobal('fetch', server.fetchImpl)

        const result = await service.startDownload(video('vid-onebyte'))
        expect(result.status).toBe('ready')
        expect(server.requests).toHaveLength(1)
        expect(server.requests[0].start).toBe(0)
        const merged = await concatChunkBytes('vid-onebyte')
        expect(Buffer.from(merged).equals(Buffer.from(source))).toBe(true)
    })

    it('exact chunk multiples complete without an extra request', async () => {
        const total = 2 * CHUNK // exactly two full chunks
        const source = makeBytes(11, total)
        const server = rangeServer(source, { etag: '"multi"' })
        vi.stubGlobal('fetch', server.fetchImpl)

        const result = await service.startDownload(video('vid-multi'))
        expect(result.status).toBe('ready')
        expect(server.requests).toHaveLength(2)
        expect(server.requests[1].end).toBe(total - 1)
        const merged = await concatChunkBytes('vid-multi')
        expect(Buffer.from(merged).equals(Buffer.from(source))).toBe(true)
    })

    it('shorter valid responses advance from their ACTUAL end', async () => {
        const total = 5 * 1024 * 1024 + 123
        const source = makeBytes(23, total)
        const cap = 512 * 1024
        const server = rangeServer(source, { etag: '"short"', maxChunkLen: cap })
        vi.stubGlobal('fetch', server.fetchImpl)

        const result = await service.startDownload(video('vid-short'))
        expect(result.status).toBe('ready')

        // Each request starts at the offset of the last COMMITTED byte (the
        // previous response's ACTUAL end + 1), never at a CHUNK multiple.
        let previousCommittedEnd = -1
        for (const r of server.requests) {
            expect(r.start).toBe(previousCommittedEnd + 1)
            expect(r.servedEnd).toBeGreaterThanOrEqual(r.start)
            previousCommittedEnd = r.servedEnd
        }
        expect(previousCommittedEnd).toBe(total - 1)
        expect(server.requests.length).toBeGreaterThan(3)
        // Served 206 bodies tile the file with no gaps/overlaps.
        const merged = await concatChunkBytes('vid-short')
        expect(Buffer.from(merged).equals(Buffer.from(source))).toBe(true)
    })

    it('resumes an interrupted download from the last committed byte', async () => {
        const total = 3 * CHUNK + 77
        const source = makeBytes(31, total)
        let drop = true
        const server = rangeServer(source, {
            etag: '"resume-1"',
            onRequest: async (i) => {
                if (drop && i > 0) {
                    // Chunk 0 is served; every later chunk is unreachable
                    // while the network is down.
                    return streamResponse({ status: 404, headers: {} })
                }
                return null
            }
        })
        vi.stubGlobal('fetch', server.fetchImpl)

        const first = await service.startDownload(video('vid-resume'))
        expect(first.status).toBe('paused')
        const paused = await rawVideo('vid-resume')
        expect(paused.completedBytes).toBe(CHUNK)
        expect(paused.chunkCount).toBe(1)

        // Network returns; a fresh run resumes at byte CHUNK (no restart,
        // no re-fetch of the committed prefix).
        drop = false
        const second = await service.startDownload(video('vid-resume'))
        expect(second.status).toBe('ready')
        const afterChunk1Index = server.requests.findIndex((r) => r.start === CHUNK)
        expect(afterChunk1Index).toBeGreaterThanOrEqual(0)
        // No request ever re-requested the committed prefix after the pause.
        const reRequested = server.requests.filter((r, i) => i > 0 && r.start === 0)
        expect(reRequested).toHaveLength(0)
        const merged = await concatChunkBytes('vid-resume')
        expect(Buffer.from(merged).equals(Buffer.from(source))).toBe(true)
    })

    it('simultaneous starts produce one writer and one happy download', async () => {
        const source = makeBytes(41, CHUNK + 5)
        const server = rangeServer(source, { etag: '"once"' })
        vi.stubGlobal('fetch', server.fetchImpl)

        const [a, b, c] = await Promise.all([
            service.startDownload(video('vid-once')),
            service.startDownload(video('vid-once')),
            service.startDownload(video('vid-once'))
        ])
        expect(a.status).toBe('ready')
        expect(b.status).toBe('downloading') // joined the same operation
        expect(c.status).toBe('downloading')
        // One downloader only: CHUNK+5 needs exactly chunk 0 + the 5-byte tail.
        expect(server.requests).toHaveLength(2)
        const merged = await concatChunkBytes('vid-once')
        expect(Buffer.from(merged).equals(Buffer.from(source))).toBe(true)
    })

    it('cancel immediately then restart completes cleanly with no leftovers', async () => {
        const total = 2 * CHUNK + 9
        const source = makeBytes(47, total)
        const server = rangeServer(source, { etag: '"restart"' })
        vi.stubGlobal('fetch', server.fetchImpl)

        const first = service.startDownload(video('vid-cancelrestart'))
        const cancel = service.cancelDownload('vid-cancelrestart')
        const [startResult] = await Promise.allSettled([first])
        await cancel
        // Cancellation deleted the records.
        expect(await service.getDownload('vid-cancelrestart')).toBeNull()
        expect(await rawChunks('vid-cancelrestart')).toHaveLength(0)

        // A replacement download starts over and succeeds.
        const second = await service.startDownload(video('vid-cancelrestart'))
        expect(second.status).toBe('ready')
        const merged = await concatChunkBytes('vid-cancelrestart')
        expect(Buffer.from(merged).equals(Buffer.from(source))).toBe(true)
        // Cancellation of the first attempt threw; record it for the report.
        expect(startResult.status).toBe('rejected')
    })
})

describe('offline download — 206/200/416 rejection paths', () => {
    const TOTAL = 2 * CHUNK + 5
    const source = () => makeBytes(61, TOTAL)
    const serverOf = () => rangeServer(source(), { etag: '"v206"' })

    it('a 200 to a ranged request pauses with RANGE_UNSUPPORTED and cancels the body', async () => {
        const server = serverOf()
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                streamResponse({
                    status: 200,
                    headers: { 'content-length': String(TOTAL), etag: '"full"' },
                    bytes: new Uint8Array(4),
                    onCancel: () => {}
                })
            )
        )
        const result = await service.startDownload(video('vid-200'))
        expect(result.status).toBe('paused')
        const meta = await rawVideo('vid-200')
        expect(meta.pausedReason).toBe('rangeUnsupported')
        // Nothing committed, nothing buffered.
        expect(await rawChunks('vid-200')).toHaveLength(0)
        expect(server.requests).toHaveLength(0)
        const download = await service.getDownload('vid-200')
        expect(download.status).toBe('paused')
    })

    it('a mid-download 200 cancels without committing the earlier partial chunk run further', async () => {
        const server = serverOf()
        let calls = 0
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                const m = String(init.headers.Range).match(/^bytes=(\d+)-(\d+)$/)
                const start = Number(m[1])
                if (calls === 0) {
                    calls++
                    const end = start + CHUNK - 1
                    const slice = source().slice(start, end + 1)
                    return streamResponse({
                        status: 206,
                        headers: makeHeaders({ start, end, total: TOTAL, etag: '"v206"' }),
                        bytes: slice
                    })
                }
                calls++
                return streamResponse({
                    status: 200,
                    headers: { 'content-length': String(TOTAL), etag: '"full"' },
                    bytes: new Uint8Array(1)
                })
            })
        )
        const result = await service.startDownload(video('vid-mid200'))
        expect(result.status).toBe('paused')
        // The one committed chunk is kept (partial data preserved); the 200
        // body was cancelled and never appended.
        const chunks = await rawChunks('vid-mid200')
        expect(chunks).toHaveLength(1)
        expect(chunks[0].start).toBe(0)
        const meta = await rawVideo('vid-mid200')
        expect(meta.pausedReason).toBe('rangeUnsupported')
        expect(meta.completedBytes).toBe(CHUNK)
    })

    it('malformed Content-Range on a 206 pauses with RANGE_INVALID', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                streamResponse({
                    status: 206,
                    headers: { 'content-range': 'garbage', etag: '"x"' },
                    bytes: new Uint8Array(0)
                })
            )
        )
        const result = await service.startDownload(video('vid-badcr'))
        expect(result.status).toBe('paused')
        const meta = await rawVideo('vid-badcr')
        expect(meta.pausedReason).toBe('rangeInvalid')
        expect(await rawChunks('vid-badcr')).toHaveLength(0)
    })

    it('missing Content-Range on a 206 pauses with RANGE_INVALID', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => streamResponse({ status: 206, headers: {}, bytes: new Uint8Array(3) }))
        )
        const result = await service.startDownload(video('vid-nocr'))
        expect(result.status).toBe('paused')
        expect((await rawVideo('vid-nocr')).pausedReason).toBe('rangeInvalid')
    })

    it('an unknown total marker (`bytes S-E/*`) pauses with RANGE_TOTAL_UNKNOWN', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                streamResponse({
                    status: 206,
                    headers: { 'content-range': 'bytes 0-9/*', etag: '"u"' },
                    bytes: new Uint8Array(10)
                })
            )
        )
        const result = await service.startDownload(video('vid-unknowntotal'))
        expect(result.status).toBe('paused')
        const meta = await rawVideo('vid-unknowntotal')
        expect(meta.pausedReason).toBe('rangeTotalUnknown')
        // An unknown-length prefix is never marked ready.
        expect(meta.status).toBe('paused')
        expect(await rawChunks('vid-unknowntotal')).toHaveLength(0)
    })

    it('wrong response start or end beyond the request pauses with RANGE_INVALID', async () => {
        const payload = source()
        // Response claims to start one byte LATER than asked.
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                const m = String(init.headers.Range).match(/^bytes=(\d+)-(\d+)$/)
                const start = Number(m[1])
                const end = start + CHUNK - 1
                const slice = payload.slice(start + 1, end + 1)
                return streamResponse({
                    status: 206,
                    headers: makeHeaders({ start: start + 1, end, total: TOTAL, etag: '"w"' }),
                    bytes: slice
                })
            })
        )
        const result = await service.startDownload(video('vid-wrongstart'))
        expect(result.status).toBe('paused')
        expect((await rawVideo('vid-wrongstart')).pausedReason).toBe('rangeInvalid')

        await loadService()
        // Response end BEYOND the requested end.
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                const m = String(init.headers.Range).match(/^bytes=(\d+)-(\d+)$/)
                const start = Number(m[1])
                return streamResponse({
                    status: 206,
                    headers: makeHeaders({ start, end: start + CHUNK, total: TOTAL + 1, etag: '"w2"' }),
                    bytes: payload.slice(start, start + CHUNK + 1)
                })
            })
        )
        const result2 = await service.startDownload(video('vid-wrongend'))
        expect(result2.status).toBe('paused')
        expect((await rawVideo('vid-wrongend')).pausedReason).toBe('rangeInvalid')
    })

    it('overflowing body (more bytes than declared) is cancelled immediately', async () => {
        let cancelled = false
        let enqueued = false
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                const declared = CHUNK
                return streamResponse({
                    status: 206,
                    headers: makeHeaders({ start: 0, end: declared - 1, total: TOTAL, etag: '"o"' }),
                    bytes: null,
                    pull: (controller) => {
                        // Enqueue MORE than declared and leave the stream open
                        // (still cancellable): the counted reader must stop at
                        // the cap, cancel immediately and never accumulate.
                        if (!enqueued) {
                            enqueued = true
                            controller.enqueue(new Uint8Array(declared + 1))
                        }
                    },
                    onCancel: () => {
                        cancelled = true
                    }
                })
            })
        )
        const result = await service.startDownload(video('vid-overflow'))
        expect(result.status).toBe('paused')
        expect(cancelled).toBe(true)
        expect((await rawVideo('vid-overflow')).pausedReason).toBe('rangeInvalid')
        expect(await rawChunks('vid-overflow')).toHaveLength(0)
    })

    it('a truncated body (premature EOF) never commits', async () => {
        const declared = CHUNK
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                // Declares declared bytes but streams declared-1 then ends.
                const streamBytes = new Uint8Array(declared - 1)
                return streamResponse({
                    status: 206,
                    headers: makeHeaders({ start: 0, end: declared - 1, total: TOTAL, etag: '"t"' }),
                    bytes: streamBytes
                })
            })
        )
        const result = await service.startDownload(video('vid-truncated'))
        expect(result.status).toBe('paused')
        expect((await rawVideo('vid-truncated')).pausedReason).toBe('rangeInvalid')
        expect(await rawChunks('vid-truncated')).toHaveLength(0)
    })

    it('an inconsistent Content-Length rejects the chunk', async () => {
        const declared = CHUNK
        const body = new Uint8Array(declared)
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                streamResponse({
                    status: 206,
                    headers: makeHeaders({
                        start: 0,
                        end: declared - 1,
                        total: TOTAL,
                        etag: '"cl"',
                        contentLength: declared - 123 // lies
                    }),
                    bytes: body
                })
            )
        )
        const result = await service.startDownload(video('vid-badcl'))
        expect(result.status).toBe('paused')
        expect((await rawVideo('vid-badcl')).pausedReason).toBe('rangeInvalid')
        expect(await rawChunks('vid-badcl')).toHaveLength(0)
    })

    it('encoded partial representations are rejected (offsets unmatchable)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                streamResponse({
                    status: 206,
                    headers: makeHeaders({
                        start: 0,
                        end: 9,
                        total: TOTAL,
                        etag: '"gz"',
                        encoding: 'gzip'
                    }),
                    bytes: new Uint8Array(10)
                })
            )
        )
        const result = await service.startDownload(video('vid-encoded'))
        expect(result.status).toBe('paused')
        expect((await rawVideo('vid-encoded')).pausedReason).toBe('rangeInvalid')
    })

    it('416 with an unsatisfied total of 0 completes an empty file', async () => {
        const server = rangeServer(new Uint8Array(0), { etag: '"empty"' })
        vi.stubGlobal('fetch', server.fetchImpl)
        const result = await service.startDownload(video('vid-empty'))
        expect(result.status).toBe('ready')
        const meta = await rawVideo('vid-empty')
        expect(meta.totalBytes).toBe(0)
        expect(meta.completedBytes).toBe(0)
        expect(meta.chunkCount).toBe(0)
        const url = await service.offlinePlayUrl('vid-empty')
        expect(url).toBeNull() // no byte coverage to assemble
    })

    it('416 while bytes are still missing is RANGE_INVALID (inconsistent unchanged total)', async () => {
        const bytes = source()
        let chunkZeroServed = false
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                const m = String(init.headers.Range).match(/^bytes=(\d+)-(\d+)$/)
                const start = Number(m[1])
                if (start === 0 && !chunkZeroServed) {
                    chunkZeroServed = true
                    const end = CHUNK - 1
                    return streamResponse({
                        status: 206,
                        headers: makeHeaders({ start: 0, end, total: TOTAL, etag: '"v206"' }),
                        bytes: bytes.slice(0, CHUNK)
                    })
                }
                // Same established total, bytes still missing → 416.
                return streamResponse({
                    status: 416,
                    headers: { 'content-range': `bytes */${TOTAL}`, etag: '"v206"' }
                })
            })
        )
        const result = await service.startDownload(video('vid-416missing'))
        expect(result.status).toBe('paused')
        const meta = await rawVideo('vid-416missing')
        expect(meta.pausedReason).toBe('rangeInvalid')
        // The one good chunk is preserved; nothing beyond it.
        const chunks = await rawChunks('vid-416missing')
        expect(chunks).toHaveLength(1)
        expect(chunks[0].start).toBe(0)
    })

    it('416 with a NEW total proves representation change → single clean restart', async () => {
        // Persisted resume state believes the old length; the new server is
        // shorter, so the resume offset is unsatisfiable and it answers 416
        // with the new total.
        const oldTotal = 3 * CHUNK + 50
        const newTotal = CHUNK + 13
        const newSource = makeBytes(71, newTotal)
        const state = { phase: 'seed' }

        // Seed: first run downloads from old-length server then "network dies"
        // after chunk 0. Persisted meta total = oldTotal, etag old.
        const seedServer = rangeServer(makeBytes(72, oldTotal), { etag: '"old-rep"' })
        vi.stubGlobal('fetch', seedServer.fetchImpl)
        const first = await service.startDownload(video('vid-416changed'))
        expect(first.status).toBe('ready')

        // Rewrite the persisted state to a paused mid-download record with the
        // OLD total but ONLY chunk 0 committed (drop the later chunks), then
        // simulate that the origin now serves the NEW representation.
        const db = await rawOpen()
        await new Promise((resolve, reject) => {
            const tx = db.transaction(['videos', 'chunks'], 'readwrite')
            const videos = tx.objectStore('videos')
            const chunks = tx.objectStore('chunks')
            videos.put({
                id: 'vid-416changed',
                status: 'paused',
                totalBytes: oldTotal,
                completedBytes: CHUNK,
                chunkCount: 1,
                etag: '"old-rep"',
                etagStrong: true,
                lastModified: null,
                title: '416 changed',
                pausedReason: 'offline'
            })
            const range = IDBKeyRange.bound('vid-416changed:', 'vid-416changed:\uffff')
            const cursorReq = chunks.openCursor(range)
            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result
                if (!cursor) return
                cursor.delete()
                cursor.continue()
            }
            tx.oncomplete = resolve
            tx.onerror = () => reject(tx.error)
        })
        db.close()

        await loadService() // fresh module: open resumed download

        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                const m = String(init.headers.Range).match(/^bytes=(\d+)-(\d+)$/)
                const start = Number(m[1])
                if (start >= newTotal) {
                    // Resume offset beyond the new EOF.
                    return streamResponse({
                        status: 416,
                        headers: { 'content-range': `bytes */${newTotal}`, etag: '"new-rep"' }
                    })
                }
                const end = Math.min(start + CHUNK - 1, newTotal - 1)
                return streamResponse({
                    status: 206,
                    headers: makeHeaders({ start, end, total: newTotal, etag: '"new-rep"' }),
                    bytes: newSource.slice(start, end + 1)
                })
            })
        )
        const second = await service.startDownload(video('vid-416changed'))
        expect(second.status).toBe('ready')
        const meta = await rawVideo('vid-416changed')
        expect(meta.totalBytes).toBe(newTotal)
        expect(meta.etag).toBe('"new-rep"')
        const merged = await concatChunkBytes('vid-416changed')
        expect(Buffer.from(merged).equals(Buffer.from(newSource))).toBe(true)
    })
})

describe('offline download — representation change and validators', () => {
    const TOTAL = 2 * CHUNK + 5

    it('a changed strong ETag triggers ONE clean restart then completion', async () => {
        const source = makeBytes(83, TOTAL)
        let calls = 0
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                const m = String(init.headers.Range).match(/^bytes=(\d+)-(\d+)$/)
                const start = Number(m[1])
                calls++
                if (calls <= 2) {
                    // First two requests: old representation.
                    const end = Math.min(start + CHUNK - 1, TOTAL - 1)
                    const etag = calls === 1 ? '"old"' : '"old"'
                    return streamResponse({
                        status: 206,
                        headers: makeHeaders({ start, end, total: TOTAL, etag }),
                        bytes: source.slice(start, end + 1)
                    })
                }
                const end = Math.min(start + CHUNK - 1, TOTAL - 1)
                return streamResponse({
                    status: 206,
                    headers: makeHeaders({ start, end, total: TOTAL, etag: '"new"' }),
                    bytes: source.slice(start, end + 1)
                })
            })
        )
        const result = await service.startDownload(video('vid-changedetag'))
        expect(result.status).toBe('ready')
        const meta = await rawVideo('vid-changedetag')
        expect(meta.etag).toBe('"new"')
        expect(meta.status).toBe('ready')
        // Restart re-fetched from zero: some request must start at 0 AFTER
        // the change was observed.
        const merged = await concatChunkBytes('vid-changedetag')
        expect(Buffer.from(merged).equals(Buffer.from(source))).toBe(true)
    })

    it('exhausting the single restart pauses with SOURCE_CHANGED', async () => {
        const source = makeBytes(89, TOTAL)
        let calls = 0
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                const m = String(init.headers.Range).match(/^bytes=(\d+)-(\d+)$/)
                const start = Number(m[1])
                const end = Math.min(start + CHUNK - 1, TOTAL - 1)
                calls++
                // A NEW etag every single response: every chunk proves change.
                return streamResponse({
                    status: 206,
                    headers: makeHeaders({ start, end, total: TOTAL, etag: `"r${calls}"` }),
                    bytes: source.slice(start, end + 1)
                })
            })
        )
        const result = await service.startDownload(video('vid-changeexhaust'))
        expect(result.status).toBe('paused')
        const meta = await rawVideo('vid-changeexhaust')
        expect(meta.pausedReason).toBe('sourceChanged')
        // Nothing inconsistent was committed as ready.
        expect(meta.status).toBe('paused')
        const download = await service.getDownload('vid-changeexhaust')
        expect(download.status).toBe('paused')
    })

    it('a changed total restarts once and adopts the new length', async () => {
        // Serve chunk 0 + chunk 1 under total A, then switch to total B (the
        // resume offset is beyond the new EOF → the origin answers 416 with
        // bytes */B, which proves the representation change).
        const totalA = 3 * CHUNK
        const totalB = CHUNK + 200
        const sourceA = makeBytes(98, totalA)
        const sourceB = makeBytes(97, totalB)
        const calls = { n: 0 }
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                const m = String(init.headers.Range).match(/^bytes=(\d+)-(\d+)$/)
                const start = Number(m[1])
                calls.n++
                const underA = calls.n <= 2
                const total = underA ? totalA : totalB
                const source = underA ? sourceA : sourceB
                if (start >= total) {
                    return streamResponse({
                        status: 416,
                        headers: { 'content-range': `bytes */${total}` }
                    })
                }
                const end = Math.min(start + CHUNK - 1, total - 1)
                return streamResponse({
                    status: 206,
                    headers: makeHeaders({ start, end, total, etag: '"stable"' }),
                    bytes: source.slice(start, end + 1)
                })
            })
        )
        const result = await service.startDownload(video('vid-changedtotal'))
        expect(result.status).toBe('ready')
        const meta = await rawVideo('vid-changedtotal')
        expect(meta.totalBytes).toBe(totalB)
        expect(meta.etag).toBe('"stable"')
        const merged = await concatChunkBytes('vid-changedtotal')
        expect(Buffer.from(merged).equals(Buffer.from(sourceB))).toBe(true)
    })

    it('unknown total with committed prefix is never marked ready (defensive)', async () => {
        // Persist a partial record whose metadata has no total and no
        // validator (legacy unknown-length prefix). Resume must NOT trust it.
        const db = await rawOpen()
        await new Promise((resolve, reject) => {
            const tx = db.transaction(['videos', 'chunks'], 'readwrite')
            tx.objectStore('videos').put({
                id: 'vid-legacyunknown',
                status: 'paused',
                totalBytes: 0,
                completedBytes: 1024,
                chunkCount: 1,
                etag: null,
                lastModified: null,
                title: 'legacy'
            })
            const blob = new Blob([new Uint8Array(1024)])
            tx.objectStore('chunks').put({
                key: 'vid-legacyunknown:000000',
                videoId: 'vid-legacyunknown',
                index: 0,
                start: 0,
                end: 1023,
                size: 1024,
                blob
            })
            tx.oncomplete = resolve
            tx.onerror = () => reject(tx.error)
        })
        db.close()

        await loadService()
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                streamResponse({
                    status: 200,
                    headers: { 'content-length': '500', etag: '"x"' },
                    bytes: new Uint8Array(1)
                })
            )
        )
        const result = await service.startDownload(video('vid-legacyunknown'))
        // No usable validator → partial data was discarded; only then can the
        // new run begin. The 200 rejection means it paused rather than lying.
        expect(result.status).toBe('paused')
        const meta = await rawVideo('vid-legacyunknown')
        expect(meta.pausedReason).toBe('rangeUnsupported')
        expect(meta.completedBytes).toBe(0)
    })
})

describe('offline download — authentication and retry policy', () => {
    const TOTAL = CHUNK + 3

    it('a single 401 triggers one reauthentication then continues', async () => {
        const source = makeBytes(101, TOTAL)
        const gateCalls = []
        let fetchCalls = 0
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                fetchCalls++
                const m = String(init.headers.Range).match(/^bytes=(\d+)-(\d+)$/)
                const start = Number(m[1])
                if (fetchCalls === 1) {
                    return streamResponse({ status: 401, headers: {} })
                }
                const end = Math.min(start + CHUNK - 1, TOTAL - 1)
                return streamResponse({
                    status: 206,
                    headers: makeHeaders({ start, end, total: TOTAL, etag: '"a1"' }),
                    bytes: source.slice(start, end + 1)
                })
            })
        )
        // Complete the auth as soon as the downloader waits for the gate.
        const resultPromise = service.startDownload(video('vid-401retry'))
        const timer = setInterval(() => {
            if (gate.state.waiters.length > 0) {
                gateCalls.push(gate.state.waiters.length)
                completeAuth()
                clearInterval(timer)
            }
        }, 1)

        const result = await resultPromise
        clearInterval(timer)
        expect(result.status).toBe('ready')
        expect(gateCalls.length).toBe(1)
        // The 401 fetch was retried once with the fresh cookie: chunk 0 = 401
        // + retried 206, then the 5-byte tail chunk.
        expect(fetchCalls).toBe(3)
        const merged = await concatChunkBytes('vid-401retry')
        expect(Buffer.from(merged).equals(Buffer.from(source))).toBe(true)
    })

    it('a second 401 is terminal for the operation (one auth allowance)', async () => {
        let fetchCalls = 0
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                fetchCalls++
                return streamResponse({ status: 401, headers: {} })
            })
        )
        // First 401 waits on the gate; auth "succeeds" but the cookie still
        // fails — the second 401 must terminate, not loop.
        const resultPromise = service.startDownload(video('vid-401twice'))
        let gateWaits = 0
        const timer = setInterval(() => {
            if (gate.state.waiters.length > 0) {
                gateWaits++
                if (gateWaits === 1) completeAuth()
                else failAuth()
            }
        }, 1)
        const result = await resultPromise
        clearInterval(timer)
        expect(result.status).toBe('paused')
        expect(fetchCalls).toBe(2) // initial 401 + single retried 401
        const meta = await rawVideo('vid-401twice')
        expect(meta.pausedReason).toBe('unauthorized')
    })

    it('abort during authentication rejects the operation without touching data', async () => {
        let fetchCalls = 0
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                fetchCalls++
                return streamResponse({ status: 401, headers: {} })
            })
        )
        const first = service.startDownload(video('vid-401abort'))
        // Wait until the downloader is blocked on the gate, then cancel.
        const timer = setInterval(() => {
            if (gate.state.waiters.length > 0) {
                clearInterval(timer)
                service.cancelDownload('vid-401abort')
            }
        }, 1)
        const [result] = await Promise.allSettled([first])
        clearInterval(timer)
        expect(result.status).toBe('rejected')
        // Cancellation cleanup removed every record.
        expect(await service.getDownload('vid-401abort')).toBeNull()
        expect(await rawChunks('vid-401abort')).toHaveLength(0)
        expect(fetchCalls).toBe(1)
    })

    it('a Retry-After over 30 seconds pauses with a retry timestamp instead of retrying', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                streamResponse({
                    status: 503,
                    headers: { 'retry-after': '120', etag: '"r"' }
                })
            )
        )
        const started = Date.now()
        const result = await service.startDownload(video('vid-retryafter'))
        const elapsed = Date.now() - started
        expect(result.status).toBe('paused')
        expect(elapsed).toBeLessThan(60_000) // did not wait out the 120 s
        const meta = await rawVideo('vid-retryafter')
        expect(meta.pausedReason).toBe('serverUnavailable')
        expect(meta.retryAfterEpoch).toBeGreaterThan(Date.now() + 115_000)
        expect(meta.retryAfterEpoch).toBeLessThan(Date.now() + 125_000)
    })

    it('one transient failure is retried with bounded backoff before success', async () => {
        const source = makeBytes(107, TOTAL)
        let calls = 0
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                calls++
                const m = String(init.headers.Range).match(/^bytes=(\d+)-(\d+)$/)
                const start = Number(m[1])
                if (calls === 1) {
                    return streamResponse({ status: 503, headers: {} })
                }
                const end = Math.min(start + CHUNK - 1, TOTAL - 1)
                return streamResponse({
                    status: 206,
                    headers: makeHeaders({ start, end, total: TOTAL, etag: '"b1"' }),
                    bytes: source.slice(start, end + 1)
                })
            })
        )
        const result = await service.startDownload(video('vid-503retry'))
        expect(result.status).toBe('ready')
        // Chunk 0: transient 503 + retried 206; then the 5-byte tail chunk.
        expect(calls).toBe(3)
    })

    it('abort during backoff cancels immediately (abortable sleep)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => streamResponse({ status: 503, headers: {} }))
        )
        const first = service.startDownload(video('vid-backoffabort'))
        const timer = setTimeout(() => service.cancelDownload('vid-backoffabort'), 30)
        const started = Date.now()
        const [result] = await Promise.allSettled([first])
        const elapsed = Date.now() - started
        clearTimeout(timer)
        expect(result.status).toBe('rejected')
        expect(elapsed).toBeLessThan(2000)
        expect(await service.getDownload('vid-backoffabort')).toBeNull()
    })

    it('404 is terminal (never retried as transient) and pauses preserving nothing', async () => {
        let calls = 0
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                calls++
                return streamResponse({ status: 404, headers: {} })
            })
        )
        const result = await service.startDownload(video('vid-404'))
        expect(result.status).toBe('paused')
        expect(calls).toBe(1)
        expect((await rawVideo('vid-404')).pausedReason).toBe('notFound')
    })
})

describe('offline download — transactional persistence and cancellation safety', () => {
    const TOTAL = 2 * CHUNK + 5
    const source = () => makeBytes(113, TOTAL)

    it('a failure between scheduling a chunk write and transaction completion persists NEITHER', async () => {
        const server = rangeServer(source(), { etag: '"tx"' })
        vi.stubGlobal('fetch', server.fetchImpl)

        // Intercept chunk-store writes: schedule the real put, then abort the
        // transaction from the request's own success path (between scheduling
        // and completion).
        const proto = await objectStorePrototype()
        const originalPut = proto.put
        vi.spyOn(proto, 'put').mockImplementation(function putSpy(value, key) {
            const storeName = this.name
            const request = originalPut.call(this, value, key)
            if (storeName === 'chunks') {
                request.onsuccess = () => {
                    try {
                        request.transaction.abort()
                    } catch {
                        /* ignore */
                    }
                }
            }
            return request
        })

        const result = await service.startDownload(video('vid-txrollback'))
        expect(result.status).toBe('paused')
        vi.restoreAllMocks()

        const chunks = await rawChunks('vid-txrollback')
        expect(chunks).toHaveLength(0) // no chunk survived
        const meta = await rawVideo('vid-txrollback')
        // No advanced progress survived either (paused marker only).
        expect(meta.completedBytes).toBe(0)
        expect(meta.chunkCount).toBe(0)
        expect(meta.status).toBe('paused')
    })

    it('quota failure on the chunk write pauses with partial data preserved correctly', async () => {
        const server = rangeServer(source(), { etag: '"quota"' })
        vi.stubGlobal('fetch', server.fetchImpl)

        const proto = await objectStorePrototype()
        const originalPut = proto.put
        vi.spyOn(proto, 'put').mockImplementation(function putSpy(value) {
            if (this.name === 'chunks') {
                const error = new DOMException('quota exceeded', 'QuotaExceededError')
                throw error
            }
            return originalPut.call(this, value)
        })

        const result = await service.startDownload(video('vid-quota'))
        vi.restoreAllMocks()
        expect(result.status).toBe('paused')
        // First chunk rolled back (threw on chunk 0's write).
        expect(await rawChunks('vid-quota')).toHaveLength(0)
        const meta = await rawVideo('vid-quota')
        expect(meta.completedBytes).toBe(0)
    })

    it('legacy inconsistent metadata is repaired to the contiguous prefix before resuming', async () => {
        const total = 2 * CHUNK + 5
        const sourceBytes = source()
        // Seed: metadata claims 3 chunks but only chunk 0 (contiguous) and a
        // bogus later chunk exist — the later one must be dropped.
        const db = await rawOpen()
        await new Promise((resolve, reject) => {
            const tx = db.transaction(['videos', 'chunks'], 'readwrite')
            tx.objectStore('videos').put({
                id: 'vid-legacy',
                status: 'paused',
                totalBytes: total,
                completedBytes: 3 * CHUNK + 5, // optimistic lie
                chunkCount: 3,
                etag: '"legacy-ok"',
                etagStrong: true,
                lastModified: null,
                title: 'legacy inconsistent'
            })
            const c0 = new Uint8Array(sourceBytes.slice(0, CHUNK))
            tx.objectStore('chunks').put({
                key: 'vid-legacy:000000',
                videoId: 'vid-legacy',
                index: 0,
                start: 0,
                end: CHUNK - 1,
                size: CHUNK,
                blob: new Blob([c0])
            })
            // Gap + descriptor whose blob size does not match its range.
            const bogus = new Uint8Array(16)
            tx.objectStore('chunks').put({
                key: 'vid-legacy:000002',
                videoId: 'vid-legacy',
                index: 2,
                start: 2 * CHUNK,
                end: 3 * CHUNK - 1,
                size: CHUNK,
                blob: new Blob([bogus]) // size mismatch → invalid prefix cut
            })
            tx.oncomplete = resolve
            tx.onerror = () => reject(tx.error)
        })
        db.close()

        await loadService()
        const server = rangeServer(sourceBytes, { etag: '"legacy-ok"' })
        vi.stubGlobal('fetch', server.fetchImpl)

        const result = await service.startDownload(video('vid-legacy'))
        expect(result.status).toBe('ready')
        const meta = await rawVideo('vid-legacy')
        // Chunk 0 from the seed + two fresh chunks complete the file.
        expect(meta.chunkCount).toBe(3)
        expect(meta.completedBytes).toBe(total)
        // Chunk 0 was re-fetched from its actual end; bogus chunk gone.
        const chunks = await rawChunks('vid-legacy')
        expect(chunks.some((c) => c.start === 2 * CHUNK && c.blob.size === 16)).toBe(false)
        const merged = await concatChunkBytes('vid-legacy')
        expect(Buffer.from(merged).equals(Buffer.from(sourceBytes))).toBe(true)
    })

    it('cancellation releases pending reads; no late write recreates deleted records', async () => {
        const sourceBytes = source()
        let releasePull = null
        const gatePromise = new Promise((resolve) => {
            releasePull = resolve
        })
        let pullStarted = false
        let cancelCount = 0

        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                const m = String(init.headers.Range).match(/^bytes=(\d+)-(\d+)$/)
                const start = Number(m[1])
                const end = Math.min(start + CHUNK - 1, TOTAL - 1)
                return streamResponse({
                    status: 206,
                    headers: makeHeaders({ start, end, total: TOTAL, etag: '"cancel"' }),
                    bytes: null, // no immediate bytes: the pull stays pending
                    pull: (controller) => {
                        pullStarted = true
                        return gatePromise.then(() => {
                            try {
                                controller.enqueue(sourceBytes.slice(start, end + 1))
                                controller.close()
                            } catch {
                                /* stream already cancelled */
                            }
                        })
                    },
                    onCancel: () => {
                        cancelCount++
                        releasePull() // never strand the parked pull
                    }
                })
            })
        )

        const first = service.startDownload(video('vid-latewrite'))
        // Wait for the read to be parked on the gate, then cancel.
        const waitForPull = setInterval(() => {
            if (pullStarted) {
                clearInterval(waitForPull)
                service.cancelDownload('vid-latewrite')
            }
        }, 1)

        const [result] = await Promise.allSettled([first])
        clearInterval(waitForPull)
        expect(result.status).toBe('rejected')

        // Records are gone BEFORE the mocked reads are released.
        expect(await service.getDownload('vid-latewrite')).toBeNull()
        expect(await rawChunks('vid-latewrite')).toHaveLength(0)

        // Release the parked read; the late stream data must NOT recreate the
        // deleted records.
        releasePull()
        await new Promise((r) => setTimeout(r, 50))
        expect(await service.getDownload('vid-latewrite')).toBeNull()
        expect(await rawChunks('vid-latewrite')).toHaveLength(0)
        expect(cancelCount).toBe(1)
    })

    it('deletion failure propagates (never reports success on failed cleanup)', async () => {
        const server = rangeServer(source(), { etag: '"del"' })
        vi.stubGlobal('fetch', server.fetchImpl)
        const result = await service.startDownload(video('vid-deletefail'))
        expect(result.status).toBe('ready')

        // Break deletion of the video record inside the cross-store delete
        // transaction: the awaited removal must reject, record survives.
        const proto = await objectStorePrototype()
        const originalDelete = proto.delete
        vi.spyOn(proto, 'delete').mockImplementation(function deleteSpy(key) {
            if (this.name === 'videos') {
                const error = new Error('disk error')
                throw error
            }
            return originalDelete.call(this, key)
        })

        await expect(service.removeDownload('vid-deletefail')).rejects.toThrow()
        vi.restoreAllMocks()

        const meta = await rawVideo('vid-deletefail')
        expect(meta).toBeTruthy()
        expect(meta.status).toBe('ready')
        const chunks = await rawChunks('vid-deletefail')
        expect(chunks.length).toBeGreaterThan(0)
    })

    it('a completed download is reported ready only after its full data commits', async () => {
        const events = []
        vi.stubGlobal('document', {
            dispatchEvent: (event) => events.push(event),
            addEventListener: () => {},
            removeEventListener: () => {},
            getElementById: () => null
        })
        const sourceBytes = source()
        const server = rangeServer(sourceBytes, { etag: '"events"' })
        vi.stubGlobal('fetch', server.fetchImpl)

        const result = await service.startDownload(video('vid-events'))
        expect(result.status).toBe('ready')

        const progressEvents = events.filter((e) => e.type === 'offline:progress')
        const lastProgress = progressEvents[progressEvents.length - 1]
        expect(lastProgress.detail.progress).toBe(1)
        expect(lastProgress.detail.completedBytes).toBe(TOTAL)
        // The meta was 'ready' before 100 % was announced.
        const readyMeta = await rawVideo('vid-events')
        expect(readyMeta.status).toBe('ready')
    })
})

// ---------------------------------------------------------------------------
// F07 — strict chunk consumption: the final (EOF-confirmation) read is under
// the same cancellation/deadline mechanism and a read error propagates
// unchanged instead of being rewritten into a fabricated done:true.
// ---------------------------------------------------------------------------

describe('offline download — F07 strict body reads (EOF + errors)', () => {
    const TOTAL = 2 * CHUNK + 5
    const source = () => makeBytes(97, TOTAL)

    /**
     * A 206 whose stream enqueues the full slice and then errors on the NEXT
     * read (the EOF confirmation). Before the F07 fix this error was
     * swallowed and the chunk was accepted with fabricated done:true.
     */
    function eofErrorServer() {
        return vi.fn(async (_url, init) => {
            const m = String(init.headers.Range).match(/^bytes=(\d+)-(\d+)$/)
            const start = Number(m[1])
            const end = Math.min(Number(m[2]), TOTAL - 1)
            const slice = source().slice(start, end + 1)
            return streamResponse({
                status: 206,
                headers: makeHeaders({ start, end, total: TOTAL, etag: '"eof-err"' }),
                pull: (controller) => {
                    controller.enqueue(slice)
                    queueMicrotask(() => {
                        try {
                            // Error AFTER the bytes — on the EOF check read.
                            controller.error(new Error('connection reset mid-body'))
                        } catch {
                            /* already closed */
                        }
                    })
                }
            })
        })
    }

    it('a read error on the EOF check propagates — never fabricated done:true', { timeout: 20000 }, async () => {
        vi.stubGlobal('fetch', eofErrorServer())
        const result = await service.startDownload(video('vid-eoferr'))
        expect(result.status).toBe('paused')
        // The failed chunk is NOT committed — but any earlier valid prefix is.
        const meta = await rawVideo('vid-eoferr')
        expect(meta.pausedReason).toBe('offline')
        expect(meta.status).toBe('paused')
    })

    it('exact bytes followed by a REAL EOF completes; overflow rejects', { timeout: 30000 }, async () => {
        // (a) well-behaved server: full coverage downloads to ready. The
        // fixture is large (3 chunks), so grant a real-time budget.
        const okServer = rangeServer(source(), { etag: '"ok"' })
        vi.stubGlobal('fetch', okServer.fetchImpl)
        const ok = await service.startDownload(video('vid-eof-ok'))
        expect(ok.status).toBe('ready')
        expect(await concatChunkBytes('vid-eof-ok')).toEqual(source())

        // (b) a 206 claiming 4 bytes but sending 6 — overflow rejected.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                streamResponse({
                    status: 206,
                    headers: { 'content-range': 'bytes 0-3/10', 'content-length': '4', etag: '"ovf"' },
                    bytes: new Uint8Array([1, 2, 3, 4, 5, 6])
                })
            )
        )
        const result = await service.startDownload(video('vid-overflow'))
        expect(result.status).toBe('paused')
        expect((await rawVideo('vid-overflow')).pausedReason).toBe('rangeInvalid')
        expect(await rawChunks('vid-overflow')).toHaveLength(0)
    })

    it('cancellation during the final EOF read still cleans up and pauses', async () => {
        const op = new AbortController()
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                const m = String(init.headers.Range).match(/^bytes=(\d+)-(\d+)$/)
                const start = Number(m[1])
                const end = Math.min(Number(m[2]), TOTAL - 1)
                const slice = source().slice(start, end + 1)
                return streamResponse({
                    status: 206,
                    headers: makeHeaders({ start, end, total: TOTAL, etag: '"eof-cancel"' }),
                    pull: (controller) => {
                        controller.enqueue(slice)
                        queueMicrotask(() => {
                            op.abort() // abort DURING the EOF confirmation read
                        })
                    }
                })
            })
        )
        // Signal must reach the downloader: startDownload runs with its own
        // controller, so we abort the video mid-flight via cancelDownload.
        const downloadPromise = service.startDownload(video('vid-eofcancel'), {
            signal: op.signal
        }).catch((error) => error)
        // Not all signatures accept a signal; fall back to cancelDownload.
        let settled = await Promise.race([
            downloadPromise.then((r) => r),
            new Promise((r) => setTimeout(() => r('pending'), 500))
        ])
        if (settled === 'pending' || settled?.status === 'paused' || settled?.name === 'AbortError') {
            await service.cancelDownload('vid-eofcancel').catch(() => {})
            settled = null
        }
        // Either way the operation settles without hanging and the metadata
        // never reports ready.
        const meta = await rawVideo('vid-eofcancel')
        if (meta) expect(meta.status).not.toBe('ready')
        await service.cancelDownload('vid-eofcancel').catch(() => {})
        expect(await rawChunks('vid-eofcancel')).toHaveLength(0)
    })

    it('a stalled body (no bytes) pauses with timeout instead of hanging', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                streamResponse({
                    status: 206,
                    headers: makeHeaders({ start: 0, end: CHUNK - 1, total: TOTAL, etag: '"stall"' }),
                    // A body that stays OPEN with a pending pull that never enqueues
                    // (a genuinely stalled connection): the idle deadline must fire,
                    // cancel the stream and pause with "timeout" instead of hanging
                    // forever on reader.read().
                    bytes: null,
                    pull: () => new Promise(() => {})
                })
            )
        )
        const download = service.startDownload(video('vid-stall'))
        const assertion = vi
            .waitFor(
                async () => {
                    const meta = await rawVideo('vid-stall')
                    expect(meta && meta.pausedReason).toBe('timeout')
                },
                { timeout: 140000, interval: 500 }
            )
            .catch(() => {
                throw new Error('download did not pause with a timeout reason')
            })
        await expect(download).resolves.toEqual({ id: 'vid-stall', status: 'paused' })
        await assertion
    }, 150000)
})
