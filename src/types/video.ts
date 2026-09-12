export interface VideoMetadata {
  id: string
  title: string
  description: string
  duration: number // in seconds
  thumbnail: string
  author: string
  authorId: string
  viewCount: number
  uploadDate: string
  streamUrl?: string
  formats?: VideoFormat[]
  // ---- R2 additive playback-truth metadata (never removes old fields) ----
  /** Quality the viewer asked for, e.g. "240p". */
  requestedQuality?: string
  /** Quality actually selected by the server (hard-capped by requested). */
  actualQuality?: string
  hasAudio?: boolean
  hasVideo?: boolean
  mimeType?: string
  codecs?: { video?: string; audio?: string }
  /** Genuinely selectable combined qualities for this video. */
  availableQualities?: Array<{ height?: number; label: string; mimeType: string; formatId?: string }>
  /** Stabilized reason this representation was chosen. */
  selectionReason?: string
}

export interface VideoFormat {
  quality: string
  url: string
  mimeType: string
  filesize?: number
  hasAudio: boolean
  hasVideo: boolean
  /** Actual stream height (when yt-dlp reported one). */
  height?: number
  width?: number
  formatId?: string
  ext?: string
  /** Raw codec identifiers (R1: explicit, never guessed). */
  vcodec?: string
  acodec?: string
}

export interface SearchResult {
  id: string
  title: string
  duration: number
  thumbnail: string
  author: string
  viewCount: number
  publishedText: string
}

export interface StreamResponse {
  url: string
  quality: string
  mimeType: string
  filesize?: number
}

export interface CachedVideo extends VideoMetadata {
  cachedAt: number
  expiresAt: number
}

export interface SearchCache {
  query: string
  results: SearchResult[]
  cachedAt: number
  expiresAt: number
}
