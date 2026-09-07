interface CacheEntry<T> {
  value: T
  expiresAt: number
}

class MemoryCache {
  private cache: Map<string, CacheEntry<any>> = new Map()
  private maxSize: number = 1000
  private defaultTTL: number = 3600000 // 1 hour

  /**
   * Set a value in the cache
   */
  set<T>(key: string, value: T, ttl?: number): void {
    // Check if cache is full
    if (this.cache.size >= this.maxSize) {
      this.evictOldest()
    }
    
    const expiresAt = Date.now() + (ttl || this.defaultTTL)
    
    this.cache.set(key, {
      value,
      expiresAt
    })
  }

  /**
   * Get a value from the cache
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key)
    
    if (!entry) {
      return null
    }
    
    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }
    
    return entry.value as T
  }

  /**
   * Delete a value from the cache
   */
  delete(key: string): void {
    this.cache.delete(key)
  }

  /**
   * Clear the entire cache
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size
  }

  /**
   * Clean up expired entries
   */
  cleanup(): void {
    const now = Date.now()
    
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * Evict oldest entries when cache is full
   */
  private evictOldest(): void {
    // Find the entry that expires first
    let oldestKey: string | null = null
    let oldestExpiry = Infinity
    
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt < oldestExpiry) {
        oldestExpiry = entry.expiresAt
        oldestKey = key
      }
    }
    
    if (oldestKey) {
      this.cache.delete(oldestKey)
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number
    maxSize: number
    hitRate: number
  } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: 0
    }
  }
}

// Export singleton instance
export const memoryCache = new MemoryCache()

// Set up periodic cleanup every 5 minutes
setInterval(() => {
  memoryCache.cleanup()
}, 300000)
