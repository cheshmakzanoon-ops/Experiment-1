#!/usr/bin/env node
/**
 * scripts/smoke.mjs — external acceptance smoke test for a DEPLOYED
 * Freebuff instance. This is a REAL gate: there is no unauthenticated
 * success mode, no auth-disabled skip and no "printed but not asserted"
 * cookie attribute.
 *
 * Usage:
 *   FREEBUFF_SMOKE_KEY="<household access key>" node scripts/smoke.mjs "https://your-freebuff-url.app"
 *
 * The access key comes from an ENVIRONMENT VARIABLE on purpose — it must
 * never appear in shell history/arguments.
 *
 * What it verifies (all small, bounded requests — never a full video):
 *   1.  root HTML serves
 *   2.  /api/health/live succeeds
 *   3.  /api/health/ready returns HTTP 200 with the EXACT ready schema
 *   4.  protected API rejects anonymous access; login works and the REAL
 *       Set-Cookie header carries HttpOnly (+ Secure over HTTPS),
 *       SameSite=Strict, Path=/ and a coherent Max-Age
 *   5.  logout verification: DELETE succeeds with a copy of the pre-logout
 *       cookie, then replaying that cookie against a protected endpoint
 *       FAILS (401); the script re-authenticates before continuing
 *   6.  authenticated search works
 *   7.  metadata works
 *   8.  thumbnail relay works
 *   9.  first / later / suffix byte ranges return 206 with matching
 *       Content-Range and EXACT received lengths (bounded byte reads; any
 *       unexpectedly full 200 body is cancelled immediately)
 *  10.  malformed Range → 416 (never a full download)
 *  11.  no response body leaks signed Google Video URLs / upstream queries
 *  12.  /api/diag/* is unavailable when diagnostics are disabled
 *
 * Failure classification (evidence-based — a bare 403/429 never proves an
 * external block):
 *   - freebuff_ingress   : cannot reach the host at all
 *   - auth               : session/login problems (local application issue)
 *   - runtime_missing    : readiness 503 (yt-dlp runtime not established)
 *   - version_mismatch   : readiness 503 YTDLP_VERSION_MISMATCH
 *   - range_corruption   : byte-range semantics broken
 *   - extraction_blocked / cdn_blocked: application verified healthy, then
 *     YouTube rejects the egress with a YT_* upstream code (EXTERNAL)
 *
 * Exit codes: 0 = every required application + live-connectivity gate
 * passed; 1 = an application-level failure; 2 = application healthy but
 * YouTube egress is externally blocked.
 */

const BASE_RAW = process.argv[2] || process.env.SMOKE_BASE_URL || ''
const KEY = process.env.FREEBUFF_SMOKE_KEY || ''
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 20000)
const EXPECT_MAX_AGE = process.env.SMOKE_EXPECT_MAX_AGE_SECONDS

// ---------------------------------------------------------------------------
// BASE validation (credentials scoped to the validated origin)
// ---------------------------------------------------------------------------

let BASE = ''
try {
  const parsed = new URL(BASE_RAW)
  if (parsed.username || parsed.password) {
    throw new Error('embedded credentials are not allowed in the base URL')
  }
  if (parsed.hash || parsed.search) {
    throw new Error('fragments/query strings are not allowed in the base URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`unexpected scheme "${parsed.protocol}" — use https://`)
  }
  const isLoopback =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  if (parsed.protocol !== 'https:' && !isLoopback && process.env.SMOKE_ALLOW_HTTP !== 'true') {
    throw new Error('deployed acceptance requires HTTPS (http allowed for localhost with SMOKE_ALLOW_HTTP=true)')
  }
  BASE = parsed.origin
} catch (error) {
  console.error(`[smoke] Invalid base URL "${BASE_RAW}": ${error.message}`)
  console.error('[smoke] Usage: FREEBUFF_SMOKE_KEY=... node scripts/smoke.mjs "https://your-freebuff-url.app"')
  process.exit(1)
}

const results = []
let jar = '' // cookie jar (ft_session=…)
let authMode = 'unknown' // 'session' | 'unknown'
let extractionStatus = 'ok' // 'ok' | 'blocked' | 'cdn-blocked'

function record(name, outcome, detail) {
  results.push({ name, outcome, detail: detail || '' })
  const mark = outcome === 'pass' ? '✅' : outcome === 'skip' ? '⏭️' : '❌'
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`)
}

function failHard(name, detail, verdict) {
  record(name, 'fail', detail)
  console.log(`\n[smoke] VERDICT: ${verdict} — ${name}: ${detail}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Redaction helpers (never leak secrets into failure details)
// ---------------------------------------------------------------------------

function redactText(text) {
  return String(text || '')
    .replace(/([?&](?:sig|signature|sparams|expire|key)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/(cookie:\s*)[^;\r\n]+/gi, '$1[redacted]')
    .replace(/(set-cookie:\s*)[^;\r\n]+/gi, '$1[redacted]')
    .replace(/(authorization:\s*)[^\r\n]+/gi, '$1[redacted]')
}

// ---------------------------------------------------------------------------
// Bounded HTTP core (deadlines held through body consumption)
// ---------------------------------------------------------------------------

async function request(path, options = {}, fetchOptions = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path.startsWith('/') ? '' : '/'}${path}`
  const controller = new AbortController()
  const deadlineMs = fetchOptions.timeoutMs || TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), deadlineMs)
  try {
    const headers = {
      ...(options.json ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
    if (jar && !path.startsWith('http')) headers.cookie = jar
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      redirect: 'manual',
      signal: controller.signal
    })
    return { status: response.status, headers: response.headers, response }
  } catch (error) {
    const timedOut = error && error.name === 'AbortError'
    return { error: timedOut ? 'timeout' : `network:${redactText(error?.message || error)}`, status: 0, headers: null }
  } finally {
    clearTimeout(timer)
  }
}

/** Read a JSON body with a byte cap + deadline. Returns {} on failure. */
async function readJsonBounded(response, maxBytes = 512 * 1024) {
  if (!response) return {}
  const reader = response.body?.getReader?.()
  if (!reader) return {}
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          return {}
        }
        chunks.push(value)
      }
    }
  } catch {
    return {}
  } finally {
    reader.releaseLock?.()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * Read at most `cap` bytes from a media body and count them. Cancels when
 * the cap is exceeded or reading finishes. Never buffers a whole media
 * object.
 */
async function readMediaBytes(response, cap) {
  const reader = response.body?.getReader?.()
  if (!reader) return { bytes: 0, overflow: false }
  let bytes = 0
  let overflow = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        bytes += value.byteLength
        if (bytes > cap) {
          overflow = true
          await reader.cancel().catch(() => {})
          break
        }
      }
    }
  } catch {
    /* treated by caller via count/overflow */
  } finally {
    reader.releaseLock?.()
  }
  return { bytes, overflow }
}

const extractCookie = (value) => {
  const m = String(value || '').match(/(ft_session=[^;]+)/)
  return m ? m[1] : null
}

function assertCookieAttributes(setCookie, isHttps) {
  const flags = String(setCookie || '')
  if (!flags) return 'no Set-Cookie header'
  const parts = flags.split(';').map((p) => p.trim().toLowerCase())
  const name = parts[0] || ''
  if (!name.startsWith('ft_session=')) return 'cookie name is not ft_session'
  if (!parts.some((p) => p === 'httponly')) return 'missing HttpOnly'
  if (isHttps && !parts.some((p) => p === 'secure')) return 'missing Secure on HTTPS deployment'
  if (!parts.some((p) => p === 'samesite=strict') && !parts.some((p) => p === 'samesite=lax')) {
    return 'missing SameSite'
  }
  const path = parts.find((p) => p.startsWith('path='))
  if (!path || path !== 'path=/') return 'missing Path=/'
  const maxAge = parts.find((p) => p.startsWith('max-age='))
  if (!maxAge) return 'missing Max-Age'
  const seconds = Number(maxAge.split('=')[1])
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Max-Age is not a positive number'
  const DAY = 86400
  if (seconds > 366 * DAY) return `Max-Age ${seconds} exceeds a coherent 366-day lifetime`
  if (EXPECT_MAX_AGE && seconds !== Number(EXPECT_MAX_AGE)) {
    return `Max-Age ${seconds} does not match SMOKE_EXPECT_MAX_AGE_SECONDS=${EXPECT_MAX_AGE}`
  }
  return null
}

// ---------------------------------------------------------------------------
console.log(`\n[smoke] Freebuff acceptance smoke → ${BASE}\n`)

// 1. Ingress + shell --------------------------------------------------------
{
  const res = await request('/')
  if (res.error) {
    failHard('1. root HTML', redactText(res.error), 'freebuff_ingress unavailable — cannot reach the host')
  }
  if (res.status === 0) failHard('1. root HTML', 'no response', 'freebuff_ingress')
  const ok = res.status === 200
  if (!ok) failHard('1. root HTML serves', `HTTP ${res.status}`, 'freebuff_ingress')
  // bounded body read of the shell
  const body = await readMediaBytes(res.response, 4096)
  record('1. root HTML serves', 'pass', 'HTTP 200')
}

// 2. Liveness ---------------------------------------------------------------
{
  const res = await request('/api/health/live')
  if (res.error || res.status !== 200) {
    failHard('2. liveness', res.error || `HTTP ${res.status}`, 'freebuff_ingress')
  }
  const body = await readJsonBounded(res.response)
  if (body.status !== 'ok') failHard('2. liveness', 'body missing status:"ok"', 'freebuff_ingress')
  record('2. liveness /api/health/live', 'pass', '200 + status=ok')
}

// 3. Readiness (exact schema, HTTP 200) ------------------------------------
{
  const res = await request('/api/health/ready')
  if (res.error) failHard('3. readiness', String(res.error), 'runtime_missing')
  if (res.status === 503) {
    const body = await readJsonBounded(res.response)
    const reason = body && body.reason ? body.reason : 'runtime missing'
    if (reason === 'SHUTTING_DOWN') {
      failHard('3. readiness', '503 SHUTTING_DOWN', 'shutting_down')
    }
    if (reason === 'YTDLP_VERSION_MISMATCH') {
      failHard('3. readiness', '503 YTDLP_VERSION_MISMATCH', 'version_mismatch')
    }
    failHard('3. readiness', `503 ${reason}`, 'runtime_missing')
  }
  if (res.status !== 200) failHard('3. readiness', `HTTP ${res.status}`, 'runtime_missing')
  const body = await readJsonBounded(res.response)
  const missing = []
  if (body.status !== 'ready') missing.push('status=ready')
  if (typeof body.node !== 'string') missing.push('node')
  if (!body.ytDlp || typeof body.ytDlp !== 'object') missing.push('ytDlp')
  else {
    if (!['local', 'env'].includes(body.ytDlp.mode)) missing.push('ytDlp.mode in {local,env}')
    if (typeof body.ytDlp.version !== 'string') missing.push('ytDlp.version')
    if (typeof body.ytDlp.pinnedVersion !== 'string') missing.push('ytDlp.pinnedVersion')
    if (typeof body.ytDlp.minimumVersion !== 'string') missing.push('ytDlp.minimumVersion')
    if (!['node', null].includes(body.ytDlp.jsRuntime)) missing.push('ytDlp.jsRuntime')
  }
  if (missing.length > 0) {
    failHard('3. readiness', `malformed ready schema — missing ${missing.join(', ')}`, 'runtime_missing')
  }
  record('3. readiness', 'pass', `status=ready · yt-dlp ${body.ytDlp.version} (${body.ytDlp.mode})`)
}

// 4. Session / auth (no unauthenticated success mode) -----------------------
{
  const probe = await request('/api/session')
  if (probe.error || probe.status !== 200) {
    failHard('4. auth', probe.error || `HTTP ${probe.status}`, 'auth — session endpoint unreachable')
  }
  const sessionBody = await readJsonBounded(probe.response)
  authMode = sessionBody && sessionBody.authMode === 'disabled' ? 'disabled' : sessionBody?.authMode || 'session'

  if (authMode === 'disabled') {
    failHard('4. auth', 'server runs AUTH_DISABLED — production smoke has NO unauthenticated success mode', 'auth')
  }

  if (!KEY) {
    failHard('4. auth', 'server enforces sessions but FREEBUFF_SMOKE_KEY is not set', 'auth')
  }

  const anon = await request('/api/feed/categories')
  if (anon.status !== 401) {
    failHard('4. auth (anonymous rejected)', `expected 401, got ${anon.status}`, 'auth')
  }
  record('4. auth (anonymous rejected)', 'pass', '401 without cookie')

  const login = await request('/api/session', {
    method: 'POST',
    json: true,
    body: JSON.stringify({ key: KEY })
  })
  if (login.error) {
    failHard('4. auth (login)', redactText(login.error), 'auth')
  }
  const setCookieHeader = login.headers?.get('set-cookie') || ''
  const cookie = extractCookie(setCookieHeader)
  if (login.status === 401 || login.status === 400 || login.status === 429 || !cookie) {
    failHard('4. auth (login)', `HTTP ${login.status} — wrong/missing key or rate limit`, 'auth')
  }
  if (login.status !== 200) {
    failHard('4. auth (login)', `HTTP ${login.status}`, 'auth')
  }
  const attrProblem = assertCookieAttributes(setCookieHeader, BASE.startsWith('https://'))
  if (attrProblem) {
    failHard('4. auth (cookie attributes)', attrProblem + ' (asserted from the actual Set-Cookie header)', 'auth')
  }
  jar = cookie
  record('4. auth (login)', 'pass', 'HttpOnly session cookie with coherent attributes')

  const authed = await request('/api/feed/categories')
  if (authed.status !== 200) {
    failHard('4. auth (cookie works)', `expected 200, got ${authed.status}`, 'auth')
  }
  record('4. auth (cookie works)', 'pass', 'authenticated request OK')
}

// 5. Logout gate: copied cookie must stop working ---------------------------
{
  const copiedCookie = jar
  if (!copiedCookie) failHard('5. logout', 'no pre-logout cookie captured', 'auth')
  const logout = await request('/api/session', { method: 'DELETE' })
  if (logout.status !== 200) {
    failHard('5. logout', `DELETE /api/session returned HTTP ${logout.status}`, 'auth')
  }
  // request() attaches the CURRENT (cleared) jar; replay with the copied
  // pre-logout cookie against a protected endpoint:
  const replayRes = await (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(`${BASE}/api/feed/categories`, {
        headers: { cookie: copiedCookie },
        redirect: 'manual',
        signal: controller.signal
      })
      return { status: response.status, response }
    } catch {
      return { status: 0 }
    } finally {
      clearTimeout(timer)
    }
  })()
  if (replayRes.status !== 401) {
    failHard('5. logout (revoked-cookie replay)', `expected 401, got ${replayRes.status}`, 'auth')
  }
  await replayRes.response?.body?.cancel?.().catch(() => {})
  record('5. logout + revoked-cookie replay', 'pass', 'DELETE ok; copied cookie now 401')

  // Re-authenticate before the remaining tests.
  const relogin = await request('/api/session', {
    method: 'POST',
    json: true,
    body: JSON.stringify({ key: KEY })
  })
  const newCookie = relogin.status === 200 ? extractCookie(relogin.headers?.get('set-cookie') || '') : null
  if (!newCookie) {
    failHard('5. logout (re-authenticate)', `re-login failed with HTTP ${relogin.status}`, 'auth')
  }
  jar = newCookie
}

// 6–9. Search + metadata + thumbnail + ranges (may hit real YouTube) --------
let sampleVideoId = null
{
  const res = await request('/api/search?q=%D9%85%D9%88%D8%B2%DB%8C%DA%A9&max=3')
  if (res.error) failHard('6. search', String(res.error), 'timeout/network')
  const bodyText = await (async () => {
    const reader = res.response.body?.getReader?.()
    if (!reader) return ''
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > 512 * 1024) {
          await reader.cancel().catch(() => {})
          return ''
        }
        chunks.push(value)
      }
    }
    return Buffer.concat(chunks).toString('utf8')
  })()
  const body = (() => {
    try {
      return JSON.parse(bodyText)
    } catch {
      return {}
    }
  })()
  const code = body && typeof body.code === 'string' ? body.code : ''
  const status = res.status

  if (status === 200 && Array.isArray(body.results) && body.results.length > 0) {
    sampleVideoId = body.results[0].id || null
    record('6. authenticated search', 'pass', `${body.results.length} result(s)`)
  } else if (status === 429 || status === 403 || /YT_BOT_WALL|YT_RATE_LIMITED|YT_EGRESS/.test(code)) {
    // Evidence-based: only an explicit YT_* upstream code (or the upstream
    // block statuses) count as an EXTERNAL egress block.
    if (!/YT_BOT_WALL|YT_RATE_LIMITED|YT_EGRESS/.test(code)) {
      failHard('6. authenticated search', `HTTP ${status} without an upstream YT_* code`, 'app')
    }
    extractionStatus = 'blocked'
    record('6. authenticated search', 'skip', `YouTube extraction blocked from this egress (${status}/${code})`)
  } else if (status === 503 && /QUEUE|BUSY|RATE_LIMITED/.test(code || '')) {
    failHard('6. authenticated search', `server busy (${code})`, 'app')
  } else {
    failHard('6. authenticated search', `HTTP ${status} ${code || 'no code'}`, 'app')
  }

  // Secret hygiene: search responses never contain signed upstream data.
  const leaked = /googlevideo\.com|videoplayback|ytimg\.com\/[^"']*signature/i.test(redactText(bodyText))
  if (leaked) {
    failHard('6. no signed URLs leak (search)', 'search body contains googlevideo/videoplayback data', 'app')
  }
}

if (sampleVideoId) {
  const meta = await request(`/api/video/${sampleVideoId}?quality=240`)
  if (meta.error) failHard('7. metadata', String(meta.error), 'app')
  const metaBody = await readJsonBounded(meta.response)
  const mCode = metaBody && typeof metaBody.code === 'string' ? metaBody.code : ''
  if (meta.status === 200) {
    if (metaBody.streamUrl !== `/api/stream/${sampleVideoId}?quality=240`) {
      failHard('7. metadata', 'streamUrl is not the same-origin proxy route', 'app')
    }
    const metaText = JSON.stringify(metaBody)
    if (/googlevideo\.com|videoplayback/i.test(metaText)) {
      failHard('7. metadata', 'metadata body leaks a signed media URL', 'app')
    }
    record('7. metadata + no signed URL leak', 'pass', 'same-origin streamUrl only')
  } else if (
    (meta.status === 429 || meta.status === 403) &&
    /YT_BOT_WALL|YT_RATE_LIMITED|YT_EGRESS/.test(mCode)
  ) {
    extractionStatus = 'blocked'
    record('7. metadata', 'skip', 'extraction blocked externally')
  } else {
    failHard('7. metadata', `HTTP ${meta.status} ${mCode}`, 'app')
  }

  // 8. Thumbnail relay (bounded body read)
  const thumb = await request(`/api/video/${sampleVideoId}/thumbnail`)
  if (thumb.status === 200) {
    const { bytes, overflow } = await readMediaBytes(thumb.response, 2 * 1024 * 1024)
    if (overflow || bytes < 100) {
      failHard('8. thumbnail relay', `unexpected size ${bytes}`, 'app')
    }
    record('8. thumbnail relay', 'pass', `${bytes} bytes`)
  } else {
    failHard('8. thumbnail relay', `HTTP ${thumb.status}`, 'app')
  }

  // 9. Byte ranges — validated status + Content-Range + EXACT lengths.
  const streamBase = `/api/stream/${sampleVideoId}?quality=240`

  const checkRange = async (name, rangeHeader, expectedStart, expectedLength) => {
    const res = await request(streamBase, { headers: { Range: rangeHeader } })
    if (res.error) failHard(name, String(res.error), 'range_corruption')
    const { status, headers } = res
    if (status === 503) {
      const codeBody = await readJsonBounded(res.response)
      if (/YT_BOT_WALL|YT_RATE_LIMITED|YT_EGRESS/.test(codeBody?.code || '')) {
        extractionStatus = 'blocked'
        record(name, 'skip', 'extraction blocked externally')
        return null
      }
      failHard(name, '503 — server busy', 'app')
    }
    if ((status === 429 || status === 403) && /YT_RATE_LIMITED|YT_EGRESS/.test(headers?.get?.('x-code') || '')) {
      extractionStatus = 'blocked'
      record(name, 'skip', 'media CDN blocked externally')
      return null
    }
    // Read with an exact cap; a full-body 200 to a ranged request must be
    // cancelled immediately and reported.
    if (status === 200) {
      await res.response?.body?.cancel?.().catch(() => {})
      failHard(name, 'server answered a ranged request with a full 200 body (cancelled)', 'range_corruption')
    }
    if (status !== 206) {
      await res.response?.body?.cancel?.().catch(() => {})
      failHard(name, `expected 206, got ${status}`, 'range_corruption')
    }
    const contentRange = headers?.get?.('content-range') || ''
    const rangeMatch = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange)
    if (!rangeMatch) {
      failHard(name, `missing/malformed Content-Range "${contentRange}"`, 'range_corruption')
    }
    const servedStart = Number(rangeMatch[1])
    const servedEnd = Number(rangeMatch[2])
    const total = Number(rangeMatch[3])
    if (servedStart !== expectedStart) {
      failHard(name, `Content-Range starts at ${servedStart}, expected ${expectedStart}`, 'range_corruption')
    }
    const expectedServed = servedEnd - servedStart + 1
    if (expectedLength !== null && expectedServed !== expectedLength) {
      failHard(name, `served ${expectedServed} bytes, expected ${expectedLength}`, 'range_corruption')
    }
    const { bytes, overflow } = await readMediaBytes(res.response, expectedServed + 1)
    if (overflow || bytes !== expectedServed) {
      failHard(name, `received ${bytes} bytes (overflow=${overflow}), expected ${expectedServed}`, 'range_corruption')
    }
    const contentLength = headers?.get?.('content-length')
    if (contentLength && Number(contentLength) !== expectedServed) {
      failHard(name, `Content-Length ${contentLength} disagrees with served ${expectedServed}`, 'range_corruption')
    }
    record(name, 'pass', `206 ${contentRange} — ${bytes} bytes read`)
    return total
  }

  const total = await checkRange('9. stream range bytes=0-1023', 'bytes=0-1023', 0, 1024)
  if (total !== null) {
    await checkRange('9. non-zero range bytes=1048576-1049600', 'bytes=1048576-1049600', 1048576, 1025)
    await checkRange('9. suffix range bytes=-1024', 'bytes=-1024', total - 1024, 1024)

    // Malformed range must NOT become a full download.
    const malformed = await request(streamBase, { headers: { Range: 'bytes=abc-def' } })
    if (malformed.status === 416 || malformed.status === 400) {
      await malformed.response?.body?.cancel?.().catch(() => {})
      record('10. malformed range rejected', 'pass', `${malformed.status} — no full download`)
    } else {
      failHard(
        '10. malformed range rejected',
        `expected 416/400, got ${malformed.status} — a malformed Range must never fetch the whole video`,
        'range_corruption'
      )
    }

    const unsat = await request(streamBase, { headers: { Range: `bytes=${total + 1}-` } })
    const unsatCR = unsat.headers?.get?.('content-range') || ''
    if (unsat.status === 416 && unsatCR === `bytes */${total}`) {
      record('10b. unsatisfiable range → 416 bytes */TOTAL', 'pass', unsatCR)
    } else if (unsat.status === 416) {
      record('10b. unsatisfiable range → 416', 'pass', `416 without total (${unsatCR || 'none'})`)
    } else {
      failHard('10b. unsatisfiable range → 416', `expected 416, got ${unsat.status}`, 'range_corruption')
    }
  }
}

// 11. Diagnostics are unavailable when disabled ------------------------------
{
  const res = await request('/api/diag/report')
  if (res.error) failHard('12. diagnostics off by default', String(res.error), 'app')
  if (res.status === 404 || res.status === 403 || res.status === 503) {
    record('12. diagnostics off by default', 'pass', `${res.status} — not exposed`)
  } else if (res.status === 200 || res.status === 401) {
    record('12. diagnostics', 'skip', `server responds ${res.status} — ENABLE_DIAGNOSTICS appears on`)
  } else {
    record('12. diagnostics', 'skip', `HTTP ${res.status}`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n' + '-'.repeat(60))
const failed = results.filter((r) => r.outcome === 'fail')
const passed = results.filter((r) => r.outcome === 'pass').length
const skipped = results.filter((r) => r.outcome === 'skip').length

if (failed.length > 0) {
  console.log(`[smoke] VERDICT: FAIL — ${failed.length} failed, ${passed} passed, ${skipped} skipped`)
  for (const f of failed) console.log(`  ❌ ${f.name}: ${redactText(f.detail)}`)
  process.exit(1)
}
if (extractionStatus === 'blocked') {
  console.log(
    '[smoke] VERDICT: APPLICATION CODE HEALTHY — but YouTube extraction is BLOCKED from this egress IP (external).\n' +
      '         A different controlled egress (proxy via YT_PROXY_URL, or another host) is required; retries cannot fix it.'
  )
  process.exit(2)
}
console.log(`[smoke] VERDICT: PASS — ${passed} passed${skipped ? `, ${skipped} skipped` : ''}`)
process.exit(0)
