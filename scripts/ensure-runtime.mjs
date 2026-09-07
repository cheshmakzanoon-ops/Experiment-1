#!/usr/bin/env node
/**
 * ensure-runtime.mjs — idempotent runtime verification used by `prestart`.
 *
 *   - When YT_DLP_PATH is set, only validates that the binary answers
 *     `--version` (the operator owns that install).
 *   - Otherwise it verifies the repository-local .runtime/bin/yt-dlp and
 *     bootstraps it (with SHA-256 verification) when missing or stale.
 *
 * A second invocation never re-downloads a valid installed binary.
 *
 * Usage:  node scripts/ensure-runtime.mjs [--quiet]
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const quiet = process.argv.includes('--quiet')
const log = quiet ? () => {} : (msg) => console.log(msg)

function versionOf(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (result.error || result.status !== 0) return null
  const version = (result.stdout || '').trim()
  return version || null
}

async function main() {
  const explicit = process.env.YT_DLP_PATH
  if (explicit) {
    const version = versionOf(explicit)
    if (version) {
      log(`[runtime] YT_DLP_PATH resolves (yt-dlp ${version}).`)
      process.exit(0)
    }
    console.error(`[runtime] YT_DLP_PATH is set to "${explicit}" but does not run — fix the path.`)
    process.exit(1)
  }

  const localBin = join(projectRoot, '.runtime', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  const localVersion = existsSync(localBin) ? versionOf(localBin) : null
  if (localVersion) {
    log(`[runtime] Local runtime OK (.runtime/bin/yt-dlp ${localVersion}).`)
    process.exit(0)
  }

  // Nothing local: try a system yt-dlp before downloading.
  const systemVersion = versionOf('yt-dlp')
  if (systemVersion) {
    log(`[runtime] Using system yt-dlp ${systemVersion}.`)
    process.exit(0)
  }

  log('[runtime] No usable yt-dlp — bootstrapping the pinned standalone binary...')
  const { spawnSync: run } = await import('node:child_process')
  const result = run(process.execPath, [join(scriptDir, 'bootstrap-runtime.mjs')], {
    stdio: 'inherit',
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    console.error('[runtime] Bootstrap failed — the server will not be ready (readiness reports RUNTIME_MISSING).')
    process.exit(1)
  }
  const after = versionOf(localBin)
  if (!after) {
    console.error('[runtime] Bootstrap completed but the binary still does not run.')
    process.exit(1)
  }
  log(`[runtime] Runtime ready (yt-dlp ${after}).`)
  process.exit(0)
}

main()
