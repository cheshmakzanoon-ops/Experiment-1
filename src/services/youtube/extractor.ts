/**
 * Video extraction + single-URL format selection (the ONE implementation).
 *
 * Previous phases spread extraction across utils/ytDlp.ts, an extractor
 * service and a separate "blocking workaround" ladder (which re-ran the
 * android/mweb client rotation after the default path failed). Those are
 * gone: every extraction/search call lands here and executes through
 * src/services/ytdlp/runYtDlp.ts (bounded concurrency + single-flight +
 * classification). No client-rotation ladder is hard-coded — modern yt-dlp
 * + the Node 22 JS runtime is the normal path; forced clients are an
 * advanced operator config only (YT_PLAYER_CLIENTS / YT_EXTRACTOR_ARGS).
 */

import { runYtDlp, YtDlpError, publicMessageFor } from '../ytdlp/runYtDlp.js'
import type { VideoFormat, VideoMetadata } from '../../types/video.js'

/** Quality presets the app exposes (everything above 144–480 is out of scope). */
export const SUPPORTED_QUALITIES = ['144', '240', '360', '480'] as const
export type SupportedQuality = (typeof SUPPORTED_QUALITIES)[number]

// ---------------------------------------------------------------------------
// yt-dlp output shapes
// ---------------------------------------------------------------------------

export interface YtDlpFormat {
  format_id: string
  url?: string
  ext?: string
  height?: number
  width?: number
  fps?: number
  vcodec?: string
  acodec?: string
  filesize?: number
  filesize_approx?: number
  tbr?: number
  vbr?: number
  abr?: number
  protocol?: string
  language?: string
  format_note?: string
}

export interface YtDlpVideoInfo {
  id: string
  title?: string
  description?: string
  duration?: number
  thumbnail?: string
  uploader?: string
  uploader_id?: string
  channel?: string
  channel_id?: string
  view_count?: number
  like_count?: number
  upload_date?: string
  webpage_url?: string
  url?: string
  is_live?: boolean
  live_status?: string
  formats?: YtDlpFormat[]
}

export interface YtDlpSearchEntry {
  id: string
  title?: string
  description?: string
  duration?: number
  thumbnail?: string
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
}

/** The single upstream URL the proxy relays, plus enough info to serve it. */
export interface SelectedStream {
  url: string
  quality: string
  mimeType: string
  filesize?: number
  height?: number
  width?: number
  hasAudio: boolean
  hasVideo: boolean
  formatId: string
}

const VIDEO_URL = (videoId: string): string => `https://www.youtube.com/watch?v=${videoId}`

// ---------------------------------------------------------------------------
// Raw extraction (bounded retry policy only)
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * One raw `--dump-single-json` extraction attempt. Throws YtDlpError on
 * process/output failure (classified; permanent failures are surfaced
 * immediately by the caller).
 */
async function rawInfoAttempt(
  videoId: string,
  signal?: AbortSignal,
  extraArgs: string[] = []
): Promise<YtDlpVideoInfo> {
  const args = [
    '--dump-single-json',
    '--no-playlist',
    ...extraArgs,
    VIDEO_URL(videoId)
  ]

  const result = await runYtDlp(args, { key: `extract:${videoId}`, signal })

  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch (parseError) {
    throw new YtDlpError('yt-dlp returned malformed JSON output', 'malformed_output', {
      originalError: parseError
    })
  }

  const info = parsed as YtDlpVideoInfo
  if (!info || typeof info.id !== 'string') {
    throw new YtDlpError('yt-dlp output missing a video id', 'malformed_output')
  }
  if (info.id !== videoId) {
    throw new YtDlpError(`yt-dlp returned a different video id (${info.id})`, 'malformed_output')
  }
  return info
}

const MAX_ATTEMPTS = 2 // initial + one bounded retry for transient classes

/** Extract the raw info dict with jittered single bounded retry. */
export async function extractRawInfo(
  videoId: string,
  options: { signal?: AbortSignal } = {}
): Promise<YtDlpVideoInfo> {
  let lastError: YtDlpError | null = null

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await rawInfoAttempt(videoId, options.signal)
    } catch (error) {
      const err = error instanceof YtDlpError ? error : new YtDlpError('Extraction failed', 'unknown', { originalError: error })
      lastError = err
      // Never retry permanent categories (404/private/geo/DRM/format,
      // rate limits, bot walls, egress blocks, runtime missing).
      if (!err.retryable || attempt >= MAX_ATTEMPTS - 1) {
        throw err
      }
      const jittered = 800 + Math.round(Math.random() * 1200)
      await sleep(jittered)
    }
  }

  throw lastError || new YtDlpError('Extraction failed', 'unknown')
}

// ---------------------------------------------------------------------------
// Format selection (single progressive URL for the byte relay)
// ---------------------------------------------------------------------------

function isM3u8(f: YtDlpFormat): boolean {
  const protocol = (f.protocol || '').toLowerCase()
  const url = (f.url || '').toLowerCase()
  return protocol.includes('m3u8') || url.includes('.m3u8')
}

function hasVideo(f: YtDlpFormat): boolean {
  return f.vcodec !== undefined && f.vcodec !== 'none'
}

function hasAudio(f: YtDlpFormat): boolean {
  return f.acodec !== undefined && f.acodec !== 'none'
}

function getMimeType(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'mp4':
    case 'm4a':
      return 'video/mp4'
    case 'webm':
      return 'video/webm'
    case 'mkv':
      return 'video/x-matroska'
    case 'flv':
      return 'video/x-flv'
    case '3gp':
      return 'video/3gpp'
    case 'ts':
      return 'video/mp2t'
    default:
      return 'video/mp4'
  }
}

function formatHeight(f: YtDlpFormat): number | undefined {
  if (f.height) return f.height
  const note = f.format_note || ''
  const parsed = note.match(/(\d{3,4})p/)
  return parsed ? parseInt(parsed[1], 10) : undefined
}

const MODERN_CONTAINERS = new Set(['mp4', 'webm', 'm4a', 'mkv'])

function isModernContainer(f: YtDlpFormat): boolean {
  return MODERN_CONTAINERS.has((f.ext || '').toLowerCase())
}

function toSelectedStream(f: YtDlpFormat, hasAv: boolean): SelectedStream {
  const height = formatHeight(f)
  return {
    url: f.url as string,
    quality: height ? `${height}p` : f.format_note || 'auto',
    mimeType: getMimeType(f.ext || 'mp4'),
    filesize: f.filesize || f.filesize_approx,
    height,
    width: f.width,
    hasAudio: hasAv && hasAudio(f),
    hasVideo: hasAv && hasVideo(f),
    formatId: f.format_id
  }
}

/**
 * Pick the single upstream URL to relay. This proxy exists for 1–2 Mbps
 * links and only relays ONE direct URL, so the winner is always a
 * progressive (audio+video in one file) format:
 *   1. highest MP4/WebM combined at or below maxHeight,
 *   2. smallest MP4/WebM combined above maxHeight,
 *   3. legacy containers (3gp/flv) as a last resort,
 *   4. DASH video-only (silent — flagged hasAudio:false).
 */
export function selectBestStream(info: YtDlpVideoInfo, maxHeight = 240): SelectedStream {
  const formats = (info.formats || []).filter(
    (f) => f && f.url && !isM3u8(f) && f.vcodec !== 'none'
  )

  if (formats.length === 0) {
    if (info.url) {
      return {
        url: info.url,
        quality: 'auto',
        mimeType: 'video/mp4',
        hasAudio: true,
        hasVideo: true,
        formatId: 'url'
      }
    }
    throw new YtDlpError('No playable formats available for this video', 'format_unavailable')
  }

  const pickHighestUnderCap = (pool: YtDlpFormat[]) =>
    pool
      .filter((f) => {
        const h = formatHeight(f)
        return h !== undefined && h <= maxHeight
      })
      .sort((a, b) => (formatHeight(b) as number) - (formatHeight(a) as number))[0]

  const pickSmallestAboveCap = (pool: YtDlpFormat[]) =>
    pool
      .filter((f) => {
        const h = formatHeight(f)
        return h !== undefined && h > maxHeight
      })
      .sort((a, b) => (formatHeight(a) as number) - (formatHeight(b) as number))[0]

  const combined = formats.filter((f) => hasAudio(f))
  const modernCombined = combined.filter((f) => isModernContainer(f))
  const withHeight = (pool: YtDlpFormat[]) => pool.filter((f) => formatHeight(f) !== undefined)

  const candidate =
    pickHighestUnderCap(withHeight(modernCombined)) ||
    pickSmallestAboveCap(withHeight(modernCombined)) ||
    pickHighestUnderCap(withHeight(combined)) ||
    pickSmallestAboveCap(withHeight(combined))

  if (candidate) {
    return toSelectedStream(candidate, true)
  }

  // Video-only DASH fallback (silent — clearly flagged for callers).
  const videoOnly = withHeight(formats).sort(
    (a, b) => (formatHeight(a) as number) - (formatHeight(b) as number)
  )
  if (videoOnly.length > 0) {
    const best = videoOnly[0]
    console.warn(`[ytdlp] ${info.id}: only video-only (DASH) formats available; audio will be absent`)
    return toSelectedStream(best, false)
  }

  throw new YtDlpError(`No suitable stream found for ${info.id} (max ${maxHeight}p)`, 'format_unavailable')
}

export interface ExtractionResult {
  info: YtDlpVideoInfo
  stream: SelectedStream
}

/** Full extraction: raw info + a single selected stream URL. */
export async function extractPlayableVideo(
  videoId: string,
  maxHeight = 240,
  options: { signal?: AbortSignal; extraArgs?: string[] } = {}
): Promise<ExtractionResult> {
  const info = await extractRawInfo(videoId, { signal: options.signal })

  if (info.is_live || info.live_status === 'is_live') {
    throw new YtDlpError('Live streams are not supported yet', 'live_stream')
  }

  const stream = selectBestStream(info, maxHeight)
  return { info, stream }
}

function videoFormatFromStream(stream: SelectedStream): VideoFormat {
  return {
    quality: stream.quality,
    url: stream.url,
    mimeType: stream.mimeType,
    filesize: stream.filesize,
    hasAudio: stream.hasAudio,
    hasVideo: stream.hasVideo,
    height: stream.height,
    width: stream.width,
    formatId: stream.formatId,
    ext: undefined
  }
}

/** Metadata shape for the metadata route. The direct URL is never exposed. */
export async function extractVideoInfo(
  videoId: string,
  maxHeight = 240,
  options: { signal?: AbortSignal } = {}
): Promise<VideoMetadata> {
  const { info, stream } = await extractPlayableVideo(videoId, maxHeight, options)

  return {
    id: info.id,
    title: info.title || '',
    description: info.description || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || '',
    author: info.uploader || info.channel || '',
    authorId: info.uploader_id || info.channel_id || '',
    viewCount: info.view_count || 0,
    uploadDate: info.upload_date || '',
    streamUrl: stream.url,
    formats: [videoFormatFromStream(stream)]
  }
}

export { publicMessageFor }
