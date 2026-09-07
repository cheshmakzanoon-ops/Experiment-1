// Isolated file (Vitest module registry per file).
process.env.AUTH_DISABLED = 'true'
process.env.ACCESS_KEY = ''
process.env.SESSION_SECRET = ''

import { describe, expect, it, beforeAll } from 'vitest'
import { Hono } from 'hono'

let app: Hono

beforeAll(async () => {
  const sessionRoutes = (await import('../src/routes/sessionRoutes.js')).sessionRoutes
  app = new Hono()
  app.route('/api', sessionRoutes)
})

describe('explicit AUTH_DISABLED dev mode', () => {
  it('authIsDisabled() is true and session state reports the mode', async () => {
    const sessionMod = await import('../src/middleware/session.js')
    expect(sessionMod.authIsDisabled()).toBe(true)

    const res = await app.request('/api/session')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { authenticated: boolean; authMode: string }
    expect(body.authenticated).toBe(true)
    expect(body.authMode).toBe('disabled')
  })
})
