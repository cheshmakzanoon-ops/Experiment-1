/**
 * Bounded concurrency controller for every expensive yt-dlp operation.
 *
 * A small Freebuff VM must never be able to spawn an unbounded number of
 * child processes. All yt-dlp invocations pass through one gate:
 *
 *   - `activeLimit` concurrent subprocesses (YT_DLP_CONCURRENCY, default 2),
 *   - a bounded waiting queue (YT_DLP_QUEUE_MAX, default 24) with a per-job
 *     queue timeout,
 *   - single-flight deduplication: simultaneous requests for the same work
 *     key share one promise instead of spawning identical subprocesses,
 *   - queue-full → controlled 503 + Retry-After (never unbounded memory),
 *   - `abortAll()` for graceful shutdown (rejects queued work, lets active
 *     jobs finish or be killed by the caller's own teardown hook).
 */

export class QueueFullError extends Error {
  constructor(
    message: string,
    public retryAfterSeconds: number
  ) {
    super(message)
    this.name = 'QueueFullError'
  }
}

export class QueueTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueueTimeoutError'
  }
}

interface WaitingJob<T> {
  task: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
  enqueuedAt: number
  name: string
}

export interface GateMetrics {
  active: number
  queued: number
  totalRuns: number
  totalRejectedFull: number
  totalQueueTimeouts: number
  singleFlightSaved: number
  singleFlightActive: number
}

export interface ConcurrencyGateOptions {
  activeLimit: number
  queueMax: number
  queueTimeoutMs: number
}

export class ConcurrencyGate {
  private active = 0
  private queue: WaitingJob<unknown>[] = []
  private totalRuns = 0
  private totalRejectedFull = 0
  private totalQueueTimeouts = 0
  private readonly flights = new Map<string, Promise<unknown>>()
  private flightsTouched = 0
  private flightsSaved = 0
  private shuttingDown = false

  constructor(private readonly options: ConcurrencyGateOptions) {}

  getMetrics(): GateMetrics {
    return {
      active: this.active,
      queued: this.queue.length,
      totalRuns: this.totalRuns,
      totalRejectedFull: this.totalRejectedFull,
      totalQueueTimeouts: this.totalQueueTimeouts,
      singleFlightSaved: this.flightsSaved,
      singleFlightActive: this.flights.size
    }
  }

  /**
   * Run `task`, optionally deduplicated by `key` when another identical job
   * is already in flight.
   */
  run<T>(key: string | null | undefined, task: () => Promise<T>): Promise<T> {
    if (key) {
      const existing = this.flights.get(key)
      if (existing) {
        this.flightsSaved++
        return existing as Promise<T>
      }
      const created = this.enqueue<T>(task)
      // Single-flight entries live as long as their promise; the map is
      // bounded (FIFO eviction) so a flood of unique keys cannot grow
      // memory — dedupe simply degrades for evicted keys.
      this.flights.set(key, created)
      if (this.flights.size > 500) {
        const oldest = this.flights.keys().next().value
        if (oldest !== undefined) this.flights.delete(oldest)
      }
      created.then(
        () => this.flights.delete(key),
        () => this.flights.delete(key)
      )
      return created
    }
    return this.enqueue<T>(task)
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) {
      return Promise.reject(new QueueFullError('Server is shutting down', 1))
    }
    return new Promise<T>((resolve, reject) => {
      const startNow = () => {
        this.active++
        this.totalRuns++
        Promise.resolve()
          .then(task)
          .then(
            (value) => {
              this.active--
              resolve(value)
              this.pump()
            },
            (reason) => {
              this.active--
              reject(reason)
              this.pump()
            }
          )
      }

      if (this.active < this.options.activeLimit) {
        startNow()
        return
      }

      if (this.queue.length >= this.options.queueMax) {
        this.totalRejectedFull++
        reject(
          new QueueFullError(
            'Too many extraction jobs are queued — try again shortly',
            Math.max(1, Math.ceil(this.queue.length / Math.max(1, this.options.activeLimit)))
          )
        )
        return
      }

      const job: WaitingJob<unknown> = {
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: null,
        enqueuedAt: Date.now(),
        name: ''
      }
      job.timer = setTimeout(() => {
        const idx = this.queue.indexOf(job)
        if (idx >= 0) this.queue.splice(idx, 1)
        this.totalQueueTimeouts++
        reject(new QueueTimeoutError('Extraction queue wait timed out'))
      }, this.options.queueTimeoutMs)
      this.queue.push(job)
    })
  }

  private pump(): void {
    while (this.active < this.options.activeLimit && this.queue.length > 0) {
      const job = this.queue.shift()
      if (!job) break
      if (job.timer) clearTimeout(job.timer)
      this.active++
      this.totalRuns++
      Promise.resolve()
        .then(job.task)
        .then(
          (value) => {
            this.active--
            job.resolve(value)
            this.pump()
          },
          (reason) => {
            this.active--
            job.reject(reason)
            this.pump()
          }
        )
    }
  }

  /** Graceful shutdown: reject queued work; active jobs keep their slots. */
  abortQueued(reason = 'Server shutting down'): void {
    this.shuttingDown = true
    const waiting = this.queue.splice(0)
    for (const job of waiting) {
      if (job.timer) clearTimeout(job.timer)
      job.reject(new QueueFullError(reason, 1))
    }
  }
}

/** Shared gate used by every yt-dlp invocation in the process. */
export const ytDlpGate = new ConcurrencyGate({
  activeLimit: 2, // replaced from config in init below
  queueMax: 24,
  queueTimeoutMs: 45_000
})

/** Apply config values (module-level config reads env at import). */
export function configureGateFromConfig(activeLimit: number, queueMax: number, queueTimeoutMs: number): void {
  ;(ytDlpGate as unknown as { options: ConcurrencyGateOptions }).options.activeLimit = activeLimit
  ;(ytDlpGate as unknown as { options: ConcurrencyGateOptions }).options.queueMax = queueMax
  ;(ytDlpGate as unknown as { options: ConcurrencyGateOptions }).options.queueTimeoutMs = queueTimeoutMs
}
