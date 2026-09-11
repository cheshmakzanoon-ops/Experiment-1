// rate-limit.test.ts — A01: the rate-limit identity must never be
// client-choosable.
//
// TRUST_PROXY=true models the Freebuff ingress: the reverse proxy APPENDS
// the connecting peer's address to X-Forwarded-For, so the RIGHTMOST entry
// is the proxy-added one and everything to its left is client-controlled.
// Taking the leftmost entry let any client rotate its own rate-limit bucket
// per request (login brute-force bypass, unbounded extraction attempts).
// Red→green: the identity tests fail against the leftmost implementation;
// the TRUST_PROXY=false tests are regression guards for the default.
//
// The config module reads env at import time, so this file must NOT use
// static imports of config-reading modules — env is set first and modules
// are imported dynamically afterwards (the session-auth.test.ts pattern).

process.env.TRUST_PROXY = 'true'

import { afterAll, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const REAL_CLIENT = '198.51.100.9'

type RateLimitModule = typeof import('../src/middleware/rateLimit.js')

async function loadModule(): Promise<RateLimitModule> {
  return import('../src/middleware/rateLimit.js')
}

function ipApp(mod: RateLimitModule): Hono {
  const app = new Hono()
  app.get('/ip', (c) => c.json({ ip: mod.clientIp(c) }))
  return app
}

async function ipFor(mod: RateLimitModule, headers: Record<string, string>): Promise<string | null> {
  const res = await ipApp(mod).request('/ip', { headers })
  const body = (await res.json()) as { ip: string | null }
  return body.ip
}

function limiterApp(mod: RateLimitModule, max: number): Hono {
  const limiter = new mod.RateLimiter({ windowMs: 60_000, max, name: 'a01-test' })
  const app = new Hono()
  app.use('/limited', limiter.middleware())
  app.get('/limited', (c) => c.json({ ok: true }))
  return app
}

describe('clientIp under TRUST_PROXY=true (A01)', () => {
  it('uses the proxy-appended (rightmost) entry — the client cannot choose its key', async () => {
    const mod = await loadModule()
    const ip = await ipFor(mod, { 'x-forwarded-for': `6.6.6.1, 6.6.6.2, ${REAL_CLIENT}` })
    expect(ip).toBe(REAL_CLIENT)
  })

  it('a single-entry chain (honest client, no spoofing) still resolves', async () => {
    const mod = await loadModule()
    const ip = await ipFor(mod, { 'x-forwarded-for': REAL_CLIENT })
    expect(ip).toBe(REAL_CLIENT)
  })

  it('fails closed when the proxy-appended entry is not a bare IP address', async () => {
    const mod = await loadModule()
    expect(await ipFor(mod, { 'x-forwarded-for': '9.9.9.9, not-an-ip' })).toBeNull()
    expect(await ipFor(mod, { 'x-forwarded-for': '1.2.3.4:8443' })).toBeNull()
    expect(await ipFor(mod, { 'x-forwarded-for': '[::1]' })).toBeNull()
  })

  it('a junk rightmost entry never lets a client-controlled leftmost entry win', async () => {
    const mod = await loadModule()
    expect(await ipFor(mod, { 'x-forwarded-for': '9.9.9.9, garbage' })).toBeNull()
  })

  it('validates X-Real-IP before trusting it', async () => {
    const mod = await loadModule()
    expect(await ipFor(mod, { 'x-real-ip': 'garbage' })).toBeNull()
    expect(await ipFor(mod, { 'x-real-ip': REAL_CLIENT })).toBe(REAL_CLIENT)
  })

  it('rotating client-controlled prefixes cannot rotate the identity', async () => {
    const mod = await loadModule()
    const seen = new Set<string>()
    for (let i = 0; i < 4; i++) {
      seen.add((await ipFor(mod, { 'x-forwarded-for': `10.1.0.${i}, ${REAL_CLIENT}` })) ?? '')
    }
    expect(seen.size).toBe(1)
  })
})

describe('RateLimiter through the middleware (A01 bypass closed)', () => {
  it('an attacker rotating forged prefixes stays bounded by the real client limit', async () => {
    const mod = await loadModule()
    const app = limiterApp(mod, 3)
    let ok = 0
    let limited = 0
    for (let i = 0; i < 6; i++) {
      const res = await app.request('/limited', {
        headers: { 'x-forwarded-for': `10.9.0.${i}, ${REAL_CLIENT}` }
      })
      if (res.status === 429) {
        limited++
        expect(res.headers.get('retry-after')).toBeTruthy()
      } else {
        ok++
      }
    }
    expect(ok).toBe(3)
    expect(limited).toBe(3)
  })

  it('distinct real clients still get independent buckets (regression)', async () => {
    const mod = await loadModule()
    const app = limiterApp(mod, 1)
    const a = await app.request('/limited', { headers: { 'x-forwarded-for': REAL_CLIENT } })
    const b = await app.request('/limited', { headers: { 'x-forwarded-for': '198.51.100.10' } })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
  })

  it('identity junk fails closed to the same bucket rather than one bucket per junk value', async () => {
    const mod = await loadModule()
    const app = limiterApp(mod, 2)
    // Two junk chains would be two distinct identities under the old
    // leftmost/no-validation scheme; they must share ONE bucket.
    const first = await app.request('/limited', { headers: { 'x-forwarded-for': 'garbage-one' } })
    const second = await app.request('/limited', { headers: { 'x-forwarded-for': 'garbage-two' } })
    const third = await app.request('/limited', { headers: { 'x-forwarded-for': 'garbage-three' } })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(third.status).toBe(429)
  })
})

describe('TRUST_PROXY=false (default) ignores forwarded headers entirely (regression)', () => {
  it('X-Forwarded-For never becomes an identity', async () => {
    vi.resetModules()
    delete process.env.TRUST_PROXY
    const fresh = await import('../src/middleware/rateLimit.js')
    const app = new Hono()
    app.get('/ip', (c) => c.json({ ip: fresh.clientIp(c) }))
    const res = await app.request('/ip', { headers: { 'x-forwarded-for': '6.6.6.6' } })
    const body = (await res.json()) as { ip: string | null }
    expect(body.ip).toBeNull()
  })
})

afterAll(() => {
  delete process.env.TRUST_PROXY
})
