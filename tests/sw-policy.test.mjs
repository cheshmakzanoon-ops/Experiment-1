// sw-policy.test.mjs — worker-policy regression for this release:
//
//   1. cache generation cleanup is NAMESPACE-SCOPED: on the v3 activation
//      only older yt-core-*/yt-runtime-* generations are deleted; the
//      current generation and unrelated same-origin caches survive,
//   2. media / session / diagnostics / health requests are NEVER handled or
//      stored (the IndexedDB downloader owns streams; ordinary online
//      playback relays truthful 206/200 responses untouched).

import { describe, expect, it } from 'vitest'
import {
  CORE_PATHS,
  cachesToDelete,
  isCacheableApiPath,
  isCacheableApiUrl,
  isNeverCacheablePath,
  responseIsCacheable,
  shouldHandleApiRequest
} from '../src/frontend/js/sw-policy.js'

const urlFor = (path) => new URL(path, 'https://household.example')

describe('cache generation cleanup (namespace-scoped)', () => {
  it('deletes only OLD yt-core-/yt-runtime- generations, never unrelated caches', () => {
    const keys = [
      'yt-core-v2', // previous shell generation → stale
      'yt-runtime-v2', // previous runtime generation → stale
      'yt-core-v3', // current generation → kept
      'yt-runtime-v3', // current generation → kept
      'some-other-app-cache', // unrelated same-origin cache → kept
      'yt-core-v1' // older generation → stale
    ]
    const toDelete = cachesToDelete(keys, { core: 'yt-core-v3', runtime: 'yt-runtime-v3' })
    expect(toDelete.sort()).toEqual(['yt-core-v1', 'yt-core-v2', 'yt-runtime-v2'])
  })

  it('the precache list still ships the full self-hosted shell (no external URLs)', () => {
    expect(CORE_PATHS.length).toBeGreaterThan(10)
    for (const path of CORE_PATHS) {
      expect(path.startsWith('/')).toBe(true)
      expect(path).not.toMatch(/^https?:\/\//)
    }
    expect(CORE_PATHS).toContain('/index.html')
    expect(CORE_PATHS).toContain('/js/app.js')
  })
})

describe('media and sensitive requests stay untouched', () => {
  it('/api/stream* is never cacheable and never handled by the SW policy', () => {
    for (const path of [
      '/api/stream/abc123xyz45',
      '/api/stream/abc123xyz45?quality=240',
      '/api/stream/abc123xyz45?range=0-99'
    ]) {
      expect(isNeverCacheablePath(path), path).toBe(true)
      expect(isCacheableApiPath(path), path).toBe(false)
      expect(shouldHandleApiRequest(urlFor(path)), path).toBe(false)
    }
  })

  it('sessions, diagnostics, health and stats are never cached', () => {
    for (const path of [
      '/api/session',
      '/api/session/callback',
      '/api/diag/report',
      '/api/diag/deep',
      '/api/health/live',
      '/api/health/ready',
      '/api/feed/stats',
      '/api/stream/stats'
    ]) {
      expect(isNeverCacheablePath(path), path).toBe(true)
      expect(shouldHandleApiRequest(urlFor(path)), path).toBe(false)
    }
  })

  it('only the explicit allowlist is SW-handled', () => {
    const allowed = [
      '/api/search?q=%D9%85%D9%88%D8%B2%DB%8C%DA%A9&max=3',
      '/api/feed/home',
      '/api/feed/category/music',
      '/api/feed/categories',
      '/api/video/abc123xyz45/thumbnail',
      '/api/video/abc123xyz45'
    ]
    for (const path of allowed) {
      expect(isCacheableApiPath(urlFor(path).pathname), path).toBe(true)
    }
    expect(isCacheableApiPath('/api/unknown')).toBe(false)
    expect(isCacheableApiPath('/api/feed/category/music/extra')).toBe(false)
  })

  it('only successful, non-no-store, non-cookie responses may be stored', () => {
    const ok = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    expect(responseIsCacheable(ok)).toBe(true)

    const noStore = new Response('{}', { status: 200, headers: { 'cache-control': 'no-store' } })
    expect(responseIsCacheable(noStore)).toBe(false)

    expect(responseIsCacheable(new Response('', { status: 401 }))).toBe(false)
    expect(responseIsCacheable(new Response('', { status: 403 }))).toBe(false)
    expect(responseIsCacheable(new Response('', { status: 429 }))).toBe(false)
    expect(responseIsCacheable(new Response('', { status: 500 }))).toBe(false)
    expect(responseIsCacheable(new Response('', { status: 206 }))).toBe(false) // media range
    expect(responseIsCacheable(null)).toBe(false)
  })
})
