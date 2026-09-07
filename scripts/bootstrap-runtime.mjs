#!/usr/bin/env node
/**
 * bootstrap-runtime.mjs — install/verify the pinned yt-dlp standalone binary
 * into .runtime/bin/ (gitignored). Works on Freebuff Cloud (no Docker, no
 * pip): the binary is an official standalone release executable.
 *
 * This module EXPORTS the reusable verification/installation functions and
 * only runs its CLI when executed directly (`node scripts/bootstrap-runtime.mjs`)
 * — importing it never downloads anything.
 *
 *   - one effective requested version: trimmed YT_DLP_VERSION, otherwise
 *     src/config/ytdlp-version.json `defaultVersion` (release-tag syntax
 *     validated: YYYY.MM.DD),
 *   - asset is platform/architecture aware (x86_64 → yt-dlp_linux,
 *     arm64 → yt-dlp_linux_aarch64, Windows → yt-dlp.exe),
 *   - SHA-256 is verified against the official release SHA2-256SUMS before
 *     the binary is trusted; a small receipt is saved ONLY after that
 *     checksum verification passes,
 *   - downloads go to a unique same-directory temporary path, the temporary
 *     executable's exact version is verified, and installation is an atomic
 *     rename — a failed replacement never deletes an existing binary first,
 *   - a bounded filesystem lock prevents concurrent installers from racing,
 *   - idempotent: a valid installed binary of the right version + a matching
 *     receipt is re-hashed and never re-downloaded; with a receipt absent/
 *     stale, the EXISTING bytes are verified against the official manifest
 *     instead of being trusted.
 *
 * Usage:  node scripts/bootstrap-runtime.mjs [--force]
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const projectRoot = resolve(scriptDir, '..')
const versionInfo = JSON.parse(
  readFileSync(join(projectRoot, 'src/config/ytdlp-version.json'), 'utf8')
)
export const DEFAULT_VERSION = versionInfo.defaultVersion

export const RELEASE_TAG_RE = /^\d{4}\.\d{2}\.\d{2}$/

export function runtimeDir(rootDir = projectRoot) {
  return join(rootDir, '.runtime', 'bin')
}

export function binaryNameFor(platform = process.platform) {
  return platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
}

export function binaryPathFor(rootDir = projectRoot, platform = process.platform) {
  return join(runtimeDir(rootDir), binaryNameFor(platform))
}

export function receiptPathFor(rootDir = projectRoot) {
  return join(runtimeDir(rootDir), '.yt-dlp.verified.json')
}

export function lockPathFor(rootDir = projectRoot) {
  return join(rootDir, '.runtime', '.yt-dlp-install.lock')
}

/**
 * The single effective requested version: trimmed YT_DLP_VERSION when
 * supplied, otherwise the repository default. Validates release-tag syntax.
 */
export function parseRequestedVersion(raw, fallback = DEFAULT_VERSION) {
  const value = (raw === undefined || raw === null ? '' : String(raw)).trim()
  const version = value || fallback
  if (!RELEASE_TAG_RE.test(version)) {
    throw new Error(
      `Invalid yt-dlp release tag "${version}" — expected YYYY.MM.DD (e.g. ${fallback}).`
    )
  }
  return version
}

export function effectiveRequestedVersion() {
  return parseRequestedVersion(process.env.YT_DLP_VERSION)
}

/** Asset name for the official standalone binary of the given arch. */
export function assetNameFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'yt-dlp.exe'
  if (platform !== 'linux') {
    throw new Error(
      `Unsupported platform ${platform} — bootstrap supports Linux (Freebuff Cloud) and Windows. ` +
        'Install yt-dlp yourself and point YT_DLP_PATH at it.'
    )
  }
  if (arch === 'x64') return 'yt-dlp_linux'
  if (arch === 'arm64') return 'yt-dlp_linux_aarch64'
  throw new Error(`Unsupported architecture ${arch} — use YT_DLP_PATH with a suitable binary.`)
}

function isExecutableFile(path) {
  try {
    if (!existsSync(path)) return false
    const st = statSync(path)
    return st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0)
  } catch {
    return false
  }
}

/**
 * Probe a binary's version with `--version`. Returns null when the file is
 * absent, not executable, or does not answer.
 */
export function probeVersionFile(binPath, { spawnImpl = spawnSync, timeoutMs = 10_000 } = {}) {
  if (!binPath || !existsSync(binPath)) return null
  if (process.platform !== 'win32' && !isExecutableFile(binPath)) return null
  const result = spawnImpl(binPath, ['--version'], { encoding: 'utf8', timeout: timeoutMs })
  if (result.error || result.status !== 0) return null
  return (result.stdout || '').trim() || null
}

export function computeSha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function fetchBytes(url, { fetchImpl = globalThis.fetch, timeoutMs = 120_000 } = {}) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} for ${url}`)
  }
  return { bytes: Buffer.from(await response.arrayBuffer()), response }
}

/** Find the `asset` line in the official SHA2-256SUMS text and validate it. */
export function parseSumsForAsset(sumsText, asset) {
  const expectedLine = String(sumsText)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.endsWith(`  ${asset}`) || l.endsWith(` ${asset}`))
  if (!expectedLine) {
    throw new Error(`SHA2-256SUMS does not list ${asset} — refusing to install.`)
  }
  const expectedHash = expectedLine.split(/\s+/)[0].toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error('Checksum file has an unexpected format — refusing to install.')
  }
  return expectedHash
}

export async function fetchOfficialSums(version, asset, { fetchImpl = globalThis.fetch } = {}) {
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/SHA2-256SUMS`
  // fetchBytes already consumed the body (arrayBuffer) — decode the bytes
  // instead of reading the same Response body a second time.
  const { bytes } = await fetchBytes(url, { fetchImpl })
  return parseSumsForAsset(bytes.toString('utf8'), asset)
}

// ---------------------------------------------------------------------------
// Receipt handling
// ---------------------------------------------------------------------------

/**
 * The receipt is a corruption-detection record saved only after the binary
 * passed the official checksum manifest check: { version, asset, sha256,
 * platform, arch }. Re-hashing on later starts catches accidental
 * corruption/staleness; it is not protection against an attacker who can
 * rewrite both files.
 */
export function readReceipt(rootDir = projectRoot) {
  const path = receiptPathFor(rootDir)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (
      !parsed ||
      typeof parsed.version !== 'string' ||
      typeof parsed.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.sha256) ||
      typeof parsed.asset !== 'string'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function writeReceipt(rootDir, { version, asset, sha256, platform, arch }) {
  const path = receiptPathFor(rootDir)
  writeFileSync(path, `${JSON.stringify({ version, asset, sha256, platform, arch }, null, 2)}\n`, {
    mode: 0o600
  })
}

// ---------------------------------------------------------------------------
// Bounded installation lock (prevents concurrent installers racing)
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 10 * 60 * 1000
const LOCK_MAX_WAIT_MS = 60_000

export function acquireInstallLock(rootDir = projectRoot) {
  const lockDir = lockPathFor(rootDir)
  const started = Date.now()
  for (;;) {
    try {
      // A pristine checkout has no .runtime directory yet.
      mkdirSync(dirname(lockDir), { recursive: true })
      mkdirSync(lockDir)
      return () => {
        try {
          rmSync(lockDir, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const st = statSync(lockDir)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true })
          continue
        }
      } catch {
        continue // lock vanished between mkdir failure and stat
      }
      if (Date.now() - started > LOCK_MAX_WAIT_MS) {
        throw new Error('Timed out waiting for the yt-dlp installation lock')
      }
      const waitUntil = Date.now() + 250
      while (Date.now() < waitUntil) {
        /* bounded busy wait */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

function readBytesOrNull(path) {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

/**
 * Install/verify the managed local binary. Options may inject the
 * platform/arch, network fetch and logging for tests; production callers
 * use the environment.
 *
 * Decision tree:
 *   1. installed version == requested AND receipt matches the bytes  → OK,
 *      no download;
 *   2. installed version == requested but receipt absent/stale/corrupt →
 *      verify the EXISTING bytes against the official checksum manifest and
 *      rewrite the receipt (never trust unverified bytes; manifest
 *      unreachable fails closed);
 *   3. anything else (missing/wrong version/checksum failure) → download
 *      the requested release to a unique temp path, verify HTTP status,
 *      asset filename, checksum syntax + hash, probe the temp executable's
 *      exact version, then atomically rename into place (a failed
 *      replacement never deletes an existing binary first).
 */
export async function installPinnedRuntime({
  rootDir = projectRoot,
  platform = process.platform,
  arch = process.arch,
  requested = null,
  fetchImpl = globalThis.fetch,
  force = false,
  log = (msg) => console.log(`[runtime] ${msg}`)
} = {}) {
  const version = requested || effectiveRequestedVersion()
  const asset = assetNameFor(platform, arch)
  const binPath = binaryPathFor(rootDir, platform)
  const dir = dirname(binPath)

  const release = acquireInstallLock(rootDir)
  try {
    mkdirSync(dir, { recursive: true })
    const installedVersion = probeVersionFile(binPath)

    if (!force && installedVersion === version) {
      const receipt = readReceipt(rootDir)
      const existingBytes = readBytesOrNull(binPath)
      const receiptMatchesBytes =
        receipt &&
        receipt.version === version &&
        receipt.asset === asset &&
        receipt.sha256 === computeSha256Hex(existingBytes)

      if (receiptMatchesBytes) {
        log(`yt-dlp ${installedVersion} verified (receipt) — nothing to do.`)
        return { ok: true, reason: 'already-installed', version }
      }

      // Receipt absent/stale or bytes drifted: re-verify against the OFFICIAL
      // manifest before trusting the existing binary again.
      if (existingBytes) {
        try {
          const expectedHash = await fetchOfficialSums(version, asset, { fetchImpl })
          const actualHash = computeSha256Hex(existingBytes)
          if (actualHash === expectedHash) {
            writeReceipt(rootDir, { version, asset, sha256: actualHash, platform, arch })
            log(`yt-dlp ${installedVersion} verified against the official checksum manifest.`)
            return { ok: true, reason: 'verified-existing', version }
          }
          log('Existing binary failed the official checksum — replacing it.')
        } catch (error) {
          throw new Error(
            `Receipt is missing/stale and the official checksum manifest is unreachable: ${error.message}`
          )
        }
      }
    }

    if (!force && installedVersion && installedVersion !== version) {
      log(`Installed yt-dlp is ${installedVersion}; pinned baseline is ${version} — replacing.`)
    } else {
      log(`Downloading yt-dlp ${version} (${asset}) from the official GitHub release...`)
    }

    const releaseBase = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}`
    const tmpBin = join(dir, `.tmp-${asset}-${randomBytes(6).toString('hex')}`)
    try {
      const { bytes } = await fetchBytes(`${releaseBase}/${asset}`, { fetchImpl })
      writeFileSync(tmpBin, bytes, { mode: platform === 'win32' ? 0o600 : 0o755 })
      if (platform !== 'win32') chmodSync(tmpBin, 0o755)

      log('Verifying SHA-256 against SHA2-256SUMS...')
      const expectedHash = await fetchOfficialSums(version, asset, { fetchImpl })
      const actualHash = computeSha256Hex(bytes)
      if (actualHash !== expectedHash) {
        throw new Error(
          `SHA-256 mismatch for ${asset} (expected ${expectedHash.slice(0, 16)}…, got ${actualHash.slice(0, 16)}…) — not installing.`
        )
      }

      // The temporary executable must answer the exact requested version
      // BEFORE the atomic installation.
      const tempVersion = probeVersionFile(tmpBin)
      if (tempVersion !== version) {
        throw new Error(
          `Downloaded ${asset} reports version "${tempVersion || 'unknown'}" instead of ${version} — not installing.`
        )
      }

      // Atomic replacement: never delete the existing binary first.
      renameSync(tmpBin, binPath)
      writeReceipt(rootDir, { version, asset, sha256: actualHash, platform, arch })
      log(`Installed yt-dlp ${version}.`)
      return { ok: true, reason: 'installed', version }
    } catch (error) {
      rmSync(tmpBin, { force: true })
      throw error
    }
  } finally {
    release()
  }
}

// ---------------------------------------------------------------------------
// CLI (only when executed directly)
// ---------------------------------------------------------------------------

function isMainModule() {
  const invoked = process.argv[1]
  if (!invoked) return false
  return resolve(invoked) === fileURLToPath(import.meta.url)
}

if (isMainModule()) {
  const FORCE = process.argv.includes('--force')
  installPinnedRuntime({ force: FORCE })
    .then((result) => {
      if (!result.ok) process.exitCode = 1
    })
    .catch((error) => {
      console.error(`[runtime] Bootstrap failed: ${error.message}`)
      process.exitCode = 1
    })
}
