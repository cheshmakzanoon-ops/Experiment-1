import { spawn, spawnSync, type ChildProcess } from 'child_process'

/**
 * PO Token Generator Service.
 *
 * YouTube requires Proof-of-Origin (PO) tokens for requests from datacenter
 * IPs. Without one, yt-dlp extraction fails with "Sign in to confirm you're
 * not a bot".
 *
 * Real-world setup (parts of it in the Dockerfile):
 *   - A *provider server* that runs headless Chromium to mint tokens and
 *     serves them over HTTP (default http://127.0.0.1:4416, endpoint
 *     POST /get_pot). The server is the Brainicism/bgutil-ytdlp-pot-provider
 *     project — run it as the official sidecar docker image (see
 *     docker-compose.yml) or build it yourself and expose its binary on
 *     PATH. NOTE: it is not distributed on npm.
 *   - `bgutil-ytdlp-pot-provider` (pip) — the yt-dlp *plugin*. Modern
 *     yt-dlp (>= 2025.05.22) discovers it and fetches tokens from the
 *     provider on its own during extraction — no code changes needed on
 *     that path.
 *
 * What THIS service does:
 *   1. On boot, tries to reach the provider (and spawns it when the binary
 *      is on PATH but not running — best-effort, never fatal).
 *   2. Keeps a fetched {token, visitorData} pair cached and refreshed every
 *      4 hours, writing it into YT_PO_TOKEN / YT_VISITOR_DATA so the legacy
 *      `youtube:po_token=web+TOKEN+VISITOR` extractor-arg path in
 *      src/utils/ytDlp.ts also works on older yt-dlp builds.
 *   3. Reports status for GET /api/diag/potoken.
 *
 * Every path degrades gracefully: no provider, no Chromium, generation
 * timeout — the server keeps running and yt-dlp simply attempts extraction
 * without a token.
 */

export interface PoTokenData {
  token: string
  visitorData: string
  generatedAt: number
  expiresAt: number
}

/** Tokens last ~6h; refresh before expiry. */
const TOKEN_TTL = 5 * 60 * 60 * 1000
/** How often to fetch a fresh token (must stay < TOKEN_TTL). */
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000
/** After a failure, don't retry the (slow) provider for this long. */
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000

const DEFAULT_PROVIDER_URL = 'http://127.0.0.1:4416'
/** Hard cap for waiting on the provider server to come up. */
const PROVIDER_STARTUP_TIMEOUT_MS = 25_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function providerUrl(): string {
  return process.env.YT_PO_PROVIDER_URL || DEFAULT_PROVIDER_URL
}

class PoTokenService {
  private cached: PoTokenData | null = null
  private fetching: Promise<PoTokenData> | null = null
  private providerProcess: ChildProcess | null = null
  private providerReachable = false
  private providerVersion: string | null = null
  private lastError: string | null = null
  private nextAttemptAt = 0
  private started = false

  /** True when the operator pinned a manual token pair via env vars. */
  hasEnvOverride(): boolean {
    return !!(process.env.YT_PO_TOKEN && process.env.YT_VISITOR_DATA)
  }

  /**
   * Get a valid PO token pair, fetching a fresh one when the cache is empty
   * or expired. Throws when no provider is available (callers degrade).
   */
  async getToken(): Promise<PoTokenData> {
    // Cached token still valid → return it.
    if (this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached
    }

    // A fetch is already in flight → share it.
    if (this.fetching) return this.fetching

    // Respect the failure cooldown so a down provider does not stall every
    // extraction with HTTP timeouts.
    if (Date.now() < this.nextAttemptAt) {
      throw new Error(this.lastError || 'PO token provider unavailable (recent failure)')
    }

    // Unknown state — cheap re-check instead of a blind 20s HTTP attempt.
    // (startAutoRefresh() also calls ensureProvider() on every cycle.)
    if (!this.providerReachable) {
      const reachable = await this.pingProvider()
      if (!reachable) {
        const err = `PO token provider not reachable at ${providerUrl()}`
        this.lastError = err
        this.nextAttemptAt = Date.now() + FAILURE_COOLDOWN_MS
        throw new Error(err)
      }
    }

    this.fetching = this.fetchFromProvider()
    try {
      const token = await this.fetching
      this.cached = token
      this.lastError = null
      // Keep the legacy env path fresh (used by the po_token extractor-arg).
      process.env.YT_PO_TOKEN = token.token
      process.env.YT_VISITOR_DATA = token.visitorData
      return token
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.nextAttemptAt = Date.now() + FAILURE_COOLDOWN_MS
      throw error
    } finally {
      this.fetching = null
    }
  }

  /**
   * Fetch a {token, visitorData} pair from the bgutil HTTP provider.
   * POST /get_pot returns the session data with the token pair embedded;
   * field names vary across provider versions, so lookup is defensive.
   */
  private async fetchFromProvider(): Promise<PoTokenData> {
    const url = providerUrl()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)

    let response: Response
    try {
      response = await fetch(`${url}/get_pot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: controller.signal
      })
    } catch (error) {
      throw new Error(
        `PO token provider unreachable at ${url}: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`PO token provider returned HTTP ${response.status}: ${text.slice(0, 200)}`)
    }

    let data: Record<string, unknown>
    try {
      data = (await response.json()) as Record<string, unknown>
    } catch {
      throw new Error('PO token provider returned non-JSON output')
    }

    const token = pickField(data, ['token', 'poToken', 'po_token'])
    const visitorData = pickField(data, ['visitorData', 'visitor_data', 'visitorId', 'visitor_id', 'dataSyncId'])

    if (!token || !visitorData) {
      throw new Error(
        `PO token provider response missing token/visitorData (keys: ${Object.keys(data).join(', ') || 'none'})`
      )
    }

    const now = Date.now()
    return {
      token,
      visitorData,
      generatedAt: now,
      expiresAt: now + TOKEN_TTL
    }
  }

  /**
   * Ensure the provider server is running: if YT_PO_PROVIDER_URL is the
   * default and nothing answers on it yet, spawn `bgutil-ytdlp-pot-provider`
   * (provider binary on PATH) and wait for /ping. Best-effort — never
   * throws.
   */
  async ensureProvider(): Promise<boolean> {
    if (this.providerReachable) return true
    if (await this.pingProvider()) return true

    // Only auto-spawn when talking to the default local provider; a custom
    // URL means the operator runs the provider elsewhere.
    if (providerUrl() !== DEFAULT_PROVIDER_URL) return false

    if (this.providerProcess) return false // already attempted

    // Cheap availability probe — no point waiting on a missing binary.
    const probe = spawnSync('bgutil-ytdlp-pot-provider', ['--help'], {
      stdio: 'ignore',
      timeout: 5000
    })
    if (probe.error) {
      this.lastError =
        'bgutil-ytdlp-pot-provider binary not found on PATH ' +
        '(run the provider sidecar from docker-compose.yml, or clone+build ' +
        'Brainicism/bgutil-ytdlp-pot-provider — see POTOKEN.md)'
      return false
    }

    try {
      console.log('[potoken] Starting bgutil-ytdlp-pot-provider server...')
      const child = spawn('bgutil-ytdlp-pot-provider', ['--port', '4416'], {
        stdio: 'ignore',
        detached: true
      })
      child.unref()
      this.providerProcess = child
      child.on('error', (error) => {
        this.providerProcess = null
        this.lastError = `bgutil provider failed to start: ${error.message}`
        console.error('[potoken]', this.lastError)
      })
      child.on('exit', () => {
        // Allow a later ensureProvider() to try again after a crash.
        if (this.providerProcess === child) this.providerProcess = null
        this.providerReachable = false
      })
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return false
    }

    // Wait for the server to answer /ping (chromium + botguard warmup can
    // take a while on first boot).
    const deadline = Date.now() + PROVIDER_STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(1000)
      if (await this.pingProvider()) return true
    }

    this.lastError =
      'bgutil-ytdlp-pot-provider started but did not become reachable within ' +
      `${PROVIDER_STARTUP_TIMEOUT_MS / 1000}s — is Chromium installed?`
    console.warn(`[potoken] ${this.lastError}`)
    return false
  }

  /** GET /ping on the provider; records reachability + version. */
  private async pingProvider(): Promise<boolean> {
    try {
      const response = await fetch(`${providerUrl()}/ping`, {
        signal: AbortSignal.timeout(3000)
      })
      if (!response.ok) return false
      const data = (await response.json()) as { version?: string }
      if (!this.providerReachable) {
        console.log(`[potoken] Provider reachable at ${providerUrl()}`)
      }
      this.providerReachable = true
      this.providerVersion = data.version || null
      return true
    } catch {
      return false
    }
  }

  /**
   * Start automatic refresh: ensure the provider, generate an initial token
   * (so YT_PO_TOKEN / YT_VISITOR_DATA are populated), then refresh every
   * 4 hours. Logs failures and continues without tokens.
   */
  startAutoRefresh(): void {
    if (this.started) return
    this.started = true

    void (async () => {
      if (this.hasEnvOverride()) {
        console.log('[potoken] Manual YT_PO_TOKEN/YT_VISITOR_DATA set — using them (no auto-refresh)')
        return
      }
      const ok = await this.ensureProvider()
      if (!ok) {
        console.warn('[potoken] No PO token provider available. YouTube may block requests.')
        console.warn('[potoken]   Install bgutil-ytdlp-pot-provider + Chromium (see POTOKEN.md) or set YT_PO_TOKEN/YT_VISITOR_DATA.')
        return
      }
      await this.getToken()
        .then(() => console.log('[potoken] Initial PO token generated'))
        .catch((error) => {
          console.warn('[potoken] Initial token generation failed:', error instanceof Error ? error.message : error)
        })
    })()

    setInterval(() => {
      void (async () => {
        if (this.hasEnvOverride()) return
        this.cached = null // force a fresh fetch
        try {
          // Re-ensure the provider first: it may have been installed/started
          // since the previous attempt, or crashed and needs a respawn.
          await this.ensureProvider()
          await this.getToken()
          console.log('[potoken] Auto-refreshed PO token')
        } catch (error) {
          console.error('[potoken] Auto-refresh failed:', error instanceof Error ? error.message : error)
        }
      })()
    }, REFRESH_INTERVAL_MS).unref()
  }

  getStatus(): {
    mode: 'env' | 'provider' | 'none'
    hasToken: boolean
    providerReachable: boolean
    providerVersion: string | null
    expiresAt: number | null
    timeUntilExpiryMs: number | null
    lastError: string | null
  } {
    const token = this.cached || this.envTokenPair()
    return {
      mode: this.hasEnvOverride() ? 'env' : this.providerReachable ? 'provider' : 'none',
      hasToken: token !== null,
      providerReachable: this.providerReachable,
      providerVersion: this.providerVersion,
      expiresAt: token ? token.expiresAt : null,
      timeUntilExpiryMs: token ? token.expiresAt - Date.now() : null,
      lastError: this.lastError
    }
  }

  private envTokenPair(): PoTokenData | null {
    if (!this.hasEnvOverride()) return null
    return {
      token: process.env.YT_PO_TOKEN as string,
      visitorData: process.env.YT_VISITOR_DATA as string,
      generatedAt: Date.now(),
      expiresAt: Date.now() + TOKEN_TTL
    }
  }
}

function pickField(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

export const poTokenService = new PoTokenService()
