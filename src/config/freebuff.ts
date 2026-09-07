import { streamCache } from '../middleware/streamCache.js'

/**
 * FreeBuff-deployment helpers.
 *
 * FreeBuff previews are dev sandboxes, not production hosting: they can go
 * idle/sleep after a period without traffic, and their bandwidth limits are
 * unknown. This module provides:
 *
 *   - a keepalive that pings /api/health AND an external service so an idle
 *     preview stays awake (idle detection often measures external egress,
 *     which a loopback self-ping never generates),
 *   - a bandwidth monitor that counts bytes relayed through the server
 *     (both Content-Length responses and wrapped streaming bodies),
 *   - an assessment endpoint helper that flags resource pressure.
 */

// ---------------------------------------------------------------------------
// Keepalive service
// ---------------------------------------------------------------------------

export interface KeepaliveStatus {
  isRunning: boolean
  intervalMinutes: number
  lastPingAt: number | null
  lastInternalOk: boolean | null
  lastExternalOk: boolean | null
  internalPingCount: number
  externalOkCount: number
  externalUrl: string
}

class KeepaliveService {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private intervalMinutes = 0
  private lastPingAt: number | null = null
  private lastInternalOk: boolean | null = null
  private lastExternalOk: boolean | null = null
  private internalPingCount = 0
  private externalOkCount = 0

  /** Lightweight external endpoint hit on every tick (egress traffic). */
  private externalUrl = process.env.KEEPALIVE_EXTERNAL_URL || 'https://api.ipify.org'

  /**
   * Ping our own /api/health AND an external service every `intervalMinutes`
   * minutes. The internal ping verifies the server is responsive; the
   * external ping generates real network egress, which is what
   * idle-detection systems typically measure. Failures are logged but never
   * crash or stop the loop.
   */
  start(intervalMinutes: number): void {
    if (this.intervalId) {
      console.log(`[keepalive] Already running (every ${this.intervalMinutes} minutes)`)
      return
    }

    if (intervalMinutes < 1) {
      console.warn('[keepalive] Interval must be >= 1 minute; using 4')
      intervalMinutes = 4
    }

    this.intervalMinutes = intervalMinutes
    const port = process.env.PORT || 3000

    this.intervalId = setInterval(() => {
      void (async () => {
        const results = await Promise.allSettled([
          // Internal health check (loopback — proves the server is alive).
          fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: AbortSignal.timeout(5000)
          }),
          // External ping (generates real egress traffic).
          fetch(this.externalUrl, {
            signal: AbortSignal.timeout(10000)
          })
        ])

        this.lastPingAt = Date.now()
        this.internalPingCount += 1
        const [internal, external] = results

        if (internal.status === 'fulfilled' && internal.value.ok) {
          this.lastInternalOk = true
          // Keep the log quiet — log ~10% of successful internal pings.
          if (Math.random() < 0.1) {
            console.log(`[keepalive] Ping ok at ${new Date().toISOString()}`)
          }
        } else {
          this.lastInternalOk = false
          const detail =
            internal.status === 'fulfilled'
              ? `/api/health returned ${internal.value.status}`
              : internal.reason instanceof Error
                ? internal.reason.message
                : String(internal.reason)
          console.warn(`[keepalive] Internal health check failed: ${detail}`)
        }

        if (external.status === 'fulfilled') {
          this.lastExternalOk = true
          this.externalOkCount += 1
          // Log ~10% of successful external pings to avoid log spam.
          if (Math.random() < 0.1) {
            console.log(`[keepalive] External ping ok at ${new Date().toISOString()}`)
          }
        } else {
          this.lastExternalOk = false
          console.warn('[keepalive] External ping failed — may indicate network issues')
        }
      })()
    }, intervalMinutes * 60 * 1000)

    console.log(
      `[keepalive] Started — pinging every ${intervalMinutes} minutes ` +
        `(internal /api/health + external ${this.externalUrl})`
    )
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      this.intervalMinutes = 0
      console.log('[keepalive] Stopped')
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
      externalOkCount: this.externalOkCount,
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
 * Counts bytes served to clients and derives running Mbps figures.
 *
 * Two sources feed this monitor:
 *   - the generic middleware counts Content-Length responses,
 *   - the stream-byte-counter middleware (src/middleware/streamByteCounter.ts)
 *     counts bytes that actually flow through wrapped /api/stream bodies
 *     (chunked relays would otherwise be invisible to Content-Length).
 */
class BandwidthMonitor {
  private totalBytesServed = 0
  private responseCount = 0
  private startTime = Date.now()
  private peakBytesPerSecond = 0
  private bytesThisSecond = 0

  constructor() {
    setInterval(() => {
      this.peakBytesPerSecond = Math.max(this.peakBytesPerSecond, this.bytesThisSecond)
      this.bytesThisSecond = 0
    }, 1000).unref()
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

  reset(): void {
    this.totalBytesServed = 0
    this.responseCount = 0
    this.startTime = Date.now()
    this.peakBytesPerSecond = 0
    this.bytesThisSecond = 0
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
    issues.push(`High heap usage: ${memPercent.toFixed(1)}% (${memUsedMB.toFixed(0)}/${memTotalMB.toFixed(0)} MB)`)
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
