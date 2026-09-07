// Feed/search architecture tests. The yt-dlp runner module is mocked so no
// real YouTube traffic happens; the batch cache + pagination logic is real.

import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../src/services/ytdlp/runYtDlp.js', () => {
  class MockYtDlpError extends Error {
    category = 'mock'
    constructor(message: string, category = 'mock', _extra?: unknown) {
      super(message)
      this.category = category
    }
  }
  return { runYtDlp: vi.fn(), YtDlpError: MockYtDlpError }
})

import { runYtDlp } from '../src/services/ytdlp/runYtDlp.js'
import { buildYtSearchString, getCategories, getTrendingForCategory } from '../src/services/youtube/trendingService.js'
import { staleCache, loadWithStale } from '../src/services/cache/staleCache.js'

const BATCH = 45

function entry(index: number) {
  return {
    id: `tv${String(index).padStart(9, '0')}`,
    title: `Mock video ${index}`,
    description: '',
    duration: 120,
    uploader: 'Mock Channel',
    view_count: 1000 + index,
    timestamp: Math.floor(Date.now() / 1000) - 60,
    upload_date: '20260901'
  }
}

function mockBatch(n: number) {
  vi.mocked(runYtDlp).mockImplementation(async () => ({
    stdout: JSON.stringify({ entries: Array.from({ length: n }, (_, i) => entry(i)) }),
    stderr: ''
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  staleCache.clear()
})

describe('feed search-string generation', () => {
  it('generates ytsearchdateN for date-sorted categories and ytsearchN otherwise', () => {
    expect(buildYtSearchString('popular music', 'date', 40)).toBe('ytsearchdate40:popular music')
    expect(buildYtSearchString('live stream', 'relevance', 20)).toBe('ytsearch20:live stream')
  })

  it('no stale year-pinned queries exist in category config', () => {
    for (const cat of getCategories()) {
      expect(cat.queryText).not.toMatch(/\b20\d\d\b/)
    }
  })
})

describe('category batch pagination', () => {
  it('pages slice the same batch, hasMore is honest, and out-of-range pages are empty (no page-1 fallback)', async () => {
    mockBatch(BATCH)

    const seen: string[] = []
    let page = 1
    for (;;) {
      const result = await getTrendingForCategory('music', page, 12)
      for (const v of result.videos as Array<{ id: string }>) seen.push(v.id)
      if (result.videos.length === 0) break
      if (!result.hasMore) {
        // A final honest page then an empty page.
        const next = await getTrendingForCategory('music', page + 1, 12)
        expect(next.videos).toHaveLength(0)
        expect(next.hasMore).toBe(false)
        break
      }
      page += 1
      expect(page).toBeLessThan(50)
    }

    // Every page served the same underlying batch — the runner ran once.
    expect(vi.mocked(runYtDlp)).toHaveBeenCalledTimes(1)
    const args = vi.mocked(runYtDlp).mock.calls[0][0] as string[]
    expect(args.join(' ')).toContain('ytsearchdate')
    // No duplicates across pages, bounded by the actual batch size.
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.length).toBeLessThanOrEqual(BATCH)

    // A nonsense page must NOT fall back to page 1 (still cached, no re-run).
    const huge = await getTrendingForCategory('music', 999, 12)
    expect(huge.videos).toHaveLength(0)
    expect(huge.hasMore).toBe(false)
    expect(vi.mocked(runYtDlp)).toHaveBeenCalledTimes(1)
  })

  it('limit changes slice the cached batch without re-fetching or mixing caches', async () => {
    mockBatch(BATCH)

    const small = await getTrendingForCategory('music', 1, 5)
    const big = await getTrendingForCategory('music', 1, 12)
    const smallAgain = await getTrendingForCategory('music', 1, 5)

    expect(small.videos).toHaveLength(5)
    expect(big.videos).toHaveLength(12)
    expect(smallAgain.videos).toHaveLength(5)
    expect((big.videos[0] as { id: string }).id).toBe((small.videos[0] as { id: string }).id)
    expect((smallAgain.videos as Array<{ id: string }>).map((v) => v.id)).toEqual(
      (small.videos as Array<{ id: string }>).map((v) => v.id)
    )
    expect(vi.mocked(runYtDlp)).toHaveBeenCalledTimes(1)
  })

  it('runs every batch refresh through the shared queue key', async () => {
    mockBatch(5)
    await getTrendingForCategory('tech', 1, 10)
    const opts = vi.mocked(runYtDlp).mock.calls[0][1] as { key?: string }
    expect(opts.key).toContain('feed-batch:tech:')
  })
})

describe('stale-if-error (search/feed refresh must not blank the UI)', () => {
  it('returns the previous successful value when the refresh throws', async () => {
    staleCache.clear()
    const producer = vi
      .fn()
      .mockResolvedValueOnce(['video-a', 'video-b'])
      .mockRejectedValueOnce(new Error('Sign in to confirm you are not a bot'))

    const first = await loadWithStale('feed:music', 15 * 60 * 1000, producer, { staleTtlMs: 2 * 60 * 60 * 1000 })
    expect(first.value).toEqual(['video-a', 'video-b'])
    expect(first.stale).toBe(false)

    // ttlMs=0 forces a refresh, which now fails — stale data must survive.
    const second = await loadWithStale('feed:music', 0, producer, { staleTtlMs: 2 * 60 * 60 * 1000 })
    expect(second.value).toEqual(['video-a', 'video-b'])
    expect(second.stale).toBe(true)
    expect(producer).toHaveBeenCalledTimes(2)
  })

  it('propagates the error when no stale data exists (fresh failure)', async () => {
    const producer = vi.fn().mockRejectedValue(new Error('booom'))
    await expect(loadWithStale('feed:news', 0, producer, { staleTtlMs: 60000 })).rejects.toThrow('booom')
  })
})
