/**
 * Same-origin HttpOnly session authentication (replaces the API-key design).
 *
 * The old design was logically broken: a PUBLIC /api/config endpoint handed
 * out the very API key that "protected" everything else, the key travelled
 * in ?key=… query strings (logs, history, referrers), and `<img>`/`<video>`
 * elements were worked around by making some routes public.
 *
 * Now: an operator secret ACCESS_KEY is POSTed once to /api/session; the
 * server responds with a signed, expiring HttpOnly cookie. All private
 * resources (search, feeds, metadata, thumbnails, streams, stats,
 * diagnostics, offline-download stream requests) authenticate through that
 * cookie — ordinary same-origin fetches AND `<img>`/`<video>` resource
 * requests carry it automatically. No secret ever reaches frontend JS, and
 * no secret ever appears in a URL.
 *
 * Cookie value: `base64url(payload).base64url(hmacSha256(payload))` where
 * payload is `{ exp, sid }`. The signing secret (SESSION_SECRET) never
 * leaves the server.
 */

import type { Context, MiddlewareHandler } from 'hono'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

export const SESSION_COOKIE = 'ft_session'
export const SESSION_ID_HEADER = 'x-session-id' // set on authenticated responses (never the secret)

const PAYLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// ---------------------------------------------------------------------------
// Server-side revocation (logout). Signed tokens are stateless, so simply
// expiring the cookie client-side is not enough — a copied cookie would
// still verify. This bounded in-memory list marks logged-out session ids
// invalid until their natural expiry. Sizes are capped and pruned lazily;
// a restart clears it (acceptable: cookies also die with the process).
// ---------------------------------------------------------------------------

const REVOKED_MAX = 5000
const revokedSids = new Map<string, number>() // sid → exp(ms)
let lastRevokePrune = Date.now()

function pruneRevoked(now: number): void {
  if (now - lastRevokePrune < 60_000) return
  lastRevokePrune = now
  for (const [sid, exp] of revokedSids) {
    if (exp <= now) revokedSids.delete(sid)
  }
}

function markRevoked(sid: string, exp: number): void {
  pruneRevoked(Date.now())
  if (revokedSids.size >= REVOKED_MAX) {
    // Evict the soonest-to-expire entry to stay bounded.
    let soonest = Infinity
    let soonestSid: string | null = null
    for (const [s, e] of revokedSids) {
      if (e < soonest) {
        soonest = e
        soonestSid = s
      }
    }
    if (soonestSid) revokedSids.delete(soonestSid)
  }
  revokedSids.set(sid, exp)
}

function isRevoked(sid: string, now: number): boolean {
  const exp = revokedSids.get(sid)
  if (exp === undefined) return false
  if (exp <= now) {
    revokedSids.delete(sid)
    return false
  }
  return true
}

/** Invalidate a token server-side (used by logout). */
export function revokeSessionToken(raw: string | undefined | null): void {
  const payload = verifySessionToken(raw)
  if (payload) markRevoked(payload.sid, payload.exp)
}

interface SessionPayload {
  /** Expiry (ms epoch). */
  exp: number
  /** Random session nonce (rotation, future revocation). */
  sid: string
}

function base64urlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function base64urlDecode(input: string): Buffer | null {
  try {
    return Buffer.from(input, 'base64url')
  } catch {
    return null
  }
}

function sign(payload: string): string {
  return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url')
}

/** Constant-time comparison for strings (used for the access key too). */
export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

export function issueSessionToken(now = Date.now()): string {
  const payload: SessionPayload = {
    exp: now + PAYLOAD_TTL_MS,
    sid: createHmac('sha256', config.sessionSecret)
      .update(`${now}:${Math.random()}`)
      .digest('base64url')
      .slice(0, 18)
  }
  const encoded = base64urlEncode(JSON.stringify(payload))
  return `${encoded}.${sign(encoded)}`
}

/**
 * Verify a cookie value. Returns null when malformed/expired/tampered.
 * Verifying involves only local HMAC — no I/O.
 */
export function verifySessionToken(raw: string | undefined | null): SessionPayload | null {
  if (!raw) return null
  const dot = raw.indexOf('.')
  if (dot <= 0 || dot >= raw.length - 1) return null

  const encoded = raw.slice(0, dot)
  const signature = raw.slice(dot + 1)

  const expected = sign(encoded)
  if (!safeEqual(signature, expected)) return null

  const decoded = base64urlDecode(encoded)
  if (!decoded) return null

  let payload: SessionPayload
  try {
    payload = JSON.parse(decoded.toString('utf8')) as SessionPayload
  } catch {
    return null
  }
  if (!payload || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null
  const now = Date.now()
  if (payload.exp <= now) return null
  if (isRevoked(payload.sid, now)) return null
  return payload
}

function cookieAttributes(token: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    `Max-Age=${maxAgeSeconds}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict'
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** Set the session cookie on `c` (login) — the signed token IS the value. */
export function setSessionCookie(c: Context, token: string): void {
  const secure = config.nodeEnv === 'production'
  c.header('Set-Cookie', cookieAttributes(token, secure, config.sessionTtlDays * 24 * 60 * 60))
}

/** Expire the session cookie (logout) — empty value + Max-Age=0. */
export function clearSessionCookie(c: Context): void {
  const secure = config.nodeEnv === 'production'
  c.header('Set-Cookie', cookieAttributes('', secure, 0))
}

/** Read the session cookie value from the request. */
export function readSessionToken(c: Context): string | null {
  const cookieHeader = c.req.header('cookie')
  if (!cookieHeader) return null
  const prefix = `${SESSION_COOKIE}=`
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length))
    }
  }
  return null
}

/**
 * True when session enforcement is off: explicit AUTH_DISABLED=true, or a
 * non-production process that has not configured either secret (an explicit,
 * loudly-logged development default — production without secrets fails
 * startup instead, see config.ts assertValidConfig).
 */
export function authIsDisabled(): boolean {
  if (config.authDisabled) return true
  if (config.nodeEnv === 'production') return false
  return !config.accessKey || !config.sessionSecret
}

/** True when the request carries a valid session. */
export function isAuthenticated(c: Context): boolean {
  if (authIsDisabled()) return true
  return verifySessionToken(readSessionToken(c)) !== null
}

export interface SessionUser {
  sid: string
  expiresAt: number
}

/** Return the verified session (or null). */
export function currentSession(c: Context): SessionUser | null {
  if (authIsDisabled()) {
    return { sid: 'dev', expiresAt: Date.now() + PAYLOAD_TTL_MS }
  }
  const payload = verifySessionToken(readSessionToken(c))
  return payload ? { sid: payload.sid, expiresAt: payload.exp } : null
}

/**
 * Protect an endpoint: 401 (with a stable machine code) when no valid
 * session exists. Public platform liveness endpoints never use this.
 */
export function requireSession(): MiddlewareHandler {
  return async (c, next) => {
    if (authIsDisabled()) {
      await next()
      return
    }
    const session = currentSession(c)
    if (!session) {
      return c.json(
        { error: 'Authentication required', code: 'AUTH_REQUIRED' },
        401,
        { 'WWW-Authenticate': 'Session' }
      )
    }
    c.header(SESSION_ID_HEADER, session.sid)
    await next()
  }
}
