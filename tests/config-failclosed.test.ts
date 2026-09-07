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
})


