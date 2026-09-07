// Session lifetime coherence tests. Env is set BEFORE the config module is
// imported (config reads env at import time; each test file runs in its own
// module registry). SESSION_TTL_DAYS=7 is chosen to prove the token expiry
// follows the operator knob and is NOT a fixed 30-day constant.
process.env.NODE_ENV = 'production'
process.env.ACCESS_KEY = 'ttl-key-123'
process.env.SESSION_SECRET = 'ttl-session-secret-abcdef-123456'
process.env.SESSION_TTL_DAYS = '7'

import { describe, expect, it, beforeAll } from 'vitest'
import { Hono } from 'hono'

interface Payload {
  exp: number
  sid: string
}

let issueSessionToken: (now?: number) => string
let verifySessionToken: (raw: string | undefined | null) => Payload | null
let app: Hono

function decodePayload(token: string): Payload {
  const encoded = token.split('.')[0]
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Payload
}

beforeAll(async () => {
  const middleware = await import('../src/middleware/session.js')
  issueSessionToken = middleware.issueSessionToken
  verifySessionToken = middleware.verifySessionToken

  app = new Hono()
  app.get('/cookie', (c) => {
    middleware.setSessionCookie(c, middleware.issueSessionToken())
    return c.text('ok')
  })
})

describe('session lifetime follows SESSION_TTL_DAYS', () => {
  it('the signed token expires after the configured days, not a fixed 30', () => {
    const now = Date.now()
    const token = issueSessionToken(now)
    const { exp } = decodePayload(token)

    const expectedTtlMs = 7 * 24 * 60 * 60 * 1000
    expect(Math.abs(exp - (now + expectedTtlMs))).toBeLessThan(5_000)
    // Would be ~2.59e9 (30 days) if a fixed constant leaked in.
    expect(exp - now).toBeLessThan(8 * 24 * 60 * 60 * 1000)
  })

  it('Set-Cookie Max-Age matches the configured lifetime (7 days)', async () => {
    const res = await app.request('/cookie')
    const setCookie = res.headers.get('set-cookie') || ''
    expect(setCookie).toContain('Max-Age=604800')
  })

  it('a fresh token verifies; an older-than-TTL token is rejected', () => {
    const fresh = issueSessionToken()
    expect(verifySessionToken(fresh)).not.toBeNull()

    // Issued 8 days ago with a 7-day lifetime → expired.
    const old = issueSessionToken(Date.now() - 8 * 24 * 60 * 60 * 1000)
    expect(verifySessionToken(old)).toBeNull()
  })

  it('each issued token carries a unique session nonce', () => {
    const a = decodePayload(issueSessionToken())
    const b = decodePayload(issueSessionToken())
    expect(a.sid).not.toBe(b.sid)
    expect(a.sid.length).toBeGreaterThanOrEqual(18)
  })
})
