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
 * Sessions are an ACTIVE ALLOWLIST persisted in src/services/sessionStore.ts
 * (never an evicting revoked-token blacklist): issuance persists the new
 * {sid, exp} record before the cookie is set, logout persists its removal
 * before success is reported, and token verification requires a matching
 * stored epoch + active record — so logout survives server restarts that
 * keep the same storage. Storage failures fail closed
 * (AUTH_STORAGE_UNAVAILABLE), never false success.
 *
 * Cookie value: `base64url(payload).base64url(hmacSha256(payload))` where
 * payload is `{ v:2, epoch, sid, exp }` and exp is ms epoch. The signing
 * secret (SESSION_SECRET) never leaves the server.
 */

import type { Context, MiddlewareHandler } from 'hono'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import {
  sessionStore,
  isValidSid,
  SessionStoreError
} from '../services/sessionStore.js'

export const SESSION_COOKIE = 'ft_session'
export const SESSION_ID_HEADER = 'x-session-id' // set on authenticated responses (never the secret)

/**
 * One source of truth for the session lifetime: the operator-tunable
 * SESSION_TTL_DAYS (default 30). The cookie Max-Age AND the signed token
 * expiry both come from here so a configured lifetime can never be silently
 * shortened by a stale fixed constant (a 365-day cookie dying at 30 days).
 */
export function sessionTokenLifetimeMs(): number {
  return Math.max(1, config.sessionTtlDays) * 24 * 60 * 60 * 1000
}

interface SessionPayload {
  /** Payload version (2 = persistent-allowlist era). */
  v: 2
  /** Store epoch (hex) the session was issued under. */
  epoch: string
  /** Expiry (ms epoch). */
  exp: number
  /** Random session nonce (the allowlist key). */
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

/**
 * Issue a session token ASYNCHRONOUSLY: the active-session record is
 * persisted first; only a successfully committed record receives a cookie.
 * Rejects with SessionStoreError (→ AUTH_STORAGE_UNAVAILABLE) when storage
 * is unavailable.
 */
export async function issueSessionToken(now = Date.now()): Promise<string> {
  const epoch = sessionStore.getEpoch()
  if (!epoch) {
    throw new SessionStoreError('Session store is not ready', 'AUTH_STORAGE_UNAVAILABLE')
  }
  const payload: SessionPayload = {
    v: 2,
    epoch,
    exp: now + sessionTokenLifetimeMs(),
    // Unpredictable per-session nonce (never Math.random) — the allowlist
    // and logout revocation rely on it being unguessable.
    sid: randomBytes(18).toString('base64url')
  }
  // Persist BEFORE issuing the cookie (never hand out an unpersisted
  // session that verification would reject or a crash would lose).
  await sessionStore.add(payload.sid, payload.exp)
  const encoded = base64urlEncode(JSON.stringify(payload))
  return `${encoded}.${sign(encoded)}`
}

/**
 * Revoke a session token ASYNCHRONOUSLY: removal is persisted before the
 * logout response returns. An invalid/expired token is a harmless no-op
 * (there is nothing active to remove). Storage failure propagates.
 */
export async function revokeSessionToken(raw: string | undefined | null): Promise<void> {
  const payload = verifySessionToken(raw)
  if (!payload) return
  await sessionStore.remove(payload.sid)
}

/**
 * Verify a cookie value synchronously. Returns null when
 * malformed/expired/tampered, when the epoch does not match the store, or
 * when the sid is not an active allowlist entry. Verification is local
 * (HMAC + in-memory membership) — no I/O.
 */
export function verifySessionToken(raw: string | undefined | null): SessionPayload | null {
  if (!raw) return null
  // Oversized cookie values are rejected outright (defense in depth).
  if (raw.length > 4096) return null
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
  if (!payload || typeof payload !== 'object') return null
  // Versioned payload: only the current allowlist format verifies.
  if (payload.v !== 2) return null
  if (typeof payload.epoch !== 'string' || !/^[0-9a-f]{64}$/.test(payload.epoch)) return null
  if (typeof payload.sid !== 'string' || !isValidSid(payload.sid)) return null
  if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp)) return null
  const now = Date.now()
  if (payload.exp <= now) return null
  // Active allowlist membership with an exact expiry match.
  if (sessionStore.getEpoch() !== payload.epoch) return null
  if (!sessionStore.has(payload.sid, payload.exp)) return null
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

/** Read the session cookie value from the request (null on malformed). */
export function readSessionToken(c: Context): string | null {
  const cookieHeader = c.req.header('cookie')
  if (!cookieHeader) return null
  const prefix = `${SESSION_COOKIE}=`
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length))
      } catch {
        // Malformed percent-encoding is an invalid cookie, not a server bug.
        return null
      }
    }
  }
  return null
}

/**
 * True only when the operator explicitly disabled authentication with the
 * validated loopback-only development flag. Missing development secrets no
 * longer open the application — auth fails CLOSED everywhere else.
 */
export function authIsDisabled(): boolean {
  return config.authDisabled
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
    return { sid: 'dev', expiresAt: Date.now() + sessionTokenLifetimeMs() }
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

export { SessionStoreError }
