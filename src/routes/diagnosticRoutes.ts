import { Hono } from 'hono'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { extractPlayableVideo, YtDlpError, SUPPORTED_QUALITIES } from '../utils/ytDlp.js'
import { isValidVideoId } from '../utils/urlValidator.js'
import { streamCache } from '../middleware/streamCache.js'
import { keepalive, bandwidthMonitor, assessSandboxHealth } from '../config/freebuff.js'
import { detectBlocking, extractWithWorkarounds } from '../services/youtube/blockingWorkaround.js'
import { poTokenService } from '../services/potoken/generator.js'

const execFileAsync = promisify(execFile)

/**
 * Live-testing + failure-diagnosis endpoints for the FreeBuff deployment.
 *
 * They exist to answer one question: *where* does the
 * yt-dlp → googlevideo.com → byte-relay pipeline break when it breaks?
 * Mounted at /api (see src/index.ts) so they are reachable as:
 *
 *   GET /api/diag/pipeline          full pipeline test (the critical one)
 *   GET /api/diag/ip                egress IP + datacenter detection
 *   GET /api/diag/ytdlp-verbose     raw verbose yt-dlp log for one video
 *   GET /api/diag/stream-test       round-trip through our own /api/stream
 *   GET /api/diag/report            everything above, combined
 *   GET /api/diag/sandbox           keepalive/bandwidth/health snapshot
 *   GET /api/diag/blocking-status   what type of YouTube block is active
 *   GET /api/diag/workaround-extract  run the workaround ladder for a video
 *   GET /api/diag/potoken           PO-token provider status + token preview
 */

const PROBE_VIDEO_ID = 'dQw4w9WgXcQ' // Rick Astley — essentially always available

function parseQuality(raw: string | undefined): number | null {
  const quality = raw || '240'
  if (!(SUPPORTED_QUALITIES as readonly string[]).includes(quality)) return null
  return parseInt(quality, 10)
}

function invalidQualityMessage(): string {
  return `Invalid quality. Must be one of: ${SUPPORTED_QUALITIES.join(', ')}`
}

interface ExecFailure {
  stderr?: string
  message?: string
  code?: string | number
}

function textOf(error: unknown): string {
  const err = error as ExecFailure
  return `${err.stderr || ''} ${err.message || ''}`
}

// --- GET /api/diag/pipeline --------------------------------------------------
// Test the whole chain: yt-dlp extraction → URL selection → googlevideo.com
// reachability. If this passes, the app works.
const diagnosticRoutes = new Hono()

diagnosticRoutes.get('/diag/pipeline', async (c) => {
  const rawVideoId = c.req.query('v') || PROBE_VIDEO_ID
  if (!isValidVideoId(rawVideoId)) {
    return c.json({ error: 'Invalid video ID' }, 400)
  }
  const maxHeight = parseQuality(c.req.query('quality'))
  if (maxHeight === null) {
    return c.json({ error: invalidQualityMessage() }, 400)
  }

  const results: {
    timestamp: string
    testVideoId: string
    requestedQuality: string
    environment: Record<string, string | number>
    steps: Record<string, any>
    overall?: Record<string, unknown>
  } = {
    timestamp: new Date().toISOString(),
    testVideoId: rawVideoId,
    requestedQuality: String(maxHeight),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      uptimeSeconds: Math.round(process.uptime()),
      memoryHeapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    },
    steps: {}
  }

  // Step 1: yt-dlp installed?
  try {
    const { stdout } = await execFileAsync('yt-dlp', ['--version'], { timeout: 10000 })
    results.steps.ytdlpInstalled = {
      success: true,
      version: String(stdout).trim()
    }
  } catch (error) {
    results.steps.ytdlpInstalled = {
      success: false,
      error: textOf(error),
      hint: 'yt-dlp must be installed in the container (pip install yt-dlp).'
    }
    return c.json(results)
  }

  // Step 2: can we reach YouTube at all?
  try {
    const response = await fetch('https://www.youtube.com', {
      method: 'HEAD',
      signal: AbortSignal.timeout(10000)
    })
    results.steps.youtubeReachable = {
      success: response.ok,
      status: response.status,
      note: 'YouTube homepage reachable (metadata only, not video streams)'
    }
  } catch (error) {
    results.steps.youtubeReachable = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      note: 'Cannot reach YouTube at all — network/DNS issue in the sandbox'
    }
  }

  // Step 3: extraction (THE critical test). Raw info dict so we see the full
  // format list and the exact selected stream URL.
  try {
    const startTime = Date.now()
    const { info, stream } = await extractPlayableVideo(rawVideoId, maxHeight)
    const extractionTimeMs = Date.now() - startTime

    results.steps.extraction = {
      success: true,
      extractionTimeMs,
      videoId: info.id,
      videoTitle: info.title || '(unknown)',
      videoDurationSeconds: info.duration || 0,
      formatsFound: info.formats?.length || 0,
      selectedFormat: {
        quality: stream.quality,
        mimeType: stream.mimeType,
        height: stream.height,
        width: stream.width,
        hasAudio: stream.hasAudio,
        hasVideo: stream.hasVideo,
        host: (() => {
          try {
            return new URL(stream.url).hostname
          } catch {
            return 'invalid-url'
          }
        })()
      },
      note:
        extractionTimeMs < 5000
          ? 'Fast extraction — YouTube is not throttling us'
          : 'Slow extraction — possible rate limiting or bot detection'
    }

    // Step 4: is the chosen googlevideo.com URL actually serving bytes?
    try {
      const upstream = await fetch(stream.url, {
        method: 'GET',
        headers: {
          Range: 'bytes=0-1024',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Referer: 'https://www.youtube.com/'
        },
        signal: AbortSignal.timeout(15000)
      })

      results.steps.googlevideoAccessible = {
        success: upstream.ok || upstream.status === 206,
        status: upstream.status,
        contentType: upstream.headers.get('content-type'),
        contentRange: upstream.headers.get('content-range'),
        note:
          upstream.status === 403 || upstream.status === 429
            ? 'YouTube is blocking video stream access from this IP — THE MAIN FAILURE MODE'
            : upstream.ok || upstream.status === 206
              ? 'Video stream URL is accessible — bytes will flow'
              : `Unexpected upstream status ${upstream.status}`
      }
      await upstream.body?.cancel().catch(() => {})
    } catch (error) {
      results.steps.googlevideoAccessible = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        note: 'Failed to fetch from googlevideo.com — extraction succeeded but streaming is blocked'
      }
    }
  } catch (error) {
    const yt = error instanceof YtDlpError ? error : null
    const message = yt?.message || (error instanceof Error ? error.message : String(error))
    const lower = message.toLowerCase()

    results.steps.extraction = {
      success: false,
      error: message,
      code: yt?.code || 500,
      retryable: yt?.retryable ?? false,
      note:
        lower.includes('sign in to confirm') ||
        lower.includes('not a bot') ||
        lower.includes('bot detection') ||
        lower.includes('429') ||
        lower.includes('403')
          ? 'YouTube is blocking extraction from this IP — see /api/diag/blocking-status and /api/diag/ytdlp-verbose'
          : 'Extraction failed for another reason — see /api/diag/ytdlp-verbose'
    }
  }

  // Step 5: stream-cache status
  const cacheStats = streamCache.getStats()
  results.steps.cache = {
    entries: cacheStats.size,
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    note: 'Entries stay 0 until a successful extraction has been cached by /api/stream'
  }

  // Verdict
  const extractionOk = results.steps.extraction?.success === true
  const googlevideoOk = results.steps.googlevideoAccessible?.success === true

  results.overall = {
    canExtract: extractionOk,
    canStream: googlevideoOk,
    verdict:
      extractionOk && googlevideoOk
        ? 'FULL PIPELINE WORKS — the app should function correctly'
        : extractionOk && !googlevideoOk
          ? 'EXTRACTION OK BUT STREAMING BLOCKED — YouTube is blocking googlevideo.com access from this IP'
          : !extractionOk
            ? 'EXTRACTION BLOCKED — YouTube is blocking yt-dlp from this IP. Critical failure.'
            : 'UNKNOWN FAILURE — both steps inconclusive'
  }

  return c.json(results)
})

// --- GET /api/diag/ip --------------------------------------------------------
// What IP are we egressing from, and does it look like a datacenter?
diagnosticRoutes.get('/diag/ip', async (c) => {
  try {
    const [ipify, ipinfo] = await Promise.allSettled([
      fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) }),
      fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(10000) })
    ])

    const result: Record<string, unknown> = {
      timestamp: new Date().toISOString()
    }

    if (ipify.status === 'fulfilled' && ipify.value.ok) {
      const data = (await ipify.value.json()) as { ip?: string }
      result.ip = data.ip
    }

    if (ipinfo.status === 'fulfilled' && ipinfo.value.ok) {
      const data = (await ipinfo.value.json()) as {
        ip?: string
        hostname?: string
        org?: string
        city?: string
        region?: string
        country?: string
      }
      result.ip = data.ip || result.ip
      result.hostname = data.hostname
      result.org = data.org // reveals AWS/GCP/Oracle/etc.
      result.city = data.city
      result.region = data.region
      result.country = data.country
    }

    if (typeof result.org === 'string') {
      const orgLower = result.org.toLowerCase()
      const datacenterKeywords = [
        'amazon', 'aws', 'google', 'oracle', 'microsoft', 'azure',
        'digitalocean', 'linode', 'vultr', 'hetzner', 'ovh'
      ]
      result.isLikelyDatacenter = datacenterKeywords.some((k) => orgLower.includes(k))
      if (result.isLikelyDatacenter) {
        result.warning =
          'This IP belongs to a known cloud provider. YouTube actively blocks datacenter IPs from video streaming.'
      }
    }

    if (!result.ip) {
      result.error = 'Could not determine IP from either service'
    }

    return c.json(result)
  } catch (error) {
    return c.json(
      { error: 'Failed to check IP', message: error instanceof Error ? error.message : String(error) },
      500
    )
  }
})

// --- GET /api/diag/ytdlp-verbose ----------------------------------------------
// Run yt-dlp with --verbose so the raw YouTube interaction is inspectable.
diagnosticRoutes.get('/diag/ytdlp-verbose', async (c) => {
  const videoId = c.req.query('v') || PROBE_VIDEO_ID
  if (!isValidVideoId(videoId)) {
    return c.json({ error: 'Invalid video ID' }, 400)
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      'yt-dlp',
      [
        '--verbose',
        '--dump-single-json',
        '--no-warnings',
        '--no-progress',
        '--format', 'best[height<=240]',
        `https://www.youtube.com/watch?v=${videoId}`
      ],
      { maxBuffer: 20 * 1024 * 1024, timeout: 60000 }
    )

    interface ParsedInfo {
      id?: string
      title?: string
      duration?: number
      formats?: unknown[]
    }
    let parsed: ParsedInfo | null = null
    try {
      parsed = JSON.parse(stdout) as ParsedInfo
    } catch {
      // Not JSON — the error text is in stdout, surface it in stderr below.
    }

    return c.json({
      success: true,
      videoId,
      videoInfo: parsed
        ? { id: parsed.id, title: parsed.title, duration: parsed.duration, formatCount: parsed.formats?.length || 0 }
        : null,
      stderr: String(stderr || '(no stderr)').substring(0, 8000),
      botDetectionIndicators: {
        signInPrompt: stderr.includes('Sign in to confirm'),
        botCheck: stderr.includes('not a bot'),
        ipBlocked: stderr.includes('HTTP Error 429') || stderr.includes('HTTP Error 403'),
        playerClientRotation: stderr.includes('player_client')
      }
    })
  } catch (error) {
    const err = error as ExecFailure
    const stderrText = String(err.stderr || '')
    const message = err.message || String(error)

    return c.json(
      {
        success: false,
        videoId,
        error: message,
        stderr: stderrText.substring(0, 8000),
        analysis: {
          isBotDetection: stderrText.includes('Sign in to confirm') || stderrText.includes('not a bot'),
          isRateLimited: stderrText.includes('429') || stderrText.includes('Too Many Requests'),
          isIpBlocked: stderrText.includes('403') || stderrText.includes('Forbidden'),
          isNetworkError: /network|timeout|connection|resolve/i.test(stderrText),
          isVideoNotFound: stderrText.includes('Video unavailable')
        }
      },
      500
    )
  }
})

// --- GET /api/diag/stream-test --------------------------------------------------
// Round-trip through our own /api/stream endpoint with a 1 KB range request.
diagnosticRoutes.get('/diag/stream-test', async (c) => {
  const videoId = c.req.query('v') || PROBE_VIDEO_ID
  if (!isValidVideoId(videoId)) {
    return c.json({ error: 'Invalid video ID' }, 400)
  }
  const maxHeight = parseQuality(c.req.query('quality'))
  if (maxHeight === null) {
    return c.json({ error: invalidQualityMessage() }, 400)
  }

  const startTime = Date.now()
  const port = process.env.PORT || 3000

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/stream/${videoId}?quality=${maxHeight}`,
      {
        method: 'GET',
        headers: { Range: 'bytes=0-1023' },
        signal: AbortSignal.timeout(60000)
      }
    )

    const result: Record<string, any> = {
      success: response.ok || response.status === 206,
      status: response.status,
      responseTimeMs: Date.now() - startTime,
      headers: {
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
        contentRange: response.headers.get('content-range'),
        acceptRanges: response.headers.get('accept-ranges')
      }
    }

    if (response.body) {
      const reader = response.body.getReader()
      const { value } = await reader.read()
      result.bytesReceived = value?.byteLength || 0
      result.firstBytesHex = value ? Array.from(value.slice(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join(' ') : null
      await reader.cancel().catch(() => {})
    }

    if (response.status === 429) {
      result.assessment = 'YouTube rate limiting — the proxy is being blocked'
    } else if (response.status === 403) {
      result.assessment = 'YouTube IP block — the sandbox IP is blacklisted'
    } else if (response.ok || response.status === 206) {
      result.assessment = 'Stream is working — the app should be able to play videos'
    } else {
      result.assessment = `Unexpected status ${response.status} — read the error body above`
    }

    return c.json(result)
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        responseTimeMs: Date.now() - startTime,
        assessment: 'Stream request failed — check whether the server is running and yt-dlp is installed'
      },
      500
    )
  }
})

// --- GET /api/diag/potoken -----------------------------------------------------
// PO-token status: env override, provider reachability, and (when a provider
// answers) a freshly generated token pair preview.
diagnosticRoutes.get('/diag/potoken', async (c) => {
  const status = poTokenService.getStatus()

  let tokenData: Record<string, string> | null = null
  if (!status.hasToken || status.mode === 'provider') {
    try {
      const token = await poTokenService.getToken()
      tokenData = {
        tokenPreview: token.token.substring(0, 24) + '…',
        visitorDataPreview: token.visitorData.substring(0, 24) + '…',
        expiresInMinutes: String(Math.max(1, Math.round((token.expiresAt - Date.now()) / 60000)))
      }
    } catch (error: any) {
      tokenData = {
        error: error?.message || String(error),
        hint: 'Run a bgutil POT provider (docker-compose.yml sidecar / clone Brainicism/bgutil-ytdlp-pot-provider; see POTOKEN.md), or set YT_PO_TOKEN / YT_VISITOR_DATA env vars'
      }
    }
  }

  return c.json({
    timestamp: new Date().toISOString(),
    status,
    tokenData,
    environmentCheck: {
      ytPoTokenSet: !!process.env.YT_PO_TOKEN,
      ytVisitorDataSet: !!process.env.YT_VISITOR_DATA,
      providerUrl: process.env.YT_PO_PROVIDER_URL || 'http://127.0.0.1:4416',
      note:
        'PO tokens only matter when YouTube blocks datacenter IPs. Without a token, extraction still attempts (and may fail with a bot-wall).'
    }
  })
})

// --- GET /api/diag/sandbox ------------------------------------------------------
// FreeBuff sandbox health snapshot.
diagnosticRoutes.get('/diag/sandbox', (c) => {
  const health = assessSandboxHealth()
  const bandwidth = bandwidthMonitor.getStats()
  const keepaliveStatus = keepalive.getStatus()

  return c.json({
    timestamp: new Date().toISOString(),
    sandboxHealth: health,
    bandwidth,
    keepalive: keepaliveStatus,
    note:
      health.status === 'healthy'
        ? 'Sandbox looks healthy'
        : `Sandbox ${health.status} — see issues/recommendations`
  })
})

// --- GET /api/diag/blocking-status ------------------------------------------------
// Which kind of YouTube block (if any) is currently active?
diagnosticRoutes.get('/diag/blocking-status', async (c) => {
  const result = await detectBlocking()
  return c.json({
    timestamp: new Date().toISOString(),
    ...result,
    hint: result.isBlocked
      ? 'See /api/diag/workaround-extract?v=ID to try the workaround ladder, or /api/diag/ip to check the egress IP'
      : 'No block detected on the probe video'
  })
})

// --- GET /api/diag/workaround-extract ------------------------------------------------
// Run the workaround ladder (client rotation → explicit android/mweb) against
// one video.
diagnosticRoutes.get('/diag/workaround-extract', async (c) => {
  const videoId = c.req.query('v') || PROBE_VIDEO_ID
  if (!isValidVideoId(videoId)) {
    return c.json({ error: 'Invalid video ID' }, 400)
  }
  const maxHeight = parseQuality(c.req.query('quality'))
  if (maxHeight === null) {
    return c.json({ error: invalidQualityMessage() }, 400)
  }

  const startTime = Date.now()
  const result = await extractWithWorkarounds(videoId, maxHeight)

  return c.json({
    timestamp: new Date().toISOString(),
    videoId,
    responseTimeMs: Date.now() - startTime,
    ...result,
    data: result.data
      ? {
          id: result.data.id,
          title: result.data.title,
          duration: result.data.duration,
          author: result.data.author,
          selectedQuality: result.data.formats?.[0]?.quality
        }
      : undefined
  })
})

// --- GET /api/diag/report -----------------------------------------------------------
// Combined diagnostic report (IP + pipeline + verdict). Can take a while when
// YouTube is throttling — the pipeline step is allowed up to ~2.5 minutes.
diagnosticRoutes.get('/diag/report', async (c) => {
  const port = process.env.PORT || 3000

  const [ipResult, pipelineResult] = await Promise.allSettled([
    fetch(`http://127.0.0.1:${port}/api/diag/ip`, { signal: AbortSignal.timeout(20000) }),
    fetch(`http://127.0.0.1:${port}/api/diag/pipeline?quality=240`, {
      signal: AbortSignal.timeout(150000)
    })
  ])

  const report: Record<string, any> = {
    timestamp: new Date().toISOString(),
    serverInfo: {
      uptimeSeconds: Math.round(process.uptime()),
      memoryHeapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      nodeVersion: process.version
    }
  }

  report.ipInfo =
    ipResult.status === 'fulfilled' && ipResult.value.ok
      ? await ipResult.value.json()
      : { error: 'IP check failed', detail: ipResult.status === 'fulfilled' ? `HTTP ${ipResult.value.status}` : String(ipResult.reason) }

  report.pipeline =
    pipelineResult.status === 'fulfilled' && pipelineResult.value.ok
      ? await pipelineResult.value.json()
      : { error: 'Pipeline test failed', detail: pipelineResult.status === 'fulfilled' ? `HTTP ${pipelineResult.value.status}` : String(pipelineResult.reason) }

  const pipelineVerdict: string = report.pipeline?.overall?.verdict || ''
  const pipelineWorks = pipelineVerdict.includes('WORKS')
  const isDatacenter = report.ipInfo?.isLikelyDatacenter === true

  report.status = {
    canStream: pipelineWorks,
    isDatacenter,
    riskLevel: pipelineWorks ? 'low' : isDatacenter ? 'high' : 'medium',
    recommendation: pipelineWorks
      ? 'System is working. Test from a phone, then build the APK and test from Iran.'        : isDatacenter
          ? 'YouTube is likely blocking this datacenter IP. Try /api/diag/blocking-status and /api/diag/potoken (PO tokens help); if still blocked, move egress to another host with a residential/non-flagged IP.'
        : 'Extraction failed but the IP is not obviously a datacenter. Read /api/diag/ytdlp-verbose for the raw error.'
  }

  return c.json(report)
})

export { diagnosticRoutes }
