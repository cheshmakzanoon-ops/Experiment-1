# Experiment-1 — Status & architecture

**What this is:** a private, single-household Persian (Farsi) RTL
YouTube-style client for 1–2 Mbps internet, with all YouTube traffic
proxied through our own Node backend so clients never touch YouTube hosts.
Primary runtime: **Freebuff Cloud** (repo scripts + pinned runtime
bootstrap). Secondary route: Docker. Android WebView wrapper in `android/`.

**Current baseline (post-hardening):**

- **Node 22+** is the required production runtime; older runtimes are
  refused at startup.
- **yt-dlp** runs as the pinned official standalone binary
  (`src/config/ytdlp-version.json` is the single version source), verified
  by SHA-256 into the gitignored `.runtime/bin/`, executed with Node 22 as
  the EJS/JavaScript-challenge runtime (`--js-runtimes node`) by one
  centralized, bounded runner (concurrency gate + single-flight + failure
  taxonomy + no retry storms). No pip/Python/ffmpeg/Chromium requirement.
- **Auth:** HttpOnly same-origin session cookie (`POST /api/session` with
  `ACCESS_KEY`, HMAC-signed with `SESSION_SECRET`, server-side logout
  revocation). No API key in query strings, no key-disclosing config
  endpoint, fail-closed in production.
- **Streaming:** strict Range parsing (absent/valid/invalid → 416 where
  applicable), safe manual redirects with per-hop allowlist re-validation,
  private/no-transform cache semantics, signed-URL expiry margins, 429 ≠
  stale-URL, cancellation propagation.
- **Feeds/search:** semantic category config → single `ytsearch…` string
  builder, bounded batch caching with honest pagination, stale-if-error.
- **Frontend:** self-hosted Vazirmatn + Material Icons (no Google CDNs),
  resilient fetch with bounded retries and Persian error taxonomy, no
  player preflight doubling traffic, chunked resumable IndexedDB offline
  downloads, service worker with an explicit cache allowlist and module
  registration.
- **Diagnostics:** off by default (`ENABLE_DIAGNOSTICS=false` → 404);
  authenticated + strictly limited when enabled. No WARP / host network
  mutation anywhere.
- **Android:** trusted-origin allowlist WebView (only `BuildConfig.WEBAPP_URL`
  origin renders inside it), validated deep links, JS-bridge gating,
  canonical same-origin download URLs, release HTTPS-only enforcement in
  Gradle, debug-only cleartext for local dev.

**Docs:** README.md (architecture, env surface, operations, the three
networks), TESTING.md (ordered local + external validation incl. the
deployed smoke script `scripts/smoke.mjs`), android/README.md (wrapper
build & hardening).

**Known external limits (not application bugs):** YouTube may block the
egress IP of a given host (datacenter ranges); the smoke script reports
that distinctly (`extraction_blocked` / `cdn_blocked`), and a controlled
outbound proxy (`YT_PROXY_URL`) or a different host is the operational fix.
The Freebuff reverse proxy’s long-stream/Range behavior can only be
validated externally (Phase 2 of TESTING.md).
