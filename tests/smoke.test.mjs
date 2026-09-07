// smoke.test.mjs — scripts/smoke.mjs is a REAL acceptance gate; these tests
// run it against a local fixture HTTP server and assert PROCESS EXIT STATUS
// (never just printed words):
//
//   disabled auth → exit 1 (no unauthenticated success mode)
//   missing FREEBUFF_SMOKE_KEY → exit 1
//   cookie attributes asserted from the actual Set-Cookie header → exit 1
//   malformed readiness schema → exit 1
//   full HTTP 200 answer to a ranged request → exit 1 (range_corruption)
//   incorrect 206 length / Content-Length disagreement → exit 1
//   revoked-cookie replay stays valid after logout → exit 1 (logout gate)
//   explicit YT_BOT_WALL upstream code → exit 2 (external block)
//   a healthy fixture → exit 0 (every gate passes)

import { describe, expect, it, afterAll } from 'vitest'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SCRIPT = fileURLToPath(new URL('../scripts/smoke.mjs', import.meta.url))
const KEY = 'smoke-access-key-0123456789abcdef'
const TOTAL = 5_000_000
const payload = Buffer.alloc(TOTAL)
for (let i = 0; i < TOTAL; i++) payload[i] = (i * 31 + 7) % 256

const COOKIE_NAME = 'ft_session'
const SAMPLE_COOKIE = 'tok-smoke-0001'

function parseRange(header) {
  if (!header) return null
  const m = /^bytes=(\d+)-(\d+)$/.exec(header)
  if (m) {
    const start = Number(m[1])
    const end = Number(m[2])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null
    return { start, end }
  }
  const suffix = /^bytes=-(\d+)$/.exec(header)
  if (suffix) {
    const n = Number(suffix[1])
    if (!Number.isSafeInteger(n) || n <= 0) return null
    return { start: TOTAL - n, end: TOTAL - 1 }
  }
  const open = /^bytes=(\d+)-$/.exec(header)
  if (open) {
    const start = Number(open[1])
    if (!Number.isSafeInteger(start) || start < 0) return null
    return { start, end: TOTAL - 1 }
  }
  return null
}

/**
 * Fixture server simulating the app surface the smoke script exercises.
 * Options: authMode, keepAfterLogout, ready, streamMode ('ok' | 'full200' |
 * 'bad206'), search ('ok' | 'botwall'), cookieFlags.
 */
async function startFixture(opts = {}) {
  const liveSessions = new Set()
  const seen = { ranges: [] }
  const server = createServer((req, res) => {
    const url = req.url || '/'
    const cookieHeader = req.headers.cookie || ''
    const cookie = (cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`)) || [])[1] || ''
    const authed = cookie !== '' && liveSessions.has(cookie)

    const json = (code, body, status, extraHeaders = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
      res.end(JSON.stringify(body))
      return
    }
    const noop = () => {}

    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><html lang="fa"><head><title>fixture</title></head><body></body></html>')
      return
    }
    if (url === '/api/health/live' || url === '/api/health') {
      json('', { status: 'ok' }, 200)
      return
    }
    if (url === '/api/health/ready') {
      const ready = opts.ready || {}
      if (ready.status503) {
        json('', { status: 'not_ready', reason: ready.reason || 'RUNTIME_MISSING' }, 503)
        return
      }
      if (ready.malformed) {
        json('', { status: 'ready', node: 'v22.0.0' }, 200) // missing ytDlp
        return
      }
      json(
        '',
        {
          status: 'ready',
          node: 'v22.0.0',
          ytDlp: {
            mode: 'local',
            version: '2026.08.19',
            pinnedVersion: '2026.08.19',
            minimumVersion: '2024.04.01',
            jsRuntime: 'node'
          }
        },
        200
      )
      return
    }
    if (url === '/api/session' && req.method === 'GET') {
      const disabled = opts.authMode === 'disabled'
      json('', { authenticated: disabled ? true : authed, authMode: disabled ? 'disabled' : 'session' }, 200)
      return
    }
    if (url === '/api/session' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        if (opts.authMode === 'disabled') {
          json('', { authenticated: true, authMode: 'disabled' }, 200)
          return
        }
        let key = null
        try {
          key = JSON.parse(raw).key
        } catch {
          key = null
        }
        if (key !== KEY) {
          json('', { error: 'Invalid access key', code: 'AUTH_INVALID' }, 401)
          return
        }
        liveSessions.add(SAMPLE_COOKIE)
        const flags = opts.cookieFlags ?? 'HttpOnly; Path=/; SameSite=Strict; Max-Age=2592000'
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': `${COOKIE_NAME}=${SAMPLE_COOKIE}; ${flags}`
        })
        res.end(JSON.stringify({ authenticated: true }))
      })
      return
    }
    if (url === '/api/session' && req.method === 'DELETE') {
      if (!opts.keepAfterLogout) liveSessions.delete(cookie)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ authenticated: false }))
      return
    }
    if (url === '/api/feed/categories') {
      if (!authed) json('', { error: 'Authentication required', code: 'AUTH_REQUIRED' }, 401)
      else json('', { categories: [] }, 200)
      return
    }
    if (url.startsWith('/api/search')) {
      if (opts.search === 'botwall') {
        json('', { error: 'YouTube block', code: 'YT_BOT_WALL' }, 429)
        return
      }
      json('', { results: [{ id: 'smokevid1', title: 'Smoke Fixture', duration: 60 }] }, 200)
      return
    }
    if (url.startsWith('/api/video/smokevid1/thumbnail')) {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(512) })
      res.end(Buffer.alloc(512, 42))
      return
    }
    if (url.startsWith('/api/video/smokevid1')) {
      json('', { id: 'smokevid1', streamUrl: '/api/stream/smokevid1?quality=240' }, 200)
      return
    }
    if (url.startsWith('/api/stream/smokevid1')) {
      const range = parseRange(req.headers.range || '')
      if (opts.streamMode === 'full200') {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(payload.length) })
        res.end(payload)
        return
      }
      if (!range) {
        // Malformed → 416, never a full download.
        res.writeHead(416, { 'content-range': 'bytes */*' })
        res.end()
        return
      }
      seen.ranges.push(range)
      if (range.start >= TOTAL) {
        res.writeHead(416, { 'content-range': `bytes */${TOTAL}` })
        res.end()
        return
      }
      if (opts.streamMode === 'bad206') {
        const body = payload.subarray(0, 1024)
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-range': 'bytes 0-1023/' + TOTAL,
          'content-length': '900', // lies about what it sends
          etag: '"fixture-v1"'
        })
        res.end(body)
        return
      }
      const end = Math.min(range.end, TOTAL - 1)
      const body = payload.subarray(range.start, end + 1)
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-range': `bytes ${range.start}-${end}/${TOTAL}`,
        'content-length': String(body.length),
        etag: '"fixture-v1"'
      })
      res.end(body)
      return
    }
    if (url.startsWith('/api/diag/')) {
      json('', { error: 'Not found' }, 404)
      return
    }
    noop()
    json('', { error: 'Not found' }, 404)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

let fixture = null

async function runSmoke(url, key, extraEnv = {}) {
  const env = { ...process.env, SMOKE_ALLOW_HTTP: 'true', ...extraEnv }
  if (key !== undefined) env.FREEBUFF_SMOKE_KEY = key
  else delete env.FREEBUFF_SMOKE_KEY
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, url], { env, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code ?? 1) : 0,
        out: `${stdout}\n${stderr}`
      })
    })
  })
}

afterAll(async () => {
  if (fixture) await fixture.close()
})

describe('scripts/smoke.mjs acceptance gates (real exit codes)', () => {
  it('exits 1 when the server runs AUTH_DISABLED — no unauthenticated success mode', async () => {
    fixture = await startFixture({ authMode: 'disabled' })
    const result = await runSmoke(fixture.url, undefined)
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/unauthenticated success mode/i)
    await fixture.close()
    fixture = null
  })

  it('exits 1 when FREEBUFF_SMOKE_KEY is missing but sessions are enforced', async () => {
    fixture = await startFixture({ authMode: 'session' })
    const result = await runSmoke(fixture.url, undefined)
    expect(result.code).toBe(1)
    expect(result.out).toContain('FREEBUFF_SMOKE_KEY is not set')
    await fixture.close()
    fixture = null
  })

  it('exits 1 when the REAL Set-Cookie header lacks required attributes', async () => {
    fixture = await startFixture({ authMode: 'session', cookieFlags: 'Path=/; SameSite=Strict; Max-Age=2592000' })
    const result = await runSmoke(fixture.url, KEY)
    expect(result.code).toBe(1)
    expect(result.out).toContain('cookie attributes')
    expect(result.out).toContain('missing HttpOnly')
    await fixture.close()
    fixture = null
  })

  it('exits 1 when readiness answers 200 with a malformed schema', async () => {
    fixture = await startFixture({ authMode: 'session', ready: { malformed: true } })
    const result = await runSmoke(fixture.url, KEY)
    expect(result.code).toBe(1)
    expect(result.out).toContain('malformed ready schema')
    await fixture.close()
    fixture = null
  })

  it('exits 1 when a ranged request is answered with a full HTTP 200 body', async () => {
    fixture = await startFixture({ authMode: 'session', streamMode: 'full200' })
    const result = await runSmoke(fixture.url, KEY)
    expect(result.code).toBe(1)
    expect(result.out).toContain('full 200')
    await fixture.close()
    fixture = null
  })

  it('exits 1 when the 206 Content-Length disagrees with what is served', async () => {
    fixture = await startFixture({ authMode: 'session', streamMode: 'bad206' })
    const result = await runSmoke(fixture.url, KEY)
    expect(result.code).toBe(1)
    // The lying Content-Length truncates the client read — the exact-byte
    // counter reports fewer bytes than the Content-Range promised.
    expect(result.out).toContain('received 900 bytes')
    await fixture.close()
    fixture = null
  })

  it('exits 1 when a copied cookie still works after logout (revoked-cookie replay gate)', async () => {
    fixture = await startFixture({ authMode: 'session', keepAfterLogout: true })
    const result = await runSmoke(fixture.url, KEY)
    expect(result.code).toBe(1)
    expect(result.out).toContain('revoked-cookie replay')
    await fixture.close()
    fixture = null
  })

  it('exits 2 with an evidence-based EXTERNAL block verdict for an explicit YT_BOT_WALL', async () => {
    fixture = await startFixture({ authMode: 'session', search: 'botwall' })
    const result = await runSmoke(fixture.url, KEY)
    expect(result.code).toBe(2)
    expect(result.out).toContain('APPLICATION CODE HEALTHY')
    expect(result.out).toContain('blocked')
    await fixture.close()
    fixture = null
  })

  it('passes every gate against a healthy fixture and verifies byte ranges', async () => {
    fixture = await startFixture({ authMode: 'session' })
    const result = await runSmoke(fixture.url, KEY)
    expect(result.code).toBe(0)
    expect(result.out).toContain('VERDICT: PASS')
    // The three byte-range probes actually reached the fixture with the
    // exact starts the smoke script demands.
    const starts = fixture.seen.ranges.map((r) => r.start)
    expect(starts).toContain(0)
    expect(starts).toContain(1048576)
    expect(starts).toContain(TOTAL - 1024)
    await fixture.close()
    fixture = null
  })
})
