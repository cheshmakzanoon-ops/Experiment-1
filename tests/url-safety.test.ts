import { describe, expect, it } from 'vitest'
import {
  ALLOWED_STREAM_HOSTS,
  assertSafeMediaUrl,
  isAllowedHost,
  isValidVideoId,
  resolveRedirectTarget,
  UnsafeUrlError
} from '../src/utils/urlValidator'

describe('video id validation', () => {
  it('accepts the exact 11-char YouTube shape', () => {
    expect(isValidVideoId('dQw4w9WgXcQ')).toBe(true)
    expect(isValidVideoId('M7lc1UVf-VE')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isValidVideoId('')).toBe(false)
    expect(isValidVideoId('short')).toBe(false)
    expect(isValidVideoId('not a valid 11!')).toBe(false)
    expect(isValidVideoId('dQw4w9WgXcQ\"));alert(1)//')).toBe(false)
  })
})

describe('host allowlist', () => {
  it('allows exact media hosts and subdomains', () => {
    expect(isAllowedHost('googlevideo.com')).toBe(true)
    expect(isAllowedHost('rr1---sn-a5mekn6s.googlevideo.com')).toBe(true)
    expect(isAllowedHost('i.ytimg.com')).toBe(true)
    expect(isAllowedHost('yt3.ggpht.com')).toBe(true)
  })

  it('rejects lookalike/suffix hosts', () => {
    expect(isAllowedHost('googlevideo.com.evil.example')).toBe(false)
    expect(isAllowedHost('notgooglevideo.com')).toBe(false)
    expect(isAllowedHost('googlevideo.com.attacker.io')).toBe(false)
    expect(isAllowedHost('example.com')).toBe(false)
  })

  it('the allowlist is non-empty and hostnames only', () => {
    expect(ALLOWED_STREAM_HOSTS.length).toBeGreaterThan(0)
    for (const host of ALLOWED_STREAM_HOSTS) {
      expect(host).not.toContain('/')
      expect(host).not.toContain('*')
    }
  })
})

describe('assertSafeMediaUrl', () => {
  it('accepts https URLs on allowed hosts', () => {
    const url = assertSafeMediaUrl('https://rr1.googlevideo.com/videoplayback?expire=1&signature=abc')
    expect(url.hostname).toBe('rr1.googlevideo.com')
  })

  it('rejects http by default (external media must be HTTPS)', () => {
    expect(() => assertSafeMediaUrl('http://googlevideo.com/v')).toThrow(UnsafeUrlError)
  })

  it('rejects embedded credentials', () => {
    expect(() => assertSafeMediaUrl('https://user:pass@googlevideo.com/v')).toThrow(UnsafeUrlError)
    expect(() => assertSafeMediaUrl('https://user@googlevideo.com/v')).toThrow(UnsafeUrlError)
  })

  it('rejects malformed URLs and disallowed hosts', () => {
    expect(() => assertSafeMediaUrl('not a url')).toThrow(UnsafeUrlError)
    expect(() => assertSafeMediaUrl('https://evil.example/x')).toThrow(UnsafeUrlError)
  })

  it('rejects non-HTTP schemes', () => {
    expect(() => assertSafeMediaUrl('file:///etc/passwd')).toThrow(UnsafeUrlError)
    expect(() => assertSafeMediaUrl('javascript:alert(1)')).toThrow(UnsafeUrlError)
  })
})

describe('redirect chain re-validation (every hop)', () => {
  const base = 'https://rr1.googlevideo.com/videoplayback?expire=1'

  it('accepts a safe→safe redirect', () => {
    const result = resolveRedirectTarget(base, 'https://rr2.googlevideo.com/videoplayback?expire=2')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.url).toContain('rr2.googlevideo.com')
  })

  it('accepts relative Location resolution against the current hop', () => {
    const result = resolveRedirectTarget(base, '/videoplayback?expire=3')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.url.startsWith('https://rr1.googlevideo.com/')).toBe(true)
  })

  it('rejects a redirect to an unsafe host', () => {
    const result = resolveRedirectTarget(base, 'https://evil.example/steal')
    expect(result.ok).toBe(false)
    const result2 = resolveRedirectTarget(base, 'https://googlevideo.com.evil.example/x')
    expect(result2.ok).toBe(false)
  })

  it('rejects a redirect downgrade to http', () => {
    const result = resolveRedirectTarget(base, 'http://googlevideo.com/v')
    expect(result.ok).toBe(false)
  })

  it('rejects redirects with embedded credentials', () => {
    const result = resolveRedirectTarget(base, 'https://user:pass@googlevideo.com/v')
    expect(result.ok).toBe(false)
  })

  it('rejects a missing or malformed Location', () => {
    expect(resolveRedirectTarget(base, null).ok).toBe(false)
    expect(resolveRedirectTarget(base, '').ok).toBe(false)
    expect(resolveRedirectTarget(base, '   ').ok).toBe(false)
    // Spaces/control characters can never appear in a valid absolute URL.
    expect(resolveRedirectTarget(base, 'https://exa mple.com/x').ok).toBe(false)
    expect(resolveRedirectTarget(base, 'https://[::1').ok).toBe(false)
  })
})
