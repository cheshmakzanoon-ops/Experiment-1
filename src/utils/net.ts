/**
 * Outbound HTTP transport used by every server-side request that leaves the
 * process (yt-dlp traffic uses the same optional proxy via environment, see
 * src/services/ytdlp/runYtDlp.ts; media/metadata fetches use this module).
 *
 * Security invariants:
 *   - redirects are followed MANUALLY, and every hop of a media request is
 *     re-validated against the host allowlist before bytes are requested,
 *   - a small maximum hop count (default 5),
 *   - external targets must be HTTPS,
 *   - URLs carrying embedded credentials are rejected,
 *   - `Accept-Encoding: identity` is applied by default so compressed
 *     transfer transformations cannot corrupt byte-range semantics.
 *
 * Optional operator proxy: when YT_PROXY_URL is set, all traffic (both this
 * module AND yt-dlp subprocesses) is routed through it — never derived from
 * user input, and its credentials are never logged.
 */

import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici'
import { config } from '../config.js'
import {
  assertSafeMediaUrl,
  resolveRedirectTarget,
  UnsafeUrlError
} from './urlValidator.js'

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD'
  headers?: Record<string, string>
  /** Connect + response-header timeout in ms. */
  timeoutMs?: number
  /** Client abort signal (request cancellation). */
  signal?: AbortSignal
  maxRedirects?: number
  /** Permit http: for local loopback hooks only. */
  allowHttp?: boolean
}

export type FetchFailureKind =
  | 'dns'
  | 'connect_timeout'
  | 'connect_refused'
  | 'tls'
  | 'aborted'
  | 'http_error'
  | 'redirect_loop'
  | 'unsafe_url'
  | 'unknown'

export class OutboundFetchError extends Error {
  constructor(
    message: string,
    public kind: FetchFailureKind,
    public status?: number,
    public retryable = false,
    public original?: unknown
  ) {
    super(message)
    this.name = 'OutboundFetchError'
  }
}

// ---------------------------------------------------------------------------
// Proxy dispatcher (single instance; credentials never logged)
// ---------------------------------------------------------------------------

let dispatcher: Agent | ProxyAgent | null = null

function getDispatcher(): Agent | ProxyAgent | undefined {
  const proxy = config.ytProxyUrl
  if (!proxy) return undefined // use undici's default (global) dispatcher
  if (!dispatcher) {
    dispatcher = new ProxyAgent(proxy)
  }
  return dispatcher
}

export function proxyConfigured(): boolean {
  return !!config.ytProxyUrl
}

export function redactProxyUrl(): string {
  if (!config.ytProxyUrl) return ''
  try {
    const url = new URL(config.ytProxyUrl)
    const shown = url.password ? `${url.username}:***` : url.username || ''
    return `${url.protocol}//${shown ? `${shown}@` : ''}${url.host}`
  } catch {
    return '(configured proxy)'
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyFetchError(error: unknown): OutboundFetchError {
  const err = error as { code?: string; name?: string; message?: string; cause?: unknown }
  const name = err?.name || ''
  const code = String(err?.code || '').toUpperCase()
  const msg = err?.message || String(error)

  if (name === 'AbortError') {
    return new OutboundFetchError('Request aborted', 'aborted', undefined, false, error)
  }
  if (code.includes('ENOTFOUND') || code.includes('EAI_AGAIN') || /getaddrinfo|dns/i.test(msg)) {
    return new OutboundFetchError('DNS resolution failed', 'dns', undefined, true, error)
  }
  if (code.includes('ETIMEDOUT') || code.includes('UND_ERR_CONNECT_TIMEOUT')) {
    return new OutboundFetchError('Connection timed out', 'connect_timeout', undefined, true, error)
  }
  if (code.includes('ECONNREFUSED') || code.includes('ECONNRESET')) {
    return new OutboundFetchError('Connection refused/reset', 'connect_refused', undefined, true, error)
  }
  if (code.includes('CERT') || code.includes('SSL') || code.includes('TLS') || code.includes('DEPTH_ZERO')) {
    return new OutboundFetchError('TLS error', 'tls', undefined, false, error)
  }
  return new OutboundFetchError(msg || 'Unknown fetch failure', 'unknown', undefined, false, error)
}

interface RawFetchInput {
  url: string
  method?: 'GET' | 'HEAD'
  headers: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
  allowHttp: boolean
  validateHost: boolean
}

/**
 * Low-level fetch with manual redirects. When `validateHost` is true every
 * hop is checked against the media allowlist; when false only HTTPS,
 * credential-free URLs are accepted (diagnostic-only lookups to non-media
 * services such as an egress-IP API).
 */
async function rawFetchWithRedirects(input: RawFetchInput): Promise<Response> {
  const { url: initialUrl, headers, timeoutMs, signal } = input
  const maxRedirects = config.outbound.maxRedirects

  let current = initialUrl
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let safeUrl: URL
    try {
      if (input.validateHost) {
        safeUrl = assertSafeMediaUrl(current, input.allowHttp)
      } else {
        const parsed = new URL(current)
        if (parsed.username || parsed.password) {
          throw new UnsafeUrlError('Refusing a URL with embedded credentials', 'credentials')
        }
        const https = parsed.protocol === 'https:'
        if (!https && !(input.allowHttp && parsed.protocol === 'http:')) {
          throw new UnsafeUrlError(`Refusing non-HTTPS URL (${parsed.protocol})`, 'scheme')
        }
        safeUrl = parsed
      }
    } catch (error) {
      if (error instanceof UnsafeUrlError) {
        throw new OutboundFetchError(error.message, 'unsafe_url', undefined, false, error)
      }
      throw error
    }

    const controller = new AbortController()
    let timedOut = false
    const abortFromClient = () => controller.abort()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    signal?.addEventListener('abort', abortFromClient, { once: true })

    let upstream: Response
    try {
      // undici's Response lacks newer DOM additions (e.g. .bytes()); cast to
      // the platform Response type the rest of the app uses.
      upstream = (await undiciFetch(safeUrl.toString(), {
        method: input.method || 'GET',
        headers,
        redirect: 'manual',
        dispatcher: getDispatcher(),
        signal: controller.signal
      })) as unknown as Response
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      if (timedOut) {
        throw new OutboundFetchError('Upstream timed out while connecting', 'connect_timeout', undefined, true, error)
      }
      if (aborted && signal?.aborted) {
        throw new OutboundFetchError('Request aborted by caller', 'aborted', undefined, false, error)
      }
      throw classifyFetchError(error)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortFromClient)
    }

    const status = upstream.status
    if (status >= 300 && status < 400) {
      const location = upstream.headers.get('location')
      await upstream.body?.cancel().catch(() => {})
      if (!location) {
        throw new OutboundFetchError(`Upstream redirect without a Location (HTTP ${status})`, 'http_error', status, false)
      }
      const hopResult = resolveRedirectTarget(safeUrl.toString(), location, input.allowHttp)
      if (!hopResult.ok) {
        throw new OutboundFetchError(`Unsafe redirect target: ${hopResult.reason}`, 'unsafe_url', undefined, false)
      }
      if (hop >= maxRedirects) {
        throw new OutboundFetchError('Too many upstream redirects', 'redirect_loop', undefined, false)
      }
      current = hopResult.url
      continue
    }

    return upstream
  }

  throw new OutboundFetchError('Redirect limit exceeded', 'redirect_loop', undefined, false)
}

/** Base headers for outbound requests. */
function baseHeaders(extra: Record<string, string> | undefined): Record<string, string> {
  return {
    'Accept-Encoding': 'identity',
    'User-Agent': config.outbound.userAgent,
    ...extra
  }
}

/**
 * Fetch a media URL with manual redirects; every hop is validated against
 * the host allowlist. Used by the stream relay, probes, and thumbnails.
 */
export async function safeFetchMedia(
  initialUrl: string,
  options: SafeFetchOptions = {}
): Promise<Response> {
  return rawFetchWithRedirects({
    url: initialUrl,
    method: options.method,
    headers: baseHeaders(options.headers),
    timeoutMs: options.timeoutMs ?? config.outbound.connectTimeoutMs,
    signal: options.signal,
    allowHttp: options.allowHttp ?? false,
    validateHost: true
  })
}

/**
 * Fetch an arbitrary HTTPS URL (diagnostics-only, e.g. an egress-IP API).
 * No host allowlist (the service is not a media host) but still HTTPS-only,
 * credential-free, manually redirected, and proxy-aware.
 */
export async function fetchExternal(
  initialUrl: string,
  options: SafeFetchOptions = {}
): Promise<Response> {
  return rawFetchWithRedirects({
    url: initialUrl,
    method: options.method,
    headers: baseHeaders(options.headers),
    timeoutMs: options.timeoutMs ?? config.outbound.connectTimeoutMs,
    signal: options.signal,
    allowHttp: false,
    validateHost: false
  })
}

export function isOutboundRetryable(error: unknown): boolean {
  return error instanceof OutboundFetchError && error.retryable
}
