#!/usr/bin/env node
/**
 * bootstrap-runtime.mjs — install the pinned yt-dlp standalone binary into
 * .runtime/bin/ (gitignored). Works on Freebuff Cloud (no Docker, no pip):
 * the binary is an official standalone release executable.
 *
 *   - version comes from src/config/ytdlp-version.json (single source),
 *     overridable with YT_DLP_VERSION,
 *   - asset is architecture-aware (x86_64 → yt-dlp_linux,
 *     arm64 → yt-dlp_linux_aarch64),
 *   - SHA-256 is verified against the official release SHA2-256SUMS before
 *     the binary is trusted,
 *   - idempotent: a valid installed binary of the right version is never
 *     re-downloaded.
 *
 * Usage:  node scripts/bootstrap-runtime.mjs [--force]
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const versionInfo = JSON.parse(
  readFileSync(join(projectRoot, 'src/config/ytdlp-version.json'), 'utf8')
)

const VERSION = process.env.YT_DLP_VERSION || versionInfo.defaultVersion
const FORCE = process.argv.includes('--force')
const BIN_DIR = join(projectRoot, '.runtime', 'bin')
const BIN_PATH = join(BIN_DIR, 'yt-dlp')
const RELEASE_BASE = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}`

function assetName() {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform !== 'linux') {
    throw new Error(
      `Unsupported platform ${process.platform} — bootstrap supports Linux (Freebuff Cloud) and Windows. ` +
        'Install yt-dlp yourself and point YT_DLP_PATH at it.'
    )
  }
  if (process.arch === 'x64') return 'yt-dlp_linux'
  if (process.arch === 'arm64') return 'yt-dlp_linux_aarch64'
  throw new Error(`Unsupported architecture ${process.arch} — use YT_DLP_PATH with a suitable binary.`)
}

function installedVersion() {
  if (!existsSync(BIN_PATH)) return null
  const result = spawnSync(BIN_PATH, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0) return null
  return (result.stdout || '').trim() || null
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} for ${url}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  writeFileSync(dest, bytes)
  return bytes
}

async function main() {
  const asset = assetName()
  const current = installedVersion()

  if (!FORCE && current === VERSION) {
    console.log(`[runtime] yt-dlp ${current} already installed at .runtime/bin/yt-dlp — nothing to do.`)
    return
  }
  if (!FORCE && current) {
    console.log(`[runtime] Installed yt-dlp is ${current}; pinned baseline is ${VERSION} — replacing.`)
  }

  console.log(`[runtime] Downloading yt-dlp ${VERSION} (${asset}) from the official GitHub release...`)
  mkdirSync(BIN_DIR, { recursive: true })

  const tmpBin = join(BIN_DIR, `.tmp-${asset}`)
  try {
    const binary = await download(`${RELEASE_BASE}/${asset}`, tmpBin)
    if (process.platform !== 'win32') chmodSync(tmpBin, 0o755)

    // Verify SHA-256 against the official checksum list before trusting it.
    console.log('[runtime] Verifying SHA-256 against SHA2-256SUMS...')
    const sumsText = await (await fetch(`${RELEASE_BASE}/SHA2-256SUMS`)).text()
    const expectedLine = sumsText
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
    const actualHash = createHash('sha256').update(binary).digest('hex')
    if (actualHash !== expectedHash) {
      throw new Error(
        `SHA-256 mismatch for ${asset} (expected ${expectedHash.slice(0, 16)}…, got ${actualHash.slice(0, 16)}…) — not installing.`
      )
    }
    console.log('[runtime] SHA-256 verified.')

    renameSync(tmpBin, BIN_PATH)

    const verify = spawnSync(BIN_PATH, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    if (verify.status !== 0) {
      rmSync(BIN_PATH, { force: true })
      throw new Error('Installed binary did not execute — removed. Check the platform/architecture.')
    }
    console.log(`[runtime] Installed yt-dlp ${(verify.stdout || '').trim()} at .runtime/bin/yt-dlp`)
  } catch (error) {
    rmSync(tmpBin, { force: true })
    console.error(`[runtime] Bootstrap failed: ${error.message}`)
    process.exitCode = 1
  }
}

main()
