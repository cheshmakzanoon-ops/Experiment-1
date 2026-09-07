/**
 * Strict numeric query-parameter validation.
 *
 * `parseInt('abc')` yields NaN, and `NaN < 1` is false — the old code could
 * therefore accept malformed page/limit/max values. These helpers require a
 * canonical positive integer (no sign, no decimals, no junk) before bounds
 * are applied.
 */

export interface ParsedParam {
  error: boolean
  value: number
}

/**
 * Parse `raw` as an integer within [min, max]. A missing/empty parameter
 * yields the fallback (which must itself be within bounds). Anything
 * non-canonical or out of range yields `error: true`.
 */
export function parseParam(
  raw: string | null | undefined,
  fallback: number,
  min: number,
  max: number
): ParsedParam {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return { error: false, value: fallback }
  }
  const trimmed = raw.trim()
  if (!/^[0-9]{1,15}$/.test(trimmed)) return { error: true, value: 0 }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value)) return { error: true, value: 0 }
  if (value < min || value > max) return { error: true, value: 0 }
  return { error: false, value }
}

/** Parse a raw integer that must be present and valid; null when not. */
export function strictInt(raw: string | null | undefined): number | null {
  if (raw === undefined || raw === null) return null
  const trimmed = raw.trim()
  if (!/^[0-9]{1,15}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : null
}
