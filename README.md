# Experiment-1 — household YouTube client shell (Freebuff Cloud)

A private, single-household Persian (Farsi, RTL) YouTube-style client for
very slow (1–2 Mbps) internet. The Node backend proxies YouTube metadata,
thumbnails and video streams (byte-relayed with full Range/seek support) so
the household never touches YouTube hosts directly; the Android WebView
wrapper turns it into an installable app.

> **Honest caveats before you build on this:**
> - Re-serving YouTube content through your own proxy may violate
>   [YouTube's Terms of Service](https://www.youtube.com/t/terms). Keep this
>   a private household tool. Do not host it publicly.
> - The server must run on a host with unrestricted access to YouTube
>   (outside Iran). Iranian ISPs block YouTube.
> - YouTube actively blocks datacenter IP ranges. If that happens, no amount
>   of retries fixes it — see “The three networks” below.

## Runtime baseline (read this first)

- **Node.js ≥ 22** is the supported production runtime (`engines` in
  `package.json`, enforced at startup). Node 20 is **not** supported.
- **yt-dlp runs as a standalone official binary** pinned in one place
  (`src/config/ytdlp-version.json`), verified by SHA-256, stored under the
  gitignored `.runtime/bin/` directory. No pip, no Python, no ffmpeg and no
  Chromium are needed: the app selects a single progressive media URL and
  byte-relays it, and yt-dlp’s JavaScript-challenge (EJS) support runs on
  Node 22 itself via `--js-runtimes node` in the centralized runner.
- Resolution order for the yt-dlp executable (NO implicit `PATH` fallback):
  1. `YT_DLP_PATH` (explicit operator override — must be an absolute path to
     a binary that answers `--version` with EXACTLY the effective requested
     version; never overwritten, never claimed as checksum-verified unless
     the operator verifies it themselves),
  2. `.runtime/bin/yt-dlp` (repository-local, bootstrapped and verified).
- One effective requested version is used everywhere: trimmed
  `YT_DLP_VERSION`, otherwise `defaultVersion` in
  `src/config/ytdlp-version.json` (release-tag syntax validated).
- `npm run bootstrap:runtime` downloads the pinned release (architecture
  aware: `yt-dlp_linux` / `yt-dlp_linux_aarch64` / `yt-dlp.exe`), verifies
  its SHA-256 against the official release SHA2-256SUMS, probes the exact
  version, and atomically installs it under `.runtime/bin/` with a small
  verification receipt (`.runtime/bin/.yt-dlp.verified.json`). A second run
  re-hashes the binary against the receipt and never re-downloads a valid
  install; when the receipt is missing/stale it re-verifies against the
  official checksum manifest instead of trusting existing bytes.
  `npm start` runs `prestart` (the same idempotent verification) before
  booting, and `node dist/index.js` direct startup also runs the ensure
  script as a bounded child first.
- To **update yt-dlp deliberately**: bump `defaultVersion` in
  `src/config/ytdlp-version.json`, then run
  `npm run bootstrap:runtime -- --force` and re-run the verification suite.
- If the runtime cannot be established, readiness fails with a precise
  `RUNTIME_MISSING` reason — user requests never die with a later ENOENT.

## Stack

- **Backend:** Node 22, Hono, TypeScript (ESM, NodeNext).
- **Frontend:** plain HTML/CSS/JS (ES modules, no framework), Persian RTL.
  Fonts (Vazirmatn) and icons (Material Icons Round) are **self-hosted** —
  no Google Fonts, no Material CDN, no external analytics or CDNs are
  required for the critical UI.
- **Extraction:** yt-dlp (pinned standalone binary, Node 22 EJS runtime)
  through one bounded runner — every subprocess goes through a concurrency
  gate with single-flight deduplication.
- **Offline:** service worker (app-shell + allowlisted cache) plus
  IndexedDB chunked/resumable downloads.
- **Android:** Gradle WebView wrapper (`android/`).

## Quick start

### Freebuff Cloud (primary deployment target)

1. Clone the repository; Freebuff installs dependencies from the lockfile
   and runs the repo’s own scripts (`npm ci`, build, start). `prestart`
   bootstraps/verifies the pinned yt-dlp runtime automatically.
2. Set the environment variables listed below in the platform env UI
   (Settings → Keys / Environment). Production requires at least
   `ACCESS_KEY` + `SESSION_SECRET`; the process **fails closed** when they
   are missing.
3. `PORT` is injected by the platform; the server binds `HOST` (default
   `0.0.0.0`).

```bash
npm ci
npm run bootstrap:runtime   # idempotent; prestart does this automatically
npm run build
npm start                   # prestart verifies the runtime first
```

### Docker (secondary deployment route)

The image uses the *same* runtime strategy as Freebuff (Node 22 +
`npm ci` + the pinned standalone yt-dlp bootstrap) — not a parallel pip
environment. Health checks honor `$PORT`.

```bash
ACCESS_KEY=… SESSION_SECRET=… docker compose up --build
```

## Authentication & access control

The old design (a public `/api/config` that handed out the API key, keys in
`?key=…` query strings) is gone.

- `POST /api/session` with the household `ACCESS_KEY` in a JSON body
  (constant-time comparison) **persists a new active session to the session
  store first** and only then issues the signed **HttpOnly** cookie:
  `SameSite=Strict`, `Path=/`, `Secure` in production, default 30-day
  lifetime (`SESSION_TTL_DAYS`) — one lifetime source for both the token
  expiration and the cookie Max-Age.
- **Active sessions are an allowlist, not a revoked-token blacklist.**
  `src/services/sessionStore.ts` keeps a versioned document
  (`{version: 1, epoch, active: [{sid, exp}]}`) at
  `.runtime/auth/sessions.json` (override with `SESSION_STORE_PATH`),
  written atomically through one serializer (temp file + fsync + rename +
  dir sync). Sessions survive server restarts; a genuinely lost/corrupted
  store fails startup (never silently replaced with a fresh one), and an
  *ephemeral* filesystem (e.g. a Freebuff rebuild) rotates the epoch,
  invalidating every old cookie — one fresh login is required after a
  deployment upgrade. Capacity is capped at 5,000 active sessions (after
  pruning expired ones); a full store rejects new login with 503
  `AUTH_SESSIONS_FULL` and never evicts an unexpired session.
- The signed payload is `{v:2, epoch, sid, exp}` — matching store epoch +
  active-allowlist membership are required. Storage failures return
  `AUTH_STORAGE_UNAVAILABLE` (never a false success) and make
  authentication/readiness fail closed until recovery. **Topology: one
  Node process/replica — do not run multiple replicas against independent
  JSON files.**
- Same-origin `<img>`/`<video>`/fetch requests carry the cookie
  automatically, so no secret ever appears in JavaScript, a URL, logs or
  history.
- `GET /api/session` reports only `{authenticated, authMode}` — never a
  secret or the store epoch. `DELETE /api/session` **persists the removal
  before** expiring the cookie; the frontend surfaces a failed logout
  instead of claiming success.
- **Public by design:** liveness/readiness health endpoints and the
  session lifecycle. Everything else (`/api/search`, feeds, metadata,
  thumbnails, streams, stats, diagnostics) requires a session. In
  production, missing `ACCESS_KEY`/`SESSION_SECRET` aborts startup, and
  partial credential configurations are rejected in **every** environment.
  `AUTH_DISABLED=true` is the only sanctioned development escape hatch and
  is accepted only when `NODE_ENV` is `development`/`test` AND `HOST`
  resolves to the literal loopback binding (`127.0.0.1` or `::1`).
- Rate limiting is mounted by class (login attempts: very low; metadata/
  feeds: moderate; extraction-triggering calls: low; diagnostics:
  extremely low) and returns accurate `Retry-After` values. Client
  identity never blindly trusts `X-Forwarded-For`: it is used only when
  `TRUST_PROXY=true`, and expensive work keys on session identity where a
  session exists.

## Streaming correctness & safety

- `Range` handling distinguishes **absent / valid / invalid**; a malformed
  or multi-range request is rejected (416 where applicable, with
  `Content-Range: bytes */TOTAL`) instead of silently becoming a full
  download. Suffix ranges (`bytes=-500`) are forwarded correctly.
- Every outbound media request validates the host allowlist, is manually
  redirected (max 5 hops) with **every hop re-validated**, requires HTTPS,
  and rejects embedded credentials. Probes, relays and diagnostics share
  this same safe transport.
- Responses use `Cache-Control: private, no-transform` semantics — never
  `public`, and no wildcard CORS (frontend and API are same-origin).
- Cached signed media URLs respect their `expire` parameter minus a safety
  margin (`STREAM_CACHE_EXPIRY_MARGIN_MS`); an expired signed URL triggers
  one cache-invalidating re-extraction, but a genuine YouTube 429 never
  triggers re-extraction storms.
- Request cancellation propagates upstream (phone disconnects → upstream
  fetch aborted).

## Offline downloads (IndexedDB) and its intentional Range limitations

The Library → آفلاین downloader stores video chunks in IndexedDB (per-video
chunk records + one metadata record, written in a single transaction) for
playback with the network disabled. The downloader's HTTP contract is
**stricter than ordinary playback** on purpose:

- **Every chunk response must be a truthful 206.** `Content-Range` is
  parsed into `{start, end, total}` with strict integer validation; the
  response start must equal the requested start, the body length must be
  counted and match, and shorter-than-requested valid responses are
  accepted (progress advances from the response's actual end).
- **Unknown totals are unsupported** — a `bytes S-E/*` 206 pauses with
  `RANGE_TOTAL_UNKNOWN`; the downloader never marks an unknown-length
  prefix ready. Totals are learned from responses and re-validated against
  the extractor's `filesize_approx`, which is treated as an estimate only.
- **A full HTTP 200 in answer to an offline Range request is unsupported:**
  the body is cancelled immediately and the download pauses with
  `RANGE_UNSUPPORTED` — the downloader never buffers a full media object.
  Ordinary online playback's truthful 200 relay is unchanged.
- 416 is parsed separately (`bytes */N`): it completes a download only when
  N matches the established total and persisted coverage is exactly
  `[0,N)`; otherwise it drives the single permitted representation-change
  restart (`SOURCE_CHANGED`) rather than marking incomplete data ready.
- **Representation changes** (changed strong ETag / total / Last-Modified
  without a strong ETag) restart that video's download once from zero after
  discarding only its incompatible chunks; a second change pauses with
  `SOURCE_CHANGED`.
- Integrity checks reject wrong starts/ends, truncation, overflow, gaps and
  overlap; committed chunks and metadata are never left half-written, and
  user cancellation deletes only that video's records (awaited transaction)
  before allowing a restart.

## Feeds & search

- Categories are configured **semantically** (query text + sort mode +
  batch size) and the yt-dlp search string is generated in one function
  (`ytsearchdateN:` for fresh content, `ytsearchN:` otherwise). No
  year-pinned queries (the old `"popular music 2024"` is gone) and no
  fragile query-string rewriting.
- One bounded batch (default 50) is fetched per category, cached 15–20
  minutes, and pages are served by slicing it — `hasMore` is honest and a
  page beyond the batch is empty (never a silent fallback to page 1).
- Stale-if-error: a temporary YouTube failure serves the last successful
  batch instead of blanking the UI.

## Expensive work is bounded

All yt-dlp subprocesses run through one concurrency gate
(`YT_DLP_CONCURRENCY`, default 2) with a bounded queue, queue/subprocess
timeouts, cancellation, single-flight deduplication, graceful shutdown,
and queue-full → `503` + `Retry-After`. Failures are classified
(content-not-found, private/restricted, geo, DRM, live, format-unavailable,
bot detection, 429 rate limit, CDN 403, DNS, timeouts, malformed output,
missing runtime) — the requested-format-unavailable error is *not* treated
as bot detection, permanent failures are never blindly retried, and a real
429 is never “fixed” by spawning more extraction.

## Diagnostics & health

- `GET /api/health/live` — cheapest possible process-liveness check.
- `GET /api/health/ready` — cached (45 s) local prerequisite check:
  configuration valid, Node ≥ 22, yt-dlp resolves and runs, JS runtime
  supported, session store healthy. Returns 503 with a precise reason
  (`RUNTIME_MISSING`, `YTDLP_VERSION_MISMATCH`, `SHUTTING_DOWN`, …) when a
  prerequisite is missing or the server is shutting down. It never performs
  a YouTube extraction and never exposes the session-store epoch/session
  list — readiness ≠ YouTube reachability.
- `GET /api/diag/*` are **disabled by default** (`ENABLE_DIAGNOSTICS=false`
  → 404). When enabled they require a session, an extremely strict rate
  limit, a single-flight deep-test lock, finite timeouts, and redact all
  tokens/cookies/proxy credentials/signed URLs. Diagnostics never call the
  server’s own HTTP API and never reconfigure host networking (no WARP).

### The three networks

Failures are handled independently and never blurred together:

| Failure | Meaning | Action |
| --- | --- | --- |
| runtime not ready | yt-dlp/JS runtime missing on the server | `npm run bootstrap:runtime`; readiness reports `RUNTIME_MISSING` |
| YouTube extraction blocked | Freebuff’s egress IP is rejected (`Sign in to confirm you’re not a bot`, 429/403) | External egress problem — different controlled egress (see below); retries cannot fix a blocked IP |
| CDN blocked | metadata works but Google Video CDN rejects byte fetches | Same class of external egress issue, reported separately |
| client can’t reach Freebuff | the phone/browser cannot reach the Freebuff host | Ingress/network problem on the client side, not a YouTube problem |

An optional operator-controlled outbound proxy (`YT_PROXY_URL`) routes
**both** yt-dlp extraction traffic and Node media/CDN fetches through the
same egress. It is never derived from user input and its credentials are
never logged. If the deployed Freebuff egress is persistently blocked, the
correct operational conclusion is “application code healthy — egress
blocked by YouTube”, which the smoke test reports as such.

## Environment variables

Secrets are marked 🔒 — set them in the platform env UI / deployment env;
**never commit them**. All keys are read from `process.env` at startup.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | accepted values: `production`, `development`, `test`; any other nonempty value is rejected at startup |
| `PORT` | `3000` | listen port (Freebuff injects it) |
| `HOST` | `0.0.0.0` | listen host (`AUTH_DISABLED=true` additionally requires the literal `127.0.0.1`/`::1` loopback binding) |
| `ACCESS_KEY` 🔒 | – | household access key, ≥ 16 chars — required in EVERY environment unless the loopback dev exception applies |
| `SESSION_SECRET` 🔒 | – | HMAC signing secret, ≥ 32 UTF-8 bytes — required in EVERY environment unless the loopback dev exception applies |
| `AUTH_DISABLED` | `false` | strict flag (`true`/`false`/absent only — typos are rejected); bypass allowed only in development/test on an explicit loopback binding, never in production or on a wildcard/network binding |
| `SESSION_TTL_DAYS` | `30` | household cookie lifetime (single source for token expiry + cookie Max-Age) |
| `SESSION_STORE_PATH` | `.runtime/auth/sessions.json` | absolute path to the persisted active-session allowlist (repo-root-relative default; directory must be writable, single-replica topology) |
| `TRUST_PROXY` | `false` | trust `X-Forwarded-For`/`X-Real-IP` for rate-limit keys |
| `LOGIN_MAX_REQUESTS` / `LOGIN_WINDOW_MS` | `8` / `15 min` | login attempt limits |
| `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW` | `120` / `60 s` | ordinary API calls |
| `EXTRACT_MAX_REQUESTS` / `EXTRACT_WINDOW_MS` | `20` / `60 s` | extraction-triggering calls |
| `DIAG_MAX_REQUESTS` / `DIAG_WINDOW_MS` | `4` / `10 min` | diagnostics |
| `YT_DLP_VERSION` | pinned default | override of the single-source version pin (trimmed; release-tag syntax validated) |
| `YT_DLP_PATH` | – | explicit operator-managed binary — absolute path whose `--version` output EXACTLY matches the effective requested version (mismatch fails with instructions) |
| `YT_DLP_CONCURRENCY` | `2` | max simultaneous yt-dlp processes |
| `YT_DLP_QUEUE_MAX` | `24` | max waiting jobs before `503` |
| `YT_DLP_QUEUE_TIMEOUT_MS` | `45000` | max queue wait |
| `YT_DLP_PROCESS_TIMEOUT_MS` | `90000` | per-process timeout |
| `YT_PLAYER_CLIENTS` | – | advanced: allowlisted forced player clients (comma list; empty = yt-dlp defaults) |
| `YT_EXTRACTOR_ARGS` 🔒 | – | advanced: raw `--extractor-args youtube:…` (e.g. temporary PO-token workarounds); never logged |
| `YT_PROXY_URL` 🔒 | – | operator outbound proxy for all YouTube/CDN egress |
| `UPSTREAM_CONNECT_TIMEOUT_MS` / `UPSTREAM_READ_TIMEOUT_MS` | `15000` / `30000` | outbound fetch timeouts |
| `UPSTREAM_MAX_REDIRECTS` | `5` | safe redirect hop limit |
| `STREAM_CACHE_TTL_MS` / `STREAM_CACHE_EXPIRY_MARGIN_MS` | `2 h` / `5 min` | signed-URL cache policy |
| `SEARCH_CACHE_TTL_MS` | `3 min` | search cache (household-friendly) |
| `FEED_BATCH_SIZE` / `FEED_TTL_MS` | `50` / `20 min` | per-category batch policy |
| `HOME_FEED_BATCH_SIZE` / `HOME_FEED_TTL_MS` | `48` / `15 min` | home feed batch policy |
| `ENABLE_DIAGNOSTICS` | `false` | expose `/api/diag/*` (authenticated) |
| `KEEPALIVE_ENABLED` / `KEEPALIVE_INTERVAL_MINUTES` | `false` / `4` | optional, unref’d self-ping experiment — not guaranteed to prevent sandbox suspension |
| `LOG_LEVEL` | `info` | `debug` enables verbose server-side logs (never secrets) |

## Testing & verification

- `npm run lint` — ESLint (no-undef etc.) over the frontend.
- `npm test` — the real Vitest suite (~200 tests across 17 files): Range
  parsing/resolution, fail-closed configuration, strict `AUTH_DISABLED`,
  session auth incl. tamper/expiry and logout, the persistent session store
  (restart survival, epoch rotation, corruption fail-closed, capacity,
  write-failure unavailability), the offline downloader contract against
  `fake-indexeddb` (strict 206 validation, bounded counted reads, chunked
  resume, transactional persistence, cancellation), single-flight gate
  cancellation with independent waiters + real SIGTERM-ignoring child
  escalation, ordered shutdown fencing, the pinned-runtime installer
  (mocked network, real filesystem/hash/probe), the smoke acceptance
  script, and the service-worker namespace-scoped cache policy.
- `npm run build` / `npm run typecheck`.
- **`scripts/smoke.mjs`** — external smoke test against a *deployed*
  Freebuff URL. The access key must be passed via `FREEBUFF_SMOKE_KEY`
  (environment variable — never an argument):
  ```bash
  FREEBUFF_SMOKE_KEY=… node scripts/smoke.mjs "https://your-freebuff-url.app"
  ```
  It verifies shell/liveness/readiness/auth/search/metadata/thumbnails,
  exact byte ranges (first, mid-file, suffix, malformed → 416,
  unsatisfiable → 416 `bytes */TOTAL`), no signed-URL leakage, and
  diagnostics-off-by-default,  and reports distinct failure categories (`freebuff_ingress`, `auth`,
  `runtime_missing`, `version_mismatch`, `shutting_down`,
  `extraction_blocked`, `cdn_blocked`, `range_corruption`, `timeout`).
  Running it against
  `localhost` proves only the local process — the real ingress, Range
  survival through the reverse proxy, and phone/Iran reachability are
  separate checks to run against the live preview URL (see TESTING.md).

## Structure

```
src/
  index.ts               # server entry (security headers, routing, ordered shutdown)
  config.ts              # env config (fail-closed validation)
  config/ytdlp-version.json  # single yt-dlp version pin
  middleware/            # session auth, rate limiting, stream cache/counters
  routes/                # session, search, feed, video, stream, health, diag
  services/
    sessionStore.ts      # persisted active-session allowlist (atomic writes)
    shutdownState.ts     # shutdown fence consulted by readiness
    ytdlp/               # runtime resolution + bounded runner (queue, errors)
    youtube/             # extractor, feeds/search, stream proxy
    cache/               # bounded TTL + stale-if-error caches
    diagnostics.ts / egress.ts
  utils/                 # range parsing, URL allowlist, outbound net, params
  frontend/              # Persian RTL UI (self-hosted fonts/icons)
android/                 # WebView wrapper (see android/README.md)
scripts/                 # pinned-runtime bootstrap/ensure + smoke test
tests/                   # Vitest suite (17 files incl. offline/session-store/cancellation/shutdown/runtime-bootstrap/smoke/sw-policy)
```

See **TESTING.md** for the ordered validation guide and **android/README.md**
for building the wrapper.
