import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Category {
  id: string
  nameFa: string // Persian display name
  nameEn: string // English name (for logging)
  searchQuery: string // YouTube search query
  ytDlpQuery: string // Full yt-dlp search string
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

/**
 * Since we use yt-dlp (not the YouTube API) there is no real "trending"
 * endpoint: each category is a search for recent popular content. The search
 * results are cached for 30 minutes so scrolling/visits don't hammer YouTube.
 */

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const CATEGORIES: Category[] = [
  { id: 'all', nameFa: 'همه', nameEn: 'All', searchQuery: 'trending', ytDlpQuery: 'ytsearchdate20:trending today' },
  { id: 'music', nameFa: 'موسیقی', nameEn: 'Music', searchQuery: 'popular music', ytDlpQuery: 'ytsearchdate20:popular music 2024' },
  { id: 'gaming', nameFa: 'بازی‌ها', nameEn: 'Gaming', searchQuery: 'gaming highlights', ytDlpQuery: 'ytsearchdate20:gaming highlights' },
  { id: 'live', nameFa: 'پخش زنده', nameEn: 'Live', searchQuery: 'live stream', ytDlpQuery: 'ytsearch20:live stream' },
  { id: 'cooking', nameFa: 'آشپزی', nameEn: 'Cooking', searchQuery: 'cooking recipe', ytDlpQuery: 'ytsearchdate20:cooking recipe easy' },
  { id: 'news', nameFa: 'اخبار', nameEn: 'News', searchQuery: 'news today', ytDlpQuery: 'ytsearchdate20:news today' },
  { id: 'comedy', nameFa: 'طنز', nameEn: 'Comedy', searchQuery: 'funny comedy', ytDlpQuery: 'ytsearchdate20:funny comedy clips' },
  { id: 'learning', nameFa: 'آموزش', nameEn: 'Learning', searchQuery: 'tutorial', ytDlpQuery: 'ytsearchdate20:tutorial how to' },
  { id: 'sports', nameFa: 'ورزش', nameEn: 'Sports', searchQuery: 'sports highlights', ytDlpQuery: 'ytsearchdate20:sports highlights' },
  { id: 'tech', nameFa: 'تکنولوژی', nameEn: 'Technology', searchQuery: 'tech review', ytDlpQuery: 'ytsearchdate20:tech review new' },
  { id: 'movies', nameFa: 'فیلم', nameEn: 'Movies', searchQuery: 'full movie', ytDlpQuery: 'ytsearchdate20:full movie free' },
  { id: 'kids', nameFa: 'کودکان', nameEn: 'Kids', searchQuery: 'kids cartoon', ytDlpQuery: 'ytsearchdate20:kids cartoon' }
]

export function getCategories(): Category[] {
  return CATEGORIES
}

// ---------------------------------------------------------------------------
// Feed cache (separate from the stream cache)
// ---------------------------------------------------------------------------

interface FeedCacheEntry {
  categoryId: string
  videos: TrendingVideo[]
  fetchedAt: number
  expiresAt: number
}

class FeedCache {
  private cache = new Map<string, FeedCacheEntry>()
  private maxSize = 100
  private static TTL = 30 * 60 * 1000 // 30 minutes

  get(categoryId: string, page: number): TrendingVideo[] | null {
    const key = `${categoryId}:${page}`
    const entry = this.cache.get(key)

    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }

    return entry.videos
  }

  set(categoryId: string, page: number, videos: TrendingVideo[]): void {
    const key = `${categoryId}:${page}`
    const now = Date.now()

    // Evict oldest entry when the cache is full (Map preserves insertion order).
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }

    this.cache.set(key, {
      categoryId,
      videos,
      fetchedAt: now,
      expiresAt: now + FeedCache.TTL
    })
  }

  clear(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }
}

export const feedCache = new FeedCache()

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

/** Format a unix timestamp as a Persian relative time string. */
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
// Trending fetch
// ---------------------------------------------------------------------------

/** Shape of a yt-dlp flat-playlist search entry (fields are sparse by design). */
interface SearchEntry {
  id?: string
  title?: string
  description?: string
  duration?: number
  uploader?: string
  uploader_id?: string
  channel?: string
  channel_id?: string
  view_count?: number
  timestamp?: number
  release_timestamp?: number
  upload_date?: string
  is_live?: boolean
  live_status?: string
  [key: string]: unknown
}

interface SearchResponse {
  entries?: SearchEntry[] | null
}

function toTrendingVideo(entry: SearchEntry): TrendingVideo | null {
  const id = entry.id
  if (!id || !entry.title) return null

  const uploadTimestamp = entry.timestamp || entry.release_timestamp

  return {
    id,
    title: entry.title,
    description: entry.description || '',
    duration: entry.duration || 0,
    // Rewritten to the local thumbnail proxy — i.ytimg.com is blocked for
    // the household, so clients must never load thumbnails directly.
    thumbnail: `/api/video/${id}/thumbnail`,
    author: entry.uploader || entry.channel || 'ناشناس',
    authorId: entry.uploader_id || entry.channel_id || '',
    viewCount: entry.view_count || 0,
    publishedText: formatRelativeTime(uploadTimestamp),
    uploadDate: entry.upload_date || '',
    isLive: entry.is_live === true || entry.live_status === 'is_live'
  }
}

/**
 * Get trending videos for a category (page N). Because yt-dlp search has no
 * offset support, each page re-runs the search and slices out its window.
 */
export async function getTrendingForCategory(
  categoryId: string,
  page: number = 1,
  videosPerPage: number = 12
): Promise<TrendingVideo[]> {
  const category = CATEGORIES.find((c) => c.id === categoryId)
  if (!category) {
    throw new Error(`Invalid category: ${categoryId}`)
  }
  if (page < 1 || page > 10) {
    throw new Error('Page must be between 1 and 10')
  }

  const cached = feedCache.get(categoryId, page)
  if (cached) return cached

  // Fetch enough entries to cover this page, then slice out our window.
  const totalToFetch = Math.min(page * videosPerPage, 50)
  const startIndex = (page - 1) * videosPerPage

  // "همه"/all rotates through broad topics so consecutive refreshes differ.
  let searchQuery: string
  if (categoryId === 'all') {
    const topics = ['viral', 'popular', 'trending', 'music', 'funny', 'news']
    const topic = topics[Math.floor(Date.now() / 3600000) % topics.length]
    searchQuery = `ytsearch${totalToFetch}:${topic} this week`
  } else {
    searchQuery = category.ytDlpQuery.replace(/ytsearch\d+:/, `ytsearch${totalToFetch}:`)
  }

  const args = [
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    '--no-progress',
    '--socket-timeout', '30',
    '--retries', '2',
    searchQuery
  ]

  console.log(`[trending] Fetching ${category.nameEn} page ${page} (query: ${searchQuery})`)

  try {
    const { stdout } = await execFileAsync('yt-dlp', args, {
      maxBuffer: 15 * 1024 * 1024,
      timeout: 60000
    })

    const response = JSON.parse(stdout) as SearchResponse
    const entries = response.entries || []

    const videos = entries
      .slice(startIndex, startIndex + videosPerPage)
      .map(toTrendingVideo)
      .filter((v): v is TrendingVideo => v !== null)

    // If the search returned fewer entries than the page window (rare), the
    // last slice can be empty — nothing to cache or return.
    feedCache.set(categoryId, page, videos)
    return videos
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[trending] Failed to fetch ${category.nameEn} page ${page}:`, message)

    // Fall back to any cached page of this category so an in-flight failure
    // still serves something.
    for (let p = 1; p <= 10; p++) {
      const fallback = feedCache.get(categoryId, p)
      if (fallback && fallback.length > 0) {
        console.log(`[trending] Using cached fallback for ${category.nameEn} page ${p}`)
        return fallback
      }
    }

    throw error
  }
}

/**
 * Mixed "home" feed: interleave fresh videos from a rotating set of
 * categories the way YouTube mixes its home recommendations.
 */
export async function getHomeFeed(
  page: number = 1,
  videosPerPage: number = 12
): Promise<TrendingVideo[]> {
  const cacheKey = 'home-mix'
  const cached = feedCache.get(cacheKey, page)
  if (cached) return cached

  const mixCategories = ['music', 'gaming', 'comedy', 'news', 'cooking', 'learning']
  const categoriesPerPage = 3
  const categoryOffset = Math.floor((page - 1) / 2) * categoriesPerPage
  const selected = mixCategories.slice(categoryOffset, categoryOffset + categoriesPerPage)

  // Cycle back around once the mix is exhausted.
  if (selected.length < categoriesPerPage) {
    selected.push(...mixCategories.slice(0, categoriesPerPage - selected.length))
  }

  const videosPerCategory = Math.ceil(videosPerPage / categoriesPerPage)

  const results = await Promise.all(
    selected.map((catId) =>
      getTrendingForCategory(catId, 1, videosPerCategory).catch(() => [] as TrendingVideo[])
    )
  )

  // Interleave videos from the different categories, YouTube-style.
  const allVideos: TrendingVideo[] = []
  for (let i = 0; i < videosPerCategory; i++) {
    for (const categoryVideos of results) {
      const video = categoryVideos[i]
      if (video) allVideos.push(video)
    }
  }

  const finalVideos = allVideos.slice(0, videosPerPage)

  feedCache.set(cacheKey, page, finalVideos)
  return finalVideos
}
