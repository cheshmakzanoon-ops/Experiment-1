/**
 * FreeBuff-deployment helpers.
 *
 *   - an OPTIONAL keepalive (KEEPALIVE_ENABLED=false by default) that pings
 *     /api/health/live and — only when KEEPALIVE_EXTERNAL_URL is configured —
 *     one external endpoint. It is documented as an experiment: a process
 *     pinging itself does not prove an external Freebuff ingress stays
 *     alive, and platform lifecycle behaviour is not something app code can
 *     reliably override. The timer is unref'd and never blocks shutdown,
 *   - a bandwidth monitor counting bytes served (Content-Length responses +
 *     streamed relays),
 *   - a resource-pressure assessment used by protected diagnostics.
 */

import { config } from '../config.js'
import { streamCache } from '../middleware/streamCache.js'

// ---------------------------------------------------------------------------
// Keepalive service (optional)
// ---------------------------------------------------------------------------

export interface KeepaliveStatus {
  isRunning: boolean
  intervalMinutes: number
  lastPingAt: number | null
  lastInternalOk: boolean | null
  lastExternalOk: boolean | null
  internalPingCount: number
  externalUrl: string | null
}

class KeepaliveService {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private intervalMinutes = 0
  private lastPingAt: number | null = null
  private lastInternalOk: boolean | null = null
  private lastExternalOk: boolean | null = null
  private internalPingCount = 0

  private externalUrl = process.env.KEEPALIVE_EXTERNAL_URL || null

  /** Start only when KEEPALIVE_ENABLED=true; interval from config. */
  start(): void {
    if (this.intervalId) return
    if (!config.keepaliveEnabled) {
      console.log('[keepalive] Disabled (KEEPALIVE_ENABLED not true)')
      return
    }

    this.intervalMinutes = Math.max(1, config.keepaliveIntervalMinutes)
    const port = config.port

    const intervalId = setInterval(() => {
      void (async () => {
        const results = await Promise.allSettled([
          fetch(`http://127.0.0.1:${port}/api/health/live`, { signal: AbortSignal.timeout(5000) }),
          ...(this.externalUrl
            ? [fetch(this.externalUrl, { signal: AbortSignal.timeout(10_000) })]
            : [])
        ])

        this.lastPingAt = Date.now()
        this.internalPingCount += 1
        const [internal, external] = results

        if (internal.status === 'fulfilled' && internal.value.ok) {
          this.lastInternalOk = true
        } else {
          this.lastInternalOk = false
          const detail =
            internal.status === 'fulfilled'
              ? `HTTP ${internal.value.status}`
              : internal.reason instanceof Error
                ? internal.reason.message
                : String(internal.reason)
          console.warn(`[keepalive] Internal liveness check failed: ${detail}`)
        }

        if (external) {
          if (external.status === 'fulfilled') {
            this.lastExternalOk = true
          } else {
            this.lastExternalOk = false
            console.warn('[keepalive] External ping failed')
          }
        }
      })()
    }, this.intervalMinutes * 60 * 1000)
    // Never let the keepalive prevent a clean process shutdown.
    intervalId.unref()
    this.intervalId = intervalId

    console.log(
      `[keepalive] Enabled — every ${this.intervalMinutes} minutes ` +
        (this.externalUrl ? `(internal + external ${this.externalUrl})` : '(internal only)')
    )
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      this.intervalMinutes = 0
    }
  }

  getStatus(): KeepaliveStatus {
    return {
      isRunning: this.intervalId !== null,
      intervalMinutes: this.intervalId ? this.intervalMinutes : 0,
      lastPingAt: this.lastPingAt,
      lastInternalOk: this.lastInternalOk,
      lastExternalOk: this.lastExternalOk,
      internalPingCount: this.internalPingCount,
      externalUrl: this.externalUrl
    }
  }
}

export const keepalive = new KeepaliveService()

// ---------------------------------------------------------------------------
// Bandwidth monitor
// ---------------------------------------------------------------------------

export interface BandwidthStats {
  totalBytesServed: number
  totalMB: string
  totalGB: string
  responseCount: number
  uptimeSeconds: number
  peakMbps: string
  averageMbps: string
  trackingMode: 'content-length' | 'stream-wrap' | 'mixed'
}

/**
 * Counts bytes served to clients. Two sources feed it: the generic
 * middleware counts Content-Length responses; the stream-byte-counter
 * middleware counts bytes actually flowing through wrapped stream bodies.
 */
class BandwidthMonitor {
  private totalBytesServed = 0
  private responseCount = 0
  private startTime = Date.now()
  private peakBytesPerSecond = 0
  private bytesThisSecond = 0
  private secondTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.secondTimer = setInterval(() => {
      this.peakBytesPerSecond = Math.max(this.peakBytesPerSecond, this.bytesThisSecond)
      this.bytesThisSecond = 0
    }, 1000)
    this.secondTimer.unref()
  }

  trackBytes(bytes: number): void {
    if (bytes <= 0) return
    this.totalBytesServed += bytes
    this.bytesThisSecond += bytes
    this.responseCount++
  }

  getStats(): BandwidthStats {
    const uptimeSeconds = Math.max(1, (Date.now() - this.startTime) / 1000)
    const averageBytesPerSecond = this.totalBytesServed / uptimeSeconds

    return {
      totalBytesServed: this.totalBytesServed,
      totalMB: (this.totalBytesServed / 1024 / 1024).toFixed(2) + ' MB',
      totalGB: (this.totalBytesServed / 1024 / 1024 / 1024).toFixed(4) + ' GB',
      responseCount: this.responseCount,
      uptimeSeconds: Math.round(uptimeSeconds),
      peakMbps: ((this.peakBytesPerSecond * 8) / 1024 / 1024).toFixed(2) + ' Mbps',
      averageMbps: ((averageBytesPerSecond * 8) / 1024 / 1024).toFixed(2) + ' Mbps',
      trackingMode: 'mixed'
    }
  }
}

export const bandwidthMonitor = new BandwidthMonitor()

// ---------------------------------------------------------------------------
// Sandbox health assessment
// ---------------------------------------------------------------------------

export interface SandboxHealth {
  status: 'healthy' | 'degraded' | 'critical'
  issues: string[]
  recommendations: string[]
}

export function assessSandboxHealth(): SandboxHealth {
  const issues: string[] = []
  const recommendations: string[] = []

  const memUsage = process.memoryUsage()
  const memUsedMB = memUsage.heapUsed / 1024 / 1024
  const memTotalMB = memUsage.heapTotal / 1024 / 1024
  const memPercent = memTotalMB > 0 ? (memUsedMB / memTotalMB) * 100 : 0

  if (memPercent > 85) {
    issues.push(`High heap usage: ${memPercent.toFixed(1)}%`)
    recommendations.push('Reduce the stream-cache max size or restart the server')
  }

  const uptimeHours = process.uptime() / 3600
  if (uptimeHours > 24) {
    issues.push(`Server running for ${uptimeHours.toFixed(1)} hours`)
    recommendations.push('Consider a scheduled restart to clear memory growth')
  }

  const cacheSize = streamCache.size()
  if (cacheSize > 400) {
    issues.push(`Stream cache is large: ${cacheSize} entries`)
    recommendations.push('Cache is bounded (LRU at 500) but is using memory')
  }

  const status: SandboxHealth['status'] =
    issues.length === 0 ? 'healthy' : issues.length <= 2 ? 'degraded' : 'critical'

  return { status, issues, recommendations }
}
