// session-body-limit.test.ts — A02: the PUBLIC login endpoint must never
// buffer an unbounded request body. POST /api/session is pre-authentication:
// the default JSON parsing reads the entire body into memory before any size
// check, so a single oversized POST can exhaust the process. Red→green:
// oversized bodies must be rejected 413 without parsing; small bodies keep
// the exact previous behavior (regressions).

process.env.NODE_ENV = 'production'
process.env.ACCESS_KEY = 'household-test-key-123'
process.env.SESSION_SECRET = 'session-test-secret-456789-0123456789-abcdef'
process.env.HOST = '0.0.0.0'
process.env.SESSION_STORE_PATH = joinTmpSessionPath()

import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'

function joinTmpSessionPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ft-session-body-'))
  return join(dir, 'sessions.json')
}

const ACCESS_KEY = 'household-test-key-123'

let app: Hono

beforeAll(async () => {
  const sessionStore = (await import('../src/services/sessionStore.js')).sessionStore
  await sessionStore.initialize()
  const sessionMod = await import('../src/routes/sessionRoutes.js')
  app = new Hono()
  app.route('/api', sessionMod.sessionRoutes)
})

afterAll(() => {
  rmSync(dirname(process.env.SESSION_STORE_PATH as string), { recursive: true, force: true })
})

function login(body: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  })
}

describe('POST /api/session body bound (A02)', () => {
  it('a normal login under the cap still succeeds (regression)', async () => {
    const res = await login(JSON.stringify({ key: ACCESS_KEY }))
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('ft_session=')
  })

  it('invalid JSON under the cap stays a 400, not a 413 (regression)', async () => {
    const res = await login('{"key":')
    expect(res.status).toBe(400)
  })

  it('an oversized body is rejected 413 without parsing (stream path)', async () => {
    const res = await login('x'.repeat(32 * 1024))
    expect(res.status).toBe(413)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('PAYLOAD_TOO_LARGE')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('an oversized declared Content-Length is refused before the body is trusted', async () => {
    const res = await login('y'.repeat(32 * 1024), {
      'content-length': String(64 * 1024 * 1024)
    })
    expect(res.status).toBe(413)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('PAYLOAD_TOO_LARGE')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('an oversized VALID login body is never parsed (401 is not enough)', async () => {
    const pad = 'p'.repeat(16 * 1024)
    const res = await login(JSON.stringify({ key: ACCESS_KEY, pad }))
    expect(res.status).toBe(413)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})
