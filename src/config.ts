/**
 * Centralized runtime configuration (Freebuff Cloud / Docker / local).
 *
 * All knobs come from environment variables. Secrets (ACCESS_KEY,
 * SESSION_SECRET, YT_PROXY_URL credentials, YT_EXTRACTOR_ARGS, …) are only
 * ever read here and must never be logged, echoed to clients, or placed in
 * query strings.
 *
 * Authentication FAILS CLOSED in every environment:
 *   - NODE_ENV must be `production`, `development` or `test` (an omitted
 *     value stays `development`, but that never disables authentication),
 *   - AUTH_DISABLED accepts exactly `true` / `false` / absent / empty,
 *   - AUTH_DISABLED=true is permitted ONLY in development/test with HOST
 *     explicitly bound to a loopback literal (127.0.0.1 / ::1) — never in
 *     production and never on a wildcard/network binding,
 *   - otherwise both ACCESS_KEY (≥ 16 characters) and SESSION_SECRET
 *     (≥ 32 UTF-8 bytes) are required, with no partial configurations.
 */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import ytdlpVersionInfo from './config/ytdlp-version.json' with { type: 'json' }

export const NODE_VERSION_MIN = 22

/** Default pinned yt-dlp baseline (single source of truth). */
export const DEFAULT_YT_DLP_VERSION: string = ytdlpVersionInfo.defaultVersion

export const NODE_ENVS = ['production', 'development', 'test'] as const
export type NodeEnv = (typeof NODE_ENVS)[number]

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

// ---------------------------------------------------------------------------
// Small typed helpers
// ---------------------------------------------------------------------------

function boolFromEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return fallback
  return !['0', 'false', 'no', 'off', ''].includes(raw.trim().toLowerCase())
}

function intFromEnv(key: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function strFromEnv(key: string, fallback = ''): string {
  const raw = process.env[key]
  return raw === undefined ? fallback : raw.trim()
}

/** Parse "a,b,c" → array of trimmed non-empty values. */
function listFromEnv(key: string): string[] {
  const raw = process.env[key]
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Strict AUTH_DISABLED parsing — NOT the permissive general boolean helper.
 * After trimming/lowercasing only `true`, `false` or absent/empty are
 * accepted; typo'd values (`flase`, `yesplease`, `disabled`) are rejected
 * instead of being silently coerced.
 */
export function parseAuthDisabledFlag(raw: string | undefined | null): boolean {
  if (raw === undefined || raw === null) return false
  const value = raw.trim().toLowerCase()
  if (value === '') return false
  if (value === 'true') return true
  if (value === 'false') return false
  throw new ConfigError(
    `AUTH_DISABLED has an unrecognized value — use exactly "true" or "false" (or omit it).`
  )
}

/** Accepted environment names only; empty retains the development default. */
export function parseNodeEnv(raw: string | undefined | null): NodeEnv {
  const value = (raw ?? '').trim()
  if (value === '') return 'development'
  if ((NODE_ENVS as readonly string[]).includes(value)) return value as NodeEnv
  throw new ConfigError(
    `NODE_ENV must be one of: ${NODE_ENVS.join(', ')} (got "${value}"). Refusing to start with an unknown environment.`
  )
}

export interface AppConfig {
  port: number
  host: string
  nodeEnv: NodeEnv
  /** Raw NODE_ENV value (validated at startup; empty = development). */
  nodeEnvRaw: string

  // ---- Auth / session -----------------------------------------------------
  accessKey: string
  sessionSecret: string
  /** Explicitly disable access control (development, loopback only). */
  authDisabled: boolean
  /** Session lifetime for household cookies, in days. */
  sessionTtlDays: number
  /** Only when true is X-Forwarded-For trusted for rate-limit keys. */
  trustProxy: boolean
  /** Auth / login rate limiting. */
  auth: { loginMax: number; loginWindowMs: number }
  /** Absolute path of the persistent active-session allowlist document. */
  sessionStorePath: string

  // ---- Rate limiting ------------------------------------------------------
  rateLimit: {
    /** Ordinary metadata/feed calls per window. */
    apiMax: number
    apiWindowMs: number
    /** yt-dlp extraction-triggering calls (low). */
    extractMax: number
    extractWindowMs: number
    /** Diagnostics (extremely low; only when ENABLE_DIAGNOSTICS=true). */
    diagMax: number
    diagWindowMs: number
  }

  // ---- yt-dlp runtime -----------------------------------------------------
  ytDlpVersion: string
  ytDlpPath: string
  ytDlpConcurrency: number
  ytDlpQueueMax: number
  ytDlpQueueTimeoutMs: number
  ytDlpProcessTimeoutMs: number
  /** Advanced: allowed forced player clients (see README). Empty = yt-dlp default behaviour. */
  ytPlayerClients: string[]
  /** Advanced: raw `--extractor-args youtube:…` string. NEVER logged. */
  ytExtractorArgs: string
  /** Operator-controlled outbound proxy for ALL egress traffic. */
  ytProxyUrl: string

  // ---- Outbound HTTP ------------------------------------------------------
  outbound: {
    connectTimeoutMs: number
    readTimeoutMs: number
    maxRedirects: number
    userAgent: string
  }

  // ---- Caches -------------------------------------------------------------
  cache: {
    streamUrlTtlMs: number
    /** Safety margin subtracted from a signed URL `expire` timestamp. */
    streamExpiryMarginMs: number
    searchTtlMs: number
  }

  // ---- Feeds --------------------------------------------------------------
  feed: {
    batchSize: number
    batchTtlMs: number
    homeBatchSize: number
    homeTtlMs: number
  }

  // ---- Features -----------------------------------------------------------
  enableDiagnostics: boolean
  keepaliveEnabled: boolean
  keepaliveIntervalMinutes: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

/**
 * Absolute repository-root-relative session-store path, independent of the
 * shell's working directory. Overridable with SESSION_STORE_PATH.
 */
function defaultSessionStorePath(): string {
  return resolve(REPO_ROOT, '.runtime', 'auth', 'sessions.json')
}

export function readConfig(): AppConfig {
  const nodeEnvRaw = strFromEnv('NODE_ENV')
  const nodeEnv = parseNodeEnv(nodeEnvRaw)
  const sessionSecret = strFromEnv('SESSION_SECRET')
  const accessKey = strFromEnv('ACCESS_KEY')
  // AUTH_DISABLED=true is the only sanctioned way to run without a key, and
  // only on a loopback-bound development/test process (see assertValidConfig).
  const authDisabled = parseAuthDisabledFlag(process.env.AUTH_DISABLED)

  return {
    port: intFromEnv('PORT', 3000, 1, 65535),
    host: strFromEnv('HOST', '0.0.0.0'),
    nodeEnv,
    nodeEnvRaw,

    accessKey,
    sessionSecret,
    authDisabled,
    sessionTtlDays: intFromEnv('SESSION_TTL_DAYS', 30, 1, 365),
    trustProxy: boolFromEnv('TRUST_PROXY', false),
    auth: {
      loginMax: intFromEnv('LOGIN_MAX_REQUESTS', 8, 1, 1000),
      loginWindowMs: intFromEnv('LOGIN_WINDOW_MS', 15 * 60 * 1000, 1000)
    },
    sessionStorePath: strFromEnv('SESSION_STORE_PATH', defaultSessionStorePath()),

    rateLimit: {
      apiMax: intFromEnv('RATE_LIMIT_MAX_REQUESTS', 120, 1, 100000),
      apiWindowMs: intFromEnv('RATE_LIMIT_WINDOW', 60_000, 1000),
      extractMax: intFromEnv('EXTRACT_MAX_REQUESTS', 20, 1, 100000),
      extractWindowMs: intFromEnv('EXTRACT_WINDOW_MS', 60_000, 1000),
      diagMax: intFromEnv('DIAG_MAX_REQUESTS', 4, 1, 100000),
      diagWindowMs: intFromEnv('DIAG_WINDOW_MS', 10 * 60 * 1000, 1000)
    },

    ytDlpVersion: strFromEnv('YT_DLP_VERSION', DEFAULT_YT_DLP_VERSION),
    ytDlpPath: strFromEnv('YT_DLP_PATH'),
    ytDlpConcurrency: intFromEnv('YT_DLP_CONCURRENCY', 2, 1, 16),
    ytDlpQueueMax: intFromEnv('YT_DLP_QUEUE_MAX', 24, 0, 1000),
    ytDlpQueueTimeoutMs: intFromEnv('YT_DLP_QUEUE_TIMEOUT_MS', 45_000, 1000),
    ytDlpProcessTimeoutMs: intFromEnv('YT_DLP_PROCESS_TIMEOUT_MS', 90_000, 5000),
    ytPlayerClients: listFromEnv('YT_PLAYER_CLIENTS'),
    ytExtractorArgs: strFromEnv('YT_EXTRACTOR_ARGS'),
    ytProxyUrl: strFromEnv('YT_PROXY_URL'),

    outbound: {
      connectTimeoutMs: intFromEnv('UPSTREAM_CONNECT_TIMEOUT_MS', 15_000, 1000),
      readTimeoutMs: intFromEnv('UPSTREAM_READ_TIMEOUT_MS', 30_000, 1000),
      maxRedirects: intFromEnv('UPSTREAM_MAX_REDIRECTS', 5, 1, 10),
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    },

    cache: {
      streamUrlTtlMs: intFromEnv('STREAM_CACHE_TTL_MS', 2 * 60 * 60 * 1000, 60_000),
      streamExpiryMarginMs: intFromEnv('STREAM_CACHE_EXPIRY_MARGIN_MS', 5 * 60 * 1000, 0),
      searchTtlMs: intFromEnv('SEARCH_CACHE_TTL_MS', 3 * 60 * 1000, 10_000)
    },

    feed: {
      batchSize: intFromEnv('FEED_BATCH_SIZE', 50, 10, 100),
      batchTtlMs: intFromEnv('FEED_TTL_MS', 20 * 60 * 1000, 60_000),
      homeBatchSize: intFromEnv('HOME_FEED_BATCH_SIZE', 48, 10, 100),
      homeTtlMs: intFromEnv('HOME_FEED_TTL_MS', 15 * 60 * 1000, 60_000)
    },

    enableDiagnostics: boolFromEnv('ENABLE_DIAGNOSTICS', false),
    keepaliveEnabled: boolFromEnv('KEEPALIVE_ENABLED', false),
    keepaliveIntervalMinutes: intFromEnv('KEEPALIVE_INTERVAL_MINUTES', 4, 1, 60),
    logLevel: (strFromEnv('LOG_LEVEL', 'info') as AppConfig['logLevel']) || 'info'
  }
}

export const config: AppConfig = readConfig()

/**
 * Validate the environment in this exact order, before the listening socket
 * is ever bound:
 *   1. NODE_ENV is a recognized environment,
 *   2. the authentication-disable setting is strictly formed,
 *   3. the allowed development exception applies (development/test on an
 *      explicit loopback binding) — otherwise,
 *   4. both credentials are present and strong enough.
 * Partial configurations are rejected in every environment.
 */
export function assertValidConfig(cfg: AppConfig = config): void {
  // 1. Environment name (empty is permitted and stays `development`).
  const rawEnv = cfg.nodeEnvRaw === undefined ? cfg.nodeEnv : cfg.nodeEnvRaw
  const normalizedEnv = (rawEnv ?? '').trim()
  if (normalizedEnv !== '' && !(NODE_ENVS as readonly string[]).includes(normalizedEnv)) {
    throw new ConfigError(
      `NODE_ENV must be one of: ${NODE_ENVS.join(', ')} (got "${normalizedEnv}"). Refusing to start with an unknown environment.`
    )
  }

  // 2. Authentication-disable setting syntax (defensive re-check of the
  // environment; readConfig already parses this strictly).
  if (process.env.AUTH_DISABLED !== undefined) {
    const rawDisabled = String(process.env.AUTH_DISABLED).trim().toLowerCase()
    if (rawDisabled !== '' && rawDisabled !== 'true' && rawDisabled !== 'false') {
      throw new ConfigError(
        `AUTH_DISABLED has an unrecognized value — use exactly "true" or "false" (or omit it).`
      )
    }
  }

  // 3. The ONLY sanctioned way to run without credentials.
  if (cfg.authDisabled) {
    if (cfg.nodeEnv === 'production') {
      throw new ConfigError('AUTH_DISABLED=true is not allowed in production.')
    }
    if (cfg.host !== '127.0.0.1' && cfg.host !== '::1') {
      throw new ConfigError(
        'AUTH_DISABLED=true is allowed only when HOST binds the loopback interface (127.0.0.1 or ::1). ' +
          'Wildcard/network bindings must run with real credentials.'
      )
    }
    return // explicit, loopback-only development mode
  }

  // 4. Fail closed: both credentials are required in EVERY environment.
  const missing: string[] = []
  if (!cfg.accessKey) {
    missing.push('ACCESS_KEY')
  } else if (cfg.accessKey.length < 16) {
    throw new ConfigError('ACCESS_KEY must be at least 16 characters.')
  }
  if (!cfg.sessionSecret) {
    missing.push('SESSION_SECRET')
  } else if (Buffer.byteLength(cfg.sessionSecret, 'utf8') < 32) {
    throw new ConfigError('SESSION_SECRET must be at least 32 UTF-8 bytes.')
  }
  if (missing.length > 0) {
    const joined = missing.join(' and ')
    throw new ConfigError(
      `${joined} ${missing.length > 1 ? 'are' : 'is'} not set — authentication is required and must fail closed. ` +
        `Configure both ACCESS_KEY and SESSION_SECRET before starting.`
    )
  }
}

/** Freebuff hosts only Node 22+ — refuse to boot on an older runtime. */
export function assertNodeVersion(processVersion = process.version): void {
  const major = Number.parseInt(processVersion.replace(/^v/, ''), 10)
  if (!Number.isInteger(major) || major < NODE_VERSION_MIN) {
    throw new ConfigError(
      `Node ${processVersion} detected — this project requires Node ${NODE_VERSION_MIN}+.`
    )
  }
}
