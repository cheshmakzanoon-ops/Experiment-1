import { describe, expect, it, vi } from 'vitest'
import {
  classifyYtDlpText,
  classifyChildProcessFailure,
  isPermanentCategory,
  categoryIsRetryable
} from '../src/services/ytdlp/errors'
import { compareYtDlpVersions, supportsJsRuntimesOption } from '../src/services/ytdlp/runtime'
import {
  ConcurrencyGate,
  QueueFullError,
  QueueTimeoutError
} from '../src/services/ytdlp/queue'

function deferred<T = unknown>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('yt-dlp failure classification', () => {
  const cases: Array<[string, string]> = [
    ['ERROR: This video is unavailable', 'video_unavailable'],
    ['HTTP Error 404: Not Found', 'video_unavailable'],
    ['This video is private', 'private'],
    ['Join this channel to get access', 'members_only'],
    ['Sign in to confirm your age', 'age_restricted'],
    ['Video not available in your country', 'geo_restricted'],
    ['This video contains DRM', 'drm'],
    ['is a live stream that cannot be downloaded', 'live_stream'],
    // The audit's headline bug: format-unavailable must NOT become bot/403.
    ['ERROR: Requested format is not available', 'format_unavailable'],
    ['Sign in to confirm you are not a bot', 'bot_detection'],
    ['HTTP Error 429: Too Many Requests', 'rate_limit'],
    ['YouTube said: too many requests, retry later', 'rate_limit'],
    ['HTTP Error 403: Forbidden', 'forbidden'],
    ['ERROR: unable to download webpage: Connection timed out', 'process_timeout'],
    ['getaddrinfo ENOTFOUND youtube.com', 'dns_error'],
    ['ECONNREFUSED while connecting', 'connect_timeout'],
    ['HTTP Error 503: Service Unavailable', 'network_error'],
    ['some novel internal error text', 'unknown']
  ]

  it('maps failure text to the right category', () => {
    for (const [text, expected] of cases) {
      expect(classifyYtDlpText(text), text).toBe(expected)
    }
  })

  it('transient network failures are retryable; true 429/blocks are NOT auto-retried', () => {
    // A genuine YouTube rate limit must not trigger a blind re-extraction
    // storm (the audit's requirement) — it is classified, not retried.
    expect(categoryIsRetryable('rate_limit')).toBe(false)
    expect(categoryIsRetryable('forbidden')).toBe(false)
    expect(categoryIsRetryable('bot_detection')).toBe(false)
    expect(isPermanentCategory('rate_limit')).toBe(true)
    expect(isPermanentCategory('bot_detection')).toBe(true)
    expect(isPermanentCategory('forbidden')).toBe(true)

    expect(categoryIsRetryable('connect_timeout')).toBe(true)
    expect(categoryIsRetryable('dns_error')).toBe(true)
    expect(categoryIsRetryable('process_timeout')).toBe(true)
    expect(categoryIsRetryable('network_error')).toBe(true)
    expect(isPermanentCategory('video_unavailable')).toBe(true)
    expect(isPermanentCategory('format_unavailable')).toBe(true)
    expect(isPermanentCategory('private')).toBe(true)
    expect(isPermanentCategory('geo_restricted')).toBe(true)
    expect(isPermanentCategory('drm')).toBe(true)
  })

  it('classifies a missing executable as runtime_missing (ENOENT)', () => {
    const err = classifyChildProcessFailure({ code: 'ENOENT' as unknown as string, message: 'spawn yt-dlp ENOENT' })
    expect(err.category).toBe('runtime_missing')
  })

  it('never exposes raw stderr to clients through the public message', () => {
    const err = classifyChildProcessFailure({
      stderr: 'HTTP Error 403: Forbidden\ninternal request id: abc-123-secret',
      code: 1
    })
    expect(err.message).not.toContain('abc-123-secret')
    expect(err.category).toBe('forbidden')
  })
})

describe('yt-dlp runtime version checks', () => {
  it('orders dated releases correctly', () => {
    expect(compareYtDlpVersions('2026.08.19', '2025.05.22')).toBeGreaterThan(0)
    expect(compareYtDlpVersions('2025.05.22', '2025.05.22')).toBe(0)
    expect(compareYtDlpVersions('2024.01.01', '2025.05.22')).toBeLessThan(0)
  })

  it('recognizes EJS/js-runtimes support on current builds only', () => {
    expect(supportsJsRuntimesOption('2026.08.19')).toBe(true)
    expect(supportsJsRuntimesOption(null)).toBe(false)
    expect(supportsJsRuntimesOption('2024.01.01')).toBe(false)
  })
})

describe('bounded concurrency gate', () => {
  it('never runs more than activeLimit subprocesses at once', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 2, queueMax: 20, queueTimeoutMs: 5000 })
    let active = 0
    let maxActive = 0
    const tasks = Array.from({ length: 8 }, () =>
      gate.run(undefined, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
      })
    )
    await Promise.all(tasks)
    expect(maxActive).toBe(2)
    const metrics = gate.getMetrics()
    expect(metrics.active).toBe(0)
    expect(metrics.queued).toBe(0)
    expect(metrics.totalRuns).toBe(8)
  })

  it('rejects work beyond the queue max with QueueFullError', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 1, queueMax: 1, queueTimeoutMs: 5000 })
    const first = deferred()
    const running = gate.run(undefined, () => first.promise)
    const queued = gate.run(undefined, async () => 'second')
    await expect(gate.run(undefined, async () => 'third')).rejects.toBeInstanceOf(QueueFullError)
    first.resolve('done')
    await running
    await expect(queued).resolves.toBe('second')
  })

  it('times out jobs that wait too long in the queue', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 1, queueMax: 5, queueTimeoutMs: 60 })
    const first = deferred()
    const running = gate.run(undefined, () => first.promise)
    const waiting = gate.run(undefined, async () => 'late')
    await expect(waiting).rejects.toBeInstanceOf(QueueTimeoutError)
    expect(gate.getMetrics().totalQueueTimeouts).toBe(1)
    first.resolve('done')
    await running
  })

  it('single-flights identical work keys (one task, shared result)', async () => {
    const gate = new ConcurrencyGate({ activeLimit: 2, queueMax: 5, queueTimeoutMs: 5000 })
    const first = deferred<number>()
    const spy = vi.fn(() => first.promise)
    const a = gate.run('video:abc:240', spy)
    const b = gate.run('video:abc:240', spy)
    // The task starts on a microtask; wait for exactly one invocation.
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    first.resolve(42)
    await expect(a).resolves.toBe(42)
    await expect(b).resolves.toBe(42)
    expect(gate.getMetrics().singleFlightSaved).toBeGreaterThanOrEqual(1)
  })
})
