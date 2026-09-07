/**
 * RFC 7233 byte-range handling for the media proxy.
 *
 * The old parser collapsed "missing", "invalid" and "unsupported" into one
 * `null` and then forwarded NO Range header — a malformed request silently
 * became a full-video download. Here the three states are explicit:
 *
 *   - absent   → normal full request is permitted
 *   - valid    → normalized for forwarding
 *   - invalid  → reject (416) — never forward, never fetch the whole file
 *
 * Multi-range requests are unsupported and are reported as invalid.
 */

export type RangeParse =
  | { kind: 'absent' }
  | { kind: 'valid'; spec: RangeSpec }
  | { kind: 'invalid'; reason: string }

export type RangeSpec =
  /** bytes=START-  (open ended) */
  | { type: 'from'; start: number }
  /** bytes=START-END (inclusive) */
  | { type: 'interval'; start: number; end: number }
  /** bytes=-N (last N bytes; needs the total size to resolve) */
  | { type: 'suffix'; suffixLength: number }

export type ResolvedRange =
  | { kind: 'satisfiable'; start: number; end: number }
  | { kind: 'unsatisfiable' }

const MAX_SAFE = Number.MAX_SAFE_INTEGER
const UNIT_RE = /^\s*bytes\s*=\s*(.*)\s*$/i
const RANGE_RE = /^(\d*)-(\d*)$/

function parseNumber(s: string, label: string): { ok: true; value: number } | { ok: false; reason: string } {
  if (s.length === 0) return { ok: true, value: 0 }
  if (!/^\d{1,16}$/.test(s)) {
    return { ok: false, reason: `non-numeric ${label}` }
  }
  const value = Number(s)
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: `${label} exceeds safe integer range` }
  }
  return { ok: true, value }
}

/** Parse a raw `Range` header value into an explicit state. */
export function parseRangeHeader(raw: string | undefined | null): RangeParse {
  if (!raw) return { kind: 'absent' }

  const unit = raw.match(UNIT_RE)
  if (!unit) return { kind: 'invalid', reason: 'unsupported range unit' }

  const specPart = unit[1].trim()
  if (!specPart) return { kind: 'invalid', reason: 'empty range set' }

  // Multi-range ("bytes=0-1,4-5") is explicitly unsupported.
  if (specPart.includes(',')) {
    return { kind: 'invalid', reason: 'multiple ranges are not supported' }
  }

  const m = specPart.match(RANGE_RE)
  if (!m) return { kind: 'invalid', reason: 'malformed byte range' }

  const startRaw = m[1]
  const endRaw = m[2]

  // "bytes=-" has no bounds at all.
  if (!startRaw && !endRaw) return { kind: 'invalid', reason: 'missing byte range bounds' }

  // Suffix range: bytes=-N
  if (!startRaw && endRaw) {
    if (endRaw === '0' || endRaw === '') return { kind: 'invalid', reason: 'invalid suffix length' }
    const parsed = parseNumber(endRaw, 'suffix length')
    if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason }
    return { kind: 'valid', spec: { type: 'suffix', suffixLength: parsed.value } }
  }

  // bytes=START-
  if (startRaw && !endRaw) {
    const parsed = parseNumber(startRaw, 'start')
    if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason }
    return { kind: 'valid', spec: { type: 'from', start: parsed.value } }
  }

  // bytes=START-END
  const startParsed = parseNumber(startRaw, 'start')
  if (!startParsed.ok) return { kind: 'invalid', reason: startParsed.reason }
  const endParsed = parseNumber(endRaw, 'end')
  if (!endParsed.ok) return { kind: 'invalid', reason: endParsed.reason }
  if (endParsed.value < startParsed.value) {
    return { kind: 'invalid', reason: 'end before start' }
  }
  return { kind: 'valid', spec: { type: 'interval', start: startParsed.value, end: endParsed.value } }
}

/**
 * Resolve a valid spec against a known total size.
 * `totalSize` may be undefined when unknown; a suffix spec then cannot be
 * resolved and is reported unsatisfiable only when total is known to be
 * smaller than the suffix start.
 */
export function resolveRange(spec: RangeSpec, totalSize?: number): ResolvedRange {
  if (spec.type === 'suffix') {
    if (totalSize === undefined) {
      // Cannot know where it starts — caller forwards the suffix verbatim.
      return { kind: 'satisfiable', start: -spec.suffixLength, end: -1 }
    }
    if (totalSize <= 0) return { kind: 'unsatisfiable' }
    const length = Math.min(spec.suffixLength, totalSize)
    return { kind: 'satisfiable', start: totalSize - length, end: totalSize - 1 }
  }

  if (spec.type === 'from') {
    if (totalSize !== undefined && spec.start >= totalSize) return { kind: 'unsatisfiable' }
    if (totalSize !== undefined && totalSize > 0) return { kind: 'satisfiable', start: spec.start, end: totalSize - 1 }
    return { kind: 'satisfiable', start: spec.start, end: -1 }
  }

  // interval
  if (spec.start > MAX_SAFE - 1) return { kind: 'unsatisfiable' }
  if (totalSize !== undefined && spec.start >= totalSize) return { kind: 'unsatisfiable' }
  if (totalSize !== undefined) {
    return { kind: 'satisfiable', start: spec.start, end: Math.min(spec.end, totalSize - 1) }
  }
  return { kind: 'satisfiable', start: spec.start, end: spec.end }
}

/**
 * The Range header value to forward upstream for a parsed spec, or undefined
 * for an absent range. Never called for invalid specs (routes reject those
 * with 416 before any upstream work). Unknown totals keep open/suffix forms.
 */
export function forwardRangeHeader(parse: RangeParse, totalSize?: number): string | undefined {
  if (parse.kind !== 'valid') return undefined
  const spec = parse.spec

  if (spec.type === 'suffix') {
    if (totalSize !== undefined && totalSize > 0) {
      const resolved = resolveRange(spec, totalSize)
      if (resolved.kind === 'satisfiable' && resolved.end >= resolved.start) {
        return `bytes=${resolved.start}-${resolved.end}`
      }
      return undefined
    }
    return `bytes=-${spec.suffixLength}`
  }

  if (spec.type === 'from') {
    return `bytes=${spec.start}-`
  }

  return `bytes=${spec.start}-${spec.end}`
}

/** `Content-Range: bytes START-END/TOTAL` (total omitted as `*` when unknown). */
export function formatContentRange(start: number, end: number, total?: number): string {
  return `bytes ${start}-${end}/${total === undefined ? '*' : total}`
}

/** Content-Range payload for a 416 response: `bytes *` / `TOTAL` (total optional). */
export function contentRangeForUnsatisfiable(total?: number): string {
  return `bytes */${total === undefined ? '*' : total}`
}
