/**
 * yt-dlp runtime resolution + version utilities.
 *
 * Executable resolution order (documented in README):
 *   1. `YT_DLP_PATH`   — explicit operator override (trusted),
 *   2. `.runtime/bin/yt-dlp` — repository-local binary installed by
 *      `npm run bootstrap:runtime` (gitignored; used on Freebuff Cloud),
 *   3. `yt-dlp` on PATH (system install).
 *
 * The version is pinned in ONE place (config.ytDlpVersion, env
 * `YT_DLP_VERSION`; default 2026.08.19). Bootstrap downloads the official
 * standalone release binary and verifies SHA-256 against the release's
 * SHA2-256SUMS before trusting it (scripts/bootstrap-runtime.mjs).
 *
 * EJS (external JavaScript challenge) support: modern yt-dlp runs YouTube's
 * JS challenges through a pluggable JS runtime. Node 22 is the supported
 * runtime here, passed as `--js-runtimes node` from the single runner —
 * never scattered across call sites.
 */

import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../../config.js'
import versionInfo from '../../config/ytdlp-version.json' with { type: 'json' }

/** yt-dlp releases are dated YYYY.MM.DD. */
export const MIN_EJS_RUNTIME_VERSION: string = versionInfo.minEjsRuntimeVersion

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/** Absolute path of the repository-local runtime directory. */
export function runtimeRootDir(): string {
  return resolve(__dirname, '../../../.runtime')
}

export function runtimeBinaryPath(): string {
  return join(runtimeRootDir(), 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
}

function isExecutableFile(path: string): boolean {
  try {
    if (!existsSync(path)) return false
    const st = statSync(path)
    return st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0)
  } catch {
    return false
  }
}

/** The resolved yt-dlp command path, or `yt-dlp` to fall back to PATH. */
export function resolveYtDlpCommand(): string {
  if (config.ytDlpPath) return config.ytDlpPath
  const local = runtimeBinaryPath()
  if (isExecutableFile(local)) return local
  return 'yt-dlp'
}

/** True when a local (bootstrap) binary is present. */
export function hasLocalRuntimeBinary(): boolean {
  return isExecutableFile(runtimeBinaryPath())
}

/** True when an explicit YT_DLP_PATH points at an executable file. */
export function hasConfiguredRuntime(): boolean {
  return !!config.ytDlpPath && isExecutableFile(config.ytDlpPath)
}

/** True when the local/configured runtime is usable (PATH fallback unknown). */
export function hasUsableRuntime(): boolean {
  return hasConfiguredRuntime() || hasLocalRuntimeBinary()
}

/** Compare two YYYY.MM.DD release strings. Returns <0, 0, >0. */
export function compareYtDlpVersions(a: string, b: string): number {
  const toTuple = (v: string): number[] =>
    v
      .trim()
      .split(/[.-]/)
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isFinite(n))
  const aa = toTuple(a)
  const bb = toTuple(b)
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const av = aa[i] || 0
    const bv = bb[i] || 0
    if (av !== bv) return av - bv
  }
  return 0
}

/** Does this version predate EJS `--js-runtimes` support? */
export function supportsJsRuntimesOption(version: string | null): boolean {
  if (!version) return false
  return compareYtDlpVersions(version, MIN_EJS_RUNTIME_VERSION) >= 0
}

/** Asset name for the official standalone Linux binary of the running arch. */
export function releaseAssetName(arch = process.arch): string | null {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform !== 'linux') return null
  if (arch === 'x64') return 'yt-dlp_linux'
  if (arch === 'arm64') return 'yt-dlp_linux_aarch64'
  return null
}

/** Human description used by readiness (never full filesystem paths). */
export function describeRuntimeState(): {
  mode: 'env' | 'local' | 'path' | 'missing'
  version: string
} {
  if (config.ytDlpPath) return { mode: 'env', version: config.ytDlpVersion }
  if (hasLocalRuntimeBinary()) return { mode: 'local', version: config.ytDlpVersion }
  return { mode: 'path', version: config.ytDlpVersion }
}
