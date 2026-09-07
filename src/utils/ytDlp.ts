import { execFile } from 'child_process'
import { promisify } from 'util'
import { poTokenService } from '../services/potoken/generator.js'
import type { SearchResult, VideoFormat, VideoMetadata } from '../types/video.js'

const execFileAsync = promisify(execFile)

/** Quality presets the app exposes (everything above 144–480 is out of scope). */
export const SUPPORTED_QUALITIES = ['144', '240', '360', '480'] as const
export type SupportedQuality = (typeof SUPPORTED_QUALITIES)[number]

// ---------------------------------------------------------------------------
// Types
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
  duration?: number
  thumbnail?: string
  uploader?: string
  view_count?: number
}

/** The single upstream URL the proxy will relay, plus enough info to serve it. */
export interface SelectedStream {
  url: string
  quality: string // e.g. "360p"
  mimeType: string
  filesize?: number
  height?: number
  width?: number
  hasAudio: boolean
  hasVideo: boolean
  formatId: string
}

export class YtDlpError extends Error {
  constructor(
    message: string,
    public code: number,
    public retryable: boolean = false,
    public originalError?: unknown
  ) {
    super(message)
    this.name = 'YtDlpError'
  }
}

// ---------------------------------------------------------------------------
// Retry / backoff configuration
// ---------------------------------------------------------------------------

/** Total extraction attempts (initial + up to 2 retries). */
const MAX_EXTRACTION_ATTEMPTS = 3
const INITIAL_DELAY_MS = 1500
const MAX_DELAY_MS = 15000
const BACKOFF_FACTOR = 2

/**
 * Player clients tried in order across attempts. The default client pool is
 * often the first thing YouTube blocks for datacenter IPs ("Sign in to
 * confirm you're not a bot"); falling back to the `android`/`mweb` clients
 * frequently bypasses that wall.
 */
const PLAYER_CLIENTS: ReadonlyArray<string | undefined> = [undefined, 'android', 'mweb']

// ---------------------------------------------------------------------------
// PO token support (optional)
// ---------------------------------------------------------------------------

/**
 * Build yt-dlp extractor-args for a player client, injecting a PO token
 * when one is available. PO tokens (Proof of Origin) help get past the
 * bot-wall on datacenter IPs. Tokens come from two places:
 *
 *   1. Env vars  YT_PO_TOKEN + YT_VISITOR_DATA  (manual override, or set
 *      automatically by the PO-token service once it has generated a pair),
 *   2. the auto-generation service (src/services/potoken/generator.ts),
 *      which mints tokens through bgutil-ytdlp-pot-provider when installed.
 *
 * When neither is available, yt-dlp runs with its own client defaults.
 */
function extractorArgsFor(client: string | undefined): string[] | undefined {
  if (client) {
    return [`youtube:player_client=${client}`]
  }
  return undefined
}

/**
 * Resolve a `youtube:po_token=web+TOKEN+VISITOR_DATA` extractor arg, or
 * undefined when no token is available. Falls back to the auto-generation
 * service when the env pair is not set; any service failure simply means
 * "extract without a token".
 */
async function poTokenExtractorArg(): Promise<string | undefined> {
  const token = process.env.YT_PO_TOKEN
  const visitorData = process.env.YT_VISITOR_DATA
  if (token && visitorData) {
    return `youtube:po_token=web+${token}+${visitorData}`
  }

  try {
    const tokenData = await poTokenService.getToken()
    return `youtube:po_token=web+${tokenData.token}+${tokenData.visitorData}`
  } catch {
    // No token available — extraction still attempts without one.
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Low-level yt-dlp invocation
// ---------------------------------------------------------------------------

interface YtDlpRunOptions {
  args: string[]
  timeoutMs?: number
  maxBuffer?: number
}

/** Run yt-dlp, returning stdout. Raw child_process errors surface to callers. */
async function runYtDlp(options: YtDlpRunOptions): Promise<string> {
  const { args, timeoutMs = 45000, maxBuffer = 20 * 1024 * 1024 } = options

  const { stdout } = await execFileAsync('yt-dlp', args, {
    maxBuffer,
    timeout: timeoutMs,
    env: process.env
  })

  return stdout as string
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Translate a yt-dlp failure (child_process error carrying stderr, or a raw
 * error) into a YtDlpError with a sensible HTTP-ish code and a retryable
 * flag. Distinguishing the failure modes matters: some errors (404, age
 * gate) will never succeed on retry, while bot-walls/rate limits often do.
 */
function classifyYtDlpError(error: unknown, context: string): YtDlpError {
  const err = error as {
    code?: string | number
    stderr?: string
    message?: string
    killed?: boolean
    signal?: string
  }

  const stderr = err.stderr || ''
  const message = err.message || ''
  const combined = `${stderr} ${message} ${context}`.toLowerCase()

  // ---- Not retryable: the content itself is unavailable ------------------
  if (
    combined.includes('video unavailable') ||
    combined.includes('this video is unavailable') ||
    combined.includes('video not found') ||
    combined.includes('http error 404') ||
    combined.includes('is not a valid url') ||
    combined.includes('unsupported url')
  ) {
    return new YtDlpError('Video not found', 404, false, error)
  }

  if (combined.includes('private video')) {
    return new YtDlpError('This video is private', 403, false, error)
  }

  if (combined.includes('members-only') || combined.includes('join this channel')) {
    return new YtDlpError('Members-only content', 403, false, error)
  }

  if (
    combined.includes('age-restricted') ||
    combined.includes('confirm your age') ||
    combined.includes('age gate')
  ) {
    return new YtDlpError('Age-restricted video', 403, false, error)
  }

  if (
    combined.includes('geo-restricted') ||
    combined.includes('not available in your country') ||
    combined.includes('not available on this server')
  ) {
    return new YtDlpError('Geo-restricted content', 403, false, error)
  }

  if (
    combined.includes('drm') ||
    combined.includes('video is protected') ||
    combined.includes('playback on other applications has been disabled')
  ) {
    return new YtDlpError('DRM-protected content', 403, false, error)
  }

  if (combined.includes('live stream')) {
    return new YtDlpError('Live streams are not supported yet', 501, false, error)
  }

  // ---- Retryable: transient network/anti-bot conditions ------------------
  if (
    combined.includes('sign in to confirm') ||
    combined.includes('not a bot') ||
    combined.includes('bot detection') ||
    combined.includes('requested format is not available')
  ) {
    return new YtDlpError(
      'YouTube bot detection triggered — retrying with a different client',
      429,
      true,
      error
    )
  }

  if (
    combined.includes('http error 429') ||
    combined.includes('too many requests') ||
    combined.includes('rate limit')
  ) {
    return new YtDlpError('Rate limited by YouTube', 429, true, error)
  }

  if (
    combined.includes('http error 403') ||
    combined.includes('forbidden') ||
    combined.includes('unavailable for this server') ||
    combined.includes('requested format is not available')
  ) {
    return new YtDlpError(
      'YouTube blocked this request (403) — the server IP may be flagged',
      429,
      true,
      error
    )
  }

  if (
    combined.includes('timed out') ||
    combined.includes('timeout') ||
    combined.includes('timed out after')
  ) {
    return new YtDlpError('Request timeout', 504, true, error)
  }

  if (
    combined.includes('network') ||
    combined.includes('connection') ||
    combined.includes('econnreset') ||
    combined.includes('econnrefused') ||
    combined.includes('eai_again') ||
    combined.includes('getaddrinfo') ||
    combined.includes('failed to resolve') ||
    combined.includes('ssl')
  ) {
    return new YtDlpError('Network error during extraction', 502, true, error)
  }

  if (err.code === 'ENOENT') {
    return new YtDlpError('yt-dlp is not installed (install with: pip install yt-dlp)', 500, false, error)
  }

  // Unknown — give it one more chance; the loop is bounded.
  return new YtDlpError(
    `yt-dlp error: ${message || stderr.slice(0, 300) || 'unknown error'}`,
    500,
    true,
    error
  )
}

// ---------------------------------------------------------------------------
// Raw extraction (with retries)
// ---------------------------------------------------------------------------

const VALID_ID_RE = /^[a-zA-Z0-9_-]{11}$/

function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

/**
 * Extract the raw yt-dlp info-dict for a video, retrying with exponential
 * backoff and rotating player clients on anti-bot/rate-limit failures.
 */
async function extractRawInfo(videoId: string): Promise<YtDlpVideoInfo> {
  if (!VALID_ID_RE.test(videoId)) {
    throw new YtDlpError('Invalid video ID', 400)
  }

  let lastError: YtDlpError | null = null

  for (let attempt = 0; attempt < MAX_EXTRACTION_ATTEMPTS; attempt++) {
    const client = PLAYER_CLIENTS[Math.min(attempt, PLAYER_CLIENTS.length - 1)]
    const args = [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--socket-timeout', '30',
      '--retries', '1',
      videoUrl(videoId)
    ]

    const extractorArgs = extractorArgsFor(client)
    if (extractorArgs) {
      args.splice(args.indexOf('--no-progress') + 1, 0, '--extractor-args', extractorArgs[0])
    } else {
      // Default-client attempt: attach a PO token when one is available
      // (env override first, then the auto-generation service). PO tokens
      // are web-client-specific, so they are never attached to the
      // android/mweb fallback attempts.
      const poArgs = await poTokenExtractorArg()
      if (poArgs) {
        args.splice(args.indexOf('--no-progress') + 1, 0, '--extractor-args', poArgs)
      }
    }

    try {
      const stdout = await runYtDlp({ args })

      let info: YtDlpVideoInfo
      try {
        info = JSON.parse(stdout) as YtDlpVideoInfo
      } catch (parseError) {
        throw new YtDlpError(
          `Failed to parse yt-dlp output: ${parseError instanceof Error ? parseError.message : 'parse error'}`,
          500,
          true,
          parseError
        )
      }

      if (!info || info.id !== videoId) {
        throw new YtDlpError(
          `Video ID mismatch: expected ${videoId}, got ${info?.id || 'none'}`,
          500,
          true
        )
      }

      return info
    } catch (error) {
      if (error instanceof YtDlpError) {
        lastError = error
      } else {
        lastError = classifyYtDlpError(error, `attempt ${attempt + 1}/${MAX_EXTRACTION_ATTEMPTS}`)
      }

      // Non-retryable → give up immediately (404, private, age-gated, …).
      if (!lastError.retryable) {
        throw lastError
      }

      if (attempt < MAX_EXTRACTION_ATTEMPTS - 1) {
        const delay = Math.min(INITIAL_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt), MAX_DELAY_MS)
        console.log(
          `[yt-dlp] ${videoId} attempt ${attempt + 1} failed (${lastError.message}). ` +
          `Retrying in ${delay}ms with player_client=${client || 'default'}...`
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError || new YtDlpError('Extraction failed after all retries', 500, false)
}

// ---------------------------------------------------------------------------
// Format selection
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

function toSelectedStream(f: YtDlpFormat, fallbackDuration: number, hasAv: boolean): SelectedStream {
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
 * Pick the single upstream URL to relay.
 *
 * This proxy exists for 1–2 Mbps links and only relays ONE direct URL, so
 * the winner is always a progressive (audio+video in a single file) format:
 *   1. Highest MP4/WebM combined format at or below maxHeight.
 *   2. Smallest MP4/WebM combined format above maxHeight. YouTube rarely
 *      serves combined formats below 360p, so a 240p request usually lands
 *      on 360p MP4 — exactly what mobile YouTube serves on slow links, and
 *      better than a silent DASH video-only stream.
 *   3. Legacy containers (3gp/flv) under/above the cap as a last resort.
 *   4. DASH video-only formats (silent — flagged hasAudio:false).
 *
 * Everything chosen must be a direct http(s) URL (no HLS/DASH manifests) so
 * the proxy can relay plain bytes with Range support.
 */
export function selectBestStream(info: YtDlpVideoInfo, maxHeight: number = 240): SelectedStream {
  const formats = (info.formats || []).filter(
    (f) => f && f.url && !isM3u8(f) && f.vcodec !== 'none'
  )

  if (formats.length === 0) {
    // Some clients only expose a single merged `url` on the info dict.
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
    throw new YtDlpError('No playable formats available for this video', 500)
  }

  const duration = info.duration || 0

  // Highest modern (mp4/webm) combined format at or below the cap.
  const pickHighestUnderCap = (pool: YtDlpFormat[]) =>
    pool
      .filter((f) => {
        const h = formatHeight(f)
        return h !== undefined && h <= maxHeight
      })
      .sort((a, b) => (formatHeight(b) as number) - (formatHeight(a) as number))[0]

  // Smallest format above the cap (we must go higher than requested).
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
    const h = formatHeight(candidate)
    if (h !== undefined && h > maxHeight) {
      console.log(
        `[yt-dlp] No combined format ≤${maxHeight}p for ${info.id}; ` +
        `using ${candidate.format_id} (${h}p) instead`
      )
    }
    return toSelectedStream(candidate, duration, true)
  }

  // Video-only DASH fallback (silent). Clearly flagged for callers.
  const videoOnly = withHeight(formats).sort(
    (a, b) => (formatHeight(a) as number) - (formatHeight(b) as number)
  )
  if (videoOnly.length > 0) {
    const best = videoOnly[0]
    console.log(`[yt-dlp] ${info.id}: only video-only (DASH) formats available; audio will be absent`)
    return toSelectedStream(best, duration, false)
  }

  throw new YtDlpError(`No suitable stream found for ${info.id} (max ${maxHeight}p)`, 500)
}

// ---------------------------------------------------------------------------
// Public API used by routes/services
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  /** Normalized raw info dict (metadata + full format list). */
  info: YtDlpVideoInfo
  /** The stream this extraction selected for proxying. */
  stream: SelectedStream
}

/**
 * Full extraction: raw info + a selected single-URL stream for the proxy.
 * This is what the stream route calls on a cache miss.
 */
export async function extractPlayableVideo(
  videoId: string,
  maxHeight: number = 240
): Promise<ExtractionResult> {
  const info = await extractRawInfo(videoId)

  if (info.is_live || info.live_status === 'is_live') {
    throw new YtDlpError('Live streams are not supported yet', 501, false)
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

/**
 * Extract video info and return the app's metadata shape (kept for the
 * metadata route / cache from phase 1). The direct stream URL is attached
 * but never exposed to clients — they are pointed at /api/stream instead.
 */
export async function extractVideoInfo(
  videoId: string,
  maxHeight: number = 240
): Promise<VideoMetadata> {
  const { info, stream } = await extractPlayableVideo(videoId, maxHeight)

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

/**
 * Search YouTube via `ytsearchN:`, with retries on transient failures.
 */
export async function searchVideos(
  query: string,
  maxResults: number = 8
): Promise<SearchResult[]> {
  const searchUrl = `ytsearch${maxResults}:${query}`

  const args = [
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    '--socket-timeout', '30',
    searchUrl
  ]

  let lastError: unknown = null

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const stdout = await runYtDlp({ args, timeoutMs: 40000, maxBuffer: 10 * 1024 * 1024 })
      const response = JSON.parse(stdout) as { entries?: YtDlpSearchEntry[] | null }
      const entries: YtDlpSearchEntry[] = response.entries || []

      return entries.map((entry) => ({
        id: entry.id,
        title: entry.title || '',
        duration: entry.duration || 0,
        thumbnail: `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
        author: entry.uploader || '',
        viewCount: entry.view_count || 0,
        publishedText: ''
      }))
    } catch (error) {
      lastError = error
      if (attempt < 2) {
        const delay = INITIAL_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  if (lastError instanceof YtDlpError) throw lastError
  const classified = classifyYtDlpError(lastError, 'search')
  throw new YtDlpError(`Search failed: ${classified.message}`, 500, false, lastError)
}
