/**
 * Centralized runtime configuration (Freebuff Cloud / Docker / local).
 *
 * All knobs come from environment variables. Secrets (ACCESS_KEY,
 * SESSION_SECRET, YT_PROXY_URL credentials, YT_EXTRACTOR_ARGS, …) are only
 * ever read here and must never be logged, echoed to clients, or placed in
 * query strings.
 *
 * Production (`NODE_ENV=production`) FAILS CLOSED: missing ACCESS_KEY or
 * SESSION_SECRET aborts startup instead of silently serving the private
 * household proxy to anyone who can reach the URL.
 */

import ytdlpVersionInfo from './config/ytdlp-version.json' with { type: 'json' }

export const NODE_VERSION_MIN = 22

/** Default pinned yt-dlp baseline (single source of truth). */
export const DEFAULT_YT_DLP_VERSION: string = ytdlpVersionInfo.defaultVersion

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

export interface AppConfig {
  port: number
  host: string
  nodeEnv: 'production' | 'development' | 'test'

  // ---- Auth / session -----------------------------------------------------
  accessKey: string
  sessionSecret: string
  /** Explicitly disable access control (development only). */
  authDisabled: boolean
  /** Session lifetime for household cookies, in days. */
  sessionTtlDays: number
  /** Only when true is X-Forwarded-For trusted for rate-limit keys. */
  trustProxy: boolean
  /** Auth / login rate limiting. */
  auth: { loginMax: number; loginWindowMs: number }

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

export function readConfig(): AppConfig {
  const nodeEnv = (process.env.NODE_ENV as AppConfig['nodeEnv']) || 'development'
  const sessionSecret = strFromEnv('SESSION_SECRET')
  const accessKey = strFromEnv('ACCESS_KEY')
  // AUTH_DISABLED=true is the only sanctioned way to run without a key.
  const authDisabled = boolFromEnv('AUTH_DISABLED', false)

  return {
    port: intFromEnv('PORT', 3000, 1, 65535),
    host: strFromEnv('HOST', '0.0.0.0'),
    nodeEnv,

    accessKey,
    sessionSecret,
    authDisabled,
    sessionTtlDays: intFromEnv('SESSION_TTL_DAYS', 30, 1, 365),
    trustProxy: boolFromEnv('TRUST_PROXY', false),
    auth: {
      loginMax: intFromEnv('LOGIN_MAX_REQUESTS', 8, 1, 1000),
      loginWindowMs: intFromEnv('LOGIN_WINDOW_MS', 15 * 60 * 1000, 1000)
    },

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

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Validate the environment. In production this is invoked at startup and
 * aborts the process when the private proxy would otherwise run wide open
 * or without a signing secret. Always fails when ACCESS_KEY is set without
 * SESSION_SECRET (a broken half-configuration).
 */
export function assertValidConfig(cfg: AppConfig = config): void {
  const { nodeEnv } = cfg

  if (cfg.nodeEnv !== 'production' && !cfg.authDisabled && cfg.accessKey && !cfg.sessionSecret) {
    throw new ConfigError('ACCESS_KEY requires SESSION_SECRET — configure both or neither.')
  }

  if (cfg.authDisabled) {
    if (nodeEnv === 'production') {
      throw new ConfigError('AUTH_DISABLED=true is not allowed in production.')
    }
    return // explicitly opted-in development mode
  }

  if (nodeEnv === 'production') {
    if (!cfg.accessKey) {
      throw new ConfigError(
        'ACCESS_KEY is not set. Refusing to start in production without access control. ' +
          'Set ACCESS_KEY and SESSION_SECRET, or run in development with AUTH_DISABLED=true.'
      )
    }
    if (!cfg.sessionSecret) {
      throw new ConfigError('SESSION_SECRET is not set. Refusing to start in production.')
    }
    if (cfg.sessionSecret.length < 16) {
      throw new ConfigError('SESSION_SECRET must be at least 16 characters.')
    }
  }

  if (cfg.sessionSecret && cfg.sessionSecret.length < 16) {
    throw new ConfigError('SESSION_SECRET must be at least 16 characters.')
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
