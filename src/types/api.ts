import type { SearchResult, VideoMetadata } from './video.js'

/** Standard error body returned by API routes. */
export interface ErrorResponse {
  error: string
  message?: string
}

/** Body returned by GET /api/search. */
export interface SearchResponse {
  query: string
  results: SearchResult[]
  total: number
}

/** Body returned by GET /api/video/:id (stream URL rewritten to the proxy). */
export type VideoInfoResponse = VideoMetadata & {
  streamUrl: string
}

/** Body returned by GET /api/health. */
export interface HealthResponse {
  status: 'ok'
  uptime: number
  timestamp: string
  memory: {
    used: number
    total: number
    rss: number
  }
  node_version: string
}

/** Body returned by GET /api/health/ready. */
export interface ReadinessResponse {
  status: 'ready' | 'not_ready'
  ytDlp: {
    installed: boolean
    version?: string
    error?: string
  }
}
