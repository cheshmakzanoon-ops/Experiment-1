import { streamCache } from '../middleware/streamCache.js'

/**
 * FreeBuff-deployment helpers.
 *
 * FreeBuff previews are dev sandboxes, not production hosting: they can go
 * idle/sleep after a period without traffic, and their bandwidth limits are
 * unknown. This module provides:
 *
 *   - a keepalive that self-pings /api/health so an idle preview stays awake,
 *   - a bandwidth monitor that estimates bytes relayed through the server,
 *   - an assessment endpoint helper that flags resource pressure.
 */

// ---------------------------------------------------------------------------
// Keepalive service
// ---------------------------------------------------------------------------

class KeepaliveService {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private intervalMinutes = 0

  /** Ping our own /api/health every `intervalMinutes` minutes. */
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
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: AbortSignal.timeout(5000)
          })
          if (response.ok) {
            console.log(`[keepalive] Ping ok at ${new Date().toISOString()}`)
          } else {
            console.warn(`[keepalive] /api/health returned ${response.status}`)
          }
        } catch (error) {
          console.error('[keepalive] Self-ping failed:', error instanceof Error ? error.message : error)
        }
      })()
    }, intervalMinutes * 60 * 1000)

    console.log(`[keepalive] Started — pinging /api/health every ${intervalMinutes} minutes`)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      this.intervalMinutes = 0
      console.log('[keepalive] Stopped')
    }
  }

  getStatus(): { isRunning: boolean; intervalMinutes: number } {
    return {
      isRunning: this.intervalId !== null,
      intervalMinutes: this.intervalId ? this.intervalMinutes : 0
    }
  }
}

export const keepalive = new KeepaliveService()

// ---------------------------------------------------------------------------
// Bandwidth monitor
// ---------------------------------------------------------------------------

/**
 * Tracks bytes served (from Content-Length headers after each response) and
 * derives running Mbps figures. Streams that are relayed without a
 * Content-Length (chunked transfer) are undercounted — the numbers are a
 * lower-bound estimate useful for spotting capacity problems, not billing.
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

  getStats(): {
    totalBytesServed: number
    totalMB: string
    responseCount: number
    uptimeSeconds: number
    peakMbps: string
    averageMbps: string
  } {
    const uptimeSeconds = Math.max(1, (Date.now() - this.startTime) / 1000)
    const averageBytesPerSecond = this.totalBytesServed / uptimeSeconds

    return {
      totalBytesServed: this.totalBytesServed,
      totalMB: (this.totalBytesServed / 1024 / 1024).toFixed(2) + ' MB',
      responseCount: this.responseCount,
      uptimeSeconds: Math.round(uptimeSeconds),
      peakMbps: ((this.peakBytesPerSecond * 8) / 1024 / 1024).toFixed(2) + ' Mbps',
      averageMbps: ((averageBytesPerSecond * 8) / 1024 / 1024).toFixed(2) + ' Mbps'
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
