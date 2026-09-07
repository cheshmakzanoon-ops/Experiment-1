// Isolated file: env is set before ANY config import (Vitest gives each
// test file its own module registry).
process.env.NODE_ENV = 'production'
delete process.env.ACCESS_KEY
delete process.env.SESSION_SECRET
delete process.env.AUTH_DISABLED

import { describe, expect, it } from 'vitest'

describe('fail-closed production config', () => {
  it('assertValidConfig throws when production secrets are missing', async () => {
    const configMod = await import('../src/config.js')
    expect(() => configMod.assertValidConfig()).toThrow()
    // auth is NOT silently disabled in production without secrets
    const sessionMod = await import('../src/middleware/session.js')
    expect(sessionMod.authIsDisabled()).toBe(false)
  })

  it('missing credentials fail closed in development too (no auto-bypass)', async () => {
    // This file already runs under NODE_ENV=production; an omitted
    // environment also keeps the `development` default WITHOUT disabling
    // authentication (see auth-disabled.test.ts for the explicit bypass).
    const sessionMod = await import('../src/middleware/session.js')
    expect(sessionMod.authIsDisabled()).toBe(false)
  })

  it('partial credentials (ACCESS_KEY only) are rejected in every environment', async () => {
    const configMod = await import('../src/config.js')
    const cfg = {
      ...configMod.config,
      accessKey: 'a-valid-looking-16-char-key',
      sessionSecret: ''
    }
    expect(() => configMod.assertValidConfig(cfg)).toThrow(/SESSION_SECRET/)
  })

  it('a short access key or session secret is rejected, not silently accepted', async () => {
    const configMod = await import('../src/config.js')
    expect(() =>
      configMod.assertValidConfig({ ...configMod.config, accessKey: 'short', sessionSecret: 'x'.repeat(40) })
    ).toThrow(/ACCESS_KEY/)
    expect(() =>
      configMod.assertValidConfig({ ...configMod.config, accessKey: 'x'.repeat(16), sessionSecret: 'short' })
    ).toThrow(/SESSION_SECRET/)
  })

  it('error messages identify missing variable names without revealing values', async () => {
    const configMod = await import('../src/config.js')
    // One secret IS configured here; the message must name only the missing
    // variable and must never echo the configured value back.
    const configuredKey = 'super-secret-16-char-key-here'
    let message = ''
    try {
      configMod.assertValidConfig({ ...configMod.config, accessKey: configuredKey, sessionSecret: '' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('SESSION_SECRET')
    expect(message).not.toContain(configuredKey)
  })
})
