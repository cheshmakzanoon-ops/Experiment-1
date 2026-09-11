import type { Context } from 'hono'

/**
 * Bounded JSON body reader (A02).
 *
 * The ONLY pre-authentication endpoint that reads a request body is
 * POST /api/session, and `c.req.json()` would buffer the whole body in
 * memory before any check. This helper rejects oversized requests with a
 * controlled 413 (never parsing them) and keeps small bodies on the exact
 * previous path:
 *
 *   - a declared Content-Length above the cap → 413 before reading,
 *   - a body that streams past the cap while reading → 413, upstream
 *     cancelled (the socket is not left draining),
 *   - valid JSON within the cap → parsed as before,
 *   - malformed JSON within the cap → the caller's 400 as before.
 */

/** Login bodies are tiny ({ key }); 8 KiB is a generous bound. */
export const LOGIN_BODY_LIMIT_BYTES = 8 * 1024

export type BoundedJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response }

export async function readBoundedJson<T = unknown>(
  c: Context,
  limitBytes = LOGIN_BODY_LIMIT_BYTES
): Promise<BoundedJsonResult<T>> {
  const tooLarge = (): Response =>
    c.json(
      { error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' },
      413,
      { Connection: 'close' }
    )

  const declared = c.req.header('content-length')
  if (declared !== undefined && declared !== '') {
    const size = Number(declared)
    if (Number.isFinite(size) && size > limitBytes) return { ok: false, response: tooLarge() }
  }

  const body = c.req.raw.body
  if (!body) return { ok: false, response: tooLarge() }

  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let received = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > limitBytes) {
        await reader.cancel('body limit exceeded').catch(() => {})
        return { ok: false, response: tooLarge() }
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch (error) {
    await reader.cancel(error instanceof Error ? error : undefined).catch(() => {})
    return {
      ok: false,
      response: c.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, 400)
    }
  }

  try {
    return { ok: true, value: JSON.parse(text) as T }
  } catch {
    return {
      ok: false,
      response: c.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, 400)
    }
  }
}
