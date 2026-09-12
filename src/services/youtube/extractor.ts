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
import { isAbortError } from '../ytdlp/queue.js'
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
  /** Exact authoritative size when the extractor reports one (never `filesize_approx`). */
  filesize?: number
  /** Extractors estimate sizes; an estimate must never gate ranges/completion. */
  filesizeApprox?: number
  height?: number
  width?: number
  hasAudio: boolean
  hasVideo: boolean
  formatId: string
  /** Raw codec identifiers (R1: audio+video must both be explicit, non-"none"). */
  vcodec?: string
  acodec?: string
  /** Estimated total bitrate (kbit/s) when reported — R2 tie-breaker. */
  tbr?: number
}

/** Aggregated browser-capability description of one format (R1/R2). */
export interface FormatFacts {
  height?: number
  width?: number
  vcodec?: string
  acodec?: string
  mimeType: string
  container: string
  /** True when the transport itself delivers a progressive media file. */
  supportedTransport: boolean
  /** True when the container+codec pair is browser-playable. */
  browserCompatible: boolean
  tbr?: number
  formatId: string
  filesize?: number
  filesizeApprox?: number
}

const VIDEO_URL = (videoId: string): string => `https://www.youtube.com/watch?v=${videoId}`

// ---------------------------------------------------------------------------
// Raw extraction (bounded retry policy only)
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

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
  abortIfRequested(signal)
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
      // Cancellation is NEVER retried and never wrapped as an unknown error.
      if (isAbortError(error)) throw error
      const err = error instanceof YtDlpError ? error : new YtDlpError('Extraction failed', 'unknown', { originalError: error })
      lastError = err
      // Never retry permanent categories (404/private/geo/DRM/format,
      // rate limits, bot walls, egress blocks, runtime missing).
      if (!err.retryable || attempt >= MAX_ATTEMPTS - 1) {
        throw err
      }
      const jittered = 800 + Math.round(Math.random() * 1200)
      try {
        await sleep(jittered, options.signal)
      } catch (sleepError) {
        if (isAbortError(sleepError)) throw sleepError
        throw err
      }
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

/** Any manifest transport (HLS/DASH) — never masquerades as an MP4 file. */
function isManifestFormat(f: YtDlpFormat): boolean {
  const protocol = (f.protocol || '').toLowerCase()
  const url = (f.url || '').toLowerCase()
  const ext = (f.ext || '').toLowerCase()
  return (
    protocol.includes('m3u8') ||
    protocol.includes('dash') ||
    protocol === 'http_dash_segments' ||
    url.includes('.m3u8') ||
    url.includes('.mpd') ||
    ext === 'm3u8' ||
    ext === 'mpd'
  )
}

/** Transports that deliver a real byte-addressable progressive file. */
function isSupportedTransport(f: YtDlpFormat): boolean {
  if (isManifestFormat(f)) return false
  const protocol = (f.protocol || '').toLowerCase()
  return protocol === '' || protocol === 'https' || protocol === 'http'
}

function hasVideo(f: YtDlpFormat): boolean {
  return f.vcodec !== undefined && f.vcodec !== null && f.vcodec !== 'none' && f.vcodec !== ''
}

function hasAudio(f: YtDlpFormat): boolean {
  return f.acodec !== undefined && f.acodec !== null && f.acodec !== 'none' && f.acodec !== ''
}

/**
 * Browser compatibility (R1): only codec/container pairs Chromium/WebView
 * actually decode, without external dependencies. Unknown codecs/containers
 * are NOT assumed compatible — callers must check before offering them.
 */
export function formatIsBrowserCompatible(f: YtDlpFormat): boolean {
  const container = (f.ext || '').toLowerCase()
  if (!MODERN_BROWSER_CONTAINERS.has(container)) return false
  const v = (f.vcodec || '').toLowerCase()
  const a = (f.acodec || '').toLowerCase()
  const videoOk = !hasVideo(f) || v.startsWith('avc1') || v.startsWith('avc3') || v.startsWith('h264') || v.startsWith('vp8') || v.startsWith('vp9') || v.startsWith('vp09')
  const audioOk = !hasAudio(f) || a.startsWith('mp4a') || a.startsWith('aac') || a.startsWith('opus') || a.startsWith('vorbis')
  return videoOk && audioOk
}

const MODERN_BROWSER_CONTAINERS = new Set(['mp4', 'webm'])

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

// Retained for potential diagnostic use; modern container != browser
// compatibility (R1 checks codecs explicitly via formatIsBrowserCompatible).
function isModernContainer(f: YtDlpFormat): boolean {
  return MODERN_CONTAINERS.has((f.ext || '').toLowerCase())
}

function formatFacts(f: YtDlpFormat): FormatFacts {
  const container = (f.ext || '').toLowerCase()
  return {
    height: formatHeight(f),
    width: f.width,
    vcodec: f.vcodec,
    acodec: f.acodec,
    mimeType: getMimeType(container || 'mp4'),
    container,
    supportedTransport: isSupportedTransport(f),
    browserCompatible: formatIsBrowserCompatible(f),
    tbr: f.tbr,
    formatId: f.format_id,
    filesize: f.filesize,
    filesizeApprox: f.filesize_approx
  }
}

function toSelectedStream(f: YtDlpFormat): SelectedStream {
  const height = formatHeight(f)
  return {
    url: f.url as string,
    quality: height ? `${height}p` : f.format_note || 'auto',
    mimeType: getMimeType((f.ext || 'mp4').toLowerCase()),
    // Only an exact `filesize` is authoritative. `filesize_approx` is an
    // estimate: kept aside, never promoted into range decisions,
    // Content-Length, or completion metadata (the proxy learns the true
    // total from CDN range responses).
    filesize: f.filesize,
    filesizeApprox: f.filesize_approx,
    height,
    width: f.width,
    hasAudio: hasAudio(f),
    hasVideo: hasVideo(f),
    formatId: f.format_id,
    vcodec: f.vcodec,
    acodec: f.acodec,
    tbr: f.tbr
  }
}

/** Codec families browser-selectable as alternatives (R2 alternatives list). */
function describeFormat(f: YtDlpFormat): string {
  const h = formatHeight(f)
  const v = (f.vcodec || 'unknown').split('.')[0]
  const a = (f.acodec || 'unknown').split('.')[0]
  return `${h ? `${h}p` : 'auto'} ${(f.ext || '?').toLowerCase()} v:${v} a:${a}`
}

/**
 * Pick the single upstream URL to relay (R1 contract).
 *
 * This proxy exists for 1–2 Mbps links and relays ONE progressive file.
 * A normal playable selection requires ALL of:
 *   - explicit, nonempty audio AND video codec identifiers (neither `none`),
 *   - a supported direct transport (HLS/DASH manifests are never accepted),
 *   - a browser-compatible container (mp4/webm),
 *   - a validated safe media URL (re-checked by streamProxy before caching).
 *
 * The requested quality is a HARD CEILING for automatic selection (R2):
 * when no combined format at or under the cap exists, the caller gets a
 * structured FORMAT_UNAVAILABLE error carrying sanitized alternatives —
 * never a silent higher-height pick and never a video-only file.
 *
 * Unknown `info.url` fallbacks (no per-format codecs) are never accepted.
 */
export function selectBestStream(info: YtDlpVideoInfo, maxHeight = 240): SelectedStream {
  const pool = (info.formats || []).filter(
    (f) =>
      f &&
      typeof f.url === 'string' &&
      f.url.length > 0 &&
      hasAudio(f) &&
      hasVideo(f) &&
      isSupportedTransport(f) &&
      formatIsBrowserCompatible(f)
  )

  const underCap = pool.filter((f) => {
    const h = formatHeight(f)
    return h !== undefined && h <= maxHeight
  })

  // Highest height at/below the cap; deterministic tie-break on lower
  // estimated bitrate (height never guarantees throughput on a 1–2 Mbps link).
  const best =
    underCap.sort((a, b) => {
      const dh = (formatHeight(b) as number) - (formatHeight(a) as number)
      if (dh !== 0) return dh
      return (a.tbr ?? Infinity) - (b.tbr ?? Infinity)
    })[0] || null

  if (best) return toSelectedStream(best)

  const alternatives = pool
    .sort((a, b) => (formatHeight(a) ?? Infinity) - (formatHeight(b) ?? Infinity))
    .slice(0, 6)
    .map(describeFormat)

  const message =
    alternatives.length > 0
      ? `No combined audio+video format at or below ${maxHeight}p; available alternatives: ${alternatives.join(', ')}`
      : `No combined audio+video format available for this video (max ${maxHeight}p)`
  throw new YtDlpError(message, 'format_unavailable')
}

/**
 * Structured unavailability (R1/R2): `reason` distinguishes "no combined
 * format at all" from "nothing at/below the requested ceiling"; the
 * alternatives list is sanitized (no URLs, codecs/heights only).
 */
export interface FormatUnavailable {
  reason: 'no_combined_format' | 'quality_above_cap' | 'no_compatible_container'
  availableQualities: Array<{ height?: number; label: string; mimeType: string }>
  selectionReason: string
}

/**
 * Aggregate every selectable combined format for the metadata endpoint:
 * genuinely available, browser-compatible, transport-valid choices only.
 */
export function availableCombinedQualities(info: YtDlpVideoInfo): Array<{
  height?: number
  label: string
  mimeType: string
  formatId: string
}> {
  const seen = new Map<number, { height?: number; label: string; mimeType: string; formatId: string }>()
  for (const f of info.formats || []) {
    if (!f || typeof f.url !== 'string' || !f.url) continue
    if (!hasAudio(f) || !hasVideo(f)) continue
    if (!isSupportedTransport(f) || !formatIsBrowserCompatible(f)) continue
    const h = formatHeight(f)
    if (h === undefined) continue
    const key = h
    if (!seen.has(key)) {
      seen.set(key, {
        height: h,
        label: `${h}p`,
        mimeType: getMimeType((f.ext || 'mp4').toLowerCase()),
        formatId: f.format_id
      })
    }
  }
  return [...seen.values()].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
}

/** Full extraction: raw info + a single selected stream URL. */
export interface ExtractionResult {
  info: YtDlpVideoInfo
  stream: SelectedStream
  /** Genuinely available combined qualities (metadata additive field). */
  availableQualities: Array<{ height?: number; label: string; mimeType: string; formatId: string }>
  /** Why this representation was chosen (stabilized for the UI). */
  selectionReason: string
}

export async function extractPlayableVideo(
  videoId: string,
  maxHeight = 240,
  options: { signal?: AbortSignal; extraArgs?: string[] } = {}
): Promise<ExtractionResult> {
  abortIfRequested(options.signal)
  const info = await extractRawInfo(videoId, { signal: options.signal })
  abortIfRequested(options.signal)

  if (info.is_live || info.live_status === 'is_live') {
    throw new YtDlpError('Live streams are not supported yet', 'live_stream')
  }

  let stream: SelectedStream
  try {
    stream = selectBestStream(info, maxHeight)
  } catch (error) {
    if (error instanceof YtDlpError && error.category === 'format_unavailable') {
      const pool = (info.formats || []).filter(
        (f) => f && f.url && hasAudio(f) && hasVideo(f) && isSupportedTransport(f) && formatIsBrowserCompatible(f)
      )
      const underCap = pool.some((f) => {
        const h = formatHeight(f)
        return h !== undefined && h <= maxHeight
      })
      const reason: FormatUnavailable['reason'] = underCap
        ? 'no_compatible_container'
        : pool.length > 0
          ? 'quality_above_cap'
          : 'no_combined_format'
      const enriched = new YtDlpError(error.message, 'format_unavailable', {
        originalError: error
      }) as unknown as YtDlpError & FormatUnavailable
      enriched.reason = reason
      enriched.availableQualities = availableCombinedQualities(info)
      enriched.selectionReason = reason
      throw enriched
    }
    throw error
  }

  const availableQualities = availableCombinedQualities(info)
  const selectionReason = `combined:${stream.formatId}:${stream.height ? `${stream.height}p` : 'auto'}`
  return { info, stream, availableQualities, selectionReason }
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
    vcodec: stream.vcodec,
    acodec: stream.acodec,
    ext: undefined
  }
}

/** Metadata shape for the metadata route. The direct URL is never exposed. */
export async function extractVideoInfo(
  videoId: string,
  maxHeight = 240,
  options: { signal?: AbortSignal } = {}
): Promise<VideoMetadata> {
  const { info, stream, availableQualities, selectionReason } = await extractPlayableVideo(
    videoId,
    maxHeight,
    options
  )

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
    formats: [videoFormatFromStream(stream)],
    // ---- R2 additive metadata (never removes existing fields) ----
    requestedQuality: `${maxHeight}p`,
    actualQuality: stream.quality,
    hasAudio: stream.hasAudio,
    hasVideo: stream.hasVideo,
    mimeType: stream.mimeType,
    codecs: { video: stream.vcodec, audio: stream.acodec },
    availableQualities,
    selectionReason
  }
}

export { publicMessageFor }
