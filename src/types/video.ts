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
