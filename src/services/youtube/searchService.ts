/**
 * YouTube search (one implementation, all through the centralized runner).
 *
 * Cache correctness: results never depend on the requested `max` — a
 * canonical batch of `SEARCH_BATCH_RESULTS` entries is cached per query and
 * sliced afterward, so request ordering cannot poison later answers.
 * Stale-on-error keeps the last successful results when a refresh fails.
 */

import { config } from '../../config.js'
import { runYtDlp, YtDlpError } from '../ytdlp/runYtDlp.js'
import { loadWithStale, staleCache } from '../cache/staleCache.js'
import type { SearchResult } from '../../types/video.js'
import type { YtDlpSearchEntry } from './extractor.js'

/** Canonical number of search entries fetched per query per TTL window. */
const SEARCH_BATCH_RESULTS = 20
const STALE_TTL_MS = 30 * 60 * 1000

export function thumbnailProxyUrl(videoId: string): string {
  return `/api/video/${videoId}/thumbnail`
}

interface SearchEntryWithMeta {
  id?: string
  title?: string
  duration?: number
  thumbnail?: string
  uploader?: string
  view_count?: number
  timestamp?: number
}

/** Run one flat-playlist search of a canonical batch size. */
async function searchBatchRaw(
  query: string,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const searchUrl = `ytsearch${SEARCH_BATCH_RESULTS}:${query}`

  const result = await runYtDlp(
    ['--flat-playlist', '--dump-single-json', searchUrl],
    { key: `search:${query.trim().toLowerCase()}`, signal, timeoutMs: 60_000 }
  )

  let parsed: { entries?: YtDlpSearchEntry[] | null }
  try {
    parsed = JSON.parse(result.stdout) as { entries?: YtDlpSearchEntry[] | null }
  } catch (parseError) {
    throw new YtDlpError('Search returned malformed output', 'malformed_output', { originalError: parseError })
  }

  const entries = parsed.entries || []
  const results: SearchResult[] = []
  for (const entry of entries) {
    if (!entry || !entry.id || !entry.title) continue
    results.push({
      id: entry.id,
      title: entry.title,
      duration: entry.duration || 0,
      thumbnail: thumbnailProxyUrl(entry.id),
      author: entry.uploader || entry.channel || '',
      viewCount: entry.view_count || 0,
      publishedText: ''
    })
  }
  return results
}

export interface SearchOptions {
  ttlMs?: number
  signal?: AbortSignal
}

/**
 * Search videos and return up to `maxResults` entries.
 * Thumbnails already point at the local proxy route.
 */
export async function searchForVideos(
  query: string,
  maxResults = 12,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const ttlMs = options.ttlMs ?? config.cache.searchTtlMs
  const cacheKey = `search:${query.trim().toLowerCase()}`

  const { value } = await loadWithStale(
    cacheKey,
    ttlMs,
    () => searchBatchRaw(query, options.signal),
    { staleTtlMs: STALE_TTL_MS }
  )

  const bounded = Math.min(Math.max(1, Math.floor(maxResults)), SEARCH_BATCH_RESULTS)
  return value.slice(0, bounded)
}

/** Low-level access for the smoke-test/diagnostics (no frontend mapping). */
export async function searchVideosRaw(
  query: string,
  maxResults: number,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  return searchForVideos(query, maxResults, { signal })
}

/** Cache introspection (diagnostics only). */
export function searchCacheStats(): { size: number } {
  return { size: staleCache.size() }
}
