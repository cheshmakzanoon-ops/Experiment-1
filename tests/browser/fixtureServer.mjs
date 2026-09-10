// Shared real-HTTP fixture server for browser specs (A03/A05/A10).
// Serves the SHIPPED src/frontend tree verbatim plus a deterministic Range
// backend, so tests drive the real offlineService.js + api.js modules.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const TOTAL = 1024 * 1024 // 1 MiB source → one 2 MiB-chunk download

/** Deterministic source bytes so byte-level assertions are stable. */
export function sourceBytes(total = TOTAL) {
    const bytes = new Uint8Array(total)
    for (let i = 0; i < total; i++) bytes[i] = (i * 31 + 7) & 0xff
    return bytes
}

export function startFixtureServer() {
    const SOURCE = sourceBytes()
    const shell = `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>fixture</title></head>
<body><div id="authGate"></div><div id="app"></div></body></html>`

    // Cross-context gating: hold the FIRST range request for vid-cross so a
    // second page can observe a genuinely in-flight foreign download.
    let holdVidCross = true

    const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x')
        const send = (status, body, headers = {}) => {
            res.writeHead(status, headers)
            res.end(body)
        }
        if (url.pathname === '/') return send(200, shell, { 'content-type': 'text/html; charset=utf-8' })
        if (url.pathname === '/api/session') {
            return send(200, JSON.stringify({ authenticated: true, authMode: 'session' }), {
                'content-type': 'application/json'
            })
        }
        const streamMatch = url.pathname.match(/^\/api\/stream\/([^/?]+)/)
        if (streamMatch) {
            const id = decodeURIComponent(streamMatch[1])
            const m = (req.headers.range || '').match(/^bytes=(\d+)-(\d+)$/)
            if (!m) return send(416, '', { 'content-range': 'bytes */' + TOTAL })
            const start = Number(m[1])
            const end = Math.min(Number(m[2]), TOTAL - 1)
            if (id === 'vid-cross' && holdVidCross && start === 0) {
                holdVidCross = false
                await new Promise((r) => setTimeout(r, 900))
            }
            const slice = SOURCE.subarray(start, end + 1)
            return send(206, slice, {
                'content-type': 'video/mp4',
                'content-length': String(slice.length),
                'content-range': `bytes ${start}-${end}/${TOTAL}`,
                'accept-ranges': 'bytes',
                etag: '"range-fixture-1"'
            })
        }
        // Ship the real frontend modules verbatim.
        if (url.pathname.startsWith('/js/')) {
            try {
                const file = await readFile(join('src/frontend', url.pathname))
                return send(200, file, { 'content-type': 'text/javascript; charset=utf-8' })
            } catch {
                return send(404, 'not found')
            }
        }
        send(404, 'not found')
    })
    return server
}
