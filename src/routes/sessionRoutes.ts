/**
 * Session endpoints.
 *
 *   GET    /api/session        → { authenticated: true|false }  (never secrets)
 *   POST   /api/session        → { key: "<household access key>" } JSON body
 *   DELETE /api/session        → logout (expires the cookie)
 *
 * POST is the ONLY route that accepts the household access key, and it is
 * rate-limited very strictly (login attempts, per client) before any
 * comparison work. The key is compared in constant time. On success an
 * HttpOnly SameSite=Strict cookie is set; nothing secret is ever returned
 * in the JSON body.
 */

import { Hono } from 'hono'
import { config } from '../config.js'
import { authIsDisabled, clearSessionCookie, issueSessionToken, readSessionToken, revokeSessionToken, safeEqual, setSessionCookie, verifySessionToken } from '../middleware/session.js'
import { clientIp, RateLimiter } from '../middleware/rateLimit.js'

const sessionRoutes = new Hono()

// Strict per-client limiter for the public login endpoint, independent of
// the general authenticated limits. Keyed on client IP (pre-session by
// definition); keys on a fixed window with an accurate Retry-After.
const loginLimiter = new RateLimiter({
  windowMs: config.auth.loginWindowMs,
  max: config.auth.loginMax,
  name: 'login'
})

// GET /api/session — auth state only. Never returns keys or cookies.
sessionRoutes.get('/session', (c) => {
  if (authIsDisabled()) {
    return c.json({ authenticated: true, authMode: 'disabled' })
  }
  const token = readSessionToken(c)
  const authenticated = verifySessionToken(token) !== null
  return c.json({ authenticated, authMode: 'session' })
})

// POST /api/session — exchange the household access key for a session cookie.
sessionRoutes.post('/session', async (c) => {
  if (authIsDisabled()) {
    // Explicit dev mode: everything is already open.
    return c.json({ authenticated: true, authMode: 'disabled' })
  }

  const limiterKey = clientIp(c) || 'anon'
  const decision = loginLimiter.allow(limiterKey)
  if (!decision.allowed) {
    return c.json(
      { error: 'Too many login attempts — try again later', code: 'LOGIN_RATE_LIMITED' },
      429,
      { 'Retry-After': String(decision.retryAfterSeconds) }
    )
  }

  let body: { key?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, 400)
  }

  const provided = typeof body.key === 'string' ? body.key : ''
  if (!provided) {
    return c.json({ error: 'Access key is required', code: 'KEY_REQUIRED' }, 400)
  }
  if (!config.accessKey || !safeEqual(provided, config.accessKey)) {
    return c.json({ error: 'Invalid access key', code: 'AUTH_INVALID' }, 401)
  }

  setSessionCookie(c, issueSessionToken())
  return c.json({ authenticated: true })
})

// DELETE /api/session — logout: revoke the token server-side AND expire
// the cookie client-side (a copied cookie stops working immediately).
sessionRoutes.delete('/session', (c) => {
  revokeSessionToken(readSessionToken(c))
  clearSessionCookie(c)
  return c.json({ authenticated: false })
})

export { sessionRoutes }
