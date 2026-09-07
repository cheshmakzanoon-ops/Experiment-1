/**
 * Bounded TTL cache with stale-on-error fallback.
 *
 * Used by search/feed services so a temporary YouTube failure never blanks
 * previously successful UI content: when a refresh fails and a stale value
 * is still inside its `staleTtlMs` window, the stale value is returned
 * (tagged `stale: true`) instead of surfacing the error.
 */

interface StaleEntry<T> {
  value: T
  savedAt: number
}

export interface StaleLoadResult<T> {
  value: T
  stale: boolean
  savedAt: number
}

export class StaleCache {
  private entries = new Map<string, StaleEntry<unknown>>()
  private maxSize: number

  constructor(maxSize = 300) {
    this.maxSize = maxSize
  }

  get<T>(key: string): T | null {
    const entry = this.entries.get(key) as StaleEntry<T> | undefined
    return entry ? entry.value : null
  }

  peek<T>(key: string): { value: T; savedAt: number } | null {
    const entry = this.entries.get(key) as StaleEntry<T> | undefined
    return entry ? { value: entry.value, savedAt: entry.savedAt } : null
  }

  set<T>(key: string, value: T, now = Date.now()): void {
    if (this.entries.size >= this.maxSize && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(key, { value, savedAt: now })
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  size(): number {
    return this.entries.size
  }
}

export const staleCache = new StaleCache()

/**
 * Load `key`, refreshing when older than `ttlMs`. If the producer throws and
 * a value newer than `staleTtlMs` exists, that stale value is returned
 * (`stale: true`); otherwise the error propagates.
 */
export async function loadWithStale<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>,
  options: { staleTtlMs?: number; now?: number; force?: boolean } = {}
): Promise<StaleLoadResult<T>> {
  const now = options.now ?? Date.now()
  const staleTtl = options.staleTtlMs ?? 30 * 60 * 1000
  const existing = staleCache.peek<T>(key)

  if (!options.force && existing && now - existing.savedAt < ttlMs) {
    return { value: existing.value, stale: false, savedAt: existing.savedAt }
  }

  try {
    const value = await producer()
    staleCache.set(key, value, now)
    return { value, stale: false, savedAt: now }
  } catch (error) {
    if (existing && now - existing.savedAt < staleTtl) {
      return { value: existing.value, stale: true, savedAt: existing.savedAt }
    }
    throw error
  }
}
