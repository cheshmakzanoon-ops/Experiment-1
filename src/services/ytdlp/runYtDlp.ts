/**
 * THE centralized yt-dlp executor.
 *
 * Every extraction/search/version call in the process must go through
 * `runYtDlp()` from this module — routes and services never invoke
 * `execFile('yt-dlp', …)` themselves. It provides:
 *
 *   - process args assembled here (socket timeout, retries, `--js-runtimes
 *     node`, optional proxy), not scattered across call sites,
 *   - bounded concurrency + single-flight through ConcurrencyGate,
 *   - subprocess timeouts with graceful SIGTERM → SIGKILL,
 *   - caller-signal cancellation,
 *   - bounded stdout capture,
 *   - failure classification into the explicit YtDlpError taxonomy,
 *   - a global child registry so shutdown can terminate running children.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { config } from '../../config.js'
import { resolveYtDlpCommand, supportsJsRuntimesOption } from './runtime.js'
import { ytDlpGate, QueueFullError, QueueTimeoutError } from './queue.js'
import {
  classifyChildProcessFailure,
  YtDlpError,
  publicMessageFor,
  type YtErrorCategory
} from './errors.js'

export interface RunYtDlpOptions {
  /** Overall process timeout in ms. */
  timeoutMs?: number
  /** Caller cancellation. */
  signal?: AbortSignal
  /** Single-flight / queue key (dedupe identical work). */
  key?: string
  /** Bounded stdout cap (bytes). */
  maxBuffer?: number
  /** Skip the queue entirely (only the readiness version probe may). */
  bypassQueue?: boolean
}

export interface RunYtDlpResult {
  stdout: string
  stderr: string
  command: string
}

/** Children started by this runner (for shutdown). */
const activeChildren = new Set<ChildProcess>()

const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024
const KILL_GRACE_MS = 2000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Default extractor-args built once here (advanced config; never logged). */
function buildBaseArgs(): string[] {
  const args = [
    '--no-warnings',
    '--no-progress',
    '--socket-timeout', String(Math.max(15, Math.round(config.outbound.connectTimeoutMs / 1000))),
    '--retries', '1'
  ]
  if (supportsJsRuntimesOption(config.ytDlpVersion)) {
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

interface SpawnOutcome {
  stdout: string
  stderr: string
}

/** Low-level spawn with timeout/cancellation/caps. Does NOT queue. */
function spawnYtDlpProcess(userArgs: string[], options: RunYtDlpOptions): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve, reject) => {
    const command = resolveYtDlpCommand()
    const args = fullArgs(userArgs)
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
    const timeoutMs = options.timeoutMs ?? config.ytDlpProcessTimeoutMs

    const child = spawn(command, args, {
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    activeChildren.add(child)

    let stdout = ''
    let stderr = ''
    let settled = false
    let stdoutOverflow = false
    let killTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      activeChildren.delete(child)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const onAbort = () => {
      terminateChild(child)
      fail(new YtDlpError('Extraction cancelled', 'unknown', {}))
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      stdout += chunk.toString('utf8')
      if (stdout.length > maxBuffer) {
        stdoutOverflow = true
        terminateChild(child)
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
      fail(classifyChildProcessFailure({ code: (error as NodeJS.ErrnoException).code, message: error.message }))
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      cleanup()

      if (stdoutOverflow) {
        reject(
          new YtDlpError('yt-dlp output exceeded the safety cap', 'malformed_output', { originalError: new Error('maxBuffer exceeded') })
        )
        return
      }

      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      const killedByTimer = signal === 'SIGTERM' || signal === 'SIGKILL'
      const error = killedByTimer
        ? new YtDlpError('yt-dlp process timed out', 'process_timeout', { originalError: new Error(`signal ${signal}`) })
        : classifyChildProcessFailure(
            {
              code: code ?? undefined,
              stderr,
              stdout,
              message: `yt-dlp exited with code ${code}`,
              signal: signal ?? undefined
            },
            stderr.slice(0, 400)
          )
      reject(error)
    })

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    if (timeoutMs > 0) {
      killTimer = setTimeout(() => terminateChild(child), timeoutMs)
    }
  })
}

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGTERM')
  } catch {
    /* already gone */
  }
  // SIGKILL fallback after a short grace period.
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }, KILL_GRACE_MS).unref()
}

/**
 * Run yt-dlp through the bounded gate. This is the single entry point used
 * by extractor/search/readiness code.
 */
export async function runYtDlp(userArgs: string[], options: RunYtDlpOptions = {}): Promise<RunYtDlpResult> {
  const task = async (): Promise<SpawnOutcome> => spawnYtDlpProcess(userArgs, options)
  return runThroughGate(task, options)
}

async function runThroughGate(task: () => Promise<SpawnOutcome>, options: RunYtDlpOptions): Promise<RunYtDlpResult> {

  try {
    if (options.bypassQueue) {
      const outcome = await task()
      return { ...outcome, command: resolveYtDlpCommand() }
    }
    const outcome = await ytDlpGate.run(options.key, task)
    return { ...outcome, command: resolveYtDlpCommand() }
  } catch (error) {
    if (error instanceof YtDlpError) throw error
    if (error instanceof QueueFullError) throw error
    if (error instanceof QueueTimeoutError) throw error
    throw error
  }
}

// ---------------------------------------------------------------------------
// Version probing (cheap, cached, queued so readiness is honest)
// ---------------------------------------------------------------------------

let cachedVersion: string | null | undefined
let versionProbeInFlight: Promise<string | null> | null = null
let versionCheckedAt = 0
const VERSION_CACHE_TTL_MS = 60_000

export async function getYtDlpVersion(force = false): Promise<string | null> {
  if (!force && cachedVersion !== undefined && Date.now() - versionCheckedAt < VERSION_CACHE_TTL_MS) {
    return cachedVersion
  }
  if (versionProbeInFlight) return versionProbeInFlight

  versionProbeInFlight = (async () => {
    try {
      const result = await runYtDlp(['--version'], {
        timeoutMs: 15_000,
        bypassQueue: true,
        key: 'version-probe'
      })
      const version = result.stdout.trim()
      cachedVersion = version || null
      versionCheckedAt = Date.now()
      return cachedVersion
    } catch {
      cachedVersion = null
      versionCheckedAt = Date.now()
      return null
    } finally {
      versionProbeInFlight = null
    }
  })()

  return versionProbeInFlight
}

export interface RuntimeHealth {
  ok: boolean
  version: string | null
  jsRuntime: 'node' | null
  jsRuntimeSupported: boolean
  problem?: 'not_installed' | 'version_too_old' | 'unknown'
}

/** Non-fetching runtime check used by readiness (cheap + cached). */
export async function checkRuntimeHealth(): Promise<RuntimeHealth> {
  const version = await getYtDlpVersion()
  if (!version) {
    return { ok: false, version: null, jsRuntime: null, jsRuntimeSupported: false, problem: 'not_installed' }
  }
  const supported = supportsJsRuntimesOption(version)
  if (!supported) {
    return { ok: false, version, jsRuntime: null, jsRuntimeSupported: false, problem: 'version_too_old' }
  }
  return { ok: true, version, jsRuntime: 'node', jsRuntimeSupported: true }
}

/** Kill every running child (shutdown). */
export function terminateAllChildren(): void {
  for (const child of activeChildren) {
    terminateChild(child)
  }
  activeChildren.clear()
}

/** Re-export for route-level mapping. */
export { YtDlpError, publicMessageFor, type YtErrorCategory }
