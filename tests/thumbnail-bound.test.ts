// thumbnail-bound.test.ts — A04: bounded extraction/relay.
//
// The thumbnail relay read the upstream body with response.arrayBuffer() —
// an unbounded read of a NETWORK stream into process memory. A pathological
// (or redirected) allowlisted upstream could stream gigabytes before the
// route answered. Red→green: the relay must bound the read (2 MiB), cancel
// the upstream body, and return 502 instead of buffering forever.

import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { videoRoutes } from '../src/routes/videoRoutes.js'
import { safeFetchMedia } from '../src/utils/net.js'

vi.mock('../src/utils/net.js', () => ({ safeFetchMedia: vi.fn() }))

const safeFetchMediaMock = vi.mocked(safeFetchMedia)

const MIB = 1024 * 1024

/** 3 × 1 MiB chunks, then the upstream stalls forever (never ends). */
function stallingUpstream(): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < 3) {
        sent++
        controller.enqueue(new Uint8Array(MIB).fill(65))
        return
      }
      return new Promise(() => {}) // stall forever
    }
  })
}

const app = new Hono()
app.route('/api', videoRoutes)

const TIMEOUT_PROXY = 'TIMEOUT'

async function respondWithin(
  promise: Promise<Response>,
  ms = 1000
): Promise<Response | typeof TIMEOUT_PROXY> {
  return Promise.race([
    promise,
    new Promise<typeof TIMEOUT_PROXY>((resolve) => setTimeout(() => resolve(TIMEOUT_PROXY), ms))
  ])
}

describe('GET /api/video/:id/thumbnail body bound (A04)', () => {
  it('a normal small thumbnail is still relayed (regression)', async () => {
    safeFetchMediaMock.mockResolvedValueOnce(
      new Response(new Uint8Array(1024).fill(66), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' }
      })
    )
    const res = await app.request('/api/video/dQw4w9WgXcQ/thumbnail')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
  })

  it('an upstream streaming past the cap is cancelled → 502, never buffered forever', async () => {
    safeFetchMediaMock.mockResolvedValueOnce(
      new Response(stallingUpstream(), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' }
      })
    )
    const outcome = await respondWithin(app.request('/api/video/dQw4w9WgXc1/thumbnail'))
    expect(outcome).not.toBe(TIMEOUT_PROXY) // RED today: the route never answers
    const res = outcome as Response
    expect(res.status).toBe(502)
  })

  it('an upstream declaring a huge Content-Length is refused without reading', async () => {
    safeFetchMediaMock.mockResolvedValueOnce(
      new Response(new Uint8Array(8), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(512 * MIB) }
      })
    )
    const res = await app.request('/api/video/dQw4w9WgXc2/thumbnail')
    expect(res.status).toBe(502)
  })
})
