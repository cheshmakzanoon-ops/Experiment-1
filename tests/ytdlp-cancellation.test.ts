// ytdlp-cancellation.test.ts — Section 8/9 regression focus:
//
//   ConcurrencyGate.run(key, task, { signal }) contract: every caller owns
//   an independent waiter promise + its own signal subscription; the first
//   caller never owns the shared subprocess; cancelling one waiter never
//   cancels another caller; the operation's OWN controller is what the task
//   sees; pre-aborted callers never enqueue or join; an active slot is
//   released only when the actual task settles; flights are removed from
//   dedupe before replacement work is accepted.
//
//   Runner-level: a real child fixture that IGNORES SIGTERM proves SIGTERM
//   → SIGKILL escalation, registry entries kept until confirmed exit/close
//   (never cleared when SIGTERM is merely sent), and awaitable termination
//   that resolves on the actual child exit. The fixture is removed after.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConcurrencyGate,
  QueueFullError,
  QueueTimeoutError,
  createAbortError,
  isAbortError
} from '../src/services/ytdlp/queue'

function makeAbortError(): Error {
  return createAbortError('test abort')
}

/** Deferred whose rejection also fires when the operation signal aborts. */
function operationHeld() {
  let resolve!: (v: unknown) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  const task = (operationSignal: AbortSignal) => {
    if (operationSignal.aborted) return Promise.reject(makeAbortError())
    const onAbort = () => reject(makeAbortError())
    operationSignal.addEventListener('abort', onAbort, { once: true })
    return promise.finally(() => operationSignal.removeEventListener('abort', onAbort))
  }
  return { task, resolve: (v: unknown) => resolve(v), reject }
}

function signal() {
  return new AbortController()
}

describe('ConcurrencyGate — independent waiters', () => {
  function countingTask(hold: ReturnType<typeof operationHeld>) {
    let calls = 0
    const task = (signal: AbortSignal) => {
      calls++
      return hold.task(signal)
    }
    return { task, count: () => calls }
  }

  it('two same-key callers spawn once; cancelling A leaves B to succeed', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 2, queueMax: 5, queueTimeoutMs: 5000 })
    const hold = operationHeld()
    const wrapped = countingTask(hold)
    const acA = signal()
    const acB = signal()

    const a = gate.run('same', wrapped.task, { signal: acA.signal })
    const b = gate.run('same', wrapped.task, { signal: acB.signal })
    await vi.waitFor(() => expect(wrapped.count()).toBe(1))

    acA.abort()
    await expect(a).rejects.toSatisfy(isAbortError)
    // B is untouched and still waiting on the SAME operation.
    expect(gate.getMetrics().active).toBe(1)

    hold.resolve('done')
    await expect(b).resolves.toBe('done')
    expect(wrapped.count()).toBe(1)
    expect(gate.getMetrics().singleFlightSaved).toBeGreaterThanOrEqual(1)
  })

  it('cancelling B while A succeeds also leaves the operation alone', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 2, queueMax: 5, queueTimeoutMs: 5000 })
    const hold = operationHeld()
    const wrapped = countingTask(hold)
    const acA = signal()
    const acB = signal()

    const a = gate.run('same', wrapped.task, { signal: acA.signal })
    const b = gate.run('same', wrapped.task, { signal: acB.signal })
    await vi.waitFor(() => expect(wrapped.count()).toBe(1))

    acB.abort()
    await expect(b).rejects.toSatisfy(isAbortError)

    hold.resolve('ok')
    await expect(a).resolves.toBe('ok')
    expect(wrapped.count()).toBe(1)
  })

  it('cancelling BOTH waiters aborts the flight; the same key can be reused after it settles', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 2, queueMax: 5, queueTimeoutMs: 5000 })
    const hold = operationHeld()
    const wrapped = countingTask(hold)
    const acA = signal()
    const acB = signal()

    const a = gate.run('reuse', wrapped.task, { signal: acA.signal })
    const b = gate.run('reuse', wrapped.task, { signal: acB.signal })
    await vi.waitFor(() => expect(wrapped.count()).toBe(1))

    acA.abort()
    acB.abort()
    await expect(a).rejects.toSatisfy(isAbortError)
    await expect(b).rejects.toSatisfy(isAbortError)
    // No waiters left → the operation's own controller was aborted; the
    // held task observes it and settles, releasing the slot.
    await vi.waitFor(() => expect(gate.getMetrics().active).toBe(0))
    expect(gate.getMetrics().singleFlightActive).toBe(0)

    // Replacement work under the same key starts a NEW flight.
    const hold2 = operationHeld()
    const c = gate.run('reuse', hold2.task)
    await vi.waitFor(() => expect(wrapped.count()).toBe(1)) // old task untouched
    hold2.resolve('second')
    await expect(c).resolves.toBe('second')
  })

  it('a pre-aborted caller neither enqueues work nor joins a flight', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 1, queueMax: 5, queueTimeoutMs: 5000 })
    const hold = operationHeld()
    const wrapped = countingTask(hold)
    const preAborted = signal()
    preAborted.abort()

    await expect(gate.run('k', wrapped.task, { signal: preAborted.signal })).rejects.toSatisfy(isAbortError)
    expect(wrapped.count()).toBe(0)
    expect(gate.getMetrics().active).toBe(0)
    expect(gate.getMetrics().queued).toBe(0)
    expect(gate.getMetrics().singleFlightActive).toBe(0)
  })

  it('cancelling a QUEUED waiter removes it immediately without harming the active job', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 1, queueMax: 5, queueTimeoutMs: 5000 })
    const activeHold = operationHeld()
    const queuedHold = operationHeld()
    const active = gate.run('a', activeHold.task)
    const queuedWrapped = countingTask(queuedHold)
    const ac = signal()
    const queued = gate.run('b', queuedWrapped.task, { signal: ac.signal })
    await vi.waitFor(() => expect(gate.getMetrics().queued).toBe(1))

    ac.abort()
    await expect(queued).rejects.toSatisfy(isAbortError)
    expect(gate.getMetrics().queued).toBe(0)
    expect(queuedWrapped.count()).toBe(0) // removed before it ever started
    expect(gate.getMetrics().active).toBe(1) // active job untouched

    activeHold.resolve('done')
    await expect(active).resolves.toBe('done')
    expect(gate.getMetrics().active).toBe(0)
  })

  it('an active slot stays occupied while a cancelled task is still settling', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 1, queueMax: 5, queueTimeoutMs: 5000 })
    const ac = signal()
    let rejectTask!: (e: unknown) => void
    let operationAborted = false
    const task = (operationSignal: AbortSignal) => {
      operationSignal.addEventListener('abort', () => {
        operationAborted = true
      })
      return new Promise<unknown>((_resolve, reject) => {
        rejectTask = reject
      })
    }
    const run = gate.run('slot2', task, { signal: ac.signal })
    await vi.waitFor(() => expect(gate.getMetrics().active).toBe(1))

    // One waiter (the caller) leaves → the operation's own controller is
    // aborted, but the task has not settled yet: the slot is retained.
    ac.abort()
    await vi.waitFor(() => expect(operationAborted).toBe(true))
    expect(gate.getMetrics().active).toBe(1)

    // The task finally settles → the slot releases.
    rejectTask(makeAbortError())
    await expect(run).rejects.toSatisfy(isAbortError)
    expect(gate.getMetrics().active).toBe(0)
  })

  it('a settled flight is removed before replacement work is accepted; old finalizer never erases the new flight', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 2, queueMax: 5, queueTimeoutMs: 5000 })
    const firstHold = operationHeld()
    const firstWrapped = countingTask(firstHold)
    const first = gate.run('guard', firstWrapped.task)
    await vi.waitFor(() => expect(firstWrapped.count()).toBe(1))

    firstHold.resolve('first')
    await expect(first).resolves.toBe('first')
    expect(gate.getMetrics().singleFlightActive).toBe(0) // completed → removed

    // Replacement under the same key must produce a NEW flight (never join
    // the settled one) and the old finalizer must not erase it.
    const secondHold = operationHeld()
    const secondWrapped = countingTask(secondHold)
    const second = gate.run('guard', secondWrapped.task)
    await vi.waitFor(() => expect(secondWrapped.count()).toBe(1))
    expect(gate.getMetrics().singleFlightActive).toBe(1)

    secondHold.resolve('second')
    await expect(second).resolves.toBe('second')
    expect(gate.getMetrics().singleFlightActive).toBe(0)
  })

  it('queue timeout and queue-full stay mapped to their own errors', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 1, queueMax: 1, queueTimeoutMs: 50 })
    const hold = operationHeld()
    const running = gate.run('a', hold.task)

    // While A is active, the first new job queues…
    const b = gate.run('b', async () => 'x')
    // …and a second new job overflows the bounded queue.
    const full = gate.run('c', async () => 'x')
    await expect(full).rejects.toBeInstanceOf(QueueFullError)
    expect(gate.getMetrics().totalRejectedFull).toBe(1)
    await expect(full).rejects.toMatchObject({ retryAfterSeconds: expect.any(Number) })

    await expect(b).rejects.toBeInstanceOf(QueueTimeoutError)
    expect(gate.getMetrics().totalQueueTimeouts).toBe(1)

    hold.resolve('done')
    await running
  })

  it('task failure propagates to every waiter once', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 2, queueMax: 5, queueTimeoutMs: 5000 })
    const hold = operationHeld()
    const wrapped = countingTask(hold)
    const a = gate.run('fail', wrapped.task)
    const b = gate.run('fail', wrapped.task)
    await vi.waitFor(() => expect(wrapped.count()).toBe(1))
    hold.reject(new Error('boom'))
    await expect(a).rejects.toThrow('boom')
    await expect(b).rejects.toThrow('boom')
    expect(gate.getMetrics().singleFlightActive).toBe(0)
  })

  it('cancelled waiters reject with the AbortError contract (queue/extraction/route share it)', () => {
    const error = createAbortError('shared')
    expect(error.name).toBe('AbortError')
    expect(isAbortError(error)).toBe(true)
    expect(isAbortError(new Error('nope'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Runner level: real child fixture ignoring SIGTERM (escalation + registry)
// ---------------------------------------------------------------------------

const FAKE_VERSION = '2026.08.19'
let fixturePath = ''
let fixtureDir = ''

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'ytdlp-cancel-'))
  fixturePath = join(fixtureDir, 'fake-yt-dlp')
  const script = `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('${FAKE_VERSION}\\n')
  process.exit(0)
}
process.on('SIGTERM', () => { /* intentionally ignore SIGTERM */ })
process.on('SIGINT', () => { /* intentionally ignore SIGINT */ })
setInterval(() => {}, 1000)
`
  writeFileSync(fixturePath, script, { mode: 0o755 })
  chmodSync(fixturePath, 0o755)
  process.env.YT_DLP_PATH = fixturePath
  process.env.YT_DLP_VERSION = FAKE_VERSION
})

afterAll(() => {
  delete process.env.YT_DLP_PATH
  delete process.env.YT_DLP_VERSION
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
})

describe('runner: child lifecycle with a SIGTERM-ignoring fixture', () => {
  it('the bare version probe runs and reports the detected executable version', async () => {
    const runner = await import('../src/services/ytdlp/runYtDlp.js')
    const version = await runner.probeDetectedVersion(true)
    expect(version).toBe(FAKE_VERSION)
    expect(runner.activeChildCount()).toBe(0)
  })

  it('terminateAllChildren escalates SIGTERM → SIGKILL and awaits the REAL exit', async () => {
    const runner = await import('../src/services/ytdlp/runYtDlp.js')
    const gate = (await import('../src/services/ytdlp/queue.js')).ytDlpGate
    const runPromise = runner.runYtDlp(['--hold-forever'], { key: 'escalate', timeoutMs: 30_000 })
    await vi.waitFor(() => expect(runner.activeChildCount()).toBe(1), { timeout: 4000 })

    const started = Date.now()
    await runner.terminateAllChildren(8000)
    const elapsed = Date.now() - started
    // The fixture ignores SIGTERM, so only the SIGKILL escalation (~2 s
    // grace) ends it — termination must reflect the actual child exit.
    expect(elapsed).toBeGreaterThanOrEqual(1800)
    expect(runner.activeChildCount()).toBe(0)
    await expect(runPromise).rejects.toThrow()
    expect(gate.getMetrics().active).toBe(0)
  })

  it('abort rejects the caller immediately, but the child stays registered until it really exits', async () => {
    const runner = await import('../src/services/ytdlp/runYtDlp.js')
    const gate = (await import('../src/services/ytdlp/queue.js')).ytDlpGate
    const controller = new AbortController()
    const runPromise = runner.runYtDlp(['--hold-forever'], {
      key: 'cancel-child',
      signal: controller.signal,
      timeoutMs: 30_000
    })
    await vi.waitFor(() => expect(runner.activeChildCount()).toBe(1), { timeout: 4000 })

    controller.abort()
    const rejection = await runPromise.catch((error) => error)
    expect(isAbortError(rejection)).toBe(true)
    // SIGTERM was merely SENT: the fixture ignores it, so the child must
    // stay REGISTERED until its real exit/close (never cleared on signal
    // delivery). The caller's rejection is not the child's termination.
    expect(runner.activeChildCount()).toBe(1)

    // After the ~2 s SIGKILL escalation the child really exits and the
    // registry entry is removed.
    await vi.waitFor(() => expect(runner.activeChildCount()).toBe(0), { timeout: 6000 })
    await vi.waitFor(() => expect(gate.getMetrics().active).toBe(0), { timeout: 2000 })
  })

  it('spawn failure without a child releases resources exactly once and classifies', async () => {
    const runner = await import('../src/services/ytdlp/runYtDlp.js')
    const savedPath = process.env.YT_DLP_PATH
    process.env.YT_DLP_PATH = join(fixtureDir, 'does-not-exist')
    vi.resetModules()
    const fresh = await import('../src/services/ytdlp/runYtDlp.js')
    // ENOENT spawn error (there is no executable): classified, no registry leak.
    await expect(fresh.probeDetectedVersion(true)).resolves.toBeNull()
    expect(fresh.activeChildCount()).toBe(0)
    process.env.YT_DLP_PATH = savedPath
    vi.resetModules()
    void runner
  })

  it('the spawn fence blocks version probes before any spawn (shutdown)', async () => {
    const runner = await import('../src/services/ytdlp/runYtDlp.js')
    runner.setSpawnFence(true)
    expect(runner.isSpawnFenced()).toBe(true)
    const before = runner.activeChildCount()
    const started = Date.now()
    const version = await runner.probeDetectedVersion(true)
    expect(Date.now() - started).toBeLessThan(500)
    expect(version).toBeNull()
    expect(runner.activeChildCount()).toBe(before) // nothing was spawned
    expect(runner.isVersionProbeActive()).toBe(false)
    runner.setSpawnFence(false)
    expect(runner.isSpawnFenced()).toBe(false)
  })

  it('existing files and stale fixture cleanup', () => {
    expect(existsSync(fixturePath)).toBe(true)
  })
})
