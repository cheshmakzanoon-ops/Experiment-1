#!/usr/bin/env node
/**
 * scripts/smoke.mjs — external smoke test for a DEPLOYED Freebuff instance.
 *
 * Usage:
 *   FREEBUFF_SMOKE_KEY="<household access key>" node scripts/smoke.mjs "https://your-freebuff-url.app"
 *   # or, when the deployment runs with AUTH_DISABLED=true (dev only):
 *   node scripts/smoke.mjs "https://your-freebuff-url.app"
 *
 * The access key comes from an ENVIRONMENT VARIABLE on purpose — it must
 * never appear in shell history/arguments.
 *
 * What it verifies (all small, bounded requests — never a full video):
 *   1.  root HTML serves
 *   2.  /api/health/live succeeds
 *   3.  /api/health/ready succeeds (runtime prerequisites, cached)
 *   4.  protected API rejects anonymous access; login works (HttpOnly cookie)
 *   5.  authenticated search works
 *   6.  metadata works
 *   7.  thumbnail relay works
 *   8.  first stream range returns 206 with matching Content-Range
 *   9.  a later non-zero range works
 *  10.  suffix range works
 *  11.  malformed Range is rejected (416) — never a silent full download
 *  12.  no response leaks signed Google Video URLs
 *  13.  /api/diag/* is unavailable when diagnostics are disabled
 *
 * Failure categories reported distinctly:
 *   - freebuff_ingress   : cannot reach the Freebuff host at all
 *   - auth               : session/login problems (local application issue)
 *   - runtime_missing    : readiness 503 (yt-dlp runtime not bootstrapped)
 *   - extraction_blocked : YouTube rejects extraction from this egress IP
 *                          (EXTERNAL to the repository — egress reputation)
 *   - cdn_blocked        : metadata ok but Google Video CDN fetch blocked
 *   - range_corruption   : byte-range semantics broken through the ingress
 *   - timeout            : a step timed out
 *
 * Exit codes: 0 = all application + reachability checks passed
 *             1 = an application-level failure (auth/runtime/range/proxy)
 *             2 = reachability/app OK but YouTube egress is externally blocked
 */

const BASE = process.argv[2] || process.env.SMOKE_BASE_URL || ''
if (!BASE) {
  console.error('[smoke] Usage: FREEBUFF_SMOKE_KEY=... node scripts/smoke.mjs "https://your-freebuff-url.app"')
  process.exit(1)
}

const KEY = process.env.FREEBUFF_SMOKE_KEY || ''
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 20000)

const results = []
let jar = '' // cookie jar (ft_session=…)
let authMode = 'unknown' // 'session' | 'disabled' | 'unknown'
let extractionStatus = 'ok' // 'ok' | 'blocked'
let cdnStatus = 'ok'

function record(name, outcome, detail) {
  results.push({ name, outcome, detail: detail || '' })
  const mark = outcome === 'pass' ? '✅' : outcome === 'skip' ? '⏭️' : '❌'
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`)
}

function classifyHttp(status) {
  if (status === 429 || status === 403) return 'blocked'
  if (status >= 500) return 'server_error'
  return 'other'
}

async function request(path, options = {}, fetchOptions = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), fetchOptions.timeoutMs || TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        ...(options.json ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
        ...(jar ? { cookie: jar } : {})
      },
      body: options.body,
      redirect: 'manual',
      signal: controller.signal
    })
    const text = await response.text()
    return { status: response.status, headers: response.headers, text }
  } catch (error) {
    const timedOut = error && error.name === 'AbortError'
    return { error: timedOut ? 'timeout' : `network:${error?.message || error}` }
  } finally {
    clearTimeout(timer)
  }
}

const extractCookie = (text) => {
  const m = text.match(/(ft_session=[^;]+)/)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
console.log(`\n[smoke] Freebuff smoke test → ${BASE}\n`)

// 1. Ingress + shell --------------------------------------------------------
{
  const res = await request('/')
  if (res.error) {
    record('1. root HTML', 'fail', res.error === 'timeout' ? 'timed out' : res.error)
    console.log('\n[smoke] VERDICT: freebuff_ingress unavailable — cannot reach the host.')
    process.exit(1)
  }
  const ok = res.status === 200 && /<html/i.test(res.text)
  record('1. root HTML serves', ok ? 'pass' : 'fail', ok ? `HTTP ${res.status}` : `HTTP ${res.status}`)
  if (!ok) {
    console.log('\n[smoke] VERDICT: freebuff_ingress — root did not serve HTML.')
    process.exit(1)
  }
}

// 2. Liveness ---------------------------------------------------------------
{
  const res = await request('/api/health/live')
  const ok = !res.error && res.status === 200
  record('2. liveness /api/health/live', ok ? 'pass' : 'fail', ok ? '200' : res.error || `HTTP ${res.status}`)
  if (!ok) process.exit(1)
}

// 3. Readiness --------------------------------------------------------------
{
  const res = await request('/api/health/ready')
  if (res.error) {
    record('3. readiness', 'fail', String(res.error))
    process.exit(1)
  }
  let body = {}
  try {
    body = JSON.parse(res.text)
  } catch {
    /* ignore */
  }
  if (res.status === 503 || body.status === 'not_ready') {
    record('3. readiness', 'fail', `503 — ${body.reason || 'runtime missing'}`)
    console.log('\n[smoke] VERDICT: runtime_missing — yt-dlp/JS runtime not established on the server.')
    process.exit(1)
  }
  record('3. readiness', 'pass', `status=${body.status || res.status}`)
}

// 4. Session / auth ---------------------------------------------------------
{
  const probe = await request('/api/session')
  if (probe.error || probe.status !== 200) {
    record('4. auth', 'fail', probe.error || `HTTP ${probe.status}`)
    console.log('\n[smoke] VERDICT: auth — session endpoint unreachable.')
    process.exit(1)
  }
  let body = {}
  try {
    body = JSON.parse(probe.text)
  } catch {
    /* ignore */
  }
  authMode = body.authMode || 'session'

  if (authMode === 'disabled') {
    record('4. auth (session mode)', 'skip', 'server runs AUTH_DISABLED dev mode — nothing to verify')
  } else {
    if (!KEY) {
      record('4. auth', 'fail', 'server enforces sessions but FREEBUFF_SMOKE_KEY is not set')
      process.exit(1)
    }
    const anon = await request('/api/feed/categories')
    if (anon.status !== 401) {
      record('4. auth (anonymous rejected)', 'fail', `expected 401, got ${anon.status}`)
      process.exit(1)
    }
    record('4. auth (anonymous rejected)', 'pass', '401 without cookie')

    const login = await request('/api/session', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ key: KEY })
    })
    const cookie = extractCookie(login.headers.get('set-cookie') || '')
    if (login.status !== 200 || !cookie) {
      record('4. auth (login)', 'fail', login.status === 401 ? 'wrong key' : `HTTP ${login.status}`)
      console.log('\n[smoke] VERDICT: auth — login failed (check ACCESS_KEY).')
      process.exit(1)
    }
    jar = cookie
    record('4. auth (login)', 'pass', 'HttpOnly session cookie issued')

    const authed = await request('/api/feed/categories')
    if (authed.status !== 200) {
      record('4. auth (cookie works)', 'fail', `expected 200, got ${authed.status}`)
      process.exit(1)
    }
    record('4. auth (cookie works)', 'pass', 'authenticated request OK')
  }
}

// 5–6. Search + metadata (may hit real YouTube) -----------------------------
let sampleVideoId = null
{
  const res = await request('/api/search?q=%D9%85%D9%88%D8%B2%DB%8C%DA%A9&max=3')
  if (res.error) {
    record('5. search', 'fail', String(res.error))
    process.exit(1)
  }
  const status = res.status
  const bodyText = res.text
  let body = {}
  try {
    body = JSON.parse(bodyText)
  } catch {
    /* ignore */
  }
  const code = body && typeof body.code === 'string' ? body.code : ''

  if (status === 200 && Array.isArray(body.results) && body.results.length > 0) {
    sampleVideoId = body.results[0].id || null
    record('5. authenticated search', 'pass', `${body.results.length} result(s)`)
  } else if (status === 429 || status === 403 || /YT_BOT_WALL|YT_RATE_LIMITED|YT_EGRESS/.test(code)) {
    extractionStatus = 'blocked'
    record('5. authenticated search', 'skip', `YouTube extraction blocked from this egress (${status}/${code})`)
  } else if (status === 503 && /QUEUE|BUSY/i.test(code || '')) {
    record('5. authenticated search', 'fail', `server busy (${code})`)
    process.exit(1)
  } else {
    record('5. authenticated search', 'fail', `HTTP ${status} ${code}`)
    process.exit(1)
  }

  // Secret hygiene on the search body.
  if (!/googlevideo\.com|videoplayback|ytimg\.com\/.*signature/i.test(bodyText)) {
    record('12. no signed URLs leak (search)', 'pass')
  } else {
    record('12. no signed URLs leak (search)', 'fail', 'search body contains googlevideo/videoplayback data')
    process.exit(1)
  }
}

if (sampleVideoId) {
  const meta = await request(`/api/video/${sampleVideoId}?quality=240`)
  if (meta.status === 200) {
    if (!/googlevideo\.com|videoplayback/i.test(meta.text)) {
      record('6. metadata + no signed URL leak', 'pass')
    } else {
      record('6. metadata + no signed URL leak', 'fail', 'metadata body leaks a signed media URL')
      process.exit(1)
    }
  } else {
    const mBody = (() => {
      try {
        return JSON.parse(meta.text)
      } catch {
        return {}
      }
    })()
    const mCode = mBody.code || ''
    if (meta.status === 429 || meta.status === 403 || /YT_BOT_WALL|YT_RATE_LIMITED/.test(mCode)) {
      extractionStatus = 'blocked'
      record('6. metadata', 'skip', 'extraction blocked externally')
    } else {
      record('6. metadata', 'fail', `HTTP ${meta.status}`)
      process.exit(1)
    }
  }

  // 7. Thumbnail relay
  const thumb = await request(`/api/video/${sampleVideoId}/thumbnail`)
  if (thumb.status === 200 && thumb.text.length > 100) {
    record('7. thumbnail relay', 'pass', `${thumb.text.length} bytes`)
  } else {
    record('7. thumbnail relay', 'fail', `HTTP ${thumb.status}`)
    process.exit(1)
  }

  // 8–11. Byte ranges
  const streamBase = `/api/stream/${sampleVideoId}?quality=240`

  const first = await request(streamBase, { headers: { Range: 'bytes=0-1023' } })
  if (first.status === 206 && /^bytes 0-1023\//.test(first.headers.get('content-range') || '')) {
    record('8. stream range bytes=0-1023', 'pass', `206 ${first.text.length} bytes`)
  } else if (first.status === 429 || first.status === 403) {
    cdnStatus = 'blocked'
    record('8. stream range bytes=0-1023', 'skip', 'CDN/stream fetch blocked externally')
  } else if (first.status === 503) {
    record('8. stream range bytes=0-1023', 'fail', '503 (extraction queue busy)')
    process.exit(1)
  } else {
    record('8. stream range bytes=0-1023', 'fail', `expected 206, got ${first.status}`)
    process.exit(1)
  }

  if (first.status === 206) {
    const totalMatch = (first.headers.get('content-range') || '').match(/\/(\d+)$/)
    const total = totalMatch ? Number(totalMatch[1]) : null

    const later = await request(streamBase, { headers: { Range: 'bytes=1048576-1049600' } })
    if (later.status === 206 && /^bytes 1048576-1049600\//.test(later.headers.get('content-range') || '')) {
      record('9. non-zero range bytes=1048576-1049600', 'pass', `206 ${later.text.length} bytes`)
    } else {
      record('9. non-zero range bytes=1048576-1049600', 'fail', `expected 206, got ${later.status}`)
      process.exit(1)
    }

    const suffix = await request(streamBase, { headers: { Range: 'bytes=-1024' } })
    const sCR = suffix.headers.get('content-range') || ''
    const sRange = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(sCR)
    const suffixServed = sRange ? Number(sRange[2]) - Number(sRange[1]) + 1 : -1
    if (suffix.status === 206 && suffixServed === 1024) {
      record('10. suffix range bytes=-1024', 'pass', `206 — last 1024 bytes (${sCR})`)
    } else {
      record('10. suffix range bytes=-1024', 'fail', `expected 206 last-1024, got ${suffix.status} served=${suffixServed} (${sCR})`)
      process.exit(1)
    }

    // Malformed range must NOT become a full download.
    const malformed = await request(streamBase, { headers: { Range: 'bytes=abc-def' } })
    if (malformed.status === 416 || malformed.status === 400) {
      record('11. malformed range rejected', 'pass', `${malformed.status} — no full download`)
    } else {
      record(
        '11. malformed range rejected',
        'fail',
        `expected 416/400, got ${malformed.status} — a malformed Range must never fetch the whole video`
      )
      process.exit(1)
    }

    if (total) {
      // An unsatisfiable range reports Content-Range: bytes */TOTAL.
      const unsat = await request(streamBase, { headers: { Range: `bytes=${total + 1}-` } })
      const unsatCR = unsat.headers.get('content-range') || ''
      if (unsat.status === 416 && unsatCR === `bytes */${total}`) {
        record('11b. unsatisfiable range → 416 bytes */TOTAL', 'pass', unsatCR)
      } else if (unsat.status === 416) {
        record('11b. unsatisfiable range → 416', 'pass', `416 without total (${unsatCR || 'no content-range'})`)
      } else {
        record('11b. unsatisfiable range → 416', 'fail', `expected 416, got ${unsat.status}`)
        process.exit(1)
      }
    }
  }
}

// 13. Diagnostics are unavailable when disabled ------------------------------
{
  const res = await request('/api/diag/report')
  if (res.error) {
    record('13. diagnostics off by default', 'fail', String(res.error))
    process.exit(1)
  }
  if (res.status === 404 || res.status === 403 || res.status === 503) {
    record('13. diagnostics off by default', 'pass', `${res.status} — not exposed`)
  } else if (res.status === 200 || res.status === 401) {
    record('13. diagnostics', 'skip', `server responds ${res.status} — ENABLE_DIAGNOSTICS appears on (authorization still applies)`)
  } else {
    record('13. diagnostics', 'skip', `HTTP ${res.status}`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n' + '-'.repeat(60))
const failed = results.filter((r) => r.outcome === 'fail')
const passed = results.filter((r) => r.outcome === 'pass').length
const skipped = results.filter((r) => r.outcome === 'skip').length

if (failed.length > 0) {
  console.log(`[smoke] VERDICT: FAIL — ${failed.length} failed, ${passed} passed, ${skipped} skipped`)
  for (const f of failed) console.log(`  ❌ ${f.name}: ${f.detail}`)
  process.exit(1)
}
if (extractionStatus === 'blocked') {
  console.log(
    '[smoke] VERDICT: APPLICATION CODE HEALTHY — but YouTube extraction is BLOCKED from this egress IP (external).\n' +
    '         A different controlled egress (proxy via YT_PROXY_URL, or another host) is required; retries cannot fix it.'
  )
  process.exit(2)
}
if (cdnStatus === 'blocked') {
  console.log(
    '[smoke] VERDICT: APPLICATION CODE HEALTHY — but Google Video CDN fetches are blocked from this egress IP (external).'
  )
  process.exit(2)
}
console.log(`[smoke] VERDICT: PASS — ${passed} passed${skipped ? `, ${skipped} skipped` : ''}`)
process.exit(0)
