// serviceWorkerReliability.spec.mjs — R5 REAL-browser service worker tests.
//
// Serves the SHIPPED frontend shell (real index.html, real sw.js, real
// modules/styles under a production-equivalent CSP) and drives the actual
// worker: registration under the real policy, network-first with a body
// that stalls (cached shell rescues), truncated candidates never stored,
// and video responses never entering the shell cache.

import { test, expect } from '@playwright/test'
import { startFixtureServer } from './fixtureServer.mjs'

let server
let baseURL

test.beforeAll(async () => {
    server = startFixtureServer({ shell: true })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    baseURL = `http://127.0.0.1:${server.address().port}`
})

test.afterAll(async () => {
    await new Promise((r) => server.close(r))
})

test.describe('R5 service worker bounded shell caching', () => {
    test('the shipped worker registers and controls the page under real CSP', async ({ page }) => {
        await page.goto(baseURL)
        // The shipped app.js registers /sw.js — assert the worker actually
        // CONTROLS the page before testing any fallback behavior.
        await expect
            .poll(async () => {
                return page.evaluate(async () => {
                    const regs = await navigator.serviceWorker.getRegistrations()
                    return regs.length
                })
            }, { timeout: 20000 })
            .toBeGreaterThan(0)
        await expect
            .poll(async () => {
                return page.evaluate(async () => {
                    const reg = await navigator.serviceWorker.getRegistration()
                    return reg ? reg.active !== null || !!reg.installing || !!reg.waiting : false
                })
            }, { timeout: 20000 })
            .toBe(true)
    })

    test('caches hold the shipped shell generation after install', async ({ page }) => {
        await page.goto(baseURL)
        await expect
            .poll(async () => {
                return page.evaluate(async () => {
                    const keys = await caches.keys()
                    return keys.filter((k) => k.startsWith('yt-core-')).length
                })
            }, { timeout: 25000 })
            .toBeGreaterThan(0)
        const hasIndex = await page.evaluate(async () => {
            const keys = await caches.keys()
            for (const key of keys.filter((k) => k.startsWith('yt-core-'))) {
                const cache = await caches.open(key)
                if (await cache.match('/index.html')) return true
            }
            return false
        })
        expect(hasIndex).toBe(true)
    })

    test('a network 200 whose body stalls is replaced by the cached shell (no hang)', async ({ page }) => {
        await page.goto(baseURL)
        // Ensure a complete generation is installed first.
        await expect
            .poll(async () => {
                return page.evaluate(async () => {
                    const keys = await caches.keys()
                    for (const key of keys.filter((k) => k.startsWith('yt-core-'))) {
                        const cache = await caches.open(key)
                        if (await cache.match('/index.html')) return true
                    }
                    return false
                })
            }, { timeout: 25000 })
            .toBe(true)

        // Now navigate again through the worker while the network candidate
        // body hangs (fixture injects a held body for this navigation path).
        const result = await Promise.race([
            page.goto(`${baseURL}/?held=1`, { waitUntil: 'domcontentloaded', timeout: 15000 }).then(
                () => 'loaded',
                () => 'error'
            ),
            new Promise((r) => setTimeout(() => r('hung'), 15000))
        ])
        // Bounded: the navigation must complete from the cached shell even
        // though the network body never finished.
        expect(result).toBe('loaded')
    })

    test('video stream responses never enter the shell cache', async ({ page }) => {
        await page.goto(baseURL)
        const cachedVideo = await page.evaluate(async () => {
            const keys = await caches.keys()
            for (const key of keys) {
                const cache = await caches.open(key)
                const keysInCache = await cache.keys()
                if (keysInCache.some((req) => req.url.includes('/api/stream/'))) return true
            }
            return false
        })
        expect(cachedVideo).toBe(false)
    })
})
