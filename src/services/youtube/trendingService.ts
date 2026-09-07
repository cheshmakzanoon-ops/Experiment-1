/**
 * Category/home feeds (single implementation).
 *
 * Architecture (replaces the old per-page query-string rewriting):
 *   - a category is described SEMANTICALLY (query text + sort mode), and the
 *     actual yt-dlp search string (`ytsearchN:` / `ytsearchdateN:`) is built
 *     in exactly one function,
 *   - the server fetches ONE bounded canonical batch per category
 *     (FEED_BATCH_SIZE, default 50) and caches it for FEED_TTL_MS
 *     (default 20 min); pages are served by slicing that cached batch,
 *   - pagination is honest: `hasMore` comes from real batch state and pages
 *     past the end return empty, never silently re-served page 1,
 *   - refreshes are single-flight (identical requests share one fetch),
 *   - a temporary YouTube failure returns the previous successful batch
 *     (stale-on-error) instead of blanking the UI.
 *
 * Date wording is deliberately year-independent (no stale "2024" queries).
 */

import { config } from '../../config.js'
import { runYtDlp, YtDlpError } from '../ytdlp/runYtDlp.js'
import { loadWithStale } from '../cache/staleCache.js'
import type { YtDlpSearchEntry } from './extractor.js'

export type FeedSortMode = 'date' | 'relevance'

export interface Category {
  id: string
  nameFa: string
  nameEn: string
  queryText: string
  sort: FeedSortMode
}

export interface TrendingVideo {
  id: string
  title: string
  description: string
  duration: number
  thumbnail: string
  author: string
  authorId: string
  viewCount: number
  publishedText: string
  uploadDate: string
  isLive: boolean
}

export interface FeedPage {
  videos: TrendingVideo[]
  page: number
  limit: number
  hasMore: boolean
  /** Index of the first item of this page inside the underlying batch. */
  offset: number
}

/**
 * Categories. `sort: 'date'` → `ytsearchdateN` (fresh content),
 * `sort: 'relevance'` → `ytsearchN`.
 */
export const CATEGORIES: Category[] = [
  { id: 'all', nameFa: 'همه', nameEn: 'All', queryText: 'trending', sort: 'date' },
  { id: 'music', nameFa: 'موسیقی', nameEn: 'Music', queryText: 'popular music', sort: 'date' },
  { id: 'gaming', nameFa: 'بازی‌ها', nameEn: 'Gaming', queryText: 'gaming highlights', sort: 'date' },
  { id: 'live', nameFa: 'پخش زنده', nameEn: 'Live', queryText: 'live stream', sort: 'relevance' },
  { id: 'cooking', nameFa: 'آشپزی', nameEn: 'Cooking', queryText: 'cooking recipe', sort: 'date' },
  { id: 'news', nameFa: 'اخبار', nameEn: 'News', queryText: 'news today', sort: 'date' },
  { id: 'comedy', nameFa: 'طنز', nameEn: 'Comedy', queryText: 'funny comedy', sort: 'date' },
  { id: 'learning', nameFa: 'آموزش', nameEn: 'Learning', queryText: 'tutorial', sort: 'date' },
  { id: 'sports', nameFa: 'ورزش', nameEn: 'Sports', queryText: 'sports highlights', sort: 'date' },
  { id: 'tech', nameFa: 'تکنولوژی', nameEn: 'Technology', queryText: 'tech review', sort: 'date' },
  { id: 'movies', nameFa: 'فیلم', nameEn: 'Movies', queryText: 'full movie', sort: 'date' },
  { id: 'kids', nameFa: 'کودکان', nameEn: 'Kids', queryText: 'kids cartoon', sort: 'date' }
]

export function getCategories(): Category[] {
  return CATEGORIES
}

export function getCategory(categoryId: string): Category | null {
  return CATEGORIES.find((c) => c.id === categoryId) || null
}

/**
 * The ONLY place a yt-dlp search string is generated. `count` is the number
 * of entries to ask for; `sort` decides `ytsearchN` vs `ytsearchdateN`.
 */
export function buildYtSearchString(queryText: string, sort: FeedSortMode, count: number): string {
  const prefix = sort === 'date' ? 'ytsearchdate' : 'ytsearch'
  return `${prefix}${count}:${queryText}`
}

// ---------------------------------------------------------------------------
// Persian helpers
// ---------------------------------------------------------------------------

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹']

function toFa(n: number): string {
  return String(n)
    .split('')
    .map((d) => {
      const digit = parseInt(d, 10)
      return Number.isNaN(digit) ? d : PERSIAN_DIGITS[digit] || d
    })
    .join('')
}

export function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return ''
  const now = Math.floor(Date.now() / 1000)
  const diff = now - timestamp
  if (diff < 60) return 'همین حالا'
  if (diff < 3600) return `${toFa(Math.floor(diff / 60))} دقیقه پیش`
  if (diff < 86400) return `${toFa(Math.floor(diff / 3600))} ساعت پیش`
  if (diff < 604800) return `${toFa(Math.floor(diff / 86400))} روز پیش`
  if (diff < 2592000) return `${toFa(Math.floor(diff / 604800))} هفته پیش`
  if (diff < 31536000) return `${toFa(Math.floor(diff / 2592000))} ماه پیش`
  return `${toFa(Math.floor(diff / 31536000))} سال پیش`
}

// ---------------------------------------------------------------------------
// Batch fetch
// ---------------------------------------------------------------------------

const STALE_TTL_MS = 2 * 60 * 60 * 1000

function toTrendingVideo(entry: YtDlpSearchEntry): TrendingVideo | null {
  const id = entry.id
  if (!id || !entry.title) return null
  return {
    id,
    title: entry.title,
    description: entry.description || '',
    duration: entry.duration || 0,
    thumbnail: `/api/video/${id}/thumbnail`,
    author: entry.uploader || entry.channel || 'ناشناس',
    authorId: entry.uploader_id || entry.channel_id || '',
    viewCount: entry.view_count || 0,
    publishedText: formatRelativeTime(entry.timestamp || entry.release_timestamp),
    uploadDate: entry.upload_date || '',
    isLive: entry.is_live === true || entry.live_status === 'is_live'
  }
}

interface BatchOptions {
  /** Number of entries to ask YouTube for. */
  size?: number
  ttlMs?: number
  cachePrefix?: string
  signal?: AbortSignal
}

/**
 * Fetch (or serve from cache) one canonical batch of search entries for a
 * category-like descriptor. Cache keys use only the descriptor + size, so
 * results are independent of the page a caller happens to request.
 */
async function loadBatchForQuery(
  categoryId: string,
  categoryName: string,
  queryText: string,
  sort: FeedSortMode,
  options: BatchOptions = {}
): Promise<TrendingVideo[]> {
  const size = options.size ?? config.feed.batchSize
  const ttlMs = options.ttlMs ?? config.feed.batchTtlMs
  const prefix = options.cachePrefix ?? 'feed'
  const cacheKey = `${prefix}:${categoryId}:${size}`

  const { value } = await loadWithStale(
    cacheKey,
    ttlMs,
    async (): Promise<TrendingVideo[]> => {
      const searchUrl = buildYtSearchString(queryText, sort, size)
      const result = await runYtDlp(
        ['--flat-playlist', '--dump-single-json', searchUrl],
        { key: `${prefix}-batch:${categoryId}:${size}`, signal: options.signal, timeoutMs: 60_000 }
      )

      let parsed: { entries?: YtDlpSearchEntry[] | null }
      try {
        parsed = JSON.parse(result.stdout) as { entries?: YtDlpSearchEntry[] | null }
      } catch (parseError) {
        throw new YtDlpError(`Feed search for ${categoryName} returned malformed output`, 'malformed_output', {
          originalError: parseError
        })
      }

      const videos: TrendingVideo[] = []
      for (const entry of parsed.entries || []) {
        const video = toTrendingVideo(entry)
        if (video) videos.push(video)
      }
      console.log(`[feed] Fetched ${videos.length} entries for ${categoryName} (${searchUrl.split(':', 1)[0]})`)
      return videos
    },
    { staleTtlMs: STALE_TTL_MS }
  )

  return value
}

function slicePage(batch: TrendingVideo[], page: number, limit: number): FeedPage {
  const offset = (page - 1) * limit
  const videos = offset >= batch.length ? [] : batch.slice(offset, offset + limit)
  return {
    videos,
    page,
    limit,
    offset,
    hasMore: offset + videos.length < batch.length && videos.length > 0
  }
}

export interface CategoryFeedResult {
  videos: TrendingVideo[]
  stale: boolean
  fetchedAt: number
}

/** One page of a category feed (batched behind the scenes). */
export async function getTrendingForCategory(
  categoryId: string,
  page = 1,
  limit = 12,
  options: { signal?: AbortSignal } = {}
): Promise<FeedPage> {
  const category = getCategory(categoryId)
  if (!category) throw new Error('Invalid category')

  const pageNum = Math.floor(page)
  const pageLimit = Math.floor(limit)
  if (pageNum < 1) throw new Error('Invalid page')
  if (pageLimit < 1) throw new Error('Invalid limit')

  const batch = await loadBatchForQuery(category.id, category.nameEn, category.queryText, category.sort, {
    signal: options.signal
  })
  return slicePage(batch, pageNum, pageLimit)
}

// ---------------------------------------------------------------------------
// Home feed (rotating mix of category batches)
// ---------------------------------------------------------------------------

const HOME_MIX = ['music', 'gaming', 'comedy', 'news', 'cooking', 'learning'] as const
const HOME_CATEGORIES_PER_REFRESH = 3
const HOME_PER_CATEGORY = 18

function pickHomeCategories(now = Date.now()): Category[] {
  const hourBucket = Math.floor(now / 3_600_000)
  const start = (hourBucket * HOME_CATEGORIES_PER_REFRESH) % HOME_MIX.length
  const picked: Category[] = []
  for (let i = 0; i < HOME_CATEGORIES_PER_REFRESH; i++) {
    const category = getCategory(HOME_MIX[(start + i) % HOME_MIX.length])
    if (category) picked.push(category)
  }
  return picked
}

/** Interleave category batches YouTube-style into one home list. */
async function loadHomeBatch(): Promise<TrendingVideo[]> {
  const categories = pickHomeCategories()
  const batches = await Promise.all(
    categories.map((category) =>
      loadBatchForQuery(`home:${category.id}`, category.nameEn, category.queryText, category.sort, {
        size: HOME_PER_CATEGORY,
        ttlMs: config.feed.homeTtlMs,
        cachePrefix: 'home'
      }).catch(() => [] as TrendingVideo[])
    )
  )

  const interleaved: TrendingVideo[] = []
  const maxLen = Math.max(0, ...batches.map((b) => b.length))
  for (let i = 0; i < maxLen; i++) {
    for (const batch of batches) {
      const video = batch[i]
      if (video) interleaved.push(video)
    }
  }
  return interleaved.slice(0, config.feed.homeBatchSize)
}

/** One page of the mixed home feed. */
export async function getHomeFeed(
  page = 1,
  limit = 12,
  options: { signal?: AbortSignal } = {}
): Promise<FeedPage> {
  const pageNum = Math.floor(page)
  const pageLimit = Math.floor(limit)
  if (pageNum < 1) throw new Error('Invalid page')
  if (pageLimit < 1) throw new Error('Invalid limit')

  const cacheKey = 'home:canonical'
  const { value } = await loadWithStale(cacheKey, config.feed.homeTtlMs, loadHomeBatch, {
    staleTtlMs: STALE_TTL_MS
  })
  return slicePage(value, pageNum, pageLimit)
}
