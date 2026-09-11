/**
 * THE centralized yt-dlp executor.
 *
 * Every extraction/search/version call in the process must go through
 * `runYtDlp()` from this module — routes and services never invoke
 * `execFile('yt-dlp', …)` themselves. It provides:
 *
 *   - process args assembled here (socket timeout, retries, `--js-runtimes
 *     node` when the DETECTED executable supports it, optional proxy),
 *   - bounded concurrency + single-flight through ConcurrencyGate,
 *   - subprocess timeouts with graceful SIGTERM → SIGKILL escalation,
 *   - caller-signal cancellation through the gate's waiter model: the
 *     caller's signal is only a *subscription*; the underlying operation
 *     owns its controller and subprocess,
 *   - bounded stdout capture,
 *   - failure classification into the explicit YtDlpError taxonomy,
 *   - a global child registry so shutdown can terminate running children
 *     and AWAIT their actual exit.
 *
 * Cancellation contract: an aborted extraction rejects with an AbortError
 * (name === 'AbortError', see queue.ts) and is NON-retryable — it is never
 * an unknown error that triggers another extraction attempt.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { config } from '../../config.js'
import {
  resolveYtDlpCommand,
  supportsJsRuntimesOption,
  runtimeBinaryPath
} from './runtime.js'
import {
  ytDlpGate,
  QueueFullError,
  QueueTimeoutError,
  createAbortError,
  isAbortError
} from './queue.js'
import {
  classifyChildProcessFailure,
  YtDlpError,
  publicMessageFor,
  type YtErrorCategory
} from './errors.js'

export interface RunYtDlpOptions {
  /** Overall process timeout in ms. */
  timeoutMs?: number
  /** Caller cancellation (subscription only — the gate owns the signal). */
  signal?: AbortSignal
  /** Single-flight / queue key (dedupe identical work). */
  key?: string
  /** Bounded stdout cap (bytes). */
  maxBuffer?: number
  /** Skip the queue entirely (only the separately deduped version probe). */
  bypassQueue?: boolean
}

export interface RunYtDlpResult {
  stdout: string
  stderr: string
  command: string
}

const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024
const KILL_GRACE_MS = 2000

// ---------------------------------------------------------------------------
// Child lifecycle registry (shutdown awaits REAL exits)
// ---------------------------------------------------------------------------

interface ChildRecord {
  child: ChildProcess
  /** Resolves when the child has actually exited/closed (or failed to spawn). */
  terminated: Promise<void>
  resolveTerminated: () => void
  /** Escalation timer (SIGKILL after SIGTERM grace) — one per child. */
  escalationTimer: ReturnType<typeof setTimeout> | null
}

const activeChildren = new Map<ChildProcess, ChildRecord>()

function registerChild(child: ChildProcess): ChildRecord {
  let resolveTerminated!: () => void
  const terminated = new Promise<void>((resolve) => {
    resolveTerminated = resolve
  })
  const record: ChildRecord = { child, terminated, resolveTerminated, escalationTimer: null }
  activeChildren.set(child, record)
  return record
}

/** Number of children still registered (tests assert real max live children). */
export function activeChildCount(): number {
  return activeChildren.size
}

/** Awaitable termination of every running child. No-op when none run. */
export async function terminateAllChildren(timeoutMs = 8000): Promise<void> {
  const records = [...activeChildren.values()]
  if (records.length === 0) return
  const deadline = Date.now() + timeoutMs
  for (const record of records) {
    terminateChild(record)
  }
  await Promise.all(
    records.map((record) =>
      Promise.race([
        record.terminated,
        new Promise<void>((resolve) => {
          const remaining = deadline - Date.now()
          setTimeout(resolve, Math.max(1, remaining)).unref?.()
        })
      ])
    )
  )
}

/**
 * Send SIGTERM once and schedule exactly one SIGKILL escalation after the
 * two-second grace. The registry is NOT cleared when SIGTERM is merely sent
 * — entries stay until confirmed exit/close.
 */
function terminateChild(record: ChildRecord): void {
  const { child } = record
  if (child.exitCode !== null || child.signalCode !== null) return
  if (record.escalationTimer) return // already terminating
  try {
    child.kill('SIGTERM')
  } catch {
    /* already gone */
  }
  record.escalationTimer = setTimeout(() => {
    record.escalationTimer = null
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }, KILL_GRACE_MS)
  record.escalationTimer.unref?.()
}

// ---------------------------------------------------------------------------
// No-new-spawns fence (shutdown). Blocks bypass probes too.
// ---------------------------------------------------------------------------

let spawnFence = false

/** Close admission at the runner level (index.ts calls this on SIGTERM). */
export function setSpawnFence(enabled: boolean): void {
  spawnFence = enabled
}

export function isSpawnFenced(): boolean {
  return spawnFence
}

// ---------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------

/**
 * Detected executable version (bare `--version` probe result), cached and
 * deduplicated at one in-flight probe. Distinct from the requested/pinned
 * config version — `--js-runtimes` support derives from THIS value.
 */
let detectedVersion: string | null | undefined
let versionProbeInFlight: Promise<string | null> | null = null
let versionCheckedAt = 0
const VERSION_CACHE_TTL_MS = 60_000

/** Default extractor-args built once here (advanced config; never logged). */
function buildBaseArgs(): string[] {
  const args = [
    '--no-warnings',
    '--no-progress',
    '--socket-timeout', String(Math.max(15, Math.round(config.outbound.connectTimeoutMs / 1000))),
    '--retries', '1'
  ]
  if (supportsJsRuntimesOption(detectedVersion ?? null)) {
    args.push('--js-runtimes', 'node')
  }
  return args
}

/** Player clients must come from the safe allowlist (advanced config). */
const ALLOWED_PLAYER_CLIENTS = new Set([
  'default',
  'web',
  'web_safari',
  'web_embedded',
  'web_music',
  'web_creator',
  'tv',
  'tv_embedded',
  'mweb',
  'android',
  'ios'
])

/**
 * Centralized `--extractor-args youtube:…` value.
 * Advanced, operator-controlled and secret-capable; used verbatim and never
 * logged. Returns undefined when nothing is configured (yt-dlp defaults).
 */
export function buildExtractorArgsValue(): string | undefined {
  if (config.ytExtractorArgs) return config.ytExtractorArgs
  const clients = config.ytPlayerClients.filter((c) => ALLOWED_PLAYER_CLIENTS.has(c))
  if (clients.length > 0) return `player_client=${clients.join(',')}`
  return undefined
}

/** Environment for the child: same as parent plus optional proxy. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (config.ytProxyUrl) {
    // yt-dlp honours these (and --proxy below); consistent with media traffic.
    env.HTTP_PROXY = config.ytProxyUrl
    env.HTTPS_PROXY = config.ytProxyUrl
    env.ALL_PROXY = config.ytProxyUrl
    env.http_proxy = config.ytProxyUrl
    env.https_proxy = config.ytProxyUrl
    env.all_proxy = config.ytProxyUrl
  }
  return env
}

function fullArgs(userArgs: string[]): string[] {
  const base = buildBaseArgs()
  const extractor = buildExtractorArgsValue()
  if (extractor) {
    return [...base, '--extractor-args', `youtube:${extractor}`, ...userArgs]
  }
  return [...base, ...userArgs]
}

// ---------------------------------------------------------------------------
// Low-level spawn (timeout/cancellation/caps). Does NOT queue.
// ---------------------------------------------------------------------------

interface SpawnOutcome {
  stdout: string
  stderr: string
}

interface SpawnOptions {
  signal?: AbortSignal
  timeoutMs: number
  maxBuffer: number
  /** Bare `--version` probe: no base/extractor args at all. */
  bare?: boolean
}

function spawnYtDlpProcess(userArgs: string[], options: SpawnOptions): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve, reject) => {
    const command = resolveYtDlpCommand()
    const args = options.bare ? userArgs : fullArgs(userArgs)
    const maxBuffer = options.maxBuffer
    const timeoutMs = options.timeoutMs

    if (spawnFence) {
      reject(new QueueFullError('Server is shutting down', 1))
      return
    }
    // Reject an already-aborted operation BEFORE spawning a process.
    if (options.signal?.aborted) {
      reject(createAbortError('Extraction cancelled'))
      return
    }

    let child: ChildProcess
    try {
      child = spawn(command, args, {
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(classifyChildProcessFailure({ code: (error as NodeJS.ErrnoException).code, message: (error as Error).message }))
      return
    }

    const record = registerChild(child)

    let stdout = ''
    let stderr = ''
    let settled = false
    let cleaned = false
    let stdoutOverflow = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    /** Bounded accumulation (A04): once the cap is hit, chunks are counted, not stored. */
    let overflowDroppedBytes = 0

    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      activeChildren.delete(child)
      if (record.escalationTimer) {
        clearTimeout(record.escalationTimer)
        record.escalationTimer = null
      }
      if (killTimer) {
        clearTimeout(killTimer)
        killTimer = null
      }
      options.signal?.removeEventListener('abort', onAbort)
      record.resolveTerminated()
    }

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }

    const onAbort = () => {
      // Caller/operation cancellation: terminate the child, then report the
      // abort. Child-registry cleanup happens on confirmed close below.
      terminateChild(record)
      fail(createAbortError('Extraction cancelled'))
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      if (stdoutOverflow) {
        // Post-cap accounting only (A04): never append while waiting for the
        // terminated child to exit, or an oversized-output child that
        // ignores SIGTERM can still drain unbounded memory into `stdout`.
        overflowDroppedBytes += chunk.byteLength
        if (overflowDroppedBytes > maxBuffer) {
          terminateChild(record)
          killTimer = setTimeout(() => terminateChild(record), 1000)
          killTimer.unref?.()
        }
        return
      }
      stdout += chunk.toString('utf8')
      if (stdout.length > maxBuffer) {
        stdoutOverflow = true
        stdout = ''
        terminateChild(record)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return
      stderr += chunk.toString('utf8')
      if (stderr.length > 2 * 1024 * 1024) {
        stderr = stderr.slice(stderr.length - 2 * 1024 * 1024)
      }
    })

    child.on('error', (error) => {
      // Spawn failure without a live child: release resources exactly once.
      cleanup()
      fail(
        classifyChildProcessFailure({
          code: (error as NodeJS.ErrnoException).code,
          message: error.message
        })
      )
    })

    child.on('close', (code, signal) => {
      cleanup()
      if (settled) return
      settled = true

      if (stdoutOverflow) {
        reject(
          new YtDlpError('yt-dlp output exceeded the safety cap', 'malformed_output', {
            originalError: new Error('maxBuffer exceeded')
          })
        )
        return
      }

      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      // Signal-terminated child (timeout/abort/overflow escalation): the
      // specific outcome was already reported for abort; a timeout is the
      // remaining signal case.
      if (code === null) {
        reject(new YtDlpError('yt-dlp process timed out', 'process_timeout', {
          originalError: new Error(`terminated by ${signal ?? 'unknown'}`)
        }))
        return
      }

      reject(
        classifyChildProcessFailure(
          {
            code: code ?? undefined,
            stderr,
            stdout,
            message: `yt-dlp exited with code ${code}`,
            signal: signal ?? undefined
          },
          stderr.slice(0, 400)
        )
      )
    })

    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    if (timeoutMs > 0) {
      killTimer = setTimeout(() => terminateChild(record), timeoutMs)
    }
  })
}

// ---------------------------------------------------------------------------
// Version probing (bare `--version`, cached, deduped at one)
// ---------------------------------------------------------------------------

/**
 * Probe the RESOLVED executable with a bare `--version` (no base/extractor
 * args). Separately deduplicated at one in-flight probe and blocked by the
 * shutdown fence. Never constructs extraction arguments (no recursion).
 */
export async function probeDetectedVersion(force = false): Promise<string | null> {
  if (!force && detectedVersion !== undefined && Date.now() - versionCheckedAt < VERSION_CACHE_TTL_MS) {
    return detectedVersion
  }
  if (versionProbeInFlight) return versionProbeInFlight

  versionProbeInFlight = (async () => {
    try {
      const outcome = await spawnYtDlpProcess(['--version'], {
        timeoutMs: 15_000,
        maxBuffer: 64 * 1024,
        bare: true
      })
      detectedVersion = outcome.stdout.trim() || null
      versionCheckedAt = Date.now()
    } catch {
      detectedVersion = null
      versionCheckedAt = Date.now()
    } finally {
      versionProbeInFlight = null
    }
    return detectedVersion
  })()

  return versionProbeInFlight
}

/** True once a version probe is running (metrics/readiness transparency). */
export function isVersionProbeActive(): boolean {
  return versionProbeInFlight !== null
}

/** Alias kept for diagnostics/readiness: version of the resolved executable. */
export async function getYtDlpVersion(force = false): Promise<string | null> {
  return probeDetectedVersion(force)
}

// ---------------------------------------------------------------------------
// Gate integration
// ---------------------------------------------------------------------------

/**
 * Run yt-dlp through the bounded gate. The caller's `options.signal` is
 * passed to the gate ONLY as a subscription; the underlying task runs with
 * the operation-owned signal, which is what the child runner observes.
 */
export async function runYtDlp(
  userArgs: string[],
  options: RunYtDlpOptions = {}
): Promise<RunYtDlpResult> {
  const command = resolveYtDlpCommand()
  const task = (operationSignal: AbortSignal): Promise<SpawnOutcome> =>
    spawnYtDlpProcess(userArgs, {
      signal: operationSignal,
      timeoutMs: options.timeoutMs ?? config.ytDlpProcessTimeoutMs,
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER
    })

  try {
    if (options.bypassQueue) {
      // Only the separately deduped version probe may bypass the queue; it
      // still gets its own operation controller wired to the caller signal.
      const outcome = await runBypass(task, options.signal)
      return { ...outcome, command }
    }
    const outcome = await ytDlpGate.run(options.key, task, { signal: options.signal })
    return { ...outcome, command }
  } catch (error) {
    if (error instanceof YtDlpError) throw error
    if (error instanceof QueueFullError) throw error
    if (error instanceof QueueTimeoutError) throw error
    if (isAbortError(error)) throw error
    throw error
  }
}

/** Bypass execution with a private operation controller (version probe). */
async function runBypass(
  task: (signal: AbortSignal) => Promise<SpawnOutcome>,
  callerSignal?: AbortSignal
): Promise<SpawnOutcome> {
  if (callerSignal?.aborted) throw createAbortError('Caller aborted before the operation started')
  const operation = new AbortController()
  const onAbort = () => operation.abort()
  callerSignal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await task(operation.signal)
  } finally {
    callerSignal?.removeEventListener('abort', onAbort)
  }
}

// ---------------------------------------------------------------------------
// Readiness helpers
// ---------------------------------------------------------------------------

export interface RuntimeHealth {
  ok: boolean
  version: string | null
  jsRuntime: 'node' | null
  jsRuntimeSupported: boolean
  problem?: 'not_installed' | 'version_too_old' | 'version_mismatch' | 'unknown'
}

/** Non-fetching runtime check used by readiness (cheap + cached). */
export async function checkRuntimeHealth(): Promise<RuntimeHealth> {
  const version = await probeDetectedVersion()
  if (!version) {
    return { ok: false, version: null, jsRuntime: null, jsRuntimeSupported: false, problem: 'not_installed' }
  }
  const supported = supportsJsRuntimesOption(version)
  if (!supported) {
    return { ok: false, version, jsRuntime: null, jsRuntimeSupported: false, problem: 'version_too_old' }
  }
  return { ok: true, version, jsRuntime: 'node', jsRuntimeSupported: true }
}

/**
 * Resolve the command the runner will spawn. Managed mode: the repository
 * local binary (verified by ensure-runtime.mjs before production work).
 * Explicit mode: the operator's absolute YT_DLP_PATH. Never an unverified
 * PATH fallback.
 */
export function resolvedCommandPath(): string {
  if (config.ytDlpPath) return config.ytDlpPath
  return runtimeBinaryPath()
}

/** Re-export for route-level mapping. */
export { YtDlpError, publicMessageFor, type YtErrorCategory }
