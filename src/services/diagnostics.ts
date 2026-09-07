/**
 * Diagnostics engine (protected + rate-limited; never anonymous).
 *
 * Replaces the old 500-line anonymous /api/diag/* file which exposed raw
 * yt-dlp stderr, attempted WARP reconfiguration and called back into its own
 * HTTP API. This service:
 *
 *   - runs only when ENABLE_DIAGNOSTICS=true AND behind a session + an
 *     extremely strict rate limit + single-flight (one deep op at a time),
 *   - never re-enters the app over HTTP — tests are plain function calls,
 *   - never prints tokens/cookies/proxy credentials/full signed URLs;
 *     media URLs are redacted to their hostname,
 *   - performs no WARP or other host-network mutation.
 *
 * The distinction that matters operationally is kept explicit:
 *   RUNTIME_MISSING (nothing installed here)
 *   EXTRACTION_BLOCKED (YouTube refuses yt-dlp from this egress IP)
 *   CDN_BLOCKED (extraction worked but the media CDN refuses byte fetches)
 *   OK (both work from this egress right now).
 */

import { getEgressInfo as fetchEgressInfo } from './egress.js'
import { extractPlayableVideo } from './youtube/extractor.js'
import { YtDlpError, publicMessageFor } from './ytdlp/errors.js'
import { getYtDlpVersion, checkRuntimeHealth } from './ytdlp/runYtDlp.js'
import { safeFetchMedia, OutboundFetchError } from '../utils/net.js'
import { describeRuntimeState } from './ytdlp/runtime.js'
import { streamCache } from '../middleware/streamCache.js'
import { staleCache } from './cache/staleCache.js'
import { memoryCache } from './cache/memoryCache.js'
import { keepalive, bandwidthMonitor, assessSandboxHealth } from '../config/freebuff.js'
import { config } from '../config.js'

/** Redact a signed media URL to hostname + a generic label. */
export function redactMediaUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    const pathType = url.pathname.startsWith('/videoplayback') ? '/videoplayback' : '/media'
    return `${url.protocol}//${url.host}${pathType} (query redacted)`
  } catch {
    return '(malformed url)'
  }
}

export interface ConnectivityStep {
  name: string
  ok: boolean
  detail?: string
}

export interface ConnectivityReport {
  timestamp: string
  videoId: string
  quality: number
  runtime: {
    nodeVersion: string
    ytDlpDetectedVersion: string | null
    mode: string
  }
  steps: ConnectivityStep[]
  verdict: 'OK' | 'EXTRACTION_BLOCKED' | 'CDN_BLOCKED' | 'RUNTIME_MISSING' | 'PARTIAL'
}

export type DiagRunStatus = 'idle' | 'running'

// One deep operation at a time + cooldown between runs.
let diagBusy: Promise<unknown> | null = null
let lastDeepRunAt = 0
const DEEP_COOLDOWN_MS = 30_000

export function diagGateStatus(): DiagRunStatus {
  return diagBusy ? 'running' : 'idle'
}

export function deepCooldownRemainingMs(now = Date.now()): number {
  return Math.max(0, lastDeepRunAt + DEEP_COOLDOWN_MS - now)
}

/**
 * Run `task` as the single deep diagnostic operation. Rejects with a
 * {status:503} object when another deep run is in flight or the cooldown
 * has not elapsed.
 */
export async function withDeepDiagnostic<T>(task: () => Promise<T>): Promise<T> {
  const cooldown = deepCooldownRemainingMs()
  if (diagBusy) {
    const err = new Error('A diagnostic is already running') as Error & { status?: number; retryAfter?: number }
    err.status = 503
    err.retryAfter = 10
    throw err
  }
  if (cooldown > 0) {
    const err = new Error('Diagnostics cooling down') as Error & { status?: number; retryAfter?: number }
    err.status = 503
    err.retryAfter = Math.ceil(cooldown / 1000)
    throw err
  }

  const run = (async () => {
    try {
      return await task()
    } finally {
      diagBusy = null
      lastDeepRunAt = Date.now()
    }
  })()
  diagBusy = run
  return run
}

/** Protected connectivity report: extraction + one CDN byte fetch. */
export async function runConnectivityCheck(
  videoId: string,
  maxHeight: number
): Promise<ConnectivityReport> {
  const steps: ConnectivityStep[] = []
  const runtimeState = describeRuntimeState()

  const health = await checkRuntimeHealth()
  if (!health.ok) {
    return {
      timestamp: new Date().toISOString(),
      videoId,
      quality: maxHeight,
      runtime: {
        nodeVersion: process.version,
        ytDlpDetectedVersion: health.version,
        mode: runtimeState.mode
      },
      steps: [
        {
          name: 'runtime',
          ok: false,
          detail: health.problem === 'version_too_old' ? 'installed yt-dlp is older than the EJS minimum' : 'no usable yt-dlp executable'
        }
      ],
      verdict: 'RUNTIME_MISSING'
    }
  }

  steps.push({ name: 'runtime', ok: true, detail: health.version || undefined })

  // --- Step 2: extraction ---------------------------------------------------
  let mediaUrl: string | null = null
  try {
    const started = Date.now()
    const { info, stream } = await extractPlayableVideo(videoId, maxHeight)
    const durationMs = Date.now() - started
    mediaUrl = stream.url
    steps.push({
      name: 'extraction',
      ok: true,
      detail: `video ${info.id} (${info.duration || '?'}s), ${stream.quality}, in ${durationMs}ms`
    })
  } catch (error) {
    if (error instanceof YtDlpError) {
      steps.push({
        name: 'extraction',
        ok: false,
        detail: `${publicMessageFor(error.category)} [${error.code}]`
      })
      return {
        timestamp: new Date().toISOString(),
        videoId,
        quality: maxHeight,
        runtime: {
          nodeVersion: process.version,
          ytDlpDetectedVersion: health.version,
          mode: runtimeState.mode
        },
        steps,
        verdict: 'EXTRACTION_BLOCKED'
      }
    }
    steps.push({ name: 'extraction', ok: false, detail: 'unexpected extraction error' })
    return {
      timestamp: new Date().toISOString(),
      videoId,
      quality: maxHeight,
      runtime: {
        nodeVersion: process.version,
        ytDlpDetectedVersion: health.version,
        mode: runtimeState.mode
      },
      steps,
      verdict: 'PARTIAL'
    }
  }

  // --- Step 3: CDN byte fetch (validated, redacted, tiny range) -------------
  try {
    const upstream = await safeFetchMedia(mediaUrl, {
      headers: {
        Range: 'bytes=0-1023',
        Referer: 'https://www.youtube.com/',
        Origin: 'https://www.youtube.com'
      },
      timeoutMs: 20_000
    })
    const ok = upstream.status === 206 || (upstream.status >= 200 && upstream.status < 300)
    await upstream.body?.cancel().catch(() => {})
    steps.push({
      name: 'cdn',
      ok,
      detail: ok
        ? `HTTP ${upstream.status} from ${redactMediaUrl(mediaUrl)}`
        : `HTTP ${upstream.status} from ${redactMediaUrl(mediaUrl)}`
    })
    return {
      timestamp: new Date().toISOString(),
      videoId,
      quality: maxHeight,
      runtime: {
        nodeVersion: process.version,
        ytDlpDetectedVersion: health.version,
        mode: runtimeState.mode
      },
      steps,
      verdict: ok ? 'OK' : 'CDN_BLOCKED'
    }
  } catch (error) {
    const kind = error instanceof OutboundFetchError ? error.kind : 'unknown'
    steps.push({
      name: 'cdn',
      ok: false,
      detail: `${kind} (${redactMediaUrl(mediaUrl)})`
    })
    return {
      timestamp: new Date().toISOString(),
      videoId,
      quality: maxHeight,
      runtime: {
        nodeVersion: process.version,
        ytDlpDetectedVersion: health.version,
        mode: runtimeState.mode
      },
      steps,
      verdict: kind === 'aborted' ? 'PARTIAL' : 'CDN_BLOCKED'
    }
  }
}

export interface DiagStatusReport {
  diagnosticsEnabled: boolean
  runtime: {
    nodeVersion: string
    ytDlpDetectedVersion: string | null
    mode: string
    pinnedVersion: string
  }
  egress: Awaited<ReturnType<typeof fetchEgressInfo>> | null
  caches: {
    streamEntries: number
    staleEntries: number
    memoryEntries: number
  }
  sandbox: {
    bandwidth: ReturnType<typeof bandwidthMonitor.getStats>
    health: ReturnType<typeof assessSandboxHealth>
    keepalive: ReturnType<typeof keepalive.getStatus>
  }
  deepDiagnostic: { status: DiagRunStatus; cooldownSeconds: number }
}

export async function buildStatusReport(): Promise<DiagStatusReport> {
  const [egress] = await Promise.allSettled([fetchEgressInfo()])
  return {
    diagnosticsEnabled: config.enableDiagnostics,
    runtime: {
      nodeVersion: process.version,
      ytDlpDetectedVersion: await getYtDlpVersion(),
      mode: describeRuntimeState().mode,
      pinnedVersion: config.ytDlpVersion
    },
    egress: egress.status === 'fulfilled' ? egress.value : null,
    caches: {
      streamEntries: streamCache.size(),
      staleEntries: staleCache.size(),
      memoryEntries: memoryCache.size()
    },
    sandbox: {
      bandwidth: bandwidthMonitor.getStats(),
      health: assessSandboxHealth(),
      keepalive: keepalive.getStatus()
    },
    deepDiagnostic: {
      status: diagGateStatus(),
      cooldownSeconds: Math.ceil(deepCooldownRemainingMs() / 1000)
    }
  }
}
