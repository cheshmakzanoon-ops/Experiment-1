/**
 * Session endpoints.
 *
 *   GET    /api/session        → { authenticated: true|false }  (never secrets)
 *   POST   /api/session        → { key: "<household access key>" } JSON body
 *   DELETE /api/session        → logout (removes the allowlist entry and
 *                                expires the cookie)
 *
 * POST is the ONLY route that accepts the household access key, and it is
 * rate-limited very strictly (login attempts, per client) before any
 * comparison work. The key is compared in constant time. On success an
 * HttpOnly SameSite=Strict cookie is set — but only AFTER the new active
 * session is durably persisted (issuance is asynchronous). DELETE persists
 * the allowlist removal BEFORE reporting success. Storage failure returns a
 * controlled 503 with AUTH_STORAGE_UNAVAILABLE — never false success.
 * Nothing secret is ever returned in the JSON body.
 */

import { Hono } from 'hono'
import { config } from '../config.js'
import {
  authIsDisabled,
  clearSessionCookie,
  issueSessionToken,
  readSessionToken,
  revokeSessionToken,
  safeEqual,
  setSessionCookie,
  verifySessionToken,
  SessionStoreError
} from '../middleware/session.js'
import { clientIp, RateLimiter } from '../middleware/rateLimit.js'
import { readBoundedJson } from '../middleware/boundedBody.js'
import { SessionStoreFullError } from '../services/sessionStore.js'

const sessionRoutes = new Hono()

// Strict per-client limiter for the public login endpoint, independent of
// the general authenticated limits. Keyed on client IP (pre-session by
// definition); keys on a fixed window with an accurate Retry-After.
const loginLimiter = new RateLimiter({
  windowMs: config.auth.loginWindowMs,
  max: config.auth.loginMax,
  name: 'login'
})

/** Storage failure response shape shared by POST/DELETE. */
function storageUnavailable(): Response {
  return new Response(
    JSON.stringify({
      error: 'Session storage is unavailable — try again shortly',
      code: 'AUTH_STORAGE_UNAVAILABLE'
    }),
    {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '5' }
    }
  )
}

function isStorageError(error: unknown): boolean {
  return error instanceof SessionStoreError
}

/**
 * Capacity exhaustion is a CONTROLLED 503 with its own code (never an
 * eviction, never a false-success login). Distinct from storage failure.
 */
function sessionsFullResponse(): Response {
  return new Response(
    JSON.stringify({
      error: 'Too many active sessions — an old session must expire before a new login',
      code: 'AUTH_SESSIONS_FULL'
    }),
    {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '60' }
    }
  )
}

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

  // Bounded read (A02): the login endpoint is public — an oversized body is
  // rejected 413 without ever being buffered or parsed.
  const bodyResult = await readBoundedJson<{ key?: unknown }>(c)
  if (!bodyResult.ok) return bodyResult.response
  const body = bodyResult.value

  const provided = typeof body.key === 'string' ? body.key : ''
  if (!provided) {
    return c.json({ error: 'Access key is required', code: 'KEY_REQUIRED' }, 400)
  }
  if (!config.accessKey || !safeEqual(provided, config.accessKey)) {
    return c.json({ error: 'Invalid access key', code: 'AUTH_INVALID' }, 401)
  }

  try {
    // Persist the active session BEFORE issuing its cookie.
    const token = await issueSessionToken()
    setSessionCookie(c, token)
    return c.json({ authenticated: true })
  } catch (error) {
    if (error instanceof SessionStoreFullError) return sessionsFullResponse()
    if (isStorageError(error)) return storageUnavailable()
    throw error
  }
})

// DELETE /api/session — logout: remove the allowlist entry (persisted) AND
// expire the cookie client-side. A copied cookie stops working immediately,
// even across a server restart that keeps the same session storage.
sessionRoutes.delete('/session', async (c) => {
  try {
    await revokeSessionToken(readSessionToken(c))
  } catch (error) {
    clearSessionCookie(c)
    if (isStorageError(error)) return storageUnavailable()
    throw error
  }
  clearSessionCookie(c)
  return c.json({ authenticated: false })
})

export { sessionRoutes }
