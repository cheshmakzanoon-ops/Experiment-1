/**
 * Centralized configuration loaded from environment variables.
 * All values have sensible defaults that match .env.example.
 */

function intFromEnv(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export interface AppConfig {
  port: number
  host: string
  nodeEnv: string
  cache: {
    videoTtlMs: number
    searchTtlMs: number
    maxVideo: number
    maxSearch: number
  }
  rateLimit: {
    windowMs: number
    maxRequests: number
  }
  video: {
    defaultHeight: number
    maxHeight: number
  }
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  corsOrigin: string
}

export const config: AppConfig = {
  port: intFromEnv('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  cache: {
    videoTtlMs: intFromEnv('CACHE_TTL_VIDEO', 7200000), // 2 hours
    searchTtlMs: intFromEnv('CACHE_TTL_SEARCH', 30000), // 30 seconds
    maxVideo: intFromEnv('CACHE_MAX_VIDEO', 200),
    maxSearch: intFromEnv('CACHE_MAX_SEARCH', 100)
  },
  rateLimit: {
    windowMs: intFromEnv('RATE_LIMIT_WINDOW', 60000),
    maxRequests: intFromEnv('RATE_LIMIT_MAX_REQUESTS', 30)
  },
  video: {
    defaultHeight: intFromEnv('DEFAULT_VIDEO_HEIGHT', 240),
    maxHeight: intFromEnv('MAX_VIDEO_HEIGHT', 480)
  },
  logLevel: (process.env.LOG_LEVEL as AppConfig['logLevel']) || 'info',
  corsOrigin: process.env.CORS_ORIGIN || '*'
}
