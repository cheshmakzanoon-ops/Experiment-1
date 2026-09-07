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
 *     key SHARE one underlying operation, but every caller owns an
 *     independent waiter promise and its own AbortSignal subscription,
 *   - queue-full → controlled 503 + Retry-After (never unbounded memory),
 *   - `abortQueued()` for graceful shutdown: permanently closes admission,
 *     rejects/removes queued jobs and clears their timers (active jobs keep
 *     their slots until the actual task settles).
 *
 * Cancellation semantics (each caller independent):
 *   - a pre-aborted caller never enqueues work and never joins a flight,
 *   - cancelling one waiter rejects only that waiter and removes its
 *     listener; remaining waiters keep the operation alive,
 *   - when the LAST waiter leaves, queued work is removed immediately or an
 *     active operation's owned controller is aborted,
 *   - a caller without a signal remains a waiter until settlement,
 *   - an active slot is released only when the actual task settles — a
 *     cancelled child still shutting down occupies its slot.
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

/** Distinct AbortError contract shared across queue/extraction/route code. */
export function createAbortError(message = 'The operation was aborted'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'AbortError'
  )
}

export interface GateMetrics {
  active: number
  queued: number
  totalRuns: number
  totalRejectedFull: number
  totalQueueTimeouts: number
  singleFlightSaved: number
  /** Keyed flights currently deduplicated (queued + active). */
  singleFlightActive: number
  /** True once shutdown closed admission. */
  closed: boolean
}

export interface ConcurrencyGateOptions {
  activeLimit: number
  queueMax: number
  queueTimeoutMs: number
}

interface Waiter {
  /** Undefined = the caller wants to stay until settlement. */
  signal?: AbortSignal
  cancelled: boolean
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  onAbort: () => void
}

interface Flight<T> {
  key?: string
  task: (operationSignal: AbortSignal) => Promise<T>
  /** Owned by the flight — the first caller never owns the subprocess. */
  operation: AbortController
  state: 'queued' | 'active' | 'settled'
  /** Individual caller promises (each resolved exactly once on settle). */
  waiters: Set<Waiter>
  /** Settlement of the actual underlying task. */
  core: Promise<T>
  settleCore: (value: T | PromiseLike<T>) => void
  rejectCore: (reason: unknown) => void
  queueTimer: ReturnType<typeof setTimeout> | null
  queueTimerCleared: boolean
}

export class ConcurrencyGate {
  private active = 0
  private queue: Flight<any>[] = []
  private totalRuns = 0
  private totalRejectedFull = 0
  private totalQueueTimeouts = 0
  private readonly flights = new Map<string, Flight<any>>()
  private flightsSaved = 0
  private shuttingDown = false
  private readonly options: ConcurrencyGateOptions

  constructor(options: ConcurrencyGateOptions) {
    this.options = { ...options }
  }

  getMetrics(): GateMetrics {
    return {
      active: this.active,
      queued: this.queue.length,
      totalRuns: this.totalRuns,
      totalRejectedFull: this.totalRejectedFull,
      totalQueueTimeouts: this.totalQueueTimeouts,
      singleFlightSaved: this.flightsSaved,
      singleFlightActive: this.flights.size,
      closed: this.shuttingDown
    }
  }

  /** Explicit closed-state access for readiness/shutdown reporting. */
  isShutdown(): boolean {
    return this.shuttingDown
  }

  /**
   * Validate + apply new concurrency bounds. Refuses to change while any
   * work is active, queued, or admission is closed — the singleton is
   * configured once during startup, never per request.
   */
  configure(options: ConcurrencyGateOptions): void {
    if (this.shuttingDown) {
      throw new Error('ConcurrencyGate cannot be reconfigured after shutdown')
    }
    if (this.active > 0 || this.queue.length > 0) {
      throw new Error('ConcurrencyGate cannot be reconfigured while work is active or queued')
    }
    this.options.activeLimit = options.activeLimit
    this.options.queueMax = options.queueMax
    this.options.queueTimeoutMs = options.queueTimeoutMs
  }

  /**
   * Run `task`, optionally deduplicated by `key` while an identical job is
   * queued/active. Each caller receives its OWN promise; the existing
   * operation promise is never handed to a caller directly.
   */
  run<T>(
    key: string | null | undefined,
    task: (operationSignal: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal } = {}
  ): Promise<T> {
    // A pre-aborted caller must neither enqueue work nor join a flight.
    if (options.signal && options.signal.aborted) {
      return Promise.reject(createAbortError('Caller aborted before the operation started'))
    }
    // Check shutdown BEFORE deduplication.
    if (this.shuttingDown) {
      return Promise.reject(new QueueFullError('Server is shutting down', 1))
    }

    if (key) {
      const existing = this.flights.get(key)
      if (existing && existing.state !== 'settled' && !existing.operation.signal.aborted) {
        this.flightsSaved++
        return this.attachWaiter(existing, options.signal) as Promise<T>
      }
      // Remove abandoned flights (settled or aborting) before accepting
      // replacement work below.
      if (existing) this.flights.delete(key)
    }

    const flight = this.createFlight<T>(key, task)
    if (key) this.flights.set(key, flight)
    const waiterPromise = this.attachWaiter(flight, options.signal)
    this.enqueue(flight)
    return waiterPromise as Promise<T>
  }

  private createFlight<T>(key: string | null | undefined, task: (s: AbortSignal) => Promise<T>): Flight<T> {
    let settleCore!: (value: T | PromiseLike<T>) => void
    let rejectCore!: (reason: unknown) => void
    const core = new Promise<T>((resolve, reject) => {
      settleCore = resolve
      rejectCore = reject
    })
    // Ensure the core rejection is always observed (waiter bookkeeping may
    // be empty when every waiter left).
    void core.catch(() => undefined)
    const flight: Flight<T> = {
      key: key ?? undefined,
      task,
      operation: new AbortController(),
      state: 'queued',
      waiters: new Set(),
      core,
      settleCore,
      rejectCore,
      queueTimer: null,
      queueTimerCleared: false
    }
    return flight
  }

  private attachWaiter(flight: Flight<any>, signal?: AbortSignal): Promise<unknown> {
    if (signal && signal.aborted) {
      // Raced between the guard above and here.
      return Promise.reject(createAbortError('Caller aborted before the operation started'))
    }
    return new Promise<unknown>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        cancelled: false,
        resolve,
        reject,
        onAbort: () => this.cancelWaiter(flight, waiter)
      }
      if (signal) {
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      flight.waiters.add(waiter)
      // Late attach after the core already settled (settled flights are
      // removed from dedupe, but guard for direct internal use).
      if (flight.state === 'settled') {
        this.releaseWaiter(flight, waiter)
      }
    })
  }

  private cancelWaiter(flight: Flight<any>, waiter: Waiter): void {
    if (waiter.cancelled) return
    waiter.cancelled = true
    flight.waiters.delete(waiter)
    if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort)
    waiter.reject(createAbortError('Caller cancelled the wait'))
    // When the LAST waiter leaves: remove queued work immediately, or abort
    // an active operation's owned controller.
    this.maybeAbandon(flight)
  }

  private maybeAbandon(flight: Flight<any>): void {
    if (flight.state === 'settled') return
    if (flight.waiters.size > 0) return
    if (flight.state === 'queued') {
      this.removeQueued(flight)
      this.finishFlight(flight, createAbortError('Queued work removed — no waiters remain'))
    } else {
      // Active: abort the operation's OWN controller (the child runner
      // observes it and terminates the child; slot releases on settle).
      try {
        flight.operation.abort()
      } catch {
        /* already aborted */
      }
    }
  }

  private removeQueued(flight: Flight<any>): void {
    const idx = this.queue.indexOf(flight)
    if (idx >= 0) this.queue.splice(idx, 1)
    if (flight.queueTimer) {
      clearTimeout(flight.queueTimer)
      flight.queueTimer = null
      flight.queueTimerCleared = true
    }
  }

  private enqueue<T>(flight: Flight<T>): void {
    if (this.shuttingDown) {
      this.finishFlight(flight, new QueueFullError('Server is shutting down', 1))
      return
    }
    if (this.active < this.options.activeLimit) {
      this.startFlight(flight)
      return
    }
    if (this.queue.length >= this.options.queueMax) {
      this.totalRejectedFull++
      this.finishFlight(
        flight,
        new QueueFullError(
          'Too many extraction jobs are queued — try again shortly',
          Math.max(1, Math.ceil(this.queue.length / Math.max(1, this.options.activeLimit)))
        )
      )
      return
    }
    flight.state = 'queued'
    flight.queueTimer = setTimeout(() => {
      const idx = this.queue.indexOf(flight)
      if (idx >= 0) this.queue.splice(idx, 1)
      this.totalQueueTimeouts++
      this.finishFlight(flight, new QueueTimeoutError('Extraction queue wait timed out'))
    }, this.options.queueTimeoutMs)
    this.queue.push(flight)
  }

  private startFlight<T>(flight: Flight<T>): void {
    this.active++
    this.totalRuns++
    if (flight.queueTimer) {
      clearTimeout(flight.queueTimer)
      flight.queueTimer = null
      flight.queueTimerCleared = true
    }
    flight.state = 'active'
    Promise.resolve()
      .then(() => flight.task(flight.operation.signal))
      .then(
        (value) => {
          this.active--
          this.finishFlight(flight, undefined, value)
          this.pump()
        },
        (reason) => {
          this.active--
          this.finishFlight(flight, reason)
          this.pump()
        }
      )
  }

  /** Settle a flight's core + every remaining waiter exactly once. */
  private finishFlight<T>(
    flight: Flight<T>,
    error?: unknown,
    value?: T
  ): void {
    if (flight.state === 'settled') return
    flight.state = 'settled'
    // Completion may delete a keyed flight only when the map still points
    // to THIS flight object — an old finalizer must never erase a newer
    // same-key flight.
    if (flight.key) {
      const current = this.flights.get(flight.key)
      if (current === (flight as unknown)) this.flights.delete(flight.key)
    }
    if (error !== undefined) {
      flight.rejectCore(error)
    } else {
      flight.settleCore(value as T)
    }
    for (const waiter of [...flight.waiters]) {
      this.releaseWaiter(flight, waiter)
    }
    flight.waiters.clear()
  }

  private releaseWaiter(flight: Flight<any>, waiter: Waiter): void {
    if (waiter.cancelled) return
    waiter.cancelled = true
    flight.waiters.delete(waiter)
    if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort)
    flight.core.then(
      (value) => waiter.resolve(value),
      (reason) => waiter.reject(reason)
    )
  }

  private pump(): void {
    // Never start new work once shutdown closed admission.
    if (this.shuttingDown) return
    while (this.active < this.options.activeLimit && this.queue.length > 0) {
      const flight = this.queue.shift()
      if (!flight) break
      this.startFlight(flight)
    }
  }

  /**
   * Graceful shutdown: permanently close admission, reject/remove every
   * queued job and clear its timers. Active jobs keep their slots until
   * their actual task settles (shutdown then terminates the children
   * separately and awaits real exits).
   */
  abortQueued(reason = 'Server is shutting down'): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    const queued = this.queue.splice(0)
    for (const flight of queued) {
      if (flight.queueTimer) {
        clearTimeout(flight.queueTimer)
        flight.queueTimer = null
        flight.queueTimerCleared = true
      }
      this.finishFlight(flight, new QueueFullError(reason, 1))
    }
  }
}

/** Shared gate used by every yt-dlp invocation in the process. */
export const ytDlpGate = new ConcurrencyGate({
  activeLimit: 2, // replaced from config once at startup (configure())
  queueMax: 24,
  queueTimeoutMs: 45_000
})
