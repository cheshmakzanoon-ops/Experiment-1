import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  extractVideoInfo,
  selectBestStream,
  YtDlpError,
  type YtDlpVideoInfo
} from '../../utils/ytDlp.js'
import type { VideoMetadata } from '../../types/video.js'

const execFileAsync = promisify(execFile)

/**
 * YouTube blocking workarounds.
 *
 * YouTube aggressively blocks datacenter IPs ("Sign in to confirm you're
 * not a bot", HTTP 429/403). Normal extraction in src/utils/ytDlp.ts already
 * retries with exponential backoff and rotates player clients
 * (default → android → mweb). This module layers diagnostics and a fallback
 * ladder on top of that:
 *
 *   - detectBlocking()      — classify the exact block type YouTube applies,
 *   - extractWithWorkarounds() — drive extraction through the ladder and
 *     report which attempt (if any) got through.
 *
 * Cloudflare WARP was previously a ladder rung but was removed: the Docker
 * image does not install `warp-cli` (the image is already large with
 * Chromium), so that path could never succeed. To re-enable it later,
 * install cloudflare-warp in the Dockerfile and restore a
 * `warp-cli connect` → re-extract step here.
 */

export interface BlockingTestResult {
  isBlocked: boolean
  blockType: 'bot_detection' | 'rate_limit' | 'ip_block' | 'none'
  workaroundsAvailable: string[]
  detail?: string
}

interface ExecError {
  stderr?: string
  message?: string
}

/** A video that is essentially always up, used as the probe. */
const PROBE_VIDEO_ID = 'dQw4w9WgXcQ'

function combinedErrorText(error: unknown): string {
  const err = error as ExecError
  return `${err.stderr || ''} ${error instanceof Error ? error.message : ''}`.toLowerCase()
}

/**
 * Detect whether YouTube is blocking us, and what type of block it is, by
 * attempting a known-good extraction.
 */
export async function detectBlocking(): Promise<BlockingTestResult> {
  try {
    await execFileAsync(
      'yt-dlp',
      [
        '--dump-single-json',
        '--no-warnings',
        '--no-progress',
        '--format', 'best[height<=240]',
        `https://www.youtube.com/watch?v=${PROBE_VIDEO_ID}`
      ],
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    )

    return { isBlocked: false, blockType: 'none', workaroundsAvailable: [] }
  } catch (error) {
    const text = combinedErrorText(error)

    if (text.includes('sign in to confirm') || text.includes('not a bot')) {
      return {
        isBlocked: true,
        blockType: 'bot_detection',
        workaroundsAvailable: [
          'player_client_rotation (built into ytDlp.ts)',
          'po_token (auto-generated or YT_PO_TOKEN / YT_VISITOR_DATA env)',
          'residential egress / authenticated cookies'
        ]
      }
    }

    if (text.includes('429') || text.includes('too many requests')) {
      return {
        isBlocked: true,
        blockType: 'rate_limit',
        workaroundsAvailable: [
          'exponential backoff (built into ytDlp.ts)',
          'request throttling / longer cache TTLs',
          'cache-first strategy (already in place)'
        ]
      }
    }

    if (text.includes('403') || text.includes('forbidden')) {
      return {
        isBlocked: true,
        blockType: 'ip_block',
        workaroundsAvailable: [
          'po_token (see POTOKEN.md)',
          'different hosting provider / residential egress'
        ]
      }
    }

    return {
      isBlocked: true,
      blockType: 'bot_detection',
      workaroundsAvailable: ['unknown — check /api/diag/ytdlp-verbose for the raw error'],
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Build the app's /api/video-shaped metadata from a raw yt-dlp info dict. */
function toMetadata(info: YtDlpVideoInfo, maxHeight: number): VideoMetadata {
  const stream = selectBestStream(info, maxHeight)
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
    formats: [
      {
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
    ]
  }
}

/**
 * Run one explicit yt-dlp extraction pinned to a player client and return
 * the app's metadata shape. Used only after the default rotation has failed.
 */
async function extractWithClient(
  videoId: string,
  maxHeight: number,
  client: 'android' | 'mweb'
): Promise<VideoMetadata> {
  const { stdout } = await execFileAsync(
    'yt-dlp',
    [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--socket-timeout', '30',
      '--retries', '1',
      '--extractor-args', `youtube:player_client=${client}`,
      `https://www.youtube.com/watch?v=${videoId}`
    ],
    { timeout: 60000, maxBuffer: 15 * 1024 * 1024 }
  )

  const info = JSON.parse(stdout) as YtDlpVideoInfo
  if (!info || info.id !== videoId) {
    throw new YtDlpError(`Video ID mismatch: expected ${videoId}`, 500, true)
  }
  if (info.is_live || info.live_status === 'is_live') {
    throw new YtDlpError('Live streams are not supported yet', 501, false)
  }

  return toMetadata(info, maxHeight)
}

export interface WorkaroundExtractionResult {
  success: boolean
  data?: VideoMetadata
  workaroundsAttempted: string[]
  error?: string
}

/**
 * Enhanced extraction with automatic workaround attempts:
 *
 *   1. normal extraction (itself: default → android → mweb rotation with
 *      backoff and an optional PO token),
 *   2. explicit android player client,
 *   3. explicit mweb player client.
 *
 * (Cloudflare WARP was rung 4 until it was removed — warp-cli is not
 * installed in the Docker image. See the module docstring for re-enabling.)
 *
 * Content-level failures (private/age-gated/404/geo/DRM) are never retried —
 * a client switch cannot fix those, so they fail fast.
 */
export async function extractWithWorkarounds(
  videoId: string,
  maxHeight: number = 240
): Promise<WorkaroundExtractionResult> {
  const workaroundsAttempted: string[] = []

  // 1. Normal path — already includes client rotation + backoff + PO token.
  try {
    const info = await extractVideoInfo(videoId, maxHeight)
    return { success: true, data: info, workaroundsAttempted }
  } catch (error) {
    if (error instanceof YtDlpError && !error.retryable) {
      return { success: false, workaroundsAttempted, error: error.message }
    }
    workaroundsAttempted.push('default rotation exhausted')
  }

  // 2 + 3. Explicit single-client attempts.
  for (const client of ['android', 'mweb'] as const) {
    try {
      const info = await extractWithClient(videoId, maxHeight, client)
      workaroundsAttempted.push(`player_client=${client} (worked)`)
      return { success: true, data: info, workaroundsAttempted }
    } catch (error) {
      workaroundsAttempted.push(
        `player_client=${client} (failed: ${error instanceof Error ? error.message.slice(0, 120) : 'error'})`
      )
    }
  }

  // 4. Cloudflare WARP — REMOVED. The Docker image does not install
  //    `warp-cli`, so hopping egress through WARP could never work here.
  //    If it is ever needed again: add cloudflare-warp to the Dockerfile,
  //    then reconnect + re-extract in this slot (see the module docstring).

  return {
    success: false,
    workaroundsAttempted,
    error:
      'All extraction methods failed. YouTube is blocking this server IP.\n' +
      'Recommended: ensure a PO token is configured (see POTOKEN.md) or move egress to a residential IP.'
  }
}
