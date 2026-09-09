// build-shell-manifest.mjs — build-time shell manifest generator (F01/F02).
//
// Walks the REAL local module graph (import/export-from statements in
// index.html + every reachable /js/*.js module), collects every referenced
// same-origin static resource (stylesheets, fonts, icons, documents) and
// emits src/frontend/js/shell-manifest.js containing:
//
//   export const SHELL_GENERATION  — content-derived release identity
//   export const SHELL_PATHS       — every file a cold offline launch needs
//
// The generation id is the SHA-256 of (sorted path list + per-file content
// hashes), so ANY source change produces a new generation. The generated
// module is plain ESM the service worker imports as a module worker, and
// tests import it directly to validate paths against the actual files on
// disk (existence asserted, never a hand-maintained list).
//
// Run automatically via `npm run build` (prebuild) and `npm test` (pretest).

import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FRONTEND = join(ROOT, 'src', 'frontend')
const OUT_FILE = join(FRONTEND, 'js', 'shell-manifest.js')

/** Read a file relative to the frontend root (null when missing). */
async function readFrontendFile(relPath) {
  const abs = join(FRONTEND, relPath)
  if (!existsSync(abs)) return null
  try {
    const s = await stat(abs)
    if (!s.isFile()) return null
    return await readFile(abs, 'utf8')
  } catch {
    return null
  }
}

/**
 * Normalize an index.html asset reference to a frontend-root path.
 * Accepts root-relative ("styles/fonts.css") and absolute ("/js/app.js")
 * references; external URLs and fragments are never precached.
 */
function normalizeHtmlPath(value) {
  const trimmed = value.split('#')[0].split('?')[0].trim()
  if (!trimmed) return null
  if (/^(https?:)?\/\//i.test(trimmed)) return null
  if (trimmed.startsWith('/')) return trimmed
  if (trimmed.startsWith('.')) return null
  return `/${trimmed}`
}

/** Extract same-origin asset paths referenced by index.html. */
function pathsFromHtml(html) {
  const paths = new Set()
  const patterns = [
    /<link[^>]+href="([^"]*)"/gi,
    /<script[^>]+src="([^"]*)"/gi,
    /<img[^>]+src="([^"]*)"/gi
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(html)) !== null) {
      const normalized = normalizeHtmlPath(m[1])
      if (normalized) paths.add(normalized)
    }
  }
  return [...paths]
}

/** Extract static same-origin imports / fetches / asset refs from a JS module. */
function pathsFromModule(source) {
  const paths = new Set()
  const importRe = /(?:^|\n)\s*(?:import|export)\s*(?:[^'"]*from\s*)?['"](\.{0,2}\/[^'"]+)['"]/g
  let m
  while ((m = importRe.exec(source)) !== null) {
    paths.add(m[1])
  }
  return [...paths]
}

/**
 * Resolve an import specifier found inside `fromPath` (a frontend-root
 * path such as /js/components/videoCard.js) to another frontend-root path.
 * /js/… specifiers are root-relative; ./ and ../ walk from the module.
 */
function resolveImportPath(fromPath, specifier) {
  if (specifier.startsWith('/')) return specifier
  const baseParts = fromPath.split('/').slice(0, -1) // directory segments
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') baseParts.pop()
    else baseParts.push(segment)
  }
  return baseParts.join('/')
}

/** Static font/icon/url() references inside CSS (fonts.css → woff2 files). */
function cssUrlPaths(cssPath, source) {
  const paths = new Set()
  const urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g
  let m
  while ((m = urlRe.exec(source)) !== null) {
    const resolved = resolveImportPath(cssPath, m[1].trim())
    paths.add(resolved)
  }
  return [...paths]
}

async function walkModuleGraph(entryPath, visited) {
  const source = await readFrontendFile(entryPath)
  if (source === null) return
  for (const raw of pathsFromModule(source)) {
    const resolved = resolveImportPath(entryPath, raw)
    if (visited.has(resolved)) continue
    visited.add(resolved)
    await walkModuleGraph(resolved, visited)
  }
  if (entryPath.endsWith('.css')) {
    for (const p of cssUrlPaths(entryPath, source)) {
      if (!visited.has(p)) {
        visited.add(p)
        await walkModuleGraph(p, visited)
      }
    }
  }
}

/** Public entry. Returns { generation, paths, missing }. */
export async function buildShellManifest() {
  const html = await readFrontendFile('index.html')
  if (html === null) throw new Error('src/frontend/index.html is missing')

  const paths = new Set(['/', '/index.html'])
  for (const p of pathsFromHtml(html)) paths.add(p)
  // The service worker itself is a module worker: it (and its own import
  // graph — sw-policy.js, shell-manifest.js) must precache too, otherwise a
  // cold offline launch of the WORKER fails even when the page is cached.
  paths.add('/sw.js')
  for (const p of [...paths]) {
    if (/^\/js\/.*\.js$/.test(p) || p === '/sw.js') await walkModuleGraph(p, paths)
    if (p.endsWith('.css')) await walkModuleGraph(p, paths) // css url() refs
  }

  // Verify every path exists on disk and record its content hash.
  const verified = []
  const missing = []
  for (const rel of [...paths].sort()) {
    const abs = join(FRONTEND, rel)
    if (!existsSync(abs)) {
      // `/` maps to index.html — not missing.
      if (rel !== '/') missing.push(rel)
      continue
    }
    const s = await stat(abs)
    if (!s.isFile()) continue
    const content = await readFile(abs)
    verified.push(rel)
    hashes.set(rel, createHash('sha256').update(content).digest('hex'))
  }

  // The identity is derived from SHELL CONTENT only — the generated manifest
  // file itself is excluded so the id is stable across regenerations (a
  // self-referential hash would change on every run).
  const identityInput = verified
    .filter((p) => p !== '/js/shell-manifest.js')
    .map((p) => [p, hashes.get(p)])
  const identity = createHash('sha256')
    .update(JSON.stringify(identityInput))
    .digest('hex')
    .slice(0, 16)

  return { generation: `sh-${identity}`, paths: verified, missing }
}

const hashes = new Map()

async function main() {
  const { generation, paths, missing } = await buildShellManifest()
  if (missing.length > 0) {
    console.error('[shell-manifest] Referenced shell files are MISSING on disk:')
    for (const p of missing) console.error(`  - ${p}`)
    throw new Error('Shell manifest references files that do not exist')
  }

  await mkdir(dirname(OUT_FILE), { recursive: true })
  const banner = `// shell-manifest.js — GENERATED by scripts/build-shell-manifest.mjs. DO NOT EDIT.
// Content-derived shell generation + verified precache paths (F01/F02).
// Regenerate: node scripts/build-shell-manifest.mjs (run by prebuild/pretest).
`
  const body = `export const SHELL_GENERATION = ${JSON.stringify(generation)};\nexport const SHELL_PATHS = ${JSON.stringify(paths, null, 4)};\n`
  await writeFile(OUT_FILE, banner + body, 'utf8')
  console.log(`[shell-manifest] ${generation}: ${paths.length} shell files verified`)
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
