/**
 * Persistent active-session allowlist (src/services/sessionStore.ts).
 *
 * Authentication is an ALLOWLIST of active {sid, exp} records persisted to
 * a versioned JSON document, NOT an evicting revoked-token blacklist:
 *
 *   - logout removes the sid from the allowlist and persists BEFORE the
 *     response returns, so a copied cookie stops working immediately and
 *     survives server restarts that keep the same storage,
 *   - retained storage preserves active sessions across restart; lost or
 *     replaced ephemeral storage creates a fresh random epoch, which
 *     invalidates every previously issued cookie (one fresh login),
 *   - the document is {version:1, epoch, sessions:[{sid, exp}]} where the
 *     epoch is 32 cryptographically random bytes; no access key, signing
 *     secret, raw cookie or upstream credential is ever stored,
 *   - initialization and mutations are asynchronous and serialized through
 *     one writer; membership checks (has) stay synchronous,
 *   - persistence is crash-conscious: a unique same-directory temporary
 *     file, restrictive permissions, fsync, atomic rename and a directory
 *     fsync on supported Linux filesystems. In-memory state is published
 *     only after the write succeeds,
 *   - corruption is NEVER silently replaced: a malformed document, invalid
 *     schema, duplicate ids, an unexpected file type or unsafe ownership /
 *     permissions fails startup (and any later rewrite attempt),
 *   - a failed write flips the store unhealthy: further authentication
 *     operations are rejected (AUTH_STORAGE_UNAVAILABLE) and readiness
 *     fails closed until a successful explicit re-initialization/restart,
 *   - the allowlist is capped at 5000 active sessions after pruning
 *     expired entries; a full store rejects new logins with a controlled
 *     503 — unexpired security records are never evicted.
 *
 * Topology: this store supports ONE Node process/replica against one JSON
 * file. Do not run multiple replicas against independent files, and never
 * claim filesystem persistence across Freebuff rebuilds without testing it.
 */

import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { config } from '../config.js'

/** Stable machine code surfaced to clients on storage failures. */
export const AUTH_STORAGE_UNAVAILABLE = 'AUTH_STORAGE_UNAVAILABLE'

export const MAX_ACTIVE_SESSIONS = 5000

export interface SessionStoreOptions {
  /** Absolute path of the persisted allowlist document. */
  path: string
  /** Injectable clock (ms epoch) — defaults to Date.now. */
  now?: () => number
}

export interface ActiveSessionRecord {
  sid: string
  /** Expiry as ms epoch. */
  exp: number
}

export interface SessionStoreDocument {
  version: 1
  /** 64 lowercase hex chars (32 random bytes). */
  epoch: string
  sessions: ActiveSessionRecord[]
}

export class SessionStoreError extends Error {
  readonly code: string
  constructor(message: string, code = AUTH_STORAGE_UNAVAILABLE) {
    super(message)
    this.name = 'SessionStoreError'
    this.code = code
  }
}

/** Controlled rejection when the allowlist is at capacity (never evicts). */
export class SessionStoreFullError extends SessionStoreError {
  constructor() {
    super('Active session limit reached — try again after a session expires', 'AUTH_SESSIONS_FULL')
    this.name = 'SessionStoreFullError'
  }
}

const EPOCH_HEX_RE = /^[0-9a-f]{64}$/
const SID_RE = /^[A-Za-z0-9_-]{8,128}$/

export function isValidSid(sid: string): boolean {
  return SID_RE.test(sid)
}

function isBrokenFileMode(mode: number): boolean {
  // Reject group/other access (0o077) and the setuid/setgid/sticky bits
  // (0o7000). Owner read/write (0o600) is exactly what we write.
  return (mode & 0o7077) !== 0
}

export class SessionStore {
  private readonly path: string
  private readonly now: () => number

  private epoch: string | null = null
  /** Committed allowlist: sid → exp (ms epoch). */
  private sessions = new Map<string, number>()
  private initialized = false
  private healthy = false
  /** Serialize every mutation through exactly one writer. */
  private writer: Promise<unknown> = Promise.resolve()

  constructor(options: SessionStoreOptions) {
    this.path = resolve(options.path)
    this.now = options.now ?? (() => Date.now())
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Load (or create) the allowlist document. A genuinely missing file gets
   * a fresh epoch and an empty allowlist; anything corrupt fails startup.
   * Safe to call again later as an explicit recovery step after a write
   * failure — never called automatically on a broken snapshot.
   */
  initialize(): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.loadFromDisk()
      this.healthy = true
      this.initialized = true
    })
  }

  /** Persist a new active session BEFORE the cookie is issued. */
  add(sid: string, exp: number): Promise<void> {
    this.assertUsable()
    if (!isValidSid(sid)) {
      return Promise.reject(new SessionStoreError('Malformed session identifier'))
    }
    if (!Number.isSafeInteger(exp) || exp <= 0) {
      return Promise.reject(new SessionStoreError('Malformed session expiry'))
    }
    return this.enqueueWrite(async () => {
      this.assertUsable()
      // Prune expired entries first, then enforce the cap.
      const now = this.now()
      for (const [existingSid, existingExp] of this.sessions) {
        if (existingExp <= now) this.sessions.delete(existingSid)
      }
      if (this.sessions.has(sid)) {
        // Idempotent re-add of the same live session (same expiry wins).
        this.sessions.set(sid, exp)
      } else if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
        throw new SessionStoreFullError()
      } else {
        this.sessions.set(sid, exp)
      }
      await this.persistSnapshot()
    })
  }

  /** Persist removal BEFORE logout reports success. Idempotent. */
  remove(sid: string): Promise<void> {
    this.assertUsable()
    return this.enqueueWrite(async () => {
      this.assertUsable()
      if (!this.sessions.has(sid)) return
      this.sessions.delete(sid)
      await this.persistSnapshot()
    })
  }

  /** Synchronous membership check used by token verification (in memory). */
  has(sid: string, exp: number): boolean {
    if (!this.initialized || !this.healthy) return false
    const stored = this.sessions.get(sid)
    if (stored === undefined) return false
    return stored === exp
  }

  /** The current epoch (hex) — tokens must match it. Null before init. */
  getEpoch(): string | null {
    return this.initialized && this.healthy ? this.epoch : null
  }

  /** Readiness/fail-closed hook. */
  isHealthy(): boolean {
    return this.initialized && this.healthy
  }

  /** Number of live (non-expired) records — internal/introspection only. */
  size(now = this.now()): number {
    let count = 0
    for (const exp of this.sessions.values()) {
      if (exp > now) count++
    }
    return count
  }

  // -------------------------------------------------------------------------
  // Disk I/O (all mutations serialized through `writer`)
  // -------------------------------------------------------------------------

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writer.then(operation, operation)
    // Keep the chain alive regardless of individual failures, and make the
    // caller observe its own rejection.
    this.writer = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private assertUsable(): void {
    if (!this.initialized) {
      throw new SessionStoreError('Session store is not initialized', AUTH_STORAGE_UNAVAILABLE)
    }
    if (!this.healthy) {
      throw new SessionStoreError(
        'Session storage is unavailable after a write failure — restart to recover',
        AUTH_STORAGE_UNAVAILABLE
      )
    }
  }

  private async loadFromDisk(): Promise<void> {
    let stat
    try {
      stat = await lstat(this.path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        // Genuinely missing: create a fresh epoch + empty allowlist.
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        this.epoch = randomBytes(32).toString('hex')
        this.sessions = new Map()
        await this.persistSnapshot()
        return
      }
      throw new SessionStoreError(`Cannot inspect session store: ${code ?? 'unknown error'}`)
    }

    if (stat.isSymbolicLink()) {
      throw new SessionStoreError('Session store path is a symlink — refusing to follow it')
    }
    if (!stat.isFile()) {
      throw new SessionStoreError('Session store path is not a regular file')
    }
    if (!this.pathOwnedByUs(stat)) {
      throw new SessionStoreError('Session store has unsafe ownership — refusing to read it')
    }
    if (isBrokenFileMode(stat.mode & 0o7777)) {
      throw new SessionStoreError(
        'Session store permissions are too open (group/other access) — refusing to read it'
      )
    }

    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      throw new SessionStoreError(`Cannot read session store: ${(error as Error).message}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new SessionStoreError('Session store contains malformed JSON — refusing to start')
    }
    this.epoch = null
    this.sessions = new Map()
    this.applyDocument(parsed)
  }

  private pathOwnedByUs(stat: { uid: number }): boolean {
    // When not running as root, the file must belong to the current user.
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      return stat.uid === process.getuid()
    }
    return true
  }

  /** Validate + apply a parsed document (throws on any schema violation). */
  private applyDocument(parsed: unknown): void {
    if (!parsed || typeof parsed !== 'object') {
      throw new SessionStoreError('Session store document is not an object')
    }
    const doc = parsed as Record<string, unknown>
    if (doc.version !== 1) {
      throw new SessionStoreError(`Unsupported session store version: ${String(doc.version)}`)
    }
    if (typeof doc.epoch !== 'string' || !EPOCH_HEX_RE.test(doc.epoch)) {
      throw new SessionStoreError('Session store epoch is missing or malformed')
    }
    if (!Array.isArray(doc.sessions)) {
      throw new SessionStoreError('Session store sessions list is missing or malformed')
    }
    const sessions = new Map<string, number>()
    const seen = new Set<string>()
    for (const entry of doc.sessions as unknown[]) {
      if (!entry || typeof entry !== 'object') {
        throw new SessionStoreError('Session store contains a malformed session record')
      }
      const { sid, exp } = entry as { sid?: unknown; exp?: unknown }
      if (typeof sid !== 'string' || !isValidSid(sid)) {
        throw new SessionStoreError('Session store contains a malformed session id')
      }
      if (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= 0) {
        throw new SessionStoreError('Session store contains a malformed session expiry')
      }
      if (seen.has(sid)) {
        throw new SessionStoreError('Session store contains duplicate session ids')
      }
      seen.add(sid)
      sessions.set(sid, exp)
    }
    this.epoch = doc.epoch
    this.sessions = sessions
  }

  /**
   * Atomically persist the current in-memory snapshot. On ANY failure the
   * store is marked unhealthy (state is never partially published) and the
   * failure propagates to the caller. Only temporary files created by this
   * operation are ever removed.
   */
  private async persistSnapshot(): Promise<void> {
    const epoch = this.epoch
    if (!epoch) {
      throw new SessionStoreError('Cannot persist before initialization')
    }
    const document: SessionStoreDocument = {
      version: 1,
      epoch,
      sessions: [...this.sessions.entries()]
        .map(([sid, exp]) => ({ sid, exp }))
        .sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0))
    }
    const payload = `${JSON.stringify(document, null, 2)}\n`
    const dir = dirname(this.path)
    const tmpPath = join(
      dir,
      `.sessions-${process.pid}-${randomBytes(8).toString('hex')}.tmp`
    )

    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const handle = await open(tmpPath, 'wx', 0o600)
      try {
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      // Atomic replacement of the live document.
      await rename(tmpPath, this.path)
      await this.fsyncDirectory(dir)
    } catch (error) {
      // Clean only the temporary file this operation created.
      await rm(tmpPath, { force: true }).catch(() => {})
      this.healthy = false
      this.initialized = true
      throw new SessionStoreError(`Failed to persist session store: ${(error as Error).message}`)
    }
  }

  private async fsyncDirectory(dir: string): Promise<void> {
    // Directory fsync is supported on Linux; best-effort elsewhere.
    let handle
    try {
      handle = await open(dir, fsConstants.O_RDONLY)
      await handle.sync()
    } catch {
      // Unsupported platform — the file fsync + atomic rename still hold.
    } finally {
      await handle?.close().catch(() => {})
    }
  }
}

/** Repository-scoped singleton used by the running server (and tests). */
export const sessionStore = new SessionStore({ path: config.sessionStorePath })

/** Chmod helper retained for tests that assert restrictive permissions. */
export async function chmodSessionStoreFile(path: string, mode: number): Promise<void> {
  await chmod(path, mode)
}
