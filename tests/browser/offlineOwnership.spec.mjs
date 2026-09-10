// offlineOwnership.spec.mjs — REAL-browser regression for A03/A05/A10.
//
// Serves the SHIPPED src/frontend tree over HTTP with a deterministic Range
// backend and drives the actual offlineService.js module in real Chromium
// contexts: two pages (one IndexedDB origin partition), heartbeat-fenced
// ownership across contexts, legacy v1 Blob playback, and the v1→v3 upgrade
// preserving the `blobs` store. Node-side Vitest (fake-indexeddb) covers the
// byte-level contract; this spec covers the lifecycles only a real browser
// has (real IDB, real Blobs, real cross-context partitions).
//
// Run: npm run test:browser  (requires `npx playwright install chromium` once)

import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const TOTAL = 1024 * 1024 // 1 MiB source → one 2 MiB-chunk download

/** Deterministic source bytes so byte-level assertions are stable. */
function sourceBytes(total) {
    const bytes = new Uint8Array(total)
    for (let i = 0; i < total; i++) bytes[i] = (i * 31 + 7) & 0xff
    return bytes
}

function startFixtureServer() {
    const SOURCE = sourceBytes(TOTAL)
    const shell = `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>fixture</title></head>
<body><div id="authGate"></div><div id="app"></div></body></html>`

    // Cross-context gating: hold the FIRST range request for vid-cross so the
    // second page can observe a genuinely in-flight foreign download.
    let holdVidCross = true

    const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x')
        const send = (status, body, headers = {}) => {
            res.writeHead(status, headers)
            res.end(body)
        }
        if (url.pathname === '/') return send(200, shell, { 'content-type': 'text/html; charset=utf-8' })
        if (url.pathname === '/api/session') {
            return send(200, JSON.stringify({ authenticated: true, authMode: 'session' }), {
                'content-type': 'application/json'
            })
        }
        const streamMatch = url.pathname.match(/^\/api\/stream\/([^/?]+)/)
        if (streamMatch) {
            const id = decodeURIComponent(streamMatch[1])
            const range = req.headers.range || ''
            const m = range.match(/^bytes=(\d+)-(\d+)$/)
            if (!m) return send(416, '', { 'content-range': 'bytes */' + TOTAL })
            let start = Number(m[1])
            let end = Math.min(Number(m[2]), TOTAL - 1)
            if (id === 'vid-cross' && holdVidCross && start === 0) {
                holdVidCross = false
                await new Promise((r) => setTimeout(r, 900))
            }
            const slice = SOURCE.subarray(start, end + 1)
            return send(206, slice, {
                'content-type': 'video/mp4',
                'content-length': String(slice.length),
                'content-range': `bytes ${start}-${end}/${TOTAL}`,
                'accept-ranges': 'bytes',
                etag: '"range-fixture-1"'
            })
        }
        // Ship the real frontend modules verbatim.
        if (url.pathname.startsWith('/js/')) {
            try {
                const file = await readFile(join('src/frontend', url.pathname))
                return send(200, file, { 'content-type': 'text/javascript; charset=utf-8' })
            } catch {
                return send(404, 'not found')
            }
        }
        send(404, 'not found')
    })
    return server
}

let server
let baseURL

test.beforeAll(async () => {
    server = startFixtureServer()
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    baseURL = `http://127.0.0.1:${server.address().port}`
})

test.afterAll(async () => {
    await new Promise((r) => server.close(r))
})

/**
 * Load the shipped service inside the page and call startDownload.
 * The shipped module imports ../api.js relative to its own URL, so serving
 * the tree verbatim under /js/ gives us the REAL networking layer too.
 */
async function downloadInPage(page, videoId) {
    return page.evaluate(async (id) => {
        const svc = await import('/js/services/offlineService.js')
        return svc.startDownload({ id, title: 'تست', author: 'کارتست' })
    }, videoId)
}

async function rawStores(page) {
    return page.evaluate(async () => {
        function openDb() {
            return new Promise((res, rej) => {
                const req = indexedDB.open('yt-offline-db', 3)
                req.onsuccess = () => res(req.result)
                req.onerror = () => rej(req.error)
            })
        }
        const db = await openDb()
        function getAll(store) {
            return new Promise((res, rej) => {
                const tx = db.transaction(store, 'readonly')
                const req = tx.objectStore(store).getAll()
                req.onsuccess = () => res(req.result)
                req.onerror = () => rej(req.error)
            })
        }
        const out = {
            videos: await getAll('videos'),
            // Blob records do not survive page→Node serialization — expose
            // only their byte sizes here (byte-equality is asserted in-page
            // where needed).
            chunkSizes: (await getAll('chunks')).map((c) => ({
                videoId: c.videoId,
                size: c.blob ? c.blob.size : null
            })),
            operations: await getAll('operations'),
            blobs: db.objectStoreNames.contains('blobs')
                ? (await getAll('blobs')).map((b) => ({ id: b.id, size: b.blob ? b.blob.size : null }))
                : null
        }
        db.close()
        return out
    })
}

/**
 * Seed/overwrite an ownership row. When the database does not exist yet this
 * creates a complete v3 profile (all three stores) so the row itself and the
 * store set are exactly what a shipped-service profile would carry.
 */
async function seedOwnership(page, videoId, owner, heartbeatAgeMs) {
    await page.evaluate(
        ({ id, owner, age }) => {
            return new Promise((res, rej) => {
                function openExisting() {
                    return new Promise((res2, rej2) => {
                        const probe = indexedDB.open('yt-offline-db')
                        probe.onupgradeneeded = () => {
                            // No database existed: build the full v3 profile.
                            const db = probe.result
                            db.createObjectStore('videos', { keyPath: 'id' })
                            db.createObjectStore('chunks', { keyPath: 'key' })
                            db.createObjectStore('operations', { keyPath: 'videoId' })
                        }
                        probe.onsuccess = () => res2(probe.result)
                        probe.onerror = () => rej2(probe.error)
                    })
                }
                openExisting().then((db) => {
                    const tx = db.transaction('operations', 'readwrite')
                    tx.objectStore('operations').put({
                        videoId: `owner:${id}`,
                        owner,
                        acquiredAt: Date.now() - age,
                        heartbeatAt: Date.now() - age,
                        previousOwner: null
                    })
                    tx.oncomplete = () => {
                        db.close()
                        res()
                    }
                    tx.onerror = () => rej(tx.error)
                })
            })
        },
        { id: videoId, owner, age: heartbeatAgeMs }
    )
}

test.describe('A03/A10 — durable cross-context download ownership', () => {
    test('a download completing in page A releases its ownership row and is byte-complete', async ({ page }) => {
        await page.goto(baseURL)
        const result = await downloadInPage(page, 'vid-single')
        expect(result.status).toBe('ready')

        const stores = await rawStores(page)
        expect(stores.videos).toHaveLength(1)
        expect(stores.videos[0]).toMatchObject({ id: 'vid-single', status: 'ready', totalBytes: TOTAL })
        expect(stores.chunkSizes.filter((c) => c.videoId === 'vid-single')).toEqual([
            { videoId: 'vid-single', size: TOTAL }
        ])
        // Ownership was released on settlement — no stale claim remains.
        expect(stores.operations).toHaveLength(0)
    })

    test('a second page sees a live foreign download and refuses to spawn a rival writer', async ({ page, context }) => {
        await page.goto(baseURL)
        // vid-cross's first range response is held server-side, so this
        // startDownload is genuinely mid-flight when page B looks.
        const firstPromise = downloadInPage(page, 'vid-cross')

        const pageB = await context.newPage()
        await pageB.goto(baseURL)

        await expect
            .poll(async () => {
                const stores = await rawStores(pageB)
                return stores.operations.find((row) => row.videoId === 'owner:vid-cross') || null
            })
            .not.toBeNull()

        const rival = await downloadInPage(pageB, 'vid-cross')
        expect(rival).toMatchObject({ id: 'vid-cross', status: 'downloading', ownedByOtherContext: true })

        // Page A finishes; the durable claim is released.
        const first = await firstPromise
        expect(first.status).toBe('ready')
        await expect
            .poll(async () => (await rawStores(pageB)).operations.filter((r) => r.videoId === 'owner:vid-cross').length)
            .toBe(0)

        // Now page B can own it — and the completed data is intact (no
        // re-download destroyed it).
        const resumed = await downloadInPage(pageB, 'vid-cross')
        expect(resumed.status).toBe('ready')
        const stores = await rawStores(pageB)
        expect(stores.chunkSizes.filter((c) => c.videoId === 'vid-cross')).toHaveLength(1)
    })

    test('cancel and remove refuse to delete data owned by a live foreign context', async ({ page }) => {
        await page.goto(baseURL)
        // Seed partial data + a LIVE foreign claim (fresh heartbeat). The
        // probe-open builds the full v3 store set when no profile exists yet
        // (a bare open(name, 3) would create a store-less database).
        await page.evaluate((totalBytes) => {
            return new Promise((res, rej) => {
                const probe = indexedDB.open('yt-offline-db')
                probe.onupgradeneeded = () => {
                    const db = probe.result
                    db.createObjectStore('videos', { keyPath: 'id' })
                    db.createObjectStore('chunks', { keyPath: 'key' })
                    db.createObjectStore('operations', { keyPath: 'videoId' })
                }
                probe.onerror = () => rej(probe.error)
                probe.onsuccess = () => {
                    const db = probe.result
                    const tx = db.transaction(['videos', 'chunks', 'operations'], 'readwrite')
                    tx.objectStore('videos').put({
                        id: 'vid-foreign',
                        status: 'paused',
                        totalBytes,
                        completedBytes: 10,
                        chunkCount: 1,
                        pausedReason: null,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    })
                    tx.objectStore('chunks').put({
                        key: 'vid-foreign:000000',
                        videoId: 'vid-foreign',
                        index: 0,
                        start: 0,
                        end: 9,
                        size: 10,
                        blob: new Blob([new Uint8Array(10)])
                    })
                    tx.objectStore('operations').put({
                        videoId: 'owner:vid-foreign',
                        owner: 'someone-else',
                        acquiredAt: Date.now(),
                        heartbeatAt: Date.now(),
                        previousOwner: null
                    })
                    tx.oncomplete = () => {
                        db.close()
                        res()
                    }
                    tx.onerror = () => rej(tx.error)
                }
            })
        }, TOTAL)

        const svcInPage = (fn, arg) =>
            page.evaluate(async ({ name, id }) => {
                const svc = await import('/js/services/offlineService.js')
                await svc[name](id)
                return null
            }, { name: fn, id: arg })

        await svcInPage('cancelDownload', 'vid-foreign')
        let stores = await rawStores(page)
        expect(stores.videos.find((v) => v.id === 'vid-foreign')).toBeTruthy()
        expect(stores.chunkSizes.filter((c) => c.videoId === 'vid-foreign')).toHaveLength(1)
        expect(stores.operations.find((r) => r.videoId === 'owner:vid-foreign')).toBeTruthy()

        await svcInPage('removeDownload', 'vid-foreign')
        stores = await rawStores(page)
        expect(stores.videos.find((v) => v.id === 'vid-foreign')).toBeTruthy()

        // Once the foreign claim expires (or is removed) deletion proceeds.
        await seedOwnership(page, 'vid-foreign', 'someone-else', 60_000)
        await svcInPage('removeDownload', 'vid-foreign')
        stores = await rawStores(page)
        expect(stores.videos.find((v) => v.id === 'vid-foreign')).toBeFalsy()
        expect(stores.chunkSizes.filter((c) => c.videoId === 'vid-foreign')).toHaveLength(0)
    })

    test('a startDownload over a LIVE foreign claim reports the foreign state; an expired claim is re-claimed', async ({ page }) => {
        await page.goto(baseURL)
        await seedOwnership(page, 'vid-claim-live', 'tab-one', 0)
        const live = await downloadInPage(page, 'vid-claim-live')
        expect(live).toMatchObject({ status: 'downloading', ownedByOtherContext: true })

        await seedOwnership(page, 'vid-claim-dead', 'tab-zero', 60_000)
        const dead = await downloadInPage(page, 'vid-claim-dead')
        expect(dead.status).toBe('ready')
    })
})

test.describe('A05 — legacy v1 monolithic downloads survive the v3 upgrade', () => {
    test('v1 profile upgrades to v3 keeping the blobs store readable, playable, deletable', async ({ page }) => {
        await page.goto(baseURL)

        // Build an authentic v1 profile: DB version 1 with ONLY a `blobs`
        // store holding one monolithic download.
        await page.evaluate(() => {
            return new Promise((res, rej) => {
                const req = indexedDB.open('yt-offline-db', 1)
                req.onupgradeneeded = () => {
                    req.result.createObjectStore('blobs', { keyPath: 'id' })
                }
                req.onsuccess = () => {
                    const db = req.result
                    const tx = db.transaction('blobs', 'readwrite')
                    tx.objectStore('blobs').put({
                        id: 'vid-legacy',
                        title: 'ویدیوی قدیمی',
                        author: 'کانال قدیمی',
                        mimeType: 'video/mp4',
                        blob: new Blob([new Uint8Array(2048)], { type: 'video/mp4' }),
                        createdAt: 1_700_000_000_000,
                        updatedAt: 1_700_000_000_000
                    })
                    tx.oncomplete = () => {
                        db.close()
                        res()
                    }
                    tx.onerror = () => rej(tx.error)
                }
                req.onerror = () => rej(req.error)
            })
        })

        // The shipped service opens v3 and must NOT delete the legacy store.
        const listed = await page.evaluate(async () => {
            const svc = await import('/js/services/offlineService.js')
            return svc.getDownloads()
        })
        const legacy = listed.find((r) => r.id === 'vid-legacy')
        expect(legacy).toBeTruthy()
        expect(legacy.status).toBe('ready')
        expect(legacy.totalBytes).toBe(2048)
        expect(legacy.legacy).toBe(true)

        // Byte-playable through a real Blob URL.
        const url = await page.evaluate(async (id) => {
            const svc = await import('/js/services/offlineService.js')
            return svc.offlinePlayUrl(id)
        }, 'vid-legacy')
        expect(url).toBeTruthy()
        const size = await page.evaluate(async (blobUrl) => {
            const blob = await (await fetch(blobUrl)).blob()
            return blob.size
        }, url)
        expect(size).toBe(2048)

        // A corrupt row (no real Blob) is invisible — never fabricated.
        await page.evaluate(() => {
            return new Promise((res, rej) => {
                const req = indexedDB.open('yt-offline-db', 3)
                req.onsuccess = () => {
                    const db = req.result
                    const tx = db.transaction('blobs', 'readwrite')
                    tx.objectStore('blobs').put({ id: 'vid-corrupt', title: 'x' })
                    tx.oncomplete = () => {
                        db.close()
                        res()
                    }
                    tx.onerror = () => rej(tx.error)
                }
                req.onerror = () => rej(req.error)
            })
        })
        const afterCorrupt = await page.evaluate(async () => {
            const svc = await import('/js/services/offlineService.js')
            return {
                single: await svc.getDownload('vid-corrupt'),
                all: (await svc.getDownloads()).map((r) => r.id)
            }
        })
        expect(afterCorrupt.single).toBeNull()
        expect(afterCorrupt.all).not.toContain('vid-corrupt')

        // Explicit user removal reaches the legacy store; only then.
        await page.evaluate(async (id) => {
            const svc = await import('/js/services/offlineService.js')
            await svc.removeDownload(id)
        }, 'vid-legacy')
        const remaining = await rawStores(page)
        expect(remaining.blobs.filter((b) => b.id === 'vid-legacy')).toHaveLength(0)
        expect(remaining.blobs.filter((b) => b.id === 'vid-corrupt')).toHaveLength(1) // untouched
    })
})
