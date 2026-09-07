// Isolated file (Vitest module registry per file). The ONLY sanctioned
// unauthenticated configuration: development/test + an explicit loopback
// HOST binding + AUTH_DISABLED=true. Never globally disable auth.
process.env.NODE_ENV = 'development'
process.env.HOST = '127.0.0.1'
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

describe('explicit AUTH_DISABLED loopback dev mode', () => {
  it('authIsDisabled() is true and session state reports the mode', async () => {
    const sessionMod = await import('../src/middleware/session.js')
    expect(sessionMod.authIsDisabled()).toBe(true)

    const res = await app.request('/api/session')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { authenticated: boolean; authMode: string }
    expect(body.authenticated).toBe(true)
    expect(body.authMode).toBe('disabled')
  })

  it('assertValidConfig accepts the loopback development bypass', async () => {
    const configMod = await import('../src/config.js')
    expect(() => configMod.assertValidConfig()).not.toThrow()
  })

  it('the same bypass is refused on wildcard/network bindings', async () => {
    const configMod = await import('../src/config.js')
    expect(() =>
      configMod.assertValidConfig({ ...configMod.config, host: '0.0.0.0', authDisabled: true })
    ).toThrow(/loopback/i)
    expect(() =>
      configMod.assertValidConfig({ ...configMod.config, host: '0.0.0.0', authDisabled: false })
    ).toThrow() // no creds configured in this fixture → fail closed
  })
})

describe('AUTH_DISABLED value parsing', () => {
  it('accepts exactly true/false/absent/empty after trimming + lowercasing', async () => {
    const configMod = await import('../src/config.js')
    expect(configMod.parseAuthDisabledFlag(undefined)).toBe(false)
    expect(configMod.parseAuthDisabledFlag('')).toBe(false)
    expect(configMod.parseAuthDisabledFlag('  ')).toBe(false)
    expect(configMod.parseAuthDisabledFlag('false')).toBe(false)
    expect(configMod.parseAuthDisabledFlag('FALSE')).toBe(false)
    expect(configMod.parseAuthDisabledFlag(' true ')).toBe(true)
    expect(configMod.parseAuthDisabledFlag('TRUE')).toBe(true)
  })

  it('rejects spelling mistakes instead of coercing them', async () => {
    const configMod = await import('../src/config.js')
    for (const bad of ['flase', 'yesplease', 'disabled', '1', '0', 'on', 'yes', 't', 'f']) {
      expect(() => configMod.parseAuthDisabledFlag(bad), bad).toThrow(/AUTH_DISABLED/)
    }
  })

  it('rejects AUTH_DISABLED=true in production even on loopback', async () => {
    const configMod = await import('../src/config.js')
    expect(() =>
      configMod.assertValidConfig({
        ...configMod.config,
        nodeEnv: 'production',
        nodeEnvRaw: 'production',
        authDisabled: true,
        host: '127.0.0.1'
      })
    ).toThrow(/production/)
  })
})
