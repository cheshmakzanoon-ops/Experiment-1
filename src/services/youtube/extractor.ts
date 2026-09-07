import { extractVideoInfo, YtDlpError } from '../../utils/ytDlp.js'
import { memoryCache } from '../cache/memoryCache.js'
import { config } from '../../config.js'
import type { VideoMetadata } from '../../types/video.js'

export interface ExtractOptions {
  /** Cache the result in memory (routes usually manage their own caching). */
  useCache?: boolean
  /** Optional explicit cache TTL in ms. */
  ttlMs?: number
}

/**
 * High-level video metadata extraction.
 *
 * Delegates to the low-level yt-dlp utility and adds an optional
 * memory-cache layer. `cacheKey` lets callers align with their own keys
 * (e.g. "video:<id>:240") when they want a shared cache entry.
 */
export async function extractVideoMetadata(
  videoId: string,
  maxHeight: number = config.video.defaultHeight,
  options: ExtractOptions = {}
): Promise<VideoMetadata> {
  const { useCache = false, ttlMs = config.cache.videoTtlMs } = options
  const cacheKey = `video:${videoId}:${maxHeight}`

  if (useCache) {
    const cached = memoryCache.get<VideoMetadata>(cacheKey)
    if (cached) return cached
  }

  const info = await extractVideoInfo(videoId, maxHeight)

  if (useCache) {
    memoryCache.set(cacheKey, info, ttlMs)
  }

  return info
}

/** Convenience wrapper that always validates the video id first. */
export async function extractVideoMetadataSafe(
  videoId: string,
  maxHeight?: number
): Promise<VideoMetadata> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    throw new YtDlpError('Invalid video ID', 400)
  }
  return extractVideoMetadata(videoId, maxHeight)
}
