// Session auth acceptance tests. Env secrets are set BEFORE the config
// module is imported (config reads env at import time; each test file runs
// in its own module registry). SESSION_STORE_PATH points at a temp file so
// the persistent allowlist never touches repository state.
process.env.NODE_ENV = 'production'
process.env.ACCESS_KEY = 'household-test-key-123'
process.env.SESSION_SECRET = 'session-test-secret-456789-0123456789-abcdef'
process.env.HOST = '0.0.0.0'
process.env.SESSION_STORE_PATH = joinTmpSessionPath()

import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { Hono } from 'hono'

function joinTmpSessionPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ft-session-auth-'))
  return join(dir, 'sessions.json')
}

let app: Hono
let issueSessionToken: (now?: number) => Promise<string>

const ACCESS_KEY = 'household-test-key-123'

function extractCookie(setCookie: string | null, name: string): string | null {
  if (!setCookie) return null
  const first = setCookie.split(';')[0]
  if (!first.startsWith(`${name}=`)) return null
  return first.slice(name.length + 1)
}

beforeAll(async () => {
  const sessionStore = (await import('../src/services/sessionStore.js')).sessionStore
  await sessionStore.initialize()

  const sessionMod = await import('../src/routes/sessionRoutes.js')
  const middleware = await import('../src/middleware/session.js')
  issueSessionToken = middleware.issueSessionToken
  sessionRoutes = sessionMod.sessionRoutes

  app = new Hono()
  app.route('/api', sessionRoutes)
  app.get('/api/private', middleware.requireSession(), (c) => c.json({ ok: true }))
})

let sessionRoutes: import('hono').Hono

afterAll(() => {
  rmSync(dirname(process.env.SESSION_STORE_PATH as string), { recursive: true, force: true })
})

describe('session authentication', () => {
  it('protected endpoint without a cookie → 401', async () => {
    const res = await app.request('/api/private')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('AUTH_REQUIRED')
  })

  it('wrong access key → 401 (and no cookie is granted)', async () => {
    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'wrong-key' })
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('missing key body → 400', async () => {
    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(res.status).toBe(400)
  })

  it('correct access key issues an HttpOnly SameSite=Strict cookie', async () => {
    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ACCESS_KEY })
    })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') || ''
    expect(setCookie).toContain('ft_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toContain('Secure') // NODE_ENV=production
    const token = extractCookie(setCookie, 'ft_session')
    expect(token).toBeTruthy()
    expect(token!.split('.').length).toBe(2)
  })

  it('the cookie authenticates a <video>-style GET (no headers, no query key)', async () => {
    const login = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ACCESS_KEY })
    })
    const cookie = extractCookie(login.headers.get('set-cookie'), 'ft_session')!
    const res = await app.request('/api/private', { headers: { cookie: `ft_session=${cookie}` } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('a tampered cookie → 401', async () => {
    const login = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ACCESS_KEY })
    })
    let token = extractCookie(login.headers.get('set-cookie'), 'ft_session')!
    // Flip a signature character (payload unchanged → HMAC mismatch).
    const dot = token.lastIndexOf('.')
    const sig = token.slice(dot + 1)
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
    token = token.slice(0, dot + 1) + flipped
    const res = await app.request('/api/private', { headers: { cookie: `ft_session=${token}` } })
    expect(res.status).toBe(401)
  })

  it('an expired token → 401', async () => {
    const expired = await issueSessionToken(Date.now() - 31 * 24 * 60 * 60 * 1000)
    const res = await app.request('/api/private', { headers: { cookie: `ft_session=${expired}` } })
    expect(res.status).toBe(401)
  })

  it('logout expires the cookie and old cookies stop working', async () => {
    const login = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ACCESS_KEY })
    })
    const token = extractCookie(login.headers.get('set-cookie'), 'ft_session')!

    // The browser sends the cookie automatically on same-origin requests.
    const logout = await app.request('/api/session', {
      method: 'DELETE',
      headers: { cookie: `ft_session=${token}` }
    })
    expect(logout.status).toBe(200)
    const setCookie = logout.headers.get('set-cookie') || ''
    expect(setCookie).toContain('Max-Age=0')

    const res = await app.request('/api/private', { headers: { cookie: `ft_session=${token}` } })
    expect(res.status).toBe(401)
  })

  it('GET /api/session reports state and NEVER returns secrets', async () => {
    const login = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ACCESS_KEY })
    })
    const cookie = extractCookie(login.headers.get('set-cookie'), 'ft_session')!
    const authed = await app.request('/api/session', {
      headers: { cookie: `ft_session=${cookie}` }
    })
    const authedBody = JSON.stringify(await authed.json())
    expect(authedBody).toContain('"authenticated":true')
    expect(authedBody).not.toContain(ACCESS_KEY)
    expect(authedBody).not.toContain('session-test-secret-456789-0123456789-abcdef')

    const anon = await app.request('/api/session')
    const anonBody = JSON.stringify(await anon.json())
    expect(anonBody).toContain('"authenticated":false')
    expect(anonBody).not.toContain('household-test-key')
  })
})
