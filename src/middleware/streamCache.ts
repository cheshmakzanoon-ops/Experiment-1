/**
 * Cache for extracted stream URLs and their metadata.
 *
 * YouTube's direct googlevideo.com URLs are signed and expire after roughly
 * 6 hours, so the stream URL is cached for 2 hours (well inside the safe
 * window). Metadata is cheap to re-derive from a cached entry but is kept
 * separately so an expired URL does not force a full re-extraction when the
 * frontend just needs a title/duration for the watch page.
 *
 * Keys are `"<videoId>:<maxHeight>"` so quality-specific selections never
 * collide. The cache is bounded (LRU eviction) and pruned on a timer.
 */

export interface StreamSelection {
  url: string
  mimeType: string
  filesize?: number
  height?: number
  width?: number
  quality: string
  hasAudio: boolean
  hasVideo: boolean
  formatId: string
}

export interface StreamMeta {
  title: string
  author: string
  duration: number
  thumbnail?: string
  viewCount?: number
}

export interface StreamCacheEntry extends StreamSelection, StreamMeta {
  videoId: string
  maxHeight: number
  extractedAt: number
  /** When the direct URL expires (must be re-extracted after this). */
  expiresAt: number
  /** When the whole entry (incl. metadata) expires. */
  metadataExpiresAt: number
  accessCount: number
  lastAccessed: number
}

type StreamCacheInput = StreamSelection & StreamMeta

class StreamCache {
  private cache = new Map<string, StreamCacheEntry>()
  private maxSize = 500
  private hits = 0
  private misses = 0

  // TTLs (milliseconds)
  private static URL_TTL = 2 * 60 * 60 * 1000 // 2 hours (URLs live ~6 h)
  private static METADATA_TTL = 24 * 60 * 60 * 1000 // 24 hours

  private static key(videoId: string, maxHeight: number): string {
    return `${videoId}:${maxHeight}`
  }

  /**
   * Return a live stream entry for (videoId, maxHeight), or null when the
   * entry is missing or its direct URL has expired.
   */
  get(videoId: string, maxHeight: number): StreamCacheEntry | null {
    const key = StreamCache.key(videoId, maxHeight)
    const entry = this.cache.get(key)

    if (!entry || Date.now() > entry.expiresAt) {
      if (entry) this.cache.delete(key)
      this.misses++
      return null
    }

    this.hits++
    entry.accessCount++
    entry.lastAccessed = Date.now()
    return entry
  }

  /**
   * Store (or refresh) a stream entry. If the URL expires later than the
   * metadata (e.g. a re-extraction after a 403), the metadata TTL is kept
   * so a re-fetch of the URL does not shorten metadata availability.
   */
  set(videoId: string, maxHeight: number, data: StreamCacheInput, now: number = Date.now()): void {
    const key = StreamCache.key(videoId, maxHeight)

    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLeastRecentlyUsed()
    }

    const previous = this.cache.get(key)
    const metadataExpiresAt = Math.max(
      now + StreamCache.METADATA_TTL,
      previous?.metadataExpiresAt || 0
    )

    this.cache.set(key, {
      videoId,
      maxHeight,
      ...data,
      extractedAt: now,
      expiresAt: now + StreamCache.URL_TTL,
      metadataExpiresAt,
      accessCount: previous ? previous.accessCount + 1 : 1,
      lastAccessed: now
    })
  }

  /**
   * Drop every cached entry for a video (all qualities). Used when an
   * upstream 403/429 suggests the cached URL went stale or was revoked.
   */
  deleteVideo(videoId: string): void {
    const prefix = `${videoId}:`
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key)
    }
  }

  /** Remove a single quality entry. */
  delete(videoId: string, maxHeight: number): void {
    this.cache.delete(StreamCache.key(videoId, maxHeight))
  }

  /** Number of entries currently stored. */
  size(): number {
    return this.cache.size
  }

  clear(): void {
    this.cache.clear()
  }

  /**
   * Drop entries whose direct URL has expired AND whose metadata window has
   * passed. Entries with expired URLs but still-valid metadata survive so
   * the watch page can still render instantly; the stream URL is simply
   * re-extracted on demand.
   */
  cleanup(now: number = Date.now()): void {
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt && now > entry.metadataExpiresAt) {
        this.cache.delete(key)
      }
    }
  }

  /** Evict the least-recently-used entry when the cache is full. */
  private evictLeastRecentlyUsed(): void {
    let lruKey: string | null = null
    let lruTime = Infinity
    for (const [key, entry] of this.cache) {
      if (entry.lastAccessed < lruTime) {
        lruTime = entry.lastAccessed
        lruKey = key
      }
    }
    if (lruKey) this.cache.delete(lruKey)
  }

  getStats(): {
    size: number
    maxSize: number
    hits: number
    misses: number
    totalAccessCount: number
    oldestEntryAgeMs: number
  } {
    let totalAccess = 0
    let oldestAge = 0
    const now = Date.now()

    for (const entry of this.cache.values()) {
      totalAccess += entry.accessCount
      oldestAge = Math.max(oldestAge, now - entry.extractedAt)
    }

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      totalAccessCount: totalAccess,
      oldestEntryAgeMs: oldestAge
    }
  }
}

export const streamCache = new StreamCache()

// Prune expired entries every 15 minutes. `.unref()` keeps the timer from
// holding the process open in short-lived scripts/tests.
setInterval(() => {
  streamCache.cleanup()
}, 15 * 60 * 1000).unref()
