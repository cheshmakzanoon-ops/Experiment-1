#!/usr/bin/env node
/**
 * ensure-runtime.mjs — idempotent runtime verification used by `prestart`
 * and by direct server startup (src/index.ts spawns this same script as a
 * bounded child before probing).
 *
 *   - One effective requested version: trimmed YT_DLP_VERSION, otherwise
 *     src/config/ytdlp-version.json `defaultVersion` (release-tag syntax
 *     validated).
 *   - YT_DLP_PATH (operator-managed): REQUIRES an absolute executable path
 *     AND an exact effective-version match; the operator's file is never
 *     overwritten and no official checksum verification is claimed for it.
 *   - Otherwise the MANAGED repository-local binary
 *     (.runtime/bin/yt-dlp[.exe]) must exist with the EXACT requested
 *     version, executable permissions and a matching SHA-256 (receipt, or
 *     the official checksum manifest when the receipt is absent). Missing
 *     or wrong → install from the pinned official release.
 *
 * A second invocation never re-downloads a valid installed binary.
 *
 * Usage:  node scripts/ensure-runtime.mjs [--quiet]
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  binaryNameFor,
  binaryPathFor,
  effectiveRequestedVersion,
  installPinnedRuntime,
  parseRequestedVersion,
  probeVersionFile,
  projectRoot
} from './bootstrap-runtime.mjs'

// Re-export for tests/importing tooling.
export { projectRoot, parseRequestedVersion, binaryPathFor, binaryNameFor }

/**
 * Verify an operator-provided YT_DLP_PATH. The file must be an absolute,
 * executable path answering --version with EXACTLY the effective requested
 * version. Never modified; never claimed as official-checksum-verified.
 */
export function verifyExplicitPath(
  explicitPath,
  requestedVersion,
  { probe = probeVersionFile } = {}
) {
  const trimmed = String(explicitPath || '').trim()
  if (!trimmed) {
    return { ok: false, code: 'EXPLICIT_EMPTY', message: 'YT_DLP_PATH is empty.' }
  }
  if (!isAbsolute(trimmed)) {
    return {
      ok: false,
      code: 'EXPLICIT_NOT_ABSOLUTE',
      message:
        `YT_DLP_PATH must be an absolute executable path (got "${trimmed}"). ` +
        'Point it at a yt-dlp binary and never at a bare command name.'
    }
  }
  if (!existsSync(trimmed)) {
    return {
      ok: false,
      code: 'EXPLICIT_MISSING',
      message: `YT_DLP_PATH "${trimmed}" does not exist.`
    }
  }
  const detected = probe(trimmed)
  if (!detected) {
    return {
      ok: false,
      code: 'EXPLICIT_NOT_RUNNING',
      message: `YT_DLP_PATH "${trimmed}" does not run \`yt-dlp --version\` (check the file/permissions).`
    }
  }
  if (detected !== requestedVersion) {
    return {
      ok: false,
      code: 'EXPLICIT_VERSION_MISMATCH',
      message:
        `YT_DLP_PATH reports yt-dlp ${detected}, but the effective requested version is ${requestedVersion}. ` +
        `Either point YT_DLP_PATH at a ${requestedVersion} binary or set YT_DLP_VERSION=${detected} to pin that version explicitly.`
    }
  }
  return { ok: true, code: 'EXPLICIT_OK', detected }
}

/**
 * Ensure the executable actually pinned for this run is in place. Returns
 * { ok, reason, version, operatorManaged } or { ok:false, code, message }.
 */
export async function ensureRuntime({
  rootDir = projectRoot,
  requested = null,
  explicitPath = null,
  fetchImpl = globalThis.fetch,
  log = () => {}
} = {}) {
  let requestedVersion
  try {
    requestedVersion = requested || effectiveRequestedVersion()
  } catch (error) {
    return { ok: false, code: 'INVALID_VERSION', message: error.message }
  }

  const explicit = explicitPath !== null ? explicitPath : (process.env.YT_DLP_PATH || '').trim()
  if (explicit) {
    const verification = verifyExplicitPath(explicit, requestedVersion)
    if (!verification.ok) return verification
    log(`Operator-managed yt-dlp ${verification.detected} at ${explicit} (exact match).`)
    return {
      ok: true,
      code: 'EXPLICIT_OK',
      version: requestedVersion,
      operatorManaged: true,
      detected: verification.detected
    }
  }

  try {
    const installed = await installPinnedRuntime({ rootDir, requested: requestedVersion, fetchImpl, log })
    return { ok: true, ...installed, operatorManaged: false }
  } catch (error) {
    return { ok: false, code: 'MANAGED_INSTALL_FAILED', message: error.message }
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
  const quiet = process.argv.includes('--quiet')
  const log = quiet
    ? () => {}
    : (msg) => console.log(msg)
  const rootDir = projectRoot

  ensureRuntime({ rootDir, log }).then((result) => {
    if (result.ok) {
      if (!quiet) {
        const mode = result.operatorManaged
          ? 'YT_DLP_PATH (operator-managed)'
          : '.runtime/bin/yt-dlp (managed)'
        console.log(`[runtime] Runtime ready — yt-dlp ${result.version} (${mode}).`)
      }
      process.exit(0)
      return
    }
    console.error(`[runtime] ${result.message}`)
    process.exit(1)
  })
}
