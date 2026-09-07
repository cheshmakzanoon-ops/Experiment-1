/**
 * HTTP helpers for the byte-relaying stream proxy: Range header parsing,
 * Content-Range formatting and response-status checks.
 */

export interface ByteRange {
  /** Byte offset to start from. Negative when it is a suffix marker (-N). */
  start: number
  /** Inclusive end byte, or null for an open-ended range. */
  end: number | null
}

/**
 * Parse a `Range` header into start/end positions.
 *
 * Examples:
 *   "bytes=0-"       → { start: 0, end: null }
 *   "bytes=100-200"  → { start: 100, end: 200 }
 *   "bytes=-500"     → with fileSize: { start: fileSize-500, end: fileSize-1 }
 *                      without fileSize: { start: -500, end: null }
 *
 * Returns null when the header is absent or cannot be understood. Only the
 * first range of a multi-range header is used; multi-range responses are
 * not supported by this proxy.
 */
export function parseRangeHeader(
  rangeHeader: string | undefined,
  fileSize?: number
): ByteRange | null {
  if (!rangeHeader) return null

  const match = rangeHeader.match(/^\s*bytes=(\d*)-(\d*)\s*$/i)
  if (!match) return null

  const startStr = match[1]
  const endStr = match[2]

  // Suffix range: "bytes=-500" (last 500 bytes).
  if (!startStr && endStr) {
    const suffixLength = parseInt(endStr, 10)
    if (Number.isNaN(suffixLength) || suffixLength <= 0) return null

    if (fileSize && fileSize > 0) {
      const start = Math.max(0, fileSize - suffixLength)
      return { start, end: fileSize - 1 }
    }
    // Total size unknown: keep the suffix marker so we can forward "-N".
    return { start: -suffixLength, end: null }
  }

  // Normal ranges: "bytes=100-" or "bytes=100-200".
  const start = parseInt(startStr, 10)
  if (Number.isNaN(start) || start < 0) return null

  let end: number | null = null
  if (endStr) {
    end = parseInt(endStr, 10)
    if (Number.isNaN(end) || end < start) return null
  }

  return { start, end }
}

/** Format a `Content-Range` response header value. */
export function formatContentRange(start: number, end: number, total: number): string {
  return `bytes ${start}-${end}/${total}`
}

/**
 * Normalize a client Range header into the value we forward upstream.
 * Returns undefined when the header is missing/invalid (no Range is sent,
 * which makes the upstream serve the whole resource).
 */
export function buildRangeHeader(
  clientRange: string | undefined,
  fileSize?: number
): string | undefined {
  if (!clientRange) return undefined

  const parsed = parseRangeHeader(clientRange, fileSize)
  if (!parsed) return undefined

  if (parsed.start < 0) {
    // Suffix range where we don't know the total: forward the marker.
    return `bytes=${-parsed.start}`
  }

  if (parsed.end === null) {
    return `bytes=${parsed.start}-`
  }

  return `bytes=${parsed.start}-${parsed.end}`
}

/** True for 2xx statuses. */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300
}

/** True for 206 Partial Content. */
export function isPartialContent(status: number): boolean {
  return status === 206
}

/** Header names that must not be forwarded between proxy hops. */
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade'
]

/** Strip hop-by-hop headers before forwarding an upstream header map. */
export function sanitizeProxyHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
      sanitized[key] = value
    }
  }
  return sanitized
}
