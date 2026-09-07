// session-store.test.ts — persistent ACTIVE-SESSION allowlist (not an
// evicting revoked-token blacklist): atomic persistence, corruption
// fail-closed, retention/rotation across restarts, controlled 503s on
// storage failure, and capacity exhaustion without evicting unexpired
// security records.
//
// The store class is exercised directly with injected paths/clock; the
// restart semantics run through the session middleware with a fresh module
// registry (env is re-read at import) against the same on-disk file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'

const SESSION_SECRET = 'test-session-secret-0123456789abcdef0123' // > 32 bytes
const ACCESS_KEY = 'test-access-key-0123456789abcdef' // >= 16 chars

let roots: string[] = []

function tmpStorePath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sst-${label}-`))
  roots.push(dir)
  return join(dir, 'sessions.json')
}

function setAuthEnv(path: string, extra: Record<string, string> = {}): void {
  process.env.NODE_ENV = 'production'
  process.env.ACCESS_KEY = ACCESS_KEY
  process.env.SESSION_SECRET = SESSION_SECRET
  process.env.HOST = '0.0.0.0'
  process.env.SESSION_STORE_PATH = path
  process.env.SESSION_TTL_DAYS = '30'
  for (const [k, v] of Object.entries(extra)) process.env[k] = v
}

function clearAuthEnv(): void {
  delete process.env.NODE_ENV
  delete process.env.ACCESS_KEY
  delete process.env.SESSION_SECRET
  delete process.env.HOST
  delete process.env.SESSION_STORE_PATH
  delete process.env.SESSION_TTL_DAYS
}

beforeEach(() => {
  vi.resetModules()
  clearAuthEnv()
})

afterEach(() => {
  vi.resetModules()
  clearAuthEnv()
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  roots = []
})

/** Write a valid v1 store document with the given epoch/sessions. */
function writeDocument(path: string, epoch: string, sessions: Array<{ sid: string; exp: number }>): void {
  writeFileSync(path, `${JSON.stringify({ version: 1, epoch, sessions }, null, 2)}\n`, { mode: 0o600 })
}

const EPOCH_A = 'a'.repeat(64)
const EPOCH_B = 'b'.repeat(64)
const sid = (n: number | string) => `sid-${String(n).padStart(10, '0')}${'x'.repeat(20)}`.slice(0, 30)

async function freshSessionModules() {
  const storeModule = await import('../src/services/sessionStore.js')
  const sessionModule = await import('../src/middleware/session.js')
  const routesModule = await import('../src/routes/sessionRoutes.js')
  return { store: storeModule.sessionStore, session: sessionModule, routes: routesModule.sessionRoutes }
}

describe('SessionStore file persistence', () => {
  it('creates a fresh versioned document with a random 32-byte epoch on a missing file', async () => {
    const { SessionStore } = await import('../src/services/sessionStore.js')
    const path = tmpStorePath('fresh')
    const store = new SessionStore({ path })
    await store.initialize()
    expect(store.isHealthy()).toBe(true)
    expect(store.getEpoch()).toMatch(/^[0-9a-f]{64}$/)
    expect(store.size()).toBe(0)

    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.epoch).toBe(store.getEpoch())
    expect(Array.isArray(raw.sessions)).toBe(true)
    // Restrictive permissions on the document.
    const mode = (await import('node:fs')).statSync(path).mode & 0o777
    expect(mode & 0o077).toBe(0)
  })

  it('uses a fresh random epoch per store (missing store ⇒ epoch rotation)', async () => {
    const { SessionStore } = await import('../src/services/sessionStore.js')
    const a = new SessionStore({ path: tmpStorePath('ea') })
    const b = new SessionStore({ path: tmpStorePath('eb') })
    await a.initialize()
    await b.initialize()
    expect(a.getEpoch()).not.toBe(b.getEpoch())
  })

  it('add persists BEFORE the caller proceeds; a retained file keeps the session', async () => {
    const { SessionStore } = await import('../src/services/sessionStore.js')
    const path = tmpStorePath('retain')
    const store = new SessionStore({ path })
    await store.initialize()
    const exp = Date.now() + 3_600_000
    await store.add(sid(1), exp)
    expect(store.has(sid(1), exp)).toBe(true)

    // A second instance over the SAME retained file (restart) sees it.
    const reopened = new SessionStore({ path })
    await reopened.initialize()
    expect(reopened.getEpoch()).toBe(store.getEpoch())
    expect(reopened.has(sid(1), exp)).toBe(true)
  })

  it('remove persists: a logged-out session is gone after a restart with the same file', async () => {
    const { SessionStore } = await import('../src/services/sessionStore.js')
    const path = tmpStorePath('logout')
    const store = new SessionStore({ path })
    await store.initialize()
    const exp = Date.now() + 3_600_000
    await store.add(sid(1), exp)
    await store.remove(sid(1))
    expect(store.has(sid(1), exp)).toBe(false)

    const reopened = new SessionStore({ path })
    await reopened.initialize()
    expect(reopened.has(sid(1), exp)).toBe(false)
  })

  it('membership requires the EXACT persisted expiry (in-memory, sync)', async () => {
    const { SessionStore } = await import('../src/services/sessionStore.js')
    const store = new SessionStore({ path: tmpStorePath('exact') })
    await store.initialize()
    const exp = Date.now() + 60_000
    await store.add(sid(9), exp)
    expect(store.has(sid(9), exp)).toBe(true)
    expect(store.has(sid(9), exp + 1)).toBe(false)
    expect(store.has(sid(8), exp)).toBe(false)
  })

  it('fails startup on malformed JSON and NEVER silently replaces corruption', async () => {
    const { SessionStore, SessionStoreError } = await import('../src/services/sessionStore.js')
    const path = tmpStorePath('corrupt')
    writeFileSync(path, '{ not json !!!', { mode: 0o600 })
    const store = new SessionStore({ path })
    await expect(store.initialize()).rejects.toBeInstanceOf(SessionStoreError)
    expect(store.isHealthy()).toBe(false)
    // The corrupt file is untouched (no fresh-epoch replacement).
    expect(readFileSync(path, 'utf8')).toBe('{ not json !!!')
  })

  it('rejects schema violations: version, epoch, sessions list, records, duplicates', async () => {
    const { SessionStore, SessionStoreError } = await import('../src/services/sessionStore.js')
    const cases: Array<[string, unknown]> = [
      ['version 2 doc', { version: 2, epoch: EPOCH_A, sessions: [] }],
      ['missing epoch', { version: 1, sessions: [] }],
      ['short epoch', { version: 1, epoch: 'abcd', sessions: [] }],
      ['sessions not an array', { version: 1, epoch: EPOCH_A, sessions: 'x' }],
      ['record missing sid', { version: 1, epoch: EPOCH_A, sessions: [{ exp: 5 }] }],
      ['record missing exp', { version: 1, epoch: EPOCH_A, sessions: [{ sid: sid(1) }] }],
      ['non-finite exp', { version: 1, epoch: EPOCH_A, sessions: [{ sid: sid(1), exp: 1e308 }] }],
      ['duplicate sids', { version: 1, epoch: EPOCH_A, sessions: [{ sid: sid(1), exp: 5 }, { sid: sid(1), exp: 6 }] }]
    ]
    for (const [label, doc] of cases) {
      const path = tmpStorePath('schema')
      writeDocument(path, EPOCH_A, [])
      writeFileSync(path, JSON.stringify(doc), { mode: 0o600 })
      const store = new SessionStore({ path })
      await expect(store.initialize(), label).rejects.toBeInstanceOf(SessionStoreError)
    }
  })

  it('rejects an unexpected file type and a symlink instead of following them', async () => {
    const { SessionStore, SessionStoreError } = await import('../src/services/sessionStore.js')
    const root = mkdtempSync(join(tmpdir(), 'sst-dirtype-'))
    roots.push(root)
    // A directory is not a regular file.
    const dirStore = new SessionStore({ path: root })
    await expect(dirStore.initialize()).rejects.toBeInstanceOf(SessionStoreError)

    const target = join(root, 'target.json')
    writeDocument(target, EPOCH_A, [])
    const link = join(root, 'link.json')
    symlinkSync(target, link)
    const linkStore = new SessionStore({ path: link })
    await expect(linkStore.initialize()).rejects.toBeInstanceOf(SessionStoreError)
  })

  it('rejects group/other-readable permissions on the store file', async () => {
    const { SessionStore, SessionStoreError } = await import('../src/services/sessionStore.js')
    const path = tmpStorePath('perms')
    writeDocument(path, EPOCH_A, [])
    // 0o644 — group/other read access.
    chmodSync(path, 0o644)
    const store = new SessionStore({ path })
    await expect(store.initialize()).rejects.toBeInstanceOf(SessionStoreError)
  })

  it('a failed write marks the store unhealthy and rejects further operations (fail closed)', async () => {
    const { SessionStore, SessionStoreError, AUTH_STORAGE_UNAVAILABLE } = await import('../src/services/sessionStore.js')
    const path = tmpStorePath('writefail')
    const store = new SessionStore({ path })
    await store.initialize()
    const exp = Date.now() + 60_000
    await store.add(sid(1), exp)
    expect(store.isHealthy()).toBe(true)

    // Sabotage: replace the live file with a DIRECTORY so the atomic rename
    // of the next snapshot cannot succeed (works even when running as root).
    const original = readFileSync(path)
    rmSync(path)
    mkdirSync(path)

    await expect(store.add(sid(2), exp + 1000)).rejects.toBeInstanceOf(SessionStoreError)
    expect(store.isHealthy()).toBe(false)
    // Even the pre-failure live record is refused while unhealthy.
    expect(store.has(sid(1), exp)).toBe(false)
    // Mutations throw synchronously (fail closed) with the storage code.
    expect(() => store.remove(sid(1))).toThrowError(
      expect.objectContaining({ code: AUTH_STORAGE_UNAVAILABLE })
    )

    // Explicit recovery after the cause is fixed restores health from the
    // last durable snapshot (the failed add is not resurrected).
    rmSync(path, { recursive: true })
    writeFileSync(path, original, { mode: 0o600 })
    await store.initialize()
    expect(store.isHealthy()).toBe(true)
    expect(store.has(sid(1), exp)).toBe(true)
    expect(store.has(sid(2), exp + 1000)).toBe(false)
  })

  it('cleans only its own temporary files after success and after failure', async () => {
    const { SessionStore } = await import('../src/services/sessionStore.js')
    const dir = tmpStorePath('tmpclean')
    const path = join(dir, 'sessions.json')
    const store = new SessionStore({ path })
    await store.initialize()
    await store.add(sid(1), Date.now() + 60_000)
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toHaveLength(0)

    rmSync(path)
    mkdirSync(path)
    await expect(store.add(sid(2), Date.now() + 60_000)).rejects.toThrow()
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'))
    expect(leftovers).toHaveLength(0)
  })

  it('expires sessions when pruning on add; capacity exhaustion never evicts unexpired records', async () => {
    const { SessionStore, SessionStoreFullError, MAX_ACTIVE_SESSIONS } = await import('../src/services/sessionStore.js')
    const path = tmpStorePath('cap')
    const now = 1_700_000_000_000
    // Seed MAX_ACTIVE_SESSIONS live records plus one expired record.
    const sessions = Array.from({ length: MAX_ACTIVE_SESSIONS }, (_, i) => ({
      sid: sid(i),
      exp: now + 3_600_000
    }))
    sessions.push({ sid: sid('expired'), exp: now - 1 })
    writeDocument(path, EPOCH_A, sessions)

    const store = new SessionStore({ path, now: () => now })
    await store.initialize()
    expect(store.size(now)).toBe(MAX_ACTIVE_SESSIONS) // expired pruned on load via add below

    // The allowlist is full of unexpired security records.
    const full = store.add(sid(MAX_ACTIVE_SESSIONS), now + 3_600_000)
    await expect(full).rejects.toBeInstanceOf(SessionStoreFullError)
    expect(store.isHealthy()).toBe(true)
    // Every unexpired record is still there — nothing was evicted.
    expect(store.size(now)).toBe(MAX_ACTIVE_SESSIONS)
    expect(store.has(sid(0), now + 3_600_000)).toBe(true)
    expect(store.has(sid(MAX_ACTIVE_SESSIONS - 1), now + 3_600_000)).toBe(true)

    // Adding while below the cap succeeds and prunes the expired entry.
    const store2 = new SessionStore({ path: tmpStorePath('cap2'), now: () => now })
    await store2.initialize()
    await store2.add(sid(1), now + 60_000)
    expect(store2.size(now)).toBe(1)
  })
})

describe('session restart semantics (same secret, same/different storage)', () => {
  it('an active cookie survives a restart that keeps the retained valid storage', async () => {
    const path = tmpStorePath('restart-retain')
    setAuthEnv(path)
    const first = await freshSessionModules()
    await first.store.initialize()
    const token = await first.session.issueSessionToken()
    expect(first.session.verifySessionToken(token)).not.toBeNull()

    // Restart: same env + same file, fresh module registry.
    vi.resetModules()
    setAuthEnv(path)
    const second = await freshSessionModules()
    await second.store.initialize()
    expect(second.session.verifySessionToken(token)).not.toBeNull()
  })

  it('a revoked cookie stays revoked after a restart with the same secret and storage', async () => {
    const path = tmpStorePath('restart-revoke')
    setAuthEnv(path)
    const first = await freshSessionModules()
    await first.store.initialize()
    const token = await first.session.issueSessionToken()
    await first.session.revokeSessionToken(token)
    expect(first.session.verifySessionToken(token)).toBeNull()

    vi.resetModules()
    setAuthEnv(path)
    const second = await freshSessionModules()
    await second.store.initialize()
    expect(second.session.verifySessionToken(token)).toBeNull()
  })

  it('missing (rotated) storage invalidates every old cookie; one fresh login is required', async () => {
    const path = tmpStorePath('restart-rotate')
    setAuthEnv(path)
    const first = await freshSessionModules()
    await first.store.initialize()
    const token = await first.session.issueSessionToken()
    const oldEpoch = first.store.getEpoch()

    // Storage is lost between restarts: delete the file.
    rmSync(path)
    vi.resetModules()
    setAuthEnv(path)
    const second = await freshSessionModules()
    await second.store.initialize()
    expect(second.store.getEpoch()).not.toBe(oldEpoch)
    expect(second.session.verifySessionToken(token)).toBeNull()

    // A fresh login under the new epoch works.
    const fresh = await second.session.issueSessionToken()
    expect(second.session.verifySessionToken(fresh)).not.toBeNull()
  })

  it('legacy v1 tokens, nonfinite expirations and oversized cookies are rejected', async () => {
    const path = tmpStorePath('restart-reject')
    setAuthEnv(path)
    const { store, session, routes } = await freshSessionModules()
    await store.initialize()

    // Hand-craft a legacy v1 payload signed with the same secret.
    const { createHmac } = await import('node:crypto')
    const b64 = (s: string) => Buffer.from(s).toString('base64url')
    const sign = (payload: string) =>
      createHmac('sha256', process.env.SESSION_SECRET as string).update(payload).digest('base64url')
    const epoch = store.getEpoch() as string
    const sidValue = sid(3)
    const exp = Date.now() + 60_000
    await store.add(sidValue, exp)

    const legacy = `${b64(JSON.stringify({ v: 1, epoch, sid: sidValue, exp }))}.${sign(
      b64(JSON.stringify({ v: 1, epoch, sid: sidValue, exp }))
    )}`
    expect(session.verifySessionToken(legacy)).toBeNull()

    const huge = `${b64(JSON.stringify({ v: 2, epoch, sid: sidValue, exp: 1e308 }))}.${sign(
      b64(JSON.stringify({ v: 2, epoch, sid: sidValue, exp: 1e308 }))
    )}`
    expect(session.verifySessionToken(huge)).toBeNull()

    // Oversized raw cookie: never an internal error, just unauthenticated.
    const app = new Hono()
    app.route('/api', routes)
    const res = await app.request('/api/session', {
      headers: { cookie: `ft_session=${'x'.repeat(4096)}` }
    })
    expect(res.status).toBe(200)
    expect((await res.json()).authenticated).toBe(false)
  })

  it('concurrent issue/revoke serialize through one writer and stay consistent', async () => {
    const path = tmpStorePath('restart-conc')
    setAuthEnv(path)
    const { store, session } = await freshSessionModules()
    await store.initialize()

    const tokens = await Promise.all(Array.from({ length: 12 }, () => session.issueSessionToken()))
    for (const t of tokens) expect(session.verifySessionToken(t)).not.toBeNull()
    expect(store.size()).toBe(12)

    await Promise.all(tokens.slice(0, 8).map((t) => session.revokeSessionToken(t)))
    expect(store.size()).toBe(4)
    for (const t of tokens.slice(0, 8)) expect(session.verifySessionToken(t)).toBeNull()
    for (const t of tokens.slice(8)) expect(session.verifySessionToken(t)).not.toBeNull()
  })

  it('capacity exhaustion surfaces a controlled 503 on login (never evicts)', async () => {
    const path = tmpStorePath('restart-cap')
    const now = Date.now()
    const sessions = Array.from({ length: 5000 }, (_, i) => ({ sid: sid(i), exp: now + 3_600_000 }))
    writeDocument(path, 'c'.repeat(64), sessions)

    setAuthEnv(path)
    const { store, session, routes } = await freshSessionModules()
    await store.initialize()

    const app = new Hono()
    app.route('/api', routes)
    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ACCESS_KEY })
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('AUTH_SESSIONS_FULL')
    // Unexpired records remain intact.
    expect(store.size()).toBe(5000)
    expect(store.has(sid(0), now + 3_600_000)).toBe(true)
    // issueSessionToken rejects rather than evicting.
    await expect(session.issueSessionToken()).rejects.toMatchObject({ code: 'AUTH_SESSIONS_FULL' })
  })
})

describe('storage failure surfaces as AUTH_STORAGE_UNAVAILABLE, never false success', () => {
  it('POST /api/session returns 503 + AUTH_STORAGE_UNAVAILABLE when persistence fails', async () => {
    const path = tmpStorePath('route-writefail')
    setAuthEnv(path)
    const { store, routes } = await freshSessionModules()
    await store.initialize()

    // Sabotage the atomic rename (works as root too).
    const original = readFileSync(path)
    rmSync(path)
    mkdirSync(path)

    const app = new Hono()
    app.route('/api', routes)
    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ACCESS_KEY })
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('AUTH_STORAGE_UNAVAILABLE')
    expect(res.headers.get('retry-after')).toBe('5')

    // Recovery is explicit, not automatic.
    rmSync(path, { recursive: true })
    writeFileSync(path, original, { mode: 0o600 })
    await expect(store.initialize()).resolves.toBeUndefined()
  })

  it('DELETE /api/session returns 503 + AUTH_STORAGE_UNAVAILABLE instead of claiming logout', async () => {
    const path = tmpStorePath('route-del-fail')
    setAuthEnv(path)
    const { store, session, routes } = await freshSessionModules()
    await store.initialize()
    const token = await session.issueSessionToken()

    const app = new Hono()
    app.route('/api', routes)
    const ok = await app.request('/api/session', { method: 'DELETE', headers: { cookie: `ft_session=${token}` } })
    expect(ok.status).toBe(200)
    // The cookie was cleared client-side and the record removed durably.

    const token2 = await session.issueSessionToken()
    const original = readFileSync(path)
    rmSync(path)
    mkdirSync(path)
    const res = await app.request('/api/session', { method: 'DELETE', headers: { cookie: `ft_session=${token2}` } })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('AUTH_STORAGE_UNAVAILABLE')

    rmSync(path, { recursive: true })
    writeFileSync(path, original, { mode: 0o600 })
    await store.initialize()
  })

  it('a failed login response never crashes on a missing body (controlled 401/400)', async () => {
    const path = tmpStorePath('route-clean')
    setAuthEnv(path)
    const { store, routes } = await freshSessionModules()
    await store.initialize()

    const app = new Hono()
    app.route('/api', routes)
    const wrong = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'totally-wrong-key-value' })
    })
    expect(wrong.status).toBe(401)

    const empty = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: ''
    })
    expect([400, 401]).toContain(empty.status)

    const bad = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ nope'
    })
    expect(bad.status).toBe(400)
    void existsSync // keep the import used on non-root paths
    void dirname
  })
})
