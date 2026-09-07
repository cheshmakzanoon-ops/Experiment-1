// shutdown.test.ts — Section 10 regression focus.
//
//   First signal: yt-dlp admission closes (queued jobs rejected now, their
//   timers cleared), a runner-level no-new-spawns fence rises (blocking even
//   bypass-queue version probes), and readiness immediately answers 503
//   SHUTTING_DOWN before consulting any cached result. Repeated signals must
//   not duplicate anything. A queued job B must NEVER start when active job
//   A is terminated during shutdown (pump is permanently blocked).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConcurrencyGate, QueueFullError } from '../src/services/ytdlp/queue'

function deferred<T = unknown>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeHold() {
  const d = deferred()
  const task = (signal: AbortSignal) => {
    if (signal.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      return Promise.reject(error)
    }
    signal.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      d.reject(error)
    })
    return d.promise
  }
  return { task, resolve: d.resolve, promise: d.promise }
}

describe('ConcurrencyGate shutdown (abortQueued)', () => {
  it('queued job B never starts when active job A is terminated during shutdown', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 1, queueMax: 5, queueTimeoutMs: 5000 })
    const a = makeHold()
    const b = makeHold()
    let bStarted = 0
    const bTask = (signal: AbortSignal) => {
      bStarted++
      return b.task(signal)
    }

    const active = gate.run('a', a.task)
    const queued = gate.run('b', bTask)
    expect(gate.getMetrics().queued).toBe(1)

    // Shutdown: admission closes and the queued flight is rejected NOW.
    gate.abortQueued('Server is shutting down')
    await expect(queued).rejects.toBeInstanceOf(QueueFullError)
    expect(bStarted).toBe(0) // B never started
    expect(gate.getMetrics().queued).toBe(0)
    expect(gate.getMetrics().closed).toBe(true)
    expect(gate.isShutdown()).toBe(true)

    // A settles; the pump must NOT launch the removed B or anything else.
    a.resolve('done')
    await expect(active).resolves.toBe('done')
    expect(bStarted).toBe(0)
    expect(gate.getMetrics().active).toBe(0)
    expect(gate.getMetrics().queued).toBe(0)
    expect(gate.getMetrics().totalRuns).toBe(1) // only A ever ran
  })

  it('abortQueued is idempotent: repeated calls never duplicate timers or rejections', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 1, queueMax: 5, queueTimeoutMs: 30_000 })
    const a = makeHold()
    const active = gate.run('a', a.task)
    const b = gate.run('b', () => Promise.resolve('x')) // queued behind a
    gate.abortQueued()
    gate.abortQueued() // repeated signal: no-op
    expect(gate.isShutdown()).toBe(true)
    await expect(b).rejects.toBeInstanceOf(QueueFullError)

    // B's queue timer was cleared at shutdown: no timeout path ever fires.
    expect(gate.getMetrics().totalQueueTimeouts).toBe(0)

    a.resolve('done')
    await active
    expect(gate.getMetrics().queued).toBe(0)
  })

  it('admission is permanently closed: new work (keyed or not) rejects without enqueueing', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 2, queueMax: 5, queueTimeoutMs: 5000 })
    const a = makeHold()
    const active = gate.run('k1', a.task)
    await new Promise((r) => setTimeout(r, 5))

    gate.abortQueued()
    const runner = vi.fn(async () => 'never')
    await expect(gate.run('k1', runner)).rejects.toBeInstanceOf(QueueFullError)
    await expect(gate.run(undefined, runner)).rejects.toBeInstanceOf(QueueFullError)
    await expect(gate.run('k2', runner)).rejects.toBeInstanceOf(QueueFullError)
    expect(runner).not.toHaveBeenCalled()
    expect(gate.getMetrics().queued).toBe(0)

    a.resolve('done')
    await active
  })

  it('configure refuses changes while work is active or after shutdown (validated once-at-startup config)', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 1, queueMax: 5, queueTimeoutMs: 5000 })
    const a = makeHold()
    const active = gate.run('cfg', a.task)
    expect(() => gate.configure({ activeLimit: 3, queueMax: 9, queueTimeoutMs: 1000 })).toThrow(/active|queued/)
    a.resolve('done')
    await active
    gate.abortQueued()
    expect(() => gate.configure({ activeLimit: 3, queueMax: 9, queueTimeoutMs: 1000 })).toThrow(/shutdown/)
  })
})

describe('readiness during shutdown', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('GET /api/health/ready answers 503 SHUTTING_DOWN before consulting cached results', async () => {
    // Fresh module registry so shutdown state and the routes share one graph.
    vi.resetModules()
    const state = await import('../src/services/shutdownState.js')
    const { healthRoutes } = await import('../src/routes/healthRoutes.js')

    state.markShuttingDown()
    const res = await healthRoutes.request('/health/ready')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { reason?: string }
    expect(body.reason).toBe('SHUTTING_DOWN')

    // Liveness stays cheap and available during shutdown.
    const live = await healthRoutes.request('/health/live')
    expect(live.status).toBe(200)
    const liveBody = (await live.json()) as { status: string }
    expect(liveBody.status).toBe('ok')
  })
})

describe('runner spawn fence blocks bypass-queue probes', () => {
  afterEach(() => {
    vi.resetModules()
    delete process.env.YT_DLP_PATH
    delete process.env.YT_DLP_VERSION
  })

  it('bypassQueue probes reject with QueueFullError once the fence is up, without spawning', async () => {
    vi.resetModules()
    process.env.YT_DLP_PATH = '/definitely/not/a/real/yt-dlp'
    process.env.YT_DLP_VERSION = '2026.08.19'
    const runner = await import('../src/services/ytdlp/runYtDlp.js')
    // Same fresh registry → same class identity as the runner's queue dep.
    const queue = await import('../src/services/ytdlp/queue.js')

    runner.setSpawnFence(true)
    const before = runner.activeChildCount()
    await expect(
      runner.runYtDlp(['--version'], { bypassQueue: true, timeoutMs: 2000 })
    ).rejects.toBeInstanceOf(queue.QueueFullError)
    expect(runner.activeChildCount()).toBe(before)
    expect(runner.isSpawnFenced()).toBe(true)

    // Direct probing is fenced the same way (never spawns during drain).
    const probeStart = Date.now()
    await expect(runner.probeDetectedVersion(true)).resolves.toBeNull()
    expect(Date.now() - probeStart).toBeLessThan(500)

    runner.setSpawnFence(false)
    expect(runner.isSpawnFenced()).toBe(false)
  })
})
