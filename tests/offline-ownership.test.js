// offline-ownership.test.js — A03/A05/A10 regressions for the offline
// downloader, run against the REAL production offlineService module:
//
//   • A05: the v2→v3 schema upgrade never deletes the legacy `blobs` store;
//     v1 monolithic downloads stay listed/playable through the compatibility
//     reader; explicit user removal also clears the preserved legacy row.
//   • A03/A10: download ownership is DURABLE across contexts (the `operations`
//     store): a live foreign owner blocks a rival start, an expired claim
//     (crashed/closed tab) is re-claimable, a same-context second start never
//     spawns a second writer, ownership loss fences chunk commits, and
//     cancel/remove refuse to tear down a live foreign owner's data.
//
// fake-indexeddb provides the browser IndexedDB engine; Blob round-trips are
// verified against it. Shared harness: tests/helpers/offlineHarness.mjs.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
    CHUNK,
    makeBytes,
    rangeServer,
    rawVideo,
    rawChunks,
    rawObjectStoreNames,
    rawLegacyRow,
    rawOwnerRow,
    rawPutOwnerRow,
    seedLegacyV2Database,
    video,
    loadService,
    getService,
    getUrlBlob,
    beforeEachHarness,
    afterEachHarness
} from './helpers/offlineHarness.mjs'

const service = () => getService()

beforeEach(async () => {
    await beforeEachHarness()
})

afterEach(() => {
    afterEachHarness()
})

// ===========================================================================
// A05 — legacy schema preservation
// ===========================================================================

describe('offline download — A05 legacy schema preservation', () => {
    it('the v2→v3 upgrade keeps the legacy `blobs` store and its records', async () => {
        const bytes = makeBytes(51, 1024)
        await seedLegacyV2Database('vid-legacy-keep', {
            legacy: { blob: [bytes], title: 'قدیمی', mime: 'video/mp4' },
            meta: null
        })

        // Reading through the production service performs the real v2→v3
        // upgrade; the legacy-only id is surfaced through the compat reader
        // (modern record absent, legacy record wins).
        const seen = await service().getDownload('vid-legacy-keep')
        expect(seen).not.toBeNull()
        expect(seen.legacy).toBe(true)
        expect(seen.status).toBe('ready')
        expect(seen.totalBytes).toBe(1024)

        const stores = await rawObjectStoreNames()
        expect(stores).toContain('blobs') // ← fails on the old delete-on-upgrade behavior
        expect(stores).toContain('operations')

        const row = await rawLegacyRow('vid-legacy-keep')
        expect(row).not.toBeNull()
        expect(row.blob.size).toBe(1024)
    })

    it('a v1 monolithic download stays visible and byte-playable after the upgrade', async () => {
        const bytes = makeBytes(52, 2048)
        await seedLegacyV2Database('vid-legacy-play', {
            legacy: { blob: [bytes], title: 'فیلم قدیمی', author: 'کانال قدیمی', mime: 'video/mp4' },
            meta: null
        })

        const download = await service().getDownload('vid-legacy-play')
        expect(download).not.toBeNull()
        expect(download.status).toBe('ready')
        expect(download.totalBytes).toBe(2048)
        expect(download.legacy).toBe(true)
        expect(download.title).toBe('فیلم قدیمی')

        const list = await service().getDownloads()
        expect(list.some((d) => d.id === 'vid-legacy-play' && d.legacy)).toBe(true)

        const url = await service().offlinePlayUrl('vid-legacy-play')
        expect(url).toBeTruthy()
        const rebuilt = new Uint8Array(await getUrlBlob().arrayBuffer())
        expect(rebuilt.length).toBe(2048)
        expect(Buffer.from(rebuilt).equals(Buffer.from(bytes))).toBe(true)
    })

    it('an explicit user removal also clears the preserved legacy row (never a blanket wipe)', async () => {
        const bytes = makeBytes(53, 512)
        await seedLegacyV2Database('vid-legacy-delete', {
            legacy: { blob: [bytes], title: 'حذف‌شدنی', mime: 'video/mp4' },
            meta: null
        })
        expect(await service().getDownload('vid-legacy-delete')).not.toBeNull()

        await service().removeDownload('vid-legacy-delete')

        expect(await service().getDownload('vid-legacy-delete')).toBeNull()
        expect(await rawLegacyRow('vid-legacy-delete')).toBeNull()
        // The stores themselves remain (no blanket wipe, no dropped store).
        const stores = await rawObjectStoreNames()
        expect(stores).toEqual(expect.arrayContaining(['videos', 'chunks', 'operations', 'blobs']))
    })

    it('a corrupt legacy record (blob missing) is reported absent, never fabricated', async () => {
        const bytes = makeBytes(54, 32)
        await seedLegacyV2Database('vid-broken', {
            legacy: { blob: [bytes], title: 'خراب', mime: 'video/mp4' },
            meta: null
        })
        // Corrupt the record: the Blob value is gone (only metadata left).
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('yt-offline-db')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        try {
            await new Promise((resolve, reject) => {
                const tx = db.transaction('blobs', 'readwrite')
                tx.objectStore('blobs').put({ id: 'vid-broken', title: 'خراب' })
                tx.oncomplete = () => resolve()
                tx.onerror = () => reject(tx.error)
            })
        } finally {
            db.close()
        }
        expect(await service().getDownload('vid-broken')).toBeNull()
        expect(await service().offlinePlayUrl('vid-broken')).toBeNull()
    })
})

// ===========================================================================
// A03/A10 — durable cross-context download ownership
// ===========================================================================

describe('offline download — A03/A10 durable ownership', () => {
    it('a running download holds a durable claim; a settled one releases it', async () => {
        const slow = rangeServer(makeBytes(62, 3 * CHUNK), {
            etag: '"own-2"',
            onRequest: async (i) => {
                if (i === 0) await new Promise((r) => setTimeout(r, 300))
                return null
            }
        })
        vi.stubGlobal('fetch', slow.fetchImpl)

        const pending = service().startDownload(video('vid-own-live'))
        await new Promise((r) => setTimeout(r, 120))
        const live = await rawOwnerRow('vid-own-live')
        expect(live).not.toBeNull()
        expect(typeof live.owner).toBe('string')
        expect(live.owner.length).toBeGreaterThan(0)
        // The claim carries a FRESH heartbeat (liveness signal for other
        // contexts deciding whether this owner is still alive).
        expect(Number.isSafeInteger(live.heartbeatAt)).toBe(true)
        expect(Date.now() - live.heartbeatAt).toBeLessThan(5_000)

        const result = await pending
        expect(result.status).toBe('ready')
        expect(await rawOwnerRow('vid-own-live')).toBeNull()
    })

    it('a fresh context refuses to start a download a LIVE foreign context owns', async () => {
        const server = rangeServer(makeBytes(63, CHUNK), { etag: '"own-3"' })
        vi.stubGlobal('fetch', server.fetchImpl)

        await seedLegacyV2Database('vid-foreign', { meta: null })
        // Perform the real v2→v3 upgrade BEFORE seeding a claim so the
        // `operations` store exists.
        await service().getDownloads()
        // A foreign owner with a fresh heartbeat — as if another tab is
        // actively downloading right now.
        await rawPutOwnerRow('vid-foreign', {
            owner: 'other-context-uuid',
            acquiredAt: Date.now(),
            heartbeatAt: Date.now()
        })

        const result = await service().startDownload(video('vid-foreign'))
        expect(result.status).toBe('downloading')
        expect(result.ownedByOtherContext).toBe(true)
        // This context fetched nothing and left the foreign claim untouched.
        expect(server.requests).toHaveLength(0)
        const claim = await rawOwnerRow('vid-foreign')
        expect(claim.owner).toBe('other-context-uuid')
    })

    it('an EXPIRED foreign claim (crashed tab) is re-claimable and completes', async () => {
        const server = rangeServer(makeBytes(64, CHUNK), { etag: '"own-4"' })
        vi.stubGlobal('fetch', server.fetchImpl)

        await seedLegacyV2Database('vid-stale', { meta: null })
        await service().getDownloads() // run the v2→v3 upgrade first
        await rawPutOwnerRow('vid-stale', {
            owner: 'crashed-context',
            acquiredAt: Date.now() - 60_000,
            heartbeatAt: Date.now() - 60_000
        })

        const result = await service().startDownload(video('vid-stale'))
        expect(result.status).toBe('ready')
        expect((await rawVideo('vid-stale')).status).toBe('ready')
    })

    it('a second start in the SAME context while downloading returns downloading (no second writer)', async () => {
        const slow = rangeServer(makeBytes(65, 3 * CHUNK), {
            etag: '"own-5"',
            onRequest: async (i) => {
                if (i === 0) await new Promise((r) => setTimeout(r, 250))
                return null
            }
        })
        vi.stubGlobal('fetch', slow.fetchImpl)

        const first = service().startDownload(video('vid-same'))
        const second = await service().startDownload(video('vid-same'))
        expect(second.status).toBe('downloading')
        expect(second.ownedByOtherContext).toBeUndefined()
        await first
        expect((await rawVideo('vid-same')).status).toBe('ready')
    })

    it('ownership loss INSIDE the chunk transaction fences the commit', async () => {
        const server = rangeServer(makeBytes(66, 5 * CHUNK), { etag: '"own-6"' })
        let firstCommitted = false
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url, init) => {
                const response = await server.fetchImpl(url, init)
                if (!firstCommitted) {
                    firstCommitted = true
                    return response
                }
                // Steal the durable claim between chunks: a rival context
                // overwrites the owner record after the first commit.
                await rawPutOwnerRow('vid-fenced', {
                    owner: 'rival-context',
                    acquiredAt: Date.now(),
                    heartbeatAt: Date.now()
                })
                return response
            })
        )

        const result = await service().startDownload(video('vid-fenced'))
        // The writer paused instead of racing on: no fabricated completion.
        expect(result.status).toBe('paused')
        const meta = await rawVideo('vid-fenced')
        expect(meta.status).toBe('paused')
        // The first chunk survived; nothing after the fence was committed.
        expect(await rawChunks('vid-fenced')).toHaveLength(1)
    })

    it('cancel/remove refuses to delete data while a LIVE foreign context owns the download', async () => {
        await seedLegacyV2Database('vid-guard', {
            meta: { status: 'downloading', totalBytes: CHUNK, completedBytes: 0, chunkCount: 0 },
            legacy: { blob: [makeBytes(67, 64)], title: 'متعلق به تب دیگر', mime: 'video/mp4' }
        })
        await service().getDownloads() // run the v2→v3 upgrade first
        await rawPutOwnerRow('vid-guard', {
            owner: 'live-foreign-tab',
            acquiredAt: Date.now(),
            heartbeatAt: Date.now()
        })

        await service().cancelDownload('vid-guard')
        expect(await rawVideo('vid-guard')).not.toBeNull() // data untouched
        expect(await rawLegacyRow('vid-guard')).not.toBeNull() // legacy preserved too
        const claim = await rawOwnerRow('vid-guard')
        expect(claim.owner).toBe('live-foreign-tab')

        await service().removeDownload('vid-guard')
        expect(await rawVideo('vid-guard')).not.toBeNull()
        expect(await rawLegacyRow('vid-guard')).not.toBeNull()
    })

    it('cancel deletes normally when the foreign claim has EXPIRED (crashed owner)', async () => {
        await seedLegacyV2Database('vid-guard-stale', {
            meta: { status: 'downloading', totalBytes: CHUNK, completedBytes: 0, chunkCount: 0 },
            legacy: { blob: [makeBytes(69, 64)], title: 'مالک مرده', mime: 'video/mp4' }
        })
        await service().getDownloads() // run the v2→v3 upgrade first
        await rawPutOwnerRow('vid-guard-stale', {
            owner: 'dead-tab',
            acquiredAt: Date.now() - 60_000,
            heartbeatAt: Date.now() - 60_000
        })

        await service().cancelDownload('vid-guard-stale')
        expect(await rawVideo('vid-guard-stale')).toBeNull()
        expect(await rawLegacyRow('vid-guard-stale')).toBeNull()
        expect(await rawOwnerRow('vid-guard-stale')).toBeNull()
    })

    it('claiming overwrites only an EXPIRED foreign claim; release deletes only our own record', async () => {
        const server = rangeServer(makeBytes(70, CHUNK), { etag: '"own-hb"' })
        vi.stubGlobal('fetch', server.fetchImpl)

        await seedLegacyV2Database('vid-hb', { meta: null })
        await service().getDownloads() // run the v2→v3 upgrade first

        // An EXPIRED foreign claim is replaced by ours when we start.
        await rawPutOwnerRow('vid-hb', {
            owner: 'dead-tab',
            acquiredAt: Date.now() - 60_000,
            heartbeatAt: Date.now() - 60_000
        })
        const result = await service().startDownload(video('vid-hb'))
        expect(result.status).toBe('ready')
        // Settled ownership releases the record entirely.
        expect(await rawOwnerRow('vid-hb')).toBeNull()

        // A LIVE foreign claim is never overwritten and never deleted by our
        // own lifecycle (verified in the refusal tests above).
        await rawPutOwnerRow('vid-hb', {
            owner: 'live-foreign-tab',
            acquiredAt: Date.now(),
            heartbeatAt: Date.now()
        })
        const refused = await service().startDownload(video('vid-hb'))
        expect(refused.ownedByOtherContext).toBe(true)
        expect((await rawOwnerRow('vid-hb')).owner).toBe('live-foreign-tab')
    })

    it('a reloaded context (fresh module instance) re-claims the expired claim and resumes from committed chunks', async () => {
        // Durable state exactly as a crashed tab would have left it: one
        // committed chunk, a paused metadata row with a strong ETag, and an
        // ownership claim whose heartbeat stopped 60 seconds ago.
        const source = makeBytes(71, 5 * CHUNK)
        await seedLegacyV2Database('vid-restart', {
            meta: {
                status: 'paused',
                totalBytes: 5 * CHUNK,
                completedBytes: CHUNK,
                chunkCount: 1,
                quality: 240,
                mimeType: 'video/mp4',
                etag: '"own-reload"',
                etagStrong: true,
                lastModified: null,
                pausedReason: 'timeout',
                createdAt: Date.now() - 120_000,
                updatedAt: Date.now() - 60_000
            },
            legacy: {}
        })
        await service().getDownloads() // run the v2→v3 upgrade first
        await rawPutOwnerRow('vid-restart', {
            owner: 'crashed-tab',
            acquiredAt: Date.now() - 60_000,
            heartbeatAt: Date.now() - 60_000
        })
        // The crashed writer's committed first chunk.
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('yt-offline-db')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        try {
            await new Promise((resolve, reject) => {
                const tx = db.transaction('chunks', 'readwrite')
                tx.objectStore('chunks').put({
                    key: 'vid-restart:000000',
                    videoId: 'vid-restart',
                    index: 0,
                    start: 0,
                    end: CHUNK - 1,
                    size: CHUNK,
                    blob: new Blob([source.slice(0, CHUNK)], { type: 'video/mp4' })
                })
                tx.oncomplete = () => resolve()
                tx.onerror = () => reject(tx.error)
            })
        } finally {
            db.close()
        }

        // The new page load (this module instance) re-claims the expired
        // claim and RESUMES from byte CHUNK — no restart from zero.
        const server = rangeServer(source, { etag: '"own-reload"' })
        vi.stubGlobal('fetch', server.fetchImpl)
        const result = await service().startDownload(video('vid-restart'))
        expect(result.status).toBe('ready')
        expect((await rawVideo('vid-restart')).status).toBe('ready')
        // Resume, not restart: the first request starts at the committed
        // offset, never at 0.
        expect(server.requests[0].start).toBe(CHUNK)
        // Byte-for-byte reconstruction across the restart boundary.
        const chunks = (await rawChunks('vid-restart')).sort((a, b) => a.index - b.index)
        expect(chunks).toHaveLength(5)
        const parts = []
        for (const c of chunks) parts.push(new Uint8Array(await c.blob.arrayBuffer()))
        const merged = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
        let at = 0
        for (const p of parts) {
            merged.set(p, at)
            at += p.length
        }
        expect(Buffer.from(merged).equals(Buffer.from(source))).toBe(true)
        expect(await rawOwnerRow('vid-restart')).toBeNull()
    })
})

/** A truthful 206 whose body never delivers bytes (a stalled connection). */
function stallResponse() {
    return {
        status: 206,
        headers: {
            get: (name) => {
                if (String(name).toLowerCase() === 'content-range') return 'bytes 2097152-4194303/10485760'
                if (String(name).toLowerCase() === 'content-length') return '2097152'
                if (String(name).toLowerCase() === 'etag') return '"own-reload"'
                if (String(name).toLowerCase() === 'content-type') return 'video/mp4'
                return null
            }
        },
        body: new ReadableStream({
            start() {},
            pull() {
                return new Promise(() => {})
            }
        })
    }
}
