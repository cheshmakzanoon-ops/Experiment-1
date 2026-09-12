/**
 * Cache for extracted stream URLs and their metadata.
 *
 * YouTube's direct googlevideo.com URLs are signed; a trustworthy `expire`
 * query parameter (epoch seconds) is honored when present, and the entry is
 * never cached beyond `expire − STREAM_CACHE_EXPIRY_MARGIN_MS`. Without a
 * parseable `expire`, a conservative configurable TTL
 * (STREAM_CACHE_TTL_MS, default 2 h) is used.
 *
 * Keys are `"<videoId>:<maxHeight>"` so quality-specific selections never
 * collide. The cache is bounded (LRU eviction) and pruned on a timer.
 */

import { config } from '../config.js'

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
  /** Raw codec identifiers (R1: tracked internally, never re-guessed). */
  vcodec?: string
  acodec?: string
  /** Estimated total bitrate (kbit/s) — R2 tie-breaker bookkeeping. */
  tbr?: number
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
  /** When the direct URL must be considered expired. */
  expiresAt: number
  /** When the whole entry (incl. metadata) expires. */
  metadataExpiresAt: number
  accessCount: number
  lastAccessed: number
}

type StreamCacheInput = StreamSelection & StreamMeta

/** Parse a trustworthy signed-URL `expire` (epoch seconds) → ms epoch. */
export function parseSignedExpiry(url: string): number | null {
  try {
    const parsed = new URL(url)
    const raw = parsed.searchParams.get('expire')
    if (!raw) return null
    const seconds = Number(raw)
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return null
    return seconds * 1000
  } catch {
    return null
  }
}

const URL_TTL_MS = (): number => config.cache.streamUrlTtlMs
const EXPIRY_MARGIN_MS = (): number => config.cache.streamExpiryMarginMs
const METADATA_TTL = 24 * 60 * 60 * 1000

class StreamCache {
  private cache = new Map<string, StreamCacheEntry>()
  private maxSize = 500
  private hits = 0
  private misses = 0

  private static key(videoId: string, maxHeight: number): string {
    return `${videoId}:${maxHeight}`
  }

  /** Live window for a URL: signed expiry − margin, capped by the TTL. */
  private static urlLifetime(url: string, now: number): number {
    const signedExpiry = parseSignedExpiry(url)
    if (signedExpiry !== null) {
      return Math.max(0, Math.min(URL_TTL_MS(), signedExpiry - EXPIRY_MARGIN_MS() - now))
    }
    return URL_TTL_MS()
  }

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

  set(videoId: string, maxHeight: number, data: StreamCacheInput, now: number = Date.now()): void {
    const key = StreamCache.key(videoId, maxHeight)

    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLeastRecentlyUsed()
    }

    const previous = this.cache.get(key)
    const metadataExpiresAt = Math.max(now + METADATA_TTL, previous?.metadataExpiresAt || 0)
    const urlLifetime = StreamCache.urlLifetime(data.url, now)

    this.cache.set(key, {
      videoId,
      maxHeight,
      ...data,
      extractedAt: now,
      expiresAt: now + urlLifetime,
      metadataExpiresAt,
      accessCount: previous ? previous.accessCount + 1 : 1,
      lastAccessed: now
    })
  }

  /** Drop every cached entry for a video (all qualities). */
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

  size(): number {
    return this.cache.size
  }

  clear(): void {
    this.cache.clear()
  }

  cleanup(now: number = Date.now()): void {
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt && now > entry.metadataExpiresAt) {
        this.cache.delete(key)
      }
    }
  }

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
