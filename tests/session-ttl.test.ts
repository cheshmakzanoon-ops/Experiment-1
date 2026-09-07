// Session lifetime coherence tests. Env is set BEFORE the config module is
// imported (config reads env at import time; each test file runs in its own
// module registry). SESSION_TTL_DAYS=7 is chosen to prove the token expiry
// follows the operator knob and is NOT a fixed 30-day constant.
process.env.NODE_ENV = 'production'
process.env.ACCESS_KEY = 'ttl-key-1234567890'
process.env.SESSION_SECRET = 'ttl-session-secret-abcdef-1234567890xyz'
process.env.HOST = '0.0.0.0'
process.env.SESSION_TTL_DAYS = '7'
process.env.SESSION_STORE_PATH = joinTmpSessionPath()

import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { Hono } from 'hono'

function joinTmpSessionPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ft-session-ttl-'))
  return join(dir, 'sessions.json')
}

interface Payload {
  exp: number
  sid: string
}

let issueSessionToken: (now?: number) => Promise<string>
let verifySessionToken: (raw: string | undefined | null) => Payload | null
let app: Hono

function decodePayload(token: string): Payload {
  const encoded = token.split('.')[0]
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Payload
}

beforeAll(async () => {
  const sessionStore = (await import('../src/services/sessionStore.js')).sessionStore
  await sessionStore.initialize()

  const middleware = await import('../src/middleware/session.js')
  issueSessionToken = middleware.issueSessionToken
  verifySessionToken = middleware.verifySessionToken

  app = new Hono()
  app.get('/cookie', async (c) => {
    middleware.setSessionCookie(c, await middleware.issueSessionToken())
    return c.text('ok')
  })
})

afterAll(() => {
  rmSync(dirname(process.env.SESSION_STORE_PATH as string), { recursive: true, force: true })
})

describe('session lifetime follows SESSION_TTL_DAYS', () => {
  it('the signed token expires after the configured days, not a fixed 30', async () => {
    const now = Date.now()
    const token = await issueSessionToken(now)
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

  it('a fresh token verifies; an older-than-TTL token is rejected', async () => {
    const fresh = await issueSessionToken()
    expect(verifySessionToken(fresh)).not.toBeNull()

    // Issued 8 days ago with a 7-day lifetime → expired.
    const old = await issueSessionToken(Date.now() - 8 * 24 * 60 * 60 * 1000)
    expect(verifySessionToken(old)).toBeNull()
  })

  it('each issued token carries a unique session nonce and v2 payload', async () => {
    const a = decodePayload(await issueSessionToken())
    const b = decodePayload(await issueSessionToken())
    expect(a.sid).not.toBe(b.sid)
    expect(a.sid.length).toBeGreaterThanOrEqual(18)
    expect(a).toHaveProperty('v', 2)
    expect(a.epoch).toMatch(/^[0-9a-f]{64}$/)
    expect(a.epoch).toBe(b.epoch) // same store epoch
  })
})
