import type { Context, Next } from 'hono'

/**
 * Accurate bandwidth tracking for streaming responses.
 *
 * Relayed video (see /api/stream/*) is served byte-for-byte from YouTube's
 * CDN. Range responses carry a Content-Length, but a plain (200) relay can
 * be chunked — and in both cases a client that disconnects early receives
 * fewer bytes than Content-Length claimed. Naively reading Content-Length
 * therefore undercounts chunked streams, so this middleware wraps the
 * response body and counts bytes as they actually flow to the client.
 *
 * Counting is exact: each chunk's length is added to a pending accumulator,
 * which is flushed to the callback in ~64 KB batches (and on stream end or
 * cancel) so the callback overhead stays negligible.
 */

export interface ByteCounterOptions {
  onBytes: (bytes: number) => void
}

const FLUSH_THRESHOLD = 64 * 1024 // report at most ~every 64 KB

/**
 * Wrap a ReadableStream, counting bytes as they pass through. The reported
 * total is the exact number of bytes read from the upstream body — including
 * a final flush when the stream ends or is cancelled early.
 */
function countStream(
  body: ReadableStream<Uint8Array>,
  onBytes: (bytes: number) => void
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let pending = 0

  const flush = () => {
    if (pending > 0) {
      onBytes(pending)
      pending = 0
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (error) {
        // Upstream error: report what already flowed, then surface it.
        flush()
        controller.error(error)
        return
      }

      if (result.done) {
        flush()
        controller.close()
        return
      }

      const chunk = result.value
      if (chunk && chunk.byteLength > 0) {
        pending += chunk.byteLength
        controller.enqueue(chunk)
        if (pending >= FLUSH_THRESHOLD) flush()
      }
    },

    async cancel(reason) {
      // Client went away mid-stream — count the bytes that were served.
      flush()
      try {
        await reader.cancel(reason)
      } catch {
        // Ignore: we are already tearing down.
      }
    }
  })
}

/**
 * Hono middleware that counts streaming response bytes. Mount it on the
 * routes that relay bodies (app.use('/api/stream/*', streamByteCounter(...)))
 * BEFORE the route handlers.
 */
export function streamByteCounter(options: ByteCounterOptions) {
  return async (c: Context, next: Next) => {
    await next()

    // Only wrap actual media relays (JSON error bodies are small and already
    // carry a Content-Length counted by the generic bandwidth middleware).
    const contentType = c.res.headers.get('content-type') || ''
    const isMedia =
      contentType.startsWith('video/') ||
      contentType.startsWith('audio/') ||
      c.req.path.startsWith('/api/stream/')

    if (!isMedia) return

    const body = c.res.body
    if (!body) return

    // HEAD/status-only responses have no body — nothing to count.
    const wrapped = countStream(body, options.onBytes)
    const headers = new Headers(c.res.headers)
    c.res = new Response(wrapped, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers
    })
  }
}
