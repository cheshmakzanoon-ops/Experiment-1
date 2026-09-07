// runtime-bootstrap.test.mjs — the pinned-executable installer/verifier
// (Section 11). Network responses are MOCKED (fetchImpl), never the verifier
// being tested: the real filesystem writes, atomic renames, lock, version
// probes (real spawnSync of small shell fixtures) and SHA-256 logic all run.
//
//   missing install, wrong installed version, correct version + wrong hash,
//   valid receipt (no download), absent receipt (manifest re-verification),
//   stale/corrupt receipt, failed checksum fetch (fail closed), checksum
//   mismatch on a fresh download, downloaded executable probe failure,
//   explicit YT_DLP_PATH override mismatch, concurrent installers, platform
//   asset names, and an idempotent second start that downloads nothing.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assetNameFor,
  binaryNameFor,
  binaryPathFor,
  installPinnedRuntime,
  parseRequestedVersion,
  receiptPathFor,
  writeReceipt,
  computeSha256Hex
} from '../scripts/bootstrap-runtime.mjs'
import { verifyExplicitPath } from '../scripts/ensure-runtime.mjs'

const VERSION = '2026.08.19'
const OLD_VERSION = '2025.05.22'

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Shell fixture that answers `yt-dlp --version` with the given version. */
function binaryFixture(version) {
  return Buffer.from(`#!/bin/sh\necho ${version}\n`, 'utf8')
}

let roots = []

function dir() {
  const root = mkdtempSync(join(tmpdir(), 'rt-bootstrap-'))
  roots.push(root)
  return root
}

function binDir(root) {
  const path = join(root, '.runtime', 'bin')
  mkdirSync(path, { recursive: true })
  return path
}

/** Pre-place an executable managed binary that answers the given version. */
function writeManagedBin(root, version) {
  binDir(root)
  const bin = binaryPathFor(root, 'linux')
  writeFileSync(bin, binaryFixture(version))
  chmodSync(bin, 0o755)
  return bin
}

function leftoversIn(root) {
  const path = join(root, '.runtime', 'bin')
  if (!existsSync(path)) return []
  return readdirSync(path)
}

beforeEach(() => {
  roots = []
})

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/**
 * fetchImpl harness for a single release: binary bytes + the SUMS manifest.
 * opts.breakSums: throw instead of serving the manifest.
 */
function networkHarness(binBytes, { sumsFor = (bytes, asset) => `${sha256Hex(bytes)}  ${asset}\n`, breakSums = false } = {}) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (breakSums && url.endsWith('SHA2-256SUMS')) throw new Error('network unreachable')
    const isSums = url.endsWith('SHA2-256SUMS')
    // The installer reads response.arrayBuffer() AND response.text() from the
    // same object (binary downloads and the manifest alike).
    const payload = isSums ? Buffer.from(sumsFor(binBytes, 'yt-dlp_linux'), 'utf8') : binBytes
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array(payload),
      text: async () => payload.toString('utf8')
    }
  }
  return { fetchImpl, calls: () => calls.slice() }
}

async function install(rootDir, fetchImpl, overrides = {}) {
  return installPinnedRuntime({
    rootDir,
    platform: 'linux',
    arch: 'x64',
    requested: VERSION,
    fetchImpl,
    log: () => {},
    ...overrides
  })
}

describe('parseRequestedVersion + platform naming', () => {
  it('accepts release-tag syntax only and trims YT_DLP_VERSION', () => {
    expect(parseRequestedVersion(' 2026.08.19 ')).toBe('2026.08.19')
    expect(parseRequestedVersion('', '2025.05.22')).toBe('2025.05.22')
    expect(parseRequestedVersion(undefined, '2025.05.22')).toBe('2025.05.22')
    expect(() => parseRequestedVersion('v2026.08.19')).toThrow(/release tag/)
    expect(() => parseRequestedVersion('2026.8.19')).toThrow(/release tag/)
    expect(() => parseRequestedVersion('garbage')).toThrow(/release tag/)
  })

  it('selects the correct asset/binary names per platform/arch', () => {
    expect(binaryNameFor('linux')).toBe('yt-dlp')
    expect(binaryNameFor('win32')).toBe('yt-dlp.exe')
    expect(assetNameFor('linux', 'x64')).toBe('yt-dlp_linux')
    expect(assetNameFor('linux', 'arm64')).toBe('yt-dlp_linux_aarch64')
    expect(assetNameFor('win32', 'x64')).toBe('yt-dlp.exe')
    expect(() => assetNameFor('darwin', 'x64')).toThrow(/Unsupported platform/)
    expect(() => assetNameFor('linux', 'ia32')).toThrow(/Unsupported architecture/)
  })
})

describe('managed install + verification flows', () => {
  it('missing install downloads, verifies and atomically installs the pinned binary', async () => {
    const root = dir()
    const bytes = binaryFixture(VERSION)
    const { fetchImpl } = networkHarness(bytes)
    const result = await install(root, fetchImpl)
    expect(result.ok).toBe(true)
    expect(result.reason).toBe('installed')
    expect(result.version).toBe(VERSION)

    const bin = binaryPathFor(root, 'linux')
    expect(existsSync(bin)).toBe(true)
    expect((statSync(bin).mode & 0o111) !== 0).toBe(true)
    const receipt = JSON.parse(readFileSync(receiptPathFor(root), 'utf8'))
    expect(receipt.version).toBe(VERSION)
    expect(receipt.sha256).toBe(sha256Hex(bytes))
  })

  it('an idempotent second start with a valid receipt downloads nothing', async () => {
    const root = dir()
    const bytes = binaryFixture(VERSION)
    const { fetchImpl, calls } = networkHarness(bytes)
    await install(root, fetchImpl)
    const firstCalls = calls().length
    expect(firstCalls).toBe(2) // binary + SUMS

    const second = await install(root, fetchImpl)
    expect(second.reason).toBe('already-installed')
    expect(calls().length).toBe(firstCalls) // nothing was downloaded again
  })

  it('a valid receipt skips the manifest entirely', async () => {
    const root = dir()
    const bytes = binaryFixture(VERSION)
    writeManagedBin(root, VERSION)
    const { fetchImpl, calls } = networkHarness(bytes)
    writeReceipt(root, { version: VERSION, asset: 'yt-dlp_linux', sha256: sha256Hex(bytes), platform: 'linux', arch: 'x64' })

    const result = await install(root, fetchImpl)
    expect(result.reason).toBe('already-installed')
    expect(calls()).toHaveLength(0)
  })

  it('an absent receipt re-verifies the EXISTING bytes against the official manifest', async () => {
    const root = dir()
    const bytes = binaryFixture(VERSION)
    writeManagedBin(root, VERSION)
    const { fetchImpl, calls } = networkHarness(bytes)

    const result = await install(root, fetchImpl)
    expect(result.reason).toBe('verified-existing')
    expect(result.ok).toBe(true)
    // Only the SUMS manifest was fetched — never the binary again.
    expect(calls().length).toBe(1)
    expect(calls()[0]).toContain('SHA2-256SUMS')
    const receipt = JSON.parse(readFileSync(receiptPathFor(root), 'utf8'))
    expect(receipt.sha256).toBe(sha256Hex(bytes))
  })

  it('a stale/corrupt receipt behaves like an absent one (manifest re-verification)', async () => {
    const root = dir()
    const bytes = binaryFixture(VERSION)
    writeManagedBin(root, VERSION)
    writeFileSync(receiptPathFor(root), '{ not valid json', { mode: 0o600 })
    const { fetchImpl } = networkHarness(bytes)

    const result = await install(root, fetchImpl)
    expect(result.reason).toBe('verified-existing')
  })

  it('a correct-version binary with a WRONG hash is replaced after failing the manifest check', async () => {
    const root = dir()
    const good = binaryFixture(VERSION)
    // Existing bytes that drifted from the official release but still answer
    // the right version (a tampered copy, e.g. an extra trailing comment).
    const bad = Buffer.from(`#!/bin/sh\necho ${VERSION}\n# ${'x'.repeat(64)} tamper-marker\n`, 'utf8')
    expect(sha256Hex(bad)).not.toBe(sha256Hex(good))
    writeManagedBin(root, VERSION)
    writeFileSync(binaryPathFor(root, 'linux'), bad)
    chmodSync(binaryPathFor(root, 'linux'), 0o755)
    const { fetchImpl } = networkHarness(good)

    const result = await install(root, fetchImpl)
    expect(result.reason).toBe('installed') // bad bytes replaced by the good release
    expect(sha256Hex(readFileSync(binaryPathFor(root, 'linux')))).toBe(sha256Hex(good))
    const receipt = JSON.parse(readFileSync(receiptPathFor(root), 'utf8'))
    expect(receipt.sha256).toBe(sha256Hex(good))
  })

  it('a wrong installed version is replaced with the pinned one', async () => {
    const root = dir()
    writeManagedBin(root, OLD_VERSION)
    const fresh = binaryFixture(VERSION)
    const { fetchImpl } = networkHarness(fresh)

    const result = await install(root, fetchImpl)
    expect(result.reason).toBe('installed')
    expect(readFileSync(binaryPathFor(root, 'linux'), 'utf8')).toContain(VERSION)
  })

  it('an unreachable checksum manifest fails closed when the receipt is absent (existing bytes never trusted)', async () => {
    const root = dir()
    const bytes = binaryFixture(VERSION)
    writeManagedBin(root, VERSION)
    const { fetchImpl } = networkHarness(bytes, { breakSums: true })

    await expect(install(root, fetchImpl)).rejects.toThrow(/manifest is unreachable/)
    // The existing binary was NOT replaced and no receipt was fabricated.
    expect(sha256Hex(readFileSync(binaryPathFor(root, 'linux')))).toBe(sha256Hex(bytes))
    expect(existsSync(receiptPathFor(root))).toBe(false)
  })

  it('a checksum mismatch on a fresh download never installs and cleans its temp file', async () => {
    const root = dir()
    const downloaded = binaryFixture(VERSION)
    const { fetchImpl } = networkHarness(downloaded, {
      // Manifest claims a DIFFERENT hash than the downloaded bytes.
      sumsFor: () => `${'0'.repeat(64)}  yt-dlp_linux\n`
    })

    await expect(install(root, fetchImpl)).rejects.toThrow(/SHA-256 mismatch/)
    expect(existsSync(binaryPathFor(root, 'linux'))).toBe(false)
    expect(existsSync(receiptPathFor(root))).toBe(false)
    expect(leftoversIn(root).filter((f) => f.includes('.tmp'))).toHaveLength(0)
  })

  it('a downloaded executable that fails the exact-version probe is rejected and cleaned', async () => {
    const root = dir()
    // Serves a binary answering the WRONG version; hash/checksum consistent.
    const wrong = binaryFixture(OLD_VERSION)
    const { fetchImpl } = networkHarness(wrong)
    await expect(install(root, fetchImpl)).rejects.toThrow(/reports version/)
    expect(existsSync(binaryPathFor(root, 'linux'))).toBe(false)
    expect(leftoversIn(root).filter((f) => f.includes('.tmp'))).toHaveLength(0)
  })

  it('concurrent installers serialize behind the bounded lock without racing (real processes)', async () => {
    // The lock uses a bounded busy-wait that is only sound across PROCESSES
    // (each waits on its own event loop) — run two real installer processes
    // against the same root so the filesystem lock actually arbitrates.
    const root = dir()
    const bytes = binaryFixture(VERSION)
    const { spawn } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const bootstrapPath = fileURLToPath(new URL('../scripts/bootstrap-runtime.mjs', import.meta.url))

    const script = `
      import { installPinnedRuntime } from ${JSON.stringify(bootstrapPath)}
      import { createHash } from 'node:crypto'
      const sha = (b) => createHash('sha256').update(b).digest('hex')
      const V = ${JSON.stringify(VERSION)}
      const bytes = Buffer.from('#!/bin/sh\\necho ' + V + '\\n')
      let calls = 0
      const fetchImpl = async (url) => {
        calls++
        const isSums = url.endsWith('SHA2-256SUMS')
        const payload = isSums ? Buffer.from(sha(bytes) + '  yt-dlp_linux\\n', 'utf8') : bytes
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array(payload),
          text: async () => payload.toString('utf8')
        }
      }
      const res = await installPinnedRuntime({
        rootDir: process.env.RT_ROOT,
        platform: 'linux',
        arch: 'x64',
        requested: V,
        fetchImpl,
        log: () => {}
      })
      console.log(JSON.stringify({ ok: res.ok, reason: res.reason, calls }))
    `

    const runInstaller = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          env: { ...process.env, RT_ROOT: root },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let out = ''
        let err = ''
        child.stdout.on('data', (c) => (out += c))
        child.stderr.on('data', (c) => (err += c))
        child.on('close', (code) => {
          if (code !== 0) reject(new Error(`installer exited ${code}: ${err}`))
          else resolve(JSON.parse(out.trim().split('\n').pop()))
        })
      })

    const results = await Promise.all([runInstaller(), runInstaller()])
    const reasons = results.map((r) => r.reason).sort()
    expect(reasons).toEqual(['already-installed', 'installed'])
    // Exactly ONE of them downloaded (2 network calls); the other was served
    // by the winner's receipt.
    expect(results.map((r) => r.calls).sort()).toEqual([0, 2])
    expect(sha256Hex(readFileSync(binaryPathFor(root, 'linux')))).toBe(sha256Hex(bytes))
  })
})

describe('explicit YT_DLP_PATH overrides (operator-managed)', () => {
  it('requires an absolute existing executable with an EXACT version match', async () => {
    const root = dir()
    const operatorBin = join(root, 'operator-yt-dlp')
    writeFileSync(operatorBin, binaryFixture(VERSION))
    chmodSync(operatorBin, 0o755)

    expect(verifyExplicitPath('', VERSION).ok).toBe(false)
    expect(verifyExplicitPath('   ', VERSION).ok).toBe(false)
    const relative = verifyExplicitPath('operator-yt-dlp', VERSION)
    expect(relative.code).toBe('EXPLICIT_NOT_ABSOLUTE')
    expect(verifyExplicitPath(join(root, 'missing'), VERSION).code).toBe('EXPLICIT_MISSING')
    expect(verifyExplicitPath(operatorBin, VERSION).ok).toBe(true)

    // Wrong version → actionable message naming YT_DLP_VERSION.
    const mismatch = verifyExplicitPath(operatorBin, OLD_VERSION)
    expect(mismatch.code).toBe('EXPLICIT_VERSION_MISMATCH')
    expect(mismatch.message).toContain(VERSION)
    expect(mismatch.message).toContain('YT_DLP_VERSION')

    // Not runnable at all.
    const notRunnable = join(root, 'not-runnable')
    writeFileSync(notRunnable, 'hello', { mode: 0o644 })
    const probe = () => null
    expect(verifyExplicitPath(notRunnable, VERSION, { probe }).code).toBe('EXPLICIT_NOT_RUNNING')
  })

  it('never overwrites the operator file and never claims manifest verification for it', async () => {
    const root = dir()
    const operatorBin = join(root, 'operator-yt-dlp')
    const original = binaryFixture(VERSION)
    writeFileSync(operatorBin, original)
    chmodSync(operatorBin, 0o755)
    const { ensureRuntime } = await import('../scripts/ensure-runtime.mjs')

    const result = await ensureRuntime({ rootDir: root, requested: VERSION, explicitPath: operatorBin })
    expect(result.ok).toBe(true)
    expect(result.code).toBe('EXPLICIT_OK')
    expect(result.operatorManaged).toBe(true)
    expect(readFileSync(operatorBin).equals(original)).toBe(true) // untouched
    expect(existsSync(receiptPathFor(root))).toBe(false) // no fabricated receipt
  })
})

describe('helpers stay import-safe', () => {
  it('computeSha256Hex matches the crypto hash', () => {
    const bytes = Buffer.from('hello runtime')
    expect(computeSha256Hex(bytes)).toBe(sha256Hex(bytes))
  })
})
